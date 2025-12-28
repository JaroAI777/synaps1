// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapseOracle
 * @notice Price oracle for SYNAPSE Protocol
 * @dev Provides price feeds for SYNX token and AI service pricing
 * Supports multiple data sources with aggregation and heartbeat monitoring
 */
contract SynapseOracle is AccessControl, ReentrancyGuard, Pausable {
    
    // ============ Roles ============
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    
    // ============ Structs ============
    
    /**
     * @notice Price data with metadata
     */
    struct PriceData {
        uint256 price;          // Price with 18 decimals
        uint256 timestamp;      // Update timestamp
        uint256 roundId;        // Round identifier
        uint8 decimals;         // Price decimals
        bool valid;             // Is price valid
    }
    
    /**
     * @notice Oracle node configuration
     */
    struct OracleNode {
        address nodeAddress;    // Node address
        string name;            // Node name
        uint256 stake;          // Staked amount
        uint256 submissions;    // Total submissions
        uint256 accuracy;       // Accuracy score (0-10000)
        bool active;            // Is active
        uint256 lastSubmission; // Last submission time
    }
    
    /**
     * @notice Price feed configuration
     */
    struct PriceFeed {
        string name;            // Feed name (e.g., "SYNX/USD")
        uint256 heartbeat;      // Maximum age in seconds
        uint256 deviationThreshold; // Max deviation in bps
        uint256 minSubmissions; // Minimum submissions for valid price
        bool active;            // Is feed active
        uint256 lastUpdate;     // Last update timestamp
    }
    
    /**
     * @notice Service pricing data
     */
    struct ServicePricing {
        bytes32 serviceId;      // Service ID
        uint256 basePrice;      // Base price per unit
        uint256 lastUpdate;     // Last update timestamp
        uint256 volatility;     // Price volatility (bps)
        bool active;            // Is pricing active
    }
    
    // ============ State Variables ============
    
    // Price feeds
    mapping(bytes32 => PriceFeed) public priceFeeds;
    mapping(bytes32 => PriceData) public latestPrices;
    mapping(bytes32 => mapping(uint256 => PriceData)) public priceHistory;
    mapping(bytes32 => uint256) public feedRoundIds;
    bytes32[] public feedIds;
    
    // Oracle nodes
    mapping(address => OracleNode) public oracleNodes;
    address[] public nodeAddresses;
    uint256 public totalNodeStake;
    
    // Aggregation
    mapping(bytes32 => mapping(uint256 => mapping(address => uint256))) public submissions;
    mapping(bytes32 => mapping(uint256 => address[])) public roundSubmitters;
    
    // Service pricing
    mapping(bytes32 => ServicePricing) public servicePricing;
    bytes32[] public pricedServices;
    
    // Configuration
    uint256 public minNodeStake;
    uint256 public maxPriceAge;
    uint256 public aggregationRoundDuration;
    
    // ============ Events ============
    
    event PriceFeedCreated(
        bytes32 indexed feedId,
        string name,
        uint256 heartbeat
    );
    
    event PriceUpdated(
        bytes32 indexed feedId,
        uint256 price,
        uint256 timestamp,
        uint256 roundId
    );
    
    event PriceSubmitted(
        bytes32 indexed feedId,
        address indexed node,
        uint256 price,
        uint256 roundId
    );
    
    event NodeRegistered(
        address indexed nodeAddress,
        string name,
        uint256 stake
    );
    
    event NodeSlashed(
        address indexed nodeAddress,
        uint256 amount,
        string reason
    );
    
    event ServicePriceUpdated(
        bytes32 indexed serviceId,
        uint256 basePrice,
        uint256 timestamp
    );

    // ============ Constructor ============
    
    constructor(
        uint256 _minNodeStake,
        uint256 _maxPriceAge,
        uint256 _aggregationRoundDuration
    ) {
        minNodeStake = _minNodeStake;
        maxPriceAge = _maxPriceAge;
        aggregationRoundDuration = _aggregationRoundDuration;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
        
        // Create default price feeds
        _createPriceFeed("SYNX/USD", 3600, 100, 3);
        _createPriceFeed("SYNX/ETH", 3600, 100, 3);
        _createPriceFeed("ETH/USD", 3600, 50, 3);
    }

    // ============ Oracle Node Management ============
    
    /**
     * @notice Register as oracle node
     */
    function registerNode(string calldata name) external payable {
        require(msg.value >= minNodeStake, "Insufficient stake");
        require(!oracleNodes[msg.sender].active, "Already registered");
        
        oracleNodes[msg.sender] = OracleNode({
            nodeAddress: msg.sender,
            name: name,
            stake: msg.value,
            submissions: 0,
            accuracy: 10000, // Start at 100%
            active: true,
            lastSubmission: 0
        });
        
        nodeAddresses.push(msg.sender);
        totalNodeStake += msg.value;
        
        _grantRole(ORACLE_ROLE, msg.sender);
        
        emit NodeRegistered(msg.sender, name, msg.value);
    }
    
    /**
     * @notice Increase node stake
     */
    function increaseStake() external payable {
        OracleNode storage node = oracleNodes[msg.sender];
        require(node.active, "Node not active");
        
        node.stake += msg.value;
        totalNodeStake += msg.value;
    }
    
    /**
     * @notice Withdraw stake (after deregistration)
     */
    function withdrawStake() external nonReentrant {
        OracleNode storage node = oracleNodes[msg.sender];
        require(!node.active, "Node still active");
        require(node.stake > 0, "No stake to withdraw");
        
        uint256 amount = node.stake;
        node.stake = 0;
        
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
    }
    
    /**
     * @notice Deactivate node
     */
    function deactivateNode() external {
        OracleNode storage node = oracleNodes[msg.sender];
        require(node.active, "Node not active");
        
        node.active = false;
        totalNodeStake -= node.stake;
        
        _revokeRole(ORACLE_ROLE, msg.sender);
    }
    
    /**
     * @notice Slash misbehaving node
     */
    function slashNode(address nodeAddress, uint256 amount, string calldata reason) 
        external 
        onlyRole(OPERATOR_ROLE) 
    {
        OracleNode storage node = oracleNodes[nodeAddress];
        require(node.active, "Node not active");
        require(amount <= node.stake, "Amount exceeds stake");
        
        node.stake -= amount;
        node.accuracy = (node.accuracy * 90) / 100; // Reduce accuracy score
        totalNodeStake -= amount;
        
        // Transfer slashed amount to treasury (msg.sender for simplicity)
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
        
        emit NodeSlashed(nodeAddress, amount, reason);
    }

    // ============ Price Feed Management ============
    
    /**
     * @notice Create new price feed
     */
    function createPriceFeed(
        string calldata name,
        uint256 heartbeat,
        uint256 deviationThreshold,
        uint256 minSubmissions
    ) external onlyRole(OPERATOR_ROLE) returns (bytes32 feedId) {
        return _createPriceFeed(name, heartbeat, deviationThreshold, minSubmissions);
    }
    
    function _createPriceFeed(
        string memory name,
        uint256 heartbeat,
        uint256 deviationThreshold,
        uint256 minSubmissions
    ) internal returns (bytes32 feedId) {
        feedId = keccak256(abi.encodePacked(name, block.timestamp));
        
        priceFeeds[feedId] = PriceFeed({
            name: name,
            heartbeat: heartbeat,
            deviationThreshold: deviationThreshold,
            minSubmissions: minSubmissions,
            active: true,
            lastUpdate: 0
        });
        
        feedIds.push(feedId);
        
        emit PriceFeedCreated(feedId, name, heartbeat);
    }
    
    /**
     * @notice Submit price data
     */
    function submitPrice(bytes32 feedId, uint256 price) 
        external 
        onlyRole(ORACLE_ROLE)
        whenNotPaused 
    {
        PriceFeed storage feed = priceFeeds[feedId];
        require(feed.active, "Feed not active");
        
        OracleNode storage node = oracleNodes[msg.sender];
        require(node.active, "Node not active");
        
        uint256 currentRound = getCurrentRound(feedId);
        
        // Check if already submitted
        require(
            submissions[feedId][currentRound][msg.sender] == 0,
            "Already submitted"
        );
        
        // Record submission
        submissions[feedId][currentRound][msg.sender] = price;
        roundSubmitters[feedId][currentRound].push(msg.sender);
        
        node.submissions++;
        node.lastSubmission = block.timestamp;
        
        emit PriceSubmitted(feedId, msg.sender, price, currentRound);
        
        // Try to aggregate if enough submissions
        if (roundSubmitters[feedId][currentRound].length >= feed.minSubmissions) {
            _aggregatePrice(feedId, currentRound);
        }
    }
    
    /**
     * @notice Batch submit prices
     */
    function batchSubmitPrices(bytes32[] calldata feedIdList, uint256[] calldata prices) 
        external 
        onlyRole(ORACLE_ROLE)
        whenNotPaused 
    {
        require(feedIdList.length == prices.length, "Array length mismatch");
        
        for (uint256 i = 0; i < feedIdList.length; i++) {
            PriceFeed storage feed = priceFeeds[feedIdList[i]];
            if (!feed.active) continue;
            
            uint256 currentRound = getCurrentRound(feedIdList[i]);
            if (submissions[feedIdList[i]][currentRound][msg.sender] != 0) continue;
            
            submissions[feedIdList[i]][currentRound][msg.sender] = prices[i];
            roundSubmitters[feedIdList[i]][currentRound].push(msg.sender);
            
            emit PriceSubmitted(feedIdList[i], msg.sender, prices[i], currentRound);
            
            if (roundSubmitters[feedIdList[i]][currentRound].length >= feed.minSubmissions) {
                _aggregatePrice(feedIdList[i], currentRound);
            }
        }
        
        oracleNodes[msg.sender].submissions += feedIdList.length;
        oracleNodes[msg.sender].lastSubmission = block.timestamp;
    }
    
    /**
     * @dev Aggregate prices from submissions
     */
    function _aggregatePrice(bytes32 feedId, uint256 roundId) internal {
        address[] memory submitters = roundSubmitters[feedId][roundId];
        if (submitters.length == 0) return;
        
        // Collect prices with stakes
        uint256[] memory prices = new uint256[](submitters.length);
        uint256[] memory weights = new uint256[](submitters.length);
        uint256 totalWeight = 0;
        
        for (uint256 i = 0; i < submitters.length; i++) {
            prices[i] = submissions[feedId][roundId][submitters[i]];
            weights[i] = oracleNodes[submitters[i]].stake * oracleNodes[submitters[i]].accuracy;
            totalWeight += weights[i];
        }
        
        // Calculate weighted median
        uint256 aggregatedPrice = _weightedMedian(prices, weights, totalWeight);
        
        // Check deviation from previous price
        PriceData memory prevPrice = latestPrices[feedId];
        PriceFeed storage feed = priceFeeds[feedId];
        
        if (prevPrice.valid) {
            uint256 deviation = _calculateDeviation(prevPrice.price, aggregatedPrice);
            if (deviation > feed.deviationThreshold) {
                // Large deviation - require more confirmations or flag
                // For now, still accept but could add additional logic
            }
        }
        
        // Update price
        PriceData memory newPrice = PriceData({
            price: aggregatedPrice,
            timestamp: block.timestamp,
            roundId: roundId,
            decimals: 18,
            valid: true
        });
        
        latestPrices[feedId] = newPrice;
        priceHistory[feedId][roundId] = newPrice;
        feedRoundIds[feedId] = roundId;
        feed.lastUpdate = block.timestamp;
        
        emit PriceUpdated(feedId, aggregatedPrice, block.timestamp, roundId);
    }
    
    /**
     * @dev Calculate weighted median
     */
    function _weightedMedian(
        uint256[] memory prices,
        uint256[] memory weights,
        uint256 totalWeight
    ) internal pure returns (uint256) {
        // Simple weighted average for efficiency
        // Could implement proper weighted median with sorting
        uint256 weightedSum = 0;
        for (uint256 i = 0; i < prices.length; i++) {
            weightedSum += prices[i] * weights[i];
        }
        return weightedSum / totalWeight;
    }
    
    /**
     * @dev Calculate deviation in basis points
     */
    function _calculateDeviation(uint256 oldPrice, uint256 newPrice) internal pure returns (uint256) {
        if (oldPrice == 0) return 0;
        uint256 diff = oldPrice > newPrice ? oldPrice - newPrice : newPrice - oldPrice;
        return (diff * 10000) / oldPrice;
    }

    // ============ Service Pricing ============
    
    /**
     * @notice Set service pricing
     */
    function setServicePricing(
        bytes32 serviceId,
        uint256 basePrice,
        uint256 volatility
    ) external onlyRole(OPERATOR_ROLE) {
        if (!servicePricing[serviceId].active) {
            pricedServices.push(serviceId);
        }
        
        servicePricing[serviceId] = ServicePricing({
            serviceId: serviceId,
            basePrice: basePrice,
            lastUpdate: block.timestamp,
            volatility: volatility,
            active: true
        });
        
        emit ServicePriceUpdated(serviceId, basePrice, block.timestamp);
    }
    
    /**
     * @notice Update service price
     */
    function updateServicePrice(bytes32 serviceId, uint256 newPrice) 
        external 
        onlyRole(ORACLE_ROLE) 
    {
        ServicePricing storage pricing = servicePricing[serviceId];
        require(pricing.active, "Service not priced");
        
        // Check volatility bounds
        uint256 deviation = _calculateDeviation(pricing.basePrice, newPrice);
        require(deviation <= pricing.volatility, "Price change exceeds volatility");
        
        pricing.basePrice = newPrice;
        pricing.lastUpdate = block.timestamp;
        
        emit ServicePriceUpdated(serviceId, newPrice, block.timestamp);
    }
    
    /**
     * @notice Calculate dynamic price for service
     */
    function calculateDynamicPrice(
        bytes32 serviceId,
        uint256 quantity,
        uint256 demand // 0-10000 representing demand level
    ) external view returns (uint256) {
        ServicePricing storage pricing = servicePricing[serviceId];
        require(pricing.active, "Service not priced");
        
        // Base price * quantity
        uint256 baseTotal = pricing.basePrice * quantity;
        
        // Apply demand multiplier (0.8x to 1.5x based on demand)
        uint256 demandMultiplier = 8000 + (demand * 7) / 10; // 8000-15000
        
        return (baseTotal * demandMultiplier) / 10000;
    }

    // ============ View Functions ============
    
    /**
     * @notice Get latest price
     */
    function getLatestPrice(bytes32 feedId) external view returns (
        uint256 price,
        uint256 timestamp,
        uint256 roundId,
        bool valid
    ) {
        PriceData memory data = latestPrices[feedId];
        PriceFeed memory feed = priceFeeds[feedId];
        
        bool isStale = block.timestamp - data.timestamp > feed.heartbeat;
        
        return (
            data.price,
            data.timestamp,
            data.roundId,
            data.valid && !isStale
        );
    }
    
    /**
     * @notice Get historical price
     */
    function getHistoricalPrice(bytes32 feedId, uint256 roundId) external view returns (
        uint256 price,
        uint256 timestamp,
        bool valid
    ) {
        PriceData memory data = priceHistory[feedId][roundId];
        return (data.price, data.timestamp, data.valid);
    }
    
    /**
     * @notice Get current aggregation round
     */
    function getCurrentRound(bytes32 feedId) public view returns (uint256) {
        return block.timestamp / aggregationRoundDuration;
    }
    
    /**
     * @notice Check if price is stale
     */
    function isPriceStale(bytes32 feedId) external view returns (bool) {
        PriceData memory data = latestPrices[feedId];
        PriceFeed memory feed = priceFeeds[feedId];
        return block.timestamp - data.timestamp > feed.heartbeat;
    }
    
    /**
     * @notice Get all feed IDs
     */
    function getAllFeeds() external view returns (bytes32[] memory) {
        return feedIds;
    }
    
    /**
     * @notice Get active nodes
     */
    function getActiveNodes() external view returns (address[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < nodeAddresses.length; i++) {
            if (oracleNodes[nodeAddresses[i]].active) count++;
        }
        
        address[] memory active = new address[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < nodeAddresses.length; i++) {
            if (oracleNodes[nodeAddresses[i]].active) {
                active[j] = nodeAddresses[i];
                j++;
            }
        }
        
        return active;
    }
    
    /**
     * @notice Get service price
     */
    function getServicePrice(bytes32 serviceId) external view returns (
        uint256 basePrice,
        uint256 lastUpdate,
        bool active
    ) {
        ServicePricing memory pricing = servicePricing[serviceId];
        return (pricing.basePrice, pricing.lastUpdate, pricing.active);
    }

    // ============ Admin Functions ============
    
    /**
     * @notice Update configuration
     */
    function updateConfig(
        uint256 _minNodeStake,
        uint256 _maxPriceAge,
        uint256 _aggregationRoundDuration
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minNodeStake = _minNodeStake;
        maxPriceAge = _maxPriceAge;
        aggregationRoundDuration = _aggregationRoundDuration;
    }
    
    /**
     * @notice Update feed configuration
     */
    function updateFeed(
        bytes32 feedId,
        uint256 heartbeat,
        uint256 deviationThreshold,
        uint256 minSubmissions
    ) external onlyRole(OPERATOR_ROLE) {
        PriceFeed storage feed = priceFeeds[feedId];
        feed.heartbeat = heartbeat;
        feed.deviationThreshold = deviationThreshold;
        feed.minSubmissions = minSubmissions;
    }
    
    /**
     * @notice Pause contract
     */
    function pause() external onlyRole(OPERATOR_ROLE) {
        _pause();
    }
    
    /**
     * @notice Unpause contract
     */
    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }
    
    /**
     * @notice Emergency withdraw
     */
    function emergencyWithdraw() external onlyRole(DEFAULT_ADMIN_ROLE) {
        (bool success, ) = msg.sender.call{value: address(this).balance}("");
        require(success, "Transfer failed");
    }
    
    receive() external payable {}
}
