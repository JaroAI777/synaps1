// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title SynapseAirdrop
 * @notice Merkle tree-based token airdrop with vesting support
 * @dev Supports multiple airdrop rounds with different configurations
 */
contract SynapseAirdrop is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Structs ============

    struct AirdropRound {
        bytes32 merkleRoot;
        uint256 totalAmount;
        uint256 claimedAmount;
        uint256 startTime;
        uint256 endTime;
        uint256 vestingDuration;    // 0 for instant, >0 for vested
        uint256 cliffDuration;      // Cliff before vesting starts
        bool isActive;
        string name;
    }

    struct UserClaim {
        uint256 totalAmount;
        uint256 claimedAmount;
        uint256 vestingStart;
        bool initialized;
    }

    // ============ State Variables ============

    IERC20 public immutable token;

    // Rounds
    AirdropRound[] public rounds;
    mapping(uint256 => mapping(address => UserClaim)) public userClaims;

    // Global stats
    uint256 public totalDistributed;
    uint256 public totalClaimed;
    uint256 public uniqueClaimants;

    // Referral bonus
    mapping(address => address) public referrers;
    uint256 public referralBonus = 500; // 5%
    mapping(address => uint256) public referralEarnings;

    // ============ Events ============

    event RoundCreated(uint256 indexed roundId, string name, uint256 totalAmount);
    event RoundUpdated(uint256 indexed roundId);
    event Claimed(
        address indexed user,
        uint256 indexed roundId,
        uint256 amount,
        address indexed referrer
    );
    event VestingClaimed(address indexed user, uint256 indexed roundId, uint256 amount);
    event ReferralBonus(address indexed referrer, address indexed user, uint256 amount);
    event EmergencyWithdraw(address indexed token, uint256 amount);

    // ============ Constructor ============

    constructor(address _token) Ownable(msg.sender) {
        token = IERC20(_token);
    }

    // ============ Round Management ============

    /**
     * @notice Create a new airdrop round
     */
    function createRound(
        bytes32 merkleRoot,
        uint256 totalAmount,
        uint256 startTime,
        uint256 endTime,
        uint256 vestingDuration,
        uint256 cliffDuration,
        string calldata name
    ) external onlyOwner returns (uint256) {
        require(merkleRoot != bytes32(0), "Invalid merkle root");
        require(totalAmount > 0, "Invalid amount");
        require(endTime > startTime, "Invalid time range");
        require(cliffDuration <= vestingDuration, "Cliff > vesting");

        // Ensure contract has enough tokens
        uint256 requiredBalance = totalAmount + _getPendingAmount();
        require(token.balanceOf(address(this)) >= requiredBalance, "Insufficient balance");

        uint256 roundId = rounds.length;

        rounds.push(AirdropRound({
            merkleRoot: merkleRoot,
            totalAmount: totalAmount,
            claimedAmount: 0,
            startTime: startTime,
            endTime: endTime,
            vestingDuration: vestingDuration,
            cliffDuration: cliffDuration,
            isActive: true,
            name: name
        }));

        totalDistributed += totalAmount;

        emit RoundCreated(roundId, name, totalAmount);

        return roundId;
    }

    /**
     * @notice Update round merkle root (for corrections)
     */
    function updateMerkleRoot(uint256 roundId, bytes32 newRoot) external onlyOwner {
        require(roundId < rounds.length, "Invalid round");
        require(rounds[roundId].claimedAmount == 0, "Already has claims");
        
        rounds[roundId].merkleRoot = newRoot;
        emit RoundUpdated(roundId);
    }

    /**
     * @notice Update round times
     */
    function updateRoundTimes(
        uint256 roundId,
        uint256 startTime,
        uint256 endTime
    ) external onlyOwner {
        require(roundId < rounds.length, "Invalid round");
        require(endTime > startTime, "Invalid time range");
        
        rounds[roundId].startTime = startTime;
        rounds[roundId].endTime = endTime;
        emit RoundUpdated(roundId);
    }

    /**
     * @notice Toggle round active status
     */
    function setRoundActive(uint256 roundId, bool isActive) external onlyOwner {
        require(roundId < rounds.length, "Invalid round");
        rounds[roundId].isActive = isActive;
        emit RoundUpdated(roundId);
    }

    // ============ Claim Functions ============

    /**
     * @notice Claim tokens from an airdrop round
     */
    function claim(
        uint256 roundId,
        uint256 amount,
        bytes32[] calldata proof,
        address referrer
    ) external nonReentrant whenNotPaused {
        require(roundId < rounds.length, "Invalid round");
        
        AirdropRound storage round = rounds[roundId];
        require(round.isActive, "Round not active");
        require(block.timestamp >= round.startTime, "Not started");
        require(block.timestamp <= round.endTime, "Ended");

        UserClaim storage userClaim = userClaims[roundId][msg.sender];
        require(!userClaim.initialized, "Already claimed");

        // Verify merkle proof
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        require(MerkleProof.verify(proof, round.merkleRoot, leaf), "Invalid proof");

        // Initialize user claim
        userClaim.totalAmount = amount;
        userClaim.initialized = true;
        userClaim.vestingStart = block.timestamp;

        // Handle referral
        if (referrer != address(0) && referrer != msg.sender && referrers[msg.sender] == address(0)) {
            referrers[msg.sender] = referrer;
        }

        uint256 claimableAmount;
        
        if (round.vestingDuration == 0) {
            // Instant claim
            claimableAmount = amount;
            userClaim.claimedAmount = amount;
        } else {
            // Vested - claim available portion
            claimableAmount = _getVestedAmount(roundId, msg.sender);
            userClaim.claimedAmount = claimableAmount;
        }

        require(claimableAmount > 0, "Nothing to claim");

        // Update stats
        round.claimedAmount += claimableAmount;
        totalClaimed += claimableAmount;
        uniqueClaimants++;

        // Transfer tokens
        token.safeTransfer(msg.sender, claimableAmount);

        // Pay referral bonus
        address ref = referrers[msg.sender];
        if (ref != address(0) && referralBonus > 0) {
            uint256 bonus = (claimableAmount * referralBonus) / 10000;
            if (token.balanceOf(address(this)) >= bonus) {
                token.safeTransfer(ref, bonus);
                referralEarnings[ref] += bonus;
                emit ReferralBonus(ref, msg.sender, bonus);
            }
        }

        emit Claimed(msg.sender, roundId, claimableAmount, ref);
    }

    /**
     * @notice Claim vested tokens
     */
    function claimVested(uint256 roundId) external nonReentrant whenNotPaused {
        require(roundId < rounds.length, "Invalid round");
        
        UserClaim storage userClaim = userClaims[roundId][msg.sender];
        require(userClaim.initialized, "Not initialized");
        require(userClaim.claimedAmount < userClaim.totalAmount, "Fully claimed");

        uint256 vestedAmount = _getVestedAmount(roundId, msg.sender);
        uint256 claimable = vestedAmount - userClaim.claimedAmount;
        
        require(claimable > 0, "Nothing to claim");

        userClaim.claimedAmount = vestedAmount;
        rounds[roundId].claimedAmount += claimable;
        totalClaimed += claimable;

        token.safeTransfer(msg.sender, claimable);

        emit VestingClaimed(msg.sender, roundId, claimable);
    }

    /**
     * @notice Batch claim from multiple rounds
     */
    function batchClaim(
        uint256[] calldata roundIds,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external nonReentrant whenNotPaused {
        require(roundIds.length == amounts.length && amounts.length == proofs.length, "Length mismatch");

        for (uint256 i = 0; i < roundIds.length; i++) {
            _claimInternal(roundIds[i], amounts[i], proofs[i]);
        }
    }

    function _claimInternal(
        uint256 roundId,
        uint256 amount,
        bytes32[] calldata proof
    ) internal {
        if (roundId >= rounds.length) return;
        
        AirdropRound storage round = rounds[roundId];
        if (!round.isActive) return;
        if (block.timestamp < round.startTime || block.timestamp > round.endTime) return;

        UserClaim storage userClaim = userClaims[roundId][msg.sender];
        if (userClaim.initialized) return;

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        if (!MerkleProof.verify(proof, round.merkleRoot, leaf)) return;

        userClaim.totalAmount = amount;
        userClaim.initialized = true;
        userClaim.vestingStart = block.timestamp;

        uint256 claimableAmount = round.vestingDuration == 0 
            ? amount 
            : _getVestedAmount(roundId, msg.sender);

        userClaim.claimedAmount = claimableAmount;
        round.claimedAmount += claimableAmount;
        totalClaimed += claimableAmount;
        uniqueClaimants++;

        token.safeTransfer(msg.sender, claimableAmount);

        emit Claimed(msg.sender, roundId, claimableAmount, address(0));
    }

    // ============ View Functions ============

    /**
     * @notice Get vested amount for user
     */
    function getVestedAmount(uint256 roundId, address user) external view returns (uint256) {
        return _getVestedAmount(roundId, user);
    }

    function _getVestedAmount(uint256 roundId, address user) internal view returns (uint256) {
        UserClaim storage userClaim = userClaims[roundId][user];
        if (!userClaim.initialized) return 0;

        AirdropRound storage round = rounds[roundId];
        if (round.vestingDuration == 0) {
            return userClaim.totalAmount;
        }

        uint256 elapsed = block.timestamp - userClaim.vestingStart;
        
        // Check cliff
        if (elapsed < round.cliffDuration) {
            return 0;
        }

        // Calculate vested
        if (elapsed >= round.vestingDuration) {
            return userClaim.totalAmount;
        }

        return (userClaim.totalAmount * elapsed) / round.vestingDuration;
    }

    /**
     * @notice Get claimable amount for user
     */
    function getClaimable(uint256 roundId, address user) external view returns (uint256) {
        UserClaim storage userClaim = userClaims[roundId][user];
        if (!userClaim.initialized) return 0;

        uint256 vested = _getVestedAmount(roundId, user);
        return vested > userClaim.claimedAmount ? vested - userClaim.claimedAmount : 0;
    }

    /**
     * @notice Check if user can claim from round
     */
    function canClaim(
        uint256 roundId,
        address user,
        uint256 amount,
        bytes32[] calldata proof
    ) external view returns (bool) {
        if (roundId >= rounds.length) return false;
        
        AirdropRound storage round = rounds[roundId];
        if (!round.isActive) return false;
        if (block.timestamp < round.startTime || block.timestamp > round.endTime) return false;
        if (userClaims[roundId][user].initialized) return false;

        bytes32 leaf = keccak256(abi.encodePacked(user, amount));
        return MerkleProof.verify(proof, round.merkleRoot, leaf);
    }

    /**
     * @notice Get round details
     */
    function getRound(uint256 roundId) external view returns (
        bytes32 merkleRoot,
        uint256 totalAmount,
        uint256 claimedAmount,
        uint256 startTime,
        uint256 endTime,
        uint256 vestingDuration,
        uint256 cliffDuration,
        bool isActive,
        string memory name
    ) {
        require(roundId < rounds.length, "Invalid round");
        AirdropRound storage round = rounds[roundId];
        return (
            round.merkleRoot,
            round.totalAmount,
            round.claimedAmount,
            round.startTime,
            round.endTime,
            round.vestingDuration,
            round.cliffDuration,
            round.isActive,
            round.name
        );
    }

    /**
     * @notice Get round count
     */
    function getRoundCount() external view returns (uint256) {
        return rounds.length;
    }

    /**
     * @notice Get user claim info
     */
    function getUserClaim(uint256 roundId, address user) external view returns (
        uint256 totalAmount,
        uint256 claimedAmount,
        uint256 vestingStart,
        bool initialized,
        uint256 claimable
    ) {
        UserClaim storage claim = userClaims[roundId][user];
        uint256 vested = _getVestedAmount(roundId, user);
        
        return (
            claim.totalAmount,
            claim.claimedAmount,
            claim.vestingStart,
            claim.initialized,
            vested > claim.claimedAmount ? vested - claim.claimedAmount : 0
        );
    }

    /**
     * @notice Get global stats
     */
    function getStats() external view returns (
        uint256 totalRounds,
        uint256 distributed,
        uint256 claimed,
        uint256 claimants,
        uint256 contractBalance
    ) {
        return (
            rounds.length,
            totalDistributed,
            totalClaimed,
            uniqueClaimants,
            token.balanceOf(address(this))
        );
    }

    function _getPendingAmount() internal view returns (uint256 pending) {
        for (uint256 i = 0; i < rounds.length; i++) {
            pending += rounds[i].totalAmount - rounds[i].claimedAmount;
        }
    }

    // ============ Admin Functions ============

    /**
     * @notice Set referral bonus
     */
    function setReferralBonus(uint256 bonus) external onlyOwner {
        require(bonus <= 1000, "Max 10%");
        referralBonus = bonus;
    }

    /**
     * @notice Emergency withdraw unclaimed tokens
     */
    function emergencyWithdraw(address tokenAddr) external onlyOwner {
        uint256 balance = IERC20(tokenAddr).balanceOf(address(this));
        IERC20(tokenAddr).safeTransfer(owner(), balance);
        emit EmergencyWithdraw(tokenAddr, balance);
    }

    /**
     * @notice Pause/unpause
     */
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
