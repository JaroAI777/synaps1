// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title SynapseToken ($SYNX)
 * @notice The native token of SYNAPSE Protocol - AI-to-AI Payment Network
 * @dev ERC20 token with governance, burning, and permit functionality
 * 
 * Total Supply: 1,000,000,000 SYNX (1 billion)
 * Decimals: 18
 */
contract SynapseToken is 
    ERC20, 
    ERC20Burnable, 
    ERC20Permit, 
    ERC20Votes, 
    AccessControl, 
    Pausable,
    ReentrancyGuard 
{
    // ============ Constants ============
    
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 10**18; // 1 billion tokens
    uint256 public constant MAX_TRANSFER_FEE = 500; // 5% max fee (basis points)
    uint256 public constant FEE_DENOMINATOR = 10000;
    
    // ============ Roles ============
    
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");
    
    // ============ State Variables ============
    
    /// @notice Transfer fee in basis points (0-500)
    uint256 public transferFee;
    
    /// @notice Address receiving transfer fees
    address public feeCollector;
    
    /// @notice Addresses exempt from transfer fees
    mapping(address => bool) public feeExempt;
    
    /// @notice Addresses blocked from transfers
    mapping(address => bool) public blocklist;
    
    /// @notice Total fees collected
    uint256 public totalFeesCollected;
    
    /// @notice Total tokens burned
    uint256 public totalBurned;
    
    // ============ Events ============
    
    event TransferFeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    event FeeExemptionUpdated(address indexed account, bool exempt);
    event AddressBlocked(address indexed account);
    event AddressUnblocked(address indexed account);
    event FeesCollected(address indexed from, address indexed to, uint256 amount);
    event TokensBridged(address indexed from, address indexed to, uint256 amount, uint256 chainId);
    
    // ============ Errors ============
    
    error AddressBlocked();
    error ZeroAddress();
    error FeeTooHigh();
    error InsufficientBalance();
    error MaxSupplyExceeded();
    
    // ============ Constructor ============
    
    /**
     * @notice Initializes the SYNX token
     * @param _feeCollector Address to receive transfer fees
     * @param _initialDistribution Array of initial distribution addresses
     * @param _amounts Array of amounts corresponding to each address
     */
    constructor(
        address _feeCollector,
        address[] memory _initialDistribution,
        uint256[] memory _amounts
    ) 
        ERC20("Synapse Token", "SYNX") 
        ERC20Permit("Synapse Token") 
    {
        if (_feeCollector == address(0)) revert ZeroAddress();
        
        feeCollector = _feeCollector;
        transferFee = 10; // 0.1% initial fee
        
        // Setup roles
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(FEE_MANAGER_ROLE, msg.sender);
        
        // Fee exempt for critical addresses
        feeExempt[msg.sender] = true;
        feeExempt[_feeCollector] = true;
        feeExempt[address(this)] = true;
        
        // Initial distribution
        uint256 totalDistributed = 0;
        for (uint256 i = 0; i < _initialDistribution.length; i++) {
            if (_initialDistribution[i] != address(0) && _amounts[i] > 0) {
                _mint(_initialDistribution[i], _amounts[i]);
                feeExempt[_initialDistribution[i]] = true;
                totalDistributed += _amounts[i];
            }
        }
        
        // Mint remaining to deployer for vesting contracts
        if (totalDistributed < TOTAL_SUPPLY) {
            _mint(msg.sender, TOTAL_SUPPLY - totalDistributed);
        }
    }
    
    // ============ Transfer Functions ============
    
    /**
     * @notice Override transfer to apply fees
     */
    function transfer(address to, uint256 amount) 
        public 
        virtual 
        override 
        whenNotPaused 
        returns (bool) 
    {
        _checkBlocklist(msg.sender, to);
        
        uint256 fee = _calculateFee(msg.sender, to, amount);
        uint256 amountAfterFee = amount - fee;
        
        if (fee > 0) {
            super.transfer(feeCollector, fee);
            totalFeesCollected += fee;
            emit FeesCollected(msg.sender, to, fee);
        }
        
        return super.transfer(to, amountAfterFee);
    }
    
    /**
     * @notice Override transferFrom to apply fees
     */
    function transferFrom(address from, address to, uint256 amount) 
        public 
        virtual 
        override 
        whenNotPaused 
        returns (bool) 
    {
        _checkBlocklist(from, to);
        
        uint256 fee = _calculateFee(from, to, amount);
        uint256 amountAfterFee = amount - fee;
        
        if (fee > 0) {
            super.transferFrom(from, feeCollector, fee);
            totalFeesCollected += fee;
            emit FeesCollected(from, to, fee);
        }
        
        return super.transferFrom(from, to, amountAfterFee);
    }
    
    /**
     * @notice Fee-free transfer for bridges and special cases
     */
    function bridgeTransfer(address from, address to, uint256 amount, uint256 targetChainId) 
        external 
        onlyRole(BRIDGE_ROLE) 
        whenNotPaused 
        returns (bool) 
    {
        _checkBlocklist(from, to);
        _transfer(from, to, amount);
        emit TokensBridged(from, to, amount, targetChainId);
        return true;
    }
    
    // ============ Fee Management ============
    
    /**
     * @notice Calculate transfer fee
     */
    function _calculateFee(address from, address to, uint256 amount) 
        internal 
        view 
        returns (uint256) 
    {
        if (feeExempt[from] || feeExempt[to] || transferFee == 0) {
            return 0;
        }
        return (amount * transferFee) / FEE_DENOMINATOR;
    }
    
    /**
     * @notice Update transfer fee
     * @param newFee New fee in basis points
     */
    function setTransferFee(uint256 newFee) 
        external 
        onlyRole(FEE_MANAGER_ROLE) 
    {
        if (newFee > MAX_TRANSFER_FEE) revert FeeTooHigh();
        
        uint256 oldFee = transferFee;
        transferFee = newFee;
        emit TransferFeeUpdated(oldFee, newFee);
    }
    
    /**
     * @notice Update fee collector address
     */
    function setFeeCollector(address newCollector) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        if (newCollector == address(0)) revert ZeroAddress();
        
        address oldCollector = feeCollector;
        feeCollector = newCollector;
        feeExempt[newCollector] = true;
        emit FeeCollectorUpdated(oldCollector, newCollector);
    }
    
    /**
     * @notice Update fee exemption status
     */
    function setFeeExemption(address account, bool exempt) 
        external 
        onlyRole(FEE_MANAGER_ROLE) 
    {
        feeExempt[account] = exempt;
        emit FeeExemptionUpdated(account, exempt);
    }
    
    // ============ Blocklist Management ============
    
    /**
     * @notice Check blocklist status
     */
    function _checkBlocklist(address from, address to) internal view {
        if (blocklist[from] || blocklist[to]) revert AddressBlocked();
    }
    
    /**
     * @notice Block an address
     */
    function blockAddress(address account) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        blocklist[account] = true;
        emit AddressBlocked(account);
    }
    
    /**
     * @notice Unblock an address
     */
    function unblockAddress(address account) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        blocklist[account] = false;
        emit AddressUnblocked(account);
    }
    
    // ============ Pause Functions ============
    
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }
    
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
    
    // ============ Burn Functions ============
    
    /**
     * @notice Override burn to track total burned
     */
    function burn(uint256 amount) public virtual override {
        super.burn(amount);
        totalBurned += amount;
    }
    
    /**
     * @notice Override burnFrom to track total burned
     */
    function burnFrom(address account, uint256 amount) public virtual override {
        super.burnFrom(account, amount);
        totalBurned += amount;
    }
    
    // ============ View Functions ============
    
    /**
     * @notice Get circulating supply (total - burned)
     */
    function circulatingSupply() external view returns (uint256) {
        return totalSupply();
    }
    
    /**
     * @notice Preview transfer fee
     */
    function previewFee(address from, address to, uint256 amount) 
        external 
        view 
        returns (uint256) 
    {
        return _calculateFee(from, to, amount);
    }
    
    // ============ Required Overrides ============
    
    function _afterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20, ERC20Votes) {
        super._afterTokenTransfer(from, to, amount);
    }
    
    function _mint(address to, uint256 amount) 
        internal 
        override(ERC20, ERC20Votes) 
    {
        if (totalSupply() + amount > TOTAL_SUPPLY) revert MaxSupplyExceeded();
        super._mint(to, amount);
    }
    
    function _burn(address account, uint256 amount) 
        internal 
        override(ERC20, ERC20Votes) 
    {
        super._burn(account, amount);
    }
    
    function nonces(address owner) 
        public 
        view 
        override(ERC20Permit, Nonces) 
        returns (uint256) 
    {
        return super.nonces(owner);
    }
}
