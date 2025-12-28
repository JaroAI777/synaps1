// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapseInsurance
 * @notice Decentralized insurance protocol for SYNAPSE ecosystem
 * @dev Provides coverage for smart contract failures, slashing, and service disputes
 */
contract SynapseInsurance is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Roles ============
    
    bytes32 public constant UNDERWRITER_ROLE = keccak256("UNDERWRITER_ROLE");
    bytes32 public constant CLAIMS_ASSESSOR_ROLE = keccak256("CLAIMS_ASSESSOR_ROLE");
    bytes32 public constant RISK_MANAGER_ROLE = keccak256("RISK_MANAGER_ROLE");

    // ============ Structs ============

    struct CoverageType {
        string name;
        string description;
        uint256 basePremiumRate;    // Annual rate in basis points
        uint256 maxCoverageAmount;
        uint256 minCoverageAmount;
        uint256 minPeriod;          // Minimum coverage period in days
        uint256 maxPeriod;          // Maximum coverage period in days
        uint256 deductible;         // Deductible in basis points
        uint256 totalCoverage;      // Total active coverage
        uint256 maxTotalCoverage;   // Maximum total coverage for this type
        bool isActive;
    }

    struct Policy {
        address holder;
        uint256 coverageTypeId;
        uint256 coverageAmount;
        uint256 premium;
        uint256 startTime;
        uint256 endTime;
        uint256 deductible;
        address coveredContract;    // Contract being covered
        PolicyStatus status;
    }

    struct Claim {
        uint256 policyId;
        address claimant;
        uint256 amount;
        string description;
        bytes32 evidenceHash;
        uint256 submittedAt;
        uint256 assessedAt;
        ClaimStatus status;
        address assessor;
        string assessmentNotes;
    }

    struct Pool {
        uint256 totalCapital;
        uint256 availableCapital;
        uint256 reservedCapital;
        uint256 totalPremiums;
        uint256 totalPayouts;
        uint256 minCapitalRatio;    // Minimum capital to coverage ratio
    }

    enum PolicyStatus {
        ACTIVE,
        EXPIRED,
        CLAIMED,
        CANCELLED
    }

    enum ClaimStatus {
        PENDING,
        UNDER_REVIEW,
        APPROVED,
        REJECTED,
        PAID
    }

    // ============ State Variables ============

    IERC20 public immutable synxToken;
    
    // Coverage types
    mapping(uint256 => CoverageType) public coverageTypes;
    uint256 public coverageTypeCount;

    // Policies
    mapping(uint256 => Policy) public policies;
    mapping(address => uint256[]) public userPolicies;
    uint256 public policyCount;

    // Claims
    mapping(uint256 => Claim) public claims;
    mapping(uint256 => uint256[]) public policyClaims;
    uint256 public claimCount;

    // Capital pool
    Pool public pool;
    mapping(address => uint256) public underwriterStakes;
    mapping(address => uint256) public underwriterRewards;
    address[] public underwriters;

    // Risk parameters
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public claimPeriod = 30 days;       // Time to file claim after incident
    uint256 public assessmentPeriod = 14 days;  // Time for claim assessment
    uint256 public cooldownPeriod = 7 days;     // Cooldown after policy start

    // ============ Events ============

    event CoverageTypeCreated(uint256 indexed typeId, string name, uint256 basePremiumRate);
    event PolicyPurchased(uint256 indexed policyId, address indexed holder, uint256 coverageAmount);
    event PolicyCancelled(uint256 indexed policyId);
    event ClaimSubmitted(uint256 indexed claimId, uint256 indexed policyId, uint256 amount);
    event ClaimAssessed(uint256 indexed claimId, ClaimStatus status, string notes);
    event ClaimPaid(uint256 indexed claimId, address indexed recipient, uint256 amount);
    event CapitalDeposited(address indexed underwriter, uint256 amount);
    event CapitalWithdrawn(address indexed underwriter, uint256 amount);
    event RewardsClaimed(address indexed underwriter, uint256 amount);

    // ============ Constructor ============

    constructor(address _synxToken) {
        synxToken = IERC20(_synxToken);
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(UNDERWRITER_ROLE, msg.sender);
        _grantRole(CLAIMS_ASSESSOR_ROLE, msg.sender);
        _grantRole(RISK_MANAGER_ROLE, msg.sender);

        pool.minCapitalRatio = 2000; // 20% minimum

        // Create default coverage types
        _createDefaultCoverageTypes();
    }

    /**
     * @dev Create default coverage types
     */
    function _createDefaultCoverageTypes() internal {
        // Smart Contract Cover
        _createCoverageType(
            "Smart Contract Cover",
            "Coverage against smart contract vulnerabilities and exploits",
            300,                    // 3% annual premium
            1000000 ether,          // Max 1M SYNX
            1000 ether,             // Min 1K SYNX
            30,                     // Min 30 days
            365,                    // Max 365 days
            500,                    // 5% deductible
            10000000 ether          // Max total 10M
        );

        // Slashing Protection
        _createCoverageType(
            "Slashing Protection",
            "Coverage against staking slashing events",
            200,                    // 2% annual premium
            500000 ether,
            500 ether,
            30,
            365,
            1000,                   // 10% deductible
            5000000 ether
        );

        // Service Dispute Cover
        _createCoverageType(
            "Service Dispute Cover",
            "Coverage for unresolved service disputes",
            400,                    // 4% annual premium
            100000 ether,
            100 ether,
            7,
            90,
            200,                    // 2% deductible
            2000000 ether
        );

        // Bridge Failure Cover
        _createCoverageType(
            "Bridge Failure Cover",
            "Coverage against cross-chain bridge failures",
            500,                    // 5% annual premium
            2000000 ether,
            5000 ether,
            30,
            180,
            300,                    // 3% deductible
            15000000 ether
        );
    }

    function _createCoverageType(
        string memory name,
        string memory description,
        uint256 basePremiumRate,
        uint256 maxCoverageAmount,
        uint256 minCoverageAmount,
        uint256 minPeriod,
        uint256 maxPeriod,
        uint256 deductible,
        uint256 maxTotalCoverage
    ) internal {
        coverageTypeCount++;
        coverageTypes[coverageTypeCount] = CoverageType({
            name: name,
            description: description,
            basePremiumRate: basePremiumRate,
            maxCoverageAmount: maxCoverageAmount,
            minCoverageAmount: minCoverageAmount,
            minPeriod: minPeriod,
            maxPeriod: maxPeriod,
            deductible: deductible,
            totalCoverage: 0,
            maxTotalCoverage: maxTotalCoverage,
            isActive: true
        });

        emit CoverageTypeCreated(coverageTypeCount, name, basePremiumRate);
    }

    // ============ Policy Management ============

    /**
     * @notice Purchase insurance policy
     */
    function purchasePolicy(
        uint256 coverageTypeId,
        uint256 coverageAmount,
        uint256 periodDays,
        address coveredContract
    ) external nonReentrant whenNotPaused returns (uint256 policyId) {
        CoverageType storage coverageType = coverageTypes[coverageTypeId];
        require(coverageType.isActive, "Coverage type not active");
        require(coverageAmount >= coverageType.minCoverageAmount, "Below minimum");
        require(coverageAmount <= coverageType.maxCoverageAmount, "Above maximum");
        require(periodDays >= coverageType.minPeriod, "Period too short");
        require(periodDays <= coverageType.maxPeriod, "Period too long");
        require(
            coverageType.totalCoverage + coverageAmount <= coverageType.maxTotalCoverage,
            "Max coverage reached"
        );

        // Check capital adequacy
        uint256 requiredCapital = (coverageAmount * pool.minCapitalRatio) / BASIS_POINTS;
        require(pool.availableCapital >= requiredCapital, "Insufficient pool capital");

        // Calculate premium
        uint256 premium = calculatePremium(coverageTypeId, coverageAmount, periodDays);

        // Transfer premium
        synxToken.safeTransferFrom(msg.sender, address(this), premium);

        // Create policy
        policyId = ++policyCount;
        policies[policyId] = Policy({
            holder: msg.sender,
            coverageTypeId: coverageTypeId,
            coverageAmount: coverageAmount,
            premium: premium,
            startTime: block.timestamp,
            endTime: block.timestamp + (periodDays * 1 days),
            deductible: coverageType.deductible,
            coveredContract: coveredContract,
            status: PolicyStatus.ACTIVE
        });

        userPolicies[msg.sender].push(policyId);
        
        // Update coverage stats
        coverageType.totalCoverage += coverageAmount;
        pool.totalPremiums += premium;
        pool.reservedCapital += requiredCapital;
        pool.availableCapital -= requiredCapital;

        emit PolicyPurchased(policyId, msg.sender, coverageAmount);
    }

    /**
     * @notice Calculate premium for coverage
     */
    function calculatePremium(
        uint256 coverageTypeId,
        uint256 coverageAmount,
        uint256 periodDays
    ) public view returns (uint256) {
        CoverageType storage coverageType = coverageTypes[coverageTypeId];
        
        // Base premium: (amount * rate * period) / (BASIS_POINTS * 365)
        uint256 basePremium = (coverageAmount * coverageType.basePremiumRate * periodDays) 
            / (BASIS_POINTS * 365);

        // Apply utilization adjustment
        uint256 utilization = (coverageType.totalCoverage * BASIS_POINTS) / coverageType.maxTotalCoverage;
        uint256 utilizationMultiplier = BASIS_POINTS + (utilization / 2); // Up to 1.5x at 100% util

        return (basePremium * utilizationMultiplier) / BASIS_POINTS;
    }

    /**
     * @notice Cancel policy (with partial refund if early)
     */
    function cancelPolicy(uint256 policyId) external nonReentrant {
        Policy storage policy = policies[policyId];
        require(policy.holder == msg.sender, "Not policy holder");
        require(policy.status == PolicyStatus.ACTIVE, "Policy not active");
        require(block.timestamp < policy.endTime, "Policy expired");

        // Calculate refund (pro-rata minus cancellation fee)
        uint256 remainingTime = policy.endTime - block.timestamp;
        uint256 totalTime = policy.endTime - policy.startTime;
        uint256 refund = (policy.premium * remainingTime * 8000) / (totalTime * BASIS_POINTS); // 20% cancellation fee

        policy.status = PolicyStatus.CANCELLED;

        // Update stats
        CoverageType storage coverageType = coverageTypes[policy.coverageTypeId];
        coverageType.totalCoverage -= policy.coverageAmount;
        
        uint256 reservedRelease = (policy.coverageAmount * pool.minCapitalRatio) / BASIS_POINTS;
        pool.reservedCapital -= reservedRelease;
        pool.availableCapital += reservedRelease;

        // Transfer refund
        if (refund > 0) {
            synxToken.safeTransfer(msg.sender, refund);
        }

        emit PolicyCancelled(policyId);
    }

    // ============ Claims ============

    /**
     * @notice Submit a claim
     */
    function submitClaim(
        uint256 policyId,
        uint256 amount,
        string calldata description,
        bytes32 evidenceHash
    ) external nonReentrant returns (uint256 claimId) {
        Policy storage policy = policies[policyId];
        require(policy.holder == msg.sender, "Not policy holder");
        require(policy.status == PolicyStatus.ACTIVE, "Policy not active");
        require(block.timestamp >= policy.startTime + cooldownPeriod, "Cooldown active");
        require(block.timestamp <= policy.endTime, "Policy expired");
        require(amount <= policy.coverageAmount, "Exceeds coverage");

        claimId = ++claimCount;
        claims[claimId] = Claim({
            policyId: policyId,
            claimant: msg.sender,
            amount: amount,
            description: description,
            evidenceHash: evidenceHash,
            submittedAt: block.timestamp,
            assessedAt: 0,
            status: ClaimStatus.PENDING,
            assessor: address(0),
            assessmentNotes: ""
        });

        policyClaims[policyId].push(claimId);

        emit ClaimSubmitted(claimId, policyId, amount);
    }

    /**
     * @notice Assess a claim (claims assessor only)
     */
    function assessClaim(
        uint256 claimId,
        bool approved,
        string calldata notes
    ) external onlyRole(CLAIMS_ASSESSOR_ROLE) {
        Claim storage claim = claims[claimId];
        require(claim.status == ClaimStatus.PENDING || claim.status == ClaimStatus.UNDER_REVIEW, "Invalid status");

        claim.assessedAt = block.timestamp;
        claim.assessor = msg.sender;
        claim.assessmentNotes = notes;
        claim.status = approved ? ClaimStatus.APPROVED : ClaimStatus.REJECTED;

        emit ClaimAssessed(claimId, claim.status, notes);

        // Auto-pay if approved
        if (approved) {
            _payClaim(claimId);
        }
    }

    /**
     * @dev Pay approved claim
     */
    function _payClaim(uint256 claimId) internal {
        Claim storage claim = claims[claimId];
        require(claim.status == ClaimStatus.APPROVED, "Not approved");

        Policy storage policy = policies[claim.policyId];
        
        // Calculate payout (minus deductible)
        uint256 deductibleAmount = (claim.amount * policy.deductible) / BASIS_POINTS;
        uint256 payout = claim.amount - deductibleAmount;

        claim.status = ClaimStatus.PAID;
        policy.status = PolicyStatus.CLAIMED;

        // Update pool
        pool.totalPayouts += payout;
        pool.totalCapital -= payout;

        // Update coverage stats
        CoverageType storage coverageType = coverageTypes[policy.coverageTypeId];
        coverageType.totalCoverage -= policy.coverageAmount;

        // Transfer payout
        synxToken.safeTransfer(claim.claimant, payout);

        emit ClaimPaid(claimId, claim.claimant, payout);
    }

    // ============ Underwriting ============

    /**
     * @notice Deposit capital as underwriter
     */
    function depositCapital(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be > 0");

        synxToken.safeTransferFrom(msg.sender, address(this), amount);

        if (underwriterStakes[msg.sender] == 0) {
            underwriters.push(msg.sender);
        }

        underwriterStakes[msg.sender] += amount;
        pool.totalCapital += amount;
        pool.availableCapital += amount;

        emit CapitalDeposited(msg.sender, amount);
    }

    /**
     * @notice Withdraw capital (subject to utilization limits)
     */
    function withdrawCapital(uint256 amount) external nonReentrant {
        require(underwriterStakes[msg.sender] >= amount, "Insufficient stake");
        
        // Check capital adequacy after withdrawal
        uint256 newAvailable = pool.availableCapital - amount;
        uint256 requiredCapital = (pool.reservedCapital * pool.minCapitalRatio) / BASIS_POINTS;
        require(newAvailable >= requiredCapital, "Would breach capital requirements");

        underwriterStakes[msg.sender] -= amount;
        pool.totalCapital -= amount;
        pool.availableCapital -= amount;

        synxToken.safeTransfer(msg.sender, amount);

        emit CapitalWithdrawn(msg.sender, amount);
    }

    /**
     * @notice Distribute rewards to underwriters
     */
    function distributeRewards() external onlyRole(RISK_MANAGER_ROLE) {
        uint256 totalRewards = pool.totalPremiums - pool.totalPayouts;
        if (totalRewards == 0) return;

        uint256 distributed = 0;
        for (uint256 i = 0; i < underwriters.length; i++) {
            address underwriter = underwriters[i];
            uint256 stake = underwriterStakes[underwriter];
            if (stake == 0) continue;

            uint256 share = (totalRewards * stake) / pool.totalCapital;
            underwriterRewards[underwriter] += share;
            distributed += share;
        }

        pool.totalPremiums -= distributed;
    }

    /**
     * @notice Claim underwriter rewards
     */
    function claimRewards() external nonReentrant {
        uint256 rewards = underwriterRewards[msg.sender];
        require(rewards > 0, "No rewards");

        underwriterRewards[msg.sender] = 0;
        synxToken.safeTransfer(msg.sender, rewards);

        emit RewardsClaimed(msg.sender, rewards);
    }

    // ============ View Functions ============

    /**
     * @notice Get policy details
     */
    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return policies[policyId];
    }

    /**
     * @notice Get user policies
     */
    function getUserPolicies(address user) external view returns (uint256[] memory) {
        return userPolicies[user];
    }

    /**
     * @notice Get claim details
     */
    function getClaim(uint256 claimId) external view returns (Claim memory) {
        return claims[claimId];
    }

    /**
     * @notice Get pool info
     */
    function getPoolInfo() external view returns (
        uint256 totalCapital,
        uint256 availableCapital,
        uint256 reservedCapital,
        uint256 totalPremiums,
        uint256 totalPayouts,
        uint256 underwriterCount
    ) {
        return (
            pool.totalCapital,
            pool.availableCapital,
            pool.reservedCapital,
            pool.totalPremiums,
            pool.totalPayouts,
            underwriters.length
        );
    }

    /**
     * @notice Check if policy is claimable
     */
    function isPolicyClaimable(uint256 policyId) external view returns (bool, string memory) {
        Policy storage policy = policies[policyId];
        
        if (policy.status != PolicyStatus.ACTIVE) return (false, "Policy not active");
        if (block.timestamp < policy.startTime + cooldownPeriod) return (false, "Cooldown active");
        if (block.timestamp > policy.endTime) return (false, "Policy expired");
        
        return (true, "Claimable");
    }

    // ============ Admin Functions ============

    /**
     * @notice Create new coverage type
     */
    function createCoverageType(
        string calldata name,
        string calldata description,
        uint256 basePremiumRate,
        uint256 maxCoverageAmount,
        uint256 minCoverageAmount,
        uint256 minPeriod,
        uint256 maxPeriod,
        uint256 deductible,
        uint256 maxTotalCoverage
    ) external onlyRole(RISK_MANAGER_ROLE) {
        _createCoverageType(
            name, description, basePremiumRate, maxCoverageAmount,
            minCoverageAmount, minPeriod, maxPeriod, deductible, maxTotalCoverage
        );
    }

    /**
     * @notice Update coverage type
     */
    function updateCoverageType(
        uint256 typeId,
        uint256 basePremiumRate,
        bool isActive
    ) external onlyRole(RISK_MANAGER_ROLE) {
        coverageTypes[typeId].basePremiumRate = basePremiumRate;
        coverageTypes[typeId].isActive = isActive;
    }

    /**
     * @notice Update risk parameters
     */
    function updateRiskParameters(
        uint256 _claimPeriod,
        uint256 _assessmentPeriod,
        uint256 _cooldownPeriod,
        uint256 _minCapitalRatio
    ) external onlyRole(RISK_MANAGER_ROLE) {
        claimPeriod = _claimPeriod;
        assessmentPeriod = _assessmentPeriod;
        cooldownPeriod = _cooldownPeriod;
        pool.minCapitalRatio = _minCapitalRatio;
    }

    /**
     * @notice Pause/unpause
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
}
