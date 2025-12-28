// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title StakingRewards
 * @notice Staking contract with time-weighted rewards for SYNX token holders
 * @dev Implements a fair staking mechanism with lock periods, boosts, and compounding
 */
contract StakingRewards is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ============ Roles ============
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant REWARDS_DISTRIBUTOR_ROLE = keccak256("REWARDS_DISTRIBUTOR_ROLE");

    // ============ Structs ============
    
    /**
     * @notice Staking position
     */
    struct Stake {
        uint256 amount;             // Staked amount
        uint256 shares;             // Share of the pool
        uint256 lockEnd;            // Lock period end (0 = no lock)
        uint256 rewardDebt;         // Reward debt for accounting
        uint256 pendingRewards;     // Accumulated pending rewards
        uint256 lastClaimTime;      // Last reward claim timestamp
        uint256 boostMultiplier;    // Boost multiplier (100 = 1x, 200 = 2x)
        uint256 createdAt;          // Position creation time
    }

    /**
     * @notice Lock tier configuration
     */
    struct LockTier {
        uint256 duration;           // Lock duration in seconds
        uint256 boostMultiplier;    // Boost multiplier (100 = 1x)
        uint256 earlyWithdrawPenalty; // Penalty for early withdrawal (in bps)
        bool active;                // Is tier active
    }

    /**
     * @notice Reward epoch
     */
    struct RewardEpoch {
        uint256 startTime;          // Epoch start
        uint256 endTime;            // Epoch end
        uint256 totalRewards;       // Total rewards for epoch
        uint256 rewardRate;         // Rewards per second
        bool distributed;           // Whether rewards have been distributed
    }

    // ============ State Variables ============
    
    IERC20 public stakingToken;
    IERC20 public rewardToken;
    
    // Pool state
    uint256 public totalStaked;
    uint256 public totalShares;
    uint256 public accRewardPerShare; // Accumulated rewards per share (scaled by 1e12)
    uint256 public lastRewardTime;
    
    // Reward configuration
    uint256 public rewardRate; // Rewards per second
    uint256 public rewardEndTime;
    uint256 public constant PRECISION = 1e12;
    
    // Staking limits
    uint256 public minStake;
    uint256 public maxStake;
    uint256 public cooldownPeriod; // Time between unstake and withdraw
    
    // User stakes
    mapping(address => Stake) public stakes;
    mapping(address => uint256) public cooldownStart; // Unstake cooldown start
    mapping(address => uint256) public cooldownAmount; // Amount in cooldown
    
    // Lock tiers
    mapping(uint256 => LockTier) public lockTiers;
    uint256[] public lockTierIds;
    
    // Epochs
    RewardEpoch[] public epochs;
    uint256 public currentEpoch;
    
    // Statistics
    uint256 public totalRewardsDistributed;
    uint256 public totalStakers;
    
    // ============ Events ============
    
    event Staked(
        address indexed user,
        uint256 amount,
        uint256 shares,
        uint256 lockDuration,
        uint256 boostMultiplier
    );
    
    event Unstaked(
        address indexed user,
        uint256 amount,
        uint256 shares,
        uint256 penalty
    );
    
    event RewardsClaimed(
        address indexed user,
        uint256 amount
    );
    
    event Compounded(
        address indexed user,
        uint256 rewardAmount,
        uint256 newShares
    );
    
    event CooldownStarted(
        address indexed user,
        uint256 amount,
        uint256 cooldownEnd
    );
    
    event CooldownCancelled(address indexed user);
    
    event RewardsAdded(uint256 amount, uint256 duration);
    
    event LockTierAdded(
        uint256 indexed tierId,
        uint256 duration,
        uint256 boostMultiplier
    );
    
    event EpochStarted(
        uint256 indexed epochId,
        uint256 totalRewards,
        uint256 startTime,
        uint256 endTime
    );

    // ============ Constructor ============
    
    constructor(
        address _stakingToken,
        address _rewardToken,
        uint256 _minStake,
        uint256 _maxStake,
        uint256 _cooldownPeriod
    ) {
        require(_stakingToken != address(0), "Invalid staking token");
        require(_rewardToken != address(0), "Invalid reward token");
        
        stakingToken = IERC20(_stakingToken);
        rewardToken = IERC20(_rewardToken);
        minStake = _minStake;
        maxStake = _maxStake;
        cooldownPeriod = _cooldownPeriod;
        lastRewardTime = block.timestamp;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
        _grantRole(REWARDS_DISTRIBUTOR_ROLE, msg.sender);
        
        // Initialize default lock tiers
        _addLockTier(0, 0, 100, 0); // No lock, 1x boost
        _addLockTier(1, 30 days, 125, 500); // 30 days, 1.25x boost, 5% penalty
        _addLockTier(2, 90 days, 150, 1000); // 90 days, 1.5x boost, 10% penalty
        _addLockTier(3, 180 days, 200, 1500); // 180 days, 2x boost, 15% penalty
        _addLockTier(4, 365 days, 300, 2000); // 365 days, 3x boost, 20% penalty
    }

    // ============ Staking Functions ============
    
    /**
     * @notice Stake tokens
     */
    function stake(uint256 amount, uint256 lockTierId) external nonReentrant whenNotPaused {
        require(amount >= minStake, "Below minimum stake");
        require(maxStake == 0 || amount <= maxStake, "Above maximum stake");
        
        LockTier storage tier = lockTiers[lockTierId];
        require(tier.active || lockTierId == 0, "Invalid lock tier");
        
        // Update rewards
        _updateRewards();
        
        // Handle existing stake
        Stake storage userStake = stakes[msg.sender];
        if (userStake.amount > 0) {
            // Claim pending rewards first
            uint256 pending = _calculatePending(msg.sender);
            if (pending > 0) {
                userStake.pendingRewards += pending;
            }
            
            // Check if extending lock
            if (tier.duration > 0) {
                uint256 newLockEnd = block.timestamp + tier.duration;
                require(
                    newLockEnd >= userStake.lockEnd,
                    "Cannot reduce lock duration"
                );
                userStake.lockEnd = newLockEnd;
                userStake.boostMultiplier = tier.boostMultiplier;
            }
        } else {
            // New staker
            totalStakers++;
            userStake.createdAt = block.timestamp;
            userStake.boostMultiplier = tier.boostMultiplier;
            
            if (tier.duration > 0) {
                userStake.lockEnd = block.timestamp + tier.duration;
            }
        }
        
        // Transfer tokens
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        
        // Calculate shares with boost
        uint256 shares = _calculateShares(amount, userStake.boostMultiplier);
        
        // Update state
        userStake.amount += amount;
        userStake.shares += shares;
        userStake.rewardDebt = (userStake.shares * accRewardPerShare) / PRECISION;
        userStake.lastClaimTime = block.timestamp;
        
        totalStaked += amount;
        totalShares += shares;
        
        emit Staked(msg.sender, amount, shares, tier.duration, tier.boostMultiplier);
    }
    
    /**
     * @notice Initiate unstake (starts cooldown)
     */
    function initiateUnstake(uint256 amount) external nonReentrant {
        Stake storage userStake = stakes[msg.sender];
        require(userStake.amount >= amount, "Insufficient stake");
        require(cooldownAmount[msg.sender] == 0, "Cooldown already active");
        
        // Check lock period
        bool earlyWithdraw = userStake.lockEnd > block.timestamp;
        
        // Update rewards first
        _updateRewards();
        uint256 pending = _calculatePending(msg.sender);
        if (pending > 0) {
            userStake.pendingRewards += pending;
        }
        
        // Calculate shares to remove
        uint256 sharesToRemove = (amount * userStake.shares) / userStake.amount;
        
        // Apply early withdrawal penalty if applicable
        uint256 penalty = 0;
        if (earlyWithdraw && userStake.lockEnd > 0) {
            // Find the lock tier
            for (uint256 i = 0; i < lockTierIds.length; i++) {
                LockTier storage tier = lockTiers[lockTierIds[i]];
                if (tier.boostMultiplier == userStake.boostMultiplier) {
                    penalty = (amount * tier.earlyWithdrawPenalty) / 10000;
                    break;
                }
            }
        }
        
        // Update state
        userStake.amount -= amount;
        userStake.shares -= sharesToRemove;
        userStake.rewardDebt = (userStake.shares * accRewardPerShare) / PRECISION;
        
        totalStaked -= amount;
        totalShares -= sharesToRemove;
        
        // Start cooldown
        cooldownStart[msg.sender] = block.timestamp;
        cooldownAmount[msg.sender] = amount - penalty;
        
        // Transfer penalty to rewards
        if (penalty > 0) {
            // Penalty goes back to reward pool
            totalStaked += penalty; // Re-add as staking rewards
        }
        
        emit Unstaked(msg.sender, amount, sharesToRemove, penalty);
        emit CooldownStarted(msg.sender, amount - penalty, block.timestamp + cooldownPeriod);
        
        // Check if user has fully unstaked
        if (userStake.amount == 0) {
            totalStakers--;
        }
    }
    
    /**
     * @notice Complete unstake after cooldown
     */
    function completeUnstake() external nonReentrant {
        require(cooldownAmount[msg.sender] > 0, "No cooldown active");
        require(
            block.timestamp >= cooldownStart[msg.sender] + cooldownPeriod,
            "Cooldown not finished"
        );
        
        uint256 amount = cooldownAmount[msg.sender];
        cooldownAmount[msg.sender] = 0;
        cooldownStart[msg.sender] = 0;
        
        stakingToken.safeTransfer(msg.sender, amount);
    }
    
    /**
     * @notice Cancel cooldown and restake
     */
    function cancelCooldown() external nonReentrant {
        require(cooldownAmount[msg.sender] > 0, "No cooldown active");
        
        uint256 amount = cooldownAmount[msg.sender];
        cooldownAmount[msg.sender] = 0;
        cooldownStart[msg.sender] = 0;
        
        // Restake
        Stake storage userStake = stakes[msg.sender];
        uint256 shares = _calculateShares(amount, userStake.boostMultiplier);
        
        userStake.amount += amount;
        userStake.shares += shares;
        totalStaked += amount;
        totalShares += shares;
        
        if (userStake.createdAt == 0) {
            userStake.createdAt = block.timestamp;
            totalStakers++;
        }
        
        emit CooldownCancelled(msg.sender);
    }
    
    /**
     * @notice Claim pending rewards
     */
    function claimRewards() external nonReentrant {
        _updateRewards();
        
        Stake storage userStake = stakes[msg.sender];
        uint256 pending = _calculatePending(msg.sender) + userStake.pendingRewards;
        
        require(pending > 0, "No rewards to claim");
        
        userStake.pendingRewards = 0;
        userStake.rewardDebt = (userStake.shares * accRewardPerShare) / PRECISION;
        userStake.lastClaimTime = block.timestamp;
        
        rewardToken.safeTransfer(msg.sender, pending);
        totalRewardsDistributed += pending;
        
        emit RewardsClaimed(msg.sender, pending);
    }
    
    /**
     * @notice Compound rewards (claim and restake)
     */
    function compound() external nonReentrant whenNotPaused {
        require(address(stakingToken) == address(rewardToken), "Cannot compound different tokens");
        
        _updateRewards();
        
        Stake storage userStake = stakes[msg.sender];
        uint256 pending = _calculatePending(msg.sender) + userStake.pendingRewards;
        
        require(pending > 0, "No rewards to compound");
        
        // Calculate new shares
        uint256 newShares = _calculateShares(pending, userStake.boostMultiplier);
        
        // Update state
        userStake.pendingRewards = 0;
        userStake.amount += pending;
        userStake.shares += newShares;
        userStake.rewardDebt = (userStake.shares * accRewardPerShare) / PRECISION;
        userStake.lastClaimTime = block.timestamp;
        
        totalStaked += pending;
        totalShares += newShares;
        totalRewardsDistributed += pending;
        
        emit Compounded(msg.sender, pending, newShares);
    }

    // ============ Reward Management ============
    
    /**
     * @notice Add rewards to the pool
     */
    function addRewards(uint256 amount, uint256 duration) external onlyRole(REWARDS_DISTRIBUTOR_ROLE) {
        require(amount > 0, "Amount must be > 0");
        require(duration > 0, "Duration must be > 0");
        
        _updateRewards();
        
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        
        if (block.timestamp >= rewardEndTime) {
            rewardRate = amount / duration;
        } else {
            uint256 remaining = rewardEndTime - block.timestamp;
            uint256 leftover = remaining * rewardRate;
            rewardRate = (amount + leftover) / duration;
        }
        
        rewardEndTime = block.timestamp + duration;
        lastRewardTime = block.timestamp;
        
        emit RewardsAdded(amount, duration);
    }
    
    /**
     * @notice Start new reward epoch
     */
    function startEpoch(uint256 totalRewards, uint256 duration) external onlyRole(REWARDS_DISTRIBUTOR_ROLE) {
        _updateRewards();
        
        rewardToken.safeTransferFrom(msg.sender, address(this), totalRewards);
        
        epochs.push(RewardEpoch({
            startTime: block.timestamp,
            endTime: block.timestamp + duration,
            totalRewards: totalRewards,
            rewardRate: totalRewards / duration,
            distributed: false
        }));
        
        rewardRate = totalRewards / duration;
        rewardEndTime = block.timestamp + duration;
        lastRewardTime = block.timestamp;
        currentEpoch = epochs.length - 1;
        
        emit EpochStarted(currentEpoch, totalRewards, block.timestamp, block.timestamp + duration);
    }
    
    /**
     * @dev Update reward accounting
     */
    function _updateRewards() internal {
        if (block.timestamp <= lastRewardTime || totalShares == 0) {
            lastRewardTime = block.timestamp;
            return;
        }
        
        uint256 timeElapsed = Math.min(block.timestamp, rewardEndTime) - lastRewardTime;
        if (timeElapsed > 0 && rewardRate > 0) {
            uint256 rewards = timeElapsed * rewardRate;
            accRewardPerShare += (rewards * PRECISION) / totalShares;
        }
        
        lastRewardTime = block.timestamp;
    }
    
    /**
     * @dev Calculate pending rewards for user
     */
    function _calculatePending(address user) internal view returns (uint256) {
        Stake storage userStake = stakes[user];
        if (userStake.shares == 0) return 0;
        
        uint256 accReward = accRewardPerShare;
        
        if (block.timestamp > lastRewardTime && totalShares > 0) {
            uint256 timeElapsed = Math.min(block.timestamp, rewardEndTime) - lastRewardTime;
            if (timeElapsed > 0 && rewardRate > 0) {
                accReward += (timeElapsed * rewardRate * PRECISION) / totalShares;
            }
        }
        
        return (userStake.shares * accReward) / PRECISION - userStake.rewardDebt;
    }
    
    /**
     * @dev Calculate shares based on amount and boost
     */
    function _calculateShares(uint256 amount, uint256 boostMultiplier) internal pure returns (uint256) {
        return (amount * boostMultiplier) / 100;
    }

    // ============ Lock Tier Management ============
    
    /**
     * @notice Add lock tier
     */
    function addLockTier(
        uint256 tierId,
        uint256 duration,
        uint256 boostMultiplier,
        uint256 earlyWithdrawPenalty
    ) external onlyRole(OPERATOR_ROLE) {
        _addLockTier(tierId, duration, boostMultiplier, earlyWithdrawPenalty);
    }
    
    function _addLockTier(
        uint256 tierId,
        uint256 duration,
        uint256 boostMultiplier,
        uint256 earlyWithdrawPenalty
    ) internal {
        require(boostMultiplier >= 100, "Boost must be >= 100");
        require(earlyWithdrawPenalty <= 5000, "Penalty too high"); // Max 50%
        
        lockTiers[tierId] = LockTier({
            duration: duration,
            boostMultiplier: boostMultiplier,
            earlyWithdrawPenalty: earlyWithdrawPenalty,
            active: true
        });
        
        lockTierIds.push(tierId);
        
        emit LockTierAdded(tierId, duration, boostMultiplier);
    }
    
    /**
     * @notice Deactivate lock tier
     */
    function deactivateLockTier(uint256 tierId) external onlyRole(OPERATOR_ROLE) {
        require(tierId != 0, "Cannot deactivate default tier");
        lockTiers[tierId].active = false;
    }

    // ============ View Functions ============
    
    /**
     * @notice Get pending rewards for user
     */
    function pendingRewards(address user) external view returns (uint256) {
        return _calculatePending(user) + stakes[user].pendingRewards;
    }
    
    /**
     * @notice Get stake info for user
     */
    function getStakeInfo(address user) external view returns (
        uint256 amount,
        uint256 shares,
        uint256 lockEnd,
        uint256 boostMultiplier,
        uint256 pendingReward,
        uint256 cooldownAmt,
        uint256 cooldownEnd
    ) {
        Stake storage userStake = stakes[user];
        return (
            userStake.amount,
            userStake.shares,
            userStake.lockEnd,
            userStake.boostMultiplier,
            _calculatePending(user) + userStake.pendingRewards,
            cooldownAmount[user],
            cooldownStart[user] > 0 ? cooldownStart[user] + cooldownPeriod : 0
        );
    }
    
    /**
     * @notice Get APR estimate
     */
    function getAPR() external view returns (uint256) {
        if (totalStaked == 0 || rewardRate == 0) return 0;
        
        uint256 yearlyRewards = rewardRate * 365 days;
        return (yearlyRewards * 10000) / totalStaked; // Returns in basis points
    }
    
    /**
     * @notice Get all lock tiers
     */
    function getLockTiers() external view returns (uint256[] memory) {
        return lockTierIds;
    }
    
    /**
     * @notice Get current epoch info
     */
    function getCurrentEpoch() external view returns (
        uint256 epochId,
        uint256 startTime,
        uint256 endTime,
        uint256 totalRewards,
        uint256 remaining
    ) {
        if (epochs.length == 0) {
            return (0, 0, 0, 0, 0);
        }
        
        RewardEpoch storage epoch = epochs[currentEpoch];
        uint256 timeRemaining = epoch.endTime > block.timestamp ? 
            epoch.endTime - block.timestamp : 0;
        
        return (
            currentEpoch,
            epoch.startTime,
            epoch.endTime,
            epoch.totalRewards,
            timeRemaining * epoch.rewardRate
        );
    }

    // ============ Admin Functions ============
    
    /**
     * @notice Update staking limits
     */
    function setStakingLimits(uint256 _minStake, uint256 _maxStake) external onlyRole(OPERATOR_ROLE) {
        minStake = _minStake;
        maxStake = _maxStake;
    }
    
    /**
     * @notice Update cooldown period
     */
    function setCooldownPeriod(uint256 _cooldownPeriod) external onlyRole(OPERATOR_ROLE) {
        cooldownPeriod = _cooldownPeriod;
    }
    
    /**
     * @notice Emergency withdraw (admin only, for stuck funds)
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(token).safeTransfer(msg.sender, amount);
    }
    
    /**
     * @notice Pause staking
     */
    function pause() external onlyRole(OPERATOR_ROLE) {
        _pause();
    }
    
    /**
     * @notice Unpause staking
     */
    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }
}
