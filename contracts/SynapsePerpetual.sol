// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapsePerpetual
 * @notice Perpetual futures trading with up to 100x leverage
 * @dev Implements funding rate, liquidation, and position management
 */
contract SynapsePerpetual is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Roles ============
    
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    // ============ Enums ============

    enum Side { LONG, SHORT }
    enum OrderType { MARKET, LIMIT, STOP_LOSS, TAKE_PROFIT }
    enum OrderStatus { OPEN, FILLED, CANCELLED, EXPIRED }

    // ============ Structs ============

    struct Market {
        bytes32 marketId;
        string symbol;              // e.g., "BTC-PERP"
        address baseToken;          // Collateral token
        uint256 indexPrice;         // Current price (scaled 1e8)
        uint256 markPrice;          // Mark price for P&L
        int256 fundingRate;         // Current funding rate (scaled 1e8)
        uint256 openInterestLong;
        uint256 openInterestShort;
        uint256 maxLeverage;        // Max leverage (e.g., 100 = 100x)
        uint256 maintenanceMargin;  // Maintenance margin rate (basis points)
        uint256 takerFee;           // Taker fee (basis points)
        uint256 makerFee;           // Maker fee (basis points)
        bool isActive;
        uint256 lastFundingTime;
    }

    struct Position {
        bytes32 marketId;
        address trader;
        Side side;
        uint256 size;               // Position size in base units
        uint256 entryPrice;         // Average entry price
        uint256 margin;             // Collateral deposited
        uint256 leverage;
        int256 unrealizedPnl;
        int256 accumulatedFunding;
        uint256 lastFundingIndex;
        uint256 openTime;
    }

    struct Order {
        uint256 orderId;
        bytes32 marketId;
        address trader;
        Side side;
        OrderType orderType;
        uint256 size;
        uint256 price;              // For limit orders
        uint256 triggerPrice;       // For stop/take-profit
        uint256 margin;
        uint256 leverage;
        OrderStatus status;
        uint256 filledSize;
        uint256 createdAt;
        uint256 expiresAt;
    }

    // ============ State Variables ============

    IERC20 public immutable collateralToken;

    // Markets
    mapping(bytes32 => Market) public markets;
    bytes32[] public marketList;

    // Positions: marketId => trader => Position
    mapping(bytes32 => mapping(address => Position)) public positions;
    mapping(address => bytes32[]) public traderMarkets;

    // Orders
    mapping(uint256 => Order) public orders;
    mapping(address => uint256[]) public traderOrders;
    uint256 public orderCounter;

    // Funding
    mapping(bytes32 => uint256) public cumulativeFundingIndex;
    uint256 public constant FUNDING_INTERVAL = 8 hours;

    // Insurance fund
    uint256 public insuranceFund;

    // Fees
    address public feeRecipient;
    uint256 public liquidationFee = 500;  // 5%
    uint256 public constant BASIS_POINTS = 10000;

    // Limits
    uint256 public maxPositionSize = 1000000 * 1e18;
    uint256 public minMargin = 10 * 1e18;

    // ============ Events ============

    event MarketCreated(bytes32 indexed marketId, string symbol);
    event PositionOpened(bytes32 indexed marketId, address indexed trader, Side side, uint256 size, uint256 price);
    event PositionClosed(bytes32 indexed marketId, address indexed trader, int256 pnl);
    event PositionLiquidated(bytes32 indexed marketId, address indexed trader, address liquidator, uint256 size);
    event MarginAdded(bytes32 indexed marketId, address indexed trader, uint256 amount);
    event MarginRemoved(bytes32 indexed marketId, address indexed trader, uint256 amount);
    event OrderPlaced(uint256 indexed orderId, bytes32 indexed marketId, address indexed trader);
    event OrderFilled(uint256 indexed orderId, uint256 filledSize, uint256 price);
    event OrderCancelled(uint256 indexed orderId);
    event FundingPaid(bytes32 indexed marketId, int256 fundingRate);
    event PriceUpdated(bytes32 indexed marketId, uint256 indexPrice, uint256 markPrice);

    // ============ Constructor ============

    constructor(address _collateralToken) {
        collateralToken = IERC20(_collateralToken);
        feeRecipient = msg.sender;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(KEEPER_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, msg.sender);
    }

    // ============ Market Management ============

    /**
     * @notice Create a new perpetual market
     */
    function createMarket(
        string calldata symbol,
        address baseToken,
        uint256 maxLeverage,
        uint256 maintenanceMargin,
        uint256 takerFee,
        uint256 makerFee
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (bytes32) {
        bytes32 marketId = keccak256(abi.encodePacked(symbol, block.timestamp));
        
        require(markets[marketId].marketId == bytes32(0), "Market exists");
        require(maxLeverage <= 100 && maxLeverage > 0, "Invalid leverage");

        markets[marketId] = Market({
            marketId: marketId,
            symbol: symbol,
            baseToken: baseToken,
            indexPrice: 0,
            markPrice: 0,
            fundingRate: 0,
            openInterestLong: 0,
            openInterestShort: 0,
            maxLeverage: maxLeverage,
            maintenanceMargin: maintenanceMargin,
            takerFee: takerFee,
            makerFee: makerFee,
            isActive: true,
            lastFundingTime: block.timestamp
        });

        marketList.push(marketId);

        emit MarketCreated(marketId, symbol);

        return marketId;
    }

    /**
     * @notice Update market prices (oracle role)
     */
    function updatePrice(
        bytes32 marketId,
        uint256 indexPrice,
        uint256 markPrice
    ) external onlyRole(ORACLE_ROLE) {
        Market storage market = markets[marketId];
        require(market.isActive, "Market not active");

        market.indexPrice = indexPrice;
        market.markPrice = markPrice;

        emit PriceUpdated(marketId, indexPrice, markPrice);
    }

    // ============ Position Management ============

    /**
     * @notice Open or increase a position
     */
    function openPosition(
        bytes32 marketId,
        Side side,
        uint256 size,
        uint256 margin,
        uint256 leverage
    ) external nonReentrant whenNotPaused {
        Market storage market = markets[marketId];
        require(market.isActive, "Market not active");
        require(leverage > 0 && leverage <= market.maxLeverage, "Invalid leverage");
        require(margin >= minMargin, "Margin too low");
        require(size <= maxPositionSize, "Size too large");

        Position storage pos = positions[marketId][msg.sender];

        // Calculate required margin
        uint256 notionalValue = (size * market.markPrice) / 1e8;
        uint256 requiredMargin = notionalValue / leverage;
        require(margin >= requiredMargin, "Insufficient margin");

        // Transfer collateral
        collateralToken.safeTransferFrom(msg.sender, address(this), margin);

        // Calculate fee
        uint256 fee = (notionalValue * market.takerFee) / BASIS_POINTS;
        collateralToken.safeTransfer(feeRecipient, fee);
        margin -= fee;

        if (pos.size == 0) {
            // New position
            pos.marketId = marketId;
            pos.trader = msg.sender;
            pos.side = side;
            pos.size = size;
            pos.entryPrice = market.markPrice;
            pos.margin = margin;
            pos.leverage = leverage;
            pos.lastFundingIndex = cumulativeFundingIndex[marketId];
            pos.openTime = block.timestamp;

            traderMarkets[msg.sender].push(marketId);
        } else {
            require(pos.side == side, "Close position first");
            
            // Increase position
            uint256 newSize = pos.size + size;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (market.markPrice * size)) / newSize;
            pos.size = newSize;
            pos.margin += margin;
        }

        // Update open interest
        if (side == Side.LONG) {
            market.openInterestLong += size;
        } else {
            market.openInterestShort += size;
        }

        emit PositionOpened(marketId, msg.sender, side, size, market.markPrice);
    }

    /**
     * @notice Close or reduce a position
     */
    function closePosition(
        bytes32 marketId,
        uint256 sizeToClose
    ) external nonReentrant {
        Position storage pos = positions[marketId][msg.sender];
        require(pos.size > 0, "No position");
        require(sizeToClose > 0 && sizeToClose <= pos.size, "Invalid size");

        Market storage market = markets[marketId];

        // Calculate PnL
        int256 pnl = _calculatePnL(pos, market.markPrice, sizeToClose);

        // Apply funding
        int256 funding = _calculateFunding(pos, marketId);
        pnl += funding;

        // Calculate fee
        uint256 notionalValue = (sizeToClose * market.markPrice) / 1e8;
        uint256 fee = (notionalValue * market.takerFee) / BASIS_POINTS;

        // Calculate margin to return
        uint256 marginToReturn = (pos.margin * sizeToClose) / pos.size;
        int256 totalReturn = int256(marginToReturn) + pnl - int256(fee);

        // Update position
        pos.size -= sizeToClose;
        pos.margin -= marginToReturn;

        if (pos.size == 0) {
            delete positions[marketId][msg.sender];
        }

        // Update open interest
        if (pos.side == Side.LONG) {
            market.openInterestLong -= sizeToClose;
        } else {
            market.openInterestShort -= sizeToClose;
        }

        // Transfer funds
        if (totalReturn > 0) {
            collateralToken.safeTransfer(msg.sender, uint256(totalReturn));
        } else if (totalReturn < 0) {
            // Loss exceeds margin, take from insurance fund
            uint256 shortfall = uint256(-totalReturn);
            if (shortfall <= insuranceFund) {
                insuranceFund -= shortfall;
            }
        }

        collateralToken.safeTransfer(feeRecipient, fee);

        emit PositionClosed(marketId, msg.sender, pnl);
    }

    /**
     * @notice Add margin to position
     */
    function addMargin(bytes32 marketId, uint256 amount) external nonReentrant {
        Position storage pos = positions[marketId][msg.sender];
        require(pos.size > 0, "No position");

        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        pos.margin += amount;

        emit MarginAdded(marketId, msg.sender, amount);
    }

    /**
     * @notice Remove excess margin from position
     */
    function removeMargin(bytes32 marketId, uint256 amount) external nonReentrant {
        Position storage pos = positions[marketId][msg.sender];
        require(pos.size > 0, "No position");

        Market storage market = markets[marketId];

        // Check if position remains healthy
        uint256 newMargin = pos.margin - amount;
        uint256 notionalValue = (pos.size * market.markPrice) / 1e8;
        uint256 minRequiredMargin = (notionalValue * market.maintenanceMargin) / BASIS_POINTS;
        
        require(newMargin >= minRequiredMargin, "Would be undercollateralized");

        pos.margin = newMargin;
        collateralToken.safeTransfer(msg.sender, amount);

        emit MarginRemoved(marketId, msg.sender, amount);
    }

    // ============ Liquidation ============

    /**
     * @notice Liquidate an undercollateralized position
     */
    function liquidate(bytes32 marketId, address trader) external nonReentrant onlyRole(KEEPER_ROLE) {
        Position storage pos = positions[marketId][trader];
        require(pos.size > 0, "No position");
        require(_isLiquidatable(marketId, trader), "Position healthy");

        Market storage market = markets[marketId];

        // Calculate remaining margin after losses
        int256 pnl = _calculatePnL(pos, market.markPrice, pos.size);
        int256 funding = _calculateFunding(pos, marketId);
        int256 totalPnl = pnl + funding;

        uint256 remainingMargin = 0;
        if (int256(pos.margin) + totalPnl > 0) {
            remainingMargin = uint256(int256(pos.margin) + totalPnl);
        }

        // Liquidation fee
        uint256 liquidatorReward = (remainingMargin * liquidationFee) / BASIS_POINTS;
        uint256 insuranceContribution = remainingMargin - liquidatorReward;

        // Update open interest
        if (pos.side == Side.LONG) {
            market.openInterestLong -= pos.size;
        } else {
            market.openInterestShort -= pos.size;
        }

        uint256 liquidatedSize = pos.size;

        // Clear position
        delete positions[marketId][trader];

        // Distribute funds
        if (liquidatorReward > 0) {
            collateralToken.safeTransfer(msg.sender, liquidatorReward);
        }
        insuranceFund += insuranceContribution;

        emit PositionLiquidated(marketId, trader, msg.sender, liquidatedSize);
    }

    /**
     * @notice Check if position is liquidatable
     */
    function _isLiquidatable(bytes32 marketId, address trader) internal view returns (bool) {
        Position storage pos = positions[marketId][trader];
        Market storage market = markets[marketId];

        if (pos.size == 0) return false;

        int256 pnl = _calculatePnL(pos, market.markPrice, pos.size);
        int256 funding = _calculateFunding(pos, marketId);
        int256 equity = int256(pos.margin) + pnl + funding;

        uint256 notionalValue = (pos.size * market.markPrice) / 1e8;
        uint256 maintenanceMargin = (notionalValue * market.maintenanceMargin) / BASIS_POINTS;

        return equity < int256(maintenanceMargin);
    }

    // ============ Order Management ============

    /**
     * @notice Place a limit order
     */
    function placeLimitOrder(
        bytes32 marketId,
        Side side,
        uint256 size,
        uint256 price,
        uint256 margin,
        uint256 leverage,
        uint256 expiresIn
    ) external nonReentrant whenNotPaused returns (uint256) {
        Market storage market = markets[marketId];
        require(market.isActive, "Market not active");
        require(leverage <= market.maxLeverage, "Invalid leverage");

        collateralToken.safeTransferFrom(msg.sender, address(this), margin);

        orderCounter++;
        uint256 orderId = orderCounter;

        orders[orderId] = Order({
            orderId: orderId,
            marketId: marketId,
            trader: msg.sender,
            side: side,
            orderType: OrderType.LIMIT,
            size: size,
            price: price,
            triggerPrice: 0,
            margin: margin,
            leverage: leverage,
            status: OrderStatus.OPEN,
            filledSize: 0,
            createdAt: block.timestamp,
            expiresAt: block.timestamp + expiresIn
        });

        traderOrders[msg.sender].push(orderId);

        emit OrderPlaced(orderId, marketId, msg.sender);

        return orderId;
    }

    /**
     * @notice Execute a limit order (keeper)
     */
    function executeOrder(uint256 orderId) external onlyRole(KEEPER_ROLE) {
        Order storage order = orders[orderId];
        require(order.status == OrderStatus.OPEN, "Order not open");
        require(block.timestamp <= order.expiresAt, "Order expired");

        Market storage market = markets[order.marketId];

        // Check if price condition is met
        bool shouldExecute;
        if (order.side == Side.LONG) {
            shouldExecute = market.markPrice <= order.price;
        } else {
            shouldExecute = market.markPrice >= order.price;
        }

        require(shouldExecute, "Price not reached");

        // Execute the order
        order.status = OrderStatus.FILLED;
        order.filledSize = order.size;

        // Open position
        _openPositionInternal(
            order.marketId,
            order.trader,
            order.side,
            order.size,
            order.margin,
            order.leverage,
            market.markPrice
        );

        emit OrderFilled(orderId, order.size, market.markPrice);
    }

    /**
     * @notice Cancel an open order
     */
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        require(order.trader == msg.sender, "Not your order");
        require(order.status == OrderStatus.OPEN, "Order not open");

        order.status = OrderStatus.CANCELLED;

        // Return margin
        collateralToken.safeTransfer(msg.sender, order.margin);

        emit OrderCancelled(orderId);
    }

    // ============ Funding ============

    /**
     * @notice Apply funding rate to all positions
     */
    function applyFunding(bytes32 marketId) external onlyRole(KEEPER_ROLE) {
        Market storage market = markets[marketId];
        require(block.timestamp >= market.lastFundingTime + FUNDING_INTERVAL, "Too early");

        // Calculate funding rate based on open interest imbalance
        int256 fundingRate;
        if (market.openInterestLong > market.openInterestShort) {
            // Longs pay shorts
            uint256 imbalance = market.openInterestLong - market.openInterestShort;
            fundingRate = int256((imbalance * 1e6) / (market.openInterestLong + 1));
        } else {
            // Shorts pay longs
            uint256 imbalance = market.openInterestShort - market.openInterestLong;
            fundingRate = -int256((imbalance * 1e6) / (market.openInterestShort + 1));
        }

        // Cap funding rate
        int256 maxFunding = 1e6; // 0.1%
        if (fundingRate > maxFunding) fundingRate = maxFunding;
        if (fundingRate < -maxFunding) fundingRate = -maxFunding;

        market.fundingRate = fundingRate;
        market.lastFundingTime = block.timestamp;

        // Update cumulative funding index
        cumulativeFundingIndex[marketId] += uint256(fundingRate > 0 ? fundingRate : -fundingRate);

        emit FundingPaid(marketId, fundingRate);
    }

    // ============ Internal Functions ============

    function _openPositionInternal(
        bytes32 marketId,
        address trader,
        Side side,
        uint256 size,
        uint256 margin,
        uint256 leverage,
        uint256 price
    ) internal {
        Position storage pos = positions[marketId][trader];
        Market storage market = markets[marketId];

        if (pos.size == 0) {
            pos.marketId = marketId;
            pos.trader = trader;
            pos.side = side;
            pos.size = size;
            pos.entryPrice = price;
            pos.margin = margin;
            pos.leverage = leverage;
            pos.lastFundingIndex = cumulativeFundingIndex[marketId];
            pos.openTime = block.timestamp;
        } else {
            uint256 newSize = pos.size + size;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (price * size)) / newSize;
            pos.size = newSize;
            pos.margin += margin;
        }

        if (side == Side.LONG) {
            market.openInterestLong += size;
        } else {
            market.openInterestShort += size;
        }
    }

    function _calculatePnL(
        Position storage pos,
        uint256 currentPrice,
        uint256 size
    ) internal view returns (int256) {
        int256 priceDiff = int256(currentPrice) - int256(pos.entryPrice);
        
        if (pos.side == Side.SHORT) {
            priceDiff = -priceDiff;
        }

        return (priceDiff * int256(size)) / 1e8;
    }

    function _calculateFunding(
        Position storage pos,
        bytes32 marketId
    ) internal view returns (int256) {
        uint256 fundingDiff = cumulativeFundingIndex[marketId] - pos.lastFundingIndex;
        int256 funding = int256((fundingDiff * pos.size) / 1e8);

        if (pos.side == Side.SHORT) {
            return funding;
        }
        return -funding;
    }

    // ============ View Functions ============

    function getPosition(bytes32 marketId, address trader) external view returns (Position memory) {
        return positions[marketId][trader];
    }

    function getMarket(bytes32 marketId) external view returns (Market memory) {
        return markets[marketId];
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function isLiquidatable(bytes32 marketId, address trader) external view returns (bool) {
        return _isLiquidatable(marketId, trader);
    }

    function getUnrealizedPnL(bytes32 marketId, address trader) external view returns (int256) {
        Position storage pos = positions[marketId][trader];
        if (pos.size == 0) return 0;

        Market storage market = markets[marketId];
        int256 pnl = _calculatePnL(pos, market.markPrice, pos.size);
        int256 funding = _calculateFunding(pos, marketId);
        return pnl + funding;
    }

    function getMarketList() external view returns (bytes32[] memory) {
        return marketList;
    }

    // ============ Admin Functions ============

    function setLiquidationFee(uint256 fee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(fee <= 1000, "Fee too high");
        liquidationFee = fee;
    }

    function setFeeRecipient(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeRecipient = recipient;
    }

    function withdrawInsuranceFund(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(amount <= insuranceFund, "Insufficient funds");
        insuranceFund -= amount;
        collateralToken.safeTransfer(msg.sender, amount);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
}
