const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("StakingRewards", function () {
  let stakingRewards;
  let token;
  let owner, staker1, staker2, distributor;
  
  const DAY = 86400;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;
  
  beforeEach(async function () {
    [owner, staker1, staker2, distributor] = await ethers.getSigners();
    
    // Deploy token (same token for staking and rewards)
    const Token = await ethers.getContractFactory("SynapseToken");
    token = await Token.deploy(
      "SYNAPSE",
      "SYNX",
      ethers.parseEther("1000000000"),
      owner.address,
      owner.address
    );
    
    // Deploy staking contract
    const StakingRewards = await ethers.getContractFactory("StakingRewards");
    stakingRewards = await StakingRewards.deploy(
      await token.getAddress(),
      await token.getAddress(), // Same token for rewards
      ethers.parseEther("100"),  // Min stake: 100 SYNX
      ethers.parseEther("1000000"), // Max stake: 1M SYNX
      DAY // 1 day cooldown
    );
    
    // Setup tokens
    await token.transfer(staker1.address, ethers.parseEther("100000"));
    await token.transfer(staker2.address, ethers.parseEther("100000"));
    await token.transfer(distributor.address, ethers.parseEther("1000000"));
    
    // Approve staking
    await token.connect(staker1).approve(
      await stakingRewards.getAddress(),
      ethers.MaxUint256
    );
    await token.connect(staker2).approve(
      await stakingRewards.getAddress(),
      ethers.MaxUint256
    );
    await token.connect(distributor).approve(
      await stakingRewards.getAddress(),
      ethers.MaxUint256
    );
    
    // Grant distributor role
    const REWARDS_DISTRIBUTOR_ROLE = await stakingRewards.REWARDS_DISTRIBUTOR_ROLE();
    await stakingRewards.grantRole(REWARDS_DISTRIBUTOR_ROLE, distributor.address);
  });

  describe("Staking", function () {
    it("Should stake tokens without lock", async function () {
      await stakingRewards.connect(staker1).stake(
        ethers.parseEther("1000"),
        0 // No lock tier
      );
      
      const stake = await stakingRewards.stakes(staker1.address);
      expect(stake.amount).to.equal(ethers.parseEther("1000"));
      expect(stake.shares).to.equal(ethers.parseEther("1000")); // 1x boost
      expect(stake.lockEnd).to.equal(0n);
      expect(stake.boostMultiplier).to.equal(100n);
      
      expect(await stakingRewards.totalStaked()).to.equal(ethers.parseEther("1000"));
      expect(await stakingRewards.totalStakers()).to.equal(1n);
    });
    
    it("Should stake with 30-day lock (1.25x boost)", async function () {
      await stakingRewards.connect(staker1).stake(
        ethers.parseEther("1000"),
        1 // 30-day lock tier
      );
      
      const stake = await stakingRewards.stakes(staker1.address);
      expect(stake.amount).to.equal(ethers.parseEther("1000"));
      expect(stake.shares).to.equal(ethers.parseEther("1250")); // 1.25x boost
      expect(stake.boostMultiplier).to.equal(125n);
      expect(stake.lockEnd).to.be.gt(0n);
    });
    
    it("Should stake with 365-day lock (3x boost)", async function () {
      await stakingRewards.connect(staker1).stake(
        ethers.parseEther("1000"),
        4 // 365-day lock tier
      );
      
      const stake = await stakingRewards.stakes(staker1.address);
      expect(stake.shares).to.equal(ethers.parseEther("3000")); // 3x boost
      expect(stake.boostMultiplier).to.equal(300n);
    });
    
    it("Should reject stake below minimum", async function () {
      await expect(
        stakingRewards.connect(staker1).stake(ethers.parseEther("50"), 0)
      ).to.be.revertedWith("Below minimum stake");
    });
    
    it("Should reject stake above maximum", async function () {
      await token.transfer(staker1.address, ethers.parseEther("2000000"));
      await expect(
        stakingRewards.connect(staker1).stake(ethers.parseEther("1500000"), 0)
      ).to.be.revertedWith("Above maximum stake");
    });
    
    it("Should allow adding to existing stake", async function () {
      await stakingRewards.connect(staker1).stake(ethers.parseEther("1000"), 0);
      await stakingRewards.connect(staker1).stake(ethers.parseEther("500"), 0);
      
      const stake = await stakingRewards.stakes(staker1.address);
      expect(stake.amount).to.equal(ethers.parseEther("1500"));
    });
    
    it("Should not allow reducing lock duration", async function () {
      await stakingRewards.connect(staker1).stake(ethers.parseEther("1000"), 3); // 180-day lock
      
      // Try to stake with shorter lock
      await expect(
        stakingRewards.connect(staker1).stake(ethers.parseEther("500"), 1) // 30-day lock
      ).to.be.revertedWith("Cannot reduce lock duration");
    });
  });

  describe("Unstaking", function () {
    beforeEach(async function () {
      await stakingRewards.connect(staker1).stake(ethers.parseEther("1000"), 0);
    });
    
    it("Should initiate unstake and start cooldown", async function () {
      await stakingRewards.connect(staker1).initiateUnstake(ethers.parseEther("500"));
      
      const stake = await stakingRewards.stakes(staker1.address);
      expect(stake.amount).to.equal(ethers.parseEther("500"));
      
      const cooldownAmount = await stakingRewards.cooldownAmount(staker1.address);
      expect(cooldownAmount).to.equal(ethers.parseEther("500"));
    });
    
    it("Should complete unstake after cooldown", async function () {
      await stakingRewards.connect(staker1).initiateUnstake(ethers.parseEther("1000"));
      
      // Cannot withdraw before cooldown
      await expect(
        stakingRewards.connect(staker1).completeUnstake()
      ).to.be.revertedWith("Cooldown not finished");
      
      // Wait for cooldown
      await time.increase(DAY + 1);
      
      const balanceBefore = await token.balanceOf(staker1.address);
      await stakingRewards.connect(staker1).completeUnstake();
      const balanceAfter = await token.balanceOf(staker1.address);
      
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("1000"));
    });
    
    it("Should apply early withdrawal penalty", async function () {
      // Stake with lock
      await stakingRewards.connect(staker2).stake(ethers.parseEther("1000"), 1); // 30-day lock, 5% penalty
      
      // Unstake immediately (early withdrawal)
      await stakingRewards.connect(staker2).initiateUnstake(ethers.parseEther("1000"));
      
      const cooldownAmount = await stakingRewards.cooldownAmount(staker2.address);
      // 5% penalty = 50 SYNX
      expect(cooldownAmount).to.equal(ethers.parseEther("950"));
    });
    
    it("Should cancel cooldown and restake", async function () {
      await stakingRewards.connect(staker1).initiateUnstake(ethers.parseEther("500"));
      
      await stakingRewards.connect(staker1).cancelCooldown();
      
      const stake = await stakingRewards.stakes(staker1.address);
      expect(stake.amount).to.equal(ethers.parseEther("1000"));
      
      const cooldownAmount = await stakingRewards.cooldownAmount(staker1.address);
      expect(cooldownAmount).to.equal(0n);
    });
  });

  describe("Rewards", function () {
    beforeEach(async function () {
      // Add rewards
      await stakingRewards.connect(distributor).addRewards(
        ethers.parseEther("100000"),
        MONTH
      );
    });
    
    it("Should distribute rewards over time", async function () {
      await stakingRewards.connect(staker1).stake(ethers.parseEther("1000"), 0);
      
      // Fast forward 1 week
      await time.increase(WEEK);
      
      const pending = await stakingRewards.pendingRewards(staker1.address);
      expect(pending).to.be.gt(0n);
      
      // Approximately 1/4 of monthly rewards
      const expectedRewards = ethers.parseEther("100000") * BigInt(WEEK) / BigInt(MONTH);
      expect(pending).to.be.closeTo(expectedRewards, ethers.parseEther("100"));
    });
    
    it("Should claim rewards", async function () {
      await stakingRewards.connect(staker1).stake(ethers.parseEther("1000"), 0);
      
      await time.increase(WEEK);
      
      const pendingBefore = await stakingRewards.pendingRewards(staker1.address);
      const balanceBefore = await token.balanceOf(staker1.address);
      
      await stakingRewards.connect(staker1).claimRewards();
      
      const balanceAfter = await token.balanceOf(staker1.address);
      expect(balanceAfter - balanceBefore).to.be.closeTo(pendingBefore, ethers.parseEther("10"));
      
      const pendingAfter = await stakingRewards.pendingRewards(staker1.address);
      expect(pendingAfter).to.be.lt(ethers.parseEther("1")); // Should be nearly 0
    });
    
    it("Should compound rewards", async function () {
      await stakingRewards.connect(staker1).stake(ethers.parseEther("1000"), 0);
      
      await time.increase(WEEK);
      
      const stakeBefore = await stakingRewards.stakes(staker1.address);
      
      await stakingRewards.connect(staker1).compound();
      
      const stakeAfter = await stakingRewards.stakes(staker1.address);
      expect(stakeAfter.amount).to.be.gt(stakeBefore.amount);
    });
    
    it("Should distribute rewards proportionally", async function () {
      // Staker1 stakes 1000
      await stakingRewards.connect(staker1).stake(ethers.parseEther("1000"), 0);
      
      // Staker2 stakes 3000 (3x more)
      await stakingRewards.connect(staker2).stake(ethers.parseEther("3000"), 0);
      
      await time.increase(WEEK);
      
      const pending1 = await stakingRewards.pendingRewards(staker1.address);
      const pending2 = await stakingRewards.pendingRewards(staker2.address);
      
      // Staker2 should have ~3x more rewards
      expect(pending2).to.be.closeTo(pending1 * 3n, ethers.parseEther("100"));
    });
    
    it("Should give more rewards to boosted stakers", async function () {
      // Staker1 stakes 1000 with no lock (1x boost)
      await stakingRewards.connect(staker1).stake(ethers.parseEther("1000"), 0);
      
      // Staker2 stakes 1000 with 365-day lock (3x boost)
      await stakingRewards.connect(staker2).stake(ethers.parseEther("1000"), 4);
      
      await time.increase(WEEK);
      
      const pending1 = await stakingRewards.pendingRewards(staker1.address);
      const pending2 = await stakingRewards.pendingRewards(staker2.address);
      
      // Staker2 should have ~3x more rewards due to boost
      expect(pending2).to.be.closeTo(pending1 * 3n, ethers.parseEther("100"));
    });
  });

  describe("Epochs", function () {
    it("Should start new epoch", async function () {
      await stakingRewards.connect(distributor).startEpoch(
        ethers.parseEther("50000"),
        WEEK
      );
      
      const epoch = await stakingRewards.getCurrentEpoch();
      expect(epoch.totalRewards).to.equal(ethers.parseEther("50000"));
    });
    
    it("Should track multiple epochs", async function () {
      await stakingRewards.connect(distributor).startEpoch(
        ethers.parseEther("50000"),
        WEEK
      );
      
      await time.increase(WEEK + 1);
      
      await stakingRewards.connect(distributor).startEpoch(
        ethers.parseEther("60000"),
        WEEK
      );
      
      expect(await stakingRewards.currentEpoch()).to.equal(1n);
    });
  });

  describe("Views", function () {
    beforeEach(async function () {
      await stakingRewards.connect(distributor).addRewards(
        ethers.parseEther("100000"),
        YEAR
      );
      await stakingRewards.connect(staker1).stake(ethers.parseEther("10000"), 2);
    });
    
    it("Should get stake info", async function () {
      const info = await stakingRewards.getStakeInfo(staker1.address);
      
      expect(info.amount).to.equal(ethers.parseEther("10000"));
      expect(info.boostMultiplier).to.equal(150n); // 90-day lock
      expect(info.lockEnd).to.be.gt(0n);
    });
    
    it("Should calculate APR", async function () {
      const apr = await stakingRewards.getAPR();
      // With 100k rewards over year and 10k staked
      // APR should be around 1000% (100000/10000 * 100 = 1000%)
      // But with 1.5x boost shares, it's different
      expect(apr).to.be.gt(0n);
    });
    
    it("Should get lock tiers", async function () {
      const tiers = await stakingRewards.getLockTiers();
      expect(tiers.length).to.equal(5); // Default 5 tiers
    });
  });

  describe("Admin Functions", function () {
    it("Should update staking limits", async function () {
      await stakingRewards.connect(owner).setStakingLimits(
        ethers.parseEther("50"),
        ethers.parseEther("500000")
      );
      
      expect(await stakingRewards.minStake()).to.equal(ethers.parseEther("50"));
      expect(await stakingRewards.maxStake()).to.equal(ethers.parseEther("500000"));
    });
    
    it("Should update cooldown period", async function () {
      await stakingRewards.connect(owner).setCooldownPeriod(WEEK);
      expect(await stakingRewards.cooldownPeriod()).to.equal(BigInt(WEEK));
    });
    
    it("Should add new lock tier", async function () {
      const OPERATOR_ROLE = await stakingRewards.OPERATOR_ROLE();
      await stakingRewards.grantRole(OPERATOR_ROLE, owner.address);
      
      await stakingRewards.connect(owner).addLockTier(
        5, // tier ID
        60 * DAY, // 60 days
        175, // 1.75x boost
        1200 // 12% penalty
      );
      
      const tier = await stakingRewards.lockTiers(5);
      expect(tier.duration).to.equal(BigInt(60 * DAY));
      expect(tier.boostMultiplier).to.equal(175n);
    });
    
    it("Should pause and unpause", async function () {
      const OPERATOR_ROLE = await stakingRewards.OPERATOR_ROLE();
      await stakingRewards.grantRole(OPERATOR_ROLE, owner.address);
      
      await stakingRewards.connect(owner).pause();
      
      await expect(
        stakingRewards.connect(staker1).stake(ethers.parseEther("1000"), 0)
      ).to.be.revertedWithCustomError(stakingRewards, "EnforcedPause");
      
      await stakingRewards.connect(owner).unpause();
      
      await stakingRewards.connect(staker1).stake(ethers.parseEther("1000"), 0);
    });
  });
});
