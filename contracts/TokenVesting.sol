// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title TokenVesting
 * @notice Manages token vesting schedules for team, investors, and advisors
 * @dev Supports multiple vesting schedules with cliff periods and linear/monthly release
 */
contract TokenVesting is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Roles ============
    bytes32 public constant VESTING_ADMIN_ROLE = keccak256("VESTING_ADMIN_ROLE");

    // ============ Enums ============
    
    enum VestingType {
        LINEAR,     // Continuous linear vesting
        MONTHLY,    // Monthly releases
        QUARTERLY,  // Quarterly releases
        MILESTONE   // Milestone-based releases
    }

    enum BeneficiaryCategory {
        TEAM,
        INVESTOR,
        ADVISOR,
        ECOSYSTEM,
        COMMUNITY,
        TREASURY
    }

    // ============ Structs ============
    
    /**
     * @notice Vesting schedule for a beneficiary
     */
    struct VestingSchedule {
        address beneficiary;
        BeneficiaryCategory category;
        uint256 totalAmount;
        uint256 releasedAmount;
        uint256 startTime;
        uint256 cliffDuration;
        uint256 vestingDuration;
        VestingType vestingType;
        bool revocable;
        bool revoked;
        uint256 revokedTime;
        uint256 revokedAmount;
    }

    /**
     * @notice Milestone for milestone-based vesting
     */
    struct Milestone {
        string description;
        uint256 percentage; // Basis points (10000 = 100%)
        bool completed;
        uint256 completedTime;
    }

    // ============ State Variables ============
    
    IERC20 public token;
    
    // Vesting schedules
    mapping(bytes32 => VestingSchedule) public vestingSchedules;
    bytes32[] public vestingScheduleIds;
    mapping(address => bytes32[]) public beneficiarySchedules;
    
    // Milestones for milestone-based vesting
    mapping(bytes32 => Milestone[]) public scheduleMilestones;
    
    // Statistics
    uint256 public totalVestedAmount;
    uint256 public totalReleasedAmount;
    uint256 public totalRevokedAmount;
    
    // Category allocations
    mapping(BeneficiaryCategory => uint256) public categoryAllocations;
    mapping(BeneficiaryCategory => uint256) public categoryVested;
    
    // ============ Events ============
    
    event VestingScheduleCreated(
        bytes32 indexed scheduleId,
        address indexed beneficiary,
        BeneficiaryCategory category,
        uint256 totalAmount,
        uint256 startTime,
        uint256 cliffDuration,
        uint256 vestingDuration,
        VestingType vestingType
    );
    
    event TokensReleased(
        bytes32 indexed scheduleId,
        address indexed beneficiary,
        uint256 amount
    );
    
    event VestingRevoked(
        bytes32 indexed scheduleId,
        address indexed beneficiary,
        uint256 revokedAmount,
        uint256 releasedAmount
    );
    
    event MilestoneCompleted(
        bytes32 indexed scheduleId,
        uint256 milestoneIndex,
        string description,
        uint256 percentage
    );
    
    event BeneficiaryChanged(
        bytes32 indexed scheduleId,
        address indexed oldBeneficiary,
        address indexed newBeneficiary
    );
    
    event CategoryAllocationSet(
        BeneficiaryCategory category,
        uint256 allocation
    );

    // ============ Constructor ============
    
    constructor(address _token) {
        require(_token != address(0), "Invalid token address");
        token = IERC20(_token);
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VESTING_ADMIN_ROLE, msg.sender);
    }

    // ============ Vesting Schedule Management ============
    
    /**
     * @notice Create a new vesting schedule
     */
    function createVestingSchedule(
        address beneficiary,
        BeneficiaryCategory category,
        uint256 totalAmount,
        uint256 startTime,
        uint256 cliffDuration,
        uint256 vestingDuration,
        VestingType vestingType,
        bool revocable
    ) external onlyRole(VESTING_ADMIN_ROLE) whenNotPaused returns (bytes32 scheduleId) {
        require(beneficiary != address(0), "Invalid beneficiary");
        require(totalAmount > 0, "Amount must be > 0");
        require(vestingDuration > 0, "Duration must be > 0");
        require(vestingDuration >= cliffDuration, "Invalid cliff");
        
        // Check category allocation
        require(
            categoryVested[category] + totalAmount <= categoryAllocations[category] ||
            categoryAllocations[category] == 0, // No limit set
            "Category allocation exceeded"
        );
        
        scheduleId = keccak256(abi.encodePacked(
            beneficiary,
            block.timestamp,
            vestingScheduleIds.length
        ));
        
        vestingSchedules[scheduleId] = VestingSchedule({
            beneficiary: beneficiary,
            category: category,
            totalAmount: totalAmount,
            releasedAmount: 0,
            startTime: startTime,
            cliffDuration: cliffDuration,
            vestingDuration: vestingDuration,
            vestingType: vestingType,
            revocable: revocable,
            revoked: false,
            revokedTime: 0,
            revokedAmount: 0
        });
        
        vestingScheduleIds.push(scheduleId);
        beneficiarySchedules[beneficiary].push(scheduleId);
        
        totalVestedAmount += totalAmount;
        categoryVested[category] += totalAmount;
        
        // Transfer tokens to contract
        token.safeTransferFrom(msg.sender, address(this), totalAmount);
        
        emit VestingScheduleCreated(
            scheduleId,
            beneficiary,
            category,
            totalAmount,
            startTime,
            cliffDuration,
            vestingDuration,
            vestingType
        );
    }

    /**
     * @notice Create vesting schedule with milestones
     */
    function createMilestoneVesting(
        address beneficiary,
        BeneficiaryCategory category,
        uint256 totalAmount,
        uint256 startTime,
        bool revocable,
        string[] calldata milestoneDescriptions,
        uint256[] calldata milestonePercentages
    ) external onlyRole(VESTING_ADMIN_ROLE) whenNotPaused returns (bytes32 scheduleId) {
        require(milestoneDescriptions.length == milestonePercentages.length, "Length mismatch");
        require(milestoneDescriptions.length > 0, "No milestones");
        
        // Verify percentages sum to 100%
        uint256 totalPercentage;
        for (uint256 i = 0; i < milestonePercentages.length; i++) {
            totalPercentage += milestonePercentages[i];
        }
        require(totalPercentage == 10000, "Percentages must sum to 100%");
        
        scheduleId = keccak256(abi.encodePacked(
            beneficiary,
            block.timestamp,
            vestingScheduleIds.length
        ));
        
        vestingSchedules[scheduleId] = VestingSchedule({
            beneficiary: beneficiary,
            category: category,
            totalAmount: totalAmount,
            releasedAmount: 0,
            startTime: startTime,
            cliffDuration: 0,
            vestingDuration: type(uint256).max, // No time limit for milestones
            vestingType: VestingType.MILESTONE,
            revocable: revocable,
            revoked: false,
            revokedTime: 0,
            revokedAmount: 0
        });
        
        // Add milestones
        for (uint256 i = 0; i < milestoneDescriptions.length; i++) {
            scheduleMilestones[scheduleId].push(Milestone({
                description: milestoneDescriptions[i],
                percentage: milestonePercentages[i],
                completed: false,
                completedTime: 0
            }));
        }
        
        vestingScheduleIds.push(scheduleId);
        beneficiarySchedules[beneficiary].push(scheduleId);
        
        totalVestedAmount += totalAmount;
        categoryVested[category] += totalAmount;
        
        token.safeTransferFrom(msg.sender, address(this), totalAmount);
        
        emit VestingScheduleCreated(
            scheduleId,
            beneficiary,
            category,
            totalAmount,
            startTime,
            0,
            type(uint256).max,
            VestingType.MILESTONE
        );
    }

    /**
     * @notice Complete a milestone and release tokens
     */
    function completeMilestone(
        bytes32 scheduleId,
        uint256 milestoneIndex
    ) external onlyRole(VESTING_ADMIN_ROLE) nonReentrant {
        VestingSchedule storage schedule = vestingSchedules[scheduleId];
        require(schedule.vestingType == VestingType.MILESTONE, "Not milestone vesting");
        require(!schedule.revoked, "Schedule revoked");
        require(milestoneIndex < scheduleMilestones[scheduleId].length, "Invalid milestone");
        
        Milestone storage milestone = scheduleMilestones[scheduleId][milestoneIndex];
        require(!milestone.completed, "Already completed");
        
        milestone.completed = true;
        milestone.completedTime = block.timestamp;
        
        // Calculate and release tokens
        uint256 releaseAmount = (schedule.totalAmount * milestone.percentage) / 10000;
        
        schedule.releasedAmount += releaseAmount;
        totalReleasedAmount += releaseAmount;
        
        token.safeTransfer(schedule.beneficiary, releaseAmount);
        
        emit MilestoneCompleted(scheduleId, milestoneIndex, milestone.description, milestone.percentage);
        emit TokensReleased(scheduleId, schedule.beneficiary, releaseAmount);
    }

    // ============ Token Release ============
    
    /**
     * @notice Release vested tokens for a schedule
     */
    function release(bytes32 scheduleId) external nonReentrant {
        VestingSchedule storage schedule = vestingSchedules[scheduleId];
        require(
            msg.sender == schedule.beneficiary || 
            hasRole(VESTING_ADMIN_ROLE, msg.sender),
            "Not authorized"
        );
        require(!schedule.revoked, "Schedule revoked");
        require(schedule.vestingType != VestingType.MILESTONE, "Use completeMilestone");
        
        uint256 releasable = _computeReleasableAmount(scheduleId);
        require(releasable > 0, "Nothing to release");
        
        schedule.releasedAmount += releasable;
        totalReleasedAmount += releasable;
        
        token.safeTransfer(schedule.beneficiary, releasable);
        
        emit TokensReleased(scheduleId, schedule.beneficiary, releasable);
    }

    /**
     * @notice Release all vested tokens for a beneficiary
     */
    function releaseAll() external nonReentrant {
        bytes32[] storage schedules = beneficiarySchedules[msg.sender];
        uint256 totalReleasable;
        
        for (uint256 i = 0; i < schedules.length; i++) {
            VestingSchedule storage schedule = vestingSchedules[schedules[i]];
            
            if (schedule.revoked || schedule.vestingType == VestingType.MILESTONE) {
                continue;
            }
            
            uint256 releasable = _computeReleasableAmount(schedules[i]);
            if (releasable > 0) {
                schedule.releasedAmount += releasable;
                totalReleasable += releasable;
                
                emit TokensReleased(schedules[i], msg.sender, releasable);
            }
        }
        
        require(totalReleasable > 0, "Nothing to release");
        totalReleasedAmount += totalReleasable;
        token.safeTransfer(msg.sender, totalReleasable);
    }

    /**
     * @notice Compute releasable amount for a schedule
     */
    function _computeReleasableAmount(bytes32 scheduleId) internal view returns (uint256) {
        VestingSchedule storage schedule = vestingSchedules[scheduleId];
        
        if (schedule.revoked) {
            return 0;
        }
        
        uint256 vestedAmount = _computeVestedAmount(scheduleId);
        return vestedAmount - schedule.releasedAmount;
    }

    /**
     * @notice Compute vested amount for a schedule
     */
    function _computeVestedAmount(bytes32 scheduleId) internal view returns (uint256) {
        VestingSchedule storage schedule = vestingSchedules[scheduleId];
        
        if (block.timestamp < schedule.startTime) {
            return 0;
        }
        
        // Check cliff
        if (block.timestamp < schedule.startTime + schedule.cliffDuration) {
            return 0;
        }
        
        uint256 endTime = schedule.revoked ? schedule.revokedTime : block.timestamp;
        uint256 timeFromStart = endTime - schedule.startTime;
        
        // Fully vested
        if (timeFromStart >= schedule.vestingDuration) {
            return schedule.totalAmount;
        }
        
        // Calculate based on vesting type
        if (schedule.vestingType == VestingType.LINEAR) {
            return (schedule.totalAmount * timeFromStart) / schedule.vestingDuration;
        } else if (schedule.vestingType == VestingType.MONTHLY) {
            uint256 monthsPassed = timeFromStart / 30 days;
            uint256 totalMonths = schedule.vestingDuration / 30 days;
            return (schedule.totalAmount * monthsPassed) / totalMonths;
        } else if (schedule.vestingType == VestingType.QUARTERLY) {
            uint256 quartersPassed = timeFromStart / 90 days;
            uint256 totalQuarters = schedule.vestingDuration / 90 days;
            return (schedule.totalAmount * quartersPassed) / totalQuarters;
        }
        
        return 0;
    }

    // ============ Revocation ============
    
    /**
     * @notice Revoke a vesting schedule
     */
    function revoke(bytes32 scheduleId) external onlyRole(VESTING_ADMIN_ROLE) nonReentrant {
        VestingSchedule storage schedule = vestingSchedules[scheduleId];
        require(schedule.revocable, "Not revocable");
        require(!schedule.revoked, "Already revoked");
        
        // Release any vested but unreleased tokens first
        uint256 vestedAmount = _computeVestedAmount(scheduleId);
        uint256 unreleased = vestedAmount - schedule.releasedAmount;
        
        if (unreleased > 0) {
            schedule.releasedAmount = vestedAmount;
            totalReleasedAmount += unreleased;
            token.safeTransfer(schedule.beneficiary, unreleased);
            emit TokensReleased(scheduleId, schedule.beneficiary, unreleased);
        }
        
        // Revoke remaining
        uint256 revokedAmount = schedule.totalAmount - vestedAmount;
        
        schedule.revoked = true;
        schedule.revokedTime = block.timestamp;
        schedule.revokedAmount = revokedAmount;
        
        totalRevokedAmount += revokedAmount;
        
        // Return revoked tokens to admin
        if (revokedAmount > 0) {
            token.safeTransfer(msg.sender, revokedAmount);
        }
        
        emit VestingRevoked(scheduleId, schedule.beneficiary, revokedAmount, schedule.releasedAmount);
    }

    // ============ Beneficiary Management ============
    
    /**
     * @notice Transfer beneficiary rights to another address
     */
    function transferBeneficiary(
        bytes32 scheduleId,
        address newBeneficiary
    ) external {
        VestingSchedule storage schedule = vestingSchedules[scheduleId];
        require(msg.sender == schedule.beneficiary, "Not beneficiary");
        require(newBeneficiary != address(0), "Invalid address");
        require(!schedule.revoked, "Schedule revoked");
        
        address oldBeneficiary = schedule.beneficiary;
        schedule.beneficiary = newBeneficiary;
        
        // Update beneficiary schedules mapping
        beneficiarySchedules[newBeneficiary].push(scheduleId);
        
        // Remove from old beneficiary (expensive, consider not doing this)
        bytes32[] storage oldSchedules = beneficiarySchedules[oldBeneficiary];
        for (uint256 i = 0; i < oldSchedules.length; i++) {
            if (oldSchedules[i] == scheduleId) {
                oldSchedules[i] = oldSchedules[oldSchedules.length - 1];
                oldSchedules.pop();
                break;
            }
        }
        
        emit BeneficiaryChanged(scheduleId, oldBeneficiary, newBeneficiary);
    }

    // ============ View Functions ============
    
    /**
     * @notice Get vesting schedule details
     */
    function getSchedule(bytes32 scheduleId) external view returns (
        address beneficiary,
        BeneficiaryCategory category,
        uint256 totalAmount,
        uint256 releasedAmount,
        uint256 vestedAmount,
        uint256 releasableAmount,
        uint256 startTime,
        uint256 cliffEnd,
        uint256 vestingEnd,
        VestingType vestingType,
        bool revocable,
        bool revoked
    ) {
        VestingSchedule storage schedule = vestingSchedules[scheduleId];
        
        return (
            schedule.beneficiary,
            schedule.category,
            schedule.totalAmount,
            schedule.releasedAmount,
            _computeVestedAmount(scheduleId),
            _computeReleasableAmount(scheduleId),
            schedule.startTime,
            schedule.startTime + schedule.cliffDuration,
            schedule.startTime + schedule.vestingDuration,
            schedule.vestingType,
            schedule.revocable,
            schedule.revoked
        );
    }

    /**
     * @notice Get releasable amount for a schedule
     */
    function getReleasableAmount(bytes32 scheduleId) external view returns (uint256) {
        return _computeReleasableAmount(scheduleId);
    }

    /**
     * @notice Get total releasable for a beneficiary
     */
    function getTotalReleasable(address beneficiary) external view returns (uint256 total) {
        bytes32[] storage schedules = beneficiarySchedules[beneficiary];
        for (uint256 i = 0; i < schedules.length; i++) {
            if (vestingSchedules[schedules[i]].vestingType != VestingType.MILESTONE) {
                total += _computeReleasableAmount(schedules[i]);
            }
        }
    }

    /**
     * @notice Get beneficiary's schedules
     */
    function getBeneficiarySchedules(address beneficiary) external view returns (bytes32[] memory) {
        return beneficiarySchedules[beneficiary];
    }

    /**
     * @notice Get milestones for a schedule
     */
    function getMilestones(bytes32 scheduleId) external view returns (Milestone[] memory) {
        return scheduleMilestones[scheduleId];
    }

    /**
     * @notice Get schedule count
     */
    function getScheduleCount() external view returns (uint256) {
        return vestingScheduleIds.length;
    }

    /**
     * @notice Get global statistics
     */
    function getStatistics() external view returns (
        uint256 _totalVested,
        uint256 _totalReleased,
        uint256 _totalRevoked,
        uint256 scheduleCount
    ) {
        return (
            totalVestedAmount,
            totalReleasedAmount,
            totalRevokedAmount,
            vestingScheduleIds.length
        );
    }

    // ============ Admin Functions ============
    
    /**
     * @notice Set category allocation limit
     */
    function setCategoryAllocation(
        BeneficiaryCategory category,
        uint256 allocation
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(allocation >= categoryVested[category], "Below already vested");
        categoryAllocations[category] = allocation;
        emit CategoryAllocationSet(category, allocation);
    }

    /**
     * @notice Pause contract
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause contract
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Recover accidentally sent tokens (not vesting token)
     */
    function recoverTokens(
        address tokenAddress,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(tokenAddress != address(token), "Cannot recover vesting token");
        IERC20(tokenAddress).safeTransfer(msg.sender, amount);
    }
}
