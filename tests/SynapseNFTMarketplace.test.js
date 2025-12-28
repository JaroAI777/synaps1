const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SynapseNFTMarketplace", function () {
  let marketplace, synxToken, nftContract;
  let owner, alice, bob, charlie;
  
  const INITIAL_SUPPLY = ethers.parseEther("1000000000");
  const DAY = 86400;

  beforeEach(async function () {
    [owner, alice, bob, charlie] = await ethers.getSigners();

    // Deploy SYNX token
    const Token = await ethers.getContractFactory("SynapseToken");
    synxToken = await Token.deploy("SYNAPSE", "SYNX", INITIAL_SUPPLY, owner.address, owner.address);

    // Deploy mock NFT contract
    const MockNFT = await ethers.getContractFactory("MockERC721");
    nftContract = await MockNFT.deploy("Test NFT", "TNFT");

    // Deploy marketplace
    const Marketplace = await ethers.getContractFactory("SynapseNFTMarketplace");
    marketplace = await Marketplace.deploy(await synxToken.getAddress());

    // Mint NFTs to users
    await nftContract.mint(alice.address, 1);
    await nftContract.mint(alice.address, 2);
    await nftContract.mint(bob.address, 3);
    await nftContract.mint(charlie.address, 4);

    // Distribute SYNX
    await synxToken.transfer(alice.address, ethers.parseEther("100000"));
    await synxToken.transfer(bob.address, ethers.parseEther("100000"));
    await synxToken.transfer(charlie.address, ethers.parseEther("100000"));

    // Approvals
    const maxApproval = ethers.MaxUint256;
    await synxToken.connect(alice).approve(await marketplace.getAddress(), maxApproval);
    await synxToken.connect(bob).approve(await marketplace.getAddress(), maxApproval);
    await synxToken.connect(charlie).approve(await marketplace.getAddress(), maxApproval);
    
    await nftContract.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);
    await nftContract.connect(bob).setApprovalForAll(await marketplace.getAddress(), true);
    await nftContract.connect(charlie).setApprovalForAll(await marketplace.getAddress(), true);
  });

  describe("Fixed Price Listings", function () {
    it("Should create a fixed price listing", async function () {
      const price = ethers.parseEther("100");
      const duration = 7 * DAY;

      const tx = await marketplace.connect(alice).createListing(
        await nftContract.getAddress(),
        1,
        1,
        0, // ERC721
        await synxToken.getAddress(),
        price,
        duration
      );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);

      const listing = await marketplace.getListing(1);
      expect(listing.seller).to.equal(alice.address);
      expect(listing.price).to.equal(price);
      expect(listing.status).to.equal(0); // ACTIVE
    });

    it("Should transfer NFT to marketplace on listing", async function () {
      await marketplace.connect(alice).createListing(
        await nftContract.getAddress(),
        1,
        1,
        0,
        await synxToken.getAddress(),
        ethers.parseEther("100"),
        7 * DAY
      );

      expect(await nftContract.ownerOf(1)).to.equal(await marketplace.getAddress());
    });

    it("Should allow buying a listing", async function () {
      await marketplace.connect(alice).createListing(
        await nftContract.getAddress(),
        1,
        1,
        0,
        await synxToken.getAddress(),
        ethers.parseEther("100"),
        7 * DAY
      );

      await marketplace.connect(bob).buyListing(1);

      expect(await nftContract.ownerOf(1)).to.equal(bob.address);
    });

    it("Should transfer payment to seller minus fee", async function () {
      const price = ethers.parseEther("100");
      
      await marketplace.connect(alice).createListing(
        await nftContract.getAddress(),
        1,
        1,
        0,
        await synxToken.getAddress(),
        price,
        7 * DAY
      );

      const balanceBefore = await synxToken.balanceOf(alice.address);
      
      await marketplace.connect(bob).buyListing(1);

      const balanceAfter = await synxToken.balanceOf(alice.address);
      
      // 2.5% platform fee
      const expectedReceived = price - (price * 250n / 10000n);
      expect(balanceAfter - balanceBefore).to.equal(expectedReceived);
    });

    it("Should reject buying expired listing", async function () {
      await marketplace.connect(alice).createListing(
        await nftContract.getAddress(),
        1,
        1,
        0,
        await synxToken.getAddress(),
        ethers.parseEther("100"),
        1 * DAY
      );

      await time.increase(2 * DAY);

      await expect(
        marketplace.connect(bob).buyListing(1)
      ).to.be.revertedWith("Listing expired");
    });

    it("Should allow cancelling a listing", async function () {
      await marketplace.connect(alice).createListing(
        await nftContract.getAddress(),
        1,
        1,
        0,
        await synxToken.getAddress(),
        ethers.parseEther("100"),
        7 * DAY
      );

      await marketplace.connect(alice).cancelListing(1);

      // NFT returned
      expect(await nftContract.ownerOf(1)).to.equal(alice.address);

      // Listing cancelled
      const listing = await marketplace.getListing(1);
      expect(listing.status).to.equal(3); // CANCELLED
    });
  });

  describe("Auctions", function () {
    beforeEach(async function () {
      await marketplace.connect(alice).createAuction(
        await nftContract.getAddress(),
        1,
        1,
        0,
        await synxToken.getAddress(),
        ethers.parseEther("10"),  // Starting price
        ethers.parseEther("1"),   // Min increment
        7 * DAY,                   // Duration
        300                        // 5 min extension
      );
    });

    it("Should create an auction", async function () {
      const listing = await marketplace.getListing(1);
      expect(listing.listingType).to.equal(1); // AUCTION
      expect(listing.price).to.equal(ethers.parseEther("10"));
    });

    it("Should accept bids at or above minimum", async function () {
      await marketplace.connect(bob).placeBid(1, ethers.parseEther("10"));

      const auction = await marketplace.getAuction(1);
      expect(auction.highestBidder).to.equal(bob.address);
      expect(auction.highestBid).to.equal(ethers.parseEther("10"));
    });

    it("Should reject bids below minimum", async function () {
      await expect(
        marketplace.connect(bob).placeBid(1, ethers.parseEther("5"))
      ).to.be.revertedWith("Bid too low");
    });

    it("Should refund previous bidder on outbid", async function () {
      await marketplace.connect(bob).placeBid(1, ethers.parseEther("10"));
      
      const bobBalanceBefore = await synxToken.balanceOf(bob.address);
      
      await marketplace.connect(charlie).placeBid(1, ethers.parseEther("15"));
      
      const bobBalanceAfter = await synxToken.balanceOf(bob.address);
      
      // Bob should be refunded
      expect(bobBalanceAfter - bobBalanceBefore).to.equal(ethers.parseEther("10"));
    });

    it("Should extend auction on last-minute bid", async function () {
      const listingBefore = await marketplace.getListing(1);
      
      // Fast forward to 1 minute before end
      await time.increase(7 * DAY - 60);
      
      await marketplace.connect(bob).placeBid(1, ethers.parseEther("10"));
      
      const listingAfter = await marketplace.getListing(1);
      
      // Should be extended by 5 minutes
      expect(listingAfter.endTime).to.be.gt(listingBefore.endTime);
    });

    it("Should settle auction with winner", async function () {
      await marketplace.connect(bob).placeBid(1, ethers.parseEther("20"));
      
      await time.increase(7 * DAY + 1);
      
      await marketplace.settleAuction(1);
      
      // Bob should own the NFT
      expect(await nftContract.ownerOf(1)).to.equal(bob.address);
      
      // Listing should be sold
      const listing = await marketplace.getListing(1);
      expect(listing.status).to.equal(1); // SOLD
    });

    it("Should return NFT if no bids", async function () {
      await time.increase(7 * DAY + 1);
      
      await marketplace.settleAuction(1);
      
      // NFT returned to Alice
      expect(await nftContract.ownerOf(1)).to.equal(alice.address);
      
      // Listing expired
      const listing = await marketplace.getListing(1);
      expect(listing.status).to.equal(3); // EXPIRED/CANCELLED
    });

    it("Should not allow cancelling auction with bids", async function () {
      await marketplace.connect(bob).placeBid(1, ethers.parseEther("10"));
      
      await expect(
        marketplace.connect(alice).cancelListing(1)
      ).to.be.revertedWith("Has bids");
    });
  });

  describe("Dutch Auctions", function () {
    beforeEach(async function () {
      await marketplace.connect(alice).createDutchAuction(
        await nftContract.getAddress(),
        1,
        1,
        0,
        await synxToken.getAddress(),
        ethers.parseEther("100"), // Start price
        ethers.parseEther("10"),  // End price
        1 * DAY                    // Duration
      );
    });

    it("Should create Dutch auction", async function () {
      const listing = await marketplace.getListing(1);
      expect(listing.listingType).to.equal(2); // DUTCH_AUCTION
      expect(listing.price).to.equal(ethers.parseEther("100"));
      expect(listing.endPrice).to.equal(ethers.parseEther("10"));
    });

    it("Should decrease price over time", async function () {
      const priceAtStart = await marketplace.getDutchAuctionPrice(1);
      
      await time.increase(DAY / 2);
      
      const priceAtHalf = await marketplace.getDutchAuctionPrice(1);
      
      expect(priceAtHalf).to.be.lt(priceAtStart);
      // At halfway, price should be ~55 SYNX
      expect(priceAtHalf).to.be.closeTo(ethers.parseEther("55"), ethers.parseEther("5"));
    });

    it("Should reach end price at end", async function () {
      await time.increase(DAY + 1);
      
      const price = await marketplace.getDutchAuctionPrice(1);
      expect(price).to.equal(ethers.parseEther("10"));
    });

    it("Should allow buying at current price", async function () {
      await time.increase(DAY / 2);
      
      const currentPrice = await marketplace.getDutchAuctionPrice(1);
      
      await marketplace.connect(bob).buyDutchAuction(1);
      
      expect(await nftContract.ownerOf(1)).to.equal(bob.address);
    });
  });

  describe("Offers", function () {
    it("Should create an offer", async function () {
      const tx = await marketplace.connect(bob).makeOffer(
        await nftContract.getAddress(),
        1,
        1,
        await synxToken.getAddress(),
        ethers.parseEther("50"),
        7 * DAY
      );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
    });

    it("Should lock payment on offer creation", async function () {
      const balanceBefore = await synxToken.balanceOf(bob.address);
      
      await marketplace.connect(bob).makeOffer(
        await nftContract.getAddress(),
        1,
        1,
        await synxToken.getAddress(),
        ethers.parseEther("50"),
        7 * DAY
      );

      const balanceAfter = await synxToken.balanceOf(bob.address);
      expect(balanceBefore - balanceAfter).to.equal(ethers.parseEther("50"));
    });

    it("Should allow accepting an offer", async function () {
      await marketplace.connect(bob).makeOffer(
        await nftContract.getAddress(),
        1,
        1,
        await synxToken.getAddress(),
        ethers.parseEther("50"),
        7 * DAY
      );

      await marketplace.connect(alice).acceptOffer(1);

      // Bob now owns the NFT
      expect(await nftContract.ownerOf(1)).to.equal(bob.address);
    });

    it("Should allow cancelling an offer", async function () {
      await marketplace.connect(bob).makeOffer(
        await nftContract.getAddress(),
        1,
        1,
        await synxToken.getAddress(),
        ethers.parseEther("50"),
        7 * DAY
      );

      const balanceBefore = await synxToken.balanceOf(bob.address);
      
      await marketplace.connect(bob).cancelOffer(1);

      const balanceAfter = await synxToken.balanceOf(bob.address);
      
      // Refunded
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("50"));
    });
  });

  describe("Collections & Royalties", function () {
    it("Should register a collection", async function () {
      await marketplace.connect(alice).registerCollection(
        await nftContract.getAddress(),
        500, // 5% royalty
        alice.address
      );

      const collection = await marketplace.collections(await nftContract.getAddress());
      expect(collection.creator).to.equal(alice.address);
      expect(collection.royaltyBps).to.equal(500n);
    });

    it("Should apply royalties on sale", async function () {
      // Register collection with 5% royalty
      await marketplace.connect(alice).registerCollection(
        await nftContract.getAddress(),
        500,
        charlie.address // Royalty recipient
      );

      // Alice lists NFT
      await marketplace.connect(alice).createListing(
        await nftContract.getAddress(),
        1,
        1,
        0,
        await synxToken.getAddress(),
        ethers.parseEther("100"),
        7 * DAY
      );

      const charlieBalanceBefore = await synxToken.balanceOf(charlie.address);
      
      // Bob buys
      await marketplace.connect(bob).buyListing(1);

      const charlieBalanceAfter = await synxToken.balanceOf(charlie.address);
      
      // Charlie should receive 5% royalty = 5 SYNX
      expect(charlieBalanceAfter - charlieBalanceBefore).to.equal(ethers.parseEther("5"));
    });

    it("Should update royalty settings", async function () {
      await marketplace.connect(alice).registerCollection(
        await nftContract.getAddress(),
        500,
        alice.address
      );

      await marketplace.connect(alice).updateRoyalty(
        await nftContract.getAddress(),
        1000, // 10%
        bob.address
      );

      const collection = await marketplace.collections(await nftContract.getAddress());
      expect(collection.royaltyBps).to.equal(1000n);
      expect(collection.royaltyRecipient).to.equal(bob.address);
    });

    it("Should reject high royalty", async function () {
      await expect(
        marketplace.connect(alice).registerCollection(
          await nftContract.getAddress(),
          1500, // 15% - too high
          alice.address
        )
      ).to.be.revertedWith("Royalty too high");
    });
  });

  describe("User Stats", function () {
    it("Should track user statistics", async function () {
      // Alice lists and Bob buys
      await marketplace.connect(alice).createListing(
        await nftContract.getAddress(),
        1,
        1,
        0,
        await synxToken.getAddress(),
        ethers.parseEther("100"),
        7 * DAY
      );

      await marketplace.connect(bob).buyListing(1);

      const aliceStats = await marketplace.userStats(alice.address);
      const bobStats = await marketplace.userStats(bob.address);

      expect(aliceStats.totalSold).to.equal(1n);
      expect(aliceStats.totalVolume).to.equal(ethers.parseEther("100"));
      
      expect(bobStats.totalBought).to.equal(1n);
      expect(bobStats.totalVolume).to.equal(ethers.parseEther("100"));
    });
  });

  describe("Admin Functions", function () {
    it("Should set platform fee", async function () {
      await marketplace.setPlatformFee(500); // 5%
      
      expect(await marketplace.platformFee()).to.equal(500n);
    });

    it("Should reject fee above maximum", async function () {
      await expect(
        marketplace.setPlatformFee(1500)
      ).to.be.revertedWith("Fee too high");
    });

    it("Should set payment token acceptance", async function () {
      const mockToken = await ethers.Wallet.createRandom().address;
      
      await marketplace.setPaymentToken(mockToken, true);
      
      expect(await marketplace.acceptedPaymentTokens(mockToken)).to.be.true;
    });

    it("Should verify collection", async function () {
      await marketplace.connect(alice).registerCollection(
        await nftContract.getAddress(),
        500,
        alice.address
      );

      await marketplace.verifyCollection(await nftContract.getAddress());

      const collection = await marketplace.collections(await nftContract.getAddress());
      expect(collection.isVerified).to.be.true;
    });

    it("Should pause and unpause", async function () {
      await marketplace.pause();

      await expect(
        marketplace.connect(alice).createListing(
          await nftContract.getAddress(),
          2,
          1,
          0,
          await synxToken.getAddress(),
          ethers.parseEther("100"),
          7 * DAY
        )
      ).to.be.reverted;

      await marketplace.unpause();

      await marketplace.connect(alice).createListing(
        await nftContract.getAddress(),
        2,
        1,
        0,
        await synxToken.getAddress(),
        ethers.parseEther("100"),
        7 * DAY
      );
    });
  });
});

// Mock ERC721 contract for testing
const MockERC721 = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
contract MockERC721 is ERC721 {
    constructor(string memory name, string memory symbol) ERC721(name, symbol) {}
    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}
`;
