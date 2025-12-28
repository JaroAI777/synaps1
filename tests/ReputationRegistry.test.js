const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("ReputationRegistry", function () {
  async function deployReputationFixture() {
    const [owner, treasury, agent1, agent2, agent3, arbiter, recorder] = await ethers.getSigners();
    
    // Deploy token
    const SynapseToken = await ethers.getContractFactory("SynapseToken");
    const token = await SynapseToken.deploy(treasury.address);
    await token.waitForDeployment();
    
    const minStake = ethers.parseEther("100");
    const registrationFee = ethers.parseEther("10");
    
    // Deploy reputation registry
    const ReputationRegistry = await ethers.getContractFactory("ReputationRegistry");
    const reputation = await ReputationRegistry.deploy(
      await token.getAddress(),
      minStake,
      registrationFee
    );
    await reputation.waitForDeployment();
    
    // Setup: Transfer tokens to agents
    await token.connect(treasury).transfer(agent1.address, ethers.parseEther("100000"));
    await token.connect(treasury).transfer(agent2.address, ethers.parseEther("100000"));
    await token.connect(treasury).transfer(agent3.address, ethers.parseEther("100000"));
    
    // Approve reputation registry
    const reputationAddress = await reputation.getAddress();
    await token.connect(agent1).approve(reputationAddress, ethers.MaxUint256);
    await token.connect(agent2).approve(reputationAddress, ethers.MaxUint256);
    await token.connect(agent3).approve(reputationAddress, ethers.MaxUint256);
    
    return {
      token,
      reputation,
      owner,
      treasury,
      agent1,
      agent2,
      agent3,
      arbiter,
      recorder,
      minStake,
      registrationFee,
      reputationAddress
    };
  }

  describe("Deployment", function () {
    it("Should set correct minimum stake", async function () {
      const { reputation, minStake } = await loadFixture(deployReputationFixture);
      expect(await reputation.minimumStake()).to.equal(minStake);
    });

    it("Should set correct registration fee", async function () {
      const { reputation, registrationFee } = await loadFixture(deployReputationFixture);
      expect(await reputation.registrationFee()).to.equal(registrationFee);
    });
  });

  describe("Agent Registration", function () {
    it("Should register new agent", async function () {
      const { reputation, agent1, minStake } = await loadFixture(deployReputationFixture);
      
      await reputation.connect(agent1).registerAgent(
        "TestAgent",
        "ipfs://metadata",
        minStake
      );
      
      const agent = await reputation.agents(agent1.address);
      expect(agent.registered).to.be.true;
      expect(agent.name).to.equal("TestAgent");
      expect(agent.stake).to.equal(minStake);
    });

    it("Should emit AgentRegistered event", async function () {
      const { reputation, agent1, minStake } = await loadFixture(deployReputationFixture);
      
      await expect(
        reputation.connect(agent1).registerAgent("TestAgent", "ipfs://meta", minStake)
      ).to.emit(reputation, "AgentRegistered")
        .withArgs(agent1.address, "TestAgent", minStake);
    });

    it("Should set initial reputation score to 500", async function () {
      const { reputation, agent1, minStake } = await loadFixture(deployReputationFixture);
      
      await reputation.connect(agent1).registerAgent("TestAgent", "", minStake);
      
      const agent = await reputation.agents(agent1.address);
      expect(agent.reputationScore).to.equal(500);
    });

    it("Should fail with stake below minimum", async function () {
      const { reputation, agent1 } = await loadFixture(deployReputationFixture);
      
      await expect(
        reputation.connect(agent1).registerAgent("TestAgent", "", ethers.parseEther("50"))
      ).to.be.revertedWith("ReputationRegistry: stake too low");
    });

    it("Should fail to register twice", async function () {
      const { reputation, agent1, minStake } = await loadFixture(deployReputationFixture);
      
      await reputation.connect(agent1).registerAgent("TestAgent", "", minStake);
      
      await expect(
        reputation.connect(agent1).registerAgent("TestAgent2", "", minStake)
      ).to.be.revertedWith("ReputationRegistry: already registered");
    });
  });

  describe("Reputation Scoring", function () {
    async function registerAgentsFixture() {
      const base = await deployReputationFixture();
      const { reputation, agent1, agent2, minStake, owner } = base;
      
      // Register agents
      await reputation.connect(agent1).registerAgent("Agent1", "", minStake);
      await reputation.connect(agent2).registerAgent("Agent2", "", minStake);
      
      // Grant recorder role to owner for testing
      const RECORDER_ROLE = await reputation.RECORDER_ROLE();
      await reputation.connect(owner).grantRole(RECORDER_ROLE, owner.address);
      
      return { ...base, RECORDER_ROLE };
    }

    it("Should increase score on successful transaction", async function () {
      const { reputation, owner, agent1 } = await loadFixture(registerAgentsFixture);
      
      const scoreBefore = (await reputation.agents(agent1.address)).reputationScore;
      
      await reputation.connect(owner).recordTransaction(
        agent1.address,
        ethers.parseEther("1000"),
        true // success
      );
      
      const scoreAfter = (await reputation.agents(agent1.address)).reputationScore;
      expect(scoreAfter).to.be.gt(scoreBefore);
    });

    it("Should decrease score on failed transaction", async function () {
      const { reputation, owner, agent1 } = await loadFixture(registerAgentsFixture);
      
      const scoreBefore = (await reputation.agents(agent1.address)).reputationScore;
      
      await reputation.connect(owner).recordTransaction(
        agent1.address,
        ethers.parseEther("1000"),
        false // failure
      );
      
      const scoreAfter = (await reputation.agents(agent1.address)).reputationScore;
      expect(scoreAfter).to.be.lt(scoreBefore);
    });

    it("Should track transaction counts", async function () {
      const { reputation, owner, agent1 } = await loadFixture(registerAgentsFixture);
      
      await reputation.connect(owner).recordTransaction(agent1.address, ethers.parseEther("100"), true);
      await reputation.connect(owner).recordTransaction(agent1.address, ethers.parseEther("100"), true);
      await reputation.connect(owner).recordTransaction(agent1.address, ethers.parseEther("100"), false);
      
      const agent = await reputation.agents(agent1.address);
      expect(agent.totalTransactions).to.equal(3);
      expect(agent.successfulTransactions).to.equal(2);
    });

    it("Should calculate success rate correctly", async function () {
      const { reputation, owner, agent1 } = await loadFixture(registerAgentsFixture);
      
      // 8 successful, 2 failed = 80% success rate
      for (let i = 0; i < 8; i++) {
        await reputation.connect(owner).recordTransaction(agent1.address, ethers.parseEther("100"), true);
      }
      for (let i = 0; i < 2; i++) {
        await reputation.connect(owner).recordTransaction(agent1.address, ethers.parseEther("100"), false);
      }
      
      const successRate = await reputation.getSuccessRate(agent1.address);
      expect(successRate).to.equal(8000); // 80.00% in basis points
    });

    it("Should not allow non-recorder to record transactions", async function () {
      const { reputation, agent1, agent2 } = await loadFixture(registerAgentsFixture);
      
      await expect(
        reputation.connect(agent2).recordTransaction(agent1.address, ethers.parseEther("100"), true)
      ).to.be.reverted;
    });
  });

  describe("Tier System", function () {
    async function registerAgentsFixture() {
      const base = await deployReputationFixture();
      const { reputation, agent1, agent2, minStake, owner } = base;
      
      await reputation.connect(agent1).registerAgent("Agent1", "", minStake);
      await reputation.connect(agent2).registerAgent("Agent2", "", minStake);
      
      const RECORDER_ROLE = await reputation.RECORDER_ROLE();
      await reputation.connect(owner).grantRole(RECORDER_ROLE, owner.address);
      
      return { ...base, RECORDER_ROLE };
    }

    it("Should start at Unverified tier", async function () {
      const { reputation, agent1 } = await loadFixture(registerAgentsFixture);
      
      const tier = await reputation.getTier(agent1.address);
      expect(tier).to.equal(0); // Unverified
    });

    it("Should upgrade to Bronze tier after requirements met", async function () {
      const { reputation, owner, agent1 } = await loadFixture(registerAgentsFixture);
      
      // Simulate 100+ successful transactions
      for (let i = 0; i < 100; i++) {
        await reputation.connect(owner).recordTransaction(
          agent1.address,
          ethers.parseEther("100"),
          true
        );
      }
      
      // Check tier - should be Bronze (1) if 95%+ success rate
      const tier = await reputation.getTier(agent1.address);
      expect(tier).to.be.gte(1); // At least Bronze
    });

    it("Should return correct fee discount per tier", async function () {
      const { reputation } = await loadFixture(registerAgentsFixture);
      
      // Test tier discounts
      expect(await reputation.getTierDiscount(0)).to.equal(0);     // Unverified: 0%
      expect(await reputation.getTierDiscount(1)).to.equal(1000);  // Bronze: 10%
      expect(await reputation.getTierDiscount(2)).to.equal(2500);  // Silver: 25%
      expect(await reputation.getTierDiscount(3)).to.equal(4000);  // Gold: 40%
      expect(await reputation.getTierDiscount(4)).to.equal(6000);  // Platinum: 60%
      expect(await reputation.getTierDiscount(5)).to.equal(7500);  // Diamond: 75%
    });
  });

  describe("Staking", function () {
    async function registerAgentsFixture() {
      const base = await deployReputationFixture();
      const { reputation, agent1, minStake } = base;
      
      await reputation.connect(agent1).registerAgent("Agent1", "", minStake);
      
      return base;
    }

    it("Should allow increasing stake", async function () {
      const { reputation, agent1, minStake } = await loadFixture(registerAgentsFixture);
      
      const additionalStake = ethers.parseEther("500");
      await reputation.connect(agent1).increaseStake(additionalStake);
      
      const agent = await reputation.agents(agent1.address);
      expect(agent.stake).to.equal(minStake + additionalStake);
    });

    it("Should emit StakeIncreased event", async function () {
      const { reputation, agent1, minStake } = await loadFixture(registerAgentsFixture);
      
      const additionalStake = ethers.parseEther("500");
      
      await expect(reputation.connect(agent1).increaseStake(additionalStake))
        .to.emit(reputation, "StakeIncreased")
        .withArgs(agent1.address, minStake + additionalStake);
    });

    it("Should allow decreasing stake above minimum", async function () {
      const { reputation, agent1, minStake } = await loadFixture(registerAgentsFixture);
      
      // First increase stake
      await reputation.connect(agent1).increaseStake(ethers.parseEther("500"));
      
      // Then decrease
      await reputation.connect(agent1).decreaseStake(ethers.parseEther("200"));
      
      const agent = await reputation.agents(agent1.address);
      expect(agent.stake).to.equal(minStake + ethers.parseEther("300"));
    });

    it("Should fail to decrease below minimum stake", async function () {
      const { reputation, agent1 } = await loadFixture(registerAgentsFixture);
      
      await expect(
        reputation.connect(agent1).decreaseStake(ethers.parseEther("50"))
      ).to.be.revertedWith("ReputationRegistry: below minimum stake");
    });
  });

  describe("Dispute System", function () {
    async function registerAgentsFixture() {
      const base = await deployReputationFixture();
      const { reputation, agent1, agent2, arbiter, owner, minStake } = base;
      
      await reputation.connect(agent1).registerAgent("Agent1", "", minStake);
      await reputation.connect(agent2).registerAgent("Agent2", "", minStake);
      
      // Grant arbiter role
      const ARBITER_ROLE = await reputation.ARBITER_ROLE();
      await reputation.connect(owner).grantRole(ARBITER_ROLE, arbiter.address);
      
      return { ...base, ARBITER_ROLE };
    }

    it("Should create dispute", async function () {
      const { reputation, agent1, agent2 } = await loadFixture(registerAgentsFixture);
      
      const tx = await reputation.connect(agent1).createDispute(
        agent2.address,
        "Service not delivered",
        ethers.encodeBytes32String("tx-123")
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(log => {
        try {
          return reputation.interface.parseLog(log)?.name === "DisputeCreated";
        } catch { return false; }
      });
      
      expect(event).to.not.be.undefined;
    });

    it("Should allow arbiter to resolve dispute in favor of complainant", async function () {
      const { reputation, agent1, agent2, arbiter, minStake } = await loadFixture(registerAgentsFixture);
      
      // Create dispute
      const tx = await reputation.connect(agent1).createDispute(
        agent2.address,
        "Service not delivered",
        ethers.encodeBytes32String("tx-456")
      );
      const receipt = await tx.wait();
      
      // Extract dispute ID from event
      const event = receipt.logs.find(log => {
        try {
          return reputation.interface.parseLog(log)?.name === "DisputeCreated";
        } catch { return false; }
      });
      const parsedEvent = reputation.interface.parseLog(event);
      const disputeId = parsedEvent.args.disputeId;
      
      const stakeBefore = (await reputation.agents(agent2.address)).stake;
      
      // Resolve in favor of complainant (agent1)
      await reputation.connect(arbiter).resolveDispute(disputeId, true);
      
      const stakeAfter = (await reputation.agents(agent2.address)).stake;
      // Agent2 should be slashed
      expect(stakeAfter).to.be.lt(stakeBefore);
    });

    it("Should allow arbiter to resolve dispute in favor of defendant", async function () {
      const { reputation, agent1, agent2, arbiter } = await loadFixture(registerAgentsFixture);
      
      const tx = await reputation.connect(agent1).createDispute(
        agent2.address,
        "False claim",
        ethers.encodeBytes32String("tx-789")
      );
      const receipt = await tx.wait();
      
      const event = receipt.logs.find(log => {
        try {
          return reputation.interface.parseLog(log)?.name === "DisputeCreated";
        } catch { return false; }
      });
      const parsedEvent = reputation.interface.parseLog(event);
      const disputeId = parsedEvent.args.disputeId;
      
      const scoreBefore = (await reputation.agents(agent2.address)).reputationScore;
      
      // Resolve in favor of defendant (agent2)
      await reputation.connect(arbiter).resolveDispute(disputeId, false);
      
      const scoreAfter = (await reputation.agents(agent2.address)).reputationScore;
      // Agent2's score should be unchanged or improved
      expect(scoreAfter).to.be.gte(scoreBefore);
    });

    it("Should not allow non-arbiter to resolve dispute", async function () {
      const { reputation, agent1, agent2 } = await loadFixture(registerAgentsFixture);
      
      const tx = await reputation.connect(agent1).createDispute(
        agent2.address,
        "Test dispute",
        ethers.encodeBytes32String("tx-000")
      );
      const receipt = await tx.wait();
      
      const event = receipt.logs.find(log => {
        try {
          return reputation.interface.parseLog(log)?.name === "DisputeCreated";
        } catch { return false; }
      });
      const parsedEvent = reputation.interface.parseLog(event);
      const disputeId = parsedEvent.args.disputeId;
      
      await expect(
        reputation.connect(agent1).resolveDispute(disputeId, true)
      ).to.be.reverted;
    });
  });

  describe("Service Ratings", function () {
    async function registerAgentsFixture() {
      const base = await deployReputationFixture();
      const { reputation, agent1, agent2, minStake, owner } = base;
      
      await reputation.connect(agent1).registerAgent("Agent1", "", minStake);
      await reputation.connect(agent2).registerAgent("Agent2", "", minStake);
      
      const RECORDER_ROLE = await reputation.RECORDER_ROLE();
      await reputation.connect(owner).grantRole(RECORDER_ROLE, owner.address);
      
      return base;
    }

    it("Should allow rating service", async function () {
      const { reputation, owner, agent1, agent2 } = await loadFixture(registerAgentsFixture);
      
      // First record a transaction
      await reputation.connect(owner).recordTransaction(agent2.address, ethers.parseEther("100"), true);
      
      // Rate the service
      await reputation.connect(agent1).rateService(
        agent2.address,
        "language_model",
        4 // 4 out of 5
      );
      
      const rating = await reputation.getServiceRating(agent2.address, "language_model");
      expect(rating.totalRatings).to.equal(1);
      expect(rating.averageRating).to.equal(4);
    });

    it("Should calculate average rating correctly", async function () {
      const { reputation, owner, agent1, agent2, agent3, minStake } = await loadFixture(registerAgentsFixture);
      
      // Register agent3
      await reputation.connect(agent3).registerAgent("Agent3", "", minStake);
      
      // Record transactions
      await reputation.connect(owner).recordTransaction(agent2.address, ethers.parseEther("100"), true);
      await reputation.connect(owner).recordTransaction(agent2.address, ethers.parseEther("100"), true);
      
      // Multiple ratings
      await reputation.connect(agent1).rateService(agent2.address, "image_gen", 5);
      await reputation.connect(agent3).rateService(agent2.address, "image_gen", 3);
      
      const rating = await reputation.getServiceRating(agent2.address, "image_gen");
      expect(rating.totalRatings).to.equal(2);
      expect(rating.averageRating).to.equal(4); // (5+3)/2 = 4
    });

    it("Should fail with invalid rating value", async function () {
      const { reputation, agent1, agent2 } = await loadFixture(registerAgentsFixture);
      
      await expect(
        reputation.connect(agent1).rateService(agent2.address, "test", 0)
      ).to.be.revertedWith("ReputationRegistry: invalid rating");
      
      await expect(
        reputation.connect(agent1).rateService(agent2.address, "test", 6)
      ).to.be.revertedWith("ReputationRegistry: invalid rating");
    });
  });

  describe("Slashing", function () {
    async function registerAgentsFixture() {
      const base = await deployReputationFixture();
      const { reputation, agent1, minStake, owner } = base;
      
      await reputation.connect(agent1).registerAgent("Agent1", "", minStake);
      
      return base;
    }

    it("Should allow admin to slash agent stake", async function () {
      const { reputation, owner, agent1, minStake } = await loadFixture(registerAgentsFixture);
      
      const slashAmount = minStake / 10n; // 10%
      
      await reputation.connect(owner).slashAgent(agent1.address, slashAmount, "Malicious behavior");
      
      const agent = await reputation.agents(agent1.address);
      expect(agent.stake).to.equal(minStake - slashAmount);
    });

    it("Should emit AgentSlashed event", async function () {
      const { reputation, owner, agent1, minStake } = await loadFixture(registerAgentsFixture);
      
      const slashAmount = minStake / 10n;
      
      await expect(reputation.connect(owner).slashAgent(agent1.address, slashAmount, "Bad actor"))
        .to.emit(reputation, "AgentSlashed")
        .withArgs(agent1.address, slashAmount, "Bad actor");
    });

    it("Should not allow slashing unregistered agent", async function () {
      const { reputation, owner, agent2 } = await loadFixture(registerAgentsFixture);
      
      await expect(
        reputation.connect(owner).slashAgent(agent2.address, ethers.parseEther("10"), "Test")
      ).to.be.revertedWith("ReputationRegistry: not registered");
    });

    it("Should not allow non-admin to slash", async function () {
      const { reputation, agent1, agent2, minStake } = await loadFixture(registerAgentsFixture);
      
      await expect(
        reputation.connect(agent2).slashAgent(agent1.address, ethers.parseEther("10"), "Test")
      ).to.be.reverted;
    });
  });

  describe("Agent Deregistration", function () {
    async function registerAgentsFixture() {
      const base = await deployReputationFixture();
      const { reputation, token, agent1, minStake } = base;
      
      await reputation.connect(agent1).registerAgent("Agent1", "", minStake);
      
      return base;
    }

    it("Should allow agent to deregister", async function () {
      const { reputation, agent1 } = await loadFixture(registerAgentsFixture);
      
      await reputation.connect(agent1).deregisterAgent();
      
      const agent = await reputation.agents(agent1.address);
      expect(agent.registered).to.be.false;
    });

    it("Should return stake on deregistration", async function () {
      const { reputation, token, agent1, minStake } = await loadFixture(registerAgentsFixture);
      
      const balanceBefore = await token.balanceOf(agent1.address);
      
      await reputation.connect(agent1).deregisterAgent();
      
      const balanceAfter = await token.balanceOf(agent1.address);
      expect(balanceAfter - balanceBefore).to.equal(minStake);
    });

    it("Should emit AgentDeregistered event", async function () {
      const { reputation, agent1 } = await loadFixture(registerAgentsFixture);
      
      await expect(reputation.connect(agent1).deregisterAgent())
        .to.emit(reputation, "AgentDeregistered")
        .withArgs(agent1.address);
    });
  });
});
