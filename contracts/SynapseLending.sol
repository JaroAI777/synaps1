// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title SynapseLending
 * @notice Collateralized lending protocol for SYNX tokens
 * @dev Supports multiple collateral types, variable interest rates, and liquidations
 */
contract SynapseLending is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ============ Structs ============

    struct Market {
        address token;
        uint256 totalDeposits;
        uint256 totalBorrows;
        uint256 depositRate;      // APY in basis points
        uint256 borrowRate;       // APY in basis points
        uint256 collateralFactor; // In basis points (e.g., 7500 = 75%)
        uint256 liquidationBonus; // In basis points (e.g., 500 = 5%)
        uint256 reserveFactor;    // Protocol fee on interest
        uint256 lastUpdateTime;
        uint256 borrowIndex;      // Accumulated interest index
        uint256 depositIndex;
        bool isActive;
        bool canBorrow;
        bool canCollateral;
    }

    struct UserPosition {
        uint256 deposited;
        uint256 borrowed;
        uint256 depositIndex;
        uint256 borrowIndex;
        bool isCollateral;
    }

    struct LiquidationParams {
        address borrower;
        address collateralToken;
        address debtToken;
        uint256 debtToCover;
    }

    // ============ Constants ============

    uint256 public constant PRECISION = 1e18;
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant SECONDS_PER_YEAR = 31536000;
    uint256 public constant MIN_HEALTH_FACTOR = 1e18; // 1.0

    // Interest rate model parameters
    uint256 public constant OPTIMAL_UTILIZATION = 8000; // 80%
    uint256 public constant BASE_RATE = 200;            // 2%
    uint256 public constant SLOPE1 = 400;               // 4%
    uint256 public constant SLOPE2 = 7500;              // 75%

    // ============ State Variables ============

    IERC20 public immutable synxToken;
    
    mapping(address => Market) public markets;
    address[] public marketList;
    
    mapping(address => mapping(address => UserPosition)) public userPositions;
    mapping(address => address[]) public userMarkets;
    
    // Oracle integration
    mapping(address => address) public priceOracles;
    mapping(address => uint256) public prices; // Fallback prices

    // Protocol stats
    uint256 public totalValueLocked;
    uint256 public totalBorrowed;
    uint256 public protocolReserves;

    // ============ Events ============

    event MarketCreated(address indexed token, uint256 collateralFactor);
    event Deposit(address indexed user, address indexed token, uint256 amount);
    event Withdraw(address indexed user, address indexed token, uint256 amount);
    event Borrow(address indexed user, address indexed token, uint256 amount);
    event Repay(address indexed user, address indexed token, uint256 amount);
    event Liquidation(
        address indexed liquidator,
        address indexed borrower,
        address indexed collateralToken,
        address debtToken,
        uint256 debtRepaid,
        uint256 collateralSeized
    );
    event CollateralToggled(address indexed user, address indexed token, bool enabled);
    event InterestAccrued(address indexed token, uint256 borrowIndex, uint256 depositIndex);
    event PriceUpdated(address indexed token, uint256 price);

    // ============ Constructor ============

    constructor(address _synxToken) Ownable(msg.sender) {
        synxToken = IERC20(_synxToken);
        
        // Create SYNX market
        _createMarket(
            _synxToken,
            7500,  // 75% collateral factor
            500,   // 5% liquidation bonus
            1000   // 10% reserve factor
        );
    }

    // ============ Market Management ============

    /**
     * @notice Create a new lending market
     */
    function createMarket(
        address token,
        uint256 collateralFactor,
        uint256 liquidationBonus,
        uint256 reserveFactor
    ) external onlyOwner {
        _createMarket(token, collateralFactor, liquidationBonus, reserveFactor);
    }

    function _createMarket(
        address token,
        uint256 collateralFactor,
        uint256 liquidationBonus,
        uint256 reserveFactor
    ) internal {
        require(token != address(0), "Invalid token");
        require(!markets[token].isActive, "Market exists");
        require(collateralFactor <= 9000, "CF too high"); // Max 90%
        require(liquidationBonus <= 2000, "Bonus too high"); // Max 20%

        markets[token] = Market({
            token: token,
            totalDeposits: 0,
            totalBorrows: 0,
            depositRate: 0,
            borrowRate: BASE_RATE,
            collateralFactor: collateralFactor,
            liquidationBonus: liquidationBonus,
            reserveFactor: reserveFactor,
            lastUpdateTime: block.timestamp,
            borrowIndex: PRECISION,
            depositIndex: PRECISION,
            isActive: true,
            canBorrow: true,
            canCollateral: true
        });

        marketList.push(token);
        emit MarketCreated(token, collateralFactor);
    }

    /**
     * @notice Update market parameters
     */
    function updateMarket(
        address token,
        uint256 collateralFactor,
        uint256 liquidationBonus,
        bool canBorrow,
        bool canCollateral
    ) external onlyOwner {
        Market storage market = markets[token];
        require(market.isActive, "Market not active");

        market.collateralFactor = collateralFactor;
        market.liquidationBonus = liquidationBonus;
        market.canBorrow = canBorrow;
        market.canCollateral = canCollateral;
    }

    // ============ Core Functions ============

    /**
     * @notice Deposit tokens to earn interest
     */
    function deposit(address token, uint256 amount) external nonReentrant whenNotPaused {
        Market storage market = markets[token];
        require(market.isActive, "Market not active");
        require(amount > 0, "Amount must be > 0");

        // Accrue interest first
        _accrueInterest(token);

        // Transfer tokens
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Update position
        UserPosition storage position = userPositions[msg.sender][token];
        
        // Convert to shares
        uint256 shares = (amount * PRECISION) / market.depositIndex;
        position.deposited += shares;
        position.depositIndex = market.depositIndex;

        market.totalDeposits += amount;
        totalValueLocked += _getValueInSynx(token, amount);

        // Track user markets
        _addUserMarket(msg.sender, token);

        emit Deposit(msg.sender, token, amount);
    }

    /**
     * @notice Withdraw deposited tokens
     */
    function withdraw(address token, uint256 amount) external nonReentrant {
        Market storage market = markets[token];
        require(market.isActive, "Market not active");

        _accrueInterest(token);

        UserPosition storage position = userPositions[msg.sender][token];
        uint256 deposited = _getDepositBalance(msg.sender, token);
        
        require(amount <= deposited, "Insufficient balance");

        // Check if withdrawal would make position unhealthy
        if (position.isCollateral && position.borrowed > 0) {
            uint256 newDeposit = deposited - amount;
            require(_isHealthyAfterAction(msg.sender, token, newDeposit, position.borrowed), "Would be unhealthy");
        }

        // Update position
        uint256 sharesToBurn = (amount * PRECISION) / market.depositIndex;
        position.deposited -= sharesToBurn;

        market.totalDeposits -= amount;
        totalValueLocked -= _getValueInSynx(token, amount);

        // Transfer tokens
        IERC20(token).safeTransfer(msg.sender, amount);

        emit Withdraw(msg.sender, token, amount);
    }

    /**
     * @notice Borrow tokens using collateral
     */
    function borrow(address token, uint256 amount) external nonReentrant whenNotPaused {
        Market storage market = markets[token];
        require(market.isActive && market.canBorrow, "Cannot borrow");
        require(amount > 0, "Amount must be > 0");
        require(market.totalDeposits - market.totalBorrows >= amount, "Insufficient liquidity");

        _accrueInterest(token);

        UserPosition storage position = userPositions[msg.sender][token];

        // Calculate new borrow amount
        uint256 currentBorrow = _getBorrowBalance(msg.sender, token);
        uint256 newBorrow = currentBorrow + amount;

        // Check health factor
        require(_isHealthyAfterAction(msg.sender, token, position.deposited, newBorrow), "Insufficient collateral");

        // Update position
        uint256 borrowShares = (amount * PRECISION) / market.borrowIndex;
        position.borrowed += borrowShares;
        position.borrowIndex = market.borrowIndex;

        market.totalBorrows += amount;
        totalBorrowed += _getValueInSynx(token, amount);

        // Transfer tokens
        IERC20(token).safeTransfer(msg.sender, amount);

        emit Borrow(msg.sender, token, amount);
    }

    /**
     * @notice Repay borrowed tokens
     */
    function repay(address token, uint256 amount) external nonReentrant {
        _repayInternal(token, msg.sender, amount);
    }

    /**
     * @notice Repay on behalf of another user
     */
    function repayFor(address token, address borrower, uint256 amount) external nonReentrant {
        _repayInternal(token, borrower, amount);
    }

    function _repayInternal(address token, address borrower, uint256 amount) internal {
        Market storage market = markets[token];
        require(market.isActive, "Market not active");

        _accrueInterest(token);

        UserPosition storage position = userPositions[borrower][token];
        uint256 borrowed = _getBorrowBalance(borrower, token);
        
        require(borrowed > 0, "No debt");
        
        uint256 repayAmount = amount > borrowed ? borrowed : amount;

        // Transfer tokens
        IERC20(token).safeTransferFrom(msg.sender, address(this), repayAmount);

        // Update position
        uint256 sharesToBurn = (repayAmount * PRECISION) / market.borrowIndex;
        position.borrowed -= sharesToBurn;

        market.totalBorrows -= repayAmount;
        totalBorrowed -= _getValueInSynx(token, repayAmount);

        emit Repay(borrower, token, repayAmount);
    }

    /**
     * @notice Toggle collateral status
     */
    function toggleCollateral(address token, bool enable) external {
        Market storage market = markets[token];
        require(market.isActive && market.canCollateral, "Cannot use as collateral");

        UserPosition storage position = userPositions[msg.sender][token];
        require(position.deposited > 0, "No deposit");

        if (!enable && position.borrowed > 0) {
            require(_isHealthyAfterToggle(msg.sender, token), "Would be unhealthy");
        }

        position.isCollateral = enable;
        emit CollateralToggled(msg.sender, token, enable);
    }

    // ============ Liquidation ============

    /**
     * @notice Liquidate an unhealthy position
     */
    function liquidate(
        address borrower,
        address collateralToken,
        address debtToken,
        uint256 debtToCover
    ) external nonReentrant {
        require(borrower != msg.sender, "Cannot self-liquidate");

        // Check health factor
        uint256 healthFactor = getHealthFactor(borrower);
        require(healthFactor < MIN_HEALTH_FACTOR, "Position healthy");

        _accrueInterest(collateralToken);
        _accrueInterest(debtToken);

        Market storage collateralMarket = markets[collateralToken];
        Market storage debtMarket = markets[debtToken];

        UserPosition storage borrowerCollateral = userPositions[borrower][collateralToken];
        UserPosition storage borrowerDebt = userPositions[borrower][debtToken];

        uint256 actualDebt = _getBorrowBalance(borrower, debtToken);
        uint256 maxLiquidatable = (actualDebt * 5000) / BASIS_POINTS; // 50% max
        
        uint256 debtRepaid = debtToCover > maxLiquidatable ? maxLiquidatable : debtToCover;

        // Calculate collateral to seize
        uint256 collateralPrice = getPrice(collateralToken);
        uint256 debtPrice = getPrice(debtToken);
        
        uint256 collateralValue = (debtRepaid * debtPrice * (BASIS_POINTS + collateralMarket.liquidationBonus)) 
            / (collateralPrice * BASIS_POINTS);

        uint256 collateralBalance = _getDepositBalance(borrower, collateralToken);
        require(collateralValue <= collateralBalance, "Insufficient collateral");

        // Transfer debt from liquidator
        IERC20(debtToken).safeTransferFrom(msg.sender, address(this), debtRepaid);

        // Update borrower debt
        uint256 debtShares = (debtRepaid * PRECISION) / debtMarket.borrowIndex;
        borrowerDebt.borrowed -= debtShares;
        debtMarket.totalBorrows -= debtRepaid;

        // Update borrower collateral
        uint256 collateralShares = (collateralValue * PRECISION) / collateralMarket.depositIndex;
        borrowerCollateral.deposited -= collateralShares;
        collateralMarket.totalDeposits -= collateralValue;

        // Transfer collateral to liquidator
        IERC20(collateralToken).safeTransfer(msg.sender, collateralValue);

        emit Liquidation(msg.sender, borrower, collateralToken, debtToken, debtRepaid, collateralValue);
    }

    // ============ Interest Rate Model ============

    /**
     * @notice Accrue interest for a market
     */
    function _accrueInterest(address token) internal {
        Market storage market = markets[token];
        
        uint256 timeElapsed = block.timestamp - market.lastUpdateTime;
        if (timeElapsed == 0) return;

        market.lastUpdateTime = block.timestamp;

        if (market.totalBorrows == 0) return;

        // Calculate utilization
        uint256 utilization = (market.totalBorrows * BASIS_POINTS) / market.totalDeposits;

        // Calculate borrow rate
        uint256 borrowRate;
        if (utilization <= OPTIMAL_UTILIZATION) {
            borrowRate = BASE_RATE + (utilization * SLOPE1) / OPTIMAL_UTILIZATION;
        } else {
            borrowRate = BASE_RATE + SLOPE1 + 
                ((utilization - OPTIMAL_UTILIZATION) * SLOPE2) / (BASIS_POINTS - OPTIMAL_UTILIZATION);
        }

        // Calculate interest
        uint256 borrowInterest = (market.totalBorrows * borrowRate * timeElapsed) / (BASIS_POINTS * SECONDS_PER_YEAR);
        
        // Update indices
        uint256 borrowIndexIncrease = (borrowInterest * PRECISION) / market.totalBorrows;
        market.borrowIndex += borrowIndexIncrease;

        // Protocol takes reserve
        uint256 reserve = (borrowInterest * market.reserveFactor) / BASIS_POINTS;
        uint256 depositInterest = borrowInterest - reserve;
        protocolReserves += reserve;

        uint256 depositIndexIncrease = market.totalDeposits > 0 
            ? (depositInterest * PRECISION) / market.totalDeposits 
            : 0;
        market.depositIndex += depositIndexIncrease;

        // Update rates
        market.borrowRate = borrowRate;
        market.depositRate = market.totalDeposits > 0
            ? (borrowRate * utilization * (BASIS_POINTS - market.reserveFactor)) / (BASIS_POINTS * BASIS_POINTS)
            : 0;

        emit InterestAccrued(token, market.borrowIndex, market.depositIndex);
    }

    // ============ View Functions ============

    /**
     * @notice Get user's deposit balance including interest
     */
    function getDepositBalance(address user, address token) external view returns (uint256) {
        return _getDepositBalance(user, token);
    }

    function _getDepositBalance(address user, address token) internal view returns (uint256) {
        UserPosition storage position = userPositions[user][token];
        Market storage market = markets[token];
        
        if (position.deposited == 0) return 0;
        
        return (position.deposited * market.depositIndex) / PRECISION;
    }

    /**
     * @notice Get user's borrow balance including interest
     */
    function getBorrowBalance(address user, address token) external view returns (uint256) {
        return _getBorrowBalance(user, token);
    }

    function _getBorrowBalance(address user, address token) internal view returns (uint256) {
        UserPosition storage position = userPositions[user][token];
        Market storage market = markets[token];
        
        if (position.borrowed == 0) return 0;
        
        return (position.borrowed * market.borrowIndex) / PRECISION;
    }

    /**
     * @notice Get health factor for user
     */
    function getHealthFactor(address user) public view returns (uint256) {
        uint256 totalCollateralValue = 0;
        uint256 totalBorrowValue = 0;

        address[] memory userMarketsArray = userMarkets[user];
        
        for (uint256 i = 0; i < userMarketsArray.length; i++) {
            address token = userMarketsArray[i];
            UserPosition storage position = userPositions[user][token];
            Market storage market = markets[token];

            uint256 price = getPrice(token);

            if (position.isCollateral && position.deposited > 0) {
                uint256 depositValue = (_getDepositBalance(user, token) * price) / PRECISION;
                totalCollateralValue += (depositValue * market.collateralFactor) / BASIS_POINTS;
            }

            if (position.borrowed > 0) {
                totalBorrowValue += (_getBorrowBalance(user, token) * price) / PRECISION;
            }
        }

        if (totalBorrowValue == 0) return type(uint256).max;
        
        return (totalCollateralValue * PRECISION) / totalBorrowValue;
    }

    /**
     * @notice Get price of token in SYNX
     */
    function getPrice(address token) public view returns (uint256) {
        if (token == address(synxToken)) return PRECISION;
        
        // Try oracle first
        if (priceOracles[token] != address(0)) {
            // Integration with oracle
            // return IOracle(priceOracles[token]).getPrice(token);
        }
        
        // Fallback to stored price
        return prices[token] > 0 ? prices[token] : PRECISION;
    }

    /**
     * @notice Get market data
     */
    function getMarketData(address token) external view returns (
        uint256 totalDeposits,
        uint256 totalBorrows,
        uint256 depositRate,
        uint256 borrowRate,
        uint256 utilization,
        uint256 liquidity
    ) {
        Market storage market = markets[token];
        
        utilization = market.totalDeposits > 0 
            ? (market.totalBorrows * BASIS_POINTS) / market.totalDeposits 
            : 0;
        
        return (
            market.totalDeposits,
            market.totalBorrows,
            market.depositRate,
            market.borrowRate,
            utilization,
            market.totalDeposits - market.totalBorrows
        );
    }

    /**
     * @notice Get user account data
     */
    function getUserAccountData(address user) external view returns (
        uint256 totalDeposits,
        uint256 totalBorrows,
        uint256 availableBorrows,
        uint256 healthFactor
    ) {
        uint256 totalCollateralValue = 0;
        uint256 totalBorrowValue = 0;

        address[] memory userMarketsArray = userMarkets[user];
        
        for (uint256 i = 0; i < userMarketsArray.length; i++) {
            address token = userMarketsArray[i];
            UserPosition storage position = userPositions[user][token];
            Market storage market = markets[token];

            uint256 price = getPrice(token);

            uint256 depositValue = (_getDepositBalance(user, token) * price) / PRECISION;
            totalDeposits += depositValue;

            if (position.isCollateral) {
                totalCollateralValue += (depositValue * market.collateralFactor) / BASIS_POINTS;
            }

            uint256 borrowValue = (_getBorrowBalance(user, token) * price) / PRECISION;
            totalBorrows += borrowValue;
            totalBorrowValue += borrowValue;
        }

        availableBorrows = totalCollateralValue > totalBorrowValue 
            ? totalCollateralValue - totalBorrowValue 
            : 0;
        
        healthFactor = getHealthFactor(user);
    }

    // ============ Internal Functions ============

    function _getValueInSynx(address token, uint256 amount) internal view returns (uint256) {
        return (amount * getPrice(token)) / PRECISION;
    }

    function _isHealthyAfterAction(
        address user,
        address token,
        uint256 newDeposit,
        uint256 newBorrow
    ) internal view returns (bool) {
        // Simplified check - full implementation would iterate all positions
        Market storage market = markets[token];
        uint256 price = getPrice(token);
        
        uint256 collateralValue = (newDeposit * price * market.collateralFactor) / (PRECISION * BASIS_POINTS);
        uint256 borrowValue = (newBorrow * price) / PRECISION;
        
        return collateralValue >= borrowValue;
    }

    function _isHealthyAfterToggle(address user, address token) internal view returns (bool) {
        return getHealthFactor(user) >= MIN_HEALTH_FACTOR;
    }

    function _addUserMarket(address user, address token) internal {
        address[] storage markets_ = userMarkets[user];
        for (uint256 i = 0; i < markets_.length; i++) {
            if (markets_[i] == token) return;
        }
        markets_.push(token);
    }

    // ============ Admin Functions ============

    /**
     * @notice Set price for token (fallback)
     */
    function setPrice(address token, uint256 price) external onlyOwner {
        prices[token] = price;
        emit PriceUpdated(token, price);
    }

    /**
     * @notice Set oracle for token
     */
    function setOracle(address token, address oracle) external onlyOwner {
        priceOracles[token] = oracle;
    }

    /**
     * @notice Withdraw protocol reserves
     */
    function withdrawReserves(address token, uint256 amount, address to) external onlyOwner {
        require(amount <= protocolReserves, "Insufficient reserves");
        protocolReserves -= amount;
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice Pause/unpause
     */
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
