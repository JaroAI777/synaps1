/**
 * SYNAPSE Protocol - Integration Tests
 * 
 * End-to-end tests covering the complete workflow
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SYNAPSE Protocol Integration Tests", function () {
  // Contracts
  let token;
  let paymentRouter;
  let reputation;
  let serviceRegistry;
  let paymentChannel;
  let subscriptionManager;
  let staking;
  
  // Accounts
  let deployer, treasury, provider1, provider2, consumer, arbiter;
  
  // Constants
  const DAY = 86400;
  const MONTH = 30 * DAY;
  
  before(async function () {
    [deployer, treasury, provider1, provider2, consumer, arbiter] = await ethers.getSigners();
    
    // Deploy Token
    const Token = await ethers.getContractFactory("SynapseToken");
    token = await Token.deploy(
      "SYNAPSE",
      "SYNX",
      ethers.parseEther("1000000000"),
      treasury.address,
      deployer.address
    );
    
    // Deploy PaymentRouter
    const Router = await ethers.getContractFactory("PaymentRouter");
    paymentRouter = await Router.deploy(
      await token.getAddress(),
      treasury.address,
      50 // 0.5% base fee
    );
    
    // Deploy ReputationRegistry
    const Reputation = await ethers.getContractFactory("ReputationRegistry");
    reputation = await Reputation.deploy(
      await token.getAddress(),
      ethers.parseEther("100") // Min stake
    );
    
    // Deploy ServiceRegistry
    const Services = await ethers.getContractFactory("ServiceRegistry");
    serviceRegistry = await Services.deploy(
      await token.getAddress(),
      await reputation.getAddress(),
      ethers.parseEther("10") // Registration fee
    );
    
    // Deploy PaymentChannel
    const Channels = await ethers.getContractFactory("PaymentChannel");
    paymentChannel = await Channels.deploy(
      await token.getAddress(),
      DAY // 1 day challenge period
    );
    
    // Deploy SubscriptionManager
    const Subscriptions = await ethers.getContractFactory("SubscriptionManager");
    subscriptionManager = await Subscriptions.deploy(
      await token.getAddress(),
      treasury.address,
      250 // 2.5% platform fee
    );
    
    // Deploy StakingRewards
    const Staking = await ethers.getContractFactory("StakingRewards");
    staking = await Staking.deploy(
      await token.getAddress(),
      await token.getAddress(),
      ethers.parseEther("100"),
      ethers.parseEther("1000000"),
      DAY
    );
    
    // Setup: Distribute tokens
    await token.transfer(provider1.address, ethers.parseEther("100000"));
    await token.transfer(provider2.address, ethers.parseEther("100000"));
    await token.transfer(consumer.address, ethers.parseEther("100000"));
    
    // Setup: Approve all contracts
    const contracts = [
      paymentRouter, reputation, serviceRegistry, 
      paymentChannel, subscriptionManager, staking
    ];
    
    for (const signer of [provider1, provider2, consumer]) {
      for (const contract of contracts) {
        await token.connect(signer).approve(
          await contract.getAddress(),
          ethers.MaxUint256
        );
      }
    }
    
    // Grant roles
    const REPORTER_ROLE = await paymentRouter.REPORTER_ROLE();
    await paymentRouter.grantRole(REPORTER_ROLE, await reputation.getAddress());
    
    const REWARDS_ROLE = await staking.REWARDS_DISTRIBUTOR_ROLE();
    await staking.grantRole(REWARDS_ROLE, deployer.address);
  });

  describe("Scenario 1: AI Agent Registration and Service Setup", function () {
    it("Provider should register as AI agent", async function () {
      await reputation.connect(provider1).registerAgent(
        "GPT-4-Provider",
        "ipfs://QmProvider1Metadata",
        ethers.parseEther("1000")
      );
      
      const agent = await reputation.agents(provider1.address);
      expect(agent.registered).to.be.true;
      expect(agent.name).to.equal("GPT-4-Provider");
      expect(agent.stake).to.equal(ethers.parseEther("1000"));
    });
    
    it("Provider should register a service", async function () {
      // Pay registration fee
      await token.connect(provider1).approve(
        await serviceRegistry.getAddress(),
        ethers.parseEther("10")
      );
      
      const tx = await serviceRegistry.connect(provider1).registerService(
        "GPT-4 Chat API",
        "language_model",
        "High-quality language model API",
        "https://api.provider1.ai/v1/chat",
        ethers.parseEther("0.001"),
        0 // PER_REQUEST
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => serviceRegistry.interface.parseLog(log)?.name === "ServiceRegistered"
      );
      
      expect(event).to.not.be.undefined;
    });
  });

  describe("Scenario 2: Payment Flow", function () {
    it("Consumer should pay for service", async function () {
      const balanceBefore = await token.balanceOf(provider1.address);
      
      const paymentId = ethers.keccak256(ethers.toUtf8Bytes("payment-001"));
      
      await paymentRouter.connect(consumer).pay(
        provider1.address,
        ethers.parseEther("10"),
        paymentId,
        "0x"
      );
      
      const balanceAfter = await token.balanceOf(provider1.address);
      // Provider receives payment minus fee (0.5%)
      expect(balanceAfter - balanceBefore).to.be.closeTo(
        ethers.parseEther("9.95"),
        ethers.parseEther("0.01")
      );
    });
    
    it("Consumer should send batch payment", async function () {
      const recipients = [provider1.address, provider2.address];
      const amounts = [ethers.parseEther("5"), ethers.parseEther("5")];
      const paymentIds = [
        ethers.keccak256(ethers.toUtf8Bytes("batch-001")),
        ethers.keccak256(ethers.toUtf8Bytes("batch-002"))
      ];
      
      await paymentRouter.connect(consumer).batchPay(
        recipients,
        amounts,
        paymentIds,
        []
      );
    });
  });

  describe("Scenario 3: Escrow Workflow", function () {
    let escrowId;
    
    it("Should create escrow", async function () {
      const deadline = Math.floor(Date.now() / 1000) + DAY;
      const paymentId = ethers.keccak256(ethers.toUtf8Bytes("escrow-001"));
      
      const tx = await paymentRouter.connect(consumer).createEscrow(
        provider1.address,
        arbiter.address,
        ethers.parseEther("100"),
        deadline,
        paymentId,
        "0x"
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => paymentRouter.interface.parseLog(log)?.name === "EscrowCreated"
      );
      
      escrowId = paymentRouter.interface.parseLog(event).args.escrowId;
      expect(escrowId).to.not.be.undefined;
    });
    
    it("Should release escrow", async function () {
      const balanceBefore = await token.balanceOf(provider1.address);
      
      await paymentRouter.connect(consumer).releaseEscrow(escrowId);
      
      const balanceAfter = await token.balanceOf(provider1.address);
      expect(balanceAfter - balanceBefore).to.be.closeTo(
        ethers.parseEther("99.5"),
        ethers.parseEther("0.1")
      );
    });
  });

  describe("Scenario 4: Payment Stream", function () {
    let streamId;
    
    it("Should create payment stream", async function () {
      const startTime = Math.floor(Date.now() / 1000);
      const endTime = startTime + DAY;
      const paymentId = ethers.keccak256(ethers.toUtf8Bytes("stream-001"));
      
      const tx = await paymentRouter.connect(consumer).createStream(
        provider1.address,
        ethers.parseEther("86400"), // 1 SYNX per second for 1 day
        startTime,
        endTime,
        paymentId
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => paymentRouter.interface.parseLog(log)?.name === "StreamCreated"
      );
      
      streamId = paymentRouter.interface.parseLog(event).args.streamId;
      expect(streamId).to.not.be.undefined;
    });
    
    it("Should withdraw from stream after time passes", async function () {
      // Fast forward 1 hour
      await time.increase(3600);
      
      const balanceBefore = await token.balanceOf(provider1.address);
      
      await paymentRouter.connect(provider1).withdrawFromStream(streamId);
      
      const balanceAfter = await token.balanceOf(provider1.address);
      // Should receive ~3600 SYNX (1 hour worth)
      expect(balanceAfter - balanceBefore).to.be.closeTo(
        ethers.parseEther("3600"),
        ethers.parseEther("100")
      );
    });
  });

  describe("Scenario 5: Payment Channel", function () {
    let channelId;
    
    it("Should open payment channel", async function () {
      const tx = await paymentChannel.connect(consumer).openChannel(
        provider1.address,
        ethers.parseEther("1000"),
        0
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => paymentChannel.interface.parseLog(log)?.name === "ChannelOpened"
      );
      
      channelId = paymentChannel.interface.parseLog(event).args.channelId;
      expect(channelId).to.not.be.undefined;
    });
    
    it("Provider should fund the channel", async function () {
      await paymentChannel.connect(provider1).fundChannel(
        consumer.address,
        ethers.parseEther("500")
      );
      
      const channel = await paymentChannel.channels(channelId);
      expect(channel.balance2).to.equal(ethers.parseEther("500"));
    });
    
    it("Should cooperatively close channel", async function () {
      // Create final state
      const finalBalance1 = ethers.parseEther("800");
      const finalBalance2 = ethers.parseEther("700");
      const nonce = 100;
      
      // Sign state
      const message = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "uint256", "uint256"],
        [channelId, finalBalance1, finalBalance2, nonce]
      );
      
      const sig1 = await consumer.signMessage(ethers.getBytes(message));
      const sig2 = await provider1.signMessage(ethers.getBytes(message));
      
      const consumerBefore = await token.balanceOf(consumer.address);
      const providerBefore = await token.balanceOf(provider1.address);
      
      await paymentChannel.connect(consumer).cooperativeClose(
        provider1.address,
        finalBalance1,
        finalBalance2,
        nonce,
        sig1,
        sig2
      );
      
      const consumerAfter = await token.balanceOf(consumer.address);
      const providerAfter = await token.balanceOf(provider1.address);
      
      expect(consumerAfter - consumerBefore).to.equal(finalBalance1);
      expect(providerAfter - providerBefore).to.equal(finalBalance2);
    });
  });

  describe("Scenario 6: Subscription Service", function () {
    let planId, subscriptionId;
    
    it("Provider should create subscription plan", async function () {
      const tx = await subscriptionManager.connect(provider1).createPlan(
        "Pro Plan",
        "Unlimited API access",
        ethers.parseEther("100"),
        MONTH,
        7 * DAY, // 7 day trial
        10000, // 10k requests
        ethers.parseEther("0.01") // Overage rate
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "PlanCreated"
      );
      
      planId = subscriptionManager.interface.parseLog(event).args.planId;
      expect(planId).to.not.be.undefined;
    });
    
    it("Consumer should subscribe to plan", async function () {
      const tx = await subscriptionManager.connect(consumer).subscribe(
        planId,
        1
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => subscriptionManager.interface.parseLog(log)?.name === "Subscribed"
      );
      
      subscriptionId = subscriptionManager.interface.parseLog(event).args.subscriptionId;
      expect(subscriptionId).to.not.be.undefined;
      
      const sub = await subscriptionManager.subscriptions(subscriptionId);
      expect(sub.inTrial).to.be.true;
    });
    
    it("Provider should record usage", async function () {
      await subscriptionManager.connect(provider1).recordUsage(
        subscriptionId,
        500,
        ethers.keccak256(ethers.toUtf8Bytes("usage-001"))
      );
      
      const sub = await subscriptionManager.subscriptions(subscriptionId);
      expect(sub.usageThisPeriod).to.equal(500n);
    });
  });

  describe("Scenario 7: Staking Rewards", function () {
    it("Should stake tokens", async function () {
      await staking.connect(consumer).stake(
        ethers.parseEther("5000"),
        2 // 90-day lock, 1.5x boost
      );
      
      const stake = await staking.stakes(consumer.address);
      expect(stake.amount).to.equal(ethers.parseEther("5000"));
      expect(stake.boostMultiplier).to.equal(150n);
    });
    
    it("Should distribute and earn rewards", async function () {
      // Add rewards
      await token.approve(await staking.getAddress(), ethers.parseEther("100000"));
      await staking.addRewards(ethers.parseEther("100000"), MONTH);
      
      // Fast forward 1 week
      await time.increase(7 * DAY);
      
      const pending = await staking.pendingRewards(consumer.address);
      expect(pending).to.be.gt(0n);
    });
    
    it("Should claim rewards", async function () {
      const balanceBefore = await token.balanceOf(consumer.address);
      
      await staking.connect(consumer).claimRewards();
      
      const balanceAfter = await token.balanceOf(consumer.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });
  });

  describe("Scenario 8: Reputation and Disputes", function () {
    it("Consumer should rate service", async function () {
      await reputation.connect(consumer).rateService(
        provider1.address,
        "language_model",
        5 // 5 stars
      );
    });
    
    it("Should create and resolve dispute", async function () {
      // Register provider2 as agent
      await reputation.connect(provider2).registerAgent(
        "Bad Provider",
        "",
        ethers.parseEther("500")
      );
      
      // Create dispute
      const txId = ethers.keccak256(ethers.toUtf8Bytes("failed-tx-001"));
      const tx = await reputation.connect(consumer).createDispute(
        provider2.address,
        "Service did not deliver as promised",
        txId
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => reputation.interface.parseLog(log)?.name === "DisputeCreated"
      );
      
      const disputeId = reputation.interface.parseLog(event).args.disputeId;
      
      // Grant arbiter role
      const ARBITER_ROLE = await reputation.ARBITER_ROLE();
      await reputation.grantRole(ARBITER_ROLE, arbiter.address);
      
      // Resolve dispute in favor of complainant
      await reputation.connect(arbiter).resolveDispute(disputeId, true);
      
      const dispute = await reputation.disputes(disputeId);
      expect(dispute.status).to.equal(1); // RESOLVED
    });
  });

  describe("Scenario 9: Full End-to-End Workflow", function () {
    it("Complete AI service transaction flow", async function () {
      // 1. New provider registers
      await reputation.connect(provider2).increaseStake(ethers.parseEther("500"));
      
      // 2. Provider registers service
      const serviceTx = await serviceRegistry.connect(provider2).registerService(
        "Image Generation API",
        "image_generation",
        "Create images with AI",
        "https://api.provider2.ai/generate",
        ethers.parseEther("0.1"),
        0
      );
      const serviceReceipt = await serviceTx.wait();
      const serviceEvent = serviceReceipt.logs.find(
        log => serviceRegistry.interface.parseLog(log)?.name === "ServiceRegistered"
      );
      const serviceId = serviceRegistry.interface.parseLog(serviceEvent).args.serviceId;
      
      // 3. Consumer requests quote
      const quoteTx = await serviceRegistry.connect(consumer).requestQuote(
        serviceId,
        10, // 10 images
        "0x"
      );
      const quoteReceipt = await quoteTx.wait();
      const quoteEvent = quoteReceipt.logs.find(
        log => serviceRegistry.interface.parseLog(log)?.name === "QuoteRequested"
      );
      const quoteId = serviceRegistry.interface.parseLog(quoteEvent).args.quoteId;
      
      // 4. Provider provides quote
      await serviceRegistry.connect(provider2).provideQuote(
        quoteId,
        ethers.parseEther("0.8"), // 0.8 SYNX for 10 images
        Math.floor(Date.now() / 1000) + DAY
      );
      
      // 5. Consumer accepts quote (creates escrow)
      const balanceBefore = await token.balanceOf(provider2.address);
      await serviceRegistry.connect(consumer).acceptQuote(quoteId);
      
      // 6. Provider delivers service and gets paid
      const balanceAfter = await token.balanceOf(provider2.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
      
      // 7. Consumer rates service
      await reputation.connect(consumer).rateService(
        provider2.address,
        "image_generation",
        4
      );
      
      // 8. Check provider reputation improved
      const agent = await reputation.agents(provider2.address);
      expect(agent.reputationScore).to.be.gt(0n);
    });
  });

  describe("Scenario 10: Protocol Statistics", function () {
    it("Should verify protocol state", async function () {
      // Token supply
      const totalSupply = await token.totalSupply();
      expect(totalSupply).to.equal(ethers.parseEther("1000000000"));
      
      // Staking stats
      const totalStaked = await staking.totalStaked();
      expect(totalStaked).to.be.gt(0n);
      
      // Service count
      const languageServices = await serviceRegistry.getServicesByCategory("language_model");
      expect(languageServices.length).to.be.gte(1);
      
      // Agent count
      const provider1Agent = await reputation.agents(provider1.address);
      const provider2Agent = await reputation.agents(provider2.address);
      expect(provider1Agent.registered).to.be.true;
      expect(provider2Agent.registered).to.be.true;
    });
  });
});
