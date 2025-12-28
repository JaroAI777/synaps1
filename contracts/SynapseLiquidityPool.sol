// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title SynapseLiquidityPool
 * @notice AMM-style liquidity pool for SYNX/stablecoin trading
 * @dev Constant product market maker with concentrated liquidity features
 */
contract SynapseLiquidityPool is ERC20, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ============ State Variables ============
    
    IERC20 public immutable synxToken;
    IERC20 public immutable stableToken;
    
    // Pool state
    uint256 public reserve0; // SYNX reserve
    uint256 public reserve1; // Stable reserve
    uint256 public kLast; // reserve0 * reserve1, as of immediately after the most recent liquidity event
    
    // Fees
    uint256 public swapFee = 30; // 0.3% in basis points
    uint256 public protocolFee = 5; // 0.05% protocol fee (portion of swap fee)
    uint256 public constant FEE_DENOMINATOR = 10000;
    
    // Protocol fee recipient
    address public feeRecipient;
    uint256 public accumulatedFees0;
    uint256 public accumulatedFees1;
    
    // Price oracle
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint32 public blockTimestampLast;
    
    // Price impact protection
    uint256 public maxPriceImpact = 300; // 3%
    
    // Liquidity mining
    uint256 public rewardRate;
    uint256 public rewardPerTokenStored;
    uint256 public lastRewardUpdateTime;
    uint256 public rewardEndTime;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;
    
    // Concentrated liquidity positions
    struct Position {
        uint256 liquidity;
        uint256 tickLower;
        uint256 tickUpper;
        uint256 feeGrowthInside0;
        uint256 feeGrowthInside1;
    }
    mapping(address => Position[]) public positions;
    
    // ============ Events ============
    
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    
    event LiquidityAdded(
        address indexed provider,
        uint256 amount0,
        uint256 amount1,
        uint256 liquidity
    );
    
    event LiquidityRemoved(
        address indexed provider,
        uint256 amount0,
        uint256 amount1,
        uint256 liquidity
    );
    
    event Sync(uint256 reserve0, uint256 reserve1);
    event FeesCollected(address indexed recipient, uint256 amount0, uint256 amount1);
    event RewardAdded(uint256 reward, uint256 duration);
    event RewardClaimed(address indexed user, uint256 amount);

    // ============ Constructor ============
    
    constructor(
        address _synxToken,
        address _stableToken,
        address _feeRecipient
    ) ERC20("SYNX-STABLE LP", "SYNX-LP") Ownable(msg.sender) {
        require(_synxToken != address(0), "Invalid SYNX token");
        require(_stableToken != address(0), "Invalid stable token");
        require(_feeRecipient != address(0), "Invalid fee recipient");
        
        synxToken = IERC20(_synxToken);
        stableToken = IERC20(_stableToken);
        feeRecipient = _feeRecipient;
    }

    // ============ Swap Functions ============
    
    /**
     * @notice Swap tokens
     * @param amount0Out Amount of SYNX to receive
     * @param amount1Out Amount of stable to receive
     * @param to Recipient address
     */
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to
    ) external nonReentrant whenNotPaused {
        require(amount0Out > 0 || amount1Out > 0, "Insufficient output");
        require(amount0Out < reserve0 && amount1Out < reserve1, "Insufficient liquidity");
        require(to != address(synxToken) && to != address(stableToken), "Invalid to");

        // Check price impact
        _checkPriceImpact(amount0Out, amount1Out);

        // Transfer tokens out
        if (amount0Out > 0) synxToken.safeTransfer(to, amount0Out);
        if (amount1Out > 0) stableToken.safeTransfer(to, amount1Out);

        // Get balances after transfer
        uint256 balance0 = synxToken.balanceOf(address(this)) - accumulatedFees0;
        uint256 balance1 = stableToken.balanceOf(address(this)) - accumulatedFees1;

        // Calculate amounts in
        uint256 amount0In = balance0 > reserve0 - amount0Out 
            ? balance0 - (reserve0 - amount0Out) 
            : 0;
        uint256 amount1In = balance1 > reserve1 - amount1Out 
            ? balance1 - (reserve1 - amount1Out) 
            : 0;
        
        require(amount0In > 0 || amount1In > 0, "Insufficient input");

        // Apply fee
        {
            uint256 balance0Adjusted = (balance0 * FEE_DENOMINATOR) - (amount0In * swapFee);
            uint256 balance1Adjusted = (balance1 * FEE_DENOMINATOR) - (amount1In * swapFee);
            require(
                balance0Adjusted * balance1Adjusted >= reserve0 * reserve1 * FEE_DENOMINATOR ** 2,
                "K invariant"
            );
        }

        // Collect protocol fees
        if (amount0In > 0) {
            uint256 fee0 = (amount0In * protocolFee) / FEE_DENOMINATOR;
            accumulatedFees0 += fee0;
        }
        if (amount1In > 0) {
            uint256 fee1 = (amount1In * protocolFee) / FEE_DENOMINATOR;
            accumulatedFees1 += fee1;
        }

        // Update reserves
        _update(balance0 - accumulatedFees0, balance1 - accumulatedFees1);

        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    /**
     * @notice Swap exact amount of tokens in
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        bool synxToStable,
        address to
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        require(amountIn > 0, "Invalid amount");

        // Calculate output amount
        amountOut = getAmountOut(amountIn, synxToStable);
        require(amountOut >= amountOutMin, "Slippage exceeded");

        // Transfer in
        if (synxToStable) {
            synxToken.safeTransferFrom(msg.sender, address(this), amountIn);
            stableToken.safeTransfer(to, amountOut);
        } else {
            stableToken.safeTransferFrom(msg.sender, address(this), amountIn);
            synxToken.safeTransfer(to, amountOut);
        }

        // Collect protocol fee
        uint256 fee = (amountIn * protocolFee) / FEE_DENOMINATOR;
        if (synxToStable) {
            accumulatedFees0 += fee;
        } else {
            accumulatedFees1 += fee;
        }

        // Update reserves
        uint256 balance0 = synxToken.balanceOf(address(this)) - accumulatedFees0;
        uint256 balance1 = stableToken.balanceOf(address(this)) - accumulatedFees1;
        _update(balance0, balance1);

        emit Swap(
            msg.sender,
            synxToStable ? amountIn : 0,
            synxToStable ? 0 : amountIn,
            synxToStable ? 0 : amountOut,
            synxToStable ? amountOut : 0,
            to
        );
    }

    /**
     * @dev Check price impact
     */
    function _checkPriceImpact(uint256 amount0Out, uint256 amount1Out) internal view {
        if (amount0Out > 0) {
            uint256 impact = (amount0Out * FEE_DENOMINATOR) / reserve0;
            require(impact <= maxPriceImpact, "Price impact too high");
        }
        if (amount1Out > 0) {
            uint256 impact = (amount1Out * FEE_DENOMINATOR) / reserve1;
            require(impact <= maxPriceImpact, "Price impact too high");
        }
    }

    // ============ Liquidity Functions ============
    
    /**
     * @notice Add liquidity to the pool
     */
    function addLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address to
    ) external nonReentrant whenNotPaused returns (uint256 amount0, uint256 amount1, uint256 liquidity) {
        // Calculate optimal amounts
        if (reserve0 == 0 && reserve1 == 0) {
            (amount0, amount1) = (amount0Desired, amount1Desired);
        } else {
            uint256 amount1Optimal = quote(amount0Desired, reserve0, reserve1);
            if (amount1Optimal <= amount1Desired) {
                require(amount1Optimal >= amount1Min, "Insufficient amount1");
                (amount0, amount1) = (amount0Desired, amount1Optimal);
            } else {
                uint256 amount0Optimal = quote(amount1Desired, reserve1, reserve0);
                require(amount0Optimal <= amount0Desired, "Excessive amount0");
                require(amount0Optimal >= amount0Min, "Insufficient amount0");
                (amount0, amount1) = (amount0Optimal, amount1Desired);
            }
        }

        // Transfer tokens
        synxToken.safeTransferFrom(msg.sender, address(this), amount0);
        stableToken.safeTransferFrom(msg.sender, address(this), amount1);

        // Mint LP tokens
        uint256 _totalSupply = totalSupply();
        if (_totalSupply == 0) {
            liquidity = Math.sqrt(amount0 * amount1) - 1000; // Minimum liquidity
            _mint(address(0xdead), 1000); // Lock minimum liquidity
        } else {
            liquidity = Math.min(
                (amount0 * _totalSupply) / reserve0,
                (amount1 * _totalSupply) / reserve1
            );
        }
        
        require(liquidity > 0, "Insufficient liquidity minted");
        _mint(to, liquidity);

        // Update reserves
        _update(
            synxToken.balanceOf(address(this)) - accumulatedFees0,
            stableToken.balanceOf(address(this)) - accumulatedFees1
        );

        // Update rewards
        _updateReward(to);

        emit LiquidityAdded(to, amount0, amount1, liquidity);
    }

    /**
     * @notice Remove liquidity from the pool
     */
    function removeLiquidity(
        uint256 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        address to
    ) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        require(liquidity > 0, "Invalid liquidity");

        // Calculate amounts
        uint256 _totalSupply = totalSupply();
        amount0 = (liquidity * reserve0) / _totalSupply;
        amount1 = (liquidity * reserve1) / _totalSupply;
        
        require(amount0 >= amount0Min, "Insufficient amount0");
        require(amount1 >= amount1Min, "Insufficient amount1");

        // Update rewards before burning
        _updateReward(msg.sender);

        // Burn LP tokens
        _burn(msg.sender, liquidity);

        // Transfer tokens
        synxToken.safeTransfer(to, amount0);
        stableToken.safeTransfer(to, amount1);

        // Update reserves
        _update(
            synxToken.balanceOf(address(this)) - accumulatedFees0,
            stableToken.balanceOf(address(this)) - accumulatedFees1
        );

        emit LiquidityRemoved(msg.sender, amount0, amount1, liquidity);
    }

    // ============ Rewards Functions ============
    
    /**
     * @notice Add rewards for liquidity mining
     */
    function addRewards(uint256 amount, uint256 duration) external onlyOwner {
        require(amount > 0 && duration > 0, "Invalid parameters");
        
        _updateReward(address(0));

        if (block.timestamp >= rewardEndTime) {
            rewardRate = amount / duration;
        } else {
            uint256 remaining = rewardEndTime - block.timestamp;
            uint256 leftover = remaining * rewardRate;
            rewardRate = (amount + leftover) / duration;
        }

        lastRewardUpdateTime = block.timestamp;
        rewardEndTime = block.timestamp + duration;

        synxToken.safeTransferFrom(msg.sender, address(this), amount);

        emit RewardAdded(amount, duration);
    }

    /**
     * @notice Claim rewards
     */
    function claimRewards() external nonReentrant returns (uint256 reward) {
        _updateReward(msg.sender);
        
        reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            synxToken.safeTransfer(msg.sender, reward);
            emit RewardClaimed(msg.sender, reward);
        }
    }

    /**
     * @dev Update reward calculations
     */
    function _updateReward(address account) internal {
        rewardPerTokenStored = rewardPerToken();
        lastRewardUpdateTime = lastTimeRewardApplicable();
        
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
    }

    /**
     * @notice Get last time reward is applicable
     */
    function lastTimeRewardApplicable() public view returns (uint256) {
        return Math.min(block.timestamp, rewardEndTime);
    }

    /**
     * @notice Get reward per token
     */
    function rewardPerToken() public view returns (uint256) {
        if (totalSupply() == 0) {
            return rewardPerTokenStored;
        }
        return rewardPerTokenStored + (
            (lastTimeRewardApplicable() - lastRewardUpdateTime) * rewardRate * 1e18 / totalSupply()
        );
    }

    /**
     * @notice Get earned rewards for account
     */
    function earned(address account) public view returns (uint256) {
        return (
            balanceOf(account) * (rewardPerToken() - userRewardPerTokenPaid[account]) / 1e18
        ) + rewards[account];
    }

    // ============ Internal Functions ============
    
    /**
     * @dev Update reserves and price accumulators
     */
    function _update(uint256 balance0, uint256 balance1) internal {
        uint32 blockTimestamp = uint32(block.timestamp % 2**32);
        uint32 timeElapsed = blockTimestamp - blockTimestampLast;
        
        if (timeElapsed > 0 && reserve0 != 0 && reserve1 != 0) {
            // Price accumulator for TWAP oracle
            price0CumulativeLast += (reserve1 * 1e18 / reserve0) * timeElapsed;
            price1CumulativeLast += (reserve0 * 1e18 / reserve1) * timeElapsed;
        }

        reserve0 = balance0;
        reserve1 = balance1;
        blockTimestampLast = blockTimestamp;
        kLast = reserve0 * reserve1;

        emit Sync(reserve0, reserve1);
    }

    // ============ View Functions ============
    
    /**
     * @notice Get amount out for a given input
     */
    function getAmountOut(uint256 amountIn, bool synxToStable) public view returns (uint256 amountOut) {
        require(amountIn > 0, "Invalid amount");
        
        uint256 reserveIn = synxToStable ? reserve0 : reserve1;
        uint256 reserveOut = synxToStable ? reserve1 : reserve0;
        
        uint256 amountInWithFee = amountIn * (FEE_DENOMINATOR - swapFee);
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * FEE_DENOMINATOR) + amountInWithFee;
        
        amountOut = numerator / denominator;
    }

    /**
     * @notice Get amount in for a given output
     */
    function getAmountIn(uint256 amountOut, bool synxToStable) public view returns (uint256 amountIn) {
        require(amountOut > 0, "Invalid amount");
        
        uint256 reserveIn = synxToStable ? reserve0 : reserve1;
        uint256 reserveOut = synxToStable ? reserve1 : reserve0;
        
        require(amountOut < reserveOut, "Insufficient liquidity");
        
        uint256 numerator = reserveIn * amountOut * FEE_DENOMINATOR;
        uint256 denominator = (reserveOut - amountOut) * (FEE_DENOMINATOR - swapFee);
        
        amountIn = (numerator / denominator) + 1;
    }

    /**
     * @notice Quote optimal amount
     */
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) public pure returns (uint256 amountB) {
        require(amountA > 0, "Invalid amount");
        require(reserveA > 0 && reserveB > 0, "Insufficient liquidity");
        amountB = (amountA * reserveB) / reserveA;
    }

    /**
     * @notice Get current spot price
     */
    function getSpotPrice() external view returns (uint256 price0, uint256 price1) {
        require(reserve0 > 0 && reserve1 > 0, "No liquidity");
        price0 = (reserve1 * 1e18) / reserve0; // SYNX price in stable
        price1 = (reserve0 * 1e18) / reserve1; // Stable price in SYNX
    }

    /**
     * @notice Get pool info
     */
    function getPoolInfo() external view returns (
        uint256 _reserve0,
        uint256 _reserve1,
        uint256 _totalSupply,
        uint256 _swapFee,
        uint256 _rewardRate,
        uint256 _rewardEndTime
    ) {
        return (
            reserve0,
            reserve1,
            totalSupply(),
            swapFee,
            rewardRate,
            rewardEndTime
        );
    }

    // ============ Admin Functions ============
    
    /**
     * @notice Set swap fee
     */
    function setSwapFee(uint256 _swapFee) external onlyOwner {
        require(_swapFee <= 100, "Fee too high"); // Max 1%
        swapFee = _swapFee;
    }

    /**
     * @notice Set protocol fee
     */
    function setProtocolFee(uint256 _protocolFee) external onlyOwner {
        require(_protocolFee <= 20, "Fee too high"); // Max 0.2%
        protocolFee = _protocolFee;
    }

    /**
     * @notice Set fee recipient
     */
    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "Invalid address");
        feeRecipient = _feeRecipient;
    }

    /**
     * @notice Set max price impact
     */
    function setMaxPriceImpact(uint256 _maxPriceImpact) external onlyOwner {
        require(_maxPriceImpact >= 100 && _maxPriceImpact <= 1000, "Invalid range"); // 1-10%
        maxPriceImpact = _maxPriceImpact;
    }

    /**
     * @notice Collect accumulated protocol fees
     */
    function collectFees() external {
        uint256 fees0 = accumulatedFees0;
        uint256 fees1 = accumulatedFees1;
        
        accumulatedFees0 = 0;
        accumulatedFees1 = 0;

        if (fees0 > 0) synxToken.safeTransfer(feeRecipient, fees0);
        if (fees1 > 0) stableToken.safeTransfer(feeRecipient, fees1);

        emit FeesCollected(feeRecipient, fees0, fees1);
    }

    /**
     * @notice Pause pool
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause pool
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Force sync reserves
     */
    function sync() external {
        _update(
            synxToken.balanceOf(address(this)) - accumulatedFees0,
            stableToken.balanceOf(address(this)) - accumulatedFees1
        );
    }
}
