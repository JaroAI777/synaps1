const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

describe("SynapseAirdrop", function () {
  let airdrop, token;
  let owner, alice, bob, charlie, referrer;
  
  const INITIAL_SUPPLY = ethers.parseEther("1000000000");
  const DAY = 86400;

  // Helper to create merkle tree
  function createMerkleTree(recipients) {
    const leaves = recipients.map(r => 
      ethers.solidityPackedKeccak256(
        ["address", "uint256"],
        [r.address, r.amount]
      )
    );
    
    return new MerkleTree(leaves, keccak256, { sortPairs: true });
  }

  function getProof(tree, address, amount) {
    const leaf = ethers.solidityPackedKeccak256(
      ["address", "uint256"],
      [address, amount]
    );
    return tree.getHexProof(leaf);
  }

  beforeEach(async function () {
    [owner, alice, bob, charlie, referrer] = await ethers.getSigners();

    // Deploy token
    const Token = await ethers.getContractFactory("SynapseToken");
    token = await Token.deploy("SYNAPSE", "SYNX", INITIAL_SUPPLY, owner.address, owner.address);

    // Deploy airdrop
    const Airdrop = await ethers.getContractFactory("SynapseAirdrop");
    airdrop = await Airdrop.deploy(await token.getAddress());

    // Fund airdrop contract
    await token.transfer(await airdrop.getAddress(), ethers.parseEther("10000000"));
  });

  describe("Round Creation", function () {
    it("Should create an airdrop round", async function () {
      const recipients = [
        { address: alice.address, amount: ethers.parseEther("1000") },
        { address: bob.address, amount: ethers.parseEther("2000") }
      ];

      const tree = createMerkleTree(recipients);
      const root = tree.getHexRoot();
      const now = await time.latest();

      await airdrop.createRound(
        root,
        ethers.parseEther("3000"),
        now,
        now + 30 * DAY,
        0, // No vesting
        0, // No cliff
        "Test Round"
      );

      expect(await airdrop.getRoundCount()).to.equal(1n);

      const round = await airdrop.getRound(0);
      expect(round.merkleRoot).to.equal(root);
      expect(round.totalAmount).to.equal(ethers.parseEther("3000"));
      expect(round.isActive).to.be.true;
    });

    it("Should reject round with insufficient balance", async function () {
      const tree = createMerkleTree([
        { address: alice.address, amount: ethers.parseEther("100000000") }
      ]);
      const now = await time.latest();

      await expect(
        airdrop.createRound(
          tree.getHexRoot(),
          ethers.parseEther("100000000"),
          now,
          now + DAY,
          0,
          0,
          "Test"
        )
      ).to.be.revertedWith("Insufficient balance");
    });
  });

  describe("Claiming", function () {
    let tree, aliceAmount, bobAmount;

    beforeEach(async function () {
      aliceAmount = ethers.parseEther("1000");
      bobAmount = ethers.parseEther("2000");

      const recipients = [
        { address: alice.address, amount: aliceAmount },
        { address: bob.address, amount: bobAmount }
      ];

      tree = createMerkleTree(recipients);
      const now = await time.latest();

      await airdrop.createRound(
        tree.getHexRoot(),
        ethers.parseEther("3000"),
        now,
        now + 30 * DAY,
        0,
        0,
        "Test Round"
      );
    });

    it("Should allow claiming with valid proof", async function () {
      const proof = getProof(tree, alice.address, aliceAmount);

      await airdrop.connect(alice).claim(0, aliceAmount, proof, ethers.ZeroAddress);

      const balance = await token.balanceOf(alice.address);
      expect(balance).to.equal(aliceAmount);
    });

    it("Should reject claiming with invalid proof", async function () {
      const proof = getProof(tree, alice.address, aliceAmount);

      await expect(
        airdrop.connect(bob).claim(0, aliceAmount, proof, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid proof");
    });

    it("Should reject double claiming", async function () {
      const proof = getProof(tree, alice.address, aliceAmount);

      await airdrop.connect(alice).claim(0, aliceAmount, proof, ethers.ZeroAddress);

      await expect(
        airdrop.connect(alice).claim(0, aliceAmount, proof, ethers.ZeroAddress)
      ).to.be.revertedWith("Already claimed");
    });

    it("Should reject claiming before start time", async function () {
      const now = await time.latest();

      await airdrop.createRound(
        tree.getHexRoot(),
        ethers.parseEther("3000"),
        now + DAY,
        now + 30 * DAY,
        0,
        0,
        "Future Round"
      );

      const proof = getProof(tree, alice.address, aliceAmount);

      await expect(
        airdrop.connect(alice).claim(1, aliceAmount, proof, ethers.ZeroAddress)
      ).to.be.revertedWith("Not started");
    });

    it("Should reject claiming after end time", async function () {
      await time.increase(31 * DAY);

      const proof = getProof(tree, alice.address, aliceAmount);

      await expect(
        airdrop.connect(alice).claim(0, aliceAmount, proof, ethers.ZeroAddress)
      ).to.be.revertedWith("Ended");
    });
  });

  describe("Referrals", function () {
    let tree, aliceAmount;

    beforeEach(async function () {
      aliceAmount = ethers.parseEther("1000");

      const recipients = [
        { address: alice.address, amount: aliceAmount }
      ];

      tree = createMerkleTree(recipients);
      const now = await time.latest();

      await airdrop.createRound(
        tree.getHexRoot(),
        ethers.parseEther("1000"),
        now,
        now + 30 * DAY,
        0,
        0,
        "Test Round"
      );
    });

    it("Should pay referral bonus", async function () {
      const proof = getProof(tree, alice.address, aliceAmount);

      await airdrop.connect(alice).claim(0, aliceAmount, proof, referrer.address);

      const referrerBalance = await token.balanceOf(referrer.address);
      // 5% of 1000 = 50 SYNX
      expect(referrerBalance).to.equal(ethers.parseEther("50"));
    });

    it("Should track referral earnings", async function () {
      const proof = getProof(tree, alice.address, aliceAmount);

      await airdrop.connect(alice).claim(0, aliceAmount, proof, referrer.address);

      const earnings = await airdrop.referralEarnings(referrer.address);
      expect(earnings).to.equal(ethers.parseEther("50"));
    });

    it("Should not allow self-referral", async function () {
      const proof = getProof(tree, alice.address, aliceAmount);

      await airdrop.connect(alice).claim(0, aliceAmount, proof, alice.address);

      // Alice should NOT receive referral bonus
      const aliceBalance = await token.balanceOf(alice.address);
      expect(aliceBalance).to.equal(aliceAmount); // Only claim amount
    });
  });

  describe("Vesting", function () {
    let tree, aliceAmount;
    const VESTING_DURATION = 100 * DAY;
    const CLIFF_DURATION = 30 * DAY;

    beforeEach(async function () {
      aliceAmount = ethers.parseEther("10000");

      const recipients = [
        { address: alice.address, amount: aliceAmount }
      ];

      tree = createMerkleTree(recipients);
      const now = await time.latest();

      await airdrop.createRound(
        tree.getHexRoot(),
        aliceAmount,
        now,
        now + 365 * DAY,
        VESTING_DURATION,
        CLIFF_DURATION,
        "Vested Round"
      );
    });

    it("Should not release tokens during cliff", async function () {
      const proof = getProof(tree, alice.address, aliceAmount);

      await airdrop.connect(alice).claim(0, aliceAmount, proof, ethers.ZeroAddress);

      // During cliff, should get 0
      const balance = await token.balanceOf(alice.address);
      expect(balance).to.equal(0n);
    });

    it("Should release tokens after cliff proportionally", async function () {
      const proof = getProof(tree, alice.address, aliceAmount);

      await airdrop.connect(alice).claim(0, aliceAmount, proof, ethers.ZeroAddress);

      // Move past cliff to 50% vesting
      await time.increase(CLIFF_DURATION + VESTING_DURATION / 2);

      await airdrop.connect(alice).claimVested(0);

      const balance = await token.balanceOf(alice.address);
      // Should be approximately 50% + some from cliff period
      expect(balance).to.be.gt(ethers.parseEther("5000"));
    });

    it("Should release all tokens after vesting ends", async function () {
      const proof = getProof(tree, alice.address, aliceAmount);

      await airdrop.connect(alice).claim(0, aliceAmount, proof, ethers.ZeroAddress);

      // Move past full vesting
      await time.increase(VESTING_DURATION + 1);

      await airdrop.connect(alice).claimVested(0);

      const balance = await token.balanceOf(alice.address);
      expect(balance).to.equal(aliceAmount);
    });
  });

  describe("Batch Claims", function () {
    let tree1, tree2;
    const amount1 = ethers.parseEther("500");
    const amount2 = ethers.parseEther("1000");

    beforeEach(async function () {
      const now = await time.latest();

      // Round 1
      tree1 = createMerkleTree([{ address: alice.address, amount: amount1 }]);
      await airdrop.createRound(
        tree1.getHexRoot(),
        amount1,
        now,
        now + 30 * DAY,
        0,
        0,
        "Round 1"
      );

      // Round 2
      tree2 = createMerkleTree([{ address: alice.address, amount: amount2 }]);
      await airdrop.createRound(
        tree2.getHexRoot(),
        amount2,
        now,
        now + 30 * DAY,
        0,
        0,
        "Round 2"
      );
    });

    it("Should allow batch claiming from multiple rounds", async function () {
      const proof1 = getProof(tree1, alice.address, amount1);
      const proof2 = getProof(tree2, alice.address, amount2);

      await airdrop.connect(alice).batchClaim(
        [0, 1],
        [amount1, amount2],
        [proof1, proof2]
      );

      const balance = await token.balanceOf(alice.address);
      expect(balance).to.equal(amount1 + amount2);
    });
  });

  describe("View Functions", function () {
    it("Should check if user can claim", async function () {
      const amount = ethers.parseEther("1000");
      const tree = createMerkleTree([{ address: alice.address, amount }]);
      const now = await time.latest();

      await airdrop.createRound(
        tree.getHexRoot(),
        amount,
        now,
        now + 30 * DAY,
        0,
        0,
        "Test"
      );

      const proof = getProof(tree, alice.address, amount);

      const canClaim = await airdrop.canClaim(0, alice.address, amount, proof);
      expect(canClaim).to.be.true;

      const canClaimBob = await airdrop.canClaim(0, bob.address, amount, proof);
      expect(canClaimBob).to.be.false;
    });

    it("Should return global stats", async function () {
      const amount = ethers.parseEther("1000");
      const tree = createMerkleTree([{ address: alice.address, amount }]);
      const now = await time.latest();

      await airdrop.createRound(
        tree.getHexRoot(),
        amount,
        now,
        now + 30 * DAY,
        0,
        0,
        "Test"
      );

      const proof = getProof(tree, alice.address, amount);
      await airdrop.connect(alice).claim(0, amount, proof, ethers.ZeroAddress);

      const stats = await airdrop.getStats();
      expect(stats.totalRounds).to.equal(1n);
      expect(stats.distributed).to.equal(amount);
      expect(stats.claimed).to.equal(amount);
      expect(stats.claimants).to.equal(1n);
    });

    it("Should return user claim info", async function () {
      const amount = ethers.parseEther("1000");
      const tree = createMerkleTree([{ address: alice.address, amount }]);
      const now = await time.latest();

      await airdrop.createRound(
        tree.getHexRoot(),
        amount,
        now,
        now + 30 * DAY,
        0,
        0,
        "Test"
      );

      const proof = getProof(tree, alice.address, amount);
      await airdrop.connect(alice).claim(0, amount, proof, ethers.ZeroAddress);

      const claim = await airdrop.getUserClaim(0, alice.address);
      expect(claim.totalAmount).to.equal(amount);
      expect(claim.claimedAmount).to.equal(amount);
      expect(claim.initialized).to.be.true;
    });
  });

  describe("Admin Functions", function () {
    it("Should allow updating merkle root before claims", async function () {
      const tree1 = createMerkleTree([{ address: alice.address, amount: ethers.parseEther("1000") }]);
      const tree2 = createMerkleTree([{ address: bob.address, amount: ethers.parseEther("2000") }]);
      const now = await time.latest();

      await airdrop.createRound(
        tree1.getHexRoot(),
        ethers.parseEther("2000"),
        now,
        now + 30 * DAY,
        0,
        0,
        "Test"
      );

      await airdrop.updateMerkleRoot(0, tree2.getHexRoot());

      const round = await airdrop.getRound(0);
      expect(round.merkleRoot).to.equal(tree2.getHexRoot());
    });

    it("Should not allow updating after claims", async function () {
      const amount = ethers.parseEther("1000");
      const tree = createMerkleTree([{ address: alice.address, amount }]);
      const now = await time.latest();

      await airdrop.createRound(
        tree.getHexRoot(),
        amount,
        now,
        now + 30 * DAY,
        0,
        0,
        "Test"
      );

      const proof = getProof(tree, alice.address, amount);
      await airdrop.connect(alice).claim(0, amount, proof, ethers.ZeroAddress);

      await expect(
        airdrop.updateMerkleRoot(0, tree.getHexRoot())
      ).to.be.revertedWith("Already has claims");
    });

    it("Should allow setting referral bonus", async function () {
      await airdrop.setReferralBonus(1000); // 10%
      expect(await airdrop.referralBonus()).to.equal(1000n);
    });

    it("Should pause and unpause", async function () {
      await airdrop.pause();

      const amount = ethers.parseEther("1000");
      const tree = createMerkleTree([{ address: alice.address, amount }]);
      const now = await time.latest();

      await airdrop.createRound(
        tree.getHexRoot(),
        amount,
        now,
        now + 30 * DAY,
        0,
        0,
        "Test"
      );

      const proof = getProof(tree, alice.address, amount);

      await expect(
        airdrop.connect(alice).claim(0, amount, proof, ethers.ZeroAddress)
      ).to.be.reverted;

      await airdrop.unpause();

      await airdrop.connect(alice).claim(0, amount, proof, ethers.ZeroAddress);
    });
  });
});
