// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title IFlashLoanReceiver
 * @notice Interface that flash loan receivers must implement
 */
interface IFlashLoanReceiver {
    function executeOperation(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata fees,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/**
 * @title SynapseFlashLoan
 * @notice Flash loan provider for SYNAPSE Protocol
 * @dev Provides uncollateralized loans that must be repaid within the same transaction
 */
contract SynapseFlashLoan is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Structs ============

    struct FlashLoanInfo {
        address token;
        uint256 maxAmount;
        uint256 fee;           // In basis points
        uint256 totalBorrowed;
        uint256 totalFees;
        bool isActive;
    }

    struct LoanExecution {
        address borrower;
        address[] tokens;
        uint256[] amounts;
        uint256[] fees;
        uint256 timestamp;
        bool successful;
    }

    // ============ Constants ============

    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MAX_FEE = 100; // 1% max fee

    // ============ State Variables ============

    mapping(address => FlashLoanInfo) public flashLoanInfo;
    address[] public supportedTokens;
    
    // Execution tracking
    mapping(bytes32 => LoanExecution) public executions;
    uint256 public executionCount;
    
    // Premium distribution
    address public feeRecipient;
    uint256 public protocolFeeShare = 5000; // 50% to protocol
    
    // Liquidity providers
    mapping(address => mapping(address => uint256)) public liquidityProvided;
    mapping(address => uint256) public totalLiquidity;

    // ============ Events ============

    event FlashLoan(
        address indexed borrower,
        address indexed token,
        uint256 amount,
        uint256 fee,
        bytes32 indexed executionId
    );
    
    event FlashLoanMulti(
        address indexed borrower,
        bytes32 indexed executionId,
        uint256 tokenCount
    );
    
    event LiquidityAdded(
        address indexed provider,
        address indexed token,
        uint256 amount
    );
    
    event LiquidityRemoved(
        address indexed provider,
        address indexed token,
        uint256 amount
    );
    
    event TokenConfigured(
        address indexed token,
        uint256 maxAmount,
        uint256 fee,
        bool isActive
    );
    
    event FeesCollected(
        address indexed token,
        uint256 amount,
        address recipient
    );

    // ============ Constructor ============

    constructor(address _feeRecipient) Ownable(msg.sender) {
        feeRecipient = _feeRecipient;
    }

    // ============ Flash Loan Functions ============

    /**
     * @notice Execute a flash loan for a single token
     * @param token The token to borrow
     * @param amount The amount to borrow
     * @param receiver The contract that will receive the loan
     * @param params Additional parameters to pass to receiver
     */
    function flashLoan(
        address token,
        uint256 amount,
        address receiver,
        bytes calldata params
    ) external nonReentrant whenNotPaused {
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = token;
        amounts[0] = amount;
        
        _executeFlashLoan(tokens, amounts, receiver, params);
    }

    /**
     * @notice Execute a flash loan for multiple tokens
     * @param tokens Array of tokens to borrow
     * @param amounts Array of amounts to borrow
     * @param receiver The contract that will receive the loan
     * @param params Additional parameters to pass to receiver
     */
    function flashLoanMulti(
        address[] calldata tokens,
        uint256[] calldata amounts,
        address receiver,
        bytes calldata params
    ) external nonReentrant whenNotPaused {
        require(tokens.length == amounts.length, "Length mismatch");
        require(tokens.length > 0, "Empty arrays");
        
        _executeFlashLoan(tokens, amounts, receiver, params);
    }

    /**
     * @dev Internal flash loan execution
     */
    function _executeFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        address receiver,
        bytes calldata params
    ) internal {
        uint256[] memory fees = new uint256[](tokens.length);
        uint256[] memory balancesBefore = new uint256[](tokens.length);

        // Validate and calculate fees
        for (uint256 i = 0; i < tokens.length; i++) {
            FlashLoanInfo storage info = flashLoanInfo[tokens[i]];
            
            require(info.isActive, "Token not supported");
            require(amounts[i] > 0, "Amount must be > 0");
            require(amounts[i] <= getAvailableLiquidity(tokens[i]), "Insufficient liquidity");
            
            if (info.maxAmount > 0) {
                require(amounts[i] <= info.maxAmount, "Exceeds max amount");
            }

            fees[i] = (amounts[i] * info.fee) / BASIS_POINTS;
            balancesBefore[i] = IERC20(tokens[i]).balanceOf(address(this));
        }

        // Generate execution ID
        bytes32 executionId = keccak256(
            abi.encodePacked(
                msg.sender,
                receiver,
                block.number,
                executionCount++
            )
        );

        // Transfer tokens to receiver
        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20(tokens[i]).safeTransfer(receiver, amounts[i]);
        }

        // Execute receiver's operation
        require(
            IFlashLoanReceiver(receiver).executeOperation(
                tokens,
                amounts,
                fees,
                msg.sender,
                params
            ),
            "Flash loan execution failed"
        );

        // Verify repayment
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 balanceAfter = IERC20(tokens[i]).balanceOf(address(this));
            uint256 expectedBalance = balancesBefore[i] + fees[i];
            
            require(balanceAfter >= expectedBalance, "Insufficient repayment");

            // Update stats
            FlashLoanInfo storage info = flashLoanInfo[tokens[i]];
            info.totalBorrowed += amounts[i];
            info.totalFees += fees[i];

            emit FlashLoan(msg.sender, tokens[i], amounts[i], fees[i], executionId);
        }

        // Store execution record
        executions[executionId] = LoanExecution({
            borrower: msg.sender,
            tokens: tokens,
            amounts: amounts,
            fees: fees,
            timestamp: block.timestamp,
            successful: true
        });

        if (tokens.length > 1) {
            emit FlashLoanMulti(msg.sender, executionId, tokens.length);
        }
    }

    // ============ Liquidity Management ============

    /**
     * @notice Add liquidity to the flash loan pool
     * @param token The token to provide
     * @param amount The amount to provide
     */
    function addLiquidity(address token, uint256 amount) external nonReentrant {
        require(flashLoanInfo[token].isActive, "Token not supported");
        require(amount > 0, "Amount must be > 0");

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        liquidityProvided[msg.sender][token] += amount;
        totalLiquidity[token] += amount;

        emit LiquidityAdded(msg.sender, token, amount);
    }

    /**
     * @notice Remove liquidity from the flash loan pool
     * @param token The token to withdraw
     * @param amount The amount to withdraw
     */
    function removeLiquidity(address token, uint256 amount) external nonReentrant {
        require(liquidityProvided[msg.sender][token] >= amount, "Insufficient balance");
        require(getAvailableLiquidity(token) >= amount, "Insufficient pool liquidity");

        liquidityProvided[msg.sender][token] -= amount;
        totalLiquidity[token] -= amount;

        IERC20(token).safeTransfer(msg.sender, amount);

        emit LiquidityRemoved(msg.sender, token, amount);
    }

    /**
     * @notice Get available liquidity for a token
     */
    function getAvailableLiquidity(address token) public view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /**
     * @notice Calculate fee for a flash loan
     */
    function calculateFee(address token, uint256 amount) external view returns (uint256) {
        FlashLoanInfo storage info = flashLoanInfo[token];
        return (amount * info.fee) / BASIS_POINTS;
    }

    // ============ Admin Functions ============

    /**
     * @notice Configure a token for flash loans
     */
    function configureToken(
        address token,
        uint256 maxAmount,
        uint256 fee,
        bool isActive
    ) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(fee <= MAX_FEE, "Fee too high");

        if (!flashLoanInfo[token].isActive && isActive) {
            supportedTokens.push(token);
        }

        flashLoanInfo[token] = FlashLoanInfo({
            token: token,
            maxAmount: maxAmount,
            fee: fee,
            totalBorrowed: flashLoanInfo[token].totalBorrowed,
            totalFees: flashLoanInfo[token].totalFees,
            isActive: isActive
        });

        emit TokenConfigured(token, maxAmount, fee, isActive);
    }

    /**
     * @notice Collect accumulated fees
     */
    function collectFees(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 liquidity = totalLiquidity[token];
        
        if (balance > liquidity) {
            uint256 fees = balance - liquidity;
            uint256 protocolFee = (fees * protocolFeeShare) / BASIS_POINTS;
            
            if (protocolFee > 0) {
                IERC20(token).safeTransfer(feeRecipient, protocolFee);
                emit FeesCollected(token, protocolFee, feeRecipient);
            }
        }
    }

    /**
     * @notice Update fee recipient
     */
    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "Invalid address");
        feeRecipient = _feeRecipient;
    }

    /**
     * @notice Update protocol fee share
     */
    function setProtocolFeeShare(uint256 _share) external onlyOwner {
        require(_share <= BASIS_POINTS, "Invalid share");
        protocolFeeShare = _share;
    }

    /**
     * @notice Emergency withdrawal
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    /**
     * @notice Pause/unpause
     */
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ============ View Functions ============

    /**
     * @notice Get all supported tokens
     */
    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }

    /**
     * @notice Get flash loan info for a token
     */
    function getFlashLoanInfo(address token) external view returns (
        uint256 maxAmount,
        uint256 fee,
        uint256 totalBorrowed,
        uint256 totalFees,
        uint256 availableLiquidity,
        bool isActive
    ) {
        FlashLoanInfo storage info = flashLoanInfo[token];
        return (
            info.maxAmount,
            info.fee,
            info.totalBorrowed,
            info.totalFees,
            getAvailableLiquidity(token),
            info.isActive
        );
    }

    /**
     * @notice Get provider's liquidity balance
     */
    function getProviderBalance(address provider, address token) external view returns (uint256) {
        return liquidityProvided[provider][token];
    }

    /**
     * @notice Get execution details
     */
    function getExecution(bytes32 executionId) external view returns (
        address borrower,
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory fees,
        uint256 timestamp,
        bool successful
    ) {
        LoanExecution storage exec = executions[executionId];
        return (
            exec.borrower,
            exec.tokens,
            exec.amounts,
            exec.fees,
            exec.timestamp,
            exec.successful
        );
    }
}

/**
 * @title FlashLoanReceiverBase
 * @notice Base contract for flash loan receivers
 */
abstract contract FlashLoanReceiverBase is IFlashLoanReceiver {
    SynapseFlashLoan public immutable flashLoanProvider;

    constructor(address _provider) {
        flashLoanProvider = SynapseFlashLoan(_provider);
    }

    /**
     * @notice Execute arbitrage or other operation
     * @dev Override this in your contract
     */
    function executeOperation(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata fees,
        address initiator,
        bytes calldata params
    ) external virtual override returns (bool) {
        require(msg.sender == address(flashLoanProvider), "Caller not provider");
        
        // Execute your logic here
        _executeLogic(tokens, amounts, fees, initiator, params);

        // Approve repayment
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 repayAmount = amounts[i] + fees[i];
            IERC20(tokens[i]).approve(address(flashLoanProvider), repayAmount);
        }

        return true;
    }

    /**
     * @dev Override to implement your logic
     */
    function _executeLogic(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata fees,
        address initiator,
        bytes calldata params
    ) internal virtual;
}
