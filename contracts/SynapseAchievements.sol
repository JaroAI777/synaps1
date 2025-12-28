// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

/**
 * @title SynapseAchievements
 * @notice NFT-based achievement badges for SYNAPSE Protocol participants
 * @dev Soulbound tokens (non-transferable) representing achievements
 */
contract SynapseAchievements is ERC721, ERC721Enumerable, ERC721URIStorage, AccessControl {
    using Counters for Counters.Counter;
    using Strings for uint256;

    // ============ Roles ============
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BADGE_ADMIN_ROLE = keccak256("BADGE_ADMIN_ROLE");

    // ============ Structs ============
    
    /**
     * @notice Badge type definition
     */
    struct BadgeType {
        string name;
        string description;
        string imageUri;
        BadgeCategory category;
        BadgeRarity rarity;
        uint256 maxSupply; // 0 = unlimited
        uint256 totalMinted;
        bool active;
        uint256 createdAt;
        mapping(string => string) attributes;
        string[] attributeKeys;
    }

    /**
     * @notice Individual badge instance
     */
    struct Badge {
        uint256 badgeTypeId;
        address originalOwner;
        uint256 mintedAt;
        uint256 achievementValue; // Optional numeric value (e.g., transaction count)
        string achievementData; // Optional additional data
    }

    // ============ Enums ============
    
    enum BadgeCategory {
        MILESTONE,      // Transaction milestones
        REPUTATION,     // Reputation achievements
        STAKING,        // Staking achievements
        GOVERNANCE,     // Governance participation
        COMMUNITY,      // Community contributions
        SPECIAL,        // Special events
        EARLY_ADOPTER   // Early adopter badges
    }

    enum BadgeRarity {
        COMMON,
        UNCOMMON,
        RARE,
        EPIC,
        LEGENDARY,
        MYTHIC
    }

    // ============ State Variables ============
    
    Counters.Counter private _tokenIdCounter;
    Counters.Counter private _badgeTypeCounter;
    
    // Badge types
    mapping(uint256 => BadgeType) public badgeTypes;
    
    // Token to badge mapping
    mapping(uint256 => Badge) public badges;
    
    // User badges by type (address => badgeTypeId => tokenId[])
    mapping(address => mapping(uint256 => uint256[])) public userBadgesByType;
    
    // Check if user has badge type
    mapping(address => mapping(uint256 => bool)) public hasBadgeType;
    
    // Soulbound setting (non-transferable by default)
    bool public soulbound = true;
    
    // Base URI for metadata
    string public baseMetadataUri;
    
    // ============ Events ============
    
    event BadgeTypeCreated(
        uint256 indexed badgeTypeId,
        string name,
        BadgeCategory category,
        BadgeRarity rarity
    );
    
    event BadgeMinted(
        uint256 indexed tokenId,
        uint256 indexed badgeTypeId,
        address indexed recipient,
        uint256 achievementValue
    );
    
    event BadgeTypeUpdated(uint256 indexed badgeTypeId);
    event SoulboundStatusChanged(bool soulbound);

    // ============ Constructor ============
    
    constructor() ERC721("SYNAPSE Achievements", "SYNACH") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        _grantRole(BADGE_ADMIN_ROLE, msg.sender);
        
        // Create initial badge types
        _createDefaultBadgeTypes();
    }

    // ============ Badge Type Management ============
    
    /**
     * @notice Create a new badge type
     */
    function createBadgeType(
        string calldata name,
        string calldata description,
        string calldata imageUri,
        BadgeCategory category,
        BadgeRarity rarity,
        uint256 maxSupply
    ) external onlyRole(BADGE_ADMIN_ROLE) returns (uint256 badgeTypeId) {
        badgeTypeId = _badgeTypeCounter.current();
        _badgeTypeCounter.increment();
        
        BadgeType storage bt = badgeTypes[badgeTypeId];
        bt.name = name;
        bt.description = description;
        bt.imageUri = imageUri;
        bt.category = category;
        bt.rarity = rarity;
        bt.maxSupply = maxSupply;
        bt.totalMinted = 0;
        bt.active = true;
        bt.createdAt = block.timestamp;
        
        emit BadgeTypeCreated(badgeTypeId, name, category, rarity);
    }

    /**
     * @notice Add attribute to badge type
     */
    function addBadgeAttribute(
        uint256 badgeTypeId,
        string calldata key,
        string calldata value
    ) external onlyRole(BADGE_ADMIN_ROLE) {
        BadgeType storage bt = badgeTypes[badgeTypeId];
        require(bt.createdAt > 0, "Badge type not found");
        
        if (bytes(bt.attributes[key]).length == 0) {
            bt.attributeKeys.push(key);
        }
        bt.attributes[key] = value;
        
        emit BadgeTypeUpdated(badgeTypeId);
    }

    /**
     * @notice Deactivate badge type (no more minting)
     */
    function deactivateBadgeType(uint256 badgeTypeId) external onlyRole(BADGE_ADMIN_ROLE) {
        badgeTypes[badgeTypeId].active = false;
        emit BadgeTypeUpdated(badgeTypeId);
    }

    /**
     * @notice Reactivate badge type
     */
    function activateBadgeType(uint256 badgeTypeId) external onlyRole(BADGE_ADMIN_ROLE) {
        badgeTypes[badgeTypeId].active = true;
        emit BadgeTypeUpdated(badgeTypeId);
    }

    // ============ Minting ============
    
    /**
     * @notice Mint achievement badge to user
     */
    function mintBadge(
        address recipient,
        uint256 badgeTypeId,
        uint256 achievementValue,
        string calldata achievementData
    ) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        BadgeType storage bt = badgeTypes[badgeTypeId];
        require(bt.active, "Badge type not active");
        require(bt.maxSupply == 0 || bt.totalMinted < bt.maxSupply, "Max supply reached");
        
        tokenId = _tokenIdCounter.current();
        _tokenIdCounter.increment();
        
        _safeMint(recipient, tokenId);
        
        badges[tokenId] = Badge({
            badgeTypeId: badgeTypeId,
            originalOwner: recipient,
            mintedAt: block.timestamp,
            achievementValue: achievementValue,
            achievementData: achievementData
        });
        
        bt.totalMinted++;
        userBadgesByType[recipient][badgeTypeId].push(tokenId);
        hasBadgeType[recipient][badgeTypeId] = true;
        
        // Set token URI
        _setTokenURI(tokenId, _generateTokenURI(tokenId));
        
        emit BadgeMinted(tokenId, badgeTypeId, recipient, achievementValue);
    }

    /**
     * @notice Batch mint badges
     */
    function batchMintBadge(
        address[] calldata recipients,
        uint256 badgeTypeId,
        uint256[] calldata achievementValues
    ) external onlyRole(MINTER_ROLE) {
        require(recipients.length == achievementValues.length, "Length mismatch");
        
        for (uint256 i = 0; i < recipients.length; i++) {
            mintBadge(recipients[i], badgeTypeId, achievementValues[i], "");
        }
    }

    // ============ Token URI Generation ============
    
    /**
     * @notice Generate on-chain metadata
     */
    function _generateTokenURI(uint256 tokenId) internal view returns (string memory) {
        Badge storage badge = badges[tokenId];
        BadgeType storage bt = badgeTypes[badge.badgeTypeId];
        
        string memory rarityStr = _rarityToString(bt.rarity);
        string memory categoryStr = _categoryToString(bt.category);
        
        // Build attributes JSON
        string memory attributes = string(abi.encodePacked(
            '[',
            '{"trait_type":"Category","value":"', categoryStr, '"},',
            '{"trait_type":"Rarity","value":"', rarityStr, '"},',
            '{"trait_type":"Achievement Value","display_type":"number","value":', badge.achievementValue.toString(), '},',
            '{"trait_type":"Mint Date","display_type":"date","value":', badge.mintedAt.toString(), '}'
        ));
        
        // Add custom attributes
        for (uint256 i = 0; i < bt.attributeKeys.length; i++) {
            string memory key = bt.attributeKeys[i];
            attributes = string(abi.encodePacked(
                attributes,
                ',{"trait_type":"', key, '","value":"', bt.attributes[key], '"}'
            ));
        }
        
        attributes = string(abi.encodePacked(attributes, ']'));
        
        // Build full metadata
        string memory json = string(abi.encodePacked(
            '{"name":"', bt.name, ' #', tokenId.toString(), '",',
            '"description":"', bt.description, '",',
            '"image":"', bt.imageUri, '",',
            '"attributes":', attributes, '}'
        ));
        
        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(bytes(json))
        ));
    }

    /**
     * @notice Convert rarity to string
     */
    function _rarityToString(BadgeRarity rarity) internal pure returns (string memory) {
        if (rarity == BadgeRarity.COMMON) return "Common";
        if (rarity == BadgeRarity.UNCOMMON) return "Uncommon";
        if (rarity == BadgeRarity.RARE) return "Rare";
        if (rarity == BadgeRarity.EPIC) return "Epic";
        if (rarity == BadgeRarity.LEGENDARY) return "Legendary";
        if (rarity == BadgeRarity.MYTHIC) return "Mythic";
        return "Unknown";
    }

    /**
     * @notice Convert category to string
     */
    function _categoryToString(BadgeCategory category) internal pure returns (string memory) {
        if (category == BadgeCategory.MILESTONE) return "Milestone";
        if (category == BadgeCategory.REPUTATION) return "Reputation";
        if (category == BadgeCategory.STAKING) return "Staking";
        if (category == BadgeCategory.GOVERNANCE) return "Governance";
        if (category == BadgeCategory.COMMUNITY) return "Community";
        if (category == BadgeCategory.SPECIAL) return "Special";
        if (category == BadgeCategory.EARLY_ADOPTER) return "Early Adopter";
        return "Unknown";
    }

    // ============ Soulbound Logic ============
    
    /**
     * @notice Override transfer to enforce soulbound
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override(ERC721, ERC721Enumerable) returns (address) {
        address from = _ownerOf(tokenId);
        
        // Allow minting (from == address(0)) and burning (to == address(0))
        // Block transfers if soulbound
        if (soulbound && from != address(0) && to != address(0)) {
            revert("Soulbound: transfers disabled");
        }
        
        return super._update(to, tokenId, auth);
    }

    /**
     * @notice Toggle soulbound status (admin only)
     */
    function setSoulbound(bool _soulbound) external onlyRole(DEFAULT_ADMIN_ROLE) {
        soulbound = _soulbound;
        emit SoulboundStatusChanged(_soulbound);
    }

    // ============ View Functions ============
    
    /**
     * @notice Get badge details
     */
    function getBadge(uint256 tokenId) external view returns (
        uint256 badgeTypeId,
        string memory name,
        string memory description,
        BadgeCategory category,
        BadgeRarity rarity,
        address originalOwner,
        uint256 mintedAt,
        uint256 achievementValue
    ) {
        Badge storage badge = badges[tokenId];
        BadgeType storage bt = badgeTypes[badge.badgeTypeId];
        
        return (
            badge.badgeTypeId,
            bt.name,
            bt.description,
            bt.category,
            bt.rarity,
            badge.originalOwner,
            badge.mintedAt,
            badge.achievementValue
        );
    }

    /**
     * @notice Get badge type details
     */
    function getBadgeType(uint256 badgeTypeId) external view returns (
        string memory name,
        string memory description,
        string memory imageUri,
        BadgeCategory category,
        BadgeRarity rarity,
        uint256 maxSupply,
        uint256 totalMinted,
        bool active
    ) {
        BadgeType storage bt = badgeTypes[badgeTypeId];
        return (
            bt.name,
            bt.description,
            bt.imageUri,
            bt.category,
            bt.rarity,
            bt.maxSupply,
            bt.totalMinted,
            bt.active
        );
    }

    /**
     * @notice Get user's badges of a specific type
     */
    function getUserBadgesOfType(
        address user,
        uint256 badgeTypeId
    ) external view returns (uint256[] memory) {
        return userBadgesByType[user][badgeTypeId];
    }

    /**
     * @notice Get total badge types
     */
    function getBadgeTypeCount() external view returns (uint256) {
        return _badgeTypeCounter.current();
    }

    /**
     * @notice Get total badges minted
     */
    function getTotalBadgesMinted() external view returns (uint256) {
        return _tokenIdCounter.current();
    }

    // ============ Default Badge Types ============
    
    function _createDefaultBadgeTypes() internal {
        // Milestone badges
        _createBadgeTypeInternal(
            "First Transaction",
            "Completed your first transaction on SYNAPSE Protocol",
            "ipfs://QmFirst",
            BadgeCategory.MILESTONE,
            BadgeRarity.COMMON,
            0
        );
        
        _createBadgeTypeInternal(
            "Transaction Master",
            "Completed 100 transactions",
            "ipfs://Qm100Tx",
            BadgeCategory.MILESTONE,
            BadgeRarity.UNCOMMON,
            0
        );
        
        _createBadgeTypeInternal(
            "Transaction Legend",
            "Completed 1000 transactions",
            "ipfs://Qm1000Tx",
            BadgeCategory.MILESTONE,
            BadgeRarity.RARE,
            0
        );
        
        // Reputation badges
        _createBadgeTypeInternal(
            "Trusted Agent",
            "Achieved Silver tier reputation",
            "ipfs://QmTrusted",
            BadgeCategory.REPUTATION,
            BadgeRarity.UNCOMMON,
            0
        );
        
        _createBadgeTypeInternal(
            "Elite Agent",
            "Achieved Diamond tier reputation",
            "ipfs://QmElite",
            BadgeCategory.REPUTATION,
            BadgeRarity.LEGENDARY,
            0
        );
        
        // Staking badges
        _createBadgeTypeInternal(
            "Staker",
            "Staked SYNX tokens for the first time",
            "ipfs://QmStaker",
            BadgeCategory.STAKING,
            BadgeRarity.COMMON,
            0
        );
        
        _createBadgeTypeInternal(
            "Diamond Hands",
            "Staked for over 1 year",
            "ipfs://QmDiamond",
            BadgeCategory.STAKING,
            BadgeRarity.EPIC,
            0
        );
        
        // Early adopter (limited)
        _createBadgeTypeInternal(
            "Genesis Pioneer",
            "One of the first 1000 users of SYNAPSE Protocol",
            "ipfs://QmGenesis",
            BadgeCategory.EARLY_ADOPTER,
            BadgeRarity.MYTHIC,
            1000
        );
    }

    function _createBadgeTypeInternal(
        string memory name,
        string memory description,
        string memory imageUri,
        BadgeCategory category,
        BadgeRarity rarity,
        uint256 maxSupply
    ) internal returns (uint256) {
        uint256 badgeTypeId = _badgeTypeCounter.current();
        _badgeTypeCounter.increment();
        
        BadgeType storage bt = badgeTypes[badgeTypeId];
        bt.name = name;
        bt.description = description;
        bt.imageUri = imageUri;
        bt.category = category;
        bt.rarity = rarity;
        bt.maxSupply = maxSupply;
        bt.active = true;
        bt.createdAt = block.timestamp;
        
        return badgeTypeId;
    }

    // ============ Required Overrides ============
    
    function _increaseBalance(
        address account,
        uint128 value
    ) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function tokenURI(
        uint256 tokenId
    ) public view override(ERC721, ERC721URIStorage) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, ERC721Enumerable, ERC721URIStorage, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
