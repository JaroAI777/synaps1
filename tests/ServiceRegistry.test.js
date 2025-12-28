const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("ServiceRegistry", function () {
  async function deployServiceFixture() {
    const [owner, treasury, provider1, provider2, consumer1, consumer2] = await ethers.getSigners();
    
    // Deploy token
    const SynapseToken = await ethers.getContractFactory("SynapseToken");
    const token = await SynapseToken.deploy(treasury.address);
    await token.waitForDeployment();
    
    // Deploy reputation registry
    const ReputationRegistry = await ethers.getContractFactory("ReputationRegistry");
    const reputation = await ReputationRegistry.deploy(
      await token.getAddress(),
      ethers.parseEther("100"),
      ethers.parseEther("10")
    );
    await reputation.waitForDeployment();
    
    // Deploy service registry
    const ServiceRegistry = await ethers.getContractFactory("ServiceRegistry");
    const registry = await ServiceRegistry.deploy(
      await token.getAddress(),
      await reputation.getAddress()
    );
    await registry.waitForDeployment();
    
    // Setup: Transfer tokens
    const tokenAddress = await token.getAddress();
    const registryAddress = await registry.getAddress();
    const reputationAddress = await reputation.getAddress();
    
    await token.connect(treasury).transfer(provider1.address, ethers.parseEther("100000"));
    await token.connect(treasury).transfer(provider2.address, ethers.parseEther("100000"));
    await token.connect(treasury).transfer(consumer1.address, ethers.parseEther("100000"));
    await token.connect(treasury).transfer(consumer2.address, ethers.parseEther("100000"));
    
    // Approve contracts
    await token.connect(provider1).approve(registryAddress, ethers.MaxUint256);
    await token.connect(provider2).approve(registryAddress, ethers.MaxUint256);
    await token.connect(consumer1).approve(registryAddress, ethers.MaxUint256);
    await token.connect(provider1).approve(reputationAddress, ethers.MaxUint256);
    await token.connect(provider2).approve(reputationAddress, ethers.MaxUint256);
    
    // Register providers in reputation system
    await reputation.connect(provider1).registerAgent("Provider1", "", ethers.parseEther("100"));
    await reputation.connect(provider2).registerAgent("Provider2", "", ethers.parseEther("100"));
    
    return {
      token,
      reputation,
      registry,
      owner,
      treasury,
      provider1,
      provider2,
      consumer1,
      consumer2,
      registryAddress
    };
  }

  describe("Deployment", function () {
    it("Should set correct token address", async function () {
      const { registry, token } = await loadFixture(deployServiceFixture);
      expect(await registry.synapseToken()).to.equal(await token.getAddress());
    });

    it("Should have default categories", async function () {
      const { registry } = await loadFixture(deployServiceFixture);
      
      // Check some default categories exist
      expect(await registry.categoryExists("language_model")).to.be.true;
      expect(await registry.categoryExists("image_generation")).to.be.true;
      expect(await registry.categoryExists("code_generation")).to.be.true;
    });
  });

  describe("Service Registration", function () {
    it("Should register new service", async function () {
      const { registry, provider1 } = await loadFixture(deployServiceFixture);
      
      await registry.connect(provider1).registerService(
        "GPT-Style-Agent",
        "language_model",
        "High-quality language model service",
        "https://api.provider1.ai/v1",
        ethers.parseEther("0.001"), // 0.001 SYNX per request
        0 // Per-request pricing
      );
      
      const services = await registry.getProviderServices(provider1.address);
      expect(services.length).to.equal(1);
      expect(services[0].name).to.equal("GPT-Style-Agent");
    });

    it("Should emit ServiceRegistered event", async function () {
      const { registry, provider1 } = await loadFixture(deployServiceFixture);
      
      await expect(
        registry.connect(provider1).registerService(
          "Test-Service",
          "language_model",
          "Test description",
          "https://api.test.ai",
          ethers.parseEther("0.01"),
          0
        )
      ).to.emit(registry, "ServiceRegistered");
    });

    it("Should fail with invalid category", async function () {
      const { registry, provider1 } = await loadFixture(deployServiceFixture);
      
      await expect(
        registry.connect(provider1).registerService(
          "Test-Service",
          "invalid_category",
          "Test",
          "https://test.ai",
          ethers.parseEther("0.01"),
          0
        )
      ).to.be.revertedWith("ServiceRegistry: invalid category");
    });

    it("Should fail with empty name", async function () {
      const { registry, provider1 } = await loadFixture(deployServiceFixture);
      
      await expect(
        registry.connect(provider1).registerService(
          "",
          "language_model",
          "Test",
          "https://test.ai",
          ethers.parseEther("0.01"),
          0
        )
      ).to.be.revertedWith("ServiceRegistry: empty name");
    });

    it("Should allow multiple services per provider", async function () {
      const { registry, provider1 } = await loadFixture(deployServiceFixture);
      
      await registry.connect(provider1).registerService(
        "Service-1", "language_model", "Desc 1", "https://s1.ai", ethers.parseEther("0.01"), 0
      );
      await registry.connect(provider1).registerService(
        "Service-2", "image_generation", "Desc 2", "https://s2.ai", ethers.parseEther("0.02"), 0
      );
      await registry.connect(provider1).registerService(
        "Service-3", "code_generation", "Desc 3", "https://s3.ai", ethers.parseEther("0.03"), 0
      );
      
      const services = await registry.getProviderServices(provider1.address);
      expect(services.length).to.equal(3);
    });

    it("Should enforce max services per provider", async function () {
      const { registry, provider1 } = await loadFixture(deployServiceFixture);
      
      // Register max services (100)
      for (let i = 0; i < 100; i++) {
        await registry.connect(provider1).registerService(
          `Service-${i}`,
          "language_model",
          `Desc ${i}`,
          `https://s${i}.ai`,
          ethers.parseEther("0.01"),
          0
        );
      }
      
      // 101st should fail
      await expect(
        registry.connect(provider1).registerService(
          "Service-101", "language_model", "Desc", "https://s101.ai", ethers.parseEther("0.01"), 0
        )
      ).to.be.revertedWith("ServiceRegistry: max services reached");
    });
  });

  describe("Service Updates", function () {
    async function registeredServiceFixture() {
      const base = await deployServiceFixture();
      const { registry, provider1 } = base;
      
      await registry.connect(provider1).registerService(
        "Test-Service",
        "language_model",
        "Original description",
        "https://original.ai",
        ethers.parseEther("0.01"),
        0
      );
      
      const services = await registry.getProviderServices(provider1.address);
      const serviceId = services[0].serviceId;
      
      return { ...base, serviceId };
    }

    it("Should update service description", async function () {
      const { registry, provider1, serviceId } = await loadFixture(registeredServiceFixture);
      
      await registry.connect(provider1).updateServiceDescription(serviceId, "Updated description");
      
      const service = await registry.services(serviceId);
      expect(service.description).to.equal("Updated description");
    });

    it("Should update service endpoint", async function () {
      const { registry, provider1, serviceId } = await loadFixture(registeredServiceFixture);
      
      await registry.connect(provider1).updateServiceEndpoint(serviceId, "https://new-endpoint.ai");
      
      const service = await registry.services(serviceId);
      expect(service.endpoint).to.equal("https://new-endpoint.ai");
    });

    it("Should update service price", async function () {
      const { registry, provider1, serviceId } = await loadFixture(registeredServiceFixture);
      
      const newPrice = ethers.parseEther("0.05");
      await registry.connect(provider1).updateServicePrice(serviceId, newPrice);
      
      const service = await registry.services(serviceId);
      expect(service.basePrice).to.equal(newPrice);
    });

    it("Should not allow non-owner to update service", async function () {
      const { registry, provider2, serviceId } = await loadFixture(registeredServiceFixture);
      
      await expect(
        registry.connect(provider2).updateServiceDescription(serviceId, "Hacked")
      ).to.be.revertedWith("ServiceRegistry: not service owner");
    });
  });

  describe("Service Activation", function () {
    async function registeredServiceFixture() {
      const base = await deployServiceFixture();
      const { registry, provider1 } = base;
      
      await registry.connect(provider1).registerService(
        "Test-Service", "language_model", "Desc", "https://test.ai", ethers.parseEther("0.01"), 0
      );
      
      const services = await registry.getProviderServices(provider1.address);
      return { ...base, serviceId: services[0].serviceId };
    }

    it("Should deactivate service", async function () {
      const { registry, provider1, serviceId } = await loadFixture(registeredServiceFixture);
      
      await registry.connect(provider1).deactivateService(serviceId);
      
      const service = await registry.services(serviceId);
      expect(service.active).to.be.false;
    });

    it("Should reactivate service", async function () {
      const { registry, provider1, serviceId } = await loadFixture(registeredServiceFixture);
      
      await registry.connect(provider1).deactivateService(serviceId);
      await registry.connect(provider1).activateService(serviceId);
      
      const service = await registry.services(serviceId);
      expect(service.active).to.be.true;
    });

    it("Should emit ServiceDeactivated event", async function () {
      const { registry, provider1, serviceId } = await loadFixture(registeredServiceFixture);
      
      await expect(registry.connect(provider1).deactivateService(serviceId))
        .to.emit(registry, "ServiceDeactivated")
        .withArgs(serviceId);
    });
  });

  describe("Volume Discounts", function () {
    async function registeredServiceFixture() {
      const base = await deployServiceFixture();
      const { registry, provider1 } = base;
      
      await registry.connect(provider1).registerService(
        "Test-Service", "language_model", "Desc", "https://test.ai", ethers.parseEther("1"), 0
      );
      
      const services = await registry.getProviderServices(provider1.address);
      return { ...base, serviceId: services[0].serviceId };
    }

    it("Should set volume discounts", async function () {
      const { registry, provider1, serviceId } = await loadFixture(registeredServiceFixture);
      
      const thresholds = [
        ethers.parseEther("100"),
        ethers.parseEther("1000"),
        ethers.parseEther("10000")
      ];
      const discounts = [500, 1000, 2000]; // 5%, 10%, 20%
      
      await registry.connect(provider1).setVolumeDiscounts(serviceId, thresholds, discounts);
      
      // Calculate price for different volumes
      const price1 = await registry.calculatePrice(serviceId, ethers.parseEther("50"));
      const price2 = await registry.calculatePrice(serviceId, ethers.parseEther("500"));
      const price3 = await registry.calculatePrice(serviceId, ethers.parseEther("5000"));
      
      // Higher volume should have lower per-unit price
      expect(price2 * 50n / 500n).to.be.lt(price1);
    });

    it("Should fail with mismatched arrays", async function () {
      const { registry, provider1, serviceId } = await loadFixture(registeredServiceFixture);
      
      await expect(
        registry.connect(provider1).setVolumeDiscounts(
          serviceId,
          [ethers.parseEther("100"), ethers.parseEther("1000")],
          [500] // Missing discount
        )
      ).to.be.revertedWith("ServiceRegistry: array mismatch");
    });
  });

  describe("Quoting System", function () {
    async function registeredServiceFixture() {
      const base = await deployServiceFixture();
      const { registry, provider1 } = base;
      
      await registry.connect(provider1).registerService(
        "Test-Service", "language_model", "Desc", "https://test.ai", ethers.parseEther("0.1"), 0
      );
      
      const services = await registry.getProviderServices(provider1.address);
      return { ...base, serviceId: services[0].serviceId };
    }

    it("Should request quote", async function () {
      const { registry, consumer1, serviceId } = await loadFixture(registeredServiceFixture);
      
      const tx = await registry.connect(consumer1).requestQuote(
        serviceId,
        100, // 100 units
        "0x" // empty specs
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(log => {
        try {
          return registry.interface.parseLog(log)?.name === "QuoteRequested";
        } catch { return false; }
      });
      
      expect(event).to.not.be.undefined;
    });

    it("Should accept valid quote", async function () {
      const { registry, token, provider1, consumer1, serviceId } = await loadFixture(registeredServiceFixture);
      
      // Request quote
      const tx = await registry.connect(consumer1).requestQuote(serviceId, 100, "0x");
      const receipt = await tx.wait();
      
      const event = receipt.logs.find(log => {
        try {
          return registry.interface.parseLog(log)?.name === "QuoteRequested";
        } catch { return false; }
      });
      const parsedEvent = registry.interface.parseLog(event);
      const quoteId = parsedEvent.args.quoteId;
      
      // Accept quote
      const consumerBalanceBefore = await token.balanceOf(consumer1.address);
      
      await registry.connect(consumer1).acceptQuote(quoteId);
      
      const consumerBalanceAfter = await token.balanceOf(consumer1.address);
      expect(consumerBalanceBefore - consumerBalanceAfter).to.be.gt(0);
    });

    it("Should fail to accept expired quote", async function () {
      const { registry, consumer1, serviceId } = await loadFixture(registeredServiceFixture);
      
      const tx = await registry.connect(consumer1).requestQuote(serviceId, 100, "0x");
      const receipt = await tx.wait();
      
      const event = receipt.logs.find(log => {
        try {
          return registry.interface.parseLog(log)?.name === "QuoteRequested";
        } catch { return false; }
      });
      const parsedEvent = registry.interface.parseLog(event);
      const quoteId = parsedEvent.args.quoteId;
      
      // Fast forward past expiry (1 hour)
      await time.increase(3601);
      
      await expect(
        registry.connect(consumer1).acceptQuote(quoteId)
      ).to.be.revertedWith("ServiceRegistry: quote expired");
    });
  });

  describe("Service Discovery", function () {
    async function multiServiceFixture() {
      const base = await deployServiceFixture();
      const { registry, provider1, provider2 } = base;
      
      // Register multiple services
      await registry.connect(provider1).registerService(
        "LLM-1", "language_model", "Desc", "https://llm1.ai", ethers.parseEther("0.01"), 0
      );
      await registry.connect(provider1).registerService(
        "Image-1", "image_generation", "Desc", "https://img1.ai", ethers.parseEther("0.02"), 0
      );
      await registry.connect(provider2).registerService(
        "LLM-2", "language_model", "Desc", "https://llm2.ai", ethers.parseEther("0.015"), 0
      );
      await registry.connect(provider2).registerService(
        "Code-1", "code_generation", "Desc", "https://code1.ai", ethers.parseEther("0.03"), 0
      );
      
      return base;
    }

    it("Should find services by category", async function () {
      const { registry } = await loadFixture(multiServiceFixture);
      
      const llmServices = await registry.getServicesByCategory("language_model");
      expect(llmServices.length).to.equal(2);
    });

    it("Should find services by provider", async function () {
      const { registry, provider1 } = await loadFixture(multiServiceFixture);
      
      const services = await registry.getProviderServices(provider1.address);
      expect(services.length).to.equal(2);
    });

    it("Should return only active services", async function () {
      const { registry, provider1 } = await loadFixture(multiServiceFixture);
      
      const services = await registry.getProviderServices(provider1.address);
      const serviceId = services[0].serviceId;
      
      await registry.connect(provider1).deactivateService(serviceId);
      
      const activeServices = await registry.getActiveServicesByCategory("language_model");
      expect(activeServices.length).to.equal(1); // Only LLM-2 should be active
    });

    it("Should return service count", async function () {
      const { registry } = await loadFixture(multiServiceFixture);
      
      const totalServices = await registry.getTotalServiceCount();
      expect(totalServices).to.equal(4);
    });
  });

  describe("Service Metrics", function () {
    async function registeredServiceFixture() {
      const base = await deployServiceFixture();
      const { registry, provider1, owner } = base;
      
      await registry.connect(provider1).registerService(
        "Test-Service", "language_model", "Desc", "https://test.ai", ethers.parseEther("0.1"), 0
      );
      
      const services = await registry.getProviderServices(provider1.address);
      
      // Grant metrics updater role
      const METRICS_ROLE = await registry.METRICS_ROLE();
      await registry.connect(owner).grantRole(METRICS_ROLE, owner.address);
      
      return { ...base, serviceId: services[0].serviceId, METRICS_ROLE };
    }

    it("Should update service metrics", async function () {
      const { registry, owner, serviceId } = await loadFixture(registeredServiceFixture);
      
      await registry.connect(owner).updateServiceMetrics(
        serviceId,
        150,   // avg response time (ms)
        9900,  // success rate (99.00%)
        9999   // uptime (99.99%)
      );
      
      const metrics = await registry.getServiceMetrics(serviceId);
      expect(metrics.avgResponseTime).to.equal(150);
      expect(metrics.successRate).to.equal(9900);
      expect(metrics.uptime).to.equal(9999);
    });

    it("Should track total requests", async function () {
      const { registry, owner, serviceId } = await loadFixture(registeredServiceFixture);
      
      // Simulate multiple metric updates (each representing requests)
      await registry.connect(owner).recordServiceUsage(serviceId, 100);
      await registry.connect(owner).recordServiceUsage(serviceId, 50);
      
      const metrics = await registry.getServiceMetrics(serviceId);
      expect(metrics.totalRequests).to.equal(150);
    });
  });

  describe("Category Management", function () {
    it("Should allow admin to add category", async function () {
      const { registry, owner } = await loadFixture(deployServiceFixture);
      
      await registry.connect(owner).addCategory("new_category", "New Category Description");
      
      expect(await registry.categoryExists("new_category")).to.be.true;
    });

    it("Should emit CategoryAdded event", async function () {
      const { registry, owner } = await loadFixture(deployServiceFixture);
      
      await expect(registry.connect(owner).addCategory("test_cat", "Test"))
        .to.emit(registry, "CategoryAdded")
        .withArgs("test_cat", "Test");
    });

    it("Should fail to add duplicate category", async function () {
      const { registry, owner } = await loadFixture(deployServiceFixture);
      
      await expect(
        registry.connect(owner).addCategory("language_model", "Duplicate")
      ).to.be.revertedWith("ServiceRegistry: category exists");
    });

    it("Should not allow non-admin to add category", async function () {
      const { registry, provider1 } = await loadFixture(deployServiceFixture);
      
      await expect(
        registry.connect(provider1).addCategory("hacked", "Hacked")
      ).to.be.reverted;
    });
  });

  describe("Pausable", function () {
    it("Should allow admin to pause", async function () {
      const { registry, owner } = await loadFixture(deployServiceFixture);
      
      await registry.connect(owner).pause();
      expect(await registry.paused()).to.be.true;
    });

    it("Should block service registration when paused", async function () {
      const { registry, owner, provider1 } = await loadFixture(deployServiceFixture);
      
      await registry.connect(owner).pause();
      
      await expect(
        registry.connect(provider1).registerService(
          "Test", "language_model", "Desc", "https://test.ai", ethers.parseEther("0.01"), 0
        )
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });
  });
});
