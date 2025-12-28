// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SynapseFeeDistributor
 * @notice Distributes protocol fees to stakers and treasury
 * @dev Implements veToken-style weighted distribution
 */
contract SynapseFeeDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Structs ============

    struct RewardToken {
        address token;
        uint256 totalDistributed;
        uint256 rewardRate;
        uint256 lastUpdateTime;
        uint256 rewardPerShareStored;
        bool isActive;
    }

    struct UserReward {
        uint256 rewardPerSharePaid;
        uint256 rewards;
        uint256 lastClaimTime;
    }

    struct Epoch {
        uint256 epochId;
        uint256 startTime;
        uint256 endTime;
        uint256 totalFees;
        uint256 distributed;
        bool finalized;
    }

    // ============ State Variables ============

    IERC20 public immutable stakingToken;       // veSYNX or staked token
    IERC20 public immutable synxToken;          // SYNX token for buyback

    // Reward tokens
    mapping(address => RewardToken) public rewardTokens;
    address[] public rewardTokenList;

    // User rewards: token => user => UserReward
    mapping(address => mapping(address => UserReward)) public userRewards;

    // Staking balances (or imported from staking contract)
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    // Epochs
    mapping(uint256 => Epoch) public epochs;
    uint256 public currentEpoch;
    uint256 public constant EPOCH_DURATION = 7 days;

    // Distribution config
    uint256 public treasuryShare = 2000;        // 20%
    uint256 public stakersShare = 6000;         // 60%
    uint256 public buybackShare = 2000;         // 20%
    uint256 public constant BASIS_POINTS = 10000;

    // Addresses
    address public treasury;
    address public buybackAddress;

    // Accumulated fees per token
    mapping(address => uint256) public accumulatedFees;

    // ============ Events ============

    event FeesReceived(address indexed token, uint256 amount);
    event RewardsClaimed(address indexed user, address indexed token, uint256 amount);
    event EpochStarted(uint256 indexed epochId, uint256 startTime);
    event EpochFinalized(uint256 indexed epochId, uint256 totalDistributed);
    event RewardTokenAdded(address indexed token);
    event RewardTokenRemoved(address indexed token);
    event DistributionUpdated(uint256 treasury, uint256 stakers, uint256 buyback);
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    // ============ Constructor ============

    constructor(
        address _stakingToken,
        address _synxToken,
        address _treasury
    ) Ownable(msg.sender) {
        stakingToken = IERC20(_stakingToken);
        synxToken = IERC20(_synxToken);
        treasury = _treasury;
        buybackAddress = address(this);

        // Start first epoch
        currentEpoch = 1;
        epochs[currentEpoch] = Epoch({
            epochId: 1,
            startTime: block.timestamp,
            endTime: block.timestamp + EPOCH_DURATION,
            totalFees: 0,
            distributed: 0,
            finalized: false
        });

        emit EpochStarted(1, block.timestamp);
    }

    // ============ Staking (if standalone) ============

    /**
     * @notice Stake tokens to receive fee share
     */
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "Cannot stake 0");

        _updateRewards(msg.sender);

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        balanceOf[msg.sender] += amount;
        totalSupply += amount;

        emit Staked(msg.sender, amount);
    }

    /**
     * @notice Withdraw staked tokens
     */
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "Cannot withdraw 0");
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");

        _updateRewards(msg.sender);

        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;

        stakingToken.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // ============ Fee Collection ============

    /**
     * @notice Receive fees from protocol contracts
     */
    function receiveFees(address token, uint256 amount) external {
        require(amount > 0, "Zero amount");

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        accumulatedFees[token] += amount;
        epochs[currentEpoch].totalFees += amount;

        emit FeesReceived(token, amount);
    }

    /**
     * @notice Distribute accumulated fees
     */
    function distributeFees(address token) external nonReentrant {
        uint256 fees = accumulatedFees[token];
        require(fees > 0, "No fees to distribute");

        // Calculate shares
        uint256 treasuryAmount = (fees * treasuryShare) / BASIS_POINTS;
        uint256 buybackAmount = (fees * buybackShare) / BASIS_POINTS;
        uint256 stakersAmount = fees - treasuryAmount - buybackAmount;

        // Send to treasury
        if (treasuryAmount > 0) {
            IERC20(token).safeTransfer(treasury, treasuryAmount);
        }

        // Send for buyback (or execute buyback)
        if (buybackAmount > 0) {
            IERC20(token).safeTransfer(buybackAddress, buybackAmount);
        }

        // Distribute to stakers
        if (stakersAmount > 0 && totalSupply > 0) {
            _distributeToStakers(token, stakersAmount);
        }

        accumulatedFees[token] = 0;
        epochs[currentEpoch].distributed += fees;
    }

    /**
     * @notice Distribute rewards to stakers
     */
    function _distributeToStakers(address token, uint256 amount) internal {
        RewardToken storage rt = rewardTokens[token];

        if (!rt.isActive) {
            // Add new reward token
            rt.token = token;
            rt.isActive = true;
            rewardTokenList.push(token);
            emit RewardTokenAdded(token);
        }

        uint256 duration = EPOCH_DURATION;
        
        if (block.timestamp >= rt.lastUpdateTime + duration) {
            rt.rewardRate = amount / duration;
        } else {
            uint256 remaining = (rt.lastUpdateTime + duration) - block.timestamp;
            uint256 leftover = remaining * rt.rewardRate;
            rt.rewardRate = (amount + leftover) / duration;
        }

        rt.lastUpdateTime = block.timestamp;
        rt.totalDistributed += amount;
    }

    // ============ Rewards Calculation ============

    function _updateRewards(address account) internal {
        for (uint256 i = 0; i < rewardTokenList.length; i++) {
            address token = rewardTokenList[i];
            _updateReward(token, account);
        }
    }

    function _updateReward(address token, address account) internal {
        RewardToken storage rt = rewardTokens[token];
        rt.rewardPerShareStored = rewardPerShare(token);
        rt.lastUpdateTime = lastTimeRewardApplicable(token);

        if (account != address(0)) {
            userRewards[token][account].rewards = earned(account, token);
            userRewards[token][account].rewardPerSharePaid = rt.rewardPerShareStored;
        }
    }

    function rewardPerShare(address token) public view returns (uint256) {
        RewardToken storage rt = rewardTokens[token];
        
        if (totalSupply == 0) {
            return rt.rewardPerShareStored;
        }

        return rt.rewardPerShareStored + (
            (lastTimeRewardApplicable(token) - rt.lastUpdateTime) * rt.rewardRate * 1e18 / totalSupply
        );
    }

    function lastTimeRewardApplicable(address token) public view returns (uint256) {
        RewardToken storage rt = rewardTokens[token];
        uint256 periodEnd = rt.lastUpdateTime + EPOCH_DURATION;
        return block.timestamp < periodEnd ? block.timestamp : periodEnd;
    }

    function earned(address account, address token) public view returns (uint256) {
        UserReward storage ur = userRewards[token][account];
        
        return (
            balanceOf[account] * (rewardPerShare(token) - ur.rewardPerSharePaid) / 1e18
        ) + ur.rewards;
    }

    // ============ Claiming ============

    /**
     * @notice Claim all pending rewards
     */
    function claimAll() external nonReentrant {
        _updateRewards(msg.sender);

        for (uint256 i = 0; i < rewardTokenList.length; i++) {
            address token = rewardTokenList[i];
            _claimReward(token);
        }
    }

    /**
     * @notice Claim rewards for specific token
     */
    function claim(address token) external nonReentrant {
        _updateReward(token, msg.sender);
        _claimReward(token);
    }

    function _claimReward(address token) internal {
        UserReward storage ur = userRewards[token][msg.sender];
        uint256 reward = ur.rewards;

        if (reward > 0) {
            ur.rewards = 0;
            ur.lastClaimTime = block.timestamp;

            IERC20(token).safeTransfer(msg.sender, reward);

            emit RewardsClaimed(msg.sender, token, reward);
        }
    }

    // ============ Epoch Management ============

    /**
     * @notice Finalize current epoch and start new one
     */
    function finalizeEpoch() external {
        Epoch storage epoch = epochs[currentEpoch];
        require(block.timestamp >= epoch.endTime, "Epoch not ended");
        require(!epoch.finalized, "Already finalized");

        epoch.finalized = true;

        emit EpochFinalized(currentEpoch, epoch.distributed);

        // Start new epoch
        currentEpoch++;
        epochs[currentEpoch] = Epoch({
            epochId: currentEpoch,
            startTime: block.timestamp,
            endTime: block.timestamp + EPOCH_DURATION,
            totalFees: 0,
            distributed: 0,
            finalized: false
        });

        emit EpochStarted(currentEpoch, block.timestamp);
    }

    // ============ View Functions ============

    function getRewardTokens() external view returns (address[] memory) {
        return rewardTokenList;
    }

    function getPendingRewards(address account) external view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = rewardTokenList;
        amounts = new uint256[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            amounts[i] = earned(account, tokens[i]);
        }
    }

    function getEpochInfo(uint256 epochId) external view returns (Epoch memory) {
        return epochs[epochId];
    }

    function getCurrentEpochInfo() external view returns (Epoch memory) {
        return epochs[currentEpoch];
    }

    function getTotalAccumulatedFees(address token) external view returns (uint256) {
        return accumulatedFees[token];
    }

    // ============ Admin Functions ============

    function setDistributionShares(
        uint256 _treasuryShare,
        uint256 _stakersShare,
        uint256 _buybackShare
    ) external onlyOwner {
        require(_treasuryShare + _stakersShare + _buybackShare == BASIS_POINTS, "Invalid shares");
        
        treasuryShare = _treasuryShare;
        stakersShare = _stakersShare;
        buybackShare = _buybackShare;

        emit DistributionUpdated(_treasuryShare, _stakersShare, _buybackShare);
    }

    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
    }

    function setBuybackAddress(address _buyback) external onlyOwner {
        buybackAddress = _buyback;
    }

    function removeRewardToken(address token) external onlyOwner {
        rewardTokens[token].isActive = false;
        emit RewardTokenRemoved(token);
    }

    /**
     * @notice Emergency token recovery
     */
    function recoverToken(address token, uint256 amount) external onlyOwner {
        require(token != address(stakingToken), "Cannot recover staking token");
        IERC20(token).safeTransfer(owner(), amount);
    }
}
