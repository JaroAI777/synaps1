// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapseTreasury
 * @notice Multi-signature treasury for protocol funds management
 * @dev Supports time-locked transactions, spending limits, and role-based access
 */
contract SynapseTreasury is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Structs ============
    
    struct Transaction {
        address target;
        uint256 value;
        bytes data;
        string description;
        uint256 proposedAt;
        uint256 executedAt;
        uint256 confirmations;
        bool executed;
        bool cancelled;
        TransactionType txType;
    }

    struct Signer {
        bool isActive;
        uint256 addedAt;
        uint256 lastActiveAt;
        string name;
    }

    struct SpendingLimit {
        uint256 dailyLimit;
        uint256 monthlyLimit;
        uint256 dailySpent;
        uint256 monthlySpent;
        uint256 lastDailyReset;
        uint256 lastMonthlyReset;
    }

    struct Budget {
        string name;
        address manager;
        uint256 allocated;
        uint256 spent;
        uint256 expiresAt;
        bool active;
    }

    // ============ Enums ============
    
    enum TransactionType {
        TRANSFER,           // Token transfer
        ETH_TRANSFER,       // ETH transfer
        CONTRACT_CALL,      // Arbitrary contract call
        ADD_SIGNER,         // Add new signer
        REMOVE_SIGNER,      // Remove signer
        CHANGE_THRESHOLD,   // Change confirmation threshold
        UPDATE_TIMELOCK,    // Update timelock duration
        UPDATE_LIMITS,      // Update spending limits
        EMERGENCY           // Emergency actions
    }

    // ============ State Variables ============
    
    // Signers
    mapping(address => Signer) public signers;
    address[] public signerList;
    uint256 public signerCount;
    uint256 public confirmationsRequired;
    
    // Transactions
    mapping(uint256 => Transaction) public transactions;
    mapping(uint256 => mapping(address => bool)) public confirmations;
    uint256 public transactionCount;
    
    // Timelock
    uint256 public timelockDuration;
    uint256 public constant MIN_TIMELOCK = 1 hours;
    uint256 public constant MAX_TIMELOCK = 7 days;
    
    // Spending limits
    mapping(address => SpendingLimit) public tokenLimits;
    SpendingLimit public ethLimits;
    
    // Budgets
    mapping(bytes32 => Budget) public budgets;
    bytes32[] public budgetIds;
    
    // Emergency
    address public emergencyAdmin;
    bool public emergencyMode;
    uint256 public emergencyModeActivatedAt;
    uint256 public constant EMERGENCY_DURATION = 24 hours;
    
    // ============ Events ============
    
    event SignerAdded(address indexed signer, string name);
    event SignerRemoved(address indexed signer);
    event TransactionProposed(
        uint256 indexed txId,
        address indexed proposer,
        address target,
        uint256 value,
        TransactionType txType,
        string description
    );
    event TransactionConfirmed(uint256 indexed txId, address indexed signer);
    event ConfirmationRevoked(uint256 indexed txId, address indexed signer);
    event TransactionExecuted(uint256 indexed txId, address indexed executor);
    event TransactionCancelled(uint256 indexed txId);
    event ThresholdChanged(uint256 oldThreshold, uint256 newThreshold);
    event TimelockChanged(uint256 oldDuration, uint256 newDuration);
    event SpendingLimitUpdated(address indexed token, uint256 daily, uint256 monthly);
    event BudgetCreated(bytes32 indexed budgetId, string name, uint256 allocated);
    event BudgetSpent(bytes32 indexed budgetId, uint256 amount, uint256 remaining);
    event EmergencyModeActivated(address indexed activator);
    event EmergencyModeDeactivated();
    event EmergencyWithdrawal(address indexed token, address indexed to, uint256 amount);

    // ============ Modifiers ============
    
    modifier onlySigner() {
        require(signers[msg.sender].isActive, "Not a signer");
        _;
    }

    modifier onlyTreasury() {
        require(msg.sender == address(this), "Only treasury");
        _;
    }

    modifier txExists(uint256 txId) {
        require(txId < transactionCount, "Transaction does not exist");
        _;
    }

    modifier notExecuted(uint256 txId) {
        require(!transactions[txId].executed, "Already executed");
        _;
    }

    modifier notCancelled(uint256 txId) {
        require(!transactions[txId].cancelled, "Transaction cancelled");
        _;
    }

    modifier notInEmergency() {
        require(!emergencyMode, "Emergency mode active");
        _;
    }

    // ============ Constructor ============
    
    constructor(
        address[] memory _signers,
        string[] memory _signerNames,
        uint256 _confirmationsRequired,
        uint256 _timelockDuration,
        address _emergencyAdmin
    ) {
        require(_signers.length >= 3, "Need at least 3 signers");
        require(_signers.length == _signerNames.length, "Names length mismatch");
        require(
            _confirmationsRequired >= 2 && _confirmationsRequired <= _signers.length,
            "Invalid threshold"
        );
        require(
            _timelockDuration >= MIN_TIMELOCK && _timelockDuration <= MAX_TIMELOCK,
            "Invalid timelock"
        );
        require(_emergencyAdmin != address(0), "Invalid emergency admin");

        for (uint256 i = 0; i < _signers.length; i++) {
            address signer = _signers[i];
            require(signer != address(0), "Invalid signer");
            require(!signers[signer].isActive, "Duplicate signer");

            signers[signer] = Signer({
                isActive: true,
                addedAt: block.timestamp,
                lastActiveAt: block.timestamp,
                name: _signerNames[i]
            });
            signerList.push(signer);
            
            emit SignerAdded(signer, _signerNames[i]);
        }

        signerCount = _signers.length;
        confirmationsRequired = _confirmationsRequired;
        timelockDuration = _timelockDuration;
        emergencyAdmin = _emergencyAdmin;
    }

    // ============ Receive ETH ============
    
    receive() external payable {}

    // ============ Transaction Proposal ============
    
    /**
     * @notice Propose a new transaction
     */
    function proposeTransaction(
        address target,
        uint256 value,
        bytes calldata data,
        TransactionType txType,
        string calldata description
    ) external onlySigner notInEmergency returns (uint256 txId) {
        require(target != address(0), "Invalid target");

        txId = transactionCount++;
        
        transactions[txId] = Transaction({
            target: target,
            value: value,
            data: data,
            description: description,
            proposedAt: block.timestamp,
            executedAt: 0,
            confirmations: 1,
            executed: false,
            cancelled: false,
            txType: txType
        });

        confirmations[txId][msg.sender] = true;
        signers[msg.sender].lastActiveAt = block.timestamp;

        emit TransactionProposed(txId, msg.sender, target, value, txType, description);
        emit TransactionConfirmed(txId, msg.sender);
    }

    /**
     * @notice Propose token transfer
     */
    function proposeTransfer(
        address token,
        address to,
        uint256 amount,
        string calldata description
    ) external onlySigner notInEmergency returns (uint256 txId) {
        bytes memory data = abi.encodeWithSelector(
            IERC20.transfer.selector,
            to,
            amount
        );
        
        return this.proposeTransaction(
            token,
            0,
            data,
            TransactionType.TRANSFER,
            description
        );
    }

    /**
     * @notice Propose ETH transfer
     */
    function proposeEthTransfer(
        address payable to,
        uint256 amount,
        string calldata description
    ) external onlySigner notInEmergency returns (uint256 txId) {
        return this.proposeTransaction(
            to,
            amount,
            "",
            TransactionType.ETH_TRANSFER,
            description
        );
    }

    // ============ Confirmation ============
    
    /**
     * @notice Confirm a transaction
     */
    function confirmTransaction(uint256 txId) 
        external 
        onlySigner 
        txExists(txId) 
        notExecuted(txId) 
        notCancelled(txId)
        notInEmergency
    {
        require(!confirmations[txId][msg.sender], "Already confirmed");

        confirmations[txId][msg.sender] = true;
        transactions[txId].confirmations++;
        signers[msg.sender].lastActiveAt = block.timestamp;

        emit TransactionConfirmed(txId, msg.sender);
    }

    /**
     * @notice Revoke confirmation
     */
    function revokeConfirmation(uint256 txId)
        external
        onlySigner
        txExists(txId)
        notExecuted(txId)
        notCancelled(txId)
    {
        require(confirmations[txId][msg.sender], "Not confirmed");

        confirmations[txId][msg.sender] = false;
        transactions[txId].confirmations--;

        emit ConfirmationRevoked(txId, msg.sender);
    }

    // ============ Execution ============
    
    /**
     * @notice Execute a confirmed transaction
     */
    function executeTransaction(uint256 txId)
        external
        onlySigner
        txExists(txId)
        notExecuted(txId)
        notCancelled(txId)
        notInEmergency
        nonReentrant
    {
        Transaction storage tx_ = transactions[txId];
        
        require(tx_.confirmations >= confirmationsRequired, "Not enough confirmations");
        require(
            block.timestamp >= tx_.proposedAt + timelockDuration,
            "Timelock not passed"
        );

        // Check spending limits for transfers
        if (tx_.txType == TransactionType.TRANSFER) {
            _checkAndUpdateTokenLimit(tx_.target, tx_.value);
        } else if (tx_.txType == TransactionType.ETH_TRANSFER) {
            _checkAndUpdateEthLimit(tx_.value);
        }

        tx_.executed = true;
        tx_.executedAt = block.timestamp;

        (bool success, ) = tx_.target.call{value: tx_.value}(tx_.data);
        require(success, "Transaction failed");

        emit TransactionExecuted(txId, msg.sender);
    }

    /**
     * @notice Cancel a pending transaction
     */
    function cancelTransaction(uint256 txId)
        external
        onlySigner
        txExists(txId)
        notExecuted(txId)
        notCancelled(txId)
    {
        // Need majority to cancel
        uint256 cancelVotes = 0;
        for (uint256 i = 0; i < signerList.length; i++) {
            if (confirmations[txId][signerList[i]]) {
                cancelVotes++;
            }
        }
        
        // If less than threshold confirmed, proposer can cancel
        // Otherwise need majority to cancel
        Transaction storage tx_ = transactions[txId];
        if (tx_.confirmations >= confirmationsRequired) {
            require(cancelVotes > signerCount / 2, "Need majority to cancel");
        }

        tx_.cancelled = true;
        emit TransactionCancelled(txId);
    }

    // ============ Spending Limits ============
    
    /**
     * @dev Check and update token spending limit
     */
    function _checkAndUpdateTokenLimit(address token, uint256 amount) internal {
        SpendingLimit storage limit = tokenLimits[token];
        
        // Reset daily if new day
        if (block.timestamp >= limit.lastDailyReset + 1 days) {
            limit.dailySpent = 0;
            limit.lastDailyReset = block.timestamp;
        }
        
        // Reset monthly if new month
        if (block.timestamp >= limit.lastMonthlyReset + 30 days) {
            limit.monthlySpent = 0;
            limit.lastMonthlyReset = block.timestamp;
        }

        // Check limits (0 means no limit)
        if (limit.dailyLimit > 0) {
            require(limit.dailySpent + amount <= limit.dailyLimit, "Daily limit exceeded");
        }
        if (limit.monthlyLimit > 0) {
            require(limit.monthlySpent + amount <= limit.monthlyLimit, "Monthly limit exceeded");
        }

        limit.dailySpent += amount;
        limit.monthlySpent += amount;
    }

    /**
     * @dev Check and update ETH spending limit
     */
    function _checkAndUpdateEthLimit(uint256 amount) internal {
        if (block.timestamp >= ethLimits.lastDailyReset + 1 days) {
            ethLimits.dailySpent = 0;
            ethLimits.lastDailyReset = block.timestamp;
        }
        
        if (block.timestamp >= ethLimits.lastMonthlyReset + 30 days) {
            ethLimits.monthlySpent = 0;
            ethLimits.lastMonthlyReset = block.timestamp;
        }

        if (ethLimits.dailyLimit > 0) {
            require(ethLimits.dailySpent + amount <= ethLimits.dailyLimit, "Daily ETH limit exceeded");
        }
        if (ethLimits.monthlyLimit > 0) {
            require(ethLimits.monthlySpent + amount <= ethLimits.monthlyLimit, "Monthly ETH limit exceeded");
        }

        ethLimits.dailySpent += amount;
        ethLimits.monthlySpent += amount;
    }

    /**
     * @notice Set spending limits for a token (via multisig)
     */
    function setTokenLimits(
        address token,
        uint256 dailyLimit,
        uint256 monthlyLimit
    ) external onlyTreasury {
        tokenLimits[token] = SpendingLimit({
            dailyLimit: dailyLimit,
            monthlyLimit: monthlyLimit,
            dailySpent: 0,
            monthlySpent: 0,
            lastDailyReset: block.timestamp,
            lastMonthlyReset: block.timestamp
        });

        emit SpendingLimitUpdated(token, dailyLimit, monthlyLimit);
    }

    /**
     * @notice Set ETH spending limits (via multisig)
     */
    function setEthLimits(
        uint256 dailyLimit,
        uint256 monthlyLimit
    ) external onlyTreasury {
        ethLimits = SpendingLimit({
            dailyLimit: dailyLimit,
            monthlyLimit: monthlyLimit,
            dailySpent: 0,
            monthlySpent: 0,
            lastDailyReset: block.timestamp,
            lastMonthlyReset: block.timestamp
        });

        emit SpendingLimitUpdated(address(0), dailyLimit, monthlyLimit);
    }

    // ============ Budget Management ============
    
    /**
     * @notice Create a budget (via multisig)
     */
    function createBudget(
        string calldata name,
        address manager,
        uint256 allocated,
        uint256 duration
    ) external onlyTreasury returns (bytes32 budgetId) {
        budgetId = keccak256(abi.encodePacked(name, manager, block.timestamp));
        
        budgets[budgetId] = Budget({
            name: name,
            manager: manager,
            allocated: allocated,
            spent: 0,
            expiresAt: block.timestamp + duration,
            active: true
        });

        budgetIds.push(budgetId);
        emit BudgetCreated(budgetId, name, allocated);
    }

    /**
     * @notice Spend from budget (manager only)
     */
    function spendFromBudget(
        bytes32 budgetId,
        address token,
        address to,
        uint256 amount
    ) external nonReentrant {
        Budget storage budget = budgets[budgetId];
        
        require(budget.active, "Budget not active");
        require(msg.sender == budget.manager, "Not budget manager");
        require(block.timestamp < budget.expiresAt, "Budget expired");
        require(budget.spent + amount <= budget.allocated, "Exceeds budget");

        budget.spent += amount;
        IERC20(token).safeTransfer(to, amount);

        emit BudgetSpent(budgetId, amount, budget.allocated - budget.spent);
    }

    // ============ Signer Management ============
    
    /**
     * @notice Add a new signer (via multisig)
     */
    function addSigner(address signer, string calldata name) external onlyTreasury {
        require(signer != address(0), "Invalid signer");
        require(!signers[signer].isActive, "Already a signer");

        signers[signer] = Signer({
            isActive: true,
            addedAt: block.timestamp,
            lastActiveAt: block.timestamp,
            name: name
        });
        signerList.push(signer);
        signerCount++;

        emit SignerAdded(signer, name);
    }

    /**
     * @notice Remove a signer (via multisig)
     */
    function removeSigner(address signer) external onlyTreasury {
        require(signers[signer].isActive, "Not a signer");
        require(signerCount - 1 >= confirmationsRequired, "Cannot go below threshold");
        require(signerCount - 1 >= 3, "Need at least 3 signers");

        signers[signer].isActive = false;
        signerCount--;

        // Remove from list
        for (uint256 i = 0; i < signerList.length; i++) {
            if (signerList[i] == signer) {
                signerList[i] = signerList[signerList.length - 1];
                signerList.pop();
                break;
            }
        }

        emit SignerRemoved(signer);
    }

    /**
     * @notice Change confirmation threshold (via multisig)
     */
    function changeThreshold(uint256 newThreshold) external onlyTreasury {
        require(newThreshold >= 2, "Threshold too low");
        require(newThreshold <= signerCount, "Threshold too high");

        uint256 oldThreshold = confirmationsRequired;
        confirmationsRequired = newThreshold;

        emit ThresholdChanged(oldThreshold, newThreshold);
    }

    /**
     * @notice Change timelock duration (via multisig)
     */
    function changeTimelock(uint256 newDuration) external onlyTreasury {
        require(newDuration >= MIN_TIMELOCK && newDuration <= MAX_TIMELOCK, "Invalid duration");

        uint256 oldDuration = timelockDuration;
        timelockDuration = newDuration;

        emit TimelockChanged(oldDuration, newDuration);
    }

    // ============ Emergency Functions ============
    
    /**
     * @notice Activate emergency mode
     */
    function activateEmergencyMode() external {
        require(msg.sender == emergencyAdmin, "Not emergency admin");
        require(!emergencyMode, "Already in emergency mode");

        emergencyMode = true;
        emergencyModeActivatedAt = block.timestamp;
        _pause();

        emit EmergencyModeActivated(msg.sender);
    }

    /**
     * @notice Deactivate emergency mode (requires multisig)
     */
    function deactivateEmergencyMode() external onlyTreasury {
        require(emergencyMode, "Not in emergency mode");

        emergencyMode = false;
        emergencyModeActivatedAt = 0;
        _unpause();

        emit EmergencyModeDeactivated();
    }

    /**
     * @notice Emergency withdrawal (only during emergency, with signer approval)
     */
    function emergencyWithdraw(
        address token,
        address to,
        uint256 amount
    ) external onlySigner {
        require(emergencyMode, "Not in emergency mode");
        require(
            block.timestamp <= emergencyModeActivatedAt + EMERGENCY_DURATION,
            "Emergency period expired"
        );

        if (token == address(0)) {
            payable(to).transfer(amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }

        emit EmergencyWithdrawal(token, to, amount);
    }

    // ============ View Functions ============
    
    /**
     * @notice Get transaction details
     */
    function getTransaction(uint256 txId) external view returns (
        address target,
        uint256 value,
        bytes memory data,
        string memory description,
        uint256 proposedAt,
        uint256 executedAt,
        uint256 numConfirmations,
        bool executed,
        bool cancelled,
        TransactionType txType
    ) {
        Transaction storage tx_ = transactions[txId];
        return (
            tx_.target,
            tx_.value,
            tx_.data,
            tx_.description,
            tx_.proposedAt,
            tx_.executedAt,
            tx_.confirmations,
            tx_.executed,
            tx_.cancelled,
            tx_.txType
        );
    }

    /**
     * @notice Check if signer has confirmed
     */
    function hasConfirmed(uint256 txId, address signer) external view returns (bool) {
        return confirmations[txId][signer];
    }

    /**
     * @notice Get all signers
     */
    function getSigners() external view returns (address[] memory) {
        return signerList;
    }

    /**
     * @notice Get pending transactions
     */
    function getPendingTransactions() external view returns (uint256[] memory) {
        uint256 pendingCount = 0;
        
        // Count pending
        for (uint256 i = 0; i < transactionCount; i++) {
            if (!transactions[i].executed && !transactions[i].cancelled) {
                pendingCount++;
            }
        }

        // Collect pending
        uint256[] memory pending = new uint256[](pendingCount);
        uint256 index = 0;
        for (uint256 i = 0; i < transactionCount; i++) {
            if (!transactions[i].executed && !transactions[i].cancelled) {
                pending[index++] = i;
            }
        }

        return pending;
    }

    /**
     * @notice Get treasury balances
     */
    function getBalances(address[] calldata tokens) external view returns (uint256[] memory) {
        uint256[] memory balances = new uint256[](tokens.length + 1);
        
        // ETH balance
        balances[0] = address(this).balance;
        
        // Token balances
        for (uint256 i = 0; i < tokens.length; i++) {
            balances[i + 1] = IERC20(tokens[i]).balanceOf(address(this));
        }

        return balances;
    }

    /**
     * @notice Can transaction be executed?
     */
    function canExecute(uint256 txId) external view returns (bool, string memory) {
        if (txId >= transactionCount) return (false, "Does not exist");
        
        Transaction storage tx_ = transactions[txId];
        
        if (tx_.executed) return (false, "Already executed");
        if (tx_.cancelled) return (false, "Cancelled");
        if (tx_.confirmations < confirmationsRequired) return (false, "Not enough confirmations");
        if (block.timestamp < tx_.proposedAt + timelockDuration) return (false, "Timelock active");
        if (emergencyMode) return (false, "Emergency mode");
        
        return (true, "Ready");
    }
}
