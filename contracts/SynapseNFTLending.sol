// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title SynapseNFTLending
 * @notice P2P NFT-backed loans and instant liquidity
 * @dev Supports both peer-to-peer offers and protocol-level lending
 */
contract SynapseNFTLending is IERC721Receiver, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ============ Enums ============

    enum LoanStatus { NONE, ACTIVE, REPAID, DEFAULTED, LIQUIDATED }
    enum OfferType { LENDER_OFFER, BORROWER_OFFER }

    // ============ Structs ============

    struct Collection {
        address nftContract;
        uint256 floorPrice;         // Protocol floor price estimate
        uint256 maxLTV;             // Max loan-to-value (basis points)
        uint256 liquidationThreshold;
        bool isActive;
        uint256 totalBorrowed;
        uint256 totalLoans;
    }

    struct Loan {
        uint256 loanId;
        address borrower;
        address lender;
        address nftContract;
        uint256 tokenId;
        address loanToken;
        uint256 principal;
        uint256 interestRate;       // Annual rate in basis points
        uint256 duration;
        uint256 startTime;
        uint256 repaymentAmount;
        LoanStatus status;
    }

    struct Offer {
        uint256 offerId;
        address creator;
        OfferType offerType;
        address nftContract;
        uint256 tokenId;            // 0 for collection-wide offers
        address loanToken;
        uint256 principal;
        uint256 interestRate;
        uint256 duration;
        uint256 expiresAt;
        bool isActive;
    }

    struct PoolConfig {
        address loanToken;
        uint256 totalDeposits;
        uint256 totalBorrowed;
        uint256 utilizationRate;
        uint256 baseRate;           // Base interest rate
        uint256 rateSlope;          // Rate increase per utilization
    }

    // ============ State Variables ============

    // Collections
    mapping(address => Collection) public collections;
    address[] public collectionList;

    // Loans
    mapping(uint256 => Loan) public loans;
    mapping(address => uint256[]) public borrowerLoans;
    mapping(address => uint256[]) public lenderLoans;
    uint256 public loanCounter;

    // Offers
    mapping(uint256 => Offer) public offers;
    mapping(address => uint256[]) public userOffers;
    uint256 public offerCounter;

    // Liquidity pools for instant loans
    mapping(address => PoolConfig) public pools;
    mapping(address => mapping(address => uint256)) public lpBalances; // token => user => balance

    // NFT custody
    mapping(address => mapping(uint256 => uint256)) public nftToLoan; // nft => tokenId => loanId

    // Fees
    uint256 public protocolFee = 250;   // 2.5%
    uint256 public constant BASIS_POINTS = 10000;
    address public feeRecipient;

    // ============ Events ============

    event CollectionAdded(address indexed nftContract, uint256 maxLTV);
    event CollectionUpdated(address indexed nftContract, uint256 floorPrice);
    event LoanCreated(uint256 indexed loanId, address indexed borrower, address indexed lender, uint256 principal);
    event LoanRepaid(uint256 indexed loanId, uint256 totalPaid);
    event LoanDefaulted(uint256 indexed loanId);
    event LoanLiquidated(uint256 indexed loanId, address liquidator);
    event OfferCreated(uint256 indexed offerId, address indexed creator, OfferType offerType);
    event OfferAccepted(uint256 indexed offerId, uint256 indexed loanId);
    event OfferCancelled(uint256 indexed offerId);
    event LiquidityAdded(address indexed token, address indexed provider, uint256 amount);
    event LiquidityRemoved(address indexed token, address indexed provider, uint256 amount);

    // ============ Constructor ============

    constructor() Ownable(msg.sender) {
        feeRecipient = msg.sender;
    }

    // ============ Collection Management ============

    /**
     * @notice Add a supported NFT collection
     */
    function addCollection(
        address nftContract,
        uint256 floorPrice,
        uint256 maxLTV,
        uint256 liquidationThreshold
    ) external onlyOwner {
        require(nftContract != address(0), "Invalid address");
        require(maxLTV <= 8000, "LTV too high"); // Max 80%
        require(liquidationThreshold > maxLTV, "Invalid threshold");

        collections[nftContract] = Collection({
            nftContract: nftContract,
            floorPrice: floorPrice,
            maxLTV: maxLTV,
            liquidationThreshold: liquidationThreshold,
            isActive: true,
            totalBorrowed: 0,
            totalLoans: 0
        });

        collectionList.push(nftContract);

        emit CollectionAdded(nftContract, maxLTV);
    }

    /**
     * @notice Update collection floor price
     */
    function updateFloorPrice(address nftContract, uint256 newFloorPrice) external onlyOwner {
        require(collections[nftContract].isActive, "Collection not active");
        collections[nftContract].floorPrice = newFloorPrice;
        emit CollectionUpdated(nftContract, newFloorPrice);
    }

    // ============ P2P Lending ============

    /**
     * @notice Create a lender offer (willing to lend against NFT)
     */
    function createLenderOffer(
        address nftContract,
        uint256 tokenId,           // 0 for collection-wide
        address loanToken,
        uint256 principal,
        uint256 interestRate,
        uint256 duration,
        uint256 expiresIn
    ) external nonReentrant whenNotPaused returns (uint256) {
        require(collections[nftContract].isActive, "Collection not supported");
        
        // Transfer loan amount to contract
        IERC20(loanToken).safeTransferFrom(msg.sender, address(this), principal);

        offerCounter++;
        uint256 offerId = offerCounter;

        offers[offerId] = Offer({
            offerId: offerId,
            creator: msg.sender,
            offerType: OfferType.LENDER_OFFER,
            nftContract: nftContract,
            tokenId: tokenId,
            loanToken: loanToken,
            principal: principal,
            interestRate: interestRate,
            duration: duration,
            expiresAt: block.timestamp + expiresIn,
            isActive: true
        });

        userOffers[msg.sender].push(offerId);

        emit OfferCreated(offerId, msg.sender, OfferType.LENDER_OFFER);

        return offerId;
    }

    /**
     * @notice Create a borrower offer (have NFT, want to borrow)
     */
    function createBorrowerOffer(
        address nftContract,
        uint256 tokenId,
        address loanToken,
        uint256 principal,
        uint256 maxInterestRate,
        uint256 duration,
        uint256 expiresIn
    ) external nonReentrant whenNotPaused returns (uint256) {
        require(collections[nftContract].isActive, "Collection not supported");
        require(IERC721(nftContract).ownerOf(tokenId) == msg.sender, "Not owner");

        // Transfer NFT to contract
        IERC721(nftContract).safeTransferFrom(msg.sender, address(this), tokenId);

        offerCounter++;
        uint256 offerId = offerCounter;

        offers[offerId] = Offer({
            offerId: offerId,
            creator: msg.sender,
            offerType: OfferType.BORROWER_OFFER,
            nftContract: nftContract,
            tokenId: tokenId,
            loanToken: loanToken,
            principal: principal,
            interestRate: maxInterestRate,
            duration: duration,
            expiresAt: block.timestamp + expiresIn,
            isActive: true
        });

        userOffers[msg.sender].push(offerId);

        emit OfferCreated(offerId, msg.sender, OfferType.BORROWER_OFFER);

        return offerId;
    }

    /**
     * @notice Accept a lender offer (borrower provides NFT)
     */
    function acceptLenderOffer(uint256 offerId, uint256 tokenId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.isActive, "Offer not active");
        require(offer.offerType == OfferType.LENDER_OFFER, "Not a lender offer");
        require(block.timestamp < offer.expiresAt, "Offer expired");
        require(offer.tokenId == 0 || offer.tokenId == tokenId, "Wrong tokenId");

        // Transfer NFT from borrower
        IERC721(offer.nftContract).safeTransferFrom(msg.sender, address(this), tokenId);

        // Create loan
        uint256 loanId = _createLoan(
            msg.sender,
            offer.creator,
            offer.nftContract,
            tokenId,
            offer.loanToken,
            offer.principal,
            offer.interestRate,
            offer.duration
        );

        // Transfer principal to borrower (minus fee)
        uint256 fee = (offer.principal * protocolFee) / BASIS_POINTS;
        IERC20(offer.loanToken).safeTransfer(msg.sender, offer.principal - fee);
        IERC20(offer.loanToken).safeTransfer(feeRecipient, fee);

        offer.isActive = false;

        emit OfferAccepted(offerId, loanId);
    }

    /**
     * @notice Accept a borrower offer (lender provides funds)
     */
    function acceptBorrowerOffer(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.isActive, "Offer not active");
        require(offer.offerType == OfferType.BORROWER_OFFER, "Not a borrower offer");
        require(block.timestamp < offer.expiresAt, "Offer expired");

        // Transfer funds from lender
        IERC20(offer.loanToken).safeTransferFrom(msg.sender, address(this), offer.principal);

        // Create loan
        uint256 loanId = _createLoan(
            offer.creator,
            msg.sender,
            offer.nftContract,
            offer.tokenId,
            offer.loanToken,
            offer.principal,
            offer.interestRate,
            offer.duration
        );

        // Transfer principal to borrower (minus fee)
        uint256 fee = (offer.principal * protocolFee) / BASIS_POINTS;
        IERC20(offer.loanToken).safeTransfer(offer.creator, offer.principal - fee);
        IERC20(offer.loanToken).safeTransfer(feeRecipient, fee);

        offer.isActive = false;

        emit OfferAccepted(offerId, loanId);
    }

    /**
     * @notice Cancel an offer
     */
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.creator == msg.sender, "Not creator");
        require(offer.isActive, "Not active");

        offer.isActive = false;

        if (offer.offerType == OfferType.LENDER_OFFER) {
            // Return funds to lender
            IERC20(offer.loanToken).safeTransfer(msg.sender, offer.principal);
        } else {
            // Return NFT to borrower
            IERC721(offer.nftContract).safeTransferFrom(address(this), msg.sender, offer.tokenId);
        }

        emit OfferCancelled(offerId);
    }

    // ============ Loan Management ============

    function _createLoan(
        address borrower,
        address lender,
        address nftContract,
        uint256 tokenId,
        address loanToken,
        uint256 principal,
        uint256 interestRate,
        uint256 duration
    ) internal returns (uint256) {
        loanCounter++;
        uint256 loanId = loanCounter;

        // Calculate repayment amount
        uint256 interest = (principal * interestRate * duration) / (365 days * BASIS_POINTS);
        uint256 repaymentAmount = principal + interest;

        loans[loanId] = Loan({
            loanId: loanId,
            borrower: borrower,
            lender: lender,
            nftContract: nftContract,
            tokenId: tokenId,
            loanToken: loanToken,
            principal: principal,
            interestRate: interestRate,
            duration: duration,
            startTime: block.timestamp,
            repaymentAmount: repaymentAmount,
            status: LoanStatus.ACTIVE
        });

        borrowerLoans[borrower].push(loanId);
        lenderLoans[lender].push(loanId);
        nftToLoan[nftContract][tokenId] = loanId;

        // Update collection stats
        collections[nftContract].totalBorrowed += principal;
        collections[nftContract].totalLoans++;

        emit LoanCreated(loanId, borrower, lender, principal);

        return loanId;
    }

    /**
     * @notice Repay a loan
     */
    function repayLoan(uint256 loanId) external nonReentrant {
        Loan storage loan = loans[loanId];
        require(loan.status == LoanStatus.ACTIVE, "Loan not active");
        require(block.timestamp <= loan.startTime + loan.duration, "Loan expired");

        // Calculate total due
        uint256 totalDue = loan.repaymentAmount;

        // Transfer repayment
        IERC20(loan.loanToken).safeTransferFrom(msg.sender, loan.lender, totalDue);

        // Return NFT to borrower
        IERC721(loan.nftContract).safeTransferFrom(address(this), loan.borrower, loan.tokenId);

        loan.status = LoanStatus.REPAID;
        delete nftToLoan[loan.nftContract][loan.tokenId];

        // Update collection stats
        collections[loan.nftContract].totalBorrowed -= loan.principal;

        emit LoanRepaid(loanId, totalDue);
    }

    /**
     * @notice Mark loan as defaulted (lender can claim NFT)
     */
    function claimDefaultedNFT(uint256 loanId) external nonReentrant {
        Loan storage loan = loans[loanId];
        require(loan.status == LoanStatus.ACTIVE, "Loan not active");
        require(loan.lender == msg.sender, "Not lender");
        require(block.timestamp > loan.startTime + loan.duration, "Loan not expired");

        loan.status = LoanStatus.DEFAULTED;

        // Transfer NFT to lender
        IERC721(loan.nftContract).safeTransferFrom(address(this), msg.sender, loan.tokenId);

        delete nftToLoan[loan.nftContract][loan.tokenId];

        emit LoanDefaulted(loanId);
    }

    // ============ Instant Liquidity Pool ============

    /**
     * @notice Add liquidity to lending pool
     */
    function addLiquidity(address token, uint256 amount) external nonReentrant {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        pools[token].totalDeposits += amount;
        lpBalances[token][msg.sender] += amount;

        emit LiquidityAdded(token, msg.sender, amount);
    }

    /**
     * @notice Remove liquidity from pool
     */
    function removeLiquidity(address token, uint256 amount) external nonReentrant {
        require(lpBalances[token][msg.sender] >= amount, "Insufficient balance");
        
        uint256 available = pools[token].totalDeposits - pools[token].totalBorrowed;
        require(available >= amount, "Insufficient liquidity");

        pools[token].totalDeposits -= amount;
        lpBalances[token][msg.sender] -= amount;

        IERC20(token).safeTransfer(msg.sender, amount);

        emit LiquidityRemoved(token, msg.sender, amount);
    }

    /**
     * @notice Instant borrow against NFT
     */
    function instantBorrow(
        address nftContract,
        uint256 tokenId,
        address loanToken,
        uint256 amount,
        uint256 duration
    ) external nonReentrant whenNotPaused returns (uint256) {
        Collection storage collection = collections[nftContract];
        require(collection.isActive, "Collection not supported");
        
        // Check LTV
        uint256 maxBorrow = (collection.floorPrice * collection.maxLTV) / BASIS_POINTS;
        require(amount <= maxBorrow, "Exceeds max LTV");

        // Check pool liquidity
        PoolConfig storage pool = pools[loanToken];
        require(pool.totalDeposits - pool.totalBorrowed >= amount, "Insufficient liquidity");

        // Transfer NFT
        IERC721(nftContract).safeTransferFrom(msg.sender, address(this), tokenId);

        // Calculate interest rate based on utilization
        uint256 interestRate = _calculateInterestRate(pool);

        // Create loan
        uint256 loanId = _createLoan(
            msg.sender,
            address(this),  // Protocol is the lender
            nftContract,
            tokenId,
            loanToken,
            amount,
            interestRate,
            duration
        );

        // Update pool
        pool.totalBorrowed += amount;
        pool.utilizationRate = (pool.totalBorrowed * BASIS_POINTS) / pool.totalDeposits;

        // Transfer funds (minus fee)
        uint256 fee = (amount * protocolFee) / BASIS_POINTS;
        IERC20(loanToken).safeTransfer(msg.sender, amount - fee);
        IERC20(loanToken).safeTransfer(feeRecipient, fee);

        return loanId;
    }

    function _calculateInterestRate(PoolConfig storage pool) internal view returns (uint256) {
        // Base rate + slope * utilization
        return pool.baseRate + (pool.rateSlope * pool.utilizationRate) / BASIS_POINTS;
    }

    // ============ View Functions ============

    function getLoan(uint256 loanId) external view returns (Loan memory) {
        return loans[loanId];
    }

    function getOffer(uint256 offerId) external view returns (Offer memory) {
        return offers[offerId];
    }

    function getCollection(address nftContract) external view returns (Collection memory) {
        return collections[nftContract];
    }

    function getBorrowerLoans(address borrower) external view returns (uint256[] memory) {
        return borrowerLoans[borrower];
    }

    function getLenderLoans(address lender) external view returns (uint256[] memory) {
        return lenderLoans[lender];
    }

    function getUserOffers(address user) external view returns (uint256[] memory) {
        return userOffers[user];
    }

    function getLoanHealth(uint256 loanId) external view returns (uint256 healthFactor, bool isDefaulted) {
        Loan storage loan = loans[loanId];
        Collection storage collection = collections[loan.nftContract];

        uint256 collateralValue = collection.floorPrice;
        uint256 debtValue = loan.repaymentAmount;

        healthFactor = (collateralValue * BASIS_POINTS) / debtValue;
        isDefaulted = block.timestamp > loan.startTime + loan.duration;
    }

    // ============ Admin Functions ============

    function setProtocolFee(uint256 fee) external onlyOwner {
        require(fee <= 500, "Fee too high");
        protocolFee = fee;
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        feeRecipient = recipient;
    }

    function configurePool(
        address token,
        uint256 baseRate,
        uint256 rateSlope
    ) external onlyOwner {
        pools[token].baseRate = baseRate;
        pools[token].rateSlope = rateSlope;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ============ ERC721 Receiver ============

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
