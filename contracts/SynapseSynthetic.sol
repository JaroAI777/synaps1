// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapseSynthetic
 * @notice Overcollateralized synthetic assets (stablecoins, synthetic stocks, etc.)
 * @dev Collateral Debt Position (CDP) based system
 */
contract SynapseSynthetic is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Roles ============
    
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");

    // ============ Structs ============

    struct SyntheticAsset {
        address syntheticToken;     // The minted synthetic token
        string symbol;              // e.g., "sUSD", "sBTC", "sAAPL"
        uint256 price;              // Current price (scaled 1e8)
        uint256 minCollateralRatio; // Min collateral ratio (e.g., 15000 = 150%)
        uint256 liquidationRatio;   // Liquidation threshold (e.g., 12000 = 120%)
        uint256 stabilityFee;       // Annual fee in basis points
        uint256 totalMinted;
        uint256 totalCollateral;
        bool isActive;
        uint256 lastPriceUpdate;
    }

    struct CDP {
        uint256 cdpId;
        address owner;
        bytes32 assetId;
        address collateralToken;
        uint256 collateralAmount;
        uint256 debtAmount;         // Synthetic tokens minted
        uint256 accumulatedFee;
        uint256 lastFeeUpdate;
        bool isActive;
    }

    struct CollateralType {
        address token;
        uint256 price;              // Price in USD (scaled 1e8)
        uint256 collateralFactor;   // How much can be borrowed (basis points)
        uint256 liquidationBonus;   // Bonus for liquidators
        bool isActive;
    }

    // ============ State Variables ============

    // Synthetic assets
    mapping(bytes32 => SyntheticAsset) public syntheticAssets;
    bytes32[] public assetList;

    // Collateral types
    mapping(address => CollateralType) public collateralTypes;
    address[] public collateralList;

    // CDPs
    mapping(uint256 => CDP) public cdps;
    mapping(address => uint256[]) public userCDPs;
    uint256 public cdpCounter;

    // Global parameters
    uint256 public globalDebtCeiling = 100_000_000 * 1e18; // $100M
    uint256 public totalGlobalDebt;

    // Treasury
    address public treasury;
    uint256 public liquidationPenalty = 1300; // 13%
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    // ============ Events ============

    event SyntheticAssetCreated(bytes32 indexed assetId, string symbol, address syntheticToken);
    event CollateralAdded(address indexed token, uint256 collateralFactor);
    event CDPOpened(uint256 indexed cdpId, address indexed owner, bytes32 assetId, uint256 collateral);
    event CDPClosed(uint256 indexed cdpId);
    event CollateralDeposited(uint256 indexed cdpId, uint256 amount);
    event CollateralWithdrawn(uint256 indexed cdpId, uint256 amount);
    event SyntheticMinted(uint256 indexed cdpId, uint256 amount);
    event SyntheticBurned(uint256 indexed cdpId, uint256 amount);
    event CDPLiquidated(uint256 indexed cdpId, address indexed liquidator, uint256 debtCovered, uint256 collateralSeized);
    event PriceUpdated(bytes32 indexed assetId, uint256 newPrice);

    // ============ Constructor ============

    constructor(address _treasury) {
        treasury = _treasury;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, msg.sender);
        _grantRole(LIQUIDATOR_ROLE, msg.sender);
    }

    // ============ Asset Management ============

    /**
     * @notice Create a new synthetic asset
     */
    function createSyntheticAsset(
        string calldata symbol,
        string calldata name,
        uint256 initialPrice,
        uint256 minCollateralRatio,
        uint256 liquidationRatio,
        uint256 stabilityFee
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (bytes32) {
        require(minCollateralRatio > liquidationRatio, "Invalid ratios");
        require(liquidationRatio >= 10000, "Ratio too low"); // Min 100%

        bytes32 assetId = keccak256(abi.encodePacked(symbol, block.timestamp));

        // Deploy synthetic token
        SyntheticToken synth = new SyntheticToken(name, symbol, address(this));

        syntheticAssets[assetId] = SyntheticAsset({
            syntheticToken: address(synth),
            symbol: symbol,
            price: initialPrice,
            minCollateralRatio: minCollateralRatio,
            liquidationRatio: liquidationRatio,
            stabilityFee: stabilityFee,
            totalMinted: 0,
            totalCollateral: 0,
            isActive: true,
            lastPriceUpdate: block.timestamp
        });

        assetList.push(assetId);

        emit SyntheticAssetCreated(assetId, symbol, address(synth));

        return assetId;
    }

    /**
     * @notice Add supported collateral type
     */
    function addCollateralType(
        address token,
        uint256 initialPrice,
        uint256 collateralFactor,
        uint256 liquidationBonus
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(0), "Invalid token");
        require(!collateralTypes[token].isActive, "Already exists");

        collateralTypes[token] = CollateralType({
            token: token,
            price: initialPrice,
            collateralFactor: collateralFactor,
            liquidationBonus: liquidationBonus,
            isActive: true
        });

        collateralList.push(token);

        emit CollateralAdded(token, collateralFactor);
    }

    /**
     * @notice Update asset price (oracle)
     */
    function updatePrice(bytes32 assetId, uint256 newPrice) external onlyRole(ORACLE_ROLE) {
        SyntheticAsset storage asset = syntheticAssets[assetId];
        require(asset.isActive, "Asset not active");

        asset.price = newPrice;
        asset.lastPriceUpdate = block.timestamp;

        emit PriceUpdated(assetId, newPrice);
    }

    /**
     * @notice Update collateral price (oracle)
     */
    function updateCollateralPrice(address token, uint256 newPrice) external onlyRole(ORACLE_ROLE) {
        require(collateralTypes[token].isActive, "Collateral not active");
        collateralTypes[token].price = newPrice;
    }

    // ============ CDP Operations ============

    /**
     * @notice Open a new CDP
     */
    function openCDP(
        bytes32 assetId,
        address collateralToken,
        uint256 collateralAmount,
        uint256 mintAmount
    ) external nonReentrant whenNotPaused returns (uint256) {
        SyntheticAsset storage asset = syntheticAssets[assetId];
        require(asset.isActive, "Asset not active");

        CollateralType storage collateral = collateralTypes[collateralToken];
        require(collateral.isActive, "Collateral not supported");

        // Transfer collateral
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), collateralAmount);

        cdpCounter++;
        uint256 cdpId = cdpCounter;

        cdps[cdpId] = CDP({
            cdpId: cdpId,
            owner: msg.sender,
            assetId: assetId,
            collateralToken: collateralToken,
            collateralAmount: collateralAmount,
            debtAmount: 0,
            accumulatedFee: 0,
            lastFeeUpdate: block.timestamp,
            isActive: true
        });

        userCDPs[msg.sender].push(cdpId);

        emit CDPOpened(cdpId, msg.sender, assetId, collateralAmount);

        // Mint if requested
        if (mintAmount > 0) {
            _mint(cdpId, mintAmount);
        }

        return cdpId;
    }

    /**
     * @notice Deposit more collateral to CDP
     */
    function depositCollateral(uint256 cdpId, uint256 amount) external nonReentrant {
        CDP storage cdp = cdps[cdpId];
        require(cdp.isActive, "CDP not active");
        require(cdp.owner == msg.sender, "Not owner");

        IERC20(cdp.collateralToken).safeTransferFrom(msg.sender, address(this), amount);
        cdp.collateralAmount += amount;

        emit CollateralDeposited(cdpId, amount);
    }

    /**
     * @notice Withdraw excess collateral
     */
    function withdrawCollateral(uint256 cdpId, uint256 amount) external nonReentrant {
        CDP storage cdp = cdps[cdpId];
        require(cdp.isActive, "CDP not active");
        require(cdp.owner == msg.sender, "Not owner");

        _updateFees(cdpId);

        cdp.collateralAmount -= amount;

        // Check collateral ratio after withdrawal
        require(_getCollateralRatio(cdpId) >= syntheticAssets[cdp.assetId].minCollateralRatio, "Below min ratio");

        IERC20(cdp.collateralToken).safeTransfer(msg.sender, amount);

        emit CollateralWithdrawn(cdpId, amount);
    }

    /**
     * @notice Mint synthetic tokens against collateral
     */
    function mint(uint256 cdpId, uint256 amount) external nonReentrant whenNotPaused {
        CDP storage cdp = cdps[cdpId];
        require(cdp.isActive, "CDP not active");
        require(cdp.owner == msg.sender, "Not owner");

        _mint(cdpId, amount);
    }

    function _mint(uint256 cdpId, uint256 amount) internal {
        CDP storage cdp = cdps[cdpId];
        SyntheticAsset storage asset = syntheticAssets[cdp.assetId];

        _updateFees(cdpId);

        cdp.debtAmount += amount;
        asset.totalMinted += amount;
        totalGlobalDebt += amount;

        require(totalGlobalDebt <= globalDebtCeiling, "Global debt ceiling");
        require(_getCollateralRatio(cdpId) >= asset.minCollateralRatio, "Below min ratio");

        // Mint synthetic tokens
        SyntheticToken(asset.syntheticToken).mint(msg.sender, amount);

        emit SyntheticMinted(cdpId, amount);
    }

    /**
     * @notice Burn synthetic tokens to reduce debt
     */
    function burn(uint256 cdpId, uint256 amount) external nonReentrant {
        CDP storage cdp = cdps[cdpId];
        require(cdp.isActive, "CDP not active");

        _updateFees(cdpId);

        SyntheticAsset storage asset = syntheticAssets[cdp.assetId];

        // Burn tokens
        SyntheticToken(asset.syntheticToken).burn(msg.sender, amount);

        cdp.debtAmount -= amount;
        asset.totalMinted -= amount;
        totalGlobalDebt -= amount;

        emit SyntheticBurned(cdpId, amount);
    }

    /**
     * @notice Close CDP (repay all debt and withdraw collateral)
     */
    function closeCDP(uint256 cdpId) external nonReentrant {
        CDP storage cdp = cdps[cdpId];
        require(cdp.isActive, "CDP not active");
        require(cdp.owner == msg.sender, "Not owner");

        _updateFees(cdpId);

        SyntheticAsset storage asset = syntheticAssets[cdp.assetId];

        // Burn all debt
        if (cdp.debtAmount > 0) {
            SyntheticToken(asset.syntheticToken).burn(msg.sender, cdp.debtAmount);
            asset.totalMinted -= cdp.debtAmount;
            totalGlobalDebt -= cdp.debtAmount;
        }

        // Pay stability fees
        if (cdp.accumulatedFee > 0) {
            IERC20(cdp.collateralToken).safeTransfer(treasury, cdp.accumulatedFee);
            cdp.collateralAmount -= cdp.accumulatedFee;
        }

        // Return collateral
        uint256 collateralToReturn = cdp.collateralAmount;
        cdp.collateralAmount = 0;
        cdp.debtAmount = 0;
        cdp.isActive = false;

        IERC20(cdp.collateralToken).safeTransfer(msg.sender, collateralToReturn);

        emit CDPClosed(cdpId);
    }

    // ============ Liquidation ============

    /**
     * @notice Liquidate undercollateralized CDP
     */
    function liquidate(uint256 cdpId, uint256 debtToCover) external nonReentrant onlyRole(LIQUIDATOR_ROLE) {
        CDP storage cdp = cdps[cdpId];
        require(cdp.isActive, "CDP not active");

        _updateFees(cdpId);

        uint256 collateralRatio = _getCollateralRatio(cdpId);
        SyntheticAsset storage asset = syntheticAssets[cdp.assetId];
        
        require(collateralRatio < asset.liquidationRatio, "CDP healthy");

        // Cap debt to cover
        if (debtToCover > cdp.debtAmount) {
            debtToCover = cdp.debtAmount;
        }

        // Calculate collateral to seize (with bonus)
        CollateralType storage collateral = collateralTypes[cdp.collateralToken];
        uint256 debtValueUsd = (debtToCover * asset.price) / 1e8;
        uint256 collateralToSeize = (debtValueUsd * (BASIS_POINTS + collateral.liquidationBonus)) / collateral.price;
        collateralToSeize = (collateralToSeize * 1e8) / BASIS_POINTS;

        if (collateralToSeize > cdp.collateralAmount) {
            collateralToSeize = cdp.collateralAmount;
        }

        // Burn synthetic from liquidator
        SyntheticToken(asset.syntheticToken).burn(msg.sender, debtToCover);

        // Update CDP
        cdp.debtAmount -= debtToCover;
        cdp.collateralAmount -= collateralToSeize;
        asset.totalMinted -= debtToCover;
        totalGlobalDebt -= debtToCover;

        // Transfer collateral to liquidator
        IERC20(cdp.collateralToken).safeTransfer(msg.sender, collateralToSeize);

        // Close CDP if empty
        if (cdp.collateralAmount == 0 || cdp.debtAmount == 0) {
            cdp.isActive = false;
        }

        emit CDPLiquidated(cdpId, msg.sender, debtToCover, collateralToSeize);
    }

    // ============ Fee Calculation ============

    function _updateFees(uint256 cdpId) internal {
        CDP storage cdp = cdps[cdpId];
        SyntheticAsset storage asset = syntheticAssets[cdp.assetId];

        if (cdp.debtAmount > 0) {
            uint256 timeElapsed = block.timestamp - cdp.lastFeeUpdate;
            uint256 fee = (cdp.debtAmount * asset.stabilityFee * timeElapsed) / (BASIS_POINTS * SECONDS_PER_YEAR);
            cdp.accumulatedFee += fee;
        }

        cdp.lastFeeUpdate = block.timestamp;
    }

    // ============ View Functions ============

    function _getCollateralRatio(uint256 cdpId) internal view returns (uint256) {
        CDP storage cdp = cdps[cdpId];
        if (cdp.debtAmount == 0) return type(uint256).max;

        SyntheticAsset storage asset = syntheticAssets[cdp.assetId];
        CollateralType storage collateral = collateralTypes[cdp.collateralToken];

        uint256 collateralValueUsd = (cdp.collateralAmount * collateral.price) / 1e18;
        uint256 debtValueUsd = (cdp.debtAmount * asset.price) / 1e18;

        return (collateralValueUsd * BASIS_POINTS) / debtValueUsd;
    }

    function getCollateralRatio(uint256 cdpId) external view returns (uint256) {
        return _getCollateralRatio(cdpId);
    }

    function getCDP(uint256 cdpId) external view returns (CDP memory) {
        return cdps[cdpId];
    }

    function getSyntheticAsset(bytes32 assetId) external view returns (SyntheticAsset memory) {
        return syntheticAssets[assetId];
    }

    function getUserCDPs(address user) external view returns (uint256[] memory) {
        return userCDPs[user];
    }

    function isLiquidatable(uint256 cdpId) external view returns (bool) {
        CDP storage cdp = cdps[cdpId];
        if (!cdp.isActive || cdp.debtAmount == 0) return false;

        return _getCollateralRatio(cdpId) < syntheticAssets[cdp.assetId].liquidationRatio;
    }

    function getMaxMintable(uint256 cdpId) external view returns (uint256) {
        CDP storage cdp = cdps[cdpId];
        SyntheticAsset storage asset = syntheticAssets[cdp.assetId];
        CollateralType storage collateral = collateralTypes[cdp.collateralToken];

        uint256 collateralValueUsd = (cdp.collateralAmount * collateral.price) / 1e18;
        uint256 maxDebtUsd = (collateralValueUsd * BASIS_POINTS) / asset.minCollateralRatio;
        uint256 maxDebt = (maxDebtUsd * 1e18) / asset.price;

        if (maxDebt <= cdp.debtAmount) return 0;
        return maxDebt - cdp.debtAmount;
    }

    // ============ Admin Functions ============

    function setGlobalDebtCeiling(uint256 ceiling) external onlyRole(DEFAULT_ADMIN_ROLE) {
        globalDebtCeiling = ceiling;
    }

    function setLiquidationPenalty(uint256 penalty) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(penalty <= 2000, "Penalty too high");
        liquidationPenalty = penalty;
    }

    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        treasury = _treasury;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
}

/**
 * @title SyntheticToken
 * @notice ERC20 token representing synthetic assets
 */
contract SyntheticToken is ERC20, ERC20Burnable {
    address public minter;

    modifier onlyMinter() {
        require(msg.sender == minter, "Only minter");
        _;
    }

    constructor(
        string memory name,
        string memory symbol,
        address _minter
    ) ERC20(name, symbol) {
        minter = _minter;
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyMinter {
        _burn(from, amount);
    }
}
