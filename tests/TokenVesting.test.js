const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("TokenVesting", function () {
  let tokenVesting;
  let token;
  let owner, beneficiary1, beneficiary2, admin;
  
  const DAY = 86400;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;

  beforeEach(async function () {
    [owner, beneficiary1, beneficiary2, admin] = await ethers.getSigners();

    // Deploy token
    const Token = await ethers.getContractFactory("SynapseToken");
    token = await Token.deploy(
      "SYNAPSE",
      "SYNX",
      ethers.parseEther("1000000000"),
      owner.address,
      owner.address
    );

    // Deploy vesting contract
    const TokenVesting = await ethers.getContractFactory("TokenVesting");
    tokenVesting = await TokenVesting.deploy(await token.getAddress());

    // Approve vesting contract
    await token.approve(await tokenVesting.getAddress(), ethers.MaxUint256);

    // Grant admin role
    const VESTING_ADMIN_ROLE = await tokenVesting.VESTING_ADMIN_ROLE();
    await tokenVesting.grantRole(VESTING_ADMIN_ROLE, admin.address);
  });

  describe("Vesting Schedule Creation", function () {
    it("Should create linear vesting schedule", async function () {
      const tx = await tokenVesting.createVestingSchedule(
        beneficiary1.address,
        0, // TEAM category
        ethers.parseEther("1000000"),
        Math.floor(Date.now() / 1000),
        MONTH, // 1 month cliff
        YEAR, // 1 year vesting
        0, // LINEAR
        true // revocable
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => tokenVesting.interface.parseLog(log)?.name === "VestingScheduleCreated"
      );

      expect(event).to.not.be.undefined;
    });

    it("Should create monthly vesting schedule", async function () {
      await tokenVesting.createVestingSchedule(
        beneficiary1.address,
        1, // INVESTOR category
        ethers.parseEther("500000"),
        Math.floor(Date.now() / 1000),
        0, // No cliff
        YEAR,
        1, // MONTHLY
        true
      );

      expect(await tokenVesting.getScheduleCount()).to.equal(1n);
    });

    it("Should create milestone-based vesting", async function () {
      const milestones = [
        "Product Launch",
        "1000 Active Users",
        "Revenue Target"
      ];
      const percentages = [3000, 3000, 4000]; // 30%, 30%, 40%

      await tokenVesting.createMilestoneVesting(
        beneficiary1.address,
        2, // ADVISOR category
        ethers.parseEther("100000"),
        Math.floor(Date.now() / 1000),
        true,
        milestones,
        percentages
      );

      const schedules = await tokenVesting.getBeneficiarySchedules(beneficiary1.address);
      expect(schedules.length).to.equal(1);
    });

    it("Should reject invalid milestone percentages", async function () {
      await expect(
        tokenVesting.createMilestoneVesting(
          beneficiary1.address,
          2,
          ethers.parseEther("100000"),
          Math.floor(Date.now() / 1000),
          true,
          ["Milestone 1", "Milestone 2"],
          [3000, 3000] // Only 60%, should be 100%
        )
      ).to.be.revertedWith("Percentages must sum to 100%");
    });
  });

  describe("Token Release", function () {
    let scheduleId: string;

    beforeEach(async function () {
      const tx = await tokenVesting.createVestingSchedule(
        beneficiary1.address,
        0,
        ethers.parseEther("1200000"), // 1.2M tokens
        Math.floor(Date.now() / 1000) - 100, // Started slightly in the past
        0, // No cliff
        YEAR, // 1 year vesting
        0, // LINEAR
        true
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => tokenVesting.interface.parseLog(log)?.name === "VestingScheduleCreated"
      );
      scheduleId = tokenVesting.interface.parseLog(event).args.scheduleId;
    });

    it("Should release vested tokens after time passes", async function () {
      // Fast forward 6 months
      await time.increase(6 * MONTH);

      const balanceBefore = await token.balanceOf(beneficiary1.address);

      await tokenVesting.connect(beneficiary1).release(scheduleId);

      const balanceAfter = await token.balanceOf(beneficiary1.address);
      
      // Should receive approximately half (6/12 months)
      expect(balanceAfter - balanceBefore).to.be.closeTo(
        ethers.parseEther("600000"),
        ethers.parseEther("10000")
      );
    });

    it("Should release all tokens after vesting period", async function () {
      // Fast forward past vesting period
      await time.increase(YEAR + DAY);

      await tokenVesting.connect(beneficiary1).release(scheduleId);

      const balance = await token.balanceOf(beneficiary1.address);
      expect(balance).to.equal(ethers.parseEther("1200000"));
    });

    it("Should not release tokens during cliff", async function () {
      // Create schedule with cliff
      const tx2 = await tokenVesting.createVestingSchedule(
        beneficiary2.address,
        0,
        ethers.parseEther("100000"),
        Math.floor(Date.now() / 1000),
        6 * MONTH, // 6 month cliff
        YEAR,
        0,
        true
      );

      const receipt = await tx2.wait();
      const event = receipt.logs.find(
        log => tokenVesting.interface.parseLog(log)?.name === "VestingScheduleCreated"
      );
      const scheduleId2 = tokenVesting.interface.parseLog(event).args.scheduleId;

      // Fast forward 3 months (still in cliff)
      await time.increase(3 * MONTH);

      const releasable = await tokenVesting.getReleasableAmount(scheduleId2);
      expect(releasable).to.equal(0n);
    });
  });

  describe("Milestone Vesting", function () {
    let scheduleId: string;

    beforeEach(async function () {
      const tx = await tokenVesting.createMilestoneVesting(
        beneficiary1.address,
        2,
        ethers.parseEther("100000"),
        Math.floor(Date.now() / 1000),
        true,
        ["Phase 1", "Phase 2", "Phase 3"],
        [2500, 2500, 5000] // 25%, 25%, 50%
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => tokenVesting.interface.parseLog(log)?.name === "VestingScheduleCreated"
      );
      scheduleId = tokenVesting.interface.parseLog(event).args.scheduleId;
    });

    it("Should complete milestone and release tokens", async function () {
      const balanceBefore = await token.balanceOf(beneficiary1.address);

      await tokenVesting.connect(admin).completeMilestone(scheduleId, 0);

      const balanceAfter = await token.balanceOf(beneficiary1.address);
      
      // 25% of 100k = 25k
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("25000"));
    });

    it("Should not allow completing same milestone twice", async function () {
      await tokenVesting.connect(admin).completeMilestone(scheduleId, 0);

      await expect(
        tokenVesting.connect(admin).completeMilestone(scheduleId, 0)
      ).to.be.revertedWith("Already completed");
    });

    it("Should release all tokens after all milestones completed", async function () {
      await tokenVesting.connect(admin).completeMilestone(scheduleId, 0);
      await tokenVesting.connect(admin).completeMilestone(scheduleId, 1);
      await tokenVesting.connect(admin).completeMilestone(scheduleId, 2);

      const balance = await token.balanceOf(beneficiary1.address);
      expect(balance).to.equal(ethers.parseEther("100000"));
    });
  });

  describe("Revocation", function () {
    let scheduleId: string;

    beforeEach(async function () {
      const tx = await tokenVesting.createVestingSchedule(
        beneficiary1.address,
        0,
        ethers.parseEther("1200000"),
        Math.floor(Date.now() / 1000) - 100,
        0,
        YEAR,
        0,
        true // revocable
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => tokenVesting.interface.parseLog(log)?.name === "VestingScheduleCreated"
      );
      scheduleId = tokenVesting.interface.parseLog(event).args.scheduleId;
    });

    it("Should revoke and return unvested tokens", async function () {
      // Fast forward 6 months
      await time.increase(6 * MONTH);

      const adminBalanceBefore = await token.balanceOf(owner.address);

      await tokenVesting.revoke(scheduleId);

      const adminBalanceAfter = await token.balanceOf(owner.address);
      const beneficiaryBalance = await token.balanceOf(beneficiary1.address);

      // Beneficiary should have vested portion (~600k)
      expect(beneficiaryBalance).to.be.closeTo(
        ethers.parseEther("600000"),
        ethers.parseEther("10000")
      );

      // Admin should receive unvested portion (~600k)
      expect(adminBalanceAfter - adminBalanceBefore).to.be.closeTo(
        ethers.parseEther("600000"),
        ethers.parseEther("10000")
      );
    });

    it("Should not revoke non-revocable schedule", async function () {
      // Create non-revocable schedule
      const tx2 = await tokenVesting.createVestingSchedule(
        beneficiary2.address,
        0,
        ethers.parseEther("100000"),
        Math.floor(Date.now() / 1000),
        0,
        YEAR,
        0,
        false // not revocable
      );

      const receipt = await tx2.wait();
      const event = receipt.logs.find(
        log => tokenVesting.interface.parseLog(log)?.name === "VestingScheduleCreated"
      );
      const nonRevocableId = tokenVesting.interface.parseLog(event).args.scheduleId;

      await expect(tokenVesting.revoke(nonRevocableId)).to.be.revertedWith("Not revocable");
    });
  });

  describe("Beneficiary Transfer", function () {
    let scheduleId: string;

    beforeEach(async function () {
      const tx = await tokenVesting.createVestingSchedule(
        beneficiary1.address,
        0,
        ethers.parseEther("100000"),
        Math.floor(Date.now() / 1000),
        0,
        YEAR,
        0,
        true
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => tokenVesting.interface.parseLog(log)?.name === "VestingScheduleCreated"
      );
      scheduleId = tokenVesting.interface.parseLog(event).args.scheduleId;
    });

    it("Should transfer beneficiary rights", async function () {
      await tokenVesting.connect(beneficiary1).transferBeneficiary(
        scheduleId,
        beneficiary2.address
      );

      const schedule = await tokenVesting.getSchedule(scheduleId);
      expect(schedule.beneficiary).to.equal(beneficiary2.address);
    });

    it("Should not allow non-beneficiary to transfer", async function () {
      await expect(
        tokenVesting.connect(beneficiary2).transferBeneficiary(
          scheduleId,
          beneficiary2.address
        )
      ).to.be.revertedWith("Not beneficiary");
    });
  });

  describe("Views", function () {
    it("Should get schedule details", async function () {
      const tx = await tokenVesting.createVestingSchedule(
        beneficiary1.address,
        0,
        ethers.parseEther("100000"),
        Math.floor(Date.now() / 1000),
        MONTH,
        YEAR,
        0,
        true
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => tokenVesting.interface.parseLog(log)?.name === "VestingScheduleCreated"
      );
      const scheduleId = tokenVesting.interface.parseLog(event).args.scheduleId;

      const schedule = await tokenVesting.getSchedule(scheduleId);
      expect(schedule.beneficiary).to.equal(beneficiary1.address);
      expect(schedule.totalAmount).to.equal(ethers.parseEther("100000"));
    });

    it("Should get statistics", async function () {
      await tokenVesting.createVestingSchedule(
        beneficiary1.address,
        0,
        ethers.parseEther("100000"),
        Math.floor(Date.now() / 1000),
        0,
        YEAR,
        0,
        true
      );

      const stats = await tokenVesting.getStatistics();
      expect(stats._totalVested).to.equal(ethers.parseEther("100000"));
      expect(stats.scheduleCount).to.equal(1n);
    });
  });
});
