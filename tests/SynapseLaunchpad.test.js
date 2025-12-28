const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

describe("SynapseLaunchpad", function () {
  let launchpad, synxToken, saleToken;
  let owner, creator, alice, bob, charlie;
  
  const INITIAL_SUPPLY = ethers.parseEther("1000000000");
  const DAY = 86400;

  beforeEach(async function () {
    [owner, creator, alice, bob, charlie] = await ethers.getSigners();

    // Deploy tokens
    const Token = await ethers.getContractFactory("SynapseToken");
    synxToken = await Token.deploy("SYNAPSE", "SYNX", INITIAL_SUPPLY, owner.address, owner.address);
    saleToken = await Token.deploy("Sale Token", "SALE", INITIAL_SUPPLY, creator.address, creator.address);

    // Deploy launchpad
    const Launchpad = await ethers.getContractFactory("SynapseLaunchpad");
    launchpad = await Launchpad.deploy(await synxToken.getAddress());

    // Grant creator role
    const CREATOR_ROLE = await launchpad.CREATOR_ROLE();
    await launchpad.grantRole(CREATOR_ROLE, creator.address);

    // Fund users with SYNX for payments
    await synxToken.transfer(alice.address, ethers.parseEther("100000"));
    await synxToken.transfer(bob.address, ethers.parseEther("100000"));
    await synxToken.transfer(charlie.address, ethers.parseEther("100000"));

    // Approvals
    const maxApproval = ethers.MaxUint256;
    await synxToken.connect(alice).approve(await launchpad.getAddress(), maxApproval);
    await synxToken.connect(bob).approve(await launchpad.getAddress(), maxApproval);
    await synxToken.connect(charlie).approve(await launchpad.getAddress(), maxApproval);
    await saleToken.connect(creator).approve(await launchpad.getAddress(), maxApproval);

    // Update user stakes for tiers
    const OPERATOR_ROLE = await launchpad.OPERATOR_ROLE();
    await launchpad.grantRole(OPERATOR_ROLE, owner.address);
    await launchpad.updateUserStake(alice.address, ethers.parseEther("10000")); // Silver tier
    await launchpad.updateUserStake(bob.address, ethers.parseEther("100000")); // Platinum tier
  });

  describe("Sale Creation", function () {
    it("Should create a public sale", async function () {
      const now = await time.latest();
      const startTime = now + 100;
      const endTime = startTime + 7 * DAY;

      await launchpad.connect(creator).createSale(
        await saleToken.getAddress(),
        await synxToken.getAddress(),
        ethers.parseEther("0.1"), // Price: 0.1 SYNX per token
        ethers.parseEther("1000000"), // 1M tokens
        ethers.parseEther("100"), // Min purchase
        ethers.parseEther("10000"), // Max purchase
        startTime,
        endTime,
        ethers.parseEther("50000"), // Soft cap
        ethers.parseEther("100000"), // Hard cap
        0, // PUBLIC
        0, // No vesting
        "ipfs://metadata"
      );

      expect(await launchpad.saleCounter()).to.equal(1n);

      const sale = await launchpad.getSale(1);
      expect(sale.creator).to.equal(creator.address);
      expect(sale.tokenPrice).to.equal(ethers.parseEther("0.1"));
    });

    it("Should transfer sale tokens to launchpad", async function () {
      const now = await time.latest();

      await launchpad.connect(creator).createSale(
        await saleToken.getAddress(),
        await synxToken.getAddress(),
        ethers.parseEther("0.1"),
        ethers.parseEther("100000"),
        ethers.parseEther("10"),
        ethers.parseEther("1000"),
        now + 100,
        now + 7 * DAY,
        ethers.parseEther("5000"),
        ethers.parseEther("10000"),
        0, 0, ""
      );

      const balance = await saleToken.balanceOf(await launchpad.getAddress());
      expect(balance).to.equal(ethers.parseEther("100000"));
    });
  });

  describe("Participation", function () {
    let saleId;

    beforeEach(async function () {
      const now = await time.latest();

      await launchpad.connect(creator).createSale(
        await saleToken.getAddress(),
        await synxToken.getAddress(),
        ethers.parseEther("0.1"),
        ethers.parseEther("100000"),
        ethers.parseEther("100"),
        ethers.parseEther("10000"),
        now + 100,
        now + 7 * DAY,
        ethers.parseEther("5000"),
        ethers.parseEther("10000"),
        0, 0, ""
      );

      saleId = 1;

      // Start sale
      await time.increase(101);
      await launchpad.startSale(saleId);
    });

    it("Should allow participation", async function () {
      const amount = ethers.parseEther("1000"); // Pay 1000 SYNX

      await launchpad.connect(alice).participate(saleId, amount);

      const participation = await launchpad.getParticipation(saleId, alice.address);
      expect(participation.amount).to.equal(amount);
      // Should get 10000 tokens (1000 / 0.1)
      expect(participation.tokenAmount).to.equal(ethers.parseEther("10000"));
    });

    it("Should enforce minimum purchase", async function () {
      await expect(
        launchpad.connect(alice).participate(saleId, ethers.parseEther("50"))
      ).to.be.revertedWith("Below minimum");
    });

    it("Should update sale stats", async function () {
      await launchpad.connect(alice).participate(saleId, ethers.parseEther("1000"));
      await launchpad.connect(bob).participate(saleId, ethers.parseEther("2000"));

      const sale = await launchpad.getSale(saleId);
      expect(sale.totalRaised).to.equal(ethers.parseEther("3000"));
      expect(sale.tokensSold).to.equal(ethers.parseEther("30000"));
    });

    it("Should enforce hard cap", async function () {
      // Try to exceed hard cap (10000 SYNX)
      await launchpad.connect(alice).participate(saleId, ethers.parseEther("5000"));
      await launchpad.connect(bob).participate(saleId, ethers.parseEther("5000"));

      await expect(
        launchpad.connect(charlie).participate(saleId, ethers.parseEther("100"))
      ).to.be.revertedWith("Exceeds hard cap");
    });
  });

  describe("Tiered Allocation", function () {
    let saleId;

    beforeEach(async function () {
      const now = await time.latest();

      // Create tiered sale
      await launchpad.connect(creator).createSale(
        await saleToken.getAddress(),
        await synxToken.getAddress(),
        ethers.parseEther("0.1"),
        ethers.parseEther("100000"),
        ethers.parseEther("100"),
        ethers.parseEther("1000"), // Low max for testing
        now + 100,
        now + 7 * DAY,
        ethers.parseEther("5000"),
        ethers.parseEther("50000"),
        2, // TIERED
        0, ""
      );

      saleId = 1;
      await time.increase(101);
      await launchpad.startSale(saleId);
    });

    it("Should calculate tier correctly", async function () {
      // Alice: 10k staked = Silver (tier 1)
      expect(await launchpad.getUserTier(alice.address)).to.equal(1);

      // Bob: 100k staked = Platinum (tier 3)
      expect(await launchpad.getUserTier(bob.address)).to.equal(3);

      // Charlie: 0 staked = Bronze (tier 0)
      expect(await launchpad.getUserTier(charlie.address)).to.equal(0);
    });

    it("Should apply tier multiplier to allocation", async function () {
      // Bob (Platinum) should have higher allocation
      // Base: 1000, Platinum: 5x = 5000
      await launchpad.connect(bob).participate(saleId, ethers.parseEther("5000"));

      const participation = await launchpad.getParticipation(saleId, bob.address);
      expect(participation.amount).to.equal(ethers.parseEther("5000"));
    });
  });

  describe("Whitelist", function () {
    let saleId;

    beforeEach(async function () {
      const now = await time.latest();

      // Create whitelist sale
      await launchpad.connect(creator).createSale(
        await saleToken.getAddress(),
        await synxToken.getAddress(),
        ethers.parseEther("0.1"),
        ethers.parseEther("100000"),
        ethers.parseEther("100"),
        ethers.parseEther("10000"),
        now + 100,
        now + 7 * DAY,
        ethers.parseEther("5000"),
        ethers.parseEther("50000"),
        1, // WHITELIST
        0, ""
      );

      saleId = 1;
      await time.increase(101);
      await launchpad.startSale(saleId);
    });

    it("Should reject non-whitelisted users", async function () {
      await expect(
        launchpad.connect(alice).participate(saleId, ethers.parseEther("1000"))
      ).to.be.revertedWith("Not whitelisted");
    });

    it("Should allow whitelisted users", async function () {
      await launchpad.connect(creator).addToWhitelist(saleId, [alice.address]);

      await launchpad.connect(alice).participate(saleId, ethers.parseEther("1000"));

      const participation = await launchpad.getParticipation(saleId, alice.address);
      expect(participation.amount).to.equal(ethers.parseEther("1000"));
    });
  });

  describe("Sale Finalization", function () {
    let saleId;

    beforeEach(async function () {
      const now = await time.latest();

      await launchpad.connect(creator).createSale(
        await saleToken.getAddress(),
        await synxToken.getAddress(),
        ethers.parseEther("0.1"),
        ethers.parseEther("100000"),
        ethers.parseEther("100"),
        ethers.parseEther("10000"),
        now + 100,
        now + 7 * DAY,
        ethers.parseEther("5000"), // Soft cap: 5000 SYNX
        ethers.parseEther("50000"),
        0, 0, ""
      );

      saleId = 1;
      await time.increase(101);
      await launchpad.startSale(saleId);
    });

    it("Should finalize when soft cap reached", async function () {
      // Reach soft cap
      await launchpad.connect(alice).participate(saleId, ethers.parseEther("5000"));

      // End sale
      await time.increase(7 * DAY + 1);

      const creatorBalanceBefore = await synxToken.balanceOf(creator.address);
      
      await launchpad.finalizeSale(saleId);

      const creatorBalanceAfter = await synxToken.balanceOf(creator.address);
      
      // Creator should receive funds minus 3% fee
      const expected = ethers.parseEther("5000") * 9700n / 10000n;
      expect(creatorBalanceAfter - creatorBalanceBefore).to.equal(expected);

      const sale = await launchpad.getSale(saleId);
      expect(sale.status).to.equal(4); // FINALIZED
    });

    it("Should cancel when soft cap not reached", async function () {
      // Don't reach soft cap
      await launchpad.connect(alice).participate(saleId, ethers.parseEther("1000"));

      await time.increase(7 * DAY + 1);

      await launchpad.finalizeSale(saleId);

      const sale = await launchpad.getSale(saleId);
      expect(sale.status).to.equal(3); // CANCELLED
    });
  });

  describe("Token Claims", function () {
    let saleId;

    beforeEach(async function () {
      const now = await time.latest();

      await launchpad.connect(creator).createSale(
        await saleToken.getAddress(),
        await synxToken.getAddress(),
        ethers.parseEther("0.1"),
        ethers.parseEther("100000"),
        ethers.parseEther("100"),
        ethers.parseEther("10000"),
        now + 100,
        now + 7 * DAY,
        ethers.parseEther("1000"),
        ethers.parseEther("50000"),
        0, 0, ""
      );

      saleId = 1;
      await time.increase(101);
      await launchpad.startSale(saleId);

      await launchpad.connect(alice).participate(saleId, ethers.parseEther("1000"));

      await time.increase(7 * DAY + 1);
      await launchpad.finalizeSale(saleId);
    });

    it("Should allow claiming tokens after finalization", async function () {
      await launchpad.connect(alice).claimTokens(saleId);

      const balance = await saleToken.balanceOf(alice.address);
      expect(balance).to.equal(ethers.parseEther("10000")); // 1000 / 0.1
    });
  });

  describe("Refunds", function () {
    let saleId;

    beforeEach(async function () {
      const now = await time.latest();

      await launchpad.connect(creator).createSale(
        await saleToken.getAddress(),
        await synxToken.getAddress(),
        ethers.parseEther("0.1"),
        ethers.parseEther("100000"),
        ethers.parseEther("100"),
        ethers.parseEther("10000"),
        now + 100,
        now + 7 * DAY,
        ethers.parseEther("10000"), // High soft cap
        ethers.parseEther("50000"),
        0, 0, ""
      );

      saleId = 1;
      await time.increase(101);
      await launchpad.startSale(saleId);

      // Don't reach soft cap
      await launchpad.connect(alice).participate(saleId, ethers.parseEther("1000"));

      await time.increase(7 * DAY + 1);
      await launchpad.finalizeSale(saleId);
    });

    it("Should allow refund when sale cancelled", async function () {
      const balanceBefore = await synxToken.balanceOf(alice.address);
      
      await launchpad.connect(alice).claimRefund(saleId);

      const balanceAfter = await synxToken.balanceOf(alice.address);
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("1000"));
    });
  });

  describe("Vesting", function () {
    let saleId;
    const VESTING_DURATION = 100 * DAY;
    const CLIFF_DURATION = 30 * DAY;
    const TGE_PERCENT = 2000; // 20%

    beforeEach(async function () {
      const now = await time.latest();

      await launchpad.connect(creator).createSale(
        await saleToken.getAddress(),
        await synxToken.getAddress(),
        ethers.parseEther("0.1"),
        ethers.parseEther("100000"),
        ethers.parseEther("100"),
        ethers.parseEther("10000"),
        now + 100,
        now + 7 * DAY,
        ethers.parseEther("1000"),
        ethers.parseEther("50000"),
        0,
        1, // LINEAR vesting
        ""
      );

      saleId = 1;

      // Set vesting schedule
      await launchpad.connect(creator).setVestingSchedule(
        saleId,
        TGE_PERCENT,
        CLIFF_DURATION,
        VESTING_DURATION,
        DAY // Daily releases
      );

      await time.increase(101);
      await launchpad.startSale(saleId);

      await launchpad.connect(alice).participate(saleId, ethers.parseEther("1000"));

      await time.increase(7 * DAY + 1);
      await launchpad.finalizeSale(saleId);
    });

    it("Should release TGE amount immediately", async function () {
      await launchpad.connect(alice).claimTokens(saleId);

      const balance = await saleToken.balanceOf(alice.address);
      // 20% of 10000 = 2000 tokens
      expect(balance).to.equal(ethers.parseEther("2000"));
    });

    it("Should vest remaining tokens over time", async function () {
      // Claim TGE
      await launchpad.connect(alice).claimTokens(saleId);

      // Move past cliff + 50% vesting
      await time.increase(CLIFF_DURATION + VESTING_DURATION / 2);

      // Get claimable
      const claimable = await launchpad.getClaimable(saleId, alice.address);
      
      // Should be approximately 50% of vesting amount (8000 * 0.5 = 4000)
      expect(claimable).to.be.gt(ethers.parseEther("3500"));
    });
  });

  describe("Admin Functions", function () {
    it("Should add tier", async function () {
      await launchpad.addTier(
        "Whale",
        ethers.parseEther("1000000"),
        200000, // 20x
        100
      );

      const tiers = await launchpad.getTiers();
      expect(tiers.length).to.equal(6);
    });

    it("Should set platform fee", async function () {
      await launchpad.setPlatformFee(500); // 5%
      expect(await launchpad.platformFee()).to.equal(500n);
    });
  });
});
