// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapseOptions
 * @notice Decentralized options trading protocol
 * @dev Options represented as ERC721 NFTs for tradability
 */
contract SynapseOptions is ERC721, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Enums ============

    enum OptionType { CALL, PUT }
    enum OptionStyle { EUROPEAN, AMERICAN }
    enum OptionState { ACTIVE, EXERCISED, EXPIRED, CANCELLED }

    // ============ Structs ============

    struct Option {
        uint256 optionId;
        address writer;             // Option seller
        address holder;             // Option buyer (current owner)
        address underlying;         // Underlying asset
        address collateral;         // Collateral token
        uint256 strikePrice;        // Strike price (scaled by 1e8)
        uint256 amount;             // Amount of underlying
        uint256 premium;            // Premium paid
        uint256 collateralAmount;   // Collateral locked
        uint256 expiry;
        OptionType optionType;
        OptionStyle style;
        OptionState state;
    }

    struct Pool {
        address underlying;
        address collateral;
        uint256 totalLiquidity;
        uint256 utilizedLiquidity;
        uint256 totalPremiums;
        bool isActive;
    }

    struct Greeks {
        int256 delta;               // Price sensitivity (scaled 1e4)
        int256 gamma;               // Delta sensitivity
        int256 theta;               // Time decay
        int256 vega;                // Volatility sensitivity
        uint256 impliedVolatility;  // IV (scaled 1e4)
    }

    // ============ State Variables ============

    // Options
    mapping(uint256 => Option) public options;
    uint256 public optionCounter;

    // Pools for liquidity provision
    mapping(bytes32 => Pool) public pools; // keccak256(underlying, collateral) => Pool
    mapping(bytes32 => mapping(address => uint256)) public lpBalances;

    // Price oracle interface
    address public priceOracle;

    // Fees (basis points)
    uint256 public writingFee = 50;      // 0.5%
    uint256 public exerciseFee = 30;     // 0.3%
    uint256 public constant MAX_FEE = 500;
    uint256 public constant BASIS_POINTS = 10000;

    // Collateral ratios (basis points)
    uint256 public callCollateralRatio = 10000;  // 100% for calls
    uint256 public putCollateralRatio = 10000;   // 100% for puts

    // Supported assets
    mapping(address => bool) public supportedAssets;
    address[] public assetList;

    // Stats
    uint256 public totalOptionsWritten;
    uint256 public totalOptionsExercised;
    uint256 public totalPremiumsCollected;
    uint256 public totalVolumeTraded;

    // ============ Events ============

    event OptionWritten(
        uint256 indexed optionId,
        address indexed writer,
        address underlying,
        OptionType optionType,
        uint256 strikePrice,
        uint256 amount,
        uint256 expiry
    );

    event OptionPurchased(
        uint256 indexed optionId,
        address indexed buyer,
        uint256 premium
    );

    event OptionExercised(
        uint256 indexed optionId,
        address indexed holder,
        uint256 profit
    );

    event OptionExpired(uint256 indexed optionId);
    event OptionCancelled(uint256 indexed optionId);
    event LiquidityAdded(bytes32 indexed poolId, address indexed provider, uint256 amount);
    event LiquidityRemoved(bytes32 indexed poolId, address indexed provider, uint256 amount);
    event AssetAdded(address indexed asset);

    // ============ Constructor ============

    constructor(address _priceOracle) ERC721("Synapse Options", "SYNOPT") Ownable(msg.sender) {
        priceOracle = _priceOracle;
    }

    // ============ Option Writing ============

    /**
     * @notice Write (sell) a new option
     */
    function writeOption(
        address underlying,
        address collateral,
        uint256 strikePrice,
        uint256 amount,
        uint256 expiry,
        OptionType optionType,
        OptionStyle style
    ) external nonReentrant whenNotPaused returns (uint256) {
        require(supportedAssets[underlying], "Asset not supported");
        require(expiry > block.timestamp, "Invalid expiry");
        require(amount > 0, "Invalid amount");
        require(strikePrice > 0, "Invalid strike");

        // Calculate required collateral
        uint256 collateralRequired = _calculateCollateral(
            underlying,
            collateral,
            strikePrice,
            amount,
            optionType
        );

        // Transfer collateral from writer
        IERC20(collateral).safeTransferFrom(msg.sender, address(this), collateralRequired);

        optionCounter++;
        uint256 optionId = optionCounter;

        options[optionId] = Option({
            optionId: optionId,
            writer: msg.sender,
            holder: address(0),
            underlying: underlying,
            collateral: collateral,
            strikePrice: strikePrice,
            amount: amount,
            premium: 0,
            collateralAmount: collateralRequired,
            expiry: expiry,
            optionType: optionType,
            style: style,
            state: OptionState.ACTIVE
        });

        // Mint option NFT to writer (they can sell/transfer it)
        _mint(msg.sender, optionId);

        totalOptionsWritten++;

        emit OptionWritten(optionId, msg.sender, underlying, optionType, strikePrice, amount, expiry);

        return optionId;
    }

    /**
     * @notice Purchase an option from writer
     */
    function purchaseOption(uint256 optionId, uint256 maxPremium) external nonReentrant whenNotPaused {
        Option storage option = options[optionId];
        require(option.state == OptionState.ACTIVE, "Option not active");
        require(option.holder == address(0), "Already purchased");
        require(block.timestamp < option.expiry, "Expired");

        // Calculate premium using Black-Scholes approximation
        uint256 premium = calculatePremium(optionId);
        require(premium <= maxPremium, "Premium too high");

        // Apply writing fee
        uint256 fee = (premium * writingFee) / BASIS_POINTS;
        uint256 writerAmount = premium - fee;

        // Transfer premium
        IERC20(option.collateral).safeTransferFrom(msg.sender, option.writer, writerAmount);
        IERC20(option.collateral).safeTransferFrom(msg.sender, address(this), fee);

        option.holder = msg.sender;
        option.premium = premium;

        // Transfer NFT to buyer
        _transfer(option.writer, msg.sender, optionId);

        totalPremiumsCollected += premium;
        totalVolumeTraded += premium;

        emit OptionPurchased(optionId, msg.sender, premium);
    }

    // ============ Option Exercise ============

    /**
     * @notice Exercise an option
     */
    function exerciseOption(uint256 optionId) external nonReentrant {
        Option storage option = options[optionId];
        require(option.state == OptionState.ACTIVE, "Option not active");
        require(ownerOf(optionId) == msg.sender, "Not option holder");
        
        // Check exercise conditions
        if (option.style == OptionStyle.EUROPEAN) {
            require(block.timestamp >= option.expiry - 1 hours, "Cannot exercise yet");
        }
        require(block.timestamp <= option.expiry, "Expired");

        // Get current price
        uint256 currentPrice = _getPrice(option.underlying);

        // Check if in-the-money
        bool itm;
        uint256 profit;

        if (option.optionType == OptionType.CALL) {
            itm = currentPrice > option.strikePrice;
            if (itm) {
                profit = ((currentPrice - option.strikePrice) * option.amount) / 1e8;
            }
        } else {
            itm = currentPrice < option.strikePrice;
            if (itm) {
                profit = ((option.strikePrice - currentPrice) * option.amount) / 1e8;
            }
        }

        require(itm, "Option not in-the-money");

        // Cap profit at collateral
        if (profit > option.collateralAmount) {
            profit = option.collateralAmount;
        }

        // Apply exercise fee
        uint256 fee = (profit * exerciseFee) / BASIS_POINTS;
        uint256 netProfit = profit - fee;

        option.state = OptionState.EXERCISED;

        // Transfer profit to holder
        IERC20(option.collateral).safeTransfer(msg.sender, netProfit);

        // Return remaining collateral to writer
        uint256 remaining = option.collateralAmount - profit;
        if (remaining > 0) {
            IERC20(option.collateral).safeTransfer(option.writer, remaining);
        }

        // Burn the option NFT
        _burn(optionId);

        totalOptionsExercised++;

        emit OptionExercised(optionId, msg.sender, netProfit);
    }

    /**
     * @notice Expire worthless options and return collateral
     */
    function expireOption(uint256 optionId) external {
        Option storage option = options[optionId];
        require(option.state == OptionState.ACTIVE, "Option not active");
        require(block.timestamp > option.expiry, "Not expired");

        option.state = OptionState.EXPIRED;

        // Return full collateral to writer
        IERC20(option.collateral).safeTransfer(option.writer, option.collateralAmount);

        // Burn the option NFT if it exists
        if (_ownerOf(optionId) != address(0)) {
            _burn(optionId);
        }

        emit OptionExpired(optionId);
    }

    /**
     * @notice Cancel an unsold option
     */
    function cancelOption(uint256 optionId) external nonReentrant {
        Option storage option = options[optionId];
        require(option.writer == msg.sender, "Not writer");
        require(option.state == OptionState.ACTIVE, "Option not active");
        require(option.holder == address(0), "Already sold");

        option.state = OptionState.CANCELLED;

        // Return collateral to writer
        IERC20(option.collateral).safeTransfer(msg.sender, option.collateralAmount);

        // Burn the option NFT
        _burn(optionId);

        emit OptionCancelled(optionId);
    }

    // ============ Liquidity Pool ============

    /**
     * @notice Add liquidity to option writing pool
     */
    function addLiquidity(
        address underlying,
        address collateral,
        uint256 amount
    ) external nonReentrant {
        bytes32 poolId = keccak256(abi.encodePacked(underlying, collateral));
        Pool storage pool = pools[poolId];

        if (!pool.isActive) {
            pool.underlying = underlying;
            pool.collateral = collateral;
            pool.isActive = true;
        }

        IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);

        pool.totalLiquidity += amount;
        lpBalances[poolId][msg.sender] += amount;

        emit LiquidityAdded(poolId, msg.sender, amount);
    }

    /**
     * @notice Remove liquidity from pool
     */
    function removeLiquidity(
        address underlying,
        address collateral,
        uint256 amount
    ) external nonReentrant {
        bytes32 poolId = keccak256(abi.encodePacked(underlying, collateral));
        Pool storage pool = pools[poolId];

        require(lpBalances[poolId][msg.sender] >= amount, "Insufficient balance");
        require(pool.totalLiquidity - pool.utilizedLiquidity >= amount, "Liquidity utilized");

        pool.totalLiquidity -= amount;
        lpBalances[poolId][msg.sender] -= amount;

        IERC20(collateral).safeTransfer(msg.sender, amount);

        emit LiquidityRemoved(poolId, msg.sender, amount);
    }

    // ============ Pricing ============

    /**
     * @notice Calculate option premium using simplified Black-Scholes
     */
    function calculatePremium(uint256 optionId) public view returns (uint256) {
        Option storage option = options[optionId];
        
        uint256 currentPrice = _getPrice(option.underlying);
        uint256 timeToExpiry = option.expiry > block.timestamp 
            ? option.expiry - block.timestamp 
            : 0;

        if (timeToExpiry == 0) return 0;

        // Simplified premium calculation
        // In production, use full Black-Scholes or SABR model
        uint256 intrinsicValue;
        
        if (option.optionType == OptionType.CALL) {
            intrinsicValue = currentPrice > option.strikePrice 
                ? currentPrice - option.strikePrice 
                : 0;
        } else {
            intrinsicValue = option.strikePrice > currentPrice 
                ? option.strikePrice - currentPrice 
                : 0;
        }

        // Time value approximation (volatility * sqrt(time) * price)
        // Using 50% annualized volatility as default
        uint256 volatility = 5000; // 50% in basis points
        uint256 timeValueFactor = _sqrt(timeToExpiry * 1e18 / 365 days);
        uint256 timeValue = (currentPrice * volatility * timeValueFactor) / (BASIS_POINTS * 1e9);

        uint256 premium = ((intrinsicValue + timeValue) * option.amount) / 1e8;
        
        return premium;
    }

    /**
     * @notice Get option Greeks
     */
    function getGreeks(uint256 optionId) external view returns (Greeks memory) {
        Option storage option = options[optionId];
        
        uint256 currentPrice = _getPrice(option.underlying);
        uint256 timeToExpiry = option.expiry > block.timestamp 
            ? option.expiry - block.timestamp 
            : 1;

        // Simplified Greeks calculation
        int256 delta;
        if (option.optionType == OptionType.CALL) {
            delta = currentPrice > option.strikePrice ? 8000 : 2000; // Simplified
        } else {
            delta = currentPrice < option.strikePrice ? -8000 : -2000;
        }

        return Greeks({
            delta: delta,
            gamma: 100,
            theta: -int256((option.premium * 1e4) / timeToExpiry),
            vega: 500,
            impliedVolatility: 5000 // 50%
        });
    }

    // ============ Internal Functions ============

    function _calculateCollateral(
        address underlying,
        address collateral,
        uint256 strikePrice,
        uint256 amount,
        OptionType optionType
    ) internal view returns (uint256) {
        uint256 currentPrice = _getPrice(underlying);
        
        if (optionType == OptionType.CALL) {
            // For calls: collateral = underlying amount * current price
            return (amount * currentPrice * callCollateralRatio) / (1e8 * BASIS_POINTS);
        } else {
            // For puts: collateral = strike price * amount
            return (amount * strikePrice * putCollateralRatio) / (1e8 * BASIS_POINTS);
        }
    }

    function _getPrice(address asset) internal view returns (uint256) {
        // In production, call price oracle
        // For now, return mock price
        return 1e8; // $1.00 with 8 decimals
    }

    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }

    // ============ View Functions ============

    function getOption(uint256 optionId) external view returns (Option memory) {
        return options[optionId];
    }

    function getPool(address underlying, address collateral) external view returns (Pool memory) {
        bytes32 poolId = keccak256(abi.encodePacked(underlying, collateral));
        return pools[poolId];
    }

    function getLPBalance(address underlying, address collateral, address lp) external view returns (uint256) {
        bytes32 poolId = keccak256(abi.encodePacked(underlying, collateral));
        return lpBalances[poolId][lp];
    }

    function isOptionITM(uint256 optionId) external view returns (bool) {
        Option storage option = options[optionId];
        uint256 currentPrice = _getPrice(option.underlying);

        if (option.optionType == OptionType.CALL) {
            return currentPrice > option.strikePrice;
        } else {
            return currentPrice < option.strikePrice;
        }
    }

    // ============ Admin Functions ============

    function addSupportedAsset(address asset) external onlyOwner {
        require(!supportedAssets[asset], "Already supported");
        supportedAssets[asset] = true;
        assetList.push(asset);
        emit AssetAdded(asset);
    }

    function setFees(uint256 _writingFee, uint256 _exerciseFee) external onlyOwner {
        require(_writingFee <= MAX_FEE && _exerciseFee <= MAX_FEE, "Fee too high");
        writingFee = _writingFee;
        exerciseFee = _exerciseFee;
    }

    function setPriceOracle(address _oracle) external onlyOwner {
        priceOracle = _oracle;
    }

    function setCollateralRatios(uint256 _callRatio, uint256 _putRatio) external onlyOwner {
        callCollateralRatio = _callRatio;
        putCollateralRatio = _putRatio;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
