const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SubscriptionManager", function () {
  let subscriptionManager;
  let token;
  let owner, provider, subscriber, operator;
  
  const HOUR = 3600;
  const DAY = 86400;
  const MONTH = 30 * DAY;
  
  beforeEach(async function () {
    [owner, provider, subscriber, operator] = await ethers.getSigners();
    
    // Deploy token
    const Token = await ethers.getContractFactory("SynapseToken");
    token = await Token.deploy(
      "SYNAPSE",
      "SYNX",
      ethers.parseEther("1000000000"),
      owner.address,
      owner.address
    );
    
    // Deploy subscription manager
    const SubscriptionManager = await ethers.getContractFactory("SubscriptionManager");
    subscriptionManager = await SubscriptionManager.deploy(
      await token.getAddress(),
      owner.address, // treasury
      250 // 2.5% platform fee
    );
    
    // Setup tokens
    await token.transfer(provider.address, ethers.parseEther("100000"));
    await token.transfer(subscriber.address, ethers.parseEther("100000"));
    
    // Approve spending
    await token.connect(provider).approve(
      await subscriptionManager.getAddress(),
      ethers.MaxUint256
    );
    await token.connect(subscriber).approve(
      await subscriptionManager.getAddress(),
      ethers.MaxUint256
    );
  });

  describe("Plan Management", function () {
    it("Should create a plan", async function () {
      const tx = await subscriptionManager.connect(provider).createPlan(
        "Basic Plan",
        "Basic AI access",
        ethers.parseEther("10"), // 10 SYNX per month
        MONTH,
        0, // no trial
        1000, // 1000 units limit
        ethers.parseEther("0.01") // overage rate
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "PlanCreated"
      );
      
      expect(event).to.not.be.undefined;
      
      const planId = subscriptionManager.interface.parseLog(event).args.planId;
      const plan = await subscriptionManager.plans(planId);
      
      expect(plan.name).to.equal("Basic Plan");
      expect(plan.basePrice).to.equal(ethers.parseEther("10"));
      expect(plan.active).to.be.true;
    });
    
    it("Should reject plan with invalid parameters", async function () {
      await expect(
        subscriptionManager.connect(provider).createPlan(
          "", // empty name
          "Description",
          ethers.parseEther("10"),
          MONTH,
          0,
          0,
          0
        )
      ).to.be.revertedWith("Name required");
      
      await expect(
        subscriptionManager.connect(provider).createPlan(
          "Plan",
          "Description",
          0, // zero price
          MONTH,
          0,
          0,
          0
        )
      ).to.be.revertedWith("Price must be > 0");
      
      await expect(
        subscriptionManager.connect(provider).createPlan(
          "Plan",
          "Description",
          ethers.parseEther("10"),
          60, // too short
          0,
          0,
          0
        )
      ).to.be.revertedWith("Period too short");
    });
    
    it("Should update plan", async function () {
      const tx = await subscriptionManager.connect(provider).createPlan(
        "Basic Plan",
        "Description",
        ethers.parseEther("10"),
        MONTH,
        0,
        1000,
        ethers.parseEther("0.01")
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "PlanCreated"
      );
      const planId = subscriptionManager.interface.parseLog(event).args.planId;
      
      await subscriptionManager.connect(provider).updatePlan(
        planId,
        "New description",
        2000,
        ethers.parseEther("0.02")
      );
      
      const plan = await subscriptionManager.plans(planId);
      expect(plan.description).to.equal("New description");
      expect(plan.usageLimit).to.equal(2000n);
    });
    
    it("Should deactivate and activate plan", async function () {
      const tx = await subscriptionManager.connect(provider).createPlan(
        "Basic Plan",
        "Description",
        ethers.parseEther("10"),
        MONTH,
        0,
        0,
        0
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "PlanCreated"
      );
      const planId = subscriptionManager.interface.parseLog(event).args.planId;
      
      await subscriptionManager.connect(provider).deactivatePlan(planId);
      let plan = await subscriptionManager.plans(planId);
      expect(plan.active).to.be.false;
      
      await subscriptionManager.connect(provider).activatePlan(planId);
      plan = await subscriptionManager.plans(planId);
      expect(plan.active).to.be.true;
    });
  });

  describe("Subscriptions", function () {
    let planId;
    
    beforeEach(async function () {
      const tx = await subscriptionManager.connect(provider).createPlan(
        "Premium Plan",
        "Full AI access",
        ethers.parseEther("100"),
        MONTH,
        0,
        10000,
        ethers.parseEther("0.01")
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "PlanCreated"
      );
      planId = subscriptionManager.interface.parseLog(event).args.planId;
    });
    
    it("Should subscribe to a plan", async function () {
      const balanceBefore = await token.balanceOf(subscriber.address);
      
      const tx = await subscriptionManager.connect(subscriber).subscribe(
        planId,
        1 // 1 period prepaid
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "Subscribed"
      );
      
      expect(event).to.not.be.undefined;
      
      const subscriptionId = subscriptionManager.interface.parseLog(event).args.subscriptionId;
      const subscription = await subscriptionManager.subscriptions(subscriptionId);
      
      expect(subscription.subscriber).to.equal(subscriber.address);
      expect(subscription.active).to.be.true;
      
      const balanceAfter = await token.balanceOf(subscriber.address);
      expect(balanceBefore - balanceAfter).to.equal(ethers.parseEther("100"));
    });
    
    it("Should handle trial period", async function () {
      // Create plan with trial
      const trialPlanTx = await subscriptionManager.connect(provider).createPlan(
        "Trial Plan",
        "Free trial",
        ethers.parseEther("50"),
        MONTH,
        7 * DAY, // 7 day trial
        5000,
        ethers.parseEther("0.01")
      );
      
      const trialReceipt = await trialPlanTx.wait();
      const trialEvent = trialReceipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "PlanCreated"
      );
      const trialPlanId = subscriptionManager.interface.parseLog(trialEvent).args.planId;
      
      const balanceBefore = await token.balanceOf(subscriber.address);
      
      // Subscribe with 1 period (should not charge during trial)
      const tx = await subscriptionManager.connect(subscriber).subscribe(
        trialPlanId,
        1
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "Subscribed"
      );
      const subscriptionId = subscriptionManager.interface.parseLog(event).args.subscriptionId;
      
      const subscription = await subscriptionManager.subscriptions(subscriptionId);
      expect(subscription.inTrial).to.be.true;
      
      const balanceAfter = await token.balanceOf(subscriber.address);
      expect(balanceBefore).to.equal(balanceAfter); // No charge during trial
    });
    
    it("Should prepay multiple periods", async function () {
      const balanceBefore = await token.balanceOf(subscriber.address);
      
      await subscriptionManager.connect(subscriber).subscribe(
        planId,
        3 // 3 periods prepaid
      );
      
      const balanceAfter = await token.balanceOf(subscriber.address);
      expect(balanceBefore - balanceAfter).to.equal(ethers.parseEther("300"));
    });
    
    it("Should add balance to subscription", async function () {
      const tx = await subscriptionManager.connect(subscriber).subscribe(planId, 1);
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "Subscribed"
      );
      const subscriptionId = subscriptionManager.interface.parseLog(event).args.subscriptionId;
      
      await subscriptionManager.connect(subscriber).addBalance(
        subscriptionId,
        ethers.parseEther("200")
      );
      
      const subscription = await subscriptionManager.subscriptions(subscriptionId);
      expect(subscription.balance).to.equal(ethers.parseEther("200"));
    });
    
    it("Should renew subscription", async function () {
      const tx = await subscriptionManager.connect(subscriber).subscribe(planId, 2);
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "Subscribed"
      );
      const subscriptionId = subscriptionManager.interface.parseLog(event).args.subscriptionId;
      
      // Fast forward to end of period
      await time.increase(MONTH + 1);
      
      await subscriptionManager.connect(subscriber).renewSubscription(subscriptionId);
      
      const subscription = await subscriptionManager.subscriptions(subscriptionId);
      expect(subscription.active).to.be.true;
    });
    
    it("Should cancel subscription", async function () {
      const tx = await subscriptionManager.connect(subscriber).subscribe(planId, 1);
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "Subscribed"
      );
      const subscriptionId = subscriptionManager.interface.parseLog(event).args.subscriptionId;
      
      await subscriptionManager.connect(subscriber).cancelSubscription(subscriptionId);
      
      const subscription = await subscriptionManager.subscriptions(subscriptionId);
      expect(subscription.cancelledAt).to.be.gt(0n);
    });
  });

  describe("Usage Tracking", function () {
    let planId, subscriptionId;
    
    beforeEach(async function () {
      const planTx = await subscriptionManager.connect(provider).createPlan(
        "Usage Plan",
        "Pay per use",
        ethers.parseEther("10"),
        MONTH,
        0,
        100, // 100 units limit
        ethers.parseEther("0.1") // 0.1 SYNX per unit overage
      );
      
      const planReceipt = await planTx.wait();
      const planEvent = planReceipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "PlanCreated"
      );
      planId = subscriptionManager.interface.parseLog(planEvent).args.planId;
      
      const subTx = await subscriptionManager.connect(subscriber).subscribe(planId, 2);
      const subReceipt = await subTx.wait();
      const subEvent = subReceipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "Subscribed"
      );
      subscriptionId = subscriptionManager.interface.parseLog(subEvent).args.subscriptionId;
    });
    
    it("Should record usage", async function () {
      const referenceId = ethers.keccak256(ethers.toUtf8Bytes("request-001"));
      
      await subscriptionManager.connect(provider).recordUsage(
        subscriptionId,
        50,
        referenceId
      );
      
      const subscription = await subscriptionManager.subscriptions(subscriptionId);
      expect(subscription.usageThisPeriod).to.equal(50n);
    });
    
    it("Should calculate overage", async function () {
      // Record usage over limit
      await subscriptionManager.connect(provider).recordUsage(
        subscriptionId,
        150, // 50 units over limit
        ethers.keccak256(ethers.toUtf8Bytes("request-001"))
      );
      
      const overage = await subscriptionManager.calculateOverage(subscriptionId);
      expect(overage).to.equal(ethers.parseEther("5")); // 50 * 0.1 = 5 SYNX
    });
    
    it("Should batch record usage", async function () {
      const referenceIds = [
        ethers.keccak256(ethers.toUtf8Bytes("req-1")),
        ethers.keccak256(ethers.toUtf8Bytes("req-2")),
        ethers.keccak256(ethers.toUtf8Bytes("req-3"))
      ];
      
      await subscriptionManager.connect(provider).batchRecordUsage(
        [subscriptionId, subscriptionId, subscriptionId],
        [10, 20, 30],
        referenceIds
      );
      
      const subscription = await subscriptionManager.subscriptions(subscriptionId);
      expect(subscription.usageThisPeriod).to.equal(60n);
    });
  });

  describe("Platform Fees", function () {
    it("Should collect platform fees", async function () {
      const tx = await subscriptionManager.connect(provider).createPlan(
        "Fee Plan",
        "Test fees",
        ethers.parseEther("100"),
        MONTH,
        0,
        0,
        0
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "PlanCreated"
      );
      const planId = subscriptionManager.interface.parseLog(event).args.planId;
      
      const treasuryBefore = await token.balanceOf(owner.address);
      const providerBefore = await token.balanceOf(provider.address);
      
      await subscriptionManager.connect(subscriber).subscribe(planId, 1);
      
      const treasuryAfter = await token.balanceOf(owner.address);
      const providerAfter = await token.balanceOf(provider.address);
      
      // 2.5% fee = 2.5 SYNX
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("2.5"));
      // Provider gets 97.5 SYNX
      expect(providerAfter - providerBefore).to.equal(ethers.parseEther("97.5"));
    });
    
    it("Should update platform fee", async function () {
      await subscriptionManager.connect(owner).setPlatformFee(500); // 5%
      expect(await subscriptionManager.platformFeeBps()).to.equal(500n);
    });
    
    it("Should reject fee above maximum", async function () {
      await expect(
        subscriptionManager.connect(owner).setPlatformFee(1500) // 15%
      ).to.be.revertedWith("Fee too high");
    });
  });

  describe("Views", function () {
    let planId, subscriptionId;
    
    beforeEach(async function () {
      const planTx = await subscriptionManager.connect(provider).createPlan(
        "View Plan",
        "Test views",
        ethers.parseEther("50"),
        MONTH,
        0,
        1000,
        ethers.parseEther("0.05")
      );
      
      const planReceipt = await planTx.wait();
      const planEvent = planReceipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "PlanCreated"
      );
      planId = subscriptionManager.interface.parseLog(planEvent).args.planId;
      
      const subTx = await subscriptionManager.connect(subscriber).subscribe(planId, 1);
      const subReceipt = await subTx.wait();
      const subEvent = subReceipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "Subscribed"
      );
      subscriptionId = subscriptionManager.interface.parseLog(subEvent).args.subscriptionId;
    });
    
    it("Should get subscription status", async function () {
      const status = await subscriptionManager.getSubscriptionStatus(subscriptionId);
      
      expect(status.active).to.be.true;
      expect(status.inTrial).to.be.false;
      expect(status.cancelled).to.be.false;
      expect(status.expired).to.be.false;
      expect(status.daysRemaining).to.be.gt(0n);
      expect(status.usageRemaining).to.equal(1000n);
    });
    
    it("Should get provider plans", async function () {
      const plans = await subscriptionManager.getProviderPlans(provider.address);
      expect(plans.length).to.equal(1);
      expect(plans[0]).to.equal(planId);
    });
    
    it("Should get subscriber subscriptions", async function () {
      const subs = await subscriptionManager.getSubscriberSubscriptions(subscriber.address);
      expect(subs.length).to.equal(1);
      expect(subs[0]).to.equal(subscriptionId);
    });
  });
});
