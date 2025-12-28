// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title SynapseGovernor
 * @notice DAO Governance contract for SYNAPSE Protocol
 * @dev OpenZeppelin Governor with timelock, quorum, and voting settings
 * 
 * Governance Parameters:
 * - Voting Delay: 1 day (time between proposal and voting start)
 * - Voting Period: 5 days
 * - Proposal Threshold: 100,000 SYNX
 * - Quorum: 10% of total supply
 * - Timelock: 2 days minimum delay
 */
contract SynapseGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    // ============ Constants ============
    
    uint256 public constant PROPOSAL_THRESHOLD = 100_000 * 10**18; // 100,000 SYNX
    
    // ============ Events ============
    
    event EmergencyActionExecuted(
        address indexed executor,
        address indexed target,
        bytes data
    );
    
    // ============ Constructor ============
    
    constructor(
        IVotes _token,
        TimelockController _timelock
    )
        Governor("SYNAPSE Governor")
        GovernorSettings(
            7200,      // 1 day voting delay (assuming 12s blocks)
            36000,     // 5 days voting period
            PROPOSAL_THRESHOLD
        )
        GovernorVotes(_token)
        GovernorVotesQuorumFraction(10) // 10% quorum
        GovernorTimelockControl(_timelock)
    {}
    
    // ============ Required Overrides ============
    
    function votingDelay()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }
    
    function votingPeriod()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }
    
    function quorum(uint256 blockNumber)
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }
    
    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }
    
    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }
    
    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }
    
    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(
            proposalId,
            targets,
            values,
            calldatas,
            descriptionHash
        );
    }
    
    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(
            proposalId,
            targets,
            values,
            calldatas,
            descriptionHash
        );
    }
    
    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }
    
    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }
}

/**
 * @title SynapseTimelock
 * @notice Timelock controller for SYNAPSE governance
 * @dev Executes proposals with a delay for security
 */
contract SynapseTimelock is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}

/**
 * @title Treasury
 * @notice Treasury contract controlled by governance
 * @dev Holds protocol fees and funds community initiatives
 */
contract Treasury {
    address public governor;
    address public timelock;
    
    mapping(address => bool) public approvedTokens;
    
    event FundsAllocated(
        address indexed token,
        address indexed recipient,
        uint256 amount,
        string reason
    );
    
    event TokenApproved(address indexed token);
    event TokenRevoked(address indexed token);
    
    modifier onlyGovernance() {
        require(
            msg.sender == timelock || msg.sender == governor,
            "Treasury: not governance"
        );
        _;
    }
    
    constructor(address _governor, address _timelock) {
        governor = _governor;
        timelock = _timelock;
    }
    
    function allocateFunds(
        address token,
        address recipient,
        uint256 amount,
        string calldata reason
    ) external onlyGovernance {
        require(approvedTokens[token], "Treasury: token not approved");
        
        IERC20(token).transfer(recipient, amount);
        
        emit FundsAllocated(token, recipient, amount, reason);
    }
    
    function approveToken(address token) external onlyGovernance {
        approvedTokens[token] = true;
        emit TokenApproved(token);
    }
    
    function revokeToken(address token) external onlyGovernance {
        approvedTokens[token] = false;
        emit TokenRevoked(token);
    }
    
    function setGovernor(address _governor) external onlyGovernance {
        governor = _governor;
    }
    
    function setTimelock(address _timelock) external onlyGovernance {
        timelock = _timelock;
    }
    
    // Allow receiving ETH
    receive() external payable {}
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
