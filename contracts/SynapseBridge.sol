// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title SynapseBridge
 * @notice Cross-chain bridge for SYNX tokens
 * @dev Supports bridging between Ethereum, Arbitrum, and other EVM chains
 */
contract SynapseBridge is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ============ Roles ============
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant VALIDATOR_ROLE = keccak256("VALIDATOR_ROLE");
    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");

    // ============ Structs ============
    
    /**
     * @notice Bridge transfer request
     */
    struct BridgeRequest {
        address sender;
        address recipient;
        uint256 amount;
        uint256 fee;
        uint256 sourceChain;
        uint256 destChain;
        uint256 nonce;
        uint256 timestamp;
        bytes32 requestId;
        BridgeStatus status;
    }

    /**
     * @notice Supported chain configuration
     */
    struct ChainConfig {
        bool supported;
        uint256 minAmount;
        uint256 maxAmount;
        uint256 dailyLimit;
        uint256 dailyVolume;
        uint256 lastResetTime;
        uint256 bridgeFee; // Basis points
        address bridgeContract;
    }

    /**
     * @notice Validator signature
     */
    struct ValidatorSignature {
        address validator;
        bytes signature;
    }

    // ============ Enums ============
    
    enum BridgeStatus {
        PENDING,
        VALIDATED,
        COMPLETED,
        REFUNDED,
        CANCELLED
    }

    // ============ State Variables ============
    
    IERC20 public token;
    uint256 public chainId;
    
    // Bridge requests
    mapping(bytes32 => BridgeRequest) public requests;
    mapping(address => bytes32[]) public userRequests;
    mapping(address => uint256) public userNonces;
    
    // Incoming transfers (from other chains)
    mapping(bytes32 => bool) public processedIncoming;
    
    // Chain configurations
    mapping(uint256 => ChainConfig) public chainConfigs;
    uint256[] public supportedChains;
    
    // Validators
    address[] public validators;
    mapping(address => bool) public isValidator;
    uint256 public requiredValidations;
    mapping(bytes32 => mapping(address => bool)) public hasValidated;
    mapping(bytes32 => uint256) public validationCount;
    
    // Fee management
    address public feeCollector;
    uint256 public totalFeesCollected;
    
    // Liquidity
    uint256 public totalLocked;
    uint256 public totalBridgedOut;
    uint256 public totalBridgedIn;
    
    // Security
    uint256 public constant MAX_VALIDATORS = 20;
    uint256 public constant MIN_CONFIRMATIONS = 2;
    uint256 public constant REQUEST_EXPIRY = 7 days;
    
    // ============ Events ============
    
    event BridgeInitiated(
        bytes32 indexed requestId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        uint256 sourceChain,
        uint256 destChain,
        uint256 nonce
    );
    
    event BridgeValidated(
        bytes32 indexed requestId,
        address indexed validator,
        uint256 validationCount,
        uint256 requiredValidations
    );
    
    event BridgeCompleted(
        bytes32 indexed requestId,
        address indexed recipient,
        uint256 amount
    );
    
    event BridgeRefunded(
        bytes32 indexed requestId,
        address indexed sender,
        uint256 amount
    );
    
    event IncomingBridgeProcessed(
        bytes32 indexed sourceRequestId,
        address indexed recipient,
        uint256 amount,
        uint256 sourceChain
    );
    
    event ChainConfigUpdated(
        uint256 indexed chainId,
        bool supported,
        uint256 minAmount,
        uint256 maxAmount,
        uint256 bridgeFee
    );
    
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);
    event RequiredValidationsUpdated(uint256 oldValue, uint256 newValue);

    // ============ Constructor ============
    
    constructor(
        address _token,
        uint256 _chainId,
        address _feeCollector,
        uint256 _requiredValidations
    ) {
        require(_token != address(0), "Invalid token");
        require(_feeCollector != address(0), "Invalid fee collector");
        require(_requiredValidations >= MIN_CONFIRMATIONS, "Too few validations");
        
        token = IERC20(_token);
        chainId = _chainId;
        feeCollector = _feeCollector;
        requiredValidations = _requiredValidations;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RELAYER_ROLE, msg.sender);
        _grantRole(FEE_MANAGER_ROLE, msg.sender);
    }

    // ============ Bridge Initiation ============
    
    /**
     * @notice Initiate a bridge transfer to another chain
     */
    function bridge(
        address recipient,
        uint256 amount,
        uint256 destChain
    ) external nonReentrant whenNotPaused returns (bytes32 requestId) {
        ChainConfig storage config = chainConfigs[destChain];
        require(config.supported, "Chain not supported");
        require(amount >= config.minAmount, "Below minimum");
        require(amount <= config.maxAmount, "Above maximum");
        require(recipient != address(0), "Invalid recipient");
        
        // Check daily limit
        _checkAndUpdateDailyLimit(destChain, amount);
        
        // Calculate fee
        uint256 fee = (amount * config.bridgeFee) / 10000;
        uint256 netAmount = amount - fee;
        
        // Generate request ID
        uint256 nonce = userNonces[msg.sender]++;
        requestId = keccak256(abi.encodePacked(
            msg.sender,
            recipient,
            amount,
            chainId,
            destChain,
            nonce,
            block.timestamp
        ));
        
        require(requests[requestId].timestamp == 0, "Request exists");
        
        // Create request
        requests[requestId] = BridgeRequest({
            sender: msg.sender,
            recipient: recipient,
            amount: netAmount,
            fee: fee,
            sourceChain: chainId,
            destChain: destChain,
            nonce: nonce,
            timestamp: block.timestamp,
            requestId: requestId,
            status: BridgeStatus.PENDING
        });
        
        userRequests[msg.sender].push(requestId);
        
        // Lock tokens
        token.safeTransferFrom(msg.sender, address(this), amount);
        totalLocked += netAmount;
        totalBridgedOut += netAmount;
        
        // Collect fee
        if (fee > 0) {
            token.safeTransfer(feeCollector, fee);
            totalFeesCollected += fee;
        }
        
        emit BridgeInitiated(
            requestId,
            msg.sender,
            recipient,
            netAmount,
            fee,
            chainId,
            destChain,
            nonce
        );
    }

    // ============ Validation ============
    
    /**
     * @notice Validate a bridge request (called by validators)
     */
    function validateBridge(
        bytes32 requestId
    ) external onlyRole(VALIDATOR_ROLE) {
        BridgeRequest storage request = requests[requestId];
        require(request.timestamp > 0, "Request not found");
        require(request.status == BridgeStatus.PENDING, "Invalid status");
        require(!hasValidated[requestId][msg.sender], "Already validated");
        require(block.timestamp <= request.timestamp + REQUEST_EXPIRY, "Request expired");
        
        hasValidated[requestId][msg.sender] = true;
        validationCount[requestId]++;
        
        emit BridgeValidated(
            requestId,
            msg.sender,
            validationCount[requestId],
            requiredValidations
        );
        
        // Check if enough validations
        if (validationCount[requestId] >= requiredValidations) {
            request.status = BridgeStatus.VALIDATED;
        }
    }

    /**
     * @notice Batch validate multiple requests
     */
    function batchValidate(bytes32[] calldata requestIds) external onlyRole(VALIDATOR_ROLE) {
        for (uint256 i = 0; i < requestIds.length; i++) {
            BridgeRequest storage request = requests[requestIds[i]];
            
            if (
                request.timestamp > 0 &&
                request.status == BridgeStatus.PENDING &&
                !hasValidated[requestIds[i]][msg.sender] &&
                block.timestamp <= request.timestamp + REQUEST_EXPIRY
            ) {
                hasValidated[requestIds[i]][msg.sender] = true;
                validationCount[requestIds[i]]++;
                
                emit BridgeValidated(
                    requestIds[i],
                    msg.sender,
                    validationCount[requestIds[i]],
                    requiredValidations
                );
                
                if (validationCount[requestIds[i]] >= requiredValidations) {
                    request.status = BridgeStatus.VALIDATED;
                }
            }
        }
    }

    // ============ Incoming Transfers ============
    
    /**
     * @notice Process incoming bridge transfer from another chain
     */
    function processIncoming(
        bytes32 sourceRequestId,
        address recipient,
        uint256 amount,
        uint256 sourceChain,
        ValidatorSignature[] calldata signatures
    ) external onlyRole(RELAYER_ROLE) nonReentrant whenNotPaused {
        require(!processedIncoming[sourceRequestId], "Already processed");
        require(signatures.length >= requiredValidations, "Insufficient signatures");
        require(recipient != address(0), "Invalid recipient");
        
        // Verify signatures
        bytes32 message = keccak256(abi.encodePacked(
            sourceRequestId,
            recipient,
            amount,
            sourceChain,
            chainId
        ));
        bytes32 ethSignedMessage = message.toEthSignedMessageHash();
        
        uint256 validSignatures;
        address[] memory signers = new address[](signatures.length);
        
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ethSignedMessage.recover(signatures[i].signature);
            
            // Check if valid validator and not duplicate
            if (isValidator[signer]) {
                bool duplicate = false;
                for (uint256 j = 0; j < validSignatures; j++) {
                    if (signers[j] == signer) {
                        duplicate = true;
                        break;
                    }
                }
                
                if (!duplicate) {
                    signers[validSignatures] = signer;
                    validSignatures++;
                }
            }
        }
        
        require(validSignatures >= requiredValidations, "Invalid signatures");
        
        // Mark as processed
        processedIncoming[sourceRequestId] = true;
        
        // Release tokens
        require(token.balanceOf(address(this)) >= amount, "Insufficient liquidity");
        totalLocked -= amount;
        totalBridgedIn += amount;
        
        token.safeTransfer(recipient, amount);
        
        emit IncomingBridgeProcessed(sourceRequestId, recipient, amount, sourceChain);
    }

    // ============ Refunds ============
    
    /**
     * @notice Refund an expired or cancelled bridge request
     */
    function refund(bytes32 requestId) external nonReentrant {
        BridgeRequest storage request = requests[requestId];
        require(request.sender == msg.sender || hasRole(RELAYER_ROLE, msg.sender), "Not authorized");
        require(
            request.status == BridgeStatus.PENDING || 
            request.status == BridgeStatus.VALIDATED,
            "Cannot refund"
        );
        require(block.timestamp > request.timestamp + REQUEST_EXPIRY, "Not expired");
        
        request.status = BridgeStatus.REFUNDED;
        totalLocked -= request.amount;
        
        token.safeTransfer(request.sender, request.amount);
        
        emit BridgeRefunded(requestId, request.sender, request.amount);
    }

    // ============ Daily Limits ============
    
    /**
     * @dev Check and update daily volume limit
     */
    function _checkAndUpdateDailyLimit(uint256 destChain, uint256 amount) internal {
        ChainConfig storage config = chainConfigs[destChain];
        
        // Reset daily volume if new day
        if (block.timestamp >= config.lastResetTime + 1 days) {
            config.dailyVolume = 0;
            config.lastResetTime = block.timestamp;
        }
        
        require(
            config.dailyVolume + amount <= config.dailyLimit,
            "Daily limit exceeded"
        );
        
        config.dailyVolume += amount;
    }

    // ============ Chain Configuration ============
    
    /**
     * @notice Add or update supported chain
     */
    function setChainConfig(
        uint256 _chainId,
        bool supported,
        uint256 minAmount,
        uint256 maxAmount,
        uint256 dailyLimit,
        uint256 bridgeFee,
        address bridgeContract
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bridgeFee <= 1000, "Fee too high"); // Max 10%
        require(maxAmount >= minAmount, "Invalid amounts");
        
        ChainConfig storage config = chainConfigs[_chainId];
        
        // Add to supported chains list if new
        if (!config.supported && supported) {
            supportedChains.push(_chainId);
        }
        
        config.supported = supported;
        config.minAmount = minAmount;
        config.maxAmount = maxAmount;
        config.dailyLimit = dailyLimit;
        config.bridgeFee = bridgeFee;
        config.bridgeContract = bridgeContract;
        
        if (config.lastResetTime == 0) {
            config.lastResetTime = block.timestamp;
        }
        
        emit ChainConfigUpdated(_chainId, supported, minAmount, maxAmount, bridgeFee);
    }

    // ============ Validator Management ============
    
    /**
     * @notice Add a validator
     */
    function addValidator(address validator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(validator != address(0), "Invalid address");
        require(!isValidator[validator], "Already validator");
        require(validators.length < MAX_VALIDATORS, "Max validators reached");
        
        validators.push(validator);
        isValidator[validator] = true;
        _grantRole(VALIDATOR_ROLE, validator);
        
        emit ValidatorAdded(validator);
    }

    /**
     * @notice Remove a validator
     */
    function removeValidator(address validator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(isValidator[validator], "Not validator");
        require(validators.length > requiredValidations, "Cannot remove");
        
        isValidator[validator] = false;
        _revokeRole(VALIDATOR_ROLE, validator);
        
        // Remove from array
        for (uint256 i = 0; i < validators.length; i++) {
            if (validators[i] == validator) {
                validators[i] = validators[validators.length - 1];
                validators.pop();
                break;
            }
        }
        
        emit ValidatorRemoved(validator);
    }

    /**
     * @notice Update required validations
     */
    function setRequiredValidations(uint256 _required) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_required >= MIN_CONFIRMATIONS, "Too few");
        require(_required <= validators.length, "Too many");
        
        uint256 oldValue = requiredValidations;
        requiredValidations = _required;
        
        emit RequiredValidationsUpdated(oldValue, _required);
    }

    // ============ View Functions ============
    
    /**
     * @notice Get request details
     */
    function getRequest(bytes32 requestId) external view returns (BridgeRequest memory) {
        return requests[requestId];
    }

    /**
     * @notice Get user's bridge requests
     */
    function getUserRequests(address user) external view returns (bytes32[] memory) {
        return userRequests[user];
    }

    /**
     * @notice Get all validators
     */
    function getValidators() external view returns (address[] memory) {
        return validators;
    }

    /**
     * @notice Get all supported chains
     */
    function getSupportedChains() external view returns (uint256[] memory) {
        return supportedChains;
    }

    /**
     * @notice Get bridge statistics
     */
    function getStatistics() external view returns (
        uint256 _totalLocked,
        uint256 _totalBridgedOut,
        uint256 _totalBridgedIn,
        uint256 _totalFees,
        uint256 _validatorCount,
        uint256 _chainCount
    ) {
        return (
            totalLocked,
            totalBridgedOut,
            totalBridgedIn,
            totalFeesCollected,
            validators.length,
            supportedChains.length
        );
    }

    /**
     * @notice Estimate bridge fee
     */
    function estimateFee(uint256 amount, uint256 destChain) external view returns (uint256) {
        ChainConfig storage config = chainConfigs[destChain];
        require(config.supported, "Chain not supported");
        return (amount * config.bridgeFee) / 10000;
    }

    // ============ Admin Functions ============
    
    /**
     * @notice Update fee collector
     */
    function setFeeCollector(address _feeCollector) external onlyRole(FEE_MANAGER_ROLE) {
        require(_feeCollector != address(0), "Invalid address");
        feeCollector = _feeCollector;
    }

    /**
     * @notice Add liquidity to the bridge
     */
    function addLiquidity(uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        totalLocked += amount;
    }

    /**
     * @notice Remove excess liquidity (admin only)
     */
    function removeLiquidity(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 available = token.balanceOf(address(this)) - totalLocked;
        require(amount <= available, "Insufficient available");
        token.safeTransfer(msg.sender, amount);
    }

    /**
     * @notice Pause bridge
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause bridge
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Emergency withdraw (admin only)
     */
    function emergencyWithdraw(
        address tokenAddress,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(tokenAddress).safeTransfer(msg.sender, amount);
    }
}
