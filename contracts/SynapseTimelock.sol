// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SynapseTimelock
 * @notice Time-locked execution of governance proposals
 * @dev Implements configurable delay for critical protocol operations
 */
contract SynapseTimelock is AccessControl, ReentrancyGuard {
    // ============ Roles ============
    
    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 public constant CANCELLER_ROLE = keccak256("CANCELLER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ============ Structs ============

    struct Transaction {
        address target;
        uint256 value;
        bytes data;
        string description;
        uint256 eta;           // Execution time
        bool executed;
        bool cancelled;
    }

    struct BatchTransaction {
        address[] targets;
        uint256[] values;
        bytes[] datas;
        string description;
        uint256 eta;
        bool executed;
        bool cancelled;
    }

    // ============ State Variables ============

    // Delay configuration
    uint256 public minDelay;
    uint256 public maxDelay;
    uint256 public gracePeriod;

    // Transaction storage
    mapping(bytes32 => Transaction) public transactions;
    mapping(bytes32 => BatchTransaction) public batchTransactions;
    mapping(bytes32 => bool) public queuedTransactions;

    // Transaction history
    bytes32[] public transactionHashes;
    uint256 public transactionCount;

    // Emergency
    bool public paused;

    // ============ Constants ============

    uint256 public constant MIN_DELAY_FLOOR = 1 hours;
    uint256 public constant MAX_DELAY_CEILING = 30 days;
    uint256 public constant GRACE_PERIOD_DEFAULT = 14 days;

    // ============ Events ============

    event TransactionQueued(
        bytes32 indexed txHash,
        address indexed target,
        uint256 value,
        bytes data,
        uint256 eta
    );

    event BatchTransactionQueued(
        bytes32 indexed txHash,
        address[] targets,
        uint256[] values,
        uint256 eta
    );

    event TransactionExecuted(
        bytes32 indexed txHash,
        address indexed target,
        uint256 value,
        bytes data
    );

    event TransactionCancelled(bytes32 indexed txHash);
    event DelayUpdated(uint256 oldDelay, uint256 newDelay);
    event EmergencyPause(address indexed guardian);
    event EmergencyUnpause(address indexed admin);

    // ============ Modifiers ============

    modifier notPaused() {
        require(!paused, "Timelock: paused");
        _;
    }

    // ============ Constructor ============

    constructor(
        uint256 _minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) {
        require(_minDelay >= MIN_DELAY_FLOOR, "Delay too short");
        require(_minDelay <= MAX_DELAY_CEILING, "Delay too long");

        minDelay = _minDelay;
        maxDelay = MAX_DELAY_CEILING;
        gracePeriod = GRACE_PERIOD_DEFAULT;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);

        for (uint256 i = 0; i < proposers.length; i++) {
            _grantRole(PROPOSER_ROLE, proposers[i]);
            _grantRole(CANCELLER_ROLE, proposers[i]);
        }

        for (uint256 i = 0; i < executors.length; i++) {
            _grantRole(EXECUTOR_ROLE, executors[i]);
        }
    }

    // ============ Queue Functions ============

    /**
     * @notice Queue a single transaction
     */
    function queueTransaction(
        address target,
        uint256 value,
        bytes calldata data,
        string calldata description,
        uint256 delay
    ) external onlyRole(PROPOSER_ROLE) notPaused returns (bytes32) {
        require(delay >= minDelay && delay <= maxDelay, "Invalid delay");
        require(target != address(0), "Invalid target");

        uint256 eta = block.timestamp + delay;
        bytes32 txHash = keccak256(abi.encode(target, value, data, eta));

        require(!queuedTransactions[txHash], "Already queued");

        transactions[txHash] = Transaction({
            target: target,
            value: value,
            data: data,
            description: description,
            eta: eta,
            executed: false,
            cancelled: false
        });

        queuedTransactions[txHash] = true;
        transactionHashes.push(txHash);
        transactionCount++;

        emit TransactionQueued(txHash, target, value, data, eta);

        return txHash;
    }

    /**
     * @notice Queue a batch of transactions
     */
    function queueBatchTransaction(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas,
        string calldata description,
        uint256 delay
    ) external onlyRole(PROPOSER_ROLE) notPaused returns (bytes32) {
        require(targets.length == values.length && values.length == datas.length, "Length mismatch");
        require(targets.length > 0, "Empty batch");
        require(delay >= minDelay && delay <= maxDelay, "Invalid delay");

        uint256 eta = block.timestamp + delay;
        bytes32 txHash = keccak256(abi.encode(targets, values, datas, eta));

        require(!queuedTransactions[txHash], "Already queued");

        batchTransactions[txHash] = BatchTransaction({
            targets: targets,
            values: values,
            datas: datas,
            description: description,
            eta: eta,
            executed: false,
            cancelled: false
        });

        queuedTransactions[txHash] = true;
        transactionHashes.push(txHash);
        transactionCount++;

        emit BatchTransactionQueued(txHash, targets, values, eta);

        return txHash;
    }

    // ============ Execute Functions ============

    /**
     * @notice Execute a queued transaction
     */
    function executeTransaction(bytes32 txHash) 
        external 
        payable 
        onlyRole(EXECUTOR_ROLE) 
        notPaused 
        nonReentrant 
        returns (bytes memory) 
    {
        Transaction storage txn = transactions[txHash];
        
        require(queuedTransactions[txHash], "Not queued");
        require(!txn.executed, "Already executed");
        require(!txn.cancelled, "Cancelled");
        require(block.timestamp >= txn.eta, "Not ready");
        require(block.timestamp <= txn.eta + gracePeriod, "Stale transaction");

        txn.executed = true;

        (bool success, bytes memory returnData) = txn.target.call{value: txn.value}(txn.data);
        require(success, "Execution failed");

        emit TransactionExecuted(txHash, txn.target, txn.value, txn.data);

        return returnData;
    }

    /**
     * @notice Execute a queued batch transaction
     */
    function executeBatchTransaction(bytes32 txHash) 
        external 
        payable 
        onlyRole(EXECUTOR_ROLE) 
        notPaused 
        nonReentrant 
    {
        BatchTransaction storage batch = batchTransactions[txHash];
        
        require(queuedTransactions[txHash], "Not queued");
        require(!batch.executed, "Already executed");
        require(!batch.cancelled, "Cancelled");
        require(block.timestamp >= batch.eta, "Not ready");
        require(block.timestamp <= batch.eta + gracePeriod, "Stale transaction");

        batch.executed = true;

        for (uint256 i = 0; i < batch.targets.length; i++) {
            (bool success, ) = batch.targets[i].call{value: batch.values[i]}(batch.datas[i]);
            require(success, string(abi.encodePacked("Execution failed at index ", i)));

            emit TransactionExecuted(txHash, batch.targets[i], batch.values[i], batch.datas[i]);
        }
    }

    // ============ Cancel Functions ============

    /**
     * @notice Cancel a queued transaction
     */
    function cancelTransaction(bytes32 txHash) external onlyRole(CANCELLER_ROLE) {
        require(queuedTransactions[txHash], "Not queued");

        Transaction storage txn = transactions[txHash];
        if (txn.target != address(0)) {
            require(!txn.executed, "Already executed");
            txn.cancelled = true;
        } else {
            BatchTransaction storage batch = batchTransactions[txHash];
            require(!batch.executed, "Already executed");
            batch.cancelled = true;
        }

        emit TransactionCancelled(txHash);
    }

    // ============ View Functions ============

    /**
     * @notice Get transaction details
     */
    function getTransaction(bytes32 txHash) external view returns (
        address target,
        uint256 value,
        bytes memory data,
        string memory description,
        uint256 eta,
        bool executed,
        bool cancelled
    ) {
        Transaction storage txn = transactions[txHash];
        return (
            txn.target,
            txn.value,
            txn.data,
            txn.description,
            txn.eta,
            txn.executed,
            txn.cancelled
        );
    }

    /**
     * @notice Get batch transaction details
     */
    function getBatchTransaction(bytes32 txHash) external view returns (
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory datas,
        string memory description,
        uint256 eta,
        bool executed,
        bool cancelled
    ) {
        BatchTransaction storage batch = batchTransactions[txHash];
        return (
            batch.targets,
            batch.values,
            batch.datas,
            batch.description,
            batch.eta,
            batch.executed,
            batch.cancelled
        );
    }

    /**
     * @notice Check if transaction is ready for execution
     */
    function isReady(bytes32 txHash) external view returns (bool) {
        if (!queuedTransactions[txHash]) return false;

        Transaction storage txn = transactions[txHash];
        if (txn.target != address(0)) {
            return !txn.executed && !txn.cancelled && 
                   block.timestamp >= txn.eta && 
                   block.timestamp <= txn.eta + gracePeriod;
        }

        BatchTransaction storage batch = batchTransactions[txHash];
        return !batch.executed && !batch.cancelled && 
               block.timestamp >= batch.eta && 
               block.timestamp <= batch.eta + gracePeriod;
    }

    /**
     * @notice Get time until transaction is ready
     */
    function getTimeUntilReady(bytes32 txHash) external view returns (uint256) {
        Transaction storage txn = transactions[txHash];
        uint256 eta = txn.target != address(0) ? txn.eta : batchTransactions[txHash].eta;
        
        if (block.timestamp >= eta) return 0;
        return eta - block.timestamp;
    }

    /**
     * @notice Get pending transactions
     */
    function getPendingTransactions() external view returns (bytes32[] memory) {
        uint256 count = 0;
        
        // Count pending
        for (uint256 i = 0; i < transactionHashes.length; i++) {
            bytes32 txHash = transactionHashes[i];
            Transaction storage txn = transactions[txHash];
            BatchTransaction storage batch = batchTransactions[txHash];
            
            bool isPending = (txn.target != address(0) && !txn.executed && !txn.cancelled) ||
                            (batch.targets.length > 0 && !batch.executed && !batch.cancelled);
            if (isPending) count++;
        }

        // Build array
        bytes32[] memory pending = new bytes32[](count);
        uint256 index = 0;
        
        for (uint256 i = 0; i < transactionHashes.length; i++) {
            bytes32 txHash = transactionHashes[i];
            Transaction storage txn = transactions[txHash];
            BatchTransaction storage batch = batchTransactions[txHash];
            
            bool isPending = (txn.target != address(0) && !txn.executed && !txn.cancelled) ||
                            (batch.targets.length > 0 && !batch.executed && !batch.cancelled);
            if (isPending) {
                pending[index++] = txHash;
            }
        }

        return pending;
    }

    // ============ Admin Functions ============

    /**
     * @notice Update minimum delay (requires timelock)
     */
    function setMinDelay(uint256 newDelay) external {
        require(msg.sender == address(this), "Only timelock");
        require(newDelay >= MIN_DELAY_FLOOR && newDelay <= maxDelay, "Invalid delay");
        
        emit DelayUpdated(minDelay, newDelay);
        minDelay = newDelay;
    }

    /**
     * @notice Update grace period (requires timelock)
     */
    function setGracePeriod(uint256 newPeriod) external {
        require(msg.sender == address(this), "Only timelock");
        require(newPeriod >= 1 days && newPeriod <= 30 days, "Invalid period");
        gracePeriod = newPeriod;
    }

    /**
     * @notice Emergency pause (guardian only)
     */
    function emergencyPause() external onlyRole(GUARDIAN_ROLE) {
        paused = true;
        emit EmergencyPause(msg.sender);
    }

    /**
     * @notice Unpause (admin only)
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = false;
        emit EmergencyUnpause(msg.sender);
    }

    /**
     * @notice Receive ETH for transaction execution
     */
    receive() external payable {}
}
