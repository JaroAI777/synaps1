// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapseYieldFarm
 * @notice Multi-pool yield farming with boosted rewards
 * @dev Supports multiple LP tokens with configurable reward allocation
 */
contract SynapseYieldFarm is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Structs ============

    struct PoolInfo {
        IERC20 lpToken;           // LP token address
        uint256 allocPoint;       // Allocation points for this pool
        uint256 lastRewardTime;   // Last timestamp rewards were calculated
        uint256 accRewardPerShare; // Accumulated rewards per share (scaled by 1e12)
        uint256 totalStaked;      // Total LP tokens staked
        uint256 depositFee;       // Deposit fee (basis points, max 500 = 5%)
        uint256 withdrawFee;      // Withdrawal fee (basis points, max 500 = 5%)
        bool isActive;            // Pool is accepting deposits
    }

    struct UserInfo {
        uint256 amount;           // LP tokens deposited
        uint256 rewardDebt;       // Reward debt for pending calculation
        uint256 boostMultiplier;  // Boost multiplier (basis points, 10000 = 1x)
        uint256 lastDepositTime;  // Last deposit timestamp
        uint256 lockedUntil;      // Lock end timestamp (for boosted pools)
    }

    struct BoostTier {
        uint256 minStake;         // Minimum SYNX staked for this tier
        uint256 multiplier;       // Boost multiplier (basis points)
    }

    // ============ State Variables ============

    IERC20 public immutable rewardToken;   // SYNX token
    IERC20 public immutable synapseStaking; // Staking contract for boost calculation
    
    uint256 public rewardPerSecond;        // Rewards distributed per second
    uint256 public totalAllocPoint;        // Total allocation points
    uint256 public startTime;              // Farming start time
    uint256 public endTime;                // Farming end time

    PoolInfo[] public poolInfo;
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;
    
    // Boost tiers
    BoostTier[] public boostTiers;
    
    // Fee collection
    address public feeCollector;
    uint256 public collectedFees;

    // Emergency
    bool public emergencyWithdrawEnabled;

    // ============ Constants ============

    uint256 public constant MAX_FEE = 500;      // 5%
    uint256 public constant PRECISION = 1e12;
    uint256 public constant BASIS_POINTS = 10000;

    // ============ Events ============

    event PoolAdded(uint256 indexed pid, address lpToken, uint256 allocPoint);
    event PoolUpdated(uint256 indexed pid, uint256 allocPoint);
    event Deposit(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event Harvest(address indexed user, uint256 indexed pid, uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event RewardRateUpdated(uint256 oldRate, uint256 newRate);
    event BoostUpdated(address indexed user, uint256 indexed pid, uint256 multiplier);

    // ============ Constructor ============

    constructor(
        address _rewardToken,
        address _synapseStaking,
        uint256 _rewardPerSecond,
        uint256 _startTime
    ) Ownable(msg.sender) {
        rewardToken = IERC20(_rewardToken);
        synapseStaking = IERC20(_synapseStaking);
        rewardPerSecond = _rewardPerSecond;
        startTime = _startTime;
        endTime = _startTime + 365 days; // Default 1 year
        feeCollector = msg.sender;

        // Initialize boost tiers
        _initializeBoostTiers();
    }

    function _initializeBoostTiers() internal {
        // Tier 0: No stake required, 1x boost
        boostTiers.push(BoostTier({ minStake: 0, multiplier: 10000 }));
        
        // Tier 1: 1,000 SYNX, 1.1x boost
        boostTiers.push(BoostTier({ minStake: 1000 ether, multiplier: 11000 }));
        
        // Tier 2: 5,000 SYNX, 1.25x boost
        boostTiers.push(BoostTier({ minStake: 5000 ether, multiplier: 12500 }));
        
        // Tier 3: 10,000 SYNX, 1.5x boost
        boostTiers.push(BoostTier({ minStake: 10000 ether, multiplier: 15000 }));
        
        // Tier 4: 50,000 SYNX, 2x boost
        boostTiers.push(BoostTier({ minStake: 50000 ether, multiplier: 20000 }));
        
        // Tier 5: 100,000 SYNX, 2.5x boost
        boostTiers.push(BoostTier({ minStake: 100000 ether, multiplier: 25000 }));
    }

    // ============ Pool Management ============

    /**
     * @notice Add a new LP pool
     */
    function addPool(
        address _lpToken,
        uint256 _allocPoint,
        uint256 _depositFee,
        uint256 _withdrawFee,
        bool _withUpdate
    ) external onlyOwner {
        require(_depositFee <= MAX_FEE, "Deposit fee too high");
        require(_withdrawFee <= MAX_FEE, "Withdraw fee too high");

        if (_withUpdate) {
            massUpdatePools();
        }

        totalAllocPoint += _allocPoint;

        poolInfo.push(PoolInfo({
            lpToken: IERC20(_lpToken),
            allocPoint: _allocPoint,
            lastRewardTime: block.timestamp > startTime ? block.timestamp : startTime,
            accRewardPerShare: 0,
            totalStaked: 0,
            depositFee: _depositFee,
            withdrawFee: _withdrawFee,
            isActive: true
        }));

        emit PoolAdded(poolInfo.length - 1, _lpToken, _allocPoint);
    }

    /**
     * @notice Update pool allocation points
     */
    function setPool(
        uint256 _pid,
        uint256 _allocPoint,
        uint256 _depositFee,
        uint256 _withdrawFee,
        bool _withUpdate
    ) external onlyOwner {
        require(_depositFee <= MAX_FEE, "Deposit fee too high");
        require(_withdrawFee <= MAX_FEE, "Withdraw fee too high");

        if (_withUpdate) {
            massUpdatePools();
        }

        totalAllocPoint = totalAllocPoint - poolInfo[_pid].allocPoint + _allocPoint;
        poolInfo[_pid].allocPoint = _allocPoint;
        poolInfo[_pid].depositFee = _depositFee;
        poolInfo[_pid].withdrawFee = _withdrawFee;

        emit PoolUpdated(_pid, _allocPoint);
    }

    /**
     * @notice Update all pools
     */
    function massUpdatePools() public {
        uint256 length = poolInfo.length;
        for (uint256 pid = 0; pid < length; pid++) {
            updatePool(pid);
        }
    }

    /**
     * @notice Update single pool
     */
    function updatePool(uint256 _pid) public {
        PoolInfo storage pool = poolInfo[_pid];
        
        if (block.timestamp <= pool.lastRewardTime) {
            return;
        }

        if (pool.totalStaked == 0 || pool.allocPoint == 0) {
            pool.lastRewardTime = block.timestamp;
            return;
        }

        uint256 timeElapsed = _getTimeElapsed(pool.lastRewardTime, block.timestamp);
        uint256 reward = (timeElapsed * rewardPerSecond * pool.allocPoint) / totalAllocPoint;

        pool.accRewardPerShare += (reward * PRECISION) / pool.totalStaked;
        pool.lastRewardTime = block.timestamp;
    }

    // ============ User Functions ============

    /**
     * @notice Deposit LP tokens
     */
    function deposit(uint256 _pid, uint256 _amount) external nonReentrant whenNotPaused {
        require(_amount > 0, "Amount must be > 0");
        
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        
        require(pool.isActive, "Pool not active");

        updatePool(_pid);

        // Harvest pending rewards first
        if (user.amount > 0) {
            uint256 pending = _pendingReward(_pid, msg.sender);
            if (pending > 0) {
                _safeRewardTransfer(msg.sender, pending);
                emit Harvest(msg.sender, _pid, pending);
            }
        }

        // Transfer LP tokens
        pool.lpToken.safeTransferFrom(msg.sender, address(this), _amount);

        // Apply deposit fee
        uint256 depositAmount = _amount;
        if (pool.depositFee > 0) {
            uint256 fee = (_amount * pool.depositFee) / BASIS_POINTS;
            pool.lpToken.safeTransfer(feeCollector, fee);
            depositAmount -= fee;
            collectedFees += fee;
        }

        // Update user info
        user.amount += depositAmount;
        user.lastDepositTime = block.timestamp;
        
        // Update boost multiplier
        _updateBoost(_pid, msg.sender);
        
        user.rewardDebt = (user.amount * pool.accRewardPerShare) / PRECISION;
        pool.totalStaked += depositAmount;

        emit Deposit(msg.sender, _pid, depositAmount);
    }

    /**
     * @notice Withdraw LP tokens
     */
    function withdraw(uint256 _pid, uint256 _amount) external nonReentrant {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];

        require(user.amount >= _amount, "Insufficient balance");
        require(block.timestamp >= user.lockedUntil, "Still locked");

        updatePool(_pid);

        // Harvest pending rewards
        uint256 pending = _pendingReward(_pid, msg.sender);
        if (pending > 0) {
            _safeRewardTransfer(msg.sender, pending);
            emit Harvest(msg.sender, _pid, pending);
        }

        uint256 withdrawAmount = _amount;
        
        // Apply withdrawal fee (if within early period)
        if (pool.withdrawFee > 0 && block.timestamp < user.lastDepositTime + 72 hours) {
            uint256 fee = (_amount * pool.withdrawFee) / BASIS_POINTS;
            pool.lpToken.safeTransfer(feeCollector, fee);
            withdrawAmount -= fee;
            collectedFees += fee;
        }

        user.amount -= _amount;
        user.rewardDebt = (user.amount * pool.accRewardPerShare) / PRECISION;
        pool.totalStaked -= _amount;

        pool.lpToken.safeTransfer(msg.sender, withdrawAmount);

        emit Withdraw(msg.sender, _pid, withdrawAmount);
    }

    /**
     * @notice Harvest rewards only
     */
    function harvest(uint256 _pid) external nonReentrant {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];

        updatePool(_pid);

        uint256 pending = _pendingReward(_pid, msg.sender);
        require(pending > 0, "No rewards");

        user.rewardDebt = (user.amount * pool.accRewardPerShare) / PRECISION;
        _safeRewardTransfer(msg.sender, pending);

        emit Harvest(msg.sender, _pid, pending);
    }

    /**
     * @notice Harvest all pools
     */
    function harvestAll() external nonReentrant {
        uint256 totalPending = 0;
        uint256 length = poolInfo.length;

        for (uint256 pid = 0; pid < length; pid++) {
            UserInfo storage user = userInfo[pid][msg.sender];
            if (user.amount > 0) {
                updatePool(pid);
                uint256 pending = _pendingReward(pid, msg.sender);
                if (pending > 0) {
                    totalPending += pending;
                    user.rewardDebt = (user.amount * poolInfo[pid].accRewardPerShare) / PRECISION;
                    emit Harvest(msg.sender, pid, pending);
                }
            }
        }

        if (totalPending > 0) {
            _safeRewardTransfer(msg.sender, totalPending);
        }
    }

    /**
     * @notice Emergency withdraw without rewards
     */
    function emergencyWithdraw(uint256 _pid) external nonReentrant {
        require(emergencyWithdrawEnabled, "Emergency withdraw disabled");

        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];

        uint256 amount = user.amount;
        user.amount = 0;
        user.rewardDebt = 0;
        pool.totalStaked -= amount;

        pool.lpToken.safeTransfer(msg.sender, amount);

        emit EmergencyWithdraw(msg.sender, _pid, amount);
    }

    // ============ Boost Functions ============

    /**
     * @notice Update user's boost multiplier
     */
    function updateBoost(uint256 _pid) external {
        _updateBoost(_pid, msg.sender);
    }

    function _updateBoost(uint256 _pid, address _user) internal {
        UserInfo storage user = userInfo[_pid][_user];
        
        // Get user's staked SYNX from staking contract
        uint256 stakedAmount = synapseStaking.balanceOf(_user);
        
        // Find applicable boost tier
        uint256 multiplier = boostTiers[0].multiplier;
        for (uint256 i = boostTiers.length - 1; i > 0; i--) {
            if (stakedAmount >= boostTiers[i].minStake) {
                multiplier = boostTiers[i].multiplier;
                break;
            }
        }

        if (user.boostMultiplier != multiplier) {
            user.boostMultiplier = multiplier;
            emit BoostUpdated(_user, _pid, multiplier);
        }
    }

    // ============ View Functions ============

    /**
     * @notice Get pending rewards for user
     */
    function pendingReward(uint256 _pid, address _user) external view returns (uint256) {
        return _pendingReward(_pid, _user);
    }

    function _pendingReward(uint256 _pid, address _user) internal view returns (uint256) {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][_user];

        uint256 accRewardPerShare = pool.accRewardPerShare;

        if (block.timestamp > pool.lastRewardTime && pool.totalStaked > 0) {
            uint256 timeElapsed = _getTimeElapsed(pool.lastRewardTime, block.timestamp);
            uint256 reward = (timeElapsed * rewardPerSecond * pool.allocPoint) / totalAllocPoint;
            accRewardPerShare += (reward * PRECISION) / pool.totalStaked;
        }

        uint256 pending = (user.amount * accRewardPerShare) / PRECISION - user.rewardDebt;
        
        // Apply boost multiplier
        uint256 multiplier = user.boostMultiplier > 0 ? user.boostMultiplier : BASIS_POINTS;
        return (pending * multiplier) / BASIS_POINTS;
    }

    /**
     * @notice Get total pending rewards across all pools
     */
    function totalPendingReward(address _user) external view returns (uint256 total) {
        uint256 length = poolInfo.length;
        for (uint256 pid = 0; pid < length; pid++) {
            total += _pendingReward(pid, _user);
        }
    }

    /**
     * @notice Get pool count
     */
    function poolLength() external view returns (uint256) {
        return poolInfo.length;
    }

    /**
     * @notice Get user's boost tier
     */
    function getUserBoostTier(address _user) external view returns (uint256 tier, uint256 multiplier) {
        uint256 stakedAmount = synapseStaking.balanceOf(_user);
        
        for (uint256 i = boostTiers.length - 1; i > 0; i--) {
            if (stakedAmount >= boostTiers[i].minStake) {
                return (i, boostTiers[i].multiplier);
            }
        }
        
        return (0, boostTiers[0].multiplier);
    }

    /**
     * @notice Get APR for pool (approximate)
     */
    function getPoolAPR(uint256 _pid) external view returns (uint256) {
        PoolInfo storage pool = poolInfo[_pid];
        if (pool.totalStaked == 0) return 0;

        uint256 yearlyRewards = rewardPerSecond * 365 days * pool.allocPoint / totalAllocPoint;
        return (yearlyRewards * BASIS_POINTS) / pool.totalStaked;
    }

    // ============ Internal Functions ============

    function _getTimeElapsed(uint256 _from, uint256 _to) internal view returns (uint256) {
        if (_to <= startTime || _from >= endTime) {
            return 0;
        }

        uint256 from = _from > startTime ? _from : startTime;
        uint256 to = _to < endTime ? _to : endTime;

        return to - from;
    }

    function _safeRewardTransfer(address _to, uint256 _amount) internal {
        uint256 balance = rewardToken.balanceOf(address(this));
        uint256 transferAmount = _amount > balance ? balance : _amount;
        if (transferAmount > 0) {
            rewardToken.safeTransfer(_to, transferAmount);
        }
    }

    // ============ Admin Functions ============

    /**
     * @notice Update reward rate
     */
    function setRewardPerSecond(uint256 _rewardPerSecond) external onlyOwner {
        massUpdatePools();
        emit RewardRateUpdated(rewardPerSecond, _rewardPerSecond);
        rewardPerSecond = _rewardPerSecond;
    }

    /**
     * @notice Set farming end time
     */
    function setEndTime(uint256 _endTime) external onlyOwner {
        require(_endTime > block.timestamp, "End time must be future");
        endTime = _endTime;
    }

    /**
     * @notice Add boost tier
     */
    function addBoostTier(uint256 _minStake, uint256 _multiplier) external onlyOwner {
        boostTiers.push(BoostTier({ minStake: _minStake, multiplier: _multiplier }));
    }

    /**
     * @notice Update boost tier
     */
    function updateBoostTier(uint256 _tier, uint256 _minStake, uint256 _multiplier) external onlyOwner {
        require(_tier < boostTiers.length, "Invalid tier");
        boostTiers[_tier] = BoostTier({ minStake: _minStake, multiplier: _multiplier });
    }

    /**
     * @notice Set fee collector
     */
    function setFeeCollector(address _feeCollector) external onlyOwner {
        feeCollector = _feeCollector;
    }

    /**
     * @notice Toggle pool active status
     */
    function setPoolActive(uint256 _pid, bool _isActive) external onlyOwner {
        poolInfo[_pid].isActive = _isActive;
    }

    /**
     * @notice Enable emergency withdraw
     */
    function setEmergencyWithdraw(bool _enabled) external onlyOwner {
        emergencyWithdrawEnabled = _enabled;
    }

    /**
     * @notice Recover wrong tokens
     */
    function recoverToken(address _token, uint256 _amount) external onlyOwner {
        require(_token != address(rewardToken), "Cannot recover reward token");
        IERC20(_token).safeTransfer(owner(), _amount);
    }

    /**
     * @notice Pause/unpause
     */
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
