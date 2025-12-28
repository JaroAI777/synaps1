// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title PaymentRouter
 * @notice Core payment routing contract for AI-to-AI transactions
 * @dev Handles direct payments, batched payments, and payment streaming
 * 
 * Features:
 * - Direct AI-to-AI payments
 * - Batched multi-recipient payments
 * - Conditional payments with escrow
 * - Payment streaming for continuous services
 * - Reputation-based fee discounts
 */
contract PaymentRouter is ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;
    
    // ============ Constants ============
    
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");
    
    uint256 public constant FEE_DENOMINATOR = 10000;
    uint256 public constant MAX_FEE = 100; // 1% max
    uint256 public constant MIN_PAYMENT = 1; // Minimum 1 wei SYNX
    uint256 public constant MAX_BATCH_SIZE = 100;
    
    // ============ Structs ============
    
    struct Payment {
        bytes32 paymentId;
        address sender;
        address recipient;
        uint256 amount;
        uint256 fee;
        uint256 timestamp;
        PaymentStatus status;
        bytes32 serviceType;
        string metadata;
    }
    
    struct EscrowPayment {
        bytes32 escrowId;
        address sender;
        address recipient;
        address arbiter;
        uint256 amount;
        uint256 fee;
        uint256 deadline;
        EscrowStatus status;
        bytes32 conditionHash;
    }
    
    struct PaymentStream {
        bytes32 streamId;
        address sender;
        address recipient;
        uint256 totalAmount;
        uint256 withdrawn;
        uint256 startTime;
        uint256 endTime;
        bool active;
    }
    
    struct FeeDiscount {
        uint256 minTransactions;
        uint256 discountBps;
    }
    
    enum PaymentStatus {
        Pending,
        Completed,
        Failed,
        Refunded
    }
    
    enum EscrowStatus {
        Active,
        Released,
        Refunded,
        Disputed
    }
    
    // ============ State Variables ============
    
    IERC20 public immutable synxToken;
    address public feeCollector;
    address public reputationRegistry;
    
    uint256 public baseFee = 10; // 0.1% base fee
    uint256 public totalPayments;
    uint256 public totalVolume;
    uint256 public totalFeesCollected;
    
    // Payment tracking
    mapping(bytes32 => Payment) public payments;
    mapping(bytes32 => EscrowPayment) public escrows;
    mapping(bytes32 => PaymentStream) public streams;
    
    // Agent statistics
    mapping(address => uint256) public agentPaymentCount;
    mapping(address => uint256) public agentVolume;
    
    // Fee discounts based on reputation tier
    mapping(uint8 => uint256) public tierDiscounts;
    
    // Nonces for replay protection
    mapping(address => uint256) public nonces;
    
    // ============ Events ============
    
    event PaymentExecuted(
        bytes32 indexed paymentId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        bytes32 serviceType
    );
    
    event BatchPaymentExecuted(
        bytes32 indexed batchId,
        address indexed sender,
        uint256 totalAmount,
        uint256 recipientCount
    );
    
    event EscrowCreated(
        bytes32 indexed escrowId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 deadline
    );
    
    event EscrowReleased(bytes32 indexed escrowId);
    event EscrowRefunded(bytes32 indexed escrowId);
    event EscrowDisputed(bytes32 indexed escrowId, address indexed disputer);
    
    event StreamCreated(
        bytes32 indexed streamId,
        address indexed sender,
        address indexed recipient,
        uint256 totalAmount,
        uint256 duration
    );
    
    event StreamWithdrawal(
        bytes32 indexed streamId,
        address indexed recipient,
        uint256 amount
    );
    
    event StreamCancelled(bytes32 indexed streamId, uint256 refundAmount);
    
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event TierDiscountUpdated(uint8 tier, uint256 discount);
    
    // ============ Errors ============
    
    error InvalidAmount();
    error InvalidRecipient();
    error PaymentNotFound();
    error EscrowNotFound();
    error StreamNotFound();
    error DeadlineExpired();
    error DeadlineNotExpired();
    error Unauthorized();
    error AlreadyProcessed();
    error InvalidSignature();
    error BatchTooLarge();
    error InsufficientStreamBalance();
    error StreamNotActive();
    
    // ============ Constructor ============
    
    constructor(
        address _synxToken,
        address _feeCollector,
        address _reputationRegistry
    ) {
        synxToken = IERC20(_synxToken);
        feeCollector = _feeCollector;
        reputationRegistry = _reputationRegistry;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
        _grantRole(FEE_MANAGER_ROLE, msg.sender);
        
        // Initialize tier discounts
        tierDiscounts[0] = 0;    // Unverified: no discount
        tierDiscounts[1] = 0;    // Bronze: no discount
        tierDiscounts[2] = 1000; // Silver: 10% discount
        tierDiscounts[3] = 2500; // Gold: 25% discount
        tierDiscounts[4] = 5000; // Platinum: 50% discount
        tierDiscounts[5] = 7500; // Diamond: 75% discount
    }
    
    // ============ Direct Payments ============
    
    /**
     * @notice Execute a direct payment from sender to recipient
     * @param recipient Address receiving the payment
     * @param amount Amount of SYNX to transfer
     * @param serviceType Identifier for the type of AI service
     * @param metadata Additional payment metadata (IPFS hash, etc.)
     */
    function pay(
        address recipient,
        uint256 amount,
        bytes32 serviceType,
        string calldata metadata
    ) external nonReentrant whenNotPaused returns (bytes32) {
        if (amount < MIN_PAYMENT) revert InvalidAmount();
        if (recipient == address(0) || recipient == msg.sender) revert InvalidRecipient();
        
        bytes32 paymentId = _generatePaymentId(msg.sender, recipient, amount);
        uint256 fee = _calculateFee(msg.sender, amount);
        uint256 netAmount = amount - fee;
        
        // Transfer tokens
        synxToken.safeTransferFrom(msg.sender, recipient, netAmount);
        if (fee > 0) {
            synxToken.safeTransferFrom(msg.sender, feeCollector, fee);
            totalFeesCollected += fee;
        }
        
        // Record payment
        payments[paymentId] = Payment({
            paymentId: paymentId,
            sender: msg.sender,
            recipient: recipient,
            amount: amount,
            fee: fee,
            timestamp: block.timestamp,
            status: PaymentStatus.Completed,
            serviceType: serviceType,
            metadata: metadata
        });
        
        // Update statistics
        _updateStats(msg.sender, recipient, amount);
        
        emit PaymentExecuted(paymentId, msg.sender, recipient, amount, fee, serviceType);
        
        return paymentId;
    }
    
    /**
     * @notice Execute payment with signature (gasless for sender)
     * @dev Allows meta-transactions where operator pays gas
     */
    function payWithSignature(
        address sender,
        address recipient,
        uint256 amount,
        bytes32 serviceType,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant whenNotPaused onlyRole(OPERATOR_ROLE) returns (bytes32) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (amount < MIN_PAYMENT) revert InvalidAmount();
        if (recipient == address(0) || recipient == sender) revert InvalidRecipient();
        
        // Verify signature
        bytes32 messageHash = keccak256(abi.encodePacked(
            sender,
            recipient,
            amount,
            serviceType,
            nonces[sender]++,
            deadline,
            block.chainid,
            address(this)
        ));
        
        bytes32 ethSignedHash = messageHash.toEthSignedMessageHash();
        address signer = ethSignedHash.recover(signature);
        
        if (signer != sender) revert InvalidSignature();
        
        bytes32 paymentId = _generatePaymentId(sender, recipient, amount);
        uint256 fee = _calculateFee(sender, amount);
        uint256 netAmount = amount - fee;
        
        // Transfer tokens
        synxToken.safeTransferFrom(sender, recipient, netAmount);
        if (fee > 0) {
            synxToken.safeTransferFrom(sender, feeCollector, fee);
            totalFeesCollected += fee;
        }
        
        // Record payment
        payments[paymentId] = Payment({
            paymentId: paymentId,
            sender: sender,
            recipient: recipient,
            amount: amount,
            fee: fee,
            timestamp: block.timestamp,
            status: PaymentStatus.Completed,
            serviceType: serviceType,
            metadata: ""
        });
        
        _updateStats(sender, recipient, amount);
        
        emit PaymentExecuted(paymentId, sender, recipient, amount, fee, serviceType);
        
        return paymentId;
    }
    
    // ============ Batch Payments ============
    
    /**
     * @notice Execute multiple payments in a single transaction
     * @param recipients Array of recipient addresses
     * @param amounts Array of amounts for each recipient
     * @param serviceTypes Array of service type identifiers
     */
    function batchPay(
        address[] calldata recipients,
        uint256[] calldata amounts,
        bytes32[] calldata serviceTypes
    ) external nonReentrant whenNotPaused returns (bytes32) {
        uint256 len = recipients.length;
        if (len != amounts.length || len != serviceTypes.length) revert InvalidAmount();
        if (len > MAX_BATCH_SIZE) revert BatchTooLarge();
        
        bytes32 batchId = keccak256(abi.encodePacked(
            msg.sender,
            block.timestamp,
            nonces[msg.sender]++
        ));
        
        uint256 totalAmount = 0;
        uint256 totalFee = 0;
        
        for (uint256 i = 0; i < len; i++) {
            if (recipients[i] == address(0) || recipients[i] == msg.sender) continue;
            if (amounts[i] < MIN_PAYMENT) continue;
            
            uint256 fee = _calculateFee(msg.sender, amounts[i]);
            uint256 netAmount = amounts[i] - fee;
            
            synxToken.safeTransferFrom(msg.sender, recipients[i], netAmount);
            
            totalAmount += amounts[i];
            totalFee += fee;
            
            _updateStats(msg.sender, recipients[i], amounts[i]);
        }
        
        if (totalFee > 0) {
            synxToken.safeTransferFrom(msg.sender, feeCollector, totalFee);
            totalFeesCollected += totalFee;
        }
        
        emit BatchPaymentExecuted(batchId, msg.sender, totalAmount, len);
        
        return batchId;
    }
    
    // ============ Escrow Payments ============
    
    /**
     * @notice Create an escrow payment with conditions
     * @param recipient Address to receive payment upon condition fulfillment
     * @param arbiter Address that can resolve disputes
     * @param amount Amount to escrow
     * @param deadline Time after which sender can reclaim funds
     * @param conditionHash Hash of the condition that must be met
     */
    function createEscrow(
        address recipient,
        address arbiter,
        uint256 amount,
        uint256 deadline,
        bytes32 conditionHash
    ) external nonReentrant whenNotPaused returns (bytes32) {
        if (amount < MIN_PAYMENT) revert InvalidAmount();
        if (recipient == address(0) || recipient == msg.sender) revert InvalidRecipient();
        if (deadline <= block.timestamp) revert DeadlineExpired();
        
        bytes32 escrowId = keccak256(abi.encodePacked(
            msg.sender,
            recipient,
            amount,
            deadline,
            nonces[msg.sender]++
        ));
        
        uint256 fee = _calculateFee(msg.sender, amount);
        
        // Lock funds in contract
        synxToken.safeTransferFrom(msg.sender, address(this), amount);
        
        escrows[escrowId] = EscrowPayment({
            escrowId: escrowId,
            sender: msg.sender,
            recipient: recipient,
            arbiter: arbiter,
            amount: amount,
            fee: fee,
            deadline: deadline,
            status: EscrowStatus.Active,
            conditionHash: conditionHash
        });
        
        emit EscrowCreated(escrowId, msg.sender, recipient, amount, deadline);
        
        return escrowId;
    }
    
    /**
     * @notice Release escrow funds to recipient
     * @param escrowId ID of the escrow to release
     * @param conditionProof Proof that condition was met
     */
    function releaseEscrow(bytes32 escrowId, bytes calldata conditionProof) 
        external 
        nonReentrant 
    {
        EscrowPayment storage escrow = escrows[escrowId];
        if (escrow.sender == address(0)) revert EscrowNotFound();
        if (escrow.status != EscrowStatus.Active) revert AlreadyProcessed();
        
        // Only sender, recipient (with proof), or arbiter can release
        bool authorized = msg.sender == escrow.sender ||
            msg.sender == escrow.arbiter ||
            (msg.sender == escrow.recipient && 
             keccak256(conditionProof) == escrow.conditionHash);
        
        if (!authorized) revert Unauthorized();
        
        escrow.status = EscrowStatus.Released;
        
        uint256 netAmount = escrow.amount - escrow.fee;
        synxToken.safeTransfer(escrow.recipient, netAmount);
        
        if (escrow.fee > 0) {
            synxToken.safeTransfer(feeCollector, escrow.fee);
            totalFeesCollected += escrow.fee;
        }
        
        _updateStats(escrow.sender, escrow.recipient, escrow.amount);
        
        emit EscrowReleased(escrowId);
    }
    
    /**
     * @notice Refund escrow to sender after deadline
     */
    function refundEscrow(bytes32 escrowId) external nonReentrant {
        EscrowPayment storage escrow = escrows[escrowId];
        if (escrow.sender == address(0)) revert EscrowNotFound();
        if (escrow.status != EscrowStatus.Active) revert AlreadyProcessed();
        if (block.timestamp < escrow.deadline) revert DeadlineNotExpired();
        
        escrow.status = EscrowStatus.Refunded;
        synxToken.safeTransfer(escrow.sender, escrow.amount);
        
        emit EscrowRefunded(escrowId);
    }
    
    /**
     * @notice Raise a dispute on an escrow
     */
    function disputeEscrow(bytes32 escrowId) external {
        EscrowPayment storage escrow = escrows[escrowId];
        if (escrow.sender == address(0)) revert EscrowNotFound();
        if (escrow.status != EscrowStatus.Active) revert AlreadyProcessed();
        
        if (msg.sender != escrow.sender && msg.sender != escrow.recipient) {
            revert Unauthorized();
        }
        
        escrow.status = EscrowStatus.Disputed;
        
        emit EscrowDisputed(escrowId, msg.sender);
    }
    
    // ============ Payment Streaming ============
    
    /**
     * @notice Create a payment stream for continuous AI services
     * @param recipient Address receiving the stream
     * @param totalAmount Total amount to stream
     * @param duration Duration of the stream in seconds
     */
    function createStream(
        address recipient,
        uint256 totalAmount,
        uint256 duration
    ) external nonReentrant whenNotPaused returns (bytes32) {
        if (totalAmount < MIN_PAYMENT) revert InvalidAmount();
        if (recipient == address(0) || recipient == msg.sender) revert InvalidRecipient();
        if (duration == 0) revert InvalidAmount();
        
        bytes32 streamId = keccak256(abi.encodePacked(
            msg.sender,
            recipient,
            totalAmount,
            duration,
            nonces[msg.sender]++
        ));
        
        // Lock funds
        synxToken.safeTransferFrom(msg.sender, address(this), totalAmount);
        
        streams[streamId] = PaymentStream({
            streamId: streamId,
            sender: msg.sender,
            recipient: recipient,
            totalAmount: totalAmount,
            withdrawn: 0,
            startTime: block.timestamp,
            endTime: block.timestamp + duration,
            active: true
        });
        
        emit StreamCreated(streamId, msg.sender, recipient, totalAmount, duration);
        
        return streamId;
    }
    
    /**
     * @notice Withdraw available funds from a stream
     */
    function withdrawFromStream(bytes32 streamId) external nonReentrant {
        PaymentStream storage stream = streams[streamId];
        if (stream.sender == address(0)) revert StreamNotFound();
        if (!stream.active) revert StreamNotActive();
        if (msg.sender != stream.recipient) revert Unauthorized();
        
        uint256 available = _streamBalance(stream);
        if (available == 0) revert InsufficientStreamBalance();
        
        uint256 fee = _calculateFee(stream.sender, available);
        uint256 netAmount = available - fee;
        
        stream.withdrawn += available;
        
        synxToken.safeTransfer(stream.recipient, netAmount);
        if (fee > 0) {
            synxToken.safeTransfer(feeCollector, fee);
            totalFeesCollected += fee;
        }
        
        // Check if stream is complete
        if (stream.withdrawn >= stream.totalAmount) {
            stream.active = false;
            _updateStats(stream.sender, stream.recipient, stream.totalAmount);
        }
        
        emit StreamWithdrawal(streamId, stream.recipient, available);
    }
    
    /**
     * @notice Cancel a stream and refund remaining funds
     */
    function cancelStream(bytes32 streamId) external nonReentrant {
        PaymentStream storage stream = streams[streamId];
        if (stream.sender == address(0)) revert StreamNotFound();
        if (!stream.active) revert StreamNotActive();
        if (msg.sender != stream.sender && msg.sender != stream.recipient) {
            revert Unauthorized();
        }
        
        // Calculate and transfer accrued amount to recipient
        uint256 accrued = _streamBalance(stream);
        if (accrued > 0) {
            uint256 fee = _calculateFee(stream.sender, accrued);
            uint256 netAccrued = accrued - fee;
            
            synxToken.safeTransfer(stream.recipient, netAccrued);
            if (fee > 0) {
                synxToken.safeTransfer(feeCollector, fee);
                totalFeesCollected += fee;
            }
        }
        
        // Refund remaining to sender
        uint256 refund = stream.totalAmount - stream.withdrawn - accrued;
        if (refund > 0) {
            synxToken.safeTransfer(stream.sender, refund);
        }
        
        stream.active = false;
        
        emit StreamCancelled(streamId, refund);
    }
    
    /**
     * @notice Get current withdrawable balance from a stream
     */
    function getStreamBalance(bytes32 streamId) external view returns (uint256) {
        PaymentStream storage stream = streams[streamId];
        if (stream.sender == address(0)) return 0;
        return _streamBalance(stream);
    }
    
    function _streamBalance(PaymentStream storage stream) internal view returns (uint256) {
        if (!stream.active) return 0;
        
        uint256 elapsed;
        if (block.timestamp >= stream.endTime) {
            elapsed = stream.endTime - stream.startTime;
        } else {
            elapsed = block.timestamp - stream.startTime;
        }
        
        uint256 duration = stream.endTime - stream.startTime;
        uint256 accrued = (stream.totalAmount * elapsed) / duration;
        
        return accrued > stream.withdrawn ? accrued - stream.withdrawn : 0;
    }
    
    // ============ Fee Calculation ============
    
    function _calculateFee(address sender, uint256 amount) internal view returns (uint256) {
        uint256 fee = (amount * baseFee) / FEE_DENOMINATOR;
        
        // Apply reputation discount if registry is set
        if (reputationRegistry != address(0)) {
            try IReputationRegistry(reputationRegistry).getAgentTier(sender) returns (uint8 tier) {
                uint256 discount = tierDiscounts[tier];
                if (discount > 0) {
                    fee = fee - (fee * discount / FEE_DENOMINATOR);
                }
            } catch {
                // No discount if registry call fails
            }
        }
        
        return fee;
    }
    
    // ============ Internal Functions ============
    
    function _generatePaymentId(
        address sender,
        address recipient,
        uint256 amount
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            sender,
            recipient,
            amount,
            block.timestamp,
            nonces[sender]
        ));
    }
    
    function _updateStats(address sender, address recipient, uint256 amount) internal {
        totalPayments++;
        totalVolume += amount;
        
        agentPaymentCount[sender]++;
        agentPaymentCount[recipient]++;
        agentVolume[sender] += amount;
        agentVolume[recipient] += amount;
    }
    
    // ============ Admin Functions ============
    
    function setBaseFee(uint256 newFee) external onlyRole(FEE_MANAGER_ROLE) {
        if (newFee > MAX_FEE) revert InvalidAmount();
        uint256 oldFee = baseFee;
        baseFee = newFee;
        emit FeeUpdated(oldFee, newFee);
    }
    
    function setTierDiscount(uint8 tier, uint256 discount) external onlyRole(FEE_MANAGER_ROLE) {
        tierDiscounts[tier] = discount;
        emit TierDiscountUpdated(tier, discount);
    }
    
    function setFeeCollector(address newCollector) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeCollector = newCollector;
    }
    
    function setReputationRegistry(address newRegistry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        reputationRegistry = newRegistry;
    }
    
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }
    
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
    
    // ============ View Functions ============
    
    function getPayment(bytes32 paymentId) external view returns (Payment memory) {
        return payments[paymentId];
    }
    
    function getEscrow(bytes32 escrowId) external view returns (EscrowPayment memory) {
        return escrows[escrowId];
    }
    
    function getStream(bytes32 streamId) external view returns (PaymentStream memory) {
        return streams[streamId];
    }
    
    function getAgentStats(address agent) external view returns (
        uint256 paymentCount,
        uint256 volume,
        uint256 estimatedFee
    ) {
        paymentCount = agentPaymentCount[agent];
        volume = agentVolume[agent];
        estimatedFee = _calculateFee(agent, 1 ether); // Fee per 1 SYNX
    }
}

// Interface for Reputation Registry
interface IReputationRegistry {
    function getAgentTier(address agent) external view returns (uint8);
}
