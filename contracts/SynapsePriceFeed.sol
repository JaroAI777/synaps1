// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapsePriceFeed
 * @notice Decentralized price oracle with multi-source aggregation
 * @dev Supports multiple price reporters with weighted median calculation
 */
contract SynapsePriceFeed is AccessControl, Pausable {
    // ============ Roles ============
    
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ============ Structs ============

    struct PriceData {
        uint256 price;
        uint256 timestamp;
        uint256 roundId;
        uint8 decimals;
    }

    struct TokenConfig {
        string symbol;
        uint8 decimals;
        uint256 heartbeat;          // Max age of price data
        uint256 deviationThreshold; // Max deviation from previous (basis points)
        bool isActive;
    }

    struct ReporterData {
        uint256 price;
        uint256 timestamp;
        uint256 weight;
    }

    // ============ State Variables ============

    // Token => Latest price data
    mapping(address => PriceData) public latestPrices;
    
    // Token => Configuration
    mapping(address => TokenConfig) public tokenConfigs;
    
    // Token => Reporter => Price data
    mapping(address => mapping(address => ReporterData)) public reporterPrices;
    
    // Token => List of reporters
    mapping(address => address[]) public tokenReporters;
    
    // Reporter weights
    mapping(address => uint256) public reporterWeights;
    
    // Supported tokens list
    address[] public supportedTokens;
    
    // Round tracking
    mapping(address => uint256) public roundIds;

    // Constants
    uint256 public constant PRECISION = 1e18;
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MIN_REPORTERS = 3;
    uint256 public constant DEFAULT_HEARTBEAT = 1 hours;
    uint256 public constant DEFAULT_DEVIATION = 500; // 5%

    // ============ Events ============

    event PriceUpdated(
        address indexed token,
        uint256 price,
        uint256 roundId,
        uint256 timestamp
    );
    
    event TokenAdded(
        address indexed token,
        string symbol,
        uint8 decimals
    );
    
    event ReporterAdded(
        address indexed reporter,
        uint256 weight
    );
    
    event PriceReported(
        address indexed reporter,
        address indexed token,
        uint256 price,
        uint256 timestamp
    );

    event DeviationAlert(
        address indexed token,
        uint256 oldPrice,
        uint256 newPrice,
        uint256 deviation
    );

    // ============ Constructor ============

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(REPORTER_ROLE, msg.sender);

        // Set initial reporter weight
        reporterWeights[msg.sender] = 100;
    }

    // ============ Price Reporting ============

    /**
     * @notice Report price for a token
     */
    function reportPrice(address token, uint256 price) external onlyRole(REPORTER_ROLE) whenNotPaused {
        require(tokenConfigs[token].isActive, "Token not supported");
        require(price > 0, "Invalid price");

        TokenConfig storage config = tokenConfigs[token];
        
        // Check deviation from previous price
        if (latestPrices[token].price > 0) {
            uint256 deviation = _calculateDeviation(latestPrices[token].price, price);
            if (deviation > config.deviationThreshold) {
                emit DeviationAlert(token, latestPrices[token].price, price, deviation);
                // Still record the price, but emit alert
            }
        }

        // Store reporter's price
        reporterPrices[token][msg.sender] = ReporterData({
            price: price,
            timestamp: block.timestamp,
            weight: reporterWeights[msg.sender]
        });

        emit PriceReported(msg.sender, token, price, block.timestamp);

        // Try to update aggregated price
        _updateAggregatedPrice(token);
    }

    /**
     * @notice Batch report prices
     */
    function batchReportPrices(
        address[] calldata tokens,
        uint256[] calldata prices
    ) external onlyRole(REPORTER_ROLE) whenNotPaused {
        require(tokens.length == prices.length, "Length mismatch");

        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokenConfigs[tokens[i]].isActive && prices[i] > 0) {
                reporterPrices[tokens[i]][msg.sender] = ReporterData({
                    price: prices[i],
                    timestamp: block.timestamp,
                    weight: reporterWeights[msg.sender]
                });

                emit PriceReported(msg.sender, tokens[i], prices[i], block.timestamp);
                _updateAggregatedPrice(tokens[i]);
            }
        }
    }

    /**
     * @dev Update aggregated price using weighted median
     */
    function _updateAggregatedPrice(address token) internal {
        address[] storage reporters = tokenReporters[token];
        TokenConfig storage config = tokenConfigs[token];
        
        if (reporters.length < MIN_REPORTERS) {
            // Not enough reporters, use simple average of valid prices
            uint256 sum = 0;
            uint256 count = 0;
            uint256 currentTime = block.timestamp;

            for (uint256 i = 0; i < reporters.length; i++) {
                ReporterData storage data = reporterPrices[token][reporters[i]];
                if (data.timestamp > 0 && currentTime - data.timestamp <= config.heartbeat) {
                    sum += data.price;
                    count++;
                }
            }

            if (count > 0) {
                _setPrice(token, sum / count, config.decimals);
            }
            return;
        }

        // Collect valid prices with weights
        uint256[] memory validPrices = new uint256[](reporters.length);
        uint256[] memory weights = new uint256[](reporters.length);
        uint256 validCount = 0;
        uint256 currentTime = block.timestamp;

        for (uint256 i = 0; i < reporters.length; i++) {
            ReporterData storage data = reporterPrices[token][reporters[i]];
            if (data.timestamp > 0 && currentTime - data.timestamp <= config.heartbeat) {
                validPrices[validCount] = data.price;
                weights[validCount] = data.weight;
                validCount++;
            }
        }

        if (validCount >= MIN_REPORTERS) {
            uint256 medianPrice = _weightedMedian(validPrices, weights, validCount);
            _setPrice(token, medianPrice, config.decimals);
        }
    }

    /**
     * @dev Calculate weighted median
     */
    function _weightedMedian(
        uint256[] memory prices,
        uint256[] memory weights,
        uint256 count
    ) internal pure returns (uint256) {
        // Simple bubble sort for small arrays
        for (uint256 i = 0; i < count - 1; i++) {
            for (uint256 j = 0; j < count - i - 1; j++) {
                if (prices[j] > prices[j + 1]) {
                    (prices[j], prices[j + 1]) = (prices[j + 1], prices[j]);
                    (weights[j], weights[j + 1]) = (weights[j + 1], weights[j]);
                }
            }
        }

        // Calculate total weight
        uint256 totalWeight = 0;
        for (uint256 i = 0; i < count; i++) {
            totalWeight += weights[i];
        }

        // Find weighted median
        uint256 cumulativeWeight = 0;
        uint256 targetWeight = totalWeight / 2;

        for (uint256 i = 0; i < count; i++) {
            cumulativeWeight += weights[i];
            if (cumulativeWeight >= targetWeight) {
                return prices[i];
            }
        }

        return prices[count - 1];
    }

    /**
     * @dev Set the aggregated price
     */
    function _setPrice(address token, uint256 price, uint8 decimals) internal {
        roundIds[token]++;
        
        latestPrices[token] = PriceData({
            price: price,
            timestamp: block.timestamp,
            roundId: roundIds[token],
            decimals: decimals
        });

        emit PriceUpdated(token, price, roundIds[token], block.timestamp);
    }

    /**
     * @dev Calculate price deviation in basis points
     */
    function _calculateDeviation(uint256 oldPrice, uint256 newPrice) internal pure returns (uint256) {
        if (oldPrice == 0) return 0;
        
        uint256 diff = oldPrice > newPrice ? oldPrice - newPrice : newPrice - oldPrice;
        return (diff * BASIS_POINTS) / oldPrice;
    }

    // ============ View Functions ============

    /**
     * @notice Get latest price for token
     */
    function getLatestPrice(address token) external view returns (
        uint256 price,
        uint256 timestamp,
        uint8 decimals
    ) {
        PriceData storage data = latestPrices[token];
        require(data.timestamp > 0, "No price data");
        require(block.timestamp - data.timestamp <= tokenConfigs[token].heartbeat, "Price stale");
        
        return (data.price, data.timestamp, data.decimals);
    }

    /**
     * @notice Get price at specific round
     */
    function getRoundData(address token, uint256 roundId) external view returns (
        uint256 price,
        uint256 timestamp
    ) {
        require(roundId <= roundIds[token], "Round not found");
        // Note: This is simplified - full implementation would store historical rounds
        PriceData storage data = latestPrices[token];
        return (data.price, data.timestamp);
    }

    /**
     * @notice Check if price is fresh
     */
    function isPriceFresh(address token) external view returns (bool) {
        PriceData storage data = latestPrices[token];
        if (data.timestamp == 0) return false;
        return block.timestamp - data.timestamp <= tokenConfigs[token].heartbeat;
    }

    /**
     * @notice Get price in USD (assuming 8 decimals for USD)
     */
    function getPriceUSD(address token) external view returns (uint256) {
        PriceData storage data = latestPrices[token];
        require(data.timestamp > 0, "No price data");
        
        // Normalize to 8 decimals
        if (data.decimals == 8) {
            return data.price;
        } else if (data.decimals < 8) {
            return data.price * (10 ** (8 - data.decimals));
        } else {
            return data.price / (10 ** (data.decimals - 8));
        }
    }

    /**
     * @notice Get all reporter prices for a token
     */
    function getReporterPrices(address token) external view returns (
        address[] memory reporters,
        uint256[] memory prices,
        uint256[] memory timestamps
    ) {
        reporters = tokenReporters[token];
        prices = new uint256[](reporters.length);
        timestamps = new uint256[](reporters.length);

        for (uint256 i = 0; i < reporters.length; i++) {
            ReporterData storage data = reporterPrices[token][reporters[i]];
            prices[i] = data.price;
            timestamps[i] = data.timestamp;
        }
    }

    /**
     * @notice Get supported tokens count
     */
    function getSupportedTokensCount() external view returns (uint256) {
        return supportedTokens.length;
    }

    // ============ Admin Functions ============

    /**
     * @notice Add supported token
     */
    function addToken(
        address token,
        string calldata symbol,
        uint8 decimals,
        uint256 heartbeat,
        uint256 deviationThreshold
    ) external onlyRole(ADMIN_ROLE) {
        require(!tokenConfigs[token].isActive, "Token exists");

        tokenConfigs[token] = TokenConfig({
            symbol: symbol,
            decimals: decimals,
            heartbeat: heartbeat > 0 ? heartbeat : DEFAULT_HEARTBEAT,
            deviationThreshold: deviationThreshold > 0 ? deviationThreshold : DEFAULT_DEVIATION,
            isActive: true
        });

        supportedTokens.push(token);

        emit TokenAdded(token, symbol, decimals);
    }

    /**
     * @notice Update token config
     */
    function updateTokenConfig(
        address token,
        uint256 heartbeat,
        uint256 deviationThreshold,
        bool isActive
    ) external onlyRole(ADMIN_ROLE) {
        TokenConfig storage config = tokenConfigs[token];
        config.heartbeat = heartbeat;
        config.deviationThreshold = deviationThreshold;
        config.isActive = isActive;
    }

    /**
     * @notice Add reporter for token
     */
    function addReporter(address reporter, uint256 weight) external onlyRole(ADMIN_ROLE) {
        require(weight > 0, "Weight must be > 0");
        
        _grantRole(REPORTER_ROLE, reporter);
        reporterWeights[reporter] = weight;

        emit ReporterAdded(reporter, weight);
    }

    /**
     * @notice Add reporter to token
     */
    function addReporterToToken(address token, address reporter) external onlyRole(ADMIN_ROLE) {
        require(hasRole(REPORTER_ROLE, reporter), "Not a reporter");
        
        address[] storage reporters = tokenReporters[token];
        for (uint256 i = 0; i < reporters.length; i++) {
            require(reporters[i] != reporter, "Already added");
        }
        
        reporters.push(reporter);
    }

    /**
     * @notice Remove reporter from token
     */
    function removeReporterFromToken(address token, address reporter) external onlyRole(ADMIN_ROLE) {
        address[] storage reporters = tokenReporters[token];
        
        for (uint256 i = 0; i < reporters.length; i++) {
            if (reporters[i] == reporter) {
                reporters[i] = reporters[reporters.length - 1];
                reporters.pop();
                break;
            }
        }
    }

    /**
     * @notice Update reporter weight
     */
    function updateReporterWeight(address reporter, uint256 weight) external onlyRole(ADMIN_ROLE) {
        reporterWeights[reporter] = weight;
    }

    /**
     * @notice Emergency set price (admin override)
     */
    function emergencySetPrice(
        address token,
        uint256 price
    ) external onlyRole(ADMIN_ROLE) {
        require(tokenConfigs[token].isActive, "Token not supported");
        _setPrice(token, price, tokenConfigs[token].decimals);
    }

    /**
     * @notice Pause/unpause
     */
    function pause() external onlyRole(ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(ADMIN_ROLE) { _unpause(); }
}
