// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title ReputationRegistry
 * @notice AI Agent Reputation System (AIRS) for SYNAPSE Protocol
 * @dev Manages AI agent registration, reputation tracking, and tier-based benefits
 * 
 * Features:
 * - Agent registration with staking
 * - Reputation scoring based on transaction history
 * - Tier system with benefits
 * - Dispute resolution with slashing
 * - Service category ratings
 */
contract ReputationRegistry is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    
    // ============ Constants ============
    
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");
    
    uint256 public constant SCORE_DECIMALS = 1000; // 3 decimal places
    uint256 public constant MAX_SCORE = 1000 * SCORE_DECIMALS; // 1000.000
    uint256 public constant INITIAL_SCORE = 500 * SCORE_DECIMALS; // 500.000
    uint256 public constant SLASH_DENOMINATOR = 10000;
    
    // ============ Enums ============
    
    enum AgentStatus {
        Unregistered,
        Active,
        Suspended,
        Banned
    }
    
    enum DisputeStatus {
        Open,
        ResolvedForClaimant,
        ResolvedForDefendant,
        Dismissed
    }
    
    // ============ Structs ============
    
    struct AIAgent {
        bytes32 agentId;
        address owner;
        uint256 registrationTime;
        uint256 stakedAmount;
        uint256 reputationScore;
        uint256 totalTransactions;
        uint256 successfulTransactions;
        uint256 failedTransactions;
        uint256 totalVolume;
        uint256 disputesRaised;
        uint256 disputesLost;
        uint8 tier;
        AgentStatus status;
        string metadataURI;
    }
    
    struct ServiceRating {
        uint256 totalRatings;
        uint256 sumRatings;
        uint256 averageRating;
    }
    
    struct Dispute {
        bytes32 disputeId;
        address claimant;
        address defendant;
        bytes32 transactionId;
        uint256 amount;
        uint256 timestamp;
        uint256 deadline;
        DisputeStatus status;
        string evidence;
    }
    
    struct TierRequirements {
        uint256 minTransactions;
        uint256 minSuccessRate; // In basis points (9500 = 95%)
        uint256 minStake;
        uint256 feeDiscount; // In basis points
    }
    
    // ============ State Variables ============
    
    IERC20 public immutable synxToken;
    address public treasury;
    
    uint256 public registrationFee;
    uint256 public minStake;
    uint256 public disputeWindow = 72 hours;
    uint256 public slashPercentage = 1000; // 10%
    
    // Agent storage
    mapping(address => AIAgent) public agents;
    mapping(bytes32 => address) public agentIdToAddress;
    mapping(address => mapping(bytes32 => ServiceRating)) public serviceRatings;
    
    // Dispute storage
    mapping(bytes32 => Dispute) public disputes;
    mapping(address => bytes32[]) public agentDisputes;
    
    // Tier configuration
    mapping(uint8 => TierRequirements) public tierRequirements;
    
    // Statistics
    uint256 public totalAgents;
    uint256 public totalStaked;
    uint256 public totalDisputes;
    
    // ============ Events ============
    
    event AgentRegistered(
        address indexed agent,
        bytes32 indexed agentId,
        uint256 stake,
        string metadataURI
    );
    
    event AgentUpdated(
        address indexed agent,
        uint256 newScore,
        uint8 newTier
    );
    
    event StakeAdded(address indexed agent, uint256 amount, uint256 newTotal);
    event StakeWithdrawn(address indexed agent, uint256 amount, uint256 newTotal);
    event StakeSlashed(address indexed agent, uint256 amount, string reason);
    
    event TransactionRecorded(
        address indexed agent,
        bytes32 indexed transactionId,
        bool success,
        uint256 amount
    );
    
    event ServiceRated(
        address indexed agent,
        bytes32 indexed serviceType,
        address indexed rater,
        uint8 rating
    );
    
    event DisputeCreated(
        bytes32 indexed disputeId,
        address indexed claimant,
        address indexed defendant,
        uint256 amount
    );
    
    event DisputeResolved(
        bytes32 indexed disputeId,
        DisputeStatus resolution,
        address winner
    );
    
    event AgentSuspended(address indexed agent, string reason);
    event AgentReinstated(address indexed agent);
    event AgentBanned(address indexed agent, string reason);
    
    // ============ Errors ============
    
    error AgentNotFound();
    error AgentAlreadyRegistered();
    error InsufficientStake();
    error InvalidRating();
    error InvalidTier();
    error DisputeNotFound();
    error DisputeDeadlinePassed();
    error DisputeAlreadyResolved();
    error Unauthorized();
    error AgentNotActive();
    error WithdrawalLocked();
    
    // ============ Constructor ============
    
    constructor(
        address _synxToken,
        address _treasury,
        uint256 _registrationFee,
        uint256 _minStake
    ) {
        synxToken = IERC20(_synxToken);
        treasury = _treasury;
        registrationFee = _registrationFee;
        minStake = _minStake;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, msg.sender);
        _grantRole(ARBITER_ROLE, msg.sender);
        
        // Initialize tier requirements
        _initializeTiers();
    }
    
    function _initializeTiers() internal {
        // Tier 0: Unverified
        tierRequirements[0] = TierRequirements({
            minTransactions: 0,
            minSuccessRate: 0,
            minStake: 0,
            feeDiscount: 0
        });
        
        // Tier 1: Bronze
        tierRequirements[1] = TierRequirements({
            minTransactions: 100,
            minSuccessRate: 9500, // 95%
            minStake: 0,
            feeDiscount: 0
        });
        
        // Tier 2: Silver
        tierRequirements[2] = TierRequirements({
            minTransactions: 1000,
            minSuccessRate: 9700, // 97%
            minStake: 100 * 10**18, // 100 SYNX
            feeDiscount: 1000 // 10%
        });
        
        // Tier 3: Gold
        tierRequirements[3] = TierRequirements({
            minTransactions: 10000,
            minSuccessRate: 9900, // 99%
            minStake: 1000 * 10**18, // 1,000 SYNX
            feeDiscount: 2500 // 25%
        });
        
        // Tier 4: Platinum
        tierRequirements[4] = TierRequirements({
            minTransactions: 100000,
            minSuccessRate: 9950, // 99.5%
            minStake: 10000 * 10**18, // 10,000 SYNX
            feeDiscount: 5000 // 50%
        });
        
        // Tier 5: Diamond
        tierRequirements[5] = TierRequirements({
            minTransactions: 1000000,
            minSuccessRate: 9990, // 99.9%
            minStake: 100000 * 10**18, // 100,000 SYNX
            feeDiscount: 7500 // 75%
        });
    }
    
    // ============ Registration Functions ============
    
    /**
     * @notice Register a new AI agent
     * @param metadataURI IPFS URI containing agent metadata
     * @param initialStake Initial stake amount (must be >= minStake)
     */
    function registerAgent(
        string calldata metadataURI,
        uint256 initialStake
    ) external nonReentrant whenNotPaused returns (bytes32) {
        if (agents[msg.sender].status != AgentStatus.Unregistered) {
            revert AgentAlreadyRegistered();
        }
        if (initialStake < minStake) revert InsufficientStake();
        
        // Pay registration fee
        if (registrationFee > 0) {
            synxToken.safeTransferFrom(msg.sender, treasury, registrationFee);
        }
        
        // Stake tokens
        synxToken.safeTransferFrom(msg.sender, address(this), initialStake);
        
        // Generate unique agent ID
        bytes32 agentId = keccak256(abi.encodePacked(
            msg.sender,
            block.timestamp,
            block.prevrandao,
            totalAgents
        ));
        
        agents[msg.sender] = AIAgent({
            agentId: agentId,
            owner: msg.sender,
            registrationTime: block.timestamp,
            stakedAmount: initialStake,
            reputationScore: INITIAL_SCORE,
            totalTransactions: 0,
            successfulTransactions: 0,
            failedTransactions: 0,
            totalVolume: 0,
            disputesRaised: 0,
            disputesLost: 0,
            tier: 0,
            status: AgentStatus.Active,
            metadataURI: metadataURI
        });
        
        agentIdToAddress[agentId] = msg.sender;
        totalAgents++;
        totalStaked += initialStake;
        
        emit AgentRegistered(msg.sender, agentId, initialStake, metadataURI);
        
        return agentId;
    }
    
    /**
     * @notice Add stake to an existing agent
     */
    function addStake(uint256 amount) external nonReentrant {
        AIAgent storage agent = agents[msg.sender];
        if (agent.status == AgentStatus.Unregistered) revert AgentNotFound();
        
        synxToken.safeTransferFrom(msg.sender, address(this), amount);
        
        agent.stakedAmount += amount;
        totalStaked += amount;
        
        _updateTier(msg.sender);
        
        emit StakeAdded(msg.sender, amount, agent.stakedAmount);
    }
    
    /**
     * @notice Withdraw stake (subject to tier requirements)
     */
    function withdrawStake(uint256 amount) external nonReentrant {
        AIAgent storage agent = agents[msg.sender];
        if (agent.status == AgentStatus.Unregistered) revert AgentNotFound();
        if (agent.status != AgentStatus.Active) revert AgentNotActive();
        
        // Check minimum stake for current tier
        uint256 minRequired = tierRequirements[agent.tier].minStake;
        if (agent.stakedAmount - amount < minRequired) {
            revert InsufficientStake();
        }
        
        agent.stakedAmount -= amount;
        totalStaked -= amount;
        
        synxToken.safeTransfer(msg.sender, amount);
        
        _updateTier(msg.sender);
        
        emit StakeWithdrawn(msg.sender, amount, agent.stakedAmount);
    }
    
    // ============ Transaction Recording ============
    
    /**
     * @notice Record a completed transaction for an agent
     * @dev Called by authorized oracles (PaymentRouter, etc.)
     */
    function recordTransaction(
        address agentAddress,
        bytes32 transactionId,
        bool success,
        uint256 amount
    ) external onlyRole(REPORTER_ROLE) {
        AIAgent storage agent = agents[agentAddress];
        if (agent.status == AgentStatus.Unregistered) revert AgentNotFound();
        
        agent.totalTransactions++;
        agent.totalVolume += amount;
        
        if (success) {
            agent.successfulTransactions++;
            _increaseScore(agentAddress, _calculateScoreIncrease(amount));
        } else {
            agent.failedTransactions++;
            _decreaseScore(agentAddress, _calculateScoreDecrease(amount));
        }
        
        _updateTier(agentAddress);
        
        emit TransactionRecorded(agentAddress, transactionId, success, amount);
    }
    
    /**
     * @notice Rate an agent's service
     * @param agentAddress Address of the agent being rated
     * @param serviceType Type of service being rated
     * @param rating Rating from 1-5
     */
    function rateService(
        address agentAddress,
        bytes32 serviceType,
        uint8 rating
    ) external {
        if (rating < 1 || rating > 5) revert InvalidRating();
        
        AIAgent storage agent = agents[agentAddress];
        if (agent.status == AgentStatus.Unregistered) revert AgentNotFound();
        
        ServiceRating storage svcRating = serviceRatings[agentAddress][serviceType];
        svcRating.totalRatings++;
        svcRating.sumRatings += rating;
        svcRating.averageRating = (svcRating.sumRatings * SCORE_DECIMALS) / svcRating.totalRatings;
        
        // Adjust reputation based on rating
        if (rating >= 4) {
            _increaseScore(agentAddress, (rating - 3) * 100);
        } else if (rating <= 2) {
            _decreaseScore(agentAddress, (3 - rating) * 100);
        }
        
        emit ServiceRated(agentAddress, serviceType, msg.sender, rating);
    }
    
    // ============ Dispute Functions ============
    
    /**
     * @notice Create a dispute against an agent
     */
    function createDispute(
        address defendant,
        bytes32 transactionId,
        uint256 amount,
        string calldata evidence
    ) external nonReentrant returns (bytes32) {
        AIAgent storage defAgent = agents[defendant];
        if (defAgent.status == AgentStatus.Unregistered) revert AgentNotFound();
        
        bytes32 disputeId = keccak256(abi.encodePacked(
            msg.sender,
            defendant,
            transactionId,
            block.timestamp
        ));
        
        disputes[disputeId] = Dispute({
            disputeId: disputeId,
            claimant: msg.sender,
            defendant: defendant,
            transactionId: transactionId,
            amount: amount,
            timestamp: block.timestamp,
            deadline: block.timestamp + disputeWindow,
            status: DisputeStatus.Open,
            evidence: evidence
        });
        
        agentDisputes[defendant].push(disputeId);
        totalDisputes++;
        
        defAgent.disputesRaised++;
        
        emit DisputeCreated(disputeId, msg.sender, defendant, amount);
        
        return disputeId;
    }
    
    /**
     * @notice Resolve a dispute
     * @dev Only callable by arbiters
     */
    function resolveDispute(
        bytes32 disputeId,
        DisputeStatus resolution
    ) external onlyRole(ARBITER_ROLE) {
        Dispute storage dispute = disputes[disputeId];
        if (dispute.claimant == address(0)) revert DisputeNotFound();
        if (dispute.status != DisputeStatus.Open) revert DisputeAlreadyResolved();
        
        dispute.status = resolution;
        
        address winner;
        
        if (resolution == DisputeStatus.ResolvedForClaimant) {
            // Slash defendant
            _slashAgent(dispute.defendant, dispute.amount, "Lost dispute");
            agents[dispute.defendant].disputesLost++;
            winner = dispute.claimant;
        } else if (resolution == DisputeStatus.ResolvedForDefendant) {
            winner = dispute.defendant;
        }
        
        emit DisputeResolved(disputeId, resolution, winner);
    }
    
    // ============ Score Management ============
    
    function _increaseScore(address agentAddress, uint256 points) internal {
        AIAgent storage agent = agents[agentAddress];
        agent.reputationScore = min(agent.reputationScore + points, MAX_SCORE);
    }
    
    function _decreaseScore(address agentAddress, uint256 points) internal {
        AIAgent storage agent = agents[agentAddress];
        if (points >= agent.reputationScore) {
            agent.reputationScore = 0;
        } else {
            agent.reputationScore -= points;
        }
    }
    
    function _calculateScoreIncrease(uint256 amount) internal pure returns (uint256) {
        // Base 10 points + scaled by amount
        return 10 + (amount / 10**18); // 1 extra point per SYNX
    }
    
    function _calculateScoreDecrease(uint256 amount) internal pure returns (uint256) {
        // Base 50 points + scaled by amount
        return 50 + (amount * 2 / 10**18);
    }
    
    // ============ Tier Management ============
    
    function _updateTier(address agentAddress) internal {
        AIAgent storage agent = agents[agentAddress];
        
        uint256 successRate = agent.totalTransactions > 0 
            ? (agent.successfulTransactions * 10000) / agent.totalTransactions 
            : 0;
        
        uint8 newTier = 0;
        
        // Check from highest tier down
        for (uint8 i = 5; i >= 1; i--) {
            TierRequirements storage req = tierRequirements[i];
            if (
                agent.totalTransactions >= req.minTransactions &&
                successRate >= req.minSuccessRate &&
                agent.stakedAmount >= req.minStake
            ) {
                newTier = i;
                break;
            }
        }
        
        if (newTier != agent.tier) {
            agent.tier = newTier;
            emit AgentUpdated(agentAddress, agent.reputationScore, newTier);
        }
    }
    
    // ============ Slashing ============
    
    function _slashAgent(address agentAddress, uint256 amount, string memory reason) internal {
        AIAgent storage agent = agents[agentAddress];
        
        uint256 slashAmount = min(
            (agent.stakedAmount * slashPercentage) / SLASH_DENOMINATOR,
            amount
        );
        
        if (slashAmount > 0) {
            agent.stakedAmount -= slashAmount;
            totalStaked -= slashAmount;
            
            // Transfer slashed tokens to treasury
            synxToken.safeTransfer(treasury, slashAmount);
            
            _decreaseScore(agentAddress, 1000);
            _updateTier(agentAddress);
            
            emit StakeSlashed(agentAddress, slashAmount, reason);
        }
    }
    
    // ============ Admin Functions ============
    
    function suspendAgent(address agentAddress, string calldata reason) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        agents[agentAddress].status = AgentStatus.Suspended;
        emit AgentSuspended(agentAddress, reason);
    }
    
    function reinstateAgent(address agentAddress) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        agents[agentAddress].status = AgentStatus.Active;
        emit AgentReinstated(agentAddress);
    }
    
    function banAgent(address agentAddress, string calldata reason) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        agents[agentAddress].status = AgentStatus.Banned;
        emit AgentBanned(agentAddress, reason);
    }
    
    function setTierRequirements(
        uint8 tier,
        uint256 minTransactions,
        uint256 minSuccessRate,
        uint256 minStake,
        uint256 feeDiscount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (tier > 5) revert InvalidTier();
        tierRequirements[tier] = TierRequirements({
            minTransactions: minTransactions,
            minSuccessRate: minSuccessRate,
            minStake: minStake,
            feeDiscount: feeDiscount
        });
    }
    
    function setRegistrationFee(uint256 newFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        registrationFee = newFee;
    }
    
    function setMinStake(uint256 newMin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minStake = newMin;
    }
    
    function setSlashPercentage(uint256 newPercentage) external onlyRole(DEFAULT_ADMIN_ROLE) {
        slashPercentage = newPercentage;
    }
    
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }
    
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
    
    // ============ View Functions ============
    
    function getAgent(address agentAddress) external view returns (AIAgent memory) {
        return agents[agentAddress];
    }
    
    function getAgentTier(address agentAddress) external view returns (uint8) {
        return agents[agentAddress].tier;
    }
    
    function getAgentScore(address agentAddress) external view returns (uint256) {
        return agents[agentAddress].reputationScore;
    }
    
    function getSuccessRate(address agentAddress) external view returns (uint256) {
        AIAgent storage agent = agents[agentAddress];
        if (agent.totalTransactions == 0) return 0;
        return (agent.successfulTransactions * 10000) / agent.totalTransactions;
    }
    
    function getServiceRating(address agentAddress, bytes32 serviceType) 
        external 
        view 
        returns (ServiceRating memory) 
    {
        return serviceRatings[agentAddress][serviceType];
    }
    
    function getAgentDisputes(address agentAddress) 
        external 
        view 
        returns (bytes32[] memory) 
    {
        return agentDisputes[agentAddress];
    }
    
    function getTierRequirements(uint8 tier) 
        external 
        view 
        returns (TierRequirements memory) 
    {
        return tierRequirements[tier];
    }
    
    function isAgentActive(address agentAddress) external view returns (bool) {
        return agents[agentAddress].status == AgentStatus.Active;
    }
    
    // ============ Utility Functions ============
    
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
