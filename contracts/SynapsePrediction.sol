// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapsePrediction
 * @notice Decentralized prediction markets for any event
 * @dev Supports binary, categorical, and scalar outcomes
 */
contract SynapsePrediction is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Roles ============
    
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant MARKET_CREATOR_ROLE = keccak256("MARKET_CREATOR_ROLE");

    // ============ Enums ============

    enum MarketType { BINARY, CATEGORICAL, SCALAR }
    enum MarketStatus { OPEN, CLOSED, RESOLVED, CANCELLED }
    enum OutcomeResult { PENDING, YES, NO, INVALID }

    // ============ Structs ============

    struct Market {
        uint256 marketId;
        address creator;
        string question;
        string description;
        MarketType marketType;
        MarketStatus status;
        address collateralToken;
        uint256 resolutionTime;
        uint256 createdAt;
        uint256 totalVolume;
        uint256 liquidityPool;
        uint256 creatorFee;         // Basis points
        uint256 protocolFee;        // Basis points
    }

    struct BinaryMarket {
        uint256 yesShares;
        uint256 noShares;
        uint256 yesPrice;           // Current price (basis points)
        uint256 noPrice;
        OutcomeResult result;
    }

    struct CategoricalMarket {
        string[] outcomes;
        uint256[] shares;
        uint256[] prices;
        uint256 winningOutcome;
    }

    struct ScalarMarket {
        uint256 lowerBound;
        uint256 upperBound;
        uint256 resolvedValue;
        uint256 longShares;
        uint256 shortShares;
    }

    struct Position {
        uint256 yesShares;
        uint256 noShares;
        uint256 totalInvested;
        uint256 claimedWinnings;
    }

    struct OrderBook {
        Order[] buyOrders;
        Order[] sellOrders;
    }

    struct Order {
        uint256 orderId;
        address trader;
        bool isBuy;
        uint256 outcome;            // 0 = YES, 1 = NO for binary
        uint256 shares;
        uint256 price;              // Limit price
        uint256 filled;
        bool isActive;
        uint256 createdAt;
    }

    // ============ State Variables ============

    IERC20 public immutable defaultToken;

    // Markets
    mapping(uint256 => Market) public markets;
    mapping(uint256 => BinaryMarket) public binaryMarkets;
    mapping(uint256 => CategoricalMarket) public categoricalMarkets;
    mapping(uint256 => ScalarMarket) public scalarMarkets;
    uint256 public marketCounter;

    // Positions: marketId => user => Position
    mapping(uint256 => mapping(address => Position)) public positions;

    // Order book
    mapping(uint256 => OrderBook) internal orderBooks;
    uint256 public orderCounter;

    // Liquidity providers
    mapping(uint256 => mapping(address => uint256)) public lpShares;
    mapping(uint256 => uint256) public totalLPShares;

    // Fees
    uint256 public defaultProtocolFee = 100;    // 1%
    uint256 public defaultCreatorFee = 100;     // 1%
    uint256 public constant MAX_FEE = 500;      // 5%
    uint256 public constant BASIS_POINTS = 10000;
    address public feeRecipient;

    // AMM constant product
    uint256 public constant INITIAL_LIQUIDITY = 1000 * 1e18;

    // ============ Events ============

    event MarketCreated(uint256 indexed marketId, address indexed creator, string question, MarketType marketType);
    event SharesPurchased(uint256 indexed marketId, address indexed trader, uint256 outcome, uint256 shares, uint256 cost);
    event SharesSold(uint256 indexed marketId, address indexed trader, uint256 outcome, uint256 shares, uint256 proceeds);
    event MarketResolved(uint256 indexed marketId, uint256 winningOutcome);
    event WinningsClaimed(uint256 indexed marketId, address indexed user, uint256 amount);
    event LiquidityAdded(uint256 indexed marketId, address indexed provider, uint256 amount);
    event LiquidityRemoved(uint256 indexed marketId, address indexed provider, uint256 amount);
    event OrderPlaced(uint256 indexed marketId, uint256 indexed orderId, address indexed trader);
    event OrderFilled(uint256 indexed orderId, uint256 filled);
    event OrderCancelled(uint256 indexed orderId);

    // ============ Constructor ============

    constructor(address _defaultToken) {
        defaultToken = IERC20(_defaultToken);
        feeRecipient = msg.sender;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, msg.sender);
        _grantRole(MARKET_CREATOR_ROLE, msg.sender);
    }

    // ============ Market Creation ============

    /**
     * @notice Create a binary (YES/NO) prediction market
     */
    function createBinaryMarket(
        string calldata question,
        string calldata description,
        uint256 resolutionTime,
        uint256 initialLiquidity,
        uint256 creatorFee
    ) external onlyRole(MARKET_CREATOR_ROLE) returns (uint256) {
        require(resolutionTime > block.timestamp, "Resolution in past");
        require(creatorFee <= MAX_FEE, "Fee too high");
        require(initialLiquidity >= INITIAL_LIQUIDITY, "Insufficient liquidity");

        marketCounter++;
        uint256 marketId = marketCounter;

        // Transfer initial liquidity
        defaultToken.safeTransferFrom(msg.sender, address(this), initialLiquidity);

        markets[marketId] = Market({
            marketId: marketId,
            creator: msg.sender,
            question: question,
            description: description,
            marketType: MarketType.BINARY,
            status: MarketStatus.OPEN,
            collateralToken: address(defaultToken),
            resolutionTime: resolutionTime,
            createdAt: block.timestamp,
            totalVolume: 0,
            liquidityPool: initialLiquidity,
            creatorFee: creatorFee,
            protocolFee: defaultProtocolFee
        });

        // Initialize with 50/50 odds
        binaryMarkets[marketId] = BinaryMarket({
            yesShares: initialLiquidity / 2,
            noShares: initialLiquidity / 2,
            yesPrice: 5000,     // 50%
            noPrice: 5000,      // 50%
            result: OutcomeResult.PENDING
        });

        // LP shares to creator
        lpShares[marketId][msg.sender] = initialLiquidity;
        totalLPShares[marketId] = initialLiquidity;

        emit MarketCreated(marketId, msg.sender, question, MarketType.BINARY);

        return marketId;
    }

    /**
     * @notice Create a categorical market with multiple outcomes
     */
    function createCategoricalMarket(
        string calldata question,
        string calldata description,
        string[] calldata outcomes,
        uint256 resolutionTime,
        uint256 initialLiquidity
    ) external onlyRole(MARKET_CREATOR_ROLE) returns (uint256) {
        require(outcomes.length >= 2 && outcomes.length <= 10, "Invalid outcomes");
        require(resolutionTime > block.timestamp, "Resolution in past");

        marketCounter++;
        uint256 marketId = marketCounter;

        defaultToken.safeTransferFrom(msg.sender, address(this), initialLiquidity);

        markets[marketId] = Market({
            marketId: marketId,
            creator: msg.sender,
            question: question,
            description: description,
            marketType: MarketType.CATEGORICAL,
            status: MarketStatus.OPEN,
            collateralToken: address(defaultToken),
            resolutionTime: resolutionTime,
            createdAt: block.timestamp,
            totalVolume: 0,
            liquidityPool: initialLiquidity,
            creatorFee: defaultCreatorFee,
            protocolFee: defaultProtocolFee
        });

        // Initialize shares and prices
        uint256 sharePerOutcome = initialLiquidity / outcomes.length;
        uint256 pricePerOutcome = BASIS_POINTS / outcomes.length;

        uint256[] memory shares = new uint256[](outcomes.length);
        uint256[] memory prices = new uint256[](outcomes.length);

        for (uint256 i = 0; i < outcomes.length; i++) {
            shares[i] = sharePerOutcome;
            prices[i] = pricePerOutcome;
        }

        categoricalMarkets[marketId].outcomes = outcomes;
        categoricalMarkets[marketId].shares = shares;
        categoricalMarkets[marketId].prices = prices;

        lpShares[marketId][msg.sender] = initialLiquidity;
        totalLPShares[marketId] = initialLiquidity;

        emit MarketCreated(marketId, msg.sender, question, MarketType.CATEGORICAL);

        return marketId;
    }

    // ============ Trading ============

    /**
     * @notice Buy outcome shares in a binary market
     */
    function buyBinaryShares(
        uint256 marketId,
        bool buyYes,
        uint256 amount,
        uint256 maxCost
    ) external nonReentrant whenNotPaused {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.OPEN, "Market not open");
        require(block.timestamp < market.resolutionTime, "Market closed");

        BinaryMarket storage binary = binaryMarkets[marketId];

        // Calculate cost using constant product AMM
        uint256 cost;
        uint256 sharesOut;

        if (buyYes) {
            // Buy YES: deposit collateral, get YES shares
            (sharesOut, cost) = _calculateBuyCost(binary.noShares, binary.yesShares, amount);
            require(cost <= maxCost, "Cost exceeds max");

            binary.yesShares -= sharesOut;
            binary.noShares += cost;
            positions[marketId][msg.sender].yesShares += sharesOut;
        } else {
            // Buy NO: deposit collateral, get NO shares
            (sharesOut, cost) = _calculateBuyCost(binary.yesShares, binary.noShares, amount);
            require(cost <= maxCost, "Cost exceeds max");

            binary.noShares -= sharesOut;
            binary.yesShares += cost;
            positions[marketId][msg.sender].noShares += sharesOut;
        }

        // Transfer payment
        defaultToken.safeTransferFrom(msg.sender, address(this), cost);

        // Apply fees
        uint256 totalFee = (cost * (market.creatorFee + market.protocolFee)) / BASIS_POINTS;
        market.liquidityPool += cost - totalFee;
        market.totalVolume += cost;

        positions[marketId][msg.sender].totalInvested += cost;

        // Update prices
        _updateBinaryPrices(marketId);

        emit SharesPurchased(marketId, msg.sender, buyYes ? 0 : 1, sharesOut, cost);
    }

    /**
     * @notice Sell outcome shares in a binary market
     */
    function sellBinaryShares(
        uint256 marketId,
        bool sellYes,
        uint256 shares,
        uint256 minProceeds
    ) external nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.OPEN, "Market not open");

        BinaryMarket storage binary = binaryMarkets[marketId];
        Position storage pos = positions[marketId][msg.sender];

        uint256 proceeds;

        if (sellYes) {
            require(pos.yesShares >= shares, "Insufficient shares");
            proceeds = _calculateSellProceeds(binary.yesShares, binary.noShares, shares);
            require(proceeds >= minProceeds, "Proceeds below min");

            pos.yesShares -= shares;
            binary.yesShares += shares;
            binary.noShares -= proceeds;
        } else {
            require(pos.noShares >= shares, "Insufficient shares");
            proceeds = _calculateSellProceeds(binary.noShares, binary.yesShares, shares);
            require(proceeds >= minProceeds, "Proceeds below min");

            pos.noShares -= shares;
            binary.noShares += shares;
            binary.yesShares -= proceeds;
        }

        // Transfer proceeds
        defaultToken.safeTransfer(msg.sender, proceeds);

        market.totalVolume += proceeds;

        _updateBinaryPrices(marketId);

        emit SharesSold(marketId, msg.sender, sellYes ? 0 : 1, shares, proceeds);
    }

    // ============ AMM Math ============

    function _calculateBuyCost(
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 amountOut
    ) internal pure returns (uint256 sharesOut, uint256 amountIn) {
        require(amountOut < reserveOut, "Insufficient liquidity");
        
        // Constant product: x * y = k
        uint256 k = reserveIn * reserveOut;
        uint256 newReserveOut = reserveOut - amountOut;
        uint256 newReserveIn = k / newReserveOut;
        
        amountIn = newReserveIn - reserveIn;
        sharesOut = amountOut;
    }

    function _calculateSellProceeds(
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 amountIn
    ) internal pure returns (uint256 amountOut) {
        uint256 k = reserveIn * reserveOut;
        uint256 newReserveIn = reserveIn + amountIn;
        uint256 newReserveOut = k / newReserveIn;
        
        amountOut = reserveOut - newReserveOut;
    }

    function _updateBinaryPrices(uint256 marketId) internal {
        BinaryMarket storage binary = binaryMarkets[marketId];
        uint256 total = binary.yesShares + binary.noShares;
        
        if (total > 0) {
            binary.yesPrice = (binary.noShares * BASIS_POINTS) / total;
            binary.noPrice = (binary.yesShares * BASIS_POINTS) / total;
        }
    }

    // ============ Resolution ============

    /**
     * @notice Resolve a binary market
     */
    function resolveBinaryMarket(
        uint256 marketId,
        OutcomeResult result
    ) external onlyRole(ORACLE_ROLE) {
        Market storage market = markets[marketId];
        require(market.marketType == MarketType.BINARY, "Not binary market");
        require(market.status == MarketStatus.OPEN, "Market not open");
        require(block.timestamp >= market.resolutionTime, "Too early");
        require(result != OutcomeResult.PENDING, "Invalid result");

        market.status = MarketStatus.RESOLVED;
        binaryMarkets[marketId].result = result;

        emit MarketResolved(marketId, result == OutcomeResult.YES ? 0 : 1);
    }

    /**
     * @notice Resolve a categorical market
     */
    function resolveCategoricalMarket(
        uint256 marketId,
        uint256 winningOutcome
    ) external onlyRole(ORACLE_ROLE) {
        Market storage market = markets[marketId];
        require(market.marketType == MarketType.CATEGORICAL, "Not categorical");
        require(market.status == MarketStatus.OPEN, "Market not open");
        require(block.timestamp >= market.resolutionTime, "Too early");

        CategoricalMarket storage cat = categoricalMarkets[marketId];
        require(winningOutcome < cat.outcomes.length, "Invalid outcome");

        market.status = MarketStatus.RESOLVED;
        cat.winningOutcome = winningOutcome;

        emit MarketResolved(marketId, winningOutcome);
    }

    /**
     * @notice Cancel a market and allow refunds
     */
    function cancelMarket(uint256 marketId) external onlyRole(ORACLE_ROLE) {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.OPEN, "Market not open");

        market.status = MarketStatus.CANCELLED;

        emit MarketResolved(marketId, type(uint256).max);
    }

    // ============ Claims ============

    /**
     * @notice Claim winnings from a resolved binary market
     */
    function claimBinaryWinnings(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.RESOLVED, "Not resolved");

        BinaryMarket storage binary = binaryMarkets[marketId];
        Position storage pos = positions[marketId][msg.sender];

        uint256 winnings = 0;

        if (binary.result == OutcomeResult.YES) {
            winnings = pos.yesShares;
            pos.yesShares = 0;
        } else if (binary.result == OutcomeResult.NO) {
            winnings = pos.noShares;
            pos.noShares = 0;
        } else if (binary.result == OutcomeResult.INVALID) {
            // Refund based on investment ratio
            winnings = pos.totalInvested - pos.claimedWinnings;
        }

        require(winnings > 0, "No winnings");
        pos.claimedWinnings += winnings;

        defaultToken.safeTransfer(msg.sender, winnings);

        emit WinningsClaimed(marketId, msg.sender, winnings);
    }

    /**
     * @notice Claim refund from cancelled market
     */
    function claimRefund(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.CANCELLED, "Not cancelled");

        Position storage pos = positions[marketId][msg.sender];
        uint256 refund = pos.totalInvested - pos.claimedWinnings;
        require(refund > 0, "Nothing to claim");

        pos.claimedWinnings = pos.totalInvested;

        defaultToken.safeTransfer(msg.sender, refund);

        emit WinningsClaimed(marketId, msg.sender, refund);
    }

    // ============ Liquidity ============

    /**
     * @notice Add liquidity to a market
     */
    function addLiquidity(uint256 marketId, uint256 amount) external nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.OPEN, "Market not open");

        defaultToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 shares = (amount * totalLPShares[marketId]) / market.liquidityPool;
        lpShares[marketId][msg.sender] += shares;
        totalLPShares[marketId] += shares;
        market.liquidityPool += amount;

        // Add to both sides proportionally
        if (market.marketType == MarketType.BINARY) {
            BinaryMarket storage binary = binaryMarkets[marketId];
            uint256 total = binary.yesShares + binary.noShares;
            binary.yesShares += (amount * binary.yesShares) / total;
            binary.noShares += (amount * binary.noShares) / total;
        }

        emit LiquidityAdded(marketId, msg.sender, amount);
    }

    /**
     * @notice Remove liquidity from a market
     */
    function removeLiquidity(uint256 marketId, uint256 shares) external nonReentrant {
        Market storage market = markets[marketId];
        require(lpShares[marketId][msg.sender] >= shares, "Insufficient LP shares");

        uint256 amount = (shares * market.liquidityPool) / totalLPShares[marketId];
        
        lpShares[marketId][msg.sender] -= shares;
        totalLPShares[marketId] -= shares;
        market.liquidityPool -= amount;

        defaultToken.safeTransfer(msg.sender, amount);

        emit LiquidityRemoved(marketId, msg.sender, amount);
    }

    // ============ View Functions ============

    function getMarket(uint256 marketId) external view returns (Market memory) {
        return markets[marketId];
    }

    function getBinaryMarket(uint256 marketId) external view returns (BinaryMarket memory) {
        return binaryMarkets[marketId];
    }

    function getPosition(uint256 marketId, address user) external view returns (Position memory) {
        return positions[marketId][user];
    }

    function getLPShare(uint256 marketId, address user) external view returns (uint256) {
        return lpShares[marketId][user];
    }

    function getBinaryPrice(uint256 marketId) external view returns (uint256 yesPrice, uint256 noPrice) {
        BinaryMarket storage binary = binaryMarkets[marketId];
        return (binary.yesPrice, binary.noPrice);
    }

    function estimateBuyCost(
        uint256 marketId,
        bool buyYes,
        uint256 shares
    ) external view returns (uint256 cost) {
        BinaryMarket storage binary = binaryMarkets[marketId];
        
        if (buyYes) {
            (, cost) = _calculateBuyCost(binary.noShares, binary.yesShares, shares);
        } else {
            (, cost) = _calculateBuyCost(binary.yesShares, binary.noShares, shares);
        }
    }

    // ============ Admin Functions ============

    function setDefaultFees(uint256 _protocolFee, uint256 _creatorFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_protocolFee + _creatorFee <= MAX_FEE, "Fees too high");
        defaultProtocolFee = _protocolFee;
        defaultCreatorFee = _creatorFee;
    }

    function setFeeRecipient(address _recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeRecipient = _recipient;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
}
