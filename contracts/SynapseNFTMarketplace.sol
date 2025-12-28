// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title SynapseNFTMarketplace
 * @notice Decentralized NFT marketplace supporting ERC721 and ERC1155
 * @dev Features: Listings, Auctions, Offers, Royalties, Collections
 */
contract SynapseNFTMarketplace is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ============ Enums ============

    enum ListingType { FIXED_PRICE, AUCTION, DUTCH_AUCTION }
    enum ListingStatus { ACTIVE, SOLD, CANCELLED, EXPIRED }
    enum TokenStandard { ERC721, ERC1155 }

    // ============ Structs ============

    struct Listing {
        uint256 listingId;
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 amount;              // For ERC1155
        TokenStandard tokenStandard;
        ListingType listingType;
        address paymentToken;        // address(0) for ETH
        uint256 price;               // Fixed price or starting price
        uint256 endPrice;            // For Dutch auction
        uint256 startTime;
        uint256 endTime;
        ListingStatus status;
    }

    struct Auction {
        uint256 listingId;
        address highestBidder;
        uint256 highestBid;
        uint256 minBidIncrement;
        uint256 extensionTime;       // Time to extend on last-minute bid
        uint256 bidCount;
    }

    struct Offer {
        uint256 offerId;
        address offerer;
        address nftContract;
        uint256 tokenId;
        uint256 amount;
        address paymentToken;
        uint256 price;
        uint256 expiresAt;
        bool isActive;
    }

    struct Collection {
        address creator;
        uint256 royaltyBps;          // Royalty in basis points
        address royaltyRecipient;
        bool isVerified;
        uint256 totalVolume;
        uint256 totalSales;
    }

    struct UserStats {
        uint256 totalBought;
        uint256 totalSold;
        uint256 totalVolume;
        uint256 listingCount;
    }

    // ============ State Variables ============

    IERC20 public immutable synxToken;

    // Listings
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Auction) public auctions;
    uint256 public listingCounter;

    // Offers
    mapping(uint256 => Offer) public offers;
    mapping(address => mapping(uint256 => uint256[])) public tokenOffers; // nft => tokenId => offerIds
    uint256 public offerCounter;

    // Collections
    mapping(address => Collection) public collections;
    address[] public verifiedCollections;

    // User data
    mapping(address => UserStats) public userStats;
    mapping(address => uint256[]) public userListings;
    mapping(address => uint256[]) public userOffers;

    // Fees
    uint256 public platformFee = 250;      // 2.5%
    uint256 public constant MAX_FEE = 1000; // 10%
    uint256 public constant BASIS_POINTS = 10000;
    address public feeRecipient;

    // Accepted payment tokens
    mapping(address => bool) public acceptedPaymentTokens;

    // ============ Events ============

    event ListingCreated(
        uint256 indexed listingId,
        address indexed seller,
        address indexed nftContract,
        uint256 tokenId,
        ListingType listingType,
        uint256 price
    );

    event ListingSold(
        uint256 indexed listingId,
        address indexed buyer,
        uint256 price
    );

    event ListingCancelled(uint256 indexed listingId);

    event BidPlaced(
        uint256 indexed listingId,
        address indexed bidder,
        uint256 amount
    );

    event OfferCreated(
        uint256 indexed offerId,
        address indexed offerer,
        address indexed nftContract,
        uint256 tokenId,
        uint256 price
    );

    event OfferAccepted(uint256 indexed offerId, address indexed seller);
    event OfferCancelled(uint256 indexed offerId);

    event CollectionRegistered(address indexed nftContract, address indexed creator);
    event CollectionVerified(address indexed nftContract);
    event RoyaltyUpdated(address indexed nftContract, uint256 royaltyBps);

    // ============ Constructor ============

    constructor(address _synxToken) Ownable(msg.sender) {
        synxToken = IERC20(_synxToken);
        feeRecipient = msg.sender;
        
        // Accept SYNX and ETH by default
        acceptedPaymentTokens[address(0)] = true;
        acceptedPaymentTokens[_synxToken] = true;
    }

    // ============ Listing Functions ============

    /**
     * @notice Create a fixed price listing
     */
    function createListing(
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        TokenStandard tokenStandard,
        address paymentToken,
        uint256 price,
        uint256 duration
    ) external nonReentrant whenNotPaused returns (uint256) {
        require(acceptedPaymentTokens[paymentToken], "Payment token not accepted");
        require(price > 0, "Price must be > 0");
        require(duration >= 1 hours && duration <= 180 days, "Invalid duration");

        // Transfer NFT to marketplace
        _transferNFTIn(nftContract, tokenId, amount, tokenStandard);

        listingCounter++;
        
        listings[listingCounter] = Listing({
            listingId: listingCounter,
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            amount: amount,
            tokenStandard: tokenStandard,
            listingType: ListingType.FIXED_PRICE,
            paymentToken: paymentToken,
            price: price,
            endPrice: 0,
            startTime: block.timestamp,
            endTime: block.timestamp + duration,
            status: ListingStatus.ACTIVE
        });

        userListings[msg.sender].push(listingCounter);

        emit ListingCreated(
            listingCounter,
            msg.sender,
            nftContract,
            tokenId,
            ListingType.FIXED_PRICE,
            price
        );

        return listingCounter;
    }

    /**
     * @notice Create an auction listing
     */
    function createAuction(
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        TokenStandard tokenStandard,
        address paymentToken,
        uint256 startingPrice,
        uint256 minBidIncrement,
        uint256 duration,
        uint256 extensionTime
    ) external nonReentrant whenNotPaused returns (uint256) {
        require(acceptedPaymentTokens[paymentToken], "Payment token not accepted");
        require(startingPrice > 0, "Price must be > 0");
        require(duration >= 1 hours && duration <= 30 days, "Invalid duration");

        _transferNFTIn(nftContract, tokenId, amount, tokenStandard);

        listingCounter++;
        
        listings[listingCounter] = Listing({
            listingId: listingCounter,
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            amount: amount,
            tokenStandard: tokenStandard,
            listingType: ListingType.AUCTION,
            paymentToken: paymentToken,
            price: startingPrice,
            endPrice: 0,
            startTime: block.timestamp,
            endTime: block.timestamp + duration,
            status: ListingStatus.ACTIVE
        });

        auctions[listingCounter] = Auction({
            listingId: listingCounter,
            highestBidder: address(0),
            highestBid: 0,
            minBidIncrement: minBidIncrement,
            extensionTime: extensionTime,
            bidCount: 0
        });

        userListings[msg.sender].push(listingCounter);

        emit ListingCreated(
            listingCounter,
            msg.sender,
            nftContract,
            tokenId,
            ListingType.AUCTION,
            startingPrice
        );

        return listingCounter;
    }

    /**
     * @notice Create a Dutch auction (decreasing price)
     */
    function createDutchAuction(
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        TokenStandard tokenStandard,
        address paymentToken,
        uint256 startingPrice,
        uint256 endingPrice,
        uint256 duration
    ) external nonReentrant whenNotPaused returns (uint256) {
        require(startingPrice > endingPrice, "Start > end price required");
        require(endingPrice > 0, "End price must be > 0");

        _transferNFTIn(nftContract, tokenId, amount, tokenStandard);

        listingCounter++;
        
        listings[listingCounter] = Listing({
            listingId: listingCounter,
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            amount: amount,
            tokenStandard: tokenStandard,
            listingType: ListingType.DUTCH_AUCTION,
            paymentToken: paymentToken,
            price: startingPrice,
            endPrice: endingPrice,
            startTime: block.timestamp,
            endTime: block.timestamp + duration,
            status: ListingStatus.ACTIVE
        });

        userListings[msg.sender].push(listingCounter);

        emit ListingCreated(
            listingCounter,
            msg.sender,
            nftContract,
            tokenId,
            ListingType.DUTCH_AUCTION,
            startingPrice
        );

        return listingCounter;
    }

    /**
     * @notice Buy a fixed price listing
     */
    function buyListing(uint256 listingId) external payable nonReentrant whenNotPaused {
        Listing storage listing = listings[listingId];
        require(listing.status == ListingStatus.ACTIVE, "Listing not active");
        require(listing.listingType == ListingType.FIXED_PRICE, "Not fixed price");
        require(block.timestamp <= listing.endTime, "Listing expired");

        uint256 price = listing.price;
        
        _processPayment(listing.paymentToken, msg.sender, listing.seller, listing.nftContract, price);
        _transferNFTOut(listing.nftContract, listing.tokenId, listing.amount, listing.tokenStandard, msg.sender);

        listing.status = ListingStatus.SOLD;
        
        _updateStats(msg.sender, listing.seller, price);
        _updateCollectionStats(listing.nftContract, price);

        emit ListingSold(listingId, msg.sender, price);
    }

    /**
     * @notice Buy a Dutch auction at current price
     */
    function buyDutchAuction(uint256 listingId) external payable nonReentrant whenNotPaused {
        Listing storage listing = listings[listingId];
        require(listing.status == ListingStatus.ACTIVE, "Listing not active");
        require(listing.listingType == ListingType.DUTCH_AUCTION, "Not Dutch auction");
        require(block.timestamp <= listing.endTime, "Auction ended");

        uint256 currentPrice = getDutchAuctionPrice(listingId);
        
        _processPayment(listing.paymentToken, msg.sender, listing.seller, listing.nftContract, currentPrice);
        _transferNFTOut(listing.nftContract, listing.tokenId, listing.amount, listing.tokenStandard, msg.sender);

        listing.status = ListingStatus.SOLD;
        
        _updateStats(msg.sender, listing.seller, currentPrice);
        _updateCollectionStats(listing.nftContract, currentPrice);

        emit ListingSold(listingId, msg.sender, currentPrice);
    }

    /**
     * @notice Place a bid on an auction
     */
    function placeBid(uint256 listingId, uint256 bidAmount) external payable nonReentrant whenNotPaused {
        Listing storage listing = listings[listingId];
        Auction storage auction = auctions[listingId];
        
        require(listing.status == ListingStatus.ACTIVE, "Listing not active");
        require(listing.listingType == ListingType.AUCTION, "Not an auction");
        require(block.timestamp <= listing.endTime, "Auction ended");

        uint256 minBid = auction.highestBid == 0 
            ? listing.price 
            : auction.highestBid + auction.minBidIncrement;
        require(bidAmount >= minBid, "Bid too low");

        // Refund previous bidder
        if (auction.highestBidder != address(0)) {
            _refundBid(listing.paymentToken, auction.highestBidder, auction.highestBid);
        }

        // Accept new bid
        _acceptBid(listing.paymentToken, bidAmount);

        auction.highestBidder = msg.sender;
        auction.highestBid = bidAmount;
        auction.bidCount++;

        // Extend auction if last-minute bid
        if (listing.endTime - block.timestamp < auction.extensionTime) {
            listing.endTime = block.timestamp + auction.extensionTime;
        }

        emit BidPlaced(listingId, msg.sender, bidAmount);
    }

    /**
     * @notice Settle an ended auction
     */
    function settleAuction(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        Auction storage auction = auctions[listingId];
        
        require(listing.status == ListingStatus.ACTIVE, "Listing not active");
        require(listing.listingType == ListingType.AUCTION, "Not an auction");
        require(block.timestamp > listing.endTime, "Auction not ended");

        if (auction.highestBidder != address(0)) {
            // Auction had bids - transfer NFT and payment
            _processPaymentFromContract(
                listing.paymentToken,
                listing.seller,
                listing.nftContract,
                auction.highestBid
            );
            
            _transferNFTOut(
                listing.nftContract,
                listing.tokenId,
                listing.amount,
                listing.tokenStandard,
                auction.highestBidder
            );

            listing.status = ListingStatus.SOLD;
            
            _updateStats(auction.highestBidder, listing.seller, auction.highestBid);
            _updateCollectionStats(listing.nftContract, auction.highestBid);

            emit ListingSold(listingId, auction.highestBidder, auction.highestBid);
        } else {
            // No bids - return NFT to seller
            _transferNFTOut(
                listing.nftContract,
                listing.tokenId,
                listing.amount,
                listing.tokenStandard,
                listing.seller
            );

            listing.status = ListingStatus.EXPIRED;
            emit ListingCancelled(listingId);
        }
    }

    /**
     * @notice Cancel a listing
     */
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.seller == msg.sender, "Not seller");
        require(listing.status == ListingStatus.ACTIVE, "Listing not active");

        // For auctions, ensure no bids
        if (listing.listingType == ListingType.AUCTION) {
            require(auctions[listingId].highestBidder == address(0), "Has bids");
        }

        // Return NFT
        _transferNFTOut(
            listing.nftContract,
            listing.tokenId,
            listing.amount,
            listing.tokenStandard,
            msg.sender
        );

        listing.status = ListingStatus.CANCELLED;
        emit ListingCancelled(listingId);
    }

    // ============ Offer Functions ============

    /**
     * @notice Make an offer on any NFT
     */
    function makeOffer(
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        address paymentToken,
        uint256 price,
        uint256 duration
    ) external nonReentrant whenNotPaused returns (uint256) {
        require(acceptedPaymentTokens[paymentToken], "Payment token not accepted");
        require(price > 0, "Price must be > 0");
        require(duration >= 1 hours && duration <= 30 days, "Invalid duration");

        // Lock payment
        if (paymentToken == address(0)) {
            revert("Use makeOfferETH");
        }
        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), price);

        offerCounter++;
        
        offers[offerCounter] = Offer({
            offerId: offerCounter,
            offerer: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            amount: amount,
            paymentToken: paymentToken,
            price: price,
            expiresAt: block.timestamp + duration,
            isActive: true
        });

        tokenOffers[nftContract][tokenId].push(offerCounter);
        userOffers[msg.sender].push(offerCounter);

        emit OfferCreated(offerCounter, msg.sender, nftContract, tokenId, price);

        return offerCounter;
    }

    /**
     * @notice Accept an offer
     */
    function acceptOffer(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.isActive, "Offer not active");
        require(block.timestamp <= offer.expiresAt, "Offer expired");

        // Verify seller owns the NFT
        // Transfer NFT from seller
        _transferNFTIn(offer.nftContract, offer.tokenId, offer.amount, TokenStandard.ERC721);

        // Process payment from contract
        _processPaymentFromContract(
            offer.paymentToken,
            msg.sender,
            offer.nftContract,
            offer.price
        );

        // Transfer NFT to buyer
        _transferNFTOut(offer.nftContract, offer.tokenId, offer.amount, TokenStandard.ERC721, offer.offerer);

        offer.isActive = false;

        _updateStats(offer.offerer, msg.sender, offer.price);
        _updateCollectionStats(offer.nftContract, offer.price);

        emit OfferAccepted(offerId, msg.sender);
    }

    /**
     * @notice Cancel an offer
     */
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.offerer == msg.sender, "Not offerer");
        require(offer.isActive, "Offer not active");

        offer.isActive = false;

        // Refund payment
        if (offer.paymentToken == address(0)) {
            payable(msg.sender).transfer(offer.price);
        } else {
            IERC20(offer.paymentToken).safeTransfer(msg.sender, offer.price);
        }

        emit OfferCancelled(offerId);
    }

    // ============ Collection Functions ============

    /**
     * @notice Register a collection
     */
    function registerCollection(
        address nftContract,
        uint256 royaltyBps,
        address royaltyRecipient
    ) external {
        require(collections[nftContract].creator == address(0), "Already registered");
        require(royaltyBps <= 1000, "Royalty too high"); // Max 10%

        collections[nftContract] = Collection({
            creator: msg.sender,
            royaltyBps: royaltyBps,
            royaltyRecipient: royaltyRecipient,
            isVerified: false,
            totalVolume: 0,
            totalSales: 0
        });

        emit CollectionRegistered(nftContract, msg.sender);
    }

    /**
     * @notice Update collection royalty (creator only)
     */
    function updateRoyalty(
        address nftContract,
        uint256 royaltyBps,
        address royaltyRecipient
    ) external {
        Collection storage collection = collections[nftContract];
        require(collection.creator == msg.sender, "Not creator");
        require(royaltyBps <= 1000, "Royalty too high");

        collection.royaltyBps = royaltyBps;
        collection.royaltyRecipient = royaltyRecipient;

        emit RoyaltyUpdated(nftContract, royaltyBps);
    }

    // ============ View Functions ============

    /**
     * @notice Get current Dutch auction price
     */
    function getDutchAuctionPrice(uint256 listingId) public view returns (uint256) {
        Listing storage listing = listings[listingId];
        require(listing.listingType == ListingType.DUTCH_AUCTION, "Not Dutch auction");

        if (block.timestamp >= listing.endTime) {
            return listing.endPrice;
        }

        uint256 elapsed = block.timestamp - listing.startTime;
        uint256 duration = listing.endTime - listing.startTime;
        uint256 priceDiff = listing.price - listing.endPrice;

        return listing.price - (priceDiff * elapsed / duration);
    }

    /**
     * @notice Get listing details
     */
    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    /**
     * @notice Get auction details
     */
    function getAuction(uint256 listingId) external view returns (Auction memory) {
        return auctions[listingId];
    }

    /**
     * @notice Get user's active listings
     */
    function getUserListings(address user) external view returns (uint256[] memory) {
        return userListings[user];
    }

    /**
     * @notice Get offers for a token
     */
    function getTokenOffers(address nftContract, uint256 tokenId) external view returns (uint256[] memory) {
        return tokenOffers[nftContract][tokenId];
    }

    // ============ Internal Functions ============

    function _transferNFTIn(
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        TokenStandard tokenStandard
    ) internal {
        if (tokenStandard == TokenStandard.ERC721) {
            IERC721(nftContract).transferFrom(msg.sender, address(this), tokenId);
        } else {
            IERC1155(nftContract).safeTransferFrom(msg.sender, address(this), tokenId, amount, "");
        }
    }

    function _transferNFTOut(
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        TokenStandard tokenStandard,
        address to
    ) internal {
        if (tokenStandard == TokenStandard.ERC721) {
            IERC721(nftContract).transferFrom(address(this), to, tokenId);
        } else {
            IERC1155(nftContract).safeTransferFrom(address(this), to, tokenId, amount, "");
        }
    }

    function _processPayment(
        address paymentToken,
        address buyer,
        address seller,
        address nftContract,
        uint256 price
    ) internal {
        uint256 platformAmount = (price * platformFee) / BASIS_POINTS;
        uint256 royaltyAmount = 0;

        Collection storage collection = collections[nftContract];
        if (collection.royaltyBps > 0) {
            royaltyAmount = (price * collection.royaltyBps) / BASIS_POINTS;
        }

        uint256 sellerAmount = price - platformAmount - royaltyAmount;

        if (paymentToken == address(0)) {
            require(msg.value >= price, "Insufficient ETH");
            payable(seller).transfer(sellerAmount);
            payable(feeRecipient).transfer(platformAmount);
            if (royaltyAmount > 0) {
                payable(collection.royaltyRecipient).transfer(royaltyAmount);
            }
            if (msg.value > price) {
                payable(buyer).transfer(msg.value - price);
            }
        } else {
            IERC20(paymentToken).safeTransferFrom(buyer, seller, sellerAmount);
            IERC20(paymentToken).safeTransferFrom(buyer, feeRecipient, platformAmount);
            if (royaltyAmount > 0) {
                IERC20(paymentToken).safeTransferFrom(buyer, collection.royaltyRecipient, royaltyAmount);
            }
        }
    }

    function _processPaymentFromContract(
        address paymentToken,
        address seller,
        address nftContract,
        uint256 price
    ) internal {
        uint256 platformAmount = (price * platformFee) / BASIS_POINTS;
        uint256 royaltyAmount = 0;

        Collection storage collection = collections[nftContract];
        if (collection.royaltyBps > 0) {
            royaltyAmount = (price * collection.royaltyBps) / BASIS_POINTS;
        }

        uint256 sellerAmount = price - platformAmount - royaltyAmount;

        if (paymentToken == address(0)) {
            payable(seller).transfer(sellerAmount);
            payable(feeRecipient).transfer(platformAmount);
            if (royaltyAmount > 0) {
                payable(collection.royaltyRecipient).transfer(royaltyAmount);
            }
        } else {
            IERC20(paymentToken).safeTransfer(seller, sellerAmount);
            IERC20(paymentToken).safeTransfer(feeRecipient, platformAmount);
            if (royaltyAmount > 0) {
                IERC20(paymentToken).safeTransfer(collection.royaltyRecipient, royaltyAmount);
            }
        }
    }

    function _acceptBid(address paymentToken, uint256 amount) internal {
        if (paymentToken == address(0)) {
            require(msg.value >= amount, "Insufficient ETH");
        } else {
            IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    function _refundBid(address paymentToken, address bidder, uint256 amount) internal {
        if (paymentToken == address(0)) {
            payable(bidder).transfer(amount);
        } else {
            IERC20(paymentToken).safeTransfer(bidder, amount);
        }
    }

    function _updateStats(address buyer, address seller, uint256 price) internal {
        userStats[buyer].totalBought++;
        userStats[buyer].totalVolume += price;
        userStats[seller].totalSold++;
        userStats[seller].totalVolume += price;
    }

    function _updateCollectionStats(address nftContract, uint256 price) internal {
        collections[nftContract].totalVolume += price;
        collections[nftContract].totalSales++;
    }

    // ============ Admin Functions ============

    function setPlatformFee(uint256 _fee) external onlyOwner {
        require(_fee <= MAX_FEE, "Fee too high");
        platformFee = _fee;
    }

    function setFeeRecipient(address _recipient) external onlyOwner {
        feeRecipient = _recipient;
    }

    function setPaymentToken(address token, bool accepted) external onlyOwner {
        acceptedPaymentTokens[token] = accepted;
    }

    function verifyCollection(address nftContract) external onlyOwner {
        collections[nftContract].isVerified = true;
        verifiedCollections.push(nftContract);
        emit CollectionVerified(nftContract);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ERC1155 receiver
    function onERC1155Received(address, address, uint256, uint256, bytes memory) public pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] memory, uint256[] memory, bytes memory) public pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    receive() external payable {}
}
