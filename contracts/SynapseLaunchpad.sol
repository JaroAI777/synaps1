// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapseLaunchpad
 * @notice IDO/ICO platform for launching new tokens
 * @dev Supports tiered allocation, vesting, and whitelist
 */
contract SynapseLaunchpad is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Roles ============
    
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");

    // ============ Enums ============

    enum SaleType { PUBLIC, WHITELIST, TIERED }
    enum SaleStatus { PENDING, ACTIVE, COMPLETED, CANCELLED, FINALIZED }
    enum VestingType { NONE, LINEAR, CLIFF_LINEAR, MILESTONE }

    // ============ Structs ============

    struct Sale {
        uint256 saleId;
        address creator;
        address saleToken;
        address paymentToken;       // address(0) for ETH
        uint256 tokenPrice;         // Price per token in payment token
        uint256 totalTokens;        // Total tokens for sale
        uint256 tokensSold;
        uint256 minPurchase;
        uint256 maxPurchase;
        uint256 startTime;
        uint256 endTime;
        uint256 softCap;
        uint256 hardCap;
        uint256 totalRaised;
        SaleType saleType;
        SaleStatus status;
        VestingType vestingType;
        string metadata;            // IPFS hash for project info
    }

    struct VestingSchedule {
        uint256 tgePercent;         // Tokens released at TGE (basis points)
        uint256 cliffDuration;
        uint256 vestingDuration;
        uint256 vestingInterval;    // Release interval (e.g., monthly)
    }

    struct Tier {
        string name;
        uint256 minStake;           // Min SYNX staked
        uint256 allocationMultiplier; // Allocation multiplier (basis points)
        uint256 maxParticipants;
    }

    struct Participation {
        uint256 amount;             // Payment amount
        uint256 tokenAmount;        // Tokens purchased
        uint256 claimedAmount;      // Tokens claimed
        uint256 refundedAmount;
        bool isWhitelisted;
        uint8 tier;
    }

    // ============ State Variables ============

    IERC20 public immutable synxToken;

    // Sales
    mapping(uint256 => Sale) public sales;
    mapping(uint256 => VestingSchedule) public vestingSchedules;
    mapping(uint256 => mapping(address => Participation)) public participations;
    mapping(uint256 => address[]) public saleParticipants;
    mapping(uint256 => mapping(address => bool)) public whitelist;
    uint256 public saleCounter;

    // Tiers
    Tier[] public tiers;
    mapping(address => uint256) public userStakes; // For tier calculation

    // Fees
    uint256 public platformFee = 300;   // 3%
    uint256 public constant MAX_FEE = 1000;
    uint256 public constant BASIS_POINTS = 10000;
    address public feeRecipient;

    // Stats
    uint256 public totalSalesCreated;
    uint256 public totalRaisedAllTime;
    uint256 public totalParticipants;

    // ============ Events ============

    event SaleCreated(uint256 indexed saleId, address indexed creator, address saleToken, uint256 totalTokens);
    event SaleStarted(uint256 indexed saleId);
    event SaleCancelled(uint256 indexed saleId);
    event SaleFinalized(uint256 indexed saleId, uint256 totalRaised, bool softCapReached);
    event Participated(uint256 indexed saleId, address indexed user, uint256 amount, uint256 tokens);
    event TokensClaimed(uint256 indexed saleId, address indexed user, uint256 amount);
    event Refunded(uint256 indexed saleId, address indexed user, uint256 amount);
    event WhitelistUpdated(uint256 indexed saleId, address[] users, bool status);
    event TierAdded(uint256 indexed tierId, string name, uint256 minStake);

    // ============ Constructor ============

    constructor(address _synxToken) {
        synxToken = IERC20(_synxToken);
        feeRecipient = msg.sender;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
        _grantRole(CREATOR_ROLE, msg.sender);

        // Initialize default tiers
        tiers.push(Tier("Bronze", 1000 * 1e18, 10000, 0));      // 1x allocation
        tiers.push(Tier("Silver", 5000 * 1e18, 15000, 0));      // 1.5x allocation
        tiers.push(Tier("Gold", 25000 * 1e18, 25000, 0));       // 2.5x allocation
        tiers.push(Tier("Platinum", 100000 * 1e18, 50000, 0));  // 5x allocation
        tiers.push(Tier("Diamond", 500000 * 1e18, 100000, 0));  // 10x allocation
    }

    // ============ Sale Creation ============

    /**
     * @notice Create a new token sale
     */
    function createSale(
        address saleToken,
        address paymentToken,
        uint256 tokenPrice,
        uint256 totalTokens,
        uint256 minPurchase,
        uint256 maxPurchase,
        uint256 startTime,
        uint256 endTime,
        uint256 softCap,
        uint256 hardCap,
        SaleType saleType,
        VestingType vestingType,
        string calldata metadata
    ) external onlyRole(CREATOR_ROLE) returns (uint256) {
        require(saleToken != address(0), "Invalid token");
        require(tokenPrice > 0, "Invalid price");
        require(totalTokens > 0, "Invalid total");
        require(endTime > startTime, "Invalid time");
        require(startTime > block.timestamp, "Start in past");
        require(hardCap >= softCap, "Invalid caps");

        saleCounter++;
        uint256 saleId = saleCounter;

        sales[saleId] = Sale({
            saleId: saleId,
            creator: msg.sender,
            saleToken: saleToken,
            paymentToken: paymentToken,
            tokenPrice: tokenPrice,
            totalTokens: totalTokens,
            tokensSold: 0,
            minPurchase: minPurchase,
            maxPurchase: maxPurchase,
            startTime: startTime,
            endTime: endTime,
            softCap: softCap,
            hardCap: hardCap,
            totalRaised: 0,
            saleType: saleType,
            status: SaleStatus.PENDING,
            vestingType: vestingType,
            metadata: metadata
        });

        // Transfer sale tokens to contract
        IERC20(saleToken).safeTransferFrom(msg.sender, address(this), totalTokens);

        totalSalesCreated++;

        emit SaleCreated(saleId, msg.sender, saleToken, totalTokens);

        return saleId;
    }

    /**
     * @notice Set vesting schedule for a sale
     */
    function setVestingSchedule(
        uint256 saleId,
        uint256 tgePercent,
        uint256 cliffDuration,
        uint256 vestingDuration,
        uint256 vestingInterval
    ) external {
        Sale storage sale = sales[saleId];
        require(sale.creator == msg.sender || hasRole(OPERATOR_ROLE, msg.sender), "Not authorized");
        require(sale.status == SaleStatus.PENDING, "Sale not pending");
        require(tgePercent <= BASIS_POINTS, "Invalid TGE percent");

        vestingSchedules[saleId] = VestingSchedule({
            tgePercent: tgePercent,
            cliffDuration: cliffDuration,
            vestingDuration: vestingDuration,
            vestingInterval: vestingInterval
        });
    }

    // ============ Sale Management ============

    /**
     * @notice Start a sale
     */
    function startSale(uint256 saleId) external {
        Sale storage sale = sales[saleId];
        require(sale.creator == msg.sender || hasRole(OPERATOR_ROLE, msg.sender), "Not authorized");
        require(sale.status == SaleStatus.PENDING, "Invalid status");
        require(block.timestamp >= sale.startTime, "Not start time");

        sale.status = SaleStatus.ACTIVE;
        emit SaleStarted(saleId);
    }

    /**
     * @notice Cancel a sale
     */
    function cancelSale(uint256 saleId) external {
        Sale storage sale = sales[saleId];
        require(sale.creator == msg.sender || hasRole(OPERATOR_ROLE, msg.sender), "Not authorized");
        require(sale.status == SaleStatus.PENDING || sale.status == SaleStatus.ACTIVE, "Cannot cancel");

        sale.status = SaleStatus.CANCELLED;

        // Return unsold tokens to creator
        uint256 unsold = sale.totalTokens - sale.tokensSold;
        if (unsold > 0) {
            IERC20(sale.saleToken).safeTransfer(sale.creator, unsold);
        }

        emit SaleCancelled(saleId);
    }

    /**
     * @notice Finalize a sale
     */
    function finalizeSale(uint256 saleId) external nonReentrant {
        Sale storage sale = sales[saleId];
        require(sale.status == SaleStatus.ACTIVE, "Not active");
        require(block.timestamp > sale.endTime || sale.totalRaised >= sale.hardCap, "Not ended");

        bool softCapReached = sale.totalRaised >= sale.softCap;
        sale.status = softCapReached ? SaleStatus.FINALIZED : SaleStatus.CANCELLED;

        if (softCapReached) {
            // Calculate and transfer fees
            uint256 fee = (sale.totalRaised * platformFee) / BASIS_POINTS;
            uint256 creatorAmount = sale.totalRaised - fee;

            if (sale.paymentToken == address(0)) {
                payable(feeRecipient).transfer(fee);
                payable(sale.creator).transfer(creatorAmount);
            } else {
                IERC20(sale.paymentToken).safeTransfer(feeRecipient, fee);
                IERC20(sale.paymentToken).safeTransfer(sale.creator, creatorAmount);
            }

            // Return unsold tokens
            uint256 unsold = sale.totalTokens - sale.tokensSold;
            if (unsold > 0) {
                IERC20(sale.saleToken).safeTransfer(sale.creator, unsold);
            }

            totalRaisedAllTime += sale.totalRaised;
        }

        emit SaleFinalized(saleId, sale.totalRaised, softCapReached);
    }

    // ============ Participation ============

    /**
     * @notice Participate in a sale
     */
    function participate(uint256 saleId, uint256 amount) external payable nonReentrant whenNotPaused {
        Sale storage sale = sales[saleId];
        require(sale.status == SaleStatus.ACTIVE, "Sale not active");
        require(block.timestamp >= sale.startTime && block.timestamp <= sale.endTime, "Outside sale period");
        require(sale.totalRaised + amount <= sale.hardCap, "Exceeds hard cap");

        Participation storage participation = participations[saleId][msg.sender];

        // Check whitelist if required
        if (sale.saleType == SaleType.WHITELIST) {
            require(whitelist[saleId][msg.sender], "Not whitelisted");
        }

        // Calculate allocation based on tier
        uint256 maxAllocation = _calculateMaxAllocation(saleId, msg.sender);
        require(participation.amount + amount <= maxAllocation, "Exceeds allocation");
        require(amount >= sale.minPurchase, "Below minimum");

        // Handle payment
        if (sale.paymentToken == address(0)) {
            require(msg.value == amount, "Invalid ETH amount");
        } else {
            IERC20(sale.paymentToken).safeTransferFrom(msg.sender, address(this), amount);
        }

        // Calculate tokens
        uint256 tokenAmount = (amount * 1e18) / sale.tokenPrice;
        require(sale.tokensSold + tokenAmount <= sale.totalTokens, "Insufficient tokens");

        // Update participation
        if (participation.amount == 0) {
            saleParticipants[saleId].push(msg.sender);
            totalParticipants++;
        }

        participation.amount += amount;
        participation.tokenAmount += tokenAmount;

        // Update sale
        sale.tokensSold += tokenAmount;
        sale.totalRaised += amount;

        emit Participated(saleId, msg.sender, amount, tokenAmount);
    }

    /**
     * @notice Claim tokens after sale finalization
     */
    function claimTokens(uint256 saleId) external nonReentrant {
        Sale storage sale = sales[saleId];
        require(sale.status == SaleStatus.FINALIZED, "Sale not finalized");

        Participation storage participation = participations[saleId][msg.sender];
        require(participation.tokenAmount > 0, "No tokens to claim");

        uint256 claimable = _calculateClaimable(saleId, msg.sender);
        require(claimable > 0, "Nothing to claim");

        participation.claimedAmount += claimable;

        IERC20(sale.saleToken).safeTransfer(msg.sender, claimable);

        emit TokensClaimed(saleId, msg.sender, claimable);
    }

    /**
     * @notice Claim refund if sale cancelled or soft cap not reached
     */
    function claimRefund(uint256 saleId) external nonReentrant {
        Sale storage sale = sales[saleId];
        require(sale.status == SaleStatus.CANCELLED, "Refund not available");

        Participation storage participation = participations[saleId][msg.sender];
        uint256 refundAmount = participation.amount - participation.refundedAmount;
        require(refundAmount > 0, "Nothing to refund");

        participation.refundedAmount = participation.amount;

        if (sale.paymentToken == address(0)) {
            payable(msg.sender).transfer(refundAmount);
        } else {
            IERC20(sale.paymentToken).safeTransfer(msg.sender, refundAmount);
        }

        emit Refunded(saleId, msg.sender, refundAmount);
    }

    // ============ Whitelist Management ============

    /**
     * @notice Add addresses to whitelist
     */
    function addToWhitelist(uint256 saleId, address[] calldata users) external {
        Sale storage sale = sales[saleId];
        require(sale.creator == msg.sender || hasRole(OPERATOR_ROLE, msg.sender), "Not authorized");

        for (uint256 i = 0; i < users.length; i++) {
            whitelist[saleId][users[i]] = true;
            participations[saleId][users[i]].isWhitelisted = true;
        }

        emit WhitelistUpdated(saleId, users, true);
    }

    /**
     * @notice Remove addresses from whitelist
     */
    function removeFromWhitelist(uint256 saleId, address[] calldata users) external {
        Sale storage sale = sales[saleId];
        require(sale.creator == msg.sender || hasRole(OPERATOR_ROLE, msg.sender), "Not authorized");

        for (uint256 i = 0; i < users.length; i++) {
            whitelist[saleId][users[i]] = false;
            participations[saleId][users[i]].isWhitelisted = false;
        }

        emit WhitelistUpdated(saleId, users, false);
    }

    // ============ View Functions ============

    /**
     * @notice Calculate maximum allocation for a user
     */
    function _calculateMaxAllocation(uint256 saleId, address user) internal view returns (uint256) {
        Sale storage sale = sales[saleId];
        
        if (sale.saleType == SaleType.PUBLIC) {
            return sale.maxPurchase;
        }

        // For tiered sales, calculate based on staked amount
        uint8 userTier = getUserTier(user);
        uint256 baseAllocation = sale.maxPurchase;
        
        if (userTier < tiers.length) {
            return (baseAllocation * tiers[userTier].allocationMultiplier) / BASIS_POINTS;
        }

        return baseAllocation;
    }

    /**
     * @notice Get user's tier based on staked SYNX
     */
    function getUserTier(address user) public view returns (uint8) {
        uint256 staked = userStakes[user];
        
        for (uint8 i = uint8(tiers.length); i > 0; i--) {
            if (staked >= tiers[i - 1].minStake) {
                return i - 1;
            }
        }
        
        return 0;
    }

    /**
     * @notice Calculate claimable tokens
     */
    function _calculateClaimable(uint256 saleId, address user) internal view returns (uint256) {
        Participation storage participation = participations[saleId][user];
        VestingSchedule storage vesting = vestingSchedules[saleId];
        Sale storage sale = sales[saleId];

        if (sale.vestingType == VestingType.NONE) {
            return participation.tokenAmount - participation.claimedAmount;
        }

        uint256 tgeAmount = (participation.tokenAmount * vesting.tgePercent) / BASIS_POINTS;
        uint256 vestedAmount = participation.tokenAmount - tgeAmount;

        uint256 elapsed = block.timestamp - sale.endTime;
        
        // Check cliff
        if (elapsed < vesting.cliffDuration) {
            return tgeAmount > participation.claimedAmount ? tgeAmount - participation.claimedAmount : 0;
        }

        uint256 vestingElapsed = elapsed - vesting.cliffDuration;
        uint256 vestedPortion;

        if (vestingElapsed >= vesting.vestingDuration) {
            vestedPortion = vestedAmount;
        } else {
            vestedPortion = (vestedAmount * vestingElapsed) / vesting.vestingDuration;
        }

        uint256 totalUnlocked = tgeAmount + vestedPortion;
        return totalUnlocked > participation.claimedAmount ? totalUnlocked - participation.claimedAmount : 0;
    }

    /**
     * @notice Get sale details
     */
    function getSale(uint256 saleId) external view returns (Sale memory) {
        return sales[saleId];
    }

    /**
     * @notice Get participation details
     */
    function getParticipation(uint256 saleId, address user) external view returns (Participation memory) {
        return participations[saleId][user];
    }

    /**
     * @notice Get claimable amount for user
     */
    function getClaimable(uint256 saleId, address user) external view returns (uint256) {
        return _calculateClaimable(saleId, user);
    }

    /**
     * @notice Get all tiers
     */
    function getTiers() external view returns (Tier[] memory) {
        return tiers;
    }

    /**
     * @notice Get sale participants
     */
    function getSaleParticipants(uint256 saleId) external view returns (address[] memory) {
        return saleParticipants[saleId];
    }

    // ============ Admin Functions ============

    /**
     * @notice Update user stake (called by staking contract)
     */
    function updateUserStake(address user, uint256 amount) external {
        require(hasRole(OPERATOR_ROLE, msg.sender), "Not operator");
        userStakes[user] = amount;
    }

    /**
     * @notice Add a new tier
     */
    function addTier(
        string calldata name,
        uint256 minStake,
        uint256 allocationMultiplier,
        uint256 maxParticipants
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        tiers.push(Tier(name, minStake, allocationMultiplier, maxParticipants));
        emit TierAdded(tiers.length - 1, name, minStake);
    }

    /**
     * @notice Update platform fee
     */
    function setPlatformFee(uint256 fee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(fee <= MAX_FEE, "Fee too high");
        platformFee = fee;
    }

    /**
     * @notice Set fee recipient
     */
    function setFeeRecipient(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeRecipient = recipient;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    receive() external payable {}
}
