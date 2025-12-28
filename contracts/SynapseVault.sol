// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapseVault
 * @notice Yield optimization vault with auto-compounding strategies
 * @dev ERC4626-like vault with multiple yield sources
 */
contract SynapseVault is ERC20, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Roles ============

    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // ============ Structs ============

    struct Strategy {
        address strategyAddress;
        uint256 allocation;        // Allocation in basis points
        uint256 deposited;
        uint256 lastHarvest;
        bool isActive;
        string name;
    }

    struct UserDeposit {
        uint256 shares;
        uint256 depositTime;
        uint256 depositValue;
    }

    struct VaultStats {
        uint256 totalDeposited;
        uint256 totalWithdrawn;
        uint256 totalHarvested;
        uint256 highWaterMark;
        uint256 lastHarvestTime;
    }

    // ============ State Variables ============

    IERC20 public immutable asset;

    // Strategies
    Strategy[] public strategies;
    mapping(address => uint256) public strategyIndex;

    // User data
    mapping(address => UserDeposit) public userDeposits;

    // Vault stats
    VaultStats public vaultStats;

    // Fees (in basis points)
    uint256 public managementFee = 200;      // 2% annual
    uint256 public performanceFee = 2000;    // 20% of profits
    uint256 public withdrawalFee = 50;       // 0.5%
    uint256 public constant MAX_FEE = 3000;  // 30%
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant SECONDS_PER_YEAR = 31536000;

    address public feeRecipient;

    // Limits
    uint256 public depositLimit;
    uint256 public userDepositLimit;
    uint256 public minDeposit = 1e18;        // 1 token minimum

    // Timing
    uint256 public harvestCooldown = 1 hours;
    uint256 public lastManagementFeeTime;

    // ============ Events ============

    event Deposit(address indexed user, uint256 assets, uint256 shares);
    event Withdraw(address indexed user, uint256 assets, uint256 shares);
    event StrategyAdded(address indexed strategy, string name, uint256 allocation);
    event StrategyRemoved(address indexed strategy);
    event StrategyHarvested(address indexed strategy, uint256 profit);
    event Rebalanced(uint256 timestamp);
    event FeesCollected(uint256 managementFee, uint256 performanceFee);

    // ============ Constructor ============

    constructor(
        address _asset,
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) {
        asset = IERC20(_asset);
        feeRecipient = msg.sender;
        depositLimit = type(uint256).max;
        userDepositLimit = type(uint256).max;
        lastManagementFeeTime = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(STRATEGIST_ROLE, msg.sender);
        _grantRole(KEEPER_ROLE, msg.sender);
    }

    // ============ Deposit/Withdraw ============

    /**
     * @notice Deposit assets and receive vault shares
     */
    function deposit(uint256 assets) external nonReentrant whenNotPaused returns (uint256 shares) {
        require(assets >= minDeposit, "Below minimum deposit");
        require(totalAssets() + assets <= depositLimit, "Deposit limit reached");
        
        UserDeposit storage userDep = userDeposits[msg.sender];
        require(userDep.depositValue + assets <= userDepositLimit, "User limit reached");

        // Calculate shares
        shares = previewDeposit(assets);
        require(shares > 0, "Zero shares");

        // Transfer assets
        asset.safeTransferFrom(msg.sender, address(this), assets);

        // Mint shares
        _mint(msg.sender, shares);

        // Update user deposit info
        userDep.shares += shares;
        userDep.depositTime = block.timestamp;
        userDep.depositValue += assets;

        // Update vault stats
        vaultStats.totalDeposited += assets;

        emit Deposit(msg.sender, assets, shares);
    }

    /**
     * @notice Withdraw assets by burning shares
     */
    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        require(shares > 0, "Zero shares");
        require(balanceOf(msg.sender) >= shares, "Insufficient shares");

        // Calculate assets
        assets = previewWithdraw(shares);

        // Apply withdrawal fee
        uint256 fee = (assets * withdrawalFee) / BASIS_POINTS;
        uint256 netAssets = assets - fee;

        // Burn shares
        _burn(msg.sender, shares);

        // Withdraw from strategies if needed
        uint256 available = asset.balanceOf(address(this));
        if (available < netAssets) {
            _withdrawFromStrategies(netAssets - available);
        }

        // Transfer assets
        asset.safeTransfer(msg.sender, netAssets);
        if (fee > 0) {
            asset.safeTransfer(feeRecipient, fee);
        }

        // Update user deposit info
        UserDeposit storage userDep = userDeposits[msg.sender];
        userDep.shares -= shares;
        userDep.depositValue = (userDep.depositValue * userDep.shares) / (userDep.shares + shares);

        // Update vault stats
        vaultStats.totalWithdrawn += assets;

        emit Withdraw(msg.sender, assets, shares);
    }

    /**
     * @notice Withdraw all user's shares
     */
    function withdrawAll() external returns (uint256 assets) {
        return withdraw(balanceOf(msg.sender));
    }

    // ============ Strategy Management ============

    /**
     * @notice Add a new yield strategy
     */
    function addStrategy(
        address strategyAddress,
        uint256 allocation,
        string calldata name
    ) external onlyRole(STRATEGIST_ROLE) {
        require(strategyAddress != address(0), "Invalid address");
        require(strategyIndex[strategyAddress] == 0, "Strategy exists");

        strategies.push(Strategy({
            strategyAddress: strategyAddress,
            allocation: allocation,
            deposited: 0,
            lastHarvest: block.timestamp,
            isActive: true,
            name: name
        }));

        strategyIndex[strategyAddress] = strategies.length; // 1-indexed

        emit StrategyAdded(strategyAddress, name, allocation);
    }

    /**
     * @notice Update strategy allocation
     */
    function setStrategyAllocation(
        address strategyAddress,
        uint256 allocation
    ) external onlyRole(STRATEGIST_ROLE) {
        uint256 index = strategyIndex[strategyAddress];
        require(index > 0, "Strategy not found");
        strategies[index - 1].allocation = allocation;
    }

    /**
     * @notice Deactivate a strategy
     */
    function deactivateStrategy(address strategyAddress) external onlyRole(STRATEGIST_ROLE) {
        uint256 index = strategyIndex[strategyAddress];
        require(index > 0, "Strategy not found");
        strategies[index - 1].isActive = false;
        emit StrategyRemoved(strategyAddress);
    }

    /**
     * @notice Harvest profits from all strategies
     */
    function harvestAll() external onlyRole(KEEPER_ROLE) {
        require(block.timestamp >= vaultStats.lastHarvestTime + harvestCooldown, "Cooldown active");

        uint256 totalProfit = 0;

        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].isActive) {
                uint256 profit = _harvestStrategy(i);
                totalProfit += profit;
            }
        }

        // Collect performance fee on profits
        if (totalProfit > 0) {
            uint256 perfFee = (totalProfit * performanceFee) / BASIS_POINTS;
            if (perfFee > 0) {
                asset.safeTransfer(feeRecipient, perfFee);
            }
            vaultStats.totalHarvested += totalProfit;
        }

        // Collect management fee
        _collectManagementFee();

        vaultStats.lastHarvestTime = block.timestamp;

        // Update high water mark
        uint256 currentValue = totalAssets();
        if (currentValue > vaultStats.highWaterMark) {
            vaultStats.highWaterMark = currentValue;
        }
    }

    /**
     * @notice Harvest a single strategy
     */
    function harvestStrategy(uint256 strategyIndex_) external onlyRole(KEEPER_ROLE) {
        require(strategyIndex_ < strategies.length, "Invalid index");
        _harvestStrategy(strategyIndex_);
    }

    /**
     * @notice Rebalance funds across strategies
     */
    function rebalance() external onlyRole(KEEPER_ROLE) {
        uint256 totalToAllocate = asset.balanceOf(address(this));
        uint256 totalAllocation = _getTotalAllocation();

        if (totalAllocation == 0 || totalToAllocate == 0) return;

        for (uint256 i = 0; i < strategies.length; i++) {
            Strategy storage strategy = strategies[i];
            if (!strategy.isActive) continue;

            uint256 targetAmount = (totalToAllocate * strategy.allocation) / totalAllocation;
            
            if (targetAmount > 0) {
                asset.safeApprove(strategy.strategyAddress, targetAmount);
                // IStrategy(strategy.strategyAddress).deposit(targetAmount);
                strategy.deposited += targetAmount;
            }
        }

        emit Rebalanced(block.timestamp);
    }

    // ============ View Functions ============

    /**
     * @notice Get total assets managed by vault
     */
    function totalAssets() public view returns (uint256) {
        uint256 total = asset.balanceOf(address(this));
        
        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].isActive) {
                total += strategies[i].deposited;
                // In production: total += IStrategy(strategies[i].strategyAddress).balanceOf();
            }
        }
        
        return total;
    }

    /**
     * @notice Preview shares for deposit amount
     */
    function previewDeposit(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            return assets;
        }
        return (assets * supply) / totalAssets();
    }

    /**
     * @notice Preview assets for share amount
     */
    function previewWithdraw(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            return 0;
        }
        return (shares * totalAssets()) / supply;
    }

    /**
     * @notice Get price per share
     */
    function pricePerShare() public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            return 1e18;
        }
        return (totalAssets() * 1e18) / supply;
    }

    /**
     * @notice Get user's current value
     */
    function getUserValue(address user) external view returns (uint256) {
        return previewWithdraw(balanceOf(user));
    }

    /**
     * @notice Get APY (estimated based on recent performance)
     */
    function getAPY() external view returns (uint256) {
        if (vaultStats.totalDeposited == 0) return 0;
        
        uint256 timeSinceStart = block.timestamp - vaultStats.lastHarvestTime;
        if (timeSinceStart == 0) return 0;

        uint256 profit = totalAssets() > vaultStats.totalDeposited 
            ? totalAssets() - vaultStats.totalDeposited 
            : 0;
        
        // Annualize the return
        return (profit * SECONDS_PER_YEAR * BASIS_POINTS) / (vaultStats.totalDeposited * timeSinceStart);
    }

    /**
     * @notice Get all strategies
     */
    function getStrategies() external view returns (Strategy[] memory) {
        return strategies;
    }

    /**
     * @notice Get strategy count
     */
    function strategyCount() external view returns (uint256) {
        return strategies.length;
    }

    // ============ Internal Functions ============

    function _harvestStrategy(uint256 index) internal returns (uint256 profit) {
        Strategy storage strategy = strategies[index];
        
        // In production, would call strategy.harvest() and get profit
        // For now, simulating:
        // profit = IStrategy(strategy.strategyAddress).harvest();
        profit = 0;

        strategy.lastHarvest = block.timestamp;

        if (profit > 0) {
            emit StrategyHarvested(strategy.strategyAddress, profit);
        }

        return profit;
    }

    function _withdrawFromStrategies(uint256 amount) internal {
        uint256 remaining = amount;

        for (uint256 i = 0; i < strategies.length && remaining > 0; i++) {
            Strategy storage strategy = strategies[i];
            if (!strategy.isActive || strategy.deposited == 0) continue;

            uint256 toWithdraw = remaining > strategy.deposited ? strategy.deposited : remaining;
            
            // IStrategy(strategy.strategyAddress).withdraw(toWithdraw);
            strategy.deposited -= toWithdraw;
            remaining -= toWithdraw;
        }
    }

    function _collectManagementFee() internal {
        uint256 timeSinceLastFee = block.timestamp - lastManagementFeeTime;
        if (timeSinceLastFee == 0) return;

        uint256 totalValue = totalAssets();
        uint256 fee = (totalValue * managementFee * timeSinceLastFee) / (BASIS_POINTS * SECONDS_PER_YEAR);

        if (fee > 0 && asset.balanceOf(address(this)) >= fee) {
            asset.safeTransfer(feeRecipient, fee);
            emit FeesCollected(fee, 0);
        }

        lastManagementFeeTime = block.timestamp;
    }

    function _getTotalAllocation() internal view returns (uint256 total) {
        for (uint256 i = 0; i < strategies.length; i++) {
            if (strategies[i].isActive) {
                total += strategies[i].allocation;
            }
        }
    }

    // ============ Admin Functions ============

    /**
     * @notice Set fees
     */
    function setFees(
        uint256 _managementFee,
        uint256 _performanceFee,
        uint256 _withdrawalFee
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_managementFee <= MAX_FEE, "Management fee too high");
        require(_performanceFee <= MAX_FEE, "Performance fee too high");
        require(_withdrawalFee <= MAX_FEE, "Withdrawal fee too high");

        managementFee = _managementFee;
        performanceFee = _performanceFee;
        withdrawalFee = _withdrawalFee;
    }

    /**
     * @notice Set limits
     */
    function setLimits(
        uint256 _depositLimit,
        uint256 _userDepositLimit,
        uint256 _minDeposit
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        depositLimit = _depositLimit;
        userDepositLimit = _userDepositLimit;
        minDeposit = _minDeposit;
    }

    /**
     * @notice Set fee recipient
     */
    function setFeeRecipient(address _recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeRecipient = _recipient;
    }

    /**
     * @notice Set harvest cooldown
     */
    function setHarvestCooldown(uint256 _cooldown) external onlyRole(DEFAULT_ADMIN_ROLE) {
        harvestCooldown = _cooldown;
    }

    /**
     * @notice Emergency withdraw from all strategies
     */
    function emergencyWithdrawAll() external onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint256 i = 0; i < strategies.length; i++) {
            Strategy storage strategy = strategies[i];
            if (strategy.deposited > 0) {
                // IStrategy(strategy.strategyAddress).emergencyWithdraw();
                strategy.deposited = 0;
            }
            strategy.isActive = false;
        }
    }

    /**
     * @notice Pause/unpause
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
}
