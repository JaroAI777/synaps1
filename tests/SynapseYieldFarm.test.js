const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SynapseYieldFarm", function () {
  let yieldFarm, synxToken, lpToken1, lpToken2, stakingContract;
  let owner, alice, bob, charlie;
  
  const INITIAL_SUPPLY = ethers.parseEther("1000000000");
  const REWARD_PER_SECOND = ethers.parseEther("1"); // 1 SYNX per second
  const DAY = 86400;

  beforeEach(async function () {
    [owner, alice, bob, charlie] = await ethers.getSigners();

    // Deploy SYNX token (reward token)
    const Token = await ethers.getContractFactory("SynapseToken");
    synxToken = await Token.deploy("SYNAPSE", "SYNX", INITIAL_SUPPLY, owner.address, owner.address);

    // Deploy mock LP tokens
    lpToken1 = await Token.deploy("LP Token 1", "LP1", INITIAL_SUPPLY, owner.address, owner.address);
    lpToken2 = await Token.deploy("LP Token 2", "LP2", INITIAL_SUPPLY, owner.address, owner.address);

    // Deploy mock staking contract (for boost calculation)
    stakingContract = await Token.deploy("Staking", "sSYNX", INITIAL_SUPPLY, owner.address, owner.address);

    // Deploy yield farm
    const startTime = (await time.latest()) + 100;
    const YieldFarm = await ethers.getContractFactory("SynapseYieldFarm");
    yieldFarm = await YieldFarm.deploy(
      await synxToken.getAddress(),
      await stakingContract.getAddress(),
      REWARD_PER_SECOND,
      startTime
    );

    // Fund yield farm with rewards
    await synxToken.transfer(await yieldFarm.getAddress(), ethers.parseEther("1000000"));

    // Add LP pools
    await yieldFarm.addPool(
      await lpToken1.getAddress(),
      1000, // 1000 alloc points
      100,  // 1% deposit fee
      100,  // 1% withdrawal fee
      false
    );

    await yieldFarm.addPool(
      await lpToken2.getAddress(),
      500,  // 500 alloc points (lower rewards)
      0,    // No deposit fee
      0,    // No withdrawal fee
      false
    );

    // Distribute LP tokens to users
    await lpToken1.transfer(alice.address, ethers.parseEther("10000"));
    await lpToken1.transfer(bob.address, ethers.parseEther("10000"));
    await lpToken2.transfer(alice.address, ethers.parseEther("10000"));
    await lpToken2.transfer(charlie.address, ethers.parseEther("10000"));

    // Give staking tokens (for boost)
    await stakingContract.transfer(alice.address, ethers.parseEther("50000"));
    await stakingContract.transfer(bob.address, ethers.parseEther("5000"));

    // Approvals
    const maxApproval = ethers.MaxUint256;
    await lpToken1.connect(alice).approve(await yieldFarm.getAddress(), maxApproval);
    await lpToken1.connect(bob).approve(await yieldFarm.getAddress(), maxApproval);
    await lpToken2.connect(alice).approve(await yieldFarm.getAddress(), maxApproval);
    await lpToken2.connect(charlie).approve(await yieldFarm.getAddress(), maxApproval);

    // Fast forward to start time
    await time.increaseTo(startTime + 1);
  });

  describe("Pool Management", function () {
    it("Should add pools correctly", async function () {
      expect(await yieldFarm.poolLength()).to.equal(2n);
      
      const pool0 = await yieldFarm.poolInfo(0);
      expect(pool0.allocPoint).to.equal(1000n);
      expect(pool0.depositFee).to.equal(100n);
    });

    it("Should update pool allocation", async function () {
      await yieldFarm.setPool(0, 2000, 50, 50, false);
      
      const pool = await yieldFarm.poolInfo(0);
      expect(pool.allocPoint).to.equal(2000n);
      expect(pool.depositFee).to.equal(50n);
    });

    it("Should reject adding pool with high fees", async function () {
      await expect(
        yieldFarm.addPool(await lpToken1.getAddress(), 100, 600, 0, false)
      ).to.be.revertedWith("Deposit fee too high");
    });
  });

  describe("Deposits", function () {
    it("Should deposit LP tokens", async function () {
      const amount = ethers.parseEther("1000");
      
      await yieldFarm.connect(alice).deposit(0, amount);

      const userInfo = await yieldFarm.userInfo(0, alice.address);
      // 1% fee deducted
      expect(userInfo.amount).to.equal(ethers.parseEther("990"));
    });

    it("Should deposit without fee in no-fee pool", async function () {
      const amount = ethers.parseEther("1000");
      
      await yieldFarm.connect(alice).deposit(1, amount);

      const userInfo = await yieldFarm.userInfo(1, alice.address);
      expect(userInfo.amount).to.equal(amount);
    });

    it("Should update pool total staked", async function () {
      await yieldFarm.connect(alice).deposit(0, ethers.parseEther("1000"));
      await yieldFarm.connect(bob).deposit(0, ethers.parseEther("500"));

      const pool = await yieldFarm.poolInfo(0);
      // 990 + 495 = 1485 (after 1% fees)
      expect(pool.totalStaked).to.equal(ethers.parseEther("1485"));
    });

    it("Should reject zero deposit", async function () {
      await expect(
        yieldFarm.connect(alice).deposit(0, 0)
      ).to.be.revertedWith("Amount must be > 0");
    });
  });

  describe("Withdrawals", function () {
    beforeEach(async function () {
      await yieldFarm.connect(alice).deposit(0, ethers.parseEther("1000"));
    });

    it("Should withdraw LP tokens", async function () {
      const balanceBefore = await lpToken1.balanceOf(alice.address);
      
      await yieldFarm.connect(alice).withdraw(0, ethers.parseEther("500"));

      const balanceAfter = await lpToken1.balanceOf(alice.address);
      // Early withdrawal fee applies (within 72 hours)
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should withdraw without early fee after 72 hours", async function () {
      await time.increase(73 * 3600); // 73 hours

      const userInfo = await yieldFarm.userInfo(0, alice.address);
      const balanceBefore = await lpToken1.balanceOf(alice.address);
      
      await yieldFarm.connect(alice).withdraw(0, userInfo.amount);

      const balanceAfter = await lpToken1.balanceOf(alice.address);
      expect(balanceAfter - balanceBefore).to.equal(userInfo.amount);
    });

    it("Should reject withdrawal exceeding balance", async function () {
      await expect(
        yieldFarm.connect(alice).withdraw(0, ethers.parseEther("2000"))
      ).to.be.revertedWith("Insufficient balance");
    });
  });

  describe("Rewards", function () {
    beforeEach(async function () {
      await yieldFarm.connect(alice).deposit(0, ethers.parseEther("1000"));
    });

    it("Should accumulate rewards over time", async function () {
      // Fast forward 1 day
      await time.increase(DAY);

      const pending = await yieldFarm.pendingReward(0, alice.address);
      
      // ~86400 seconds * 1 SYNX/sec * (1000/1500 allocation)
      // Pool 0 has 1000 alloc points out of 1500 total
      expect(pending).to.be.gt(ethers.parseEther("50000"));
    });

    it("Should harvest rewards", async function () {
      await time.increase(DAY);

      const balanceBefore = await synxToken.balanceOf(alice.address);
      
      await yieldFarm.connect(alice).harvest(0);

      const balanceAfter = await synxToken.balanceOf(alice.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should harvest all pools", async function () {
      await yieldFarm.connect(alice).deposit(1, ethers.parseEther("1000"));
      await time.increase(DAY);

      const balanceBefore = await synxToken.balanceOf(alice.address);
      
      await yieldFarm.connect(alice).harvestAll();

      const balanceAfter = await synxToken.balanceOf(alice.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should distribute rewards proportionally", async function () {
      // Bob deposits same amount
      await yieldFarm.connect(bob).deposit(0, ethers.parseEther("1000"));

      await time.increase(DAY);

      const alicePending = await yieldFarm.pendingReward(0, alice.address);
      const bobPending = await yieldFarm.pendingReward(0, bob.address);

      // Alice should have more (deposited first, same amount)
      expect(alicePending).to.be.gt(bobPending);
    });
  });

  describe("Boost System", function () {
    beforeEach(async function () {
      await yieldFarm.connect(alice).deposit(0, ethers.parseEther("1000"));
      await yieldFarm.connect(bob).deposit(0, ethers.parseEther("1000"));
    });

    it("Should calculate boost tier correctly", async function () {
      // Alice has 50,000 staking tokens = Tier 4 (2x boost)
      const [aliceTier, aliceMultiplier] = await yieldFarm.getUserBoostTier(alice.address);
      expect(aliceTier).to.equal(4n);
      expect(aliceMultiplier).to.equal(20000n); // 2x

      // Bob has 5,000 staking tokens = Tier 2 (1.25x boost)
      const [bobTier, bobMultiplier] = await yieldFarm.getUserBoostTier(bob.address);
      expect(bobTier).to.equal(2n);
      expect(bobMultiplier).to.equal(12500n); // 1.25x
    });

    it("Should apply boost to rewards", async function () {
      // Update boosts
      await yieldFarm.connect(alice).updateBoost(0);
      await yieldFarm.connect(bob).updateBoost(0);

      await time.increase(DAY);

      const alicePending = await yieldFarm.pendingReward(0, alice.address);
      const bobPending = await yieldFarm.pendingReward(0, bob.address);

      // Alice should have ~1.6x Bob's rewards (2x vs 1.25x boost)
      const ratio = Number(alicePending) / Number(bobPending);
      expect(ratio).to.be.closeTo(1.6, 0.2);
    });
  });

  describe("Total Pending", function () {
    it("Should calculate total pending across pools", async function () {
      await yieldFarm.connect(alice).deposit(0, ethers.parseEther("1000"));
      await yieldFarm.connect(alice).deposit(1, ethers.parseEther("1000"));

      await time.increase(DAY);

      const total = await yieldFarm.totalPendingReward(alice.address);
      const pool0 = await yieldFarm.pendingReward(0, alice.address);
      const pool1 = await yieldFarm.pendingReward(1, alice.address);

      expect(total).to.equal(pool0 + pool1);
    });
  });

  describe("APR Calculation", function () {
    it("Should calculate pool APR", async function () {
      await yieldFarm.connect(alice).deposit(0, ethers.parseEther("1000"));

      const apr = await yieldFarm.getPoolAPR(0);
      
      // Should be very high with our test parameters
      expect(apr).to.be.gt(0n);
    });

    it("Should return 0 APR for empty pool", async function () {
      const apr = await yieldFarm.getPoolAPR(0);
      expect(apr).to.equal(0n);
    });
  });

  describe("Emergency Withdraw", function () {
    it("Should not allow emergency withdraw when disabled", async function () {
      await yieldFarm.connect(alice).deposit(0, ethers.parseEther("1000"));

      await expect(
        yieldFarm.connect(alice).emergencyWithdraw(0)
      ).to.be.revertedWith("Emergency withdraw disabled");
    });

    it("Should allow emergency withdraw when enabled", async function () {
      await yieldFarm.connect(alice).deposit(0, ethers.parseEther("1000"));
      await yieldFarm.setEmergencyWithdraw(true);

      const balanceBefore = await lpToken1.balanceOf(alice.address);
      
      await yieldFarm.connect(alice).emergencyWithdraw(0);

      const balanceAfter = await lpToken1.balanceOf(alice.address);
      expect(balanceAfter).to.be.gt(balanceBefore);

      // Should forfeit rewards
      const userInfo = await yieldFarm.userInfo(0, alice.address);
      expect(userInfo.amount).to.equal(0n);
    });
  });

  describe("Admin Functions", function () {
    it("Should update reward per second", async function () {
      const newRate = ethers.parseEther("2");
      
      await yieldFarm.setRewardPerSecond(newRate);

      expect(await yieldFarm.rewardPerSecond()).to.equal(newRate);
    });

    it("Should set pool active status", async function () {
      await yieldFarm.setPoolActive(0, false);

      const pool = await yieldFarm.poolInfo(0);
      expect(pool.isActive).to.be.false;
    });

    it("Should add boost tier", async function () {
      await yieldFarm.addBoostTier(
        ethers.parseEther("200000"),
        30000 // 3x boost
      );

      // Check new tier
      const tier = await yieldFarm.boostTiers(6);
      expect(tier.minStake).to.equal(ethers.parseEther("200000"));
      expect(tier.multiplier).to.equal(30000n);
    });

    it("Should update boost tier", async function () {
      await yieldFarm.updateBoostTier(
        1,
        ethers.parseEther("2000"),
        12000 // 1.2x
      );

      const tier = await yieldFarm.boostTiers(1);
      expect(tier.minStake).to.equal(ethers.parseEther("2000"));
      expect(tier.multiplier).to.equal(12000n);
    });

    it("Should set end time", async function () {
      const newEndTime = (await time.latest()) + 365 * DAY;
      
      await yieldFarm.setEndTime(newEndTime);

      expect(await yieldFarm.endTime()).to.equal(newEndTime);
    });

    it("Should pause and unpause", async function () {
      await yieldFarm.pause();

      await expect(
        yieldFarm.connect(alice).deposit(0, ethers.parseEther("100"))
      ).to.be.reverted;

      await yieldFarm.unpause();

      await yieldFarm.connect(alice).deposit(0, ethers.parseEther("100"));
    });
  });

  describe("Fee Collection", function () {
    it("Should collect deposit fees", async function () {
      const feeCollector = await yieldFarm.feeCollector();
      const balanceBefore = await lpToken1.balanceOf(feeCollector);

      await yieldFarm.connect(alice).deposit(0, ethers.parseEther("1000"));

      const balanceAfter = await lpToken1.balanceOf(feeCollector);
      // 1% of 1000 = 10 LP tokens
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("10"));
    });

    it("Should set new fee collector", async function () {
      await yieldFarm.setFeeCollector(bob.address);
      expect(await yieldFarm.feeCollector()).to.equal(bob.address);
    });
  });

  describe("Mass Update Pools", function () {
    it("Should update all pools", async function () {
      await yieldFarm.connect(alice).deposit(0, ethers.parseEther("1000"));
      await yieldFarm.connect(alice).deposit(1, ethers.parseEther("1000"));

      await time.increase(DAY);

      // Mass update should not revert
      await yieldFarm.massUpdatePools();

      // Rewards should still be calculated correctly
      const pending0 = await yieldFarm.pendingReward(0, alice.address);
      const pending1 = await yieldFarm.pendingReward(1, alice.address);

      expect(pending0).to.be.gt(0n);
      expect(pending1).to.be.gt(0n);
    });
  });
});
