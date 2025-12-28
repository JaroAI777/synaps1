// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title PaymentChannel
 * @notice Bidirectional payment channel for high-frequency AI-to-AI micropayments
 * @dev Enables off-chain transactions with on-chain settlement
 * 
 * Flow:
 * 1. Both parties deposit funds to open the channel
 * 2. Off-chain: Parties exchange signed state updates
 * 3. Either party can close with the latest state
 * 4. Challenge period allows disputing invalid closes
 */
contract PaymentChannel is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;
    
    // ============ Constants ============
    
    uint256 public constant CHALLENGE_PERIOD = 1 hours;
    uint256 public constant MIN_DEPOSIT = 1; // 1 wei SYNX
    
    // ============ Enums ============
    
    enum ChannelStatus {
        None,
        Open,
        Closing,
        Closed,
        Disputed
    }
    
    // ============ Structs ============
    
    struct Channel {
        bytes32 channelId;
        address partyA;
        address partyB;
        uint256 depositA;
        uint256 depositB;
        uint256 balanceA;
        uint256 balanceB;
        uint256 nonce;
        uint256 openTime;
        uint256 closeTime;
        uint256 challengeEnd;
        ChannelStatus status;
        bytes32 latestStateHash;
    }
    
    struct ChannelState {
        bytes32 channelId;
        uint256 balanceA;
        uint256 balanceB;
        uint256 nonce;
    }
    
    // ============ State Variables ============
    
    IERC20 public immutable synxToken;
    address public factory;
    
    mapping(bytes32 => Channel) public channels;
    mapping(address => bytes32[]) public userChannels;
    
    uint256 public totalChannels;
    uint256 public totalVolumeLocked;
    
    // ============ Events ============
    
    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed partyA,
        address indexed partyB,
        uint256 depositA,
        uint256 depositB
    );
    
    event ChannelDeposit(
        bytes32 indexed channelId,
        address indexed party,
        uint256 amount
    );
    
    event ChannelCloseInitiated(
        bytes32 indexed channelId,
        address indexed initiator,
        uint256 balanceA,
        uint256 balanceB,
        uint256 nonce
    );
    
    event ChannelChallenged(
        bytes32 indexed channelId,
        address indexed challenger,
        uint256 newNonce
    );
    
    event ChannelClosed(
        bytes32 indexed channelId,
        uint256 finalBalanceA,
        uint256 finalBalanceB
    );
    
    event ChannelDisputed(bytes32 indexed channelId);
    
    // ============ Errors ============
    
    error ChannelNotFound();
    error ChannelNotOpen();
    error ChannelAlreadyExists();
    error InvalidParty();
    error InvalidDeposit();
    error InvalidSignature();
    error InvalidNonce();
    error InvalidBalances();
    error ChallengePeriodNotOver();
    error ChallengePeriodOver();
    error NotParty();
    error ChannelNotClosing();
    
    // ============ Constructor ============
    
    constructor(address _synxToken) {
        synxToken = IERC20(_synxToken);
        factory = msg.sender;
    }
    
    // ============ Channel Management ============
    
    /**
     * @notice Open a new payment channel between two parties
     * @param partyB The other party in the channel
     * @param depositA Initial deposit from party A (msg.sender)
     * @param depositB Initial deposit from party B (requires pre-approval)
     */
    function openChannel(
        address partyB,
        uint256 depositA,
        uint256 depositB
    ) external nonReentrant returns (bytes32) {
        if (partyB == address(0) || partyB == msg.sender) revert InvalidParty();
        if (depositA < MIN_DEPOSIT && depositB < MIN_DEPOSIT) revert InvalidDeposit();
        
        bytes32 channelId = keccak256(abi.encodePacked(
            msg.sender,
            partyB,
            block.timestamp,
            totalChannels
        ));
        
        if (channels[channelId].status != ChannelStatus.None) {
            revert ChannelAlreadyExists();
        }
        
        // Transfer deposits
        if (depositA > 0) {
            synxToken.safeTransferFrom(msg.sender, address(this), depositA);
        }
        if (depositB > 0) {
            synxToken.safeTransferFrom(partyB, address(this), depositB);
        }
        
        uint256 total = depositA + depositB;
        
        channels[channelId] = Channel({
            channelId: channelId,
            partyA: msg.sender,
            partyB: partyB,
            depositA: depositA,
            depositB: depositB,
            balanceA: depositA,
            balanceB: depositB,
            nonce: 0,
            openTime: block.timestamp,
            closeTime: 0,
            challengeEnd: 0,
            status: ChannelStatus.Open,
            latestStateHash: bytes32(0)
        });
        
        userChannels[msg.sender].push(channelId);
        userChannels[partyB].push(channelId);
        
        totalChannels++;
        totalVolumeLocked += total;
        
        emit ChannelOpened(channelId, msg.sender, partyB, depositA, depositB);
        
        return channelId;
    }
    
    /**
     * @notice Add deposit to an existing channel
     */
    function deposit(bytes32 channelId, uint256 amount) external nonReentrant {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Open) revert ChannelNotOpen();
        
        bool isPartyA = msg.sender == channel.partyA;
        bool isPartyB = msg.sender == channel.partyB;
        if (!isPartyA && !isPartyB) revert NotParty();
        
        synxToken.safeTransferFrom(msg.sender, address(this), amount);
        
        if (isPartyA) {
            channel.depositA += amount;
            channel.balanceA += amount;
        } else {
            channel.depositB += amount;
            channel.balanceB += amount;
        }
        
        totalVolumeLocked += amount;
        
        emit ChannelDeposit(channelId, msg.sender, amount);
    }
    
    /**
     * @notice Initiate channel closure with a signed state
     * @param channelId ID of the channel to close
     * @param balanceA Final balance for party A
     * @param balanceB Final balance for party B
     * @param nonce State nonce (must be latest)
     * @param sigA Signature from party A
     * @param sigB Signature from party B
     */
    function initiateClose(
        bytes32 channelId,
        uint256 balanceA,
        uint256 balanceB,
        uint256 nonce,
        bytes calldata sigA,
        bytes calldata sigB
    ) external nonReentrant {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Open) revert ChannelNotOpen();
        if (msg.sender != channel.partyA && msg.sender != channel.partyB) {
            revert NotParty();
        }
        
        // Verify total balances don't exceed deposits
        uint256 totalDeposits = channel.depositA + channel.depositB;
        if (balanceA + balanceB != totalDeposits) revert InvalidBalances();
        
        // Verify signatures
        bytes32 stateHash = _hashState(channelId, balanceA, balanceB, nonce);
        
        if (!_verifySignature(stateHash, sigA, channel.partyA)) {
            revert InvalidSignature();
        }
        if (!_verifySignature(stateHash, sigB, channel.partyB)) {
            revert InvalidSignature();
        }
        
        channel.balanceA = balanceA;
        channel.balanceB = balanceB;
        channel.nonce = nonce;
        channel.closeTime = block.timestamp;
        channel.challengeEnd = block.timestamp + CHALLENGE_PERIOD;
        channel.status = ChannelStatus.Closing;
        channel.latestStateHash = stateHash;
        
        emit ChannelCloseInitiated(channelId, msg.sender, balanceA, balanceB, nonce);
    }
    
    /**
     * @notice Challenge a closing state with a newer state
     */
    function challenge(
        bytes32 channelId,
        uint256 balanceA,
        uint256 balanceB,
        uint256 nonce,
        bytes calldata sigA,
        bytes calldata sigB
    ) external nonReentrant {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Closing) revert ChannelNotClosing();
        if (block.timestamp > channel.challengeEnd) revert ChallengePeriodOver();
        if (msg.sender != channel.partyA && msg.sender != channel.partyB) {
            revert NotParty();
        }
        
        // New state must have higher nonce
        if (nonce <= channel.nonce) revert InvalidNonce();
        
        // Verify balances
        uint256 totalDeposits = channel.depositA + channel.depositB;
        if (balanceA + balanceB != totalDeposits) revert InvalidBalances();
        
        // Verify signatures
        bytes32 stateHash = _hashState(channelId, balanceA, balanceB, nonce);
        
        if (!_verifySignature(stateHash, sigA, channel.partyA)) {
            revert InvalidSignature();
        }
        if (!_verifySignature(stateHash, sigB, channel.partyB)) {
            revert InvalidSignature();
        }
        
        // Update state
        channel.balanceA = balanceA;
        channel.balanceB = balanceB;
        channel.nonce = nonce;
        channel.challengeEnd = block.timestamp + CHALLENGE_PERIOD;
        channel.latestStateHash = stateHash;
        
        emit ChannelChallenged(channelId, msg.sender, nonce);
    }
    
    /**
     * @notice Finalize channel closure after challenge period
     */
    function finalizeClose(bytes32 channelId) external nonReentrant {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Closing) revert ChannelNotClosing();
        if (block.timestamp < channel.challengeEnd) revert ChallengePeriodNotOver();
        
        channel.status = ChannelStatus.Closed;
        
        uint256 total = channel.balanceA + channel.balanceB;
        totalVolumeLocked -= total;
        
        // Distribute final balances
        if (channel.balanceA > 0) {
            synxToken.safeTransfer(channel.partyA, channel.balanceA);
        }
        if (channel.balanceB > 0) {
            synxToken.safeTransfer(channel.partyB, channel.balanceB);
        }
        
        emit ChannelClosed(channelId, channel.balanceA, channel.balanceB);
    }
    
    /**
     * @notice Cooperative instant close (both parties sign)
     */
    function cooperativeClose(
        bytes32 channelId,
        uint256 balanceA,
        uint256 balanceB,
        uint256 nonce,
        bytes calldata sigA,
        bytes calldata sigB
    ) external nonReentrant {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Open) revert ChannelNotOpen();
        
        // Verify balances
        uint256 totalDeposits = channel.depositA + channel.depositB;
        if (balanceA + balanceB != totalDeposits) revert InvalidBalances();
        
        // Verify signatures with cooperative close flag
        bytes32 stateHash = keccak256(abi.encodePacked(
            channelId,
            balanceA,
            balanceB,
            nonce,
            "COOPERATIVE_CLOSE"
        ));
        
        if (!_verifySignature(stateHash, sigA, channel.partyA)) {
            revert InvalidSignature();
        }
        if (!_verifySignature(stateHash, sigB, channel.partyB)) {
            revert InvalidSignature();
        }
        
        channel.balanceA = balanceA;
        channel.balanceB = balanceB;
        channel.nonce = nonce;
        channel.status = ChannelStatus.Closed;
        
        totalVolumeLocked -= totalDeposits;
        
        // Distribute immediately
        if (balanceA > 0) {
            synxToken.safeTransfer(channel.partyA, balanceA);
        }
        if (balanceB > 0) {
            synxToken.safeTransfer(channel.partyB, balanceB);
        }
        
        emit ChannelClosed(channelId, balanceA, balanceB);
    }
    
    // ============ View Functions ============
    
    function getChannel(bytes32 channelId) external view returns (Channel memory) {
        return channels[channelId];
    }
    
    function getUserChannels(address user) external view returns (bytes32[] memory) {
        return userChannels[user];
    }
    
    function getChannelBalance(bytes32 channelId, address party) 
        external 
        view 
        returns (uint256) 
    {
        Channel storage channel = channels[channelId];
        if (party == channel.partyA) return channel.balanceA;
        if (party == channel.partyB) return channel.balanceB;
        return 0;
    }
    
    function isChannelOpen(bytes32 channelId) external view returns (bool) {
        return channels[channelId].status == ChannelStatus.Open;
    }
    
    function getRemainingChallengeTime(bytes32 channelId) external view returns (uint256) {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Closing) return 0;
        if (block.timestamp >= channel.challengeEnd) return 0;
        return channel.challengeEnd - block.timestamp;
    }
    
    // ============ Signature Utilities ============
    
    function _hashState(
        bytes32 channelId,
        uint256 balanceA,
        uint256 balanceB,
        uint256 nonce
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            channelId,
            balanceA,
            balanceB,
            nonce,
            block.chainid,
            address(this)
        ));
    }
    
    function _verifySignature(
        bytes32 hash,
        bytes calldata signature,
        address expectedSigner
    ) internal pure returns (bool) {
        bytes32 ethSignedHash = hash.toEthSignedMessageHash();
        address signer = ethSignedHash.recover(signature);
        return signer == expectedSigner;
    }
    
    /**
     * @notice Helper to create state hash for off-chain signing
     */
    function createStateHash(
        bytes32 channelId,
        uint256 balanceA,
        uint256 balanceB,
        uint256 nonce
    ) external view returns (bytes32) {
        return _hashState(channelId, balanceA, balanceB, nonce);
    }
    
    /**
     * @notice Helper to create cooperative close hash
     */
    function createCooperativeCloseHash(
        bytes32 channelId,
        uint256 balanceA,
        uint256 balanceB,
        uint256 nonce
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(
            channelId,
            balanceA,
            balanceB,
            nonce,
            "COOPERATIVE_CLOSE"
        ));
    }
}

/**
 * @title PaymentChannelFactory
 * @notice Factory for deploying payment channels
 */
contract PaymentChannelFactory {
    address public immutable synxToken;
    address[] public deployedChannels;
    
    event ChannelContractDeployed(address indexed channel, address indexed deployer);
    
    constructor(address _synxToken) {
        synxToken = _synxToken;
    }
    
    function deployChannel() external returns (address) {
        PaymentChannel channel = new PaymentChannel(synxToken);
        deployedChannels.push(address(channel));
        emit ChannelContractDeployed(address(channel), msg.sender);
        return address(channel);
    }
    
    function getDeployedChannels() external view returns (address[] memory) {
        return deployedChannels;
    }
}
