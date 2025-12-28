// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title ServiceRegistry
 * @notice Service Discovery Protocol (SDP) for SYNAPSE AI agents
 * @dev Allows AI agents to register, discover, and negotiate services
 * 
 * Features:
 * - Service registration with metadata
 * - Category-based discovery
 * - Price quoting and negotiation
 * - Service quality metrics
 * - Availability tracking
 */
contract ServiceRegistry is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    // ============ Constants ============
    
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint256 public constant MAX_SERVICES_PER_AGENT = 100;
    uint256 public constant PRICE_DECIMALS = 18;
    
    // ============ Enums ============
    
    enum PricingModel {
        PerRequest,      // Fixed price per request
        PerToken,        // Price per input/output token
        PerSecond,       // Time-based pricing
        PerByte,         // Data size based
        Subscription,    // Recurring payments
        Custom           // Custom pricing logic
    }
    
    enum ServiceStatus {
        Inactive,
        Active,
        Paused,
        Deprecated
    }
    
    // ============ Structs ============
    
    struct Service {
        bytes32 serviceId;
        address provider;
        bytes32 category;
        string name;
        string description;
        string metadataURI;     // IPFS URI for extended metadata
        string endpoint;        // API endpoint
        PricingModel pricingModel;
        uint256 basePrice;      // Base price in SYNX (18 decimals)
        uint256 minAmount;      // Minimum transaction amount
        uint256 maxAmount;      // Maximum transaction amount (0 = no limit)
        uint256 registrationTime;
        uint256 lastUpdateTime;
        ServiceStatus status;
        uint256 totalRequests;
        uint256 totalVolume;
    }
    
    struct VolumeDiscount {
        uint256 threshold;      // Volume threshold in SYNX
        uint256 discountBps;    // Discount in basis points
    }
    
    struct ServiceMetrics {
        uint256 avgResponseTime;    // In milliseconds
        uint256 successRate;        // In basis points (9500 = 95%)
        uint256 uptime;            // In basis points
        uint256 lastActiveTime;
        uint256 totalRatings;
        uint256 avgRating;         // 1-5 scale * 1000
    }
    
    struct ServiceQuote {
        bytes32 quoteId;
        bytes32 serviceId;
        address requester;
        uint256 estimatedAmount;
        uint256 validUntil;
        bool accepted;
        bytes32 params;         // Hash of request parameters
    }
    
    // ============ State Variables ============
    
    IERC20 public immutable synxToken;
    address public treasury;
    
    uint256 public registrationFee;
    uint256 public updateFee;
    uint256 public quoteFee;
    
    // Service storage
    mapping(bytes32 => Service) public services;
    mapping(bytes32 => ServiceMetrics) public serviceMetrics;
    mapping(bytes32 => VolumeDiscount[]) public volumeDiscounts;
    mapping(bytes32 => ServiceQuote) public quotes;
    
    // Indexing
    mapping(address => bytes32[]) public providerServices;
    mapping(bytes32 => bytes32[]) public categoryServices;
    bytes32[] public allCategories;
    mapping(bytes32 => bool) public categoryExists;
    
    // Statistics
    uint256 public totalServices;
    uint256 public activeServices;
    
    // ============ Events ============
    
    event ServiceRegistered(
        bytes32 indexed serviceId,
        address indexed provider,
        bytes32 indexed category,
        string name,
        uint256 basePrice
    );
    
    event ServiceUpdated(
        bytes32 indexed serviceId,
        uint256 newPrice,
        ServiceStatus newStatus
    );
    
    event ServiceDeactivated(bytes32 indexed serviceId);
    
    event MetricsUpdated(
        bytes32 indexed serviceId,
        uint256 avgResponseTime,
        uint256 successRate,
        uint256 uptime
    );
    
    event QuoteCreated(
        bytes32 indexed quoteId,
        bytes32 indexed serviceId,
        address indexed requester,
        uint256 estimatedAmount
    );
    
    event QuoteAccepted(bytes32 indexed quoteId);
    
    event CategoryAdded(bytes32 indexed category, string name);
    
    event ServiceRequest(
        bytes32 indexed serviceId,
        address indexed requester,
        uint256 amount
    );
    
    // ============ Errors ============
    
    error ServiceNotFound();
    error ServiceNotActive();
    error InvalidCategory();
    error TooManyServices();
    error InvalidPrice();
    error InvalidAmount();
    error QuoteNotFound();
    error QuoteExpired();
    error QuoteAlreadyAccepted();
    error Unauthorized();
    
    // ============ Constructor ============
    
    constructor(
        address _synxToken,
        address _treasury,
        uint256 _registrationFee
    ) {
        synxToken = IERC20(_synxToken);
        treasury = _treasury;
        registrationFee = _registrationFee;
        updateFee = _registrationFee / 10;
        quoteFee = _registrationFee / 100;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
        
        // Initialize default categories
        _addCategory(keccak256("LANGUAGE_MODEL"), "Language Model");
        _addCategory(keccak256("IMAGE_GENERATION"), "Image Generation");
        _addCategory(keccak256("CODE_GENERATION"), "Code Generation");
        _addCategory(keccak256("TRANSLATION"), "Translation");
        _addCategory(keccak256("DATA_ANALYSIS"), "Data Analysis");
        _addCategory(keccak256("REASONING"), "Reasoning");
        _addCategory(keccak256("EMBEDDING"), "Embedding");
        _addCategory(keccak256("SPEECH"), "Speech");
        _addCategory(keccak256("VISION"), "Vision");
        _addCategory(keccak256("MULTIMODAL"), "Multimodal");
        _addCategory(keccak256("AGENT"), "Agent");
        _addCategory(keccak256("TOOL"), "Tool");
        _addCategory(keccak256("CUSTOM"), "Custom");
    }
    
    // ============ Service Registration ============
    
    /**
     * @notice Register a new AI service
     */
    function registerService(
        bytes32 category,
        string calldata name,
        string calldata description,
        string calldata metadataURI,
        string calldata endpoint,
        PricingModel pricingModel,
        uint256 basePrice,
        uint256 minAmount,
        uint256 maxAmount
    ) external nonReentrant whenNotPaused returns (bytes32) {
        if (!categoryExists[category]) revert InvalidCategory();
        if (providerServices[msg.sender].length >= MAX_SERVICES_PER_AGENT) {
            revert TooManyServices();
        }
        if (basePrice == 0) revert InvalidPrice();
        
        // Pay registration fee
        if (registrationFee > 0) {
            synxToken.safeTransferFrom(msg.sender, treasury, registrationFee);
        }
        
        bytes32 serviceId = keccak256(abi.encodePacked(
            msg.sender,
            category,
            name,
            block.timestamp,
            totalServices
        ));
        
        services[serviceId] = Service({
            serviceId: serviceId,
            provider: msg.sender,
            category: category,
            name: name,
            description: description,
            metadataURI: metadataURI,
            endpoint: endpoint,
            pricingModel: pricingModel,
            basePrice: basePrice,
            minAmount: minAmount,
            maxAmount: maxAmount,
            registrationTime: block.timestamp,
            lastUpdateTime: block.timestamp,
            status: ServiceStatus.Active,
            totalRequests: 0,
            totalVolume: 0
        });
        
        serviceMetrics[serviceId] = ServiceMetrics({
            avgResponseTime: 0,
            successRate: 10000, // Start at 100%
            uptime: 10000,
            lastActiveTime: block.timestamp,
            totalRatings: 0,
            avgRating: 0
        });
        
        providerServices[msg.sender].push(serviceId);
        categoryServices[category].push(serviceId);
        
        totalServices++;
        activeServices++;
        
        emit ServiceRegistered(serviceId, msg.sender, category, name, basePrice);
        
        return serviceId;
    }
    
    /**
     * @notice Update service details
     */
    function updateService(
        bytes32 serviceId,
        string calldata description,
        string calldata metadataURI,
        string calldata endpoint,
        uint256 basePrice,
        uint256 minAmount,
        uint256 maxAmount
    ) external nonReentrant {
        Service storage service = services[serviceId];
        if (service.provider == address(0)) revert ServiceNotFound();
        if (service.provider != msg.sender) revert Unauthorized();
        
        // Pay update fee
        if (updateFee > 0) {
            synxToken.safeTransferFrom(msg.sender, treasury, updateFee);
        }
        
        if (bytes(description).length > 0) {
            service.description = description;
        }
        if (bytes(metadataURI).length > 0) {
            service.metadataURI = metadataURI;
        }
        if (bytes(endpoint).length > 0) {
            service.endpoint = endpoint;
        }
        if (basePrice > 0) {
            service.basePrice = basePrice;
        }
        service.minAmount = minAmount;
        service.maxAmount = maxAmount;
        service.lastUpdateTime = block.timestamp;
        
        emit ServiceUpdated(serviceId, basePrice, service.status);
    }
    
    /**
     * @notice Set service status
     */
    function setServiceStatus(bytes32 serviceId, ServiceStatus status) external {
        Service storage service = services[serviceId];
        if (service.provider == address(0)) revert ServiceNotFound();
        if (service.provider != msg.sender) revert Unauthorized();
        
        if (service.status == ServiceStatus.Active && status != ServiceStatus.Active) {
            activeServices--;
        } else if (service.status != ServiceStatus.Active && status == ServiceStatus.Active) {
            activeServices++;
        }
        
        service.status = status;
        service.lastUpdateTime = block.timestamp;
        
        emit ServiceUpdated(serviceId, service.basePrice, status);
    }
    
    /**
     * @notice Add volume discount tiers
     */
    function setVolumeDiscounts(
        bytes32 serviceId,
        uint256[] calldata thresholds,
        uint256[] calldata discounts
    ) external {
        Service storage service = services[serviceId];
        if (service.provider == address(0)) revert ServiceNotFound();
        if (service.provider != msg.sender) revert Unauthorized();
        if (thresholds.length != discounts.length) revert InvalidAmount();
        
        delete volumeDiscounts[serviceId];
        
        for (uint256 i = 0; i < thresholds.length; i++) {
            volumeDiscounts[serviceId].push(VolumeDiscount({
                threshold: thresholds[i],
                discountBps: discounts[i]
            }));
        }
    }
    
    // ============ Service Discovery ============
    
    /**
     * @notice Get services by category
     */
    function getServicesByCategory(bytes32 category) 
        external 
        view 
        returns (bytes32[] memory) 
    {
        return categoryServices[category];
    }
    
    /**
     * @notice Get services by provider
     */
    function getServicesByProvider(address provider) 
        external 
        view 
        returns (bytes32[] memory) 
    {
        return providerServices[provider];
    }
    
    /**
     * @notice Get active services in a category
     */
    function getActiveServicesByCategory(bytes32 category) 
        external 
        view 
        returns (bytes32[] memory) 
    {
        bytes32[] memory catServices = categoryServices[category];
        uint256 activeCount = 0;
        
        // Count active services
        for (uint256 i = 0; i < catServices.length; i++) {
            if (services[catServices[i]].status == ServiceStatus.Active) {
                activeCount++;
            }
        }
        
        // Build result array
        bytes32[] memory result = new bytes32[](activeCount);
        uint256 index = 0;
        for (uint256 i = 0; i < catServices.length; i++) {
            if (services[catServices[i]].status == ServiceStatus.Active) {
                result[index] = catServices[i];
                index++;
            }
        }
        
        return result;
    }
    
    // ============ Quoting ============
    
    /**
     * @notice Request a quote for a service
     */
    function requestQuote(
        bytes32 serviceId,
        bytes32 paramsHash,
        uint256 estimatedAmount
    ) external returns (bytes32) {
        Service storage service = services[serviceId];
        if (service.provider == address(0)) revert ServiceNotFound();
        if (service.status != ServiceStatus.Active) revert ServiceNotActive();
        
        // Pay quote fee
        if (quoteFee > 0) {
            synxToken.safeTransferFrom(msg.sender, treasury, quoteFee);
        }
        
        bytes32 quoteId = keccak256(abi.encodePacked(
            serviceId,
            msg.sender,
            paramsHash,
            block.timestamp
        ));
        
        // Calculate price with discounts
        uint256 finalAmount = _calculatePrice(serviceId, estimatedAmount, msg.sender);
        
        quotes[quoteId] = ServiceQuote({
            quoteId: quoteId,
            serviceId: serviceId,
            requester: msg.sender,
            estimatedAmount: finalAmount,
            validUntil: block.timestamp + 1 hours,
            accepted: false,
            params: paramsHash
        });
        
        emit QuoteCreated(quoteId, serviceId, msg.sender, finalAmount);
        
        return quoteId;
    }
    
    /**
     * @notice Accept a quote
     */
    function acceptQuote(bytes32 quoteId) external nonReentrant {
        ServiceQuote storage quote = quotes[quoteId];
        if (quote.requester == address(0)) revert QuoteNotFound();
        if (quote.requester != msg.sender) revert Unauthorized();
        if (block.timestamp > quote.validUntil) revert QuoteExpired();
        if (quote.accepted) revert QuoteAlreadyAccepted();
        
        Service storage service = services[quote.serviceId];
        if (service.status != ServiceStatus.Active) revert ServiceNotActive();
        
        quote.accepted = true;
        
        // Transfer payment to provider
        synxToken.safeTransferFrom(msg.sender, service.provider, quote.estimatedAmount);
        
        // Update service stats
        service.totalRequests++;
        service.totalVolume += quote.estimatedAmount;
        serviceMetrics[quote.serviceId].lastActiveTime = block.timestamp;
        
        emit QuoteAccepted(quoteId);
        emit ServiceRequest(quote.serviceId, msg.sender, quote.estimatedAmount);
    }
    
    // ============ Metrics Reporting ============
    
    /**
     * @notice Update service metrics (called by oracles)
     */
    function updateMetrics(
        bytes32 serviceId,
        uint256 avgResponseTime,
        uint256 successRate,
        uint256 uptime
    ) external onlyRole(OPERATOR_ROLE) {
        Service storage service = services[serviceId];
        if (service.provider == address(0)) revert ServiceNotFound();
        
        ServiceMetrics storage metrics = serviceMetrics[serviceId];
        metrics.avgResponseTime = avgResponseTime;
        metrics.successRate = successRate;
        metrics.uptime = uptime;
        metrics.lastActiveTime = block.timestamp;
        
        emit MetricsUpdated(serviceId, avgResponseTime, successRate, uptime);
    }
    
    /**
     * @notice Record a service request (for stats)
     */
    function recordRequest(
        bytes32 serviceId,
        address requester,
        uint256 amount,
        bool success,
        uint256 responseTime
    ) external onlyRole(OPERATOR_ROLE) {
        Service storage service = services[serviceId];
        if (service.provider == address(0)) revert ServiceNotFound();
        
        service.totalRequests++;
        service.totalVolume += amount;
        
        ServiceMetrics storage metrics = serviceMetrics[serviceId];
        
        // Update rolling average response time
        if (metrics.avgResponseTime == 0) {
            metrics.avgResponseTime = responseTime;
        } else {
            metrics.avgResponseTime = (metrics.avgResponseTime * 9 + responseTime) / 10;
        }
        
        // Update success rate
        uint256 successVal = success ? 10000 : 0;
        metrics.successRate = (metrics.successRate * 99 + successVal) / 100;
        
        metrics.lastActiveTime = block.timestamp;
        
        emit ServiceRequest(serviceId, requester, amount);
    }
    
    /**
     * @notice Rate a service
     */
    function rateService(bytes32 serviceId, uint8 rating) external {
        if (rating < 1 || rating > 5) revert InvalidAmount();
        
        Service storage service = services[serviceId];
        if (service.provider == address(0)) revert ServiceNotFound();
        
        ServiceMetrics storage metrics = serviceMetrics[serviceId];
        
        uint256 ratingScaled = uint256(rating) * 1000;
        
        if (metrics.totalRatings == 0) {
            metrics.avgRating = ratingScaled;
        } else {
            uint256 totalScore = metrics.avgRating * metrics.totalRatings + ratingScaled;
            metrics.avgRating = totalScore / (metrics.totalRatings + 1);
        }
        
        metrics.totalRatings++;
    }
    
    // ============ Price Calculation ============
    
    function _calculatePrice(
        bytes32 serviceId,
        uint256 baseAmount,
        address requester
    ) internal view returns (uint256) {
        Service storage service = services[serviceId];
        
        // Apply volume discounts
        VolumeDiscount[] storage discounts = volumeDiscounts[serviceId];
        uint256 discountBps = 0;
        
        for (uint256 i = 0; i < discounts.length; i++) {
            if (baseAmount >= discounts[i].threshold) {
                discountBps = discounts[i].discountBps;
            }
        }
        
        uint256 finalAmount = baseAmount;
        if (discountBps > 0) {
            finalAmount = baseAmount - (baseAmount * discountBps / 10000);
        }
        
        // Enforce min/max
        if (service.minAmount > 0 && finalAmount < service.minAmount) {
            finalAmount = service.minAmount;
        }
        if (service.maxAmount > 0 && finalAmount > service.maxAmount) {
            finalAmount = service.maxAmount;
        }
        
        return finalAmount;
    }
    
    /**
     * @notice Get estimated price for a service
     */
    function getEstimatedPrice(
        bytes32 serviceId,
        uint256 amount
    ) external view returns (uint256) {
        return _calculatePrice(serviceId, amount, msg.sender);
    }
    
    // ============ Category Management ============
    
    function _addCategory(bytes32 categoryId, string memory name) internal {
        if (!categoryExists[categoryId]) {
            allCategories.push(categoryId);
            categoryExists[categoryId] = true;
            emit CategoryAdded(categoryId, name);
        }
    }
    
    function addCategory(bytes32 categoryId, string calldata name) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        _addCategory(categoryId, name);
    }
    
    function getAllCategories() external view returns (bytes32[] memory) {
        return allCategories;
    }
    
    // ============ Admin Functions ============
    
    function setFees(
        uint256 _registrationFee,
        uint256 _updateFee,
        uint256 _quoteFee
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        registrationFee = _registrationFee;
        updateFee = _updateFee;
        quoteFee = _quoteFee;
    }
    
    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        treasury = _treasury;
    }
    
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }
    
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
    
    // ============ View Functions ============
    
    function getService(bytes32 serviceId) external view returns (Service memory) {
        return services[serviceId];
    }
    
    function getServiceMetrics(bytes32 serviceId) external view returns (ServiceMetrics memory) {
        return serviceMetrics[serviceId];
    }
    
    function getVolumeDiscounts(bytes32 serviceId) 
        external 
        view 
        returns (VolumeDiscount[] memory) 
    {
        return volumeDiscounts[serviceId];
    }
    
    function getQuote(bytes32 quoteId) external view returns (ServiceQuote memory) {
        return quotes[quoteId];
    }
    
    function isServiceActive(bytes32 serviceId) external view returns (bool) {
        return services[serviceId].status == ServiceStatus.Active;
    }
}
