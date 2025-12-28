// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SynapseMultiSig
 * @notice Multi-signature wallet for team and treasury management
 * @dev Supports ETH and ERC20 transfers with configurable threshold
 */
contract SynapseMultiSig is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Structs ============

    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        string description;
        bool executed;
        uint256 confirmations;
        uint256 createdAt;
    }

    struct Owner {
        address addr;
        bool isOwner;
        uint256 addedAt;
    }

    // ============ State Variables ============

    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public threshold;

    Transaction[] public transactions;
    mapping(uint256 => mapping(address => bool)) public confirmations;

    // Daily limits
    mapping(address => uint256) public dailySpent;      // token => amount spent today
    mapping(address => uint256) public dailyLimit;      // token => daily limit
    mapping(address => uint256) public lastSpendDay;    // token => last spend day
    
    // Statistics
    uint256 public totalExecuted;
    uint256 public totalValue;

    // ============ Constants ============

    uint256 public constant MAX_OWNERS = 50;
    uint256 public constant MIN_THRESHOLD = 1;
    address public constant ETH_ADDRESS = address(0);

    // ============ Events ============

    event Deposit(address indexed sender, uint256 value);
    event TransactionSubmitted(uint256 indexed txId, address indexed submitter, address to, uint256 value);
    event TransactionConfirmed(uint256 indexed txId, address indexed owner);
    event ConfirmationRevoked(uint256 indexed txId, address indexed owner);
    event TransactionExecuted(uint256 indexed txId, address indexed executor);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event ThresholdChanged(uint256 oldThreshold, uint256 newThreshold);
    event DailyLimitSet(address indexed token, uint256 limit);

    // ============ Modifiers ============

    modifier onlyOwner() {
        require(isOwner[msg.sender], "Not an owner");
        _;
    }

    modifier onlyWallet() {
        require(msg.sender == address(this), "Only wallet");
        _;
    }

    modifier txExists(uint256 txId) {
        require(txId < transactions.length, "Transaction does not exist");
        _;
    }

    modifier notExecuted(uint256 txId) {
        require(!transactions[txId].executed, "Already executed");
        _;
    }

    modifier notConfirmed(uint256 txId) {
        require(!confirmations[txId][msg.sender], "Already confirmed");
        _;
    }

    // ============ Constructor ============

    constructor(address[] memory _owners, uint256 _threshold) {
        require(_owners.length > 0, "Owners required");
        require(_owners.length <= MAX_OWNERS, "Too many owners");
        require(_threshold >= MIN_THRESHOLD && _threshold <= _owners.length, "Invalid threshold");

        for (uint256 i = 0; i < _owners.length; i++) {
            address owner = _owners[i];
            require(owner != address(0), "Invalid owner");
            require(!isOwner[owner], "Duplicate owner");

            isOwner[owner] = true;
            owners.push(owner);
        }

        threshold = _threshold;

        // Set default daily limit for ETH (100 ETH)
        dailyLimit[ETH_ADDRESS] = 100 ether;
    }

    // ============ Submit & Confirm ============

    /**
     * @notice Submit a new transaction
     */
    function submitTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        string calldata description
    ) external onlyOwner returns (uint256) {
        require(to != address(0), "Invalid recipient");

        uint256 txId = transactions.length;

        transactions.push(Transaction({
            to: to,
            value: value,
            data: data,
            description: description,
            executed: false,
            confirmations: 0,
            createdAt: block.timestamp
        }));

        emit TransactionSubmitted(txId, msg.sender, to, value);

        // Auto-confirm by submitter
        _confirm(txId);

        return txId;
    }

    /**
     * @notice Confirm a transaction
     */
    function confirmTransaction(uint256 txId) 
        external 
        onlyOwner 
        txExists(txId) 
        notExecuted(txId) 
        notConfirmed(txId) 
    {
        _confirm(txId);
    }

    function _confirm(uint256 txId) internal {
        confirmations[txId][msg.sender] = true;
        transactions[txId].confirmations++;

        emit TransactionConfirmed(txId, msg.sender);

        // Auto-execute if threshold reached
        if (transactions[txId].confirmations >= threshold) {
            _execute(txId);
        }
    }

    /**
     * @notice Revoke confirmation
     */
    function revokeConfirmation(uint256 txId) 
        external 
        onlyOwner 
        txExists(txId) 
        notExecuted(txId) 
    {
        require(confirmations[txId][msg.sender], "Not confirmed");

        confirmations[txId][msg.sender] = false;
        transactions[txId].confirmations--;

        emit ConfirmationRevoked(txId, msg.sender);
    }

    // ============ Execute ============

    /**
     * @notice Execute a confirmed transaction
     */
    function executeTransaction(uint256 txId) 
        external 
        onlyOwner 
        txExists(txId) 
        notExecuted(txId) 
        nonReentrant 
    {
        require(transactions[txId].confirmations >= threshold, "Not enough confirmations");
        _execute(txId);
    }

    function _execute(uint256 txId) internal {
        Transaction storage txn = transactions[txId];
        
        // Check daily limit for ETH transfers
        if (txn.data.length == 0 && txn.value > 0) {
            _checkDailyLimit(ETH_ADDRESS, txn.value);
        }

        txn.executed = true;
        totalExecuted++;
        totalValue += txn.value;

        (bool success, ) = txn.to.call{value: txn.value}(txn.data);
        require(success, "Execution failed");

        emit TransactionExecuted(txId, msg.sender);
    }

    // ============ Quick Actions ============

    /**
     * @notice Quick transfer ETH (within daily limit, single signature)
     */
    function quickTransferETH(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Invalid recipient");
        require(amount <= dailyLimit[ETH_ADDRESS], "Exceeds single transfer limit");
        
        _checkDailyLimit(ETH_ADDRESS, amount);

        (bool success, ) = to.call{value: amount}("");
        require(success, "Transfer failed");
    }

    /**
     * @notice Quick transfer ERC20 (within daily limit, single signature)
     */
    function quickTransferToken(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(to != address(0), "Invalid recipient");
        require(dailyLimit[token] > 0, "No daily limit set");
        require(amount <= dailyLimit[token], "Exceeds single transfer limit");

        _checkDailyLimit(token, amount);

        IERC20(token).safeTransfer(to, amount);
    }

    function _checkDailyLimit(address token, uint256 amount) internal {
        uint256 today = block.timestamp / 1 days;
        
        if (lastSpendDay[token] != today) {
            dailySpent[token] = 0;
            lastSpendDay[token] = today;
        }

        require(dailySpent[token] + amount <= dailyLimit[token], "Daily limit exceeded");
        dailySpent[token] += amount;
    }

    // ============ Owner Management ============

    /**
     * @notice Add a new owner (requires multi-sig)
     */
    function addOwner(address owner) external onlyWallet {
        require(owner != address(0), "Invalid owner");
        require(!isOwner[owner], "Already an owner");
        require(owners.length < MAX_OWNERS, "Max owners reached");

        isOwner[owner] = true;
        owners.push(owner);

        emit OwnerAdded(owner);
    }

    /**
     * @notice Remove an owner (requires multi-sig)
     */
    function removeOwner(address owner) external onlyWallet {
        require(isOwner[owner], "Not an owner");
        require(owners.length > threshold, "Would break threshold");

        isOwner[owner] = false;

        // Remove from array
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == owner) {
                owners[i] = owners[owners.length - 1];
                owners.pop();
                break;
            }
        }

        emit OwnerRemoved(owner);
    }

    /**
     * @notice Replace an owner (requires multi-sig)
     */
    function replaceOwner(address oldOwner, address newOwner) external onlyWallet {
        require(isOwner[oldOwner], "Not an owner");
        require(!isOwner[newOwner], "Already an owner");
        require(newOwner != address(0), "Invalid owner");

        isOwner[oldOwner] = false;
        isOwner[newOwner] = true;

        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == oldOwner) {
                owners[i] = newOwner;
                break;
            }
        }

        emit OwnerRemoved(oldOwner);
        emit OwnerAdded(newOwner);
    }

    /**
     * @notice Change threshold (requires multi-sig)
     */
    function changeThreshold(uint256 newThreshold) external onlyWallet {
        require(newThreshold >= MIN_THRESHOLD && newThreshold <= owners.length, "Invalid threshold");
        
        emit ThresholdChanged(threshold, newThreshold);
        threshold = newThreshold;
    }

    /**
     * @notice Set daily limit for token (requires multi-sig)
     */
    function setDailyLimit(address token, uint256 limit) external onlyWallet {
        dailyLimit[token] = limit;
        emit DailyLimitSet(token, limit);
    }

    // ============ View Functions ============

    /**
     * @notice Get owners list
     */
    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    /**
     * @notice Get owner count
     */
    function getOwnerCount() external view returns (uint256) {
        return owners.length;
    }

    /**
     * @notice Get transaction count
     */
    function getTransactionCount() external view returns (uint256) {
        return transactions.length;
    }

    /**
     * @notice Get transaction details
     */
    function getTransaction(uint256 txId) external view returns (
        address to,
        uint256 value,
        bytes memory data,
        string memory description,
        bool executed,
        uint256 numConfirmations,
        uint256 createdAt
    ) {
        Transaction storage txn = transactions[txId];
        return (
            txn.to,
            txn.value,
            txn.data,
            txn.description,
            txn.executed,
            txn.confirmations,
            txn.createdAt
        );
    }

    /**
     * @notice Check if owner has confirmed transaction
     */
    function isConfirmed(uint256 txId, address owner) external view returns (bool) {
        return confirmations[txId][owner];
    }

    /**
     * @notice Get confirmations for transaction
     */
    function getConfirmations(uint256 txId) external view returns (address[] memory) {
        uint256 count = transactions[txId].confirmations;
        address[] memory confirmed = new address[](count);
        uint256 index = 0;

        for (uint256 i = 0; i < owners.length && index < count; i++) {
            if (confirmations[txId][owners[i]]) {
                confirmed[index++] = owners[i];
            }
        }

        return confirmed;
    }

    /**
     * @notice Get pending transactions
     */
    function getPendingTransactions() external view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < transactions.length; i++) {
            if (!transactions[i].executed) count++;
        }

        uint256[] memory pending = new uint256[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < transactions.length; i++) {
            if (!transactions[i].executed) {
                pending[index++] = i;
            }
        }

        return pending;
    }

    /**
     * @notice Get remaining daily limit
     */
    function getRemainingDailyLimit(address token) external view returns (uint256) {
        uint256 today = block.timestamp / 1 days;
        
        if (lastSpendDay[token] != today) {
            return dailyLimit[token];
        }

        if (dailySpent[token] >= dailyLimit[token]) {
            return 0;
        }

        return dailyLimit[token] - dailySpent[token];
    }

    /**
     * @notice Get wallet stats
     */
    function getStats() external view returns (
        uint256 ownerCount,
        uint256 txCount,
        uint256 executed,
        uint256 pending,
        uint256 ethBalance
    ) {
        uint256 pendingCount = 0;
        for (uint256 i = 0; i < transactions.length; i++) {
            if (!transactions[i].executed) pendingCount++;
        }

        return (
            owners.length,
            transactions.length,
            totalExecuted,
            pendingCount,
            address(this).balance
        );
    }

    // ============ Receive ============

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }
}
