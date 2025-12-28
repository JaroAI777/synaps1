// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SubscriptionManager
 * @notice Manages recurring subscriptions and payments for AI services
 * @dev Supports multiple billing periods, trial periods, and usage-based billing
 */
contract SubscriptionManager is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Roles ============
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PROVIDER_ROLE = keccak256("PROVIDER_ROLE");

    // ============ Structs ============
    
    /**
     * @notice Subscription plan definition
     */
    struct Plan {
        address provider;           // Service provider address
        string name;                // Plan name
        string description;         // Plan description
        uint256 basePrice;          // Base price per period
        uint256 billingPeriod;      // Billing period in seconds
        uint256 trialPeriod;        // Trial period in seconds (0 = no trial)
        uint256 usageLimit;         // Usage limit per period (0 = unlimited)
        uint256 overageRate;        // Rate for usage over limit (per unit)
        bool active;                // Is plan active
        uint256 subscriberCount;    // Number of active subscribers
        uint256 totalRevenue;       // Total revenue generated
        uint256 createdAt;          // Creation timestamp
    }

    /**
     * @notice Active subscription
     */
    struct Subscription {
        bytes32 planId;             // Plan ID
        address subscriber;         // Subscriber address
        uint256 startTime;          // Subscription start time
        uint256 currentPeriodStart; // Current billing period start
        uint256 currentPeriodEnd;   // Current billing period end
        uint256 usageThisPeriod;    // Usage in current period
        uint256 totalPaid;          // Total amount paid
        uint256 balance;            // Prepaid balance
        bool active;                // Is subscription active
        bool inTrial;               // Is in trial period
        uint256 cancelledAt;        // Cancellation timestamp (0 = not cancelled)
    }

    /**
     * @notice Usage record
     */
    struct UsageRecord {
        bytes32 subscriptionId;     // Subscription ID
        uint256 amount;             // Usage amount
        uint256 timestamp;          // Record timestamp
        bytes32 referenceId;        // External reference ID
    }

    // ============ State Variables ============
    
    IERC20 public token;
    address public treasury;
    uint256 public platformFeeBps; // Platform fee in basis points
    
    // Plan storage
    mapping(bytes32 => Plan) public plans;
    bytes32[] public planIds;
    mapping(address => bytes32[]) public providerPlans;
    
    // Subscription storage
    mapping(bytes32 => Subscription) public subscriptions;
    bytes32[] public subscriptionIds;
    mapping(address => bytes32[]) public subscriberSubscriptions;
    mapping(bytes32 => bytes32[]) public planSubscriptions; // planId => subscriptionIds
    
    // Usage storage
    mapping(bytes32 => UsageRecord[]) public usageRecords;
    
    // Configuration
    uint256 public constant MAX_FEE_BPS = 1000; // 10% max fee
    uint256 public constant MIN_BILLING_PERIOD = 1 hours;
    uint256 public constant MAX_BILLING_PERIOD = 365 days;
    
    // ============ Events ============
    
    event PlanCreated(
        bytes32 indexed planId,
        address indexed provider,
        string name,
        uint256 basePrice,
        uint256 billingPeriod
    );
    
    event PlanUpdated(bytes32 indexed planId);
    event PlanDeactivated(bytes32 indexed planId);
    event PlanActivated(bytes32 indexed planId);
    
    event Subscribed(
        bytes32 indexed subscriptionId,
        bytes32 indexed planId,
        address indexed subscriber,
        uint256 startTime
    );
    
    event SubscriptionRenewed(
        bytes32 indexed subscriptionId,
        uint256 periodStart,
        uint256 periodEnd,
        uint256 amountPaid
    );
    
    event SubscriptionCancelled(
        bytes32 indexed subscriptionId,
        address indexed subscriber,
        uint256 cancelledAt
    );
    
    event UsageRecorded(
        bytes32 indexed subscriptionId,
        uint256 amount,
        bytes32 referenceId
    );
    
    event PaymentProcessed(
        bytes32 indexed subscriptionId,
        address indexed subscriber,
        address indexed provider,
        uint256 amount,
        uint256 fee
    );
    
    event BalanceAdded(
        bytes32 indexed subscriptionId,
        uint256 amount
    );
    
    event OverageCharged(
        bytes32 indexed subscriptionId,
        uint256 usage,
        uint256 amount
    );

    // ============ Constructor ============
    
    constructor(
        address _token,
        address _treasury,
        uint256 _platformFeeBps
    ) {
        require(_token != address(0), "Invalid token");
        require(_treasury != address(0), "Invalid treasury");
        require(_platformFeeBps <= MAX_FEE_BPS, "Fee too high");
        
        token = IERC20(_token);
        treasury = _treasury;
        platformFeeBps = _platformFeeBps;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }

    // ============ Plan Management ============
    
    /**
     * @notice Create a new subscription plan
     */
    function createPlan(
        string calldata name,
        string calldata description,
        uint256 basePrice,
        uint256 billingPeriod,
        uint256 trialPeriod,
        uint256 usageLimit,
        uint256 overageRate
    ) external returns (bytes32 planId) {
        require(bytes(name).length > 0, "Name required");
        require(basePrice > 0, "Price must be > 0");
        require(billingPeriod >= MIN_BILLING_PERIOD, "Period too short");
        require(billingPeriod <= MAX_BILLING_PERIOD, "Period too long");
        
        planId = keccak256(abi.encodePacked(
            msg.sender,
            name,
            block.timestamp,
            planIds.length
        ));
        
        plans[planId] = Plan({
            provider: msg.sender,
            name: name,
            description: description,
            basePrice: basePrice,
            billingPeriod: billingPeriod,
            trialPeriod: trialPeriod,
            usageLimit: usageLimit,
            overageRate: overageRate,
            active: true,
            subscriberCount: 0,
            totalRevenue: 0,
            createdAt: block.timestamp
        });
        
        planIds.push(planId);
        providerPlans[msg.sender].push(planId);
        
        _grantRole(PROVIDER_ROLE, msg.sender);
        
        emit PlanCreated(planId, msg.sender, name, basePrice, billingPeriod);
    }
    
    /**
     * @notice Update plan details
     */
    function updatePlan(
        bytes32 planId,
        string calldata description,
        uint256 usageLimit,
        uint256 overageRate
    ) external {
        Plan storage plan = plans[planId];
        require(plan.provider == msg.sender, "Not provider");
        
        plan.description = description;
        plan.usageLimit = usageLimit;
        plan.overageRate = overageRate;
        
        emit PlanUpdated(planId);
    }
    
    /**
     * @notice Update plan price (only affects new subscriptions)
     */
    function updatePlanPrice(bytes32 planId, uint256 newPrice) external {
        Plan storage plan = plans[planId];
        require(plan.provider == msg.sender, "Not provider");
        require(newPrice > 0, "Price must be > 0");
        
        plan.basePrice = newPrice;
        emit PlanUpdated(planId);
    }
    
    /**
     * @notice Deactivate a plan (no new subscriptions)
     */
    function deactivatePlan(bytes32 planId) external {
        Plan storage plan = plans[planId];
        require(
            plan.provider == msg.sender || hasRole(OPERATOR_ROLE, msg.sender),
            "Not authorized"
        );
        
        plan.active = false;
        emit PlanDeactivated(planId);
    }
    
    /**
     * @notice Reactivate a plan
     */
    function activatePlan(bytes32 planId) external {
        Plan storage plan = plans[planId];
        require(plan.provider == msg.sender, "Not provider");
        
        plan.active = true;
        emit PlanActivated(planId);
    }

    // ============ Subscription Management ============
    
    /**
     * @notice Subscribe to a plan
     */
    function subscribe(
        bytes32 planId,
        uint256 prepayPeriods
    ) external nonReentrant whenNotPaused returns (bytes32 subscriptionId) {
        Plan storage plan = plans[planId];
        require(plan.active, "Plan not active");
        require(prepayPeriods >= 1, "Must prepay at least 1 period");
        
        subscriptionId = keccak256(abi.encodePacked(
            msg.sender,
            planId,
            block.timestamp,
            subscriptionIds.length
        ));
        
        // Calculate initial payment
        uint256 initialPayment;
        bool startInTrial = plan.trialPeriod > 0;
        
        if (startInTrial) {
            // Trial period - only charge for prepaid periods after trial
            initialPayment = plan.basePrice * (prepayPeriods > 1 ? prepayPeriods - 1 : 0);
        } else {
            initialPayment = plan.basePrice * prepayPeriods;
        }
        
        // Process payment if any
        if (initialPayment > 0) {
            _processPayment(msg.sender, plan.provider, initialPayment);
            plan.totalRevenue += initialPayment;
        }
        
        // Calculate period times
        uint256 periodStart = block.timestamp;
        uint256 periodEnd;
        
        if (startInTrial) {
            periodEnd = block.timestamp + plan.trialPeriod;
        } else {
            periodEnd = block.timestamp + plan.billingPeriod;
        }
        
        // Create subscription
        subscriptions[subscriptionId] = Subscription({
            planId: planId,
            subscriber: msg.sender,
            startTime: block.timestamp,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            usageThisPeriod: 0,
            totalPaid: initialPayment,
            balance: startInTrial ? plan.basePrice * prepayPeriods : plan.basePrice * (prepayPeriods - 1),
            active: true,
            inTrial: startInTrial,
            cancelledAt: 0
        });
        
        subscriptionIds.push(subscriptionId);
        subscriberSubscriptions[msg.sender].push(subscriptionId);
        planSubscriptions[planId].push(subscriptionId);
        plan.subscriberCount++;
        
        emit Subscribed(subscriptionId, planId, msg.sender, block.timestamp);
    }
    
    /**
     * @notice Add balance to subscription
     */
    function addBalance(bytes32 subscriptionId, uint256 amount) external nonReentrant {
        Subscription storage sub = subscriptions[subscriptionId];
        require(sub.subscriber == msg.sender, "Not subscriber");
        require(sub.active, "Subscription not active");
        require(amount > 0, "Amount must be > 0");
        
        Plan storage plan = plans[sub.planId];
        
        _processPayment(msg.sender, plan.provider, amount);
        sub.balance += amount;
        sub.totalPaid += amount;
        plan.totalRevenue += amount;
        
        emit BalanceAdded(subscriptionId, amount);
    }
    
    /**
     * @notice Renew subscription for next period
     */
    function renewSubscription(bytes32 subscriptionId) external nonReentrant {
        Subscription storage sub = subscriptions[subscriptionId];
        require(sub.active, "Subscription not active");
        require(sub.cancelledAt == 0, "Subscription cancelled");
        
        Plan storage plan = plans[sub.planId];
        
        // Check if current period has ended
        require(block.timestamp >= sub.currentPeriodEnd, "Period not ended");
        
        // Handle trial end
        if (sub.inTrial) {
            sub.inTrial = false;
        }
        
        // Calculate renewal cost
        uint256 renewalCost = plan.basePrice;
        
        // Check overage from previous period
        if (plan.usageLimit > 0 && sub.usageThisPeriod > plan.usageLimit) {
            uint256 overage = sub.usageThisPeriod - plan.usageLimit;
            uint256 overageCharge = overage * plan.overageRate;
            renewalCost += overageCharge;
            emit OverageCharged(subscriptionId, overage, overageCharge);
        }
        
        // Use balance or charge subscriber
        if (sub.balance >= renewalCost) {
            sub.balance -= renewalCost;
        } else {
            uint256 amountNeeded = renewalCost - sub.balance;
            _processPayment(sub.subscriber, plan.provider, amountNeeded);
            sub.totalPaid += amountNeeded;
            plan.totalRevenue += amountNeeded;
            sub.balance = 0;
        }
        
        // Update period
        sub.currentPeriodStart = block.timestamp;
        sub.currentPeriodEnd = block.timestamp + plan.billingPeriod;
        sub.usageThisPeriod = 0;
        
        emit SubscriptionRenewed(
            subscriptionId,
            sub.currentPeriodStart,
            sub.currentPeriodEnd,
            renewalCost
        );
    }
    
    /**
     * @notice Cancel subscription
     */
    function cancelSubscription(bytes32 subscriptionId) external {
        Subscription storage sub = subscriptions[subscriptionId];
        require(
            sub.subscriber == msg.sender || 
            plans[sub.planId].provider == msg.sender ||
            hasRole(OPERATOR_ROLE, msg.sender),
            "Not authorized"
        );
        require(sub.active, "Already inactive");
        
        sub.cancelledAt = block.timestamp;
        
        // Subscription remains active until current period ends
        // No refund for partial periods
        
        emit SubscriptionCancelled(subscriptionId, sub.subscriber, block.timestamp);
    }
    
    /**
     * @notice Deactivate expired/cancelled subscription
     */
    function deactivateSubscription(bytes32 subscriptionId) external {
        Subscription storage sub = subscriptions[subscriptionId];
        require(sub.active, "Already inactive");
        require(
            sub.cancelledAt > 0 && block.timestamp >= sub.currentPeriodEnd,
            "Cannot deactivate yet"
        );
        
        sub.active = false;
        plans[sub.planId].subscriberCount--;
        
        // Refund remaining balance
        if (sub.balance > 0) {
            uint256 refund = sub.balance;
            sub.balance = 0;
            token.safeTransfer(sub.subscriber, refund);
        }
    }

    // ============ Usage Tracking ============
    
    /**
     * @notice Record usage for a subscription
     */
    function recordUsage(
        bytes32 subscriptionId,
        uint256 amount,
        bytes32 referenceId
    ) external {
        Subscription storage sub = subscriptions[subscriptionId];
        Plan storage plan = plans[sub.planId];
        
        require(
            plan.provider == msg.sender || hasRole(OPERATOR_ROLE, msg.sender),
            "Not authorized"
        );
        require(sub.active, "Subscription not active");
        require(block.timestamp <= sub.currentPeriodEnd, "Period ended");
        
        sub.usageThisPeriod += amount;
        
        usageRecords[subscriptionId].push(UsageRecord({
            subscriptionId: subscriptionId,
            amount: amount,
            timestamp: block.timestamp,
            referenceId: referenceId
        }));
        
        emit UsageRecorded(subscriptionId, amount, referenceId);
    }
    
    /**
     * @notice Batch record usage
     */
    function batchRecordUsage(
        bytes32[] calldata subscriptionIdList,
        uint256[] calldata amounts,
        bytes32[] calldata referenceIds
    ) external {
        require(
            subscriptionIdList.length == amounts.length &&
            amounts.length == referenceIds.length,
            "Array length mismatch"
        );
        
        for (uint256 i = 0; i < subscriptionIdList.length; i++) {
            Subscription storage sub = subscriptions[subscriptionIdList[i]];
            Plan storage plan = plans[sub.planId];
            
            require(
                plan.provider == msg.sender || hasRole(OPERATOR_ROLE, msg.sender),
                "Not authorized"
            );
            
            if (sub.active && block.timestamp <= sub.currentPeriodEnd) {
                sub.usageThisPeriod += amounts[i];
                
                usageRecords[subscriptionIdList[i]].push(UsageRecord({
                    subscriptionId: subscriptionIdList[i],
                    amount: amounts[i],
                    timestamp: block.timestamp,
                    referenceId: referenceIds[i]
                }));
                
                emit UsageRecorded(subscriptionIdList[i], amounts[i], referenceIds[i]);
            }
        }
    }

    // ============ Payment Processing ============
    
    /**
     * @dev Process payment with platform fee
     */
    function _processPayment(
        address from,
        address provider,
        uint256 amount
    ) internal {
        uint256 fee = (amount * platformFeeBps) / 10000;
        uint256 providerAmount = amount - fee;
        
        token.safeTransferFrom(from, provider, providerAmount);
        if (fee > 0) {
            token.safeTransferFrom(from, treasury, fee);
        }
        
        emit PaymentProcessed(bytes32(0), from, provider, providerAmount, fee);
    }

    // ============ View Functions ============
    
    /**
     * @notice Get subscription status
     */
    function getSubscriptionStatus(bytes32 subscriptionId) external view returns (
        bool active,
        bool inTrial,
        bool cancelled,
        bool expired,
        uint256 daysRemaining,
        uint256 usageRemaining
    ) {
        Subscription storage sub = subscriptions[subscriptionId];
        Plan storage plan = plans[sub.planId];
        
        active = sub.active;
        inTrial = sub.inTrial;
        cancelled = sub.cancelledAt > 0;
        expired = block.timestamp > sub.currentPeriodEnd;
        
        if (block.timestamp < sub.currentPeriodEnd) {
            daysRemaining = (sub.currentPeriodEnd - block.timestamp) / 1 days;
        }
        
        if (plan.usageLimit > 0 && sub.usageThisPeriod < plan.usageLimit) {
            usageRemaining = plan.usageLimit - sub.usageThisPeriod;
        }
    }
    
    /**
     * @notice Get all plans for a provider
     */
    function getProviderPlans(address provider) external view returns (bytes32[] memory) {
        return providerPlans[provider];
    }
    
    /**
     * @notice Get all subscriptions for a subscriber
     */
    function getSubscriberSubscriptions(address subscriber) external view returns (bytes32[] memory) {
        return subscriberSubscriptions[subscriber];
    }
    
    /**
     * @notice Get usage history
     */
    function getUsageHistory(
        bytes32 subscriptionId,
        uint256 offset,
        uint256 limit
    ) external view returns (UsageRecord[] memory) {
        UsageRecord[] storage records = usageRecords[subscriptionId];
        uint256 total = records.length;
        
        if (offset >= total) {
            return new UsageRecord[](0);
        }
        
        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }
        
        UsageRecord[] memory result = new UsageRecord[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = records[i];
        }
        
        return result;
    }
    
    /**
     * @notice Calculate overage cost
     */
    function calculateOverage(bytes32 subscriptionId) external view returns (uint256) {
        Subscription storage sub = subscriptions[subscriptionId];
        Plan storage plan = plans[sub.planId];
        
        if (plan.usageLimit == 0 || sub.usageThisPeriod <= plan.usageLimit) {
            return 0;
        }
        
        return (sub.usageThisPeriod - plan.usageLimit) * plan.overageRate;
    }
    
    /**
     * @notice Get plan count
     */
    function getPlanCount() external view returns (uint256) {
        return planIds.length;
    }
    
    /**
     * @notice Get subscription count
     */
    function getSubscriptionCount() external view returns (uint256) {
        return subscriptionIds.length;
    }

    // ============ Admin Functions ============
    
    /**
     * @notice Update platform fee
     */
    function setPlatformFee(uint256 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newFeeBps <= MAX_FEE_BPS, "Fee too high");
        platformFeeBps = newFeeBps;
    }
    
    /**
     * @notice Update treasury
     */
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newTreasury != address(0), "Invalid treasury");
        treasury = newTreasury;
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
}
