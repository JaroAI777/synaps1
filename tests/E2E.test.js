/**
 * SYNAPSE Protocol - End-to-End Test Suite
 * 
 * Comprehensive E2E tests for full protocol workflows
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SYNAPSE Protocol E2E Tests", function () {
  // Contracts
  let token, router, reputation, serviceRegistry, channel, staking, subscriptions;
  
  // Accounts
  let deployer, alice, bob, charlie, serviceProvider, arbiter;
  
  // Constants
  const HOUR = 3600;
  const DAY = 86400;
  const INITIAL_SUPPLY = ethers.parseEther("1000000000");

  before(async function () {
    [deployer, alice, bob, charlie, serviceProvider, arbiter] = await ethers.getSigners();
  });

  // ============================================
  // Setup
  // ============================================
  
  describe("Protocol Deployment", function () {
    it("Should deploy all contracts", async function () {
      // Deploy Token
      const Token = await ethers.getContractFactory("SynapseToken");
      token = await Token.deploy("SYNAPSE", "SYNX", INITIAL_SUPPLY, deployer.address, deployer.address);
      expect(await token.getAddress()).to.not.be.undefined;

      // Deploy PaymentRouter
      const Router = await ethers.getContractFactory("PaymentRouter");
      router = await Router.deploy(await token.getAddress(), deployer.address);
      expect(await router.getAddress()).to.not.be.undefined;

      // Deploy ReputationRegistry
      const Reputation = await ethers.getContractFactory("ReputationRegistry");
      reputation = await Reputation.deploy(await token.getAddress());
      expect(await reputation.getAddress()).to.not.be.undefined;

      // Deploy ServiceRegistry
      const ServiceRegistry = await ethers.getContractFactory("ServiceRegistry");
      serviceRegistry = await ServiceRegistry.deploy(await reputation.getAddress());
      expect(await serviceRegistry.getAddress()).to.not.be.undefined;

      // Deploy PaymentChannel
      const Channel = await ethers.getContractFactory("PaymentChannel");
      channel = await Channel.deploy(await token.getAddress());
      expect(await channel.getAddress()).to.not.be.undefined;

      // Deploy StakingRewards
      const Staking = await ethers.getContractFactory("StakingRewards");
      staking = await Staking.deploy(await token.getAddress());
      expect(await staking.getAddress()).to.not.be.undefined;

      // Deploy SubscriptionManager
      const Subscriptions = await ethers.getContractFactory("SubscriptionManager");
      subscriptions = await Subscriptions.deploy(await token.getAddress());
      expect(await subscriptions.getAddress()).to.not.be.undefined;
    });

    it("Should distribute initial tokens", async function () {
      // Distribute tokens to test accounts
      await token.transfer(alice.address, ethers.parseEther("100000"));
      await token.transfer(bob.address, ethers.parseEther("100000"));
      await token.transfer(charlie.address, ethers.parseEther("100000"));
      await token.transfer(serviceProvider.address, ethers.parseEther("50000"));

      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("100000"));
    });

    it("Should setup approvals", async function () {
      const maxApproval = ethers.MaxUint256;

      // Alice approves all contracts
      await token.connect(alice).approve(await router.getAddress(), maxApproval);
      await token.connect(alice).approve(await reputation.getAddress(), maxApproval);
      await token.connect(alice).approve(await channel.getAddress(), maxApproval);
      await token.connect(alice).approve(await staking.getAddress(), maxApproval);
      await token.connect(alice).approve(await subscriptions.getAddress(), maxApproval);

      // Bob approves
      await token.connect(bob).approve(await router.getAddress(), maxApproval);
      await token.connect(bob).approve(await channel.getAddress(), maxApproval);
      await token.connect(bob).approve(await subscriptions.getAddress(), maxApproval);

      // Service provider approves
      await token.connect(serviceProvider).approve(await reputation.getAddress(), maxApproval);
    });
  });

  // ============================================
  // Complete Payment Flow
  // ============================================
  
  describe("E2E: Payment Flow", function () {
    it("Should complete direct payment", async function () {
      const amount = ethers.parseEther("100");
      const bobBalanceBefore = await token.balanceOf(bob.address);

      await router.connect(alice).pay(bob.address, amount, "Direct payment test");

      const bobBalanceAfter = await token.balanceOf(bob.address);
      expect(bobBalanceAfter - bobBalanceBefore).to.be.closeTo(amount, ethers.parseEther("1")); // Account for fee
    });

    it("Should complete batch payment", async function () {
      const recipients = [bob.address, charlie.address];
      const amounts = [ethers.parseEther("50"), ethers.parseEther("75")];

      await router.connect(alice).batchPay(recipients, amounts, "Batch payment test");

      // Verify both received (minus fees)
      expect(await token.balanceOf(bob.address)).to.be.gt(ethers.parseEther("100000"));
      expect(await token.balanceOf(charlie.address)).to.be.gt(ethers.parseEther("100000"));
    });

    it("Should complete escrow flow", async function () {
      const amount = ethers.parseEther("500");
      const deadline = (await time.latest()) + DAY;

      // Create escrow
      const tx = await router.connect(alice).createEscrow(
        bob.address,
        arbiter.address,
        amount,
        deadline
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => router.interface.parseLog(log)?.name === "EscrowCreated"
      );
      const escrowId = router.interface.parseLog(event).args.escrowId;

      // Release escrow
      await router.connect(alice).releaseEscrow(escrowId);

      // Verify bob received funds
      expect(await token.balanceOf(bob.address)).to.be.gt(ethers.parseEther("100500"));
    });

    it("Should complete payment stream", async function () {
      const amount = ethers.parseEther("1000");
      const startTime = await time.latest();
      const endTime = startTime + 30 * DAY;

      // Create stream
      const tx = await router.connect(alice).createStream(
        bob.address,
        amount,
        startTime,
        endTime
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => router.interface.parseLog(log)?.name === "StreamCreated"
      );
      const streamId = router.interface.parseLog(event).args.streamId;

      // Fast forward 15 days
      await time.increase(15 * DAY);

      // Withdraw from stream
      const bobBalanceBefore = await token.balanceOf(bob.address);
      await router.connect(bob).withdrawFromStream(streamId);
      const bobBalanceAfter = await token.balanceOf(bob.address);

      // Should receive ~50% of stream
      const received = bobBalanceAfter - bobBalanceBefore;
      expect(received).to.be.closeTo(ethers.parseEther("500"), ethers.parseEther("50"));
    });
  });

  // ============================================
  // Complete Agent & Service Flow
  // ============================================
  
  describe("E2E: Agent & Service Flow", function () {
    it("Should register agent and service", async function () {
      // Register agent
      await reputation.connect(serviceProvider).registerAgent(
        "AI Service Provider",
        "ipfs://metadata",
        ethers.parseEther("1000")
      );

      const agent = await reputation.getAgent(serviceProvider.address);
      expect(agent.name).to.equal("AI Service Provider");

      // Register service
      const tx = await serviceRegistry.connect(serviceProvider).registerService(
        "GPT-4 API",
        "language_model",
        "High-quality language model API",
        "https://api.example.com/v1",
        ethers.parseEther("0.01"), // Base price
        0 // PER_REQUEST pricing
      );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
    });

    it("Should discover and use service", async function () {
      // Find services by category
      const services = await serviceRegistry.getServicesByCategory("language_model");
      expect(services.length).to.be.gt(0);

      const serviceId = services[0];
      const service = await serviceRegistry.getService(serviceId);
      expect(service.name).to.equal("GPT-4 API");

      // Calculate price for 100 requests
      const price = await serviceRegistry.calculatePrice(serviceId, 100);
      expect(price).to.equal(ethers.parseEther("1")); // 0.01 * 100

      // Pay for service
      await router.connect(alice).pay(
        serviceProvider.address,
        price,
        `service:${serviceId}`
      );
    });

    it("Should rate service and update reputation", async function () {
      // Rate service
      await reputation.connect(alice).rateService(
        serviceProvider.address,
        "language_model",
        5 // 5 stars
      );

      // Check reputation increased
      const agent = await reputation.getAgent(serviceProvider.address);
      expect(agent.reputation).to.be.gt(50);
    });
  });

  // ============================================
  // Complete Payment Channel Flow
  // ============================================
  
  describe("E2E: Payment Channel Flow", function () {
    let channelId;

    it("Should open payment channel", async function () {
      const deposit = ethers.parseEther("1000");

      const tx = await channel.connect(alice).openChannel(
        bob.address,
        deposit,
        0 // Bob deposits later
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => channel.interface.parseLog(log)?.name === "ChannelOpened"
      );
      channelId = channel.interface.parseLog(event).args.channelId;

      expect(channelId).to.not.be.undefined;
    });

    it("Should fund channel from counterparty", async function () {
      await channel.connect(bob).fundChannel(alice.address, ethers.parseEther("500"));

      const info = await channel.getChannel(alice.address, bob.address);
      expect(info.balance1).to.equal(ethers.parseEther("1000"));
      expect(info.balance2).to.equal(ethers.parseEther("500"));
    });

    it("Should close channel cooperatively", async function () {
      // Create final state
      const finalBalance1 = ethers.parseEther("600");
      const finalBalance2 = ethers.parseEther("900");
      const nonce = 100;

      // Sign state (simplified - in reality both parties sign)
      const message = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "uint256", "uint256"],
        [channelId, finalBalance1, finalBalance2, nonce]
      );

      const sig1 = await alice.signMessage(ethers.getBytes(message));
      const sig2 = await bob.signMessage(ethers.getBytes(message));

      const aliceBalanceBefore = await token.balanceOf(alice.address);
      const bobBalanceBefore = await token.balanceOf(bob.address);

      await channel.connect(alice).cooperativeClose(
        bob.address,
        finalBalance1,
        finalBalance2,
        nonce,
        sig1,
        sig2
      );

      const aliceBalanceAfter = await token.balanceOf(alice.address);
      const bobBalanceAfter = await token.balanceOf(bob.address);

      expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(finalBalance1);
      expect(bobBalanceAfter - bobBalanceBefore).to.equal(finalBalance2);
    });
  });

  // ============================================
  // Complete Staking Flow
  // ============================================
  
  describe("E2E: Staking Flow", function () {
    before(async function () {
      // Add rewards to staking contract
      await token.transfer(await staking.getAddress(), ethers.parseEther("100000"));
      await staking.notifyRewardAmount(ethers.parseEther("100000"), 30 * DAY);
    });

    it("Should stake tokens with lock", async function () {
      const stakeAmount = ethers.parseEther("10000");

      await staking.connect(alice).stake(stakeAmount, 2); // 90-day lock

      const info = await staking.getStakeInfo(alice.address);
      expect(info.amount).to.equal(stakeAmount);
      expect(info.lockTierId).to.equal(2);
    });

    it("Should accumulate rewards over time", async function () {
      // Fast forward 7 days
      await time.increase(7 * DAY);

      const earned = await staking.earned(alice.address);
      expect(earned).to.be.gt(0);
    });

    it("Should claim rewards", async function () {
      const aliceBalanceBefore = await token.balanceOf(alice.address);
      
      await staking.connect(alice).claimRewards();

      const aliceBalanceAfter = await token.balanceOf(alice.address);
      expect(aliceBalanceAfter).to.be.gt(aliceBalanceBefore);
    });

    it("Should compound rewards", async function () {
      await time.increase(7 * DAY);

      const stakeBefore = await staking.getStakeInfo(alice.address);
      
      await staking.connect(alice).compound();

      const stakeAfter = await staking.getStakeInfo(alice.address);
      expect(stakeAfter.amount).to.be.gt(stakeBefore.amount);
    });
  });

  // ============================================
  // Complete Subscription Flow
  // ============================================
  
  describe("E2E: Subscription Flow", function () {
    let planId;
    let subscriptionId;

    it("Should create subscription plan", async function () {
      const tx = await subscriptions.connect(serviceProvider).createPlan(
        "Pro Plan",
        "Unlimited API access",
        ethers.parseEther("100"), // Base price
        30 * DAY, // Billing period
        7 * DAY, // Trial period
        10000, // Usage limit
        ethers.parseEther("0.01") // Overage rate
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptions.interface.parseLog(log)?.name === "PlanCreated"
      );
      planId = subscriptions.interface.parseLog(event).args.planId;

      expect(planId).to.not.be.undefined;
    });

    it("Should subscribe to plan", async function () {
      const tx = await subscriptions.connect(alice).subscribe(planId, 1);

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptions.interface.parseLog(log)?.name === "SubscriptionCreated"
      );
      subscriptionId = subscriptions.interface.parseLog(event).args.subscriptionId;

      const subscription = await subscriptions.getSubscription(subscriptionId);
      expect(subscription.status).to.equal(0); // ACTIVE
    });

    it("Should track usage", async function () {
      await subscriptions.connect(serviceProvider).recordUsage(subscriptionId, 1000);

      const subscription = await subscriptions.getSubscription(subscriptionId);
      expect(subscription.usageCount).to.equal(1000);
    });

    it("Should renew subscription", async function () {
      // Fast forward past billing period
      await time.increase(31 * DAY);

      await subscriptions.connect(alice).renew(subscriptionId, 1);

      const subscription = await subscriptions.getSubscription(subscriptionId);
      expect(subscription.status).to.equal(0); // Still ACTIVE
    });

    it("Should cancel subscription", async function () {
      await subscriptions.connect(alice).cancel(subscriptionId);

      const subscription = await subscriptions.getSubscription(subscriptionId);
      expect(subscription.status).to.equal(2); // CANCELLED
    });
  });

  // ============================================
  // Complete Multi-Party Workflow
  // ============================================
  
  describe("E2E: Multi-Party Service Workflow", function () {
    let serviceId;

    it("Should complete full service workflow", async function () {
      // 1. Provider registers service
      const registerTx = await serviceRegistry.connect(serviceProvider).registerService(
        "Image Generation API",
        "image_generation",
        "AI-powered image generation",
        "https://api.example.com/images",
        ethers.parseEther("0.1"),
        0
      );
      
      const registerReceipt = await registerTx.wait();
      const registerEvent = registerReceipt.logs.find(
        log => serviceRegistry.interface.parseLog(log)?.name === "ServiceRegistered"
      );
      serviceId = serviceRegistry.interface.parseLog(registerEvent).args.serviceId;

      // 2. Customer discovers and quotes service
      const price = await serviceRegistry.calculatePrice(serviceId, 10);
      expect(price).to.equal(ethers.parseEther("1"));

      // 3. Customer pays for service
      const payTx = await router.connect(alice).pay(
        serviceProvider.address,
        price,
        `service:${serviceId}:qty:10`
      );
      await payTx.wait();

      // 4. Customer rates service
      await reputation.connect(alice).rateService(
        serviceProvider.address,
        "image_generation",
        4
      );

      // 5. Provider's reputation increases
      const agent = await reputation.getAgent(serviceProvider.address);
      expect(agent.reputation).to.be.gt(50);
      expect(agent.totalTransactions).to.be.gt(0);
    });
  });

  // ============================================
  // Protocol Statistics
  // ============================================
  
  describe("Protocol Statistics", function () {
    it("Should report correct statistics", async function () {
      console.log("\n📊 Protocol Statistics After E2E Tests:");
      
      const totalSupply = await token.totalSupply();
      console.log(`   Total Supply: ${ethers.formatEther(totalSupply)} SYNX`);

      const routerBalance = await token.balanceOf(await router.getAddress());
      console.log(`   Router Balance: ${ethers.formatEther(routerBalance)} SYNX`);

      const stakingBalance = await token.balanceOf(await staking.getAddress());
      console.log(`   Staking TVL: ${ethers.formatEther(stakingBalance)} SYNX`);

      const aliceBalance = await token.balanceOf(alice.address);
      console.log(`   Alice Balance: ${ethers.formatEther(aliceBalance)} SYNX`);

      const bobBalance = await token.balanceOf(bob.address);
      console.log(`   Bob Balance: ${ethers.formatEther(bobBalance)} SYNX`);

      const providerBalance = await token.balanceOf(serviceProvider.address);
      console.log(`   Provider Balance: ${ethers.formatEther(providerBalance)} SYNX`);

      console.log("");
    });
  });
});
