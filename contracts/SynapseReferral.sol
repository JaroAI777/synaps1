// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapseReferral
 * @notice Referral and affiliate system for SYNAPSE Protocol
 * @dev Multi-tier referral with commission tracking and payouts
 */
contract SynapseReferral is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Structs ============
    
    struct Referrer {
        address referredBy;         // Who referred this user
        uint256 tier;               // Referrer tier (0-4)
        uint256 totalEarnings;      // Total earnings ever
        uint256 pendingEarnings;    // Unclaimed earnings
        uint256 totalReferrals;     // Number of direct referrals
        uint256 activeReferrals;    // Referrals that have been active
        uint256 totalVolume;        // Total volume from referrals
        uint256 joinedAt;           // When user joined
        bool isActive;              // Is referrer active
        string referralCode;        // Unique referral code
    }

    struct TierConfig {
        uint256 minReferrals;       // Min referrals for tier
        uint256 minVolume;          // Min volume for tier
        uint256 commissionRate;     // Commission in basis points
        uint256 bonusRate;          // Bonus for referee
        string name;                // Tier name
    }

    struct Campaign {
        string name;
        uint256 bonusMultiplier;    // Extra multiplier (100 = 1x, 200 = 2x)
        uint256 startTime;
        uint256 endTime;
        uint256 maxParticipants;
        uint256 participants;
        uint256 budget;
        uint256 spent;
        bool active;
    }

    // ============ Constants ============
    
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant CAMPAIGN_MANAGER_ROLE = keccak256("CAMPAIGN_MANAGER_ROLE");
    
    uint256 public constant MAX_COMMISSION = 1000; // 10%
    uint256 public constant MAX_TIERS = 5;
    uint256 public constant REFERRAL_CODE_LENGTH = 8;

    // ============ State Variables ============
    
    IERC20 public immutable synxToken;
    
    // Referrer data
    mapping(address => Referrer) public referrers;
    mapping(string => address) public codeToAddress;
    mapping(address => address[]) public directReferrals;
    
    // Tier configurations
    TierConfig[5] public tiers;
    
    // Campaigns
    mapping(uint256 => Campaign) public campaigns;
    uint256 public campaignCount;
    mapping(uint256 => mapping(address => bool)) public campaignParticipants;
    
    // Statistics
    uint256 public totalReferrers;
    uint256 public totalEarningsPaid;
    uint256 public totalVolumeReferred;
    
    // Settings
    uint256 public minWithdrawal = 10 ether; // 10 SYNX
    uint256 public referralWindow = 365 days; // Attribution window
    bool public registrationOpen = true;
    
    // Allowed callers (PaymentRouter, etc.)
    mapping(address => bool) public allowedCallers;

    // ============ Events ============
    
    event ReferrerRegistered(address indexed referrer, string code, address indexed referredBy);
    event ReferralRecorded(address indexed referee, address indexed referrer, uint256 volume);
    event CommissionEarned(address indexed referrer, address indexed referee, uint256 amount, uint256 tier);
    event CommissionWithdrawn(address indexed referrer, uint256 amount);
    event TierUpgrade(address indexed referrer, uint256 oldTier, uint256 newTier);
    event CampaignCreated(uint256 indexed campaignId, string name, uint256 bonusMultiplier);
    event CampaignEnded(uint256 indexed campaignId);

    // ============ Constructor ============
    
    constructor(address _synxToken) {
        require(_synxToken != address(0), "Invalid token");
        synxToken = IERC20(_synxToken);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
        _grantRole(CAMPAIGN_MANAGER_ROLE, msg.sender);

        // Initialize tiers
        tiers[0] = TierConfig({
            minReferrals: 0,
            minVolume: 0,
            commissionRate: 100, // 1%
            bonusRate: 50, // 0.5% to referee
            name: "Starter"
        });

        tiers[1] = TierConfig({
            minReferrals: 5,
            minVolume: 1000 ether,
            commissionRate: 200, // 2%
            bonusRate: 75,
            name: "Bronze"
        });

        tiers[2] = TierConfig({
            minReferrals: 20,
            minVolume: 10000 ether,
            commissionRate: 300, // 3%
            bonusRate: 100,
            name: "Silver"
        });

        tiers[3] = TierConfig({
            minReferrals: 50,
            minVolume: 50000 ether,
            commissionRate: 400, // 4%
            bonusRate: 125,
            name: "Gold"
        });

        tiers[4] = TierConfig({
            minReferrals: 100,
            minVolume: 200000 ether,
            commissionRate: 500, // 5%
            bonusRate: 150,
            name: "Platinum"
        });
    }

    // ============ Registration ============
    
    /**
     * @notice Register as a referrer
     * @param referralCode Unique referral code (leave empty to auto-generate)
     * @param referrerCode Code of who referred you (optional)
     */
    function register(
        string calldata referralCode,
        string calldata referrerCode
    ) external whenNotPaused {
        require(registrationOpen, "Registration closed");
        require(!referrers[msg.sender].isActive, "Already registered");

        string memory code = bytes(referralCode).length > 0 
            ? referralCode 
            : _generateCode(msg.sender);

        require(bytes(code).length >= 4 && bytes(code).length <= 20, "Invalid code length");
        require(codeToAddress[code] == address(0), "Code taken");

        // Check referrer
        address referredBy = address(0);
        if (bytes(referrerCode).length > 0) {
            referredBy = codeToAddress[referrerCode];
            require(referredBy != address(0), "Invalid referrer code");
            require(referredBy != msg.sender, "Cannot self-refer");
            
            // Update referrer stats
            referrers[referredBy].totalReferrals++;
            directReferrals[referredBy].push(msg.sender);
        }

        referrers[msg.sender] = Referrer({
            referredBy: referredBy,
            tier: 0,
            totalEarnings: 0,
            pendingEarnings: 0,
            totalReferrals: 0,
            activeReferrals: 0,
            totalVolume: 0,
            joinedAt: block.timestamp,
            isActive: true,
            referralCode: code
        });

        codeToAddress[code] = msg.sender;
        totalReferrers++;

        emit ReferrerRegistered(msg.sender, code, referredBy);
    }

    /**
     * @dev Generate a unique referral code
     */
    function _generateCode(address user) internal view returns (string memory) {
        bytes memory chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        bytes memory code = new bytes(REFERRAL_CODE_LENGTH);
        
        uint256 random = uint256(keccak256(abi.encodePacked(
            block.timestamp,
            block.prevrandao,
            user,
            totalReferrers
        )));

        for (uint256 i = 0; i < REFERRAL_CODE_LENGTH; i++) {
            code[i] = chars[random % chars.length];
            random = random / chars.length;
        }

        return string(code);
    }

    // ============ Referral Recording ============
    
    /**
     * @notice Record a referral transaction (called by PaymentRouter)
     * @param referee The user making the payment
     * @param volume The payment volume
     */
    function recordReferral(
        address referee,
        uint256 volume
    ) external nonReentrant whenNotPaused {
        require(allowedCallers[msg.sender], "Not authorized");
        require(volume > 0, "Zero volume");

        Referrer storage user = referrers[referee];
        if (!user.isActive || user.referredBy == address(0)) {
            return; // Not a referred user
        }

        // Check attribution window
        if (block.timestamp > user.joinedAt + referralWindow) {
            return; // Outside attribution window
        }

        address referrerAddr = user.referredBy;
        Referrer storage referrer = referrers[referrerAddr];

        if (!referrer.isActive) {
            return;
        }

        // Update referrer stats
        referrer.totalVolume += volume;
        if (referrer.activeReferrals == 0 || !_isActiveReferral(referee, referrerAddr)) {
            referrer.activeReferrals++;
        }

        totalVolumeReferred += volume;

        // Calculate commission
        TierConfig memory tierConfig = tiers[referrer.tier];
        uint256 commission = (volume * tierConfig.commissionRate) / 10000;

        // Check for active campaigns
        uint256 campaignBonus = _getCampaignBonus(referrerAddr);
        if (campaignBonus > 100) {
            commission = (commission * campaignBonus) / 100;
        }

        referrer.pendingEarnings += commission;
        referrer.totalEarnings += commission;

        // Check tier upgrade
        _checkTierUpgrade(referrerAddr);

        emit ReferralRecorded(referee, referrerAddr, volume);
        emit CommissionEarned(referrerAddr, referee, commission, referrer.tier);
    }

    /**
     * @dev Check if referee is already an active referral
     */
    function _isActiveReferral(address referee, address referrer) internal view returns (bool) {
        address[] memory refs = directReferrals[referrer];
        for (uint256 i = 0; i < refs.length; i++) {
            if (refs[i] == referee) {
                return referrers[referee].totalVolume > 0;
            }
        }
        return false;
    }

    /**
     * @dev Get campaign bonus multiplier
     */
    function _getCampaignBonus(address referrer) internal returns (uint256) {
        uint256 maxBonus = 100;

        for (uint256 i = 0; i < campaignCount; i++) {
            Campaign storage campaign = campaigns[i];
            
            if (!campaign.active) continue;
            if (block.timestamp < campaign.startTime || block.timestamp > campaign.endTime) continue;
            if (campaign.participants >= campaign.maxParticipants) continue;
            if (campaign.spent >= campaign.budget) continue;

            if (!campaignParticipants[i][referrer]) {
                campaignParticipants[i][referrer] = true;
                campaign.participants++;
            }

            if (campaign.bonusMultiplier > maxBonus) {
                maxBonus = campaign.bonusMultiplier;
            }
        }

        return maxBonus;
    }

    /**
     * @dev Check and apply tier upgrade
     */
    function _checkTierUpgrade(address referrerAddr) internal {
        Referrer storage referrer = referrers[referrerAddr];
        uint256 currentTier = referrer.tier;

        for (uint256 i = currentTier + 1; i < MAX_TIERS; i++) {
            TierConfig memory tierConfig = tiers[i];
            
            if (referrer.activeReferrals >= tierConfig.minReferrals &&
                referrer.totalVolume >= tierConfig.minVolume) {
                referrer.tier = i;
            } else {
                break;
            }
        }

        if (referrer.tier > currentTier) {
            emit TierUpgrade(referrerAddr, currentTier, referrer.tier);
        }
    }

    // ============ Withdrawals ============
    
    /**
     * @notice Withdraw pending earnings
     */
    function withdraw() external nonReentrant whenNotPaused {
        Referrer storage referrer = referrers[msg.sender];
        require(referrer.isActive, "Not a referrer");
        require(referrer.pendingEarnings >= minWithdrawal, "Below minimum");

        uint256 amount = referrer.pendingEarnings;
        referrer.pendingEarnings = 0;
        totalEarningsPaid += amount;

        synxToken.safeTransfer(msg.sender, amount);

        emit CommissionWithdrawn(msg.sender, amount);
    }

    /**
     * @notice Withdraw to specific address
     */
    function withdrawTo(address to) external nonReentrant whenNotPaused {
        require(to != address(0), "Invalid address");
        
        Referrer storage referrer = referrers[msg.sender];
        require(referrer.isActive, "Not a referrer");
        require(referrer.pendingEarnings >= minWithdrawal, "Below minimum");

        uint256 amount = referrer.pendingEarnings;
        referrer.pendingEarnings = 0;
        totalEarningsPaid += amount;

        synxToken.safeTransfer(to, amount);

        emit CommissionWithdrawn(msg.sender, amount);
    }

    // ============ Campaigns ============
    
    /**
     * @notice Create a referral campaign
     */
    function createCampaign(
        string calldata name,
        uint256 bonusMultiplier,
        uint256 startTime,
        uint256 duration,
        uint256 maxParticipants,
        uint256 budget
    ) external onlyRole(CAMPAIGN_MANAGER_ROLE) returns (uint256 campaignId) {
        require(bonusMultiplier >= 100 && bonusMultiplier <= 500, "Invalid multiplier");
        require(duration > 0, "Invalid duration");
        require(budget > 0, "Invalid budget");

        campaignId = campaignCount++;

        campaigns[campaignId] = Campaign({
            name: name,
            bonusMultiplier: bonusMultiplier,
            startTime: startTime > 0 ? startTime : block.timestamp,
            endTime: (startTime > 0 ? startTime : block.timestamp) + duration,
            maxParticipants: maxParticipants,
            participants: 0,
            budget: budget,
            spent: 0,
            active: true
        });

        // Transfer budget
        synxToken.safeTransferFrom(msg.sender, address(this), budget);

        emit CampaignCreated(campaignId, name, bonusMultiplier);
    }

    /**
     * @notice End a campaign early
     */
    function endCampaign(uint256 campaignId) external onlyRole(CAMPAIGN_MANAGER_ROLE) {
        Campaign storage campaign = campaigns[campaignId];
        require(campaign.active, "Not active");

        campaign.active = false;
        campaign.endTime = block.timestamp;

        // Return unspent budget
        uint256 remaining = campaign.budget - campaign.spent;
        if (remaining > 0) {
            synxToken.safeTransfer(msg.sender, remaining);
        }

        emit CampaignEnded(campaignId);
    }

    // ============ Admin Functions ============
    
    /**
     * @notice Set allowed caller
     */
    function setAllowedCaller(address caller, bool allowed) external onlyRole(OPERATOR_ROLE) {
        allowedCallers[caller] = allowed;
    }

    /**
     * @notice Update tier configuration
     */
    function updateTier(
        uint256 tierId,
        uint256 minReferrals,
        uint256 minVolume,
        uint256 commissionRate,
        uint256 bonusRate,
        string calldata name
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(tierId < MAX_TIERS, "Invalid tier");
        require(commissionRate <= MAX_COMMISSION, "Rate too high");

        tiers[tierId] = TierConfig({
            minReferrals: minReferrals,
            minVolume: minVolume,
            commissionRate: commissionRate,
            bonusRate: bonusRate,
            name: name
        });
    }

    /**
     * @notice Set minimum withdrawal
     */
    function setMinWithdrawal(uint256 amount) external onlyRole(OPERATOR_ROLE) {
        minWithdrawal = amount;
    }

    /**
     * @notice Set referral attribution window
     */
    function setReferralWindow(uint256 window) external onlyRole(OPERATOR_ROLE) {
        referralWindow = window;
    }

    /**
     * @notice Toggle registration
     */
    function setRegistrationOpen(bool open) external onlyRole(OPERATOR_ROLE) {
        registrationOpen = open;
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
     * @notice Fund contract for payouts
     */
    function fund(uint256 amount) external {
        synxToken.safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Emergency withdraw
     */
    function emergencyWithdraw(address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 balance = synxToken.balanceOf(address(this));
        synxToken.safeTransfer(to, balance);
    }

    // ============ View Functions ============
    
    /**
     * @notice Get referrer details
     */
    function getReferrer(address account) external view returns (
        address referredBy,
        uint256 tier,
        uint256 totalEarnings,
        uint256 pendingEarnings,
        uint256 totalReferrals,
        uint256 activeReferrals,
        uint256 totalVolume,
        string memory referralCode
    ) {
        Referrer storage r = referrers[account];
        return (
            r.referredBy,
            r.tier,
            r.totalEarnings,
            r.pendingEarnings,
            r.totalReferrals,
            r.activeReferrals,
            r.totalVolume,
            r.referralCode
        );
    }

    /**
     * @notice Get direct referrals of an address
     */
    function getDirectReferrals(address referrer) external view returns (address[] memory) {
        return directReferrals[referrer];
    }

    /**
     * @notice Get commission rate for a tier
     */
    function getCommissionRate(uint256 tierId) external view returns (uint256) {
        require(tierId < MAX_TIERS, "Invalid tier");
        return tiers[tierId].commissionRate;
    }

    /**
     * @notice Get tier details
     */
    function getTier(uint256 tierId) external view returns (TierConfig memory) {
        require(tierId < MAX_TIERS, "Invalid tier");
        return tiers[tierId];
    }

    /**
     * @notice Get all tiers
     */
    function getAllTiers() external view returns (TierConfig[5] memory) {
        return tiers;
    }

    /**
     * @notice Get campaign details
     */
    function getCampaign(uint256 campaignId) external view returns (Campaign memory) {
        return campaigns[campaignId];
    }

    /**
     * @notice Get active campaigns
     */
    function getActiveCampaigns() external view returns (uint256[] memory) {
        uint256 activeCount = 0;
        
        for (uint256 i = 0; i < campaignCount; i++) {
            if (campaigns[i].active && 
                block.timestamp >= campaigns[i].startTime &&
                block.timestamp <= campaigns[i].endTime) {
                activeCount++;
            }
        }

        uint256[] memory active = new uint256[](activeCount);
        uint256 index = 0;

        for (uint256 i = 0; i < campaignCount; i++) {
            if (campaigns[i].active && 
                block.timestamp >= campaigns[i].startTime &&
                block.timestamp <= campaigns[i].endTime) {
                active[index++] = i;
            }
        }

        return active;
    }

    /**
     * @notice Get protocol statistics
     */
    function getStats() external view returns (
        uint256 _totalReferrers,
        uint256 _totalEarningsPaid,
        uint256 _totalVolumeReferred,
        uint256 _contractBalance
    ) {
        return (
            totalReferrers,
            totalEarningsPaid,
            totalVolumeReferred,
            synxToken.balanceOf(address(this))
        );
    }

    /**
     * @notice Check if code is available
     */
    function isCodeAvailable(string calldata code) external view returns (bool) {
        return codeToAddress[code] == address(0);
    }

    /**
     * @notice Get referrer by code
     */
    function getReferrerByCode(string calldata code) external view returns (address) {
        return codeToAddress[code];
    }
}
