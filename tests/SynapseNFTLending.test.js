const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SynapseNFTLending", function () {
  let nftLending, synxToken, testNFT;
  let owner, lender, borrower, arbiter;
  
  const INITIAL_SUPPLY = ethers.parseEther("1000000000");
  const DAY = 86400;
  const FLOOR_PRICE = ethers.parseEther("10"); // 10 SYNX floor

  beforeEach(async function () {
    [owner, lender, borrower, arbiter] = await ethers.getSigners();

    // Deploy tokens
    const Token = await ethers.getContractFactory("SynapseToken");
    synxToken = await Token.deploy("SYNAPSE", "SYNX", INITIAL_SUPPLY, owner.address, owner.address);

    // Deploy test NFT
    const NFT = await ethers.getContractFactory("SynapseAchievementsNFT");
    testNFT = await NFT.deploy(owner.address);

    // Deploy NFT Lending
    const NFTLending = await ethers.getContractFactory("SynapseNFTLending");
    nftLending = await NFTLending.deploy();

    // Setup collection
    await nftLending.addCollection(
      await testNFT.getAddress(),
      FLOOR_PRICE,
      5000, // 50% max LTV
      8000  // 80% liquidation threshold
    );

    // Fund users
    await synxToken.transfer(lender.address, ethers.parseEther("100000"));
    await synxToken.transfer(borrower.address, ethers.parseEther("10000"));

    // Approvals
    const maxApproval = ethers.MaxUint256;
    await synxToken.connect(lender).approve(await nftLending.getAddress(), maxApproval);
    await synxToken.connect(borrower).approve(await nftLending.getAddress(), maxApproval);

    // Mint NFT to borrower
    await testNFT.mint(borrower.address, "ipfs://test/1");
    await testNFT.connect(borrower).setApprovalForAll(await nftLending.getAddress(), true);
  });

  describe("Collection Management", function () {
    it("Should add collection with correct parameters", async function () {
      const collection = await nftLending.getCollection(await testNFT.getAddress());
      
      expect(collection.floorPrice).to.equal(FLOOR_PRICE);
      expect(collection.maxLTV).to.equal(5000n);
      expect(collection.isActive).to.be.true;
    });

    it("Should update floor price", async function () {
      const newFloor = ethers.parseEther("15");
      await nftLending.updateFloorPrice(await testNFT.getAddress(), newFloor);

      const collection = await nftLending.getCollection(await testNFT.getAddress());
      expect(collection.floorPrice).to.equal(newFloor);
    });

    it("Should reject LTV > 80%", async function () {
      const NFT2 = await ethers.getContractFactory("SynapseAchievementsNFT");
      const testNFT2 = await NFT2.deploy(owner.address);

      await expect(
        nftLending.addCollection(await testNFT2.getAddress(), FLOOR_PRICE, 9000, 9500)
      ).to.be.revertedWith("LTV too high");
    });
  });

  describe("Lender Offers", function () {
    it("Should create lender offer", async function () {
      const principal = ethers.parseEther("5");
      const interestRate = 1000; // 10% annual
      const duration = 30 * DAY;

      await nftLending.connect(lender).createLenderOffer(
        await testNFT.getAddress(),
        0, // Collection-wide
        await synxToken.getAddress(),
        principal,
        interestRate,
        duration,
        7 * DAY // Expires in 7 days
      );

      const offer = await nftLending.getOffer(1);
      expect(offer.creator).to.equal(lender.address);
      expect(offer.principal).to.equal(principal);
      expect(offer.isActive).to.be.true;
    });

    it("Should transfer loan amount on offer creation", async function () {
      const principal = ethers.parseEther("5");
      const balanceBefore = await synxToken.balanceOf(lender.address);

      await nftLending.connect(lender).createLenderOffer(
        await testNFT.getAddress(),
        0,
        await synxToken.getAddress(),
        principal,
        1000,
        30 * DAY,
        7 * DAY
      );

      const balanceAfter = await synxToken.balanceOf(lender.address);
      expect(balanceBefore - balanceAfter).to.equal(principal);
    });

    it("Should allow borrower to accept lender offer", async function () {
      // Create offer
      await nftLending.connect(lender).createLenderOffer(
        await testNFT.getAddress(),
        0,
        await synxToken.getAddress(),
        ethers.parseEther("5"),
        1000,
        30 * DAY,
        7 * DAY
      );

      // Accept offer
      const balanceBefore = await synxToken.balanceOf(borrower.address);
      await nftLending.connect(borrower).acceptLenderOffer(1, 1); // Token ID 1

      const balanceAfter = await synxToken.balanceOf(borrower.address);
      
      // Should receive principal minus fee (2.5%)
      const expectedReceived = ethers.parseEther("5") * 9750n / 10000n;
      expect(balanceAfter - balanceBefore).to.equal(expectedReceived);

      // NFT should be in contract
      expect(await testNFT.ownerOf(1)).to.equal(await nftLending.getAddress());

      // Loan should be created
      const loan = await nftLending.getLoan(1);
      expect(loan.borrower).to.equal(borrower.address);
      expect(loan.lender).to.equal(lender.address);
    });
  });

  describe("Borrower Offers", function () {
    it("Should create borrower offer", async function () {
      const principal = ethers.parseEther("4");

      await nftLending.connect(borrower).createBorrowerOffer(
        await testNFT.getAddress(),
        1, // Token ID
        await synxToken.getAddress(),
        principal,
        1500, // Max 15% interest
        30 * DAY,
        7 * DAY
      );

      const offer = await nftLending.getOffer(1);
      expect(offer.creator).to.equal(borrower.address);
      expect(offer.tokenId).to.equal(1n);

      // NFT should be in contract
      expect(await testNFT.ownerOf(1)).to.equal(await nftLending.getAddress());
    });

    it("Should allow lender to accept borrower offer", async function () {
      // Create borrower offer
      await nftLending.connect(borrower).createBorrowerOffer(
        await testNFT.getAddress(),
        1,
        await synxToken.getAddress(),
        ethers.parseEther("4"),
        1500,
        30 * DAY,
        7 * DAY
      );

      // Lender accepts
      const borrowerBalanceBefore = await synxToken.balanceOf(borrower.address);
      await nftLending.connect(lender).acceptBorrowerOffer(1);

      const borrowerBalanceAfter = await synxToken.balanceOf(borrower.address);

      // Borrower should receive principal minus fee
      const expectedReceived = ethers.parseEther("4") * 9750n / 10000n;
      expect(borrowerBalanceAfter - borrowerBalanceBefore).to.equal(expectedReceived);
    });
  });

  describe("Loan Repayment", function () {
    let loanId;

    beforeEach(async function () {
      // Create and accept offer
      await nftLending.connect(lender).createLenderOffer(
        await testNFT.getAddress(),
        0,
        await synxToken.getAddress(),
        ethers.parseEther("5"),
        1000, // 10% annual
        30 * DAY,
        7 * DAY
      );

      await nftLending.connect(borrower).acceptLenderOffer(1, 1);
      loanId = 1;
    });

    it("Should repay loan successfully", async function () {
      const loan = await nftLending.getLoan(loanId);
      
      // Fast forward 15 days
      await time.increase(15 * DAY);

      // Repay loan
      await nftLending.connect(borrower).repayLoan(loanId);

      // NFT should be returned to borrower
      expect(await testNFT.ownerOf(1)).to.equal(borrower.address);

      // Loan should be marked as repaid
      const updatedLoan = await nftLending.getLoan(loanId);
      expect(updatedLoan.status).to.equal(1); // REPAID
    });

    it("Should calculate correct repayment amount", async function () {
      const loan = await nftLending.getLoan(loanId);
      
      // For 30-day loan at 10% annual:
      // Interest = 5 * 0.10 * (30/365) = ~0.041
      expect(loan.repaymentAmount).to.be.gt(ethers.parseEther("5"));
    });
  });

  describe("Loan Default", function () {
    let loanId;

    beforeEach(async function () {
      await nftLending.connect(lender).createLenderOffer(
        await testNFT.getAddress(),
        0,
        await synxToken.getAddress(),
        ethers.parseEther("5"),
        1000,
        30 * DAY,
        7 * DAY
      );

      await nftLending.connect(borrower).acceptLenderOffer(1, 1);
      loanId = 1;
    });

    it("Should allow lender to claim NFT after default", async function () {
      // Fast forward past loan duration
      await time.increase(31 * DAY);

      // Lender claims NFT
      await nftLending.connect(lender).claimDefaultedNFT(loanId);

      // NFT should be transferred to lender
      expect(await testNFT.ownerOf(1)).to.equal(lender.address);

      // Loan should be marked as defaulted
      const loan = await nftLending.getLoan(loanId);
      expect(loan.status).to.equal(2); // DEFAULTED
    });

    it("Should reject claim before expiry", async function () {
      await expect(
        nftLending.connect(lender).claimDefaultedNFT(loanId)
      ).to.be.revertedWith("Loan not expired");
    });
  });

  describe("Offer Cancellation", function () {
    it("Should cancel lender offer and return funds", async function () {
      await nftLending.connect(lender).createLenderOffer(
        await testNFT.getAddress(),
        0,
        await synxToken.getAddress(),
        ethers.parseEther("5"),
        1000,
        30 * DAY,
        7 * DAY
      );

      const balanceBefore = await synxToken.balanceOf(lender.address);
      await nftLending.connect(lender).cancelOffer(1);
      const balanceAfter = await synxToken.balanceOf(lender.address);

      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("5"));

      const offer = await nftLending.getOffer(1);
      expect(offer.isActive).to.be.false;
    });

    it("Should cancel borrower offer and return NFT", async function () {
      await nftLending.connect(borrower).createBorrowerOffer(
        await testNFT.getAddress(),
        1,
        await synxToken.getAddress(),
        ethers.parseEther("4"),
        1500,
        30 * DAY,
        7 * DAY
      );

      await nftLending.connect(borrower).cancelOffer(1);

      // NFT should be returned
      expect(await testNFT.ownerOf(1)).to.equal(borrower.address);
    });
  });

  describe("Instant Liquidity Pool", function () {
    beforeEach(async function () {
      // Configure pool
      await nftLending.configurePool(await synxToken.getAddress(), 500, 100); // 5% base, 1% slope
    });

    it("Should add liquidity to pool", async function () {
      const amount = ethers.parseEther("10000");
      await nftLending.connect(lender).addLiquidity(await synxToken.getAddress(), amount);

      const balance = await synxToken.balanceOf(await nftLending.getAddress());
      expect(balance).to.be.gte(amount);
    });

    it("Should remove liquidity from pool", async function () {
      await nftLending.connect(lender).addLiquidity(
        await synxToken.getAddress(),
        ethers.parseEther("10000")
      );

      const balanceBefore = await synxToken.balanceOf(lender.address);
      await nftLending.connect(lender).removeLiquidity(
        await synxToken.getAddress(),
        ethers.parseEther("5000")
      );
      const balanceAfter = await synxToken.balanceOf(lender.address);

      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("5000"));
    });

    it("Should allow instant borrow", async function () {
      // Add liquidity
      await nftLending.connect(lender).addLiquidity(
        await synxToken.getAddress(),
        ethers.parseEther("10000")
      );

      // Instant borrow
      const borrowAmount = ethers.parseEther("4"); // Within 50% LTV
      const balanceBefore = await synxToken.balanceOf(borrower.address);

      await nftLending.connect(borrower).instantBorrow(
        await testNFT.getAddress(),
        1,
        await synxToken.getAddress(),
        borrowAmount,
        30 * DAY
      );

      const balanceAfter = await synxToken.balanceOf(borrower.address);
      
      // Should receive amount minus fee
      const expectedReceived = borrowAmount * 9750n / 10000n;
      expect(balanceAfter - balanceBefore).to.equal(expectedReceived);
    });

    it("Should reject borrow exceeding LTV", async function () {
      await nftLending.connect(lender).addLiquidity(
        await synxToken.getAddress(),
        ethers.parseEther("10000")
      );

      // Try to borrow more than 50% LTV (floor = 10, max = 5)
      await expect(
        nftLending.connect(borrower).instantBorrow(
          await testNFT.getAddress(),
          1,
          await synxToken.getAddress(),
          ethers.parseEther("6"), // More than 50% of 10
          30 * DAY
        )
      ).to.be.revertedWith("Exceeds max LTV");
    });
  });

  describe("View Functions", function () {
    it("Should return borrower loans", async function () {
      // Create loan
      await nftLending.connect(lender).createLenderOffer(
        await testNFT.getAddress(),
        0,
        await synxToken.getAddress(),
        ethers.parseEther("5"),
        1000,
        30 * DAY,
        7 * DAY
      );
      await nftLending.connect(borrower).acceptLenderOffer(1, 1);

      const loans = await nftLending.getBorrowerLoans(borrower.address);
      expect(loans.length).to.equal(1);
    });

    it("Should calculate loan health", async function () {
      await nftLending.connect(lender).createLenderOffer(
        await testNFT.getAddress(),
        0,
        await synxToken.getAddress(),
        ethers.parseEther("5"),
        1000,
        30 * DAY,
        7 * DAY
      );
      await nftLending.connect(borrower).acceptLenderOffer(1, 1);

      const [healthFactor, isDefaulted] = await nftLending.getLoanHealth(1);
      
      // Health factor should be positive
      expect(healthFactor).to.be.gt(0);
      expect(isDefaulted).to.be.false;
    });
  });

  describe("Admin Functions", function () {
    it("Should set protocol fee", async function () {
      await nftLending.setProtocolFee(300); // 3%
      expect(await nftLending.protocolFee()).to.equal(300n);
    });

    it("Should pause and unpause", async function () {
      await nftLending.pause();

      await expect(
        nftLending.connect(lender).createLenderOffer(
          await testNFT.getAddress(),
          0,
          await synxToken.getAddress(),
          ethers.parseEther("5"),
          1000,
          30 * DAY,
          7 * DAY
        )
      ).to.be.reverted;

      await nftLending.unpause();

      // Should work after unpause
      await nftLending.connect(lender).createLenderOffer(
        await testNFT.getAddress(),
        0,
        await synxToken.getAddress(),
        ethers.parseEther("5"),
        1000,
        30 * DAY,
        7 * DAY
      );
    });
  });
});
