// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SynapseAchievementsNFT
 * @notice NFT-based achievement system for SYNAPSE Protocol
 * @dev ERC1155 multi-token standard for various achievement types
 */
contract SynapseAchievementsNFT is ERC1155, ERC1155Supply, AccessControl, ReentrancyGuard {
    using Strings for uint256;

    // ============ Roles ============
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ============ Structs ============
    
    struct Achievement {
        string name;
        string description;
        string imageUri;
        AchievementCategory category;
        AchievementRarity rarity;
        uint256 maxSupply; // 0 = unlimited
        uint256 points;
        bool transferable;
        bool active;
        uint256 createdAt;
    }

    struct UserProgress {
        uint256 totalPoints;
        uint256 achievementCount;
        uint256[] unlockedAchievements;
        mapping(uint256 => uint256) achievementTimestamps;
    }

    struct Leaderboard {
        address user;
        uint256 points;
        uint256 achievementCount;
    }

    // ============ Enums ============
    
    enum AchievementCategory {
        PAYMENT,        // Payment-related achievements
        STAKING,        // Staking milestones
        SERVICE,        // Service provider achievements
        AGENT,          // AI Agent achievements
        COMMUNITY,      // Community participation
        GOVERNANCE,     // Governance participation
        SPECIAL,        // Special/limited achievements
        SEASONAL        // Time-limited seasonal achievements
    }

    enum AchievementRarity {
        COMMON,         // Easy to obtain
        UNCOMMON,       // Moderate difficulty
        RARE,           // Challenging
        EPIC,           // Very difficult
        LEGENDARY,      // Extremely rare
        MYTHIC          // One-time or very limited
    }

    // ============ State Variables ============
    
    string public name = "SYNAPSE Achievements";
    string public symbol = "SYNX-ACH";
    string public baseUri;

    mapping(uint256 => Achievement) public achievements;
    mapping(address => UserProgress) private userProgress;
    
    uint256 public achievementCount;
    uint256 public totalPointsDistributed;
    
    // Leaderboard
    address[] public leaderboardAddresses;
    mapping(address => bool) public isOnLeaderboard;
    
    // Achievement requirements (for automated unlocking)
    mapping(uint256 => bytes) public achievementRequirements;
    
    // Points multiplier for rarity
    uint256[6] public rarityMultipliers = [100, 150, 250, 500, 1000, 2500]; // basis points

    // ============ Events ============
    
    event AchievementCreated(
        uint256 indexed achievementId,
        string name,
        AchievementCategory category,
        AchievementRarity rarity
    );
    
    event AchievementUnlocked(
        address indexed user,
        uint256 indexed achievementId,
        uint256 points,
        uint256 timestamp
    );
    
    event PointsAwarded(
        address indexed user,
        uint256 points,
        string reason
    );
    
    event LeaderboardUpdated(
        address indexed user,
        uint256 newPoints,
        uint256 rank
    );

    // ============ Constructor ============
    
    constructor(string memory _baseUri) ERC1155(_baseUri) {
        baseUri = _baseUri;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);

        // Create initial achievements
        _createInitialAchievements();
    }

    // ============ Achievement Creation ============
    
    /**
     * @notice Create a new achievement
     */
    function createAchievement(
        string calldata _name,
        string calldata _description,
        string calldata _imageUri,
        AchievementCategory _category,
        AchievementRarity _rarity,
        uint256 _maxSupply,
        uint256 _basePoints,
        bool _transferable
    ) external onlyRole(ADMIN_ROLE) returns (uint256 achievementId) {
        achievementId = ++achievementCount;
        
        // Apply rarity multiplier to points
        uint256 points = (_basePoints * rarityMultipliers[uint256(_rarity)]) / 100;

        achievements[achievementId] = Achievement({
            name: _name,
            description: _description,
            imageUri: _imageUri,
            category: _category,
            rarity: _rarity,
            maxSupply: _maxSupply,
            points: points,
            transferable: _transferable,
            active: true,
            createdAt: block.timestamp
        });

        emit AchievementCreated(achievementId, _name, _category, _rarity);
    }

    /**
     * @notice Set achievement requirements for automated unlocking
     */
    function setAchievementRequirements(
        uint256 achievementId,
        bytes calldata requirements
    ) external onlyRole(ADMIN_ROLE) {
        require(achievements[achievementId].active, "Achievement not active");
        achievementRequirements[achievementId] = requirements;
    }

    /**
     * @dev Create initial achievement set
     */
    function _createInitialAchievements() internal {
        // Payment achievements
        _createAchievementInternal("First Payment", "Made your first payment", "", AchievementCategory.PAYMENT, AchievementRarity.COMMON, 0, 10, false);
        _createAchievementInternal("Payment Pro", "Made 100 payments", "", AchievementCategory.PAYMENT, AchievementRarity.UNCOMMON, 0, 50, false);
        _createAchievementInternal("Payment Master", "Made 1000 payments", "", AchievementCategory.PAYMENT, AchievementRarity.RARE, 0, 100, false);
        _createAchievementInternal("Whale", "Single payment over 10,000 SYNX", "", AchievementCategory.PAYMENT, AchievementRarity.EPIC, 0, 200, false);
        
        // Staking achievements
        _createAchievementInternal("Staker", "Staked tokens for the first time", "", AchievementCategory.STAKING, AchievementRarity.COMMON, 0, 10, false);
        _createAchievementInternal("Diamond Hands", "Staked for 365 days", "", AchievementCategory.STAKING, AchievementRarity.LEGENDARY, 0, 500, false);
        _createAchievementInternal("Top Staker", "In top 100 stakers", "", AchievementCategory.STAKING, AchievementRarity.MYTHIC, 100, 1000, false);
        
        // Agent achievements
        _createAchievementInternal("Agent Registered", "Registered as an AI agent", "", AchievementCategory.AGENT, AchievementRarity.COMMON, 0, 20, false);
        _createAchievementInternal("Trusted Agent", "Reached Gold tier", "", AchievementCategory.AGENT, AchievementRarity.RARE, 0, 150, false);
        _createAchievementInternal("Elite Agent", "Reached Diamond tier", "", AchievementCategory.AGENT, AchievementRarity.LEGENDARY, 0, 500, false);
        
        // Service achievements
        _createAchievementInternal("Service Provider", "Registered first service", "", AchievementCategory.SERVICE, AchievementRarity.COMMON, 0, 20, false);
        _createAchievementInternal("Popular Service", "Service used 1000 times", "", AchievementCategory.SERVICE, AchievementRarity.RARE, 0, 200, false);
        
        // Community achievements
        _createAchievementInternal("Early Adopter", "Joined in first month", "", AchievementCategory.COMMUNITY, AchievementRarity.EPIC, 10000, 300, false);
        _createAchievementInternal("OG", "Genesis participant", "", AchievementCategory.COMMUNITY, AchievementRarity.MYTHIC, 1000, 1000, false);
        
        // Governance achievements
        _createAchievementInternal("Voter", "Participated in governance vote", "", AchievementCategory.GOVERNANCE, AchievementRarity.COMMON, 0, 15, false);
        _createAchievementInternal("Proposal Creator", "Created a governance proposal", "", AchievementCategory.GOVERNANCE, AchievementRarity.RARE, 0, 100, false);
    }

    function _createAchievementInternal(
        string memory _name,
        string memory _description,
        string memory _imageUri,
        AchievementCategory _category,
        AchievementRarity _rarity,
        uint256 _maxSupply,
        uint256 _basePoints,
        bool _transferable
    ) internal {
        uint256 achievementId = ++achievementCount;
        uint256 points = (_basePoints * rarityMultipliers[uint256(_rarity)]) / 100;

        achievements[achievementId] = Achievement({
            name: _name,
            description: _description,
            imageUri: _imageUri,
            category: _category,
            rarity: _rarity,
            maxSupply: _maxSupply,
            points: points,
            transferable: _transferable,
            active: true,
            createdAt: block.timestamp
        });
    }

    // ============ Achievement Minting ============
    
    /**
     * @notice Unlock achievement for user
     */
    function unlockAchievement(
        address user,
        uint256 achievementId
    ) external onlyRole(MINTER_ROLE) nonReentrant {
        Achievement storage achievement = achievements[achievementId];
        
        require(achievement.active, "Achievement not active");
        require(balanceOf(user, achievementId) == 0, "Already unlocked");
        
        if (achievement.maxSupply > 0) {
            require(totalSupply(achievementId) < achievement.maxSupply, "Max supply reached");
        }

        // Mint NFT
        _mint(user, achievementId, 1, "");

        // Update user progress
        UserProgress storage progress = userProgress[user];
        progress.totalPoints += achievement.points;
        progress.achievementCount++;
        progress.unlockedAchievements.push(achievementId);
        progress.achievementTimestamps[achievementId] = block.timestamp;

        totalPointsDistributed += achievement.points;

        // Update leaderboard
        _updateLeaderboard(user);

        emit AchievementUnlocked(user, achievementId, achievement.points, block.timestamp);
    }

    /**
     * @notice Batch unlock achievements
     */
    function batchUnlockAchievements(
        address user,
        uint256[] calldata achievementIds
    ) external onlyRole(MINTER_ROLE) nonReentrant {
        for (uint256 i = 0; i < achievementIds.length; i++) {
            uint256 achievementId = achievementIds[i];
            Achievement storage achievement = achievements[achievementId];
            
            if (!achievement.active || balanceOf(user, achievementId) > 0) {
                continue;
            }
            
            if (achievement.maxSupply > 0 && totalSupply(achievementId) >= achievement.maxSupply) {
                continue;
            }

            _mint(user, achievementId, 1, "");

            UserProgress storage progress = userProgress[user];
            progress.totalPoints += achievement.points;
            progress.achievementCount++;
            progress.unlockedAchievements.push(achievementId);
            progress.achievementTimestamps[achievementId] = block.timestamp;

            totalPointsDistributed += achievement.points;

            emit AchievementUnlocked(user, achievementId, achievement.points, block.timestamp);
        }

        _updateLeaderboard(user);
    }

    /**
     * @notice Award bonus points
     */
    function awardPoints(
        address user,
        uint256 points,
        string calldata reason
    ) external onlyRole(MINTER_ROLE) {
        userProgress[user].totalPoints += points;
        totalPointsDistributed += points;
        
        _updateLeaderboard(user);

        emit PointsAwarded(user, points, reason);
    }

    // ============ Leaderboard ============
    
    /**
     * @dev Update leaderboard position
     */
    function _updateLeaderboard(address user) internal {
        if (!isOnLeaderboard[user]) {
            leaderboardAddresses.push(user);
            isOnLeaderboard[user] = true;
        }

        // Find rank (simple linear search, optimize for production)
        uint256 userPoints = userProgress[user].totalPoints;
        uint256 rank = 1;
        
        for (uint256 i = 0; i < leaderboardAddresses.length; i++) {
            if (leaderboardAddresses[i] != user && 
                userProgress[leaderboardAddresses[i]].totalPoints > userPoints) {
                rank++;
            }
        }

        emit LeaderboardUpdated(user, userPoints, rank);
    }

    /**
     * @notice Get leaderboard
     */
    function getLeaderboard(uint256 limit) external view returns (Leaderboard[] memory) {
        uint256 count = leaderboardAddresses.length < limit ? leaderboardAddresses.length : limit;
        Leaderboard[] memory board = new Leaderboard[](count);

        // Create unsorted array
        Leaderboard[] memory all = new Leaderboard[](leaderboardAddresses.length);
        for (uint256 i = 0; i < leaderboardAddresses.length; i++) {
            address addr = leaderboardAddresses[i];
            all[i] = Leaderboard({
                user: addr,
                points: userProgress[addr].totalPoints,
                achievementCount: userProgress[addr].achievementCount
            });
        }

        // Simple bubble sort (optimize for production)
        for (uint256 i = 0; i < all.length; i++) {
            for (uint256 j = i + 1; j < all.length; j++) {
                if (all[j].points > all[i].points) {
                    Leaderboard memory temp = all[i];
                    all[i] = all[j];
                    all[j] = temp;
                }
            }
        }

        // Return top entries
        for (uint256 i = 0; i < count; i++) {
            board[i] = all[i];
        }

        return board;
    }

    // ============ View Functions ============
    
    /**
     * @notice Get user progress
     */
    function getUserProgress(address user) external view returns (
        uint256 totalPoints,
        uint256 achievementCount_,
        uint256[] memory unlockedAchievements
    ) {
        UserProgress storage progress = userProgress[user];
        return (
            progress.totalPoints,
            progress.achievementCount,
            progress.unlockedAchievements
        );
    }

    /**
     * @notice Get achievement details
     */
    function getAchievement(uint256 achievementId) external view returns (
        string memory _name,
        string memory description,
        AchievementCategory category,
        AchievementRarity rarity,
        uint256 maxSupply,
        uint256 currentSupply,
        uint256 points,
        bool transferable,
        bool active
    ) {
        Achievement storage a = achievements[achievementId];
        return (
            a.name,
            a.description,
            a.category,
            a.rarity,
            a.maxSupply,
            totalSupply(achievementId),
            a.points,
            a.transferable,
            a.active
        );
    }

    /**
     * @notice Get achievements by category
     */
    function getAchievementsByCategory(AchievementCategory category) 
        external view returns (uint256[] memory) 
    {
        uint256 count = 0;
        for (uint256 i = 1; i <= achievementCount; i++) {
            if (achievements[i].category == category) count++;
        }

        uint256[] memory result = new uint256[](count);
        uint256 index = 0;
        for (uint256 i = 1; i <= achievementCount; i++) {
            if (achievements[i].category == category) {
                result[index++] = i;
            }
        }

        return result;
    }

    /**
     * @notice Check if user has achievement
     */
    function hasAchievement(address user, uint256 achievementId) external view returns (bool) {
        return balanceOf(user, achievementId) > 0;
    }

    /**
     * @notice Get achievement unlock timestamp
     */
    function getUnlockTimestamp(address user, uint256 achievementId) external view returns (uint256) {
        return userProgress[user].achievementTimestamps[achievementId];
    }

    /**
     * @notice Get user rank
     */
    function getUserRank(address user) external view returns (uint256 rank) {
        uint256 userPoints = userProgress[user].totalPoints;
        rank = 1;
        
        for (uint256 i = 0; i < leaderboardAddresses.length; i++) {
            if (leaderboardAddresses[i] != user && 
                userProgress[leaderboardAddresses[i]].totalPoints > userPoints) {
                rank++;
            }
        }
    }

    // ============ Admin Functions ============
    
    /**
     * @notice Update achievement
     */
    function updateAchievement(
        uint256 achievementId,
        string calldata _name,
        string calldata _description,
        bool active
    ) external onlyRole(ADMIN_ROLE) {
        Achievement storage a = achievements[achievementId];
        a.name = _name;
        a.description = _description;
        a.active = active;
    }

    /**
     * @notice Set base URI
     */
    function setBaseUri(string calldata _baseUri) external onlyRole(ADMIN_ROLE) {
        baseUri = _baseUri;
    }

    /**
     * @notice Set rarity multipliers
     */
    function setRarityMultipliers(uint256[6] calldata multipliers) external onlyRole(ADMIN_ROLE) {
        rarityMultipliers = multipliers;
    }

    // ============ Overrides ============
    
    function uri(uint256 tokenId) public view override returns (string memory) {
        return string(abi.encodePacked(baseUri, tokenId.toString(), ".json"));
    }

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override(ERC1155, ERC1155Supply) {
        // Check transferability for each token
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; i++) {
                require(achievements[ids[i]].transferable, "Achievement not transferable");
            }
        }
        
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC1155, AccessControl) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
