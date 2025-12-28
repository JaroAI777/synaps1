const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SynapseBridge", function () {
  let bridge;
  let token;
  let owner, validator1, validator2, validator3, user1, user2, feeCollector;
  
  const DAY = 86400;
  const CHAIN_ID = 1; // Mainnet
  const DEST_CHAIN = 42161; // Arbitrum

  beforeEach(async function () {
    [owner, validator1, validator2, validator3, user1, user2, feeCollector] = await ethers.getSigners();

    // Deploy token
    const Token = await ethers.getContractFactory("SynapseToken");
    token = await Token.deploy(
      "SYNAPSE",
      "SYNX",
      ethers.parseEther("1000000000"),
      owner.address,
      owner.address
    );

    // Deploy bridge
    const Bridge = await ethers.getContractFactory("SynapseBridge");
    bridge = await Bridge.deploy(
      await token.getAddress(),
      CHAIN_ID,
      feeCollector.address,
      2 // Required validations
    );

    // Setup tokens
    await token.transfer(user1.address, ethers.parseEther("100000"));
    await token.transfer(user2.address, ethers.parseEther("100000"));

    // Approve bridge
    await token.connect(user1).approve(await bridge.getAddress(), ethers.MaxUint256);
    await token.connect(user2).approve(await bridge.getAddress(), ethers.MaxUint256);

    // Add validators
    await bridge.addValidator(validator1.address);
    await bridge.addValidator(validator2.address);
    await bridge.addValidator(validator3.address);

    // Configure destination chain
    await bridge.setChainConfig(
      DEST_CHAIN,
      true, // supported
      ethers.parseEther("10"), // minAmount
      ethers.parseEther("100000"), // maxAmount
      ethers.parseEther("1000000"), // dailyLimit
      100, // 1% fee
      ethers.ZeroAddress // bridgeContract (not used here)
    );

    // Add liquidity to bridge
    await token.approve(await bridge.getAddress(), ethers.parseEther("1000000"));
    await bridge.addLiquidity(ethers.parseEther("1000000"));
  });

  describe("Bridge Initiation", function () {
    it("Should initiate bridge transfer", async function () {
      const tx = await bridge.connect(user1).bridge(
        user2.address,
        ethers.parseEther("1000"),
        DEST_CHAIN
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => bridge.interface.parseLog(log)?.name === "BridgeInitiated"
      );

      expect(event).to.not.be.undefined;
      
      const parsedEvent = bridge.interface.parseLog(event);
      expect(parsedEvent.args.sender).to.equal(user1.address);
      expect(parsedEvent.args.recipient).to.equal(user2.address);
      // Amount after 1% fee
      expect(parsedEvent.args.amount).to.equal(ethers.parseEther("990"));
    });

    it("Should reject bridge below minimum", async function () {
      await expect(
        bridge.connect(user1).bridge(user2.address, ethers.parseEther("5"), DEST_CHAIN)
      ).to.be.revertedWith("Below minimum");
    });

    it("Should reject bridge above maximum", async function () {
      await token.transfer(user1.address, ethers.parseEther("200000"));
      await expect(
        bridge.connect(user1).bridge(user2.address, ethers.parseEther("150000"), DEST_CHAIN)
      ).to.be.revertedWith("Above maximum");
    });

    it("Should reject unsupported chain", async function () {
      await expect(
        bridge.connect(user1).bridge(user2.address, ethers.parseEther("100"), 999999)
      ).to.be.revertedWith("Chain not supported");
    });

    it("Should enforce daily limit", async function () {
      // Set a lower daily limit
      await bridge.setChainConfig(
        DEST_CHAIN,
        true,
        ethers.parseEther("10"),
        ethers.parseEther("100000"),
        ethers.parseEther("1500"), // 1500 daily limit
        100,
        ethers.ZeroAddress
      );

      // First bridge should succeed
      await bridge.connect(user1).bridge(user2.address, ethers.parseEther("1000"), DEST_CHAIN);

      // Second bridge should fail (exceeds daily limit)
      await expect(
        bridge.connect(user1).bridge(user2.address, ethers.parseEther("1000"), DEST_CHAIN)
      ).to.be.revertedWith("Daily limit exceeded");
    });

    it("Should reset daily limit after 24 hours", async function () {
      await bridge.setChainConfig(
        DEST_CHAIN,
        true,
        ethers.parseEther("10"),
        ethers.parseEther("100000"),
        ethers.parseEther("1500"),
        100,
        ethers.ZeroAddress
      );

      await bridge.connect(user1).bridge(user2.address, ethers.parseEther("1000"), DEST_CHAIN);

      // Fast forward 24 hours
      await time.increase(DAY + 1);

      // Should succeed after reset
      await bridge.connect(user1).bridge(user2.address, ethers.parseEther("1000"), DEST_CHAIN);
    });
  });

  describe("Validation", function () {
    let requestId;

    beforeEach(async function () {
      const tx = await bridge.connect(user1).bridge(
        user2.address,
        ethers.parseEther("1000"),
        DEST_CHAIN
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => bridge.interface.parseLog(log)?.name === "BridgeInitiated"
      );
      requestId = bridge.interface.parseLog(event).args.requestId;
    });

    it("Should validate bridge request", async function () {
      await bridge.connect(validator1).validateBridge(requestId);

      const count = await bridge.validationCount(requestId);
      expect(count).to.equal(1n);
    });

    it("Should not allow double validation", async function () {
      await bridge.connect(validator1).validateBridge(requestId);

      await expect(
        bridge.connect(validator1).validateBridge(requestId)
      ).to.be.revertedWith("Already validated");
    });

    it("Should mark as validated after required validations", async function () {
      await bridge.connect(validator1).validateBridge(requestId);
      await bridge.connect(validator2).validateBridge(requestId);

      const request = await bridge.requests(requestId);
      expect(request.status).to.equal(1); // VALIDATED
    });

    it("Should batch validate multiple requests", async function () {
      // Create second request
      const tx2 = await bridge.connect(user1).bridge(
        user2.address,
        ethers.parseEther("500"),
        DEST_CHAIN
      );
      const receipt2 = await tx2.wait();
      const event2 = receipt2.logs.find(
        log => bridge.interface.parseLog(log)?.name === "BridgeInitiated"
      );
      const requestId2 = bridge.interface.parseLog(event2).args.requestId;

      await bridge.connect(validator1).batchValidate([requestId, requestId2]);

      expect(await bridge.validationCount(requestId)).to.equal(1n);
      expect(await bridge.validationCount(requestId2)).to.equal(1n);
    });
  });

  describe("Incoming Transfers", function () {
    it("Should process incoming bridge transfer", async function () {
      const sourceRequestId = ethers.keccak256(ethers.toUtf8Bytes("source-request-1"));
      const amount = ethers.parseEther("500");

      // Create signatures
      const message = ethers.solidityPackedKeccak256(
        ["bytes32", "address", "uint256", "uint256", "uint256"],
        [sourceRequestId, user2.address, amount, DEST_CHAIN, CHAIN_ID]
      );

      const sig1 = await validator1.signMessage(ethers.getBytes(message));
      const sig2 = await validator2.signMessage(ethers.getBytes(message));

      const balanceBefore = await token.balanceOf(user2.address);

      // Grant relayer role
      const RELAYER_ROLE = await bridge.RELAYER_ROLE();
      await bridge.grantRole(RELAYER_ROLE, owner.address);

      await bridge.processIncoming(
        sourceRequestId,
        user2.address,
        amount,
        DEST_CHAIN,
        [
          { validator: validator1.address, signature: sig1 },
          { validator: validator2.address, signature: sig2 }
        ]
      );

      const balanceAfter = await token.balanceOf(user2.address);
      expect(balanceAfter - balanceBefore).to.equal(amount);
    });

    it("Should reject duplicate incoming transfer", async function () {
      const sourceRequestId = ethers.keccak256(ethers.toUtf8Bytes("source-request-2"));
      const amount = ethers.parseEther("500");

      const message = ethers.solidityPackedKeccak256(
        ["bytes32", "address", "uint256", "uint256", "uint256"],
        [sourceRequestId, user2.address, amount, DEST_CHAIN, CHAIN_ID]
      );

      const sig1 = await validator1.signMessage(ethers.getBytes(message));
      const sig2 = await validator2.signMessage(ethers.getBytes(message));

      const RELAYER_ROLE = await bridge.RELAYER_ROLE();
      await bridge.grantRole(RELAYER_ROLE, owner.address);

      await bridge.processIncoming(
        sourceRequestId,
        user2.address,
        amount,
        DEST_CHAIN,
        [
          { validator: validator1.address, signature: sig1 },
          { validator: validator2.address, signature: sig2 }
        ]
      );

      await expect(
        bridge.processIncoming(
          sourceRequestId,
          user2.address,
          amount,
          DEST_CHAIN,
          [
            { validator: validator1.address, signature: sig1 },
            { validator: validator2.address, signature: sig2 }
          ]
        )
      ).to.be.revertedWith("Already processed");
    });

    it("Should reject with insufficient signatures", async function () {
      const sourceRequestId = ethers.keccak256(ethers.toUtf8Bytes("source-request-3"));
      const amount = ethers.parseEther("500");

      const message = ethers.solidityPackedKeccak256(
        ["bytes32", "address", "uint256", "uint256", "uint256"],
        [sourceRequestId, user2.address, amount, DEST_CHAIN, CHAIN_ID]
      );

      const sig1 = await validator1.signMessage(ethers.getBytes(message));

      const RELAYER_ROLE = await bridge.RELAYER_ROLE();
      await bridge.grantRole(RELAYER_ROLE, owner.address);

      await expect(
        bridge.processIncoming(
          sourceRequestId,
          user2.address,
          amount,
          DEST_CHAIN,
          [{ validator: validator1.address, signature: sig1 }]
        )
      ).to.be.revertedWith("Insufficient signatures");
    });
  });

  describe("Refunds", function () {
    let requestId;

    beforeEach(async function () {
      const tx = await bridge.connect(user1).bridge(
        user2.address,
        ethers.parseEther("1000"),
        DEST_CHAIN
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => bridge.interface.parseLog(log)?.name === "BridgeInitiated"
      );
      requestId = bridge.interface.parseLog(event).args.requestId;
    });

    it("Should refund expired request", async function () {
      // Fast forward past expiry (7 days)
      await time.increase(7 * DAY + 1);

      const balanceBefore = await token.balanceOf(user1.address);

      await bridge.connect(user1).refund(requestId);

      const balanceAfter = await token.balanceOf(user1.address);
      // Should receive amount minus fee (990)
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("990"));
    });

    it("Should not refund before expiry", async function () {
      await expect(
        bridge.connect(user1).refund(requestId)
      ).to.be.revertedWith("Not expired");
    });
  });

  describe("Validator Management", function () {
    it("Should add validator", async function () {
      const newValidator = user1;
      await bridge.addValidator(newValidator.address);

      expect(await bridge.isValidator(newValidator.address)).to.be.true;
    });

    it("Should remove validator", async function () {
      await bridge.removeValidator(validator3.address);

      expect(await bridge.isValidator(validator3.address)).to.be.false;
    });

    it("Should not remove if below required validations", async function () {
      await bridge.removeValidator(validator3.address);

      await expect(
        bridge.removeValidator(validator2.address)
      ).to.be.revertedWith("Cannot remove");
    });

    it("Should update required validations", async function () {
      await bridge.setRequiredValidations(3);

      expect(await bridge.requiredValidations()).to.equal(3n);
    });
  });

  describe("Fee Management", function () {
    it("Should collect fees", async function () {
      const balanceBefore = await token.balanceOf(feeCollector.address);

      await bridge.connect(user1).bridge(
        user2.address,
        ethers.parseEther("1000"),
        DEST_CHAIN
      );

      const balanceAfter = await token.balanceOf(feeCollector.address);
      // 1% fee = 10 SYNX
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("10"));
    });

    it("Should estimate fee correctly", async function () {
      const fee = await bridge.estimateFee(ethers.parseEther("1000"), DEST_CHAIN);
      expect(fee).to.equal(ethers.parseEther("10")); // 1%
    });
  });

  describe("Statistics", function () {
    it("Should track statistics", async function () {
      await bridge.connect(user1).bridge(
        user2.address,
        ethers.parseEther("1000"),
        DEST_CHAIN
      );

      const stats = await bridge.getStatistics();
      expect(stats._totalBridgedOut).to.equal(ethers.parseEther("990"));
      expect(stats._totalFees).to.equal(ethers.parseEther("10"));
    });

    it("Should get supported chains", async function () {
      const chains = await bridge.getSupportedChains();
      expect(chains.length).to.equal(1);
      expect(chains[0]).to.equal(BigInt(DEST_CHAIN));
    });

    it("Should get validators", async function () {
      const validators = await bridge.getValidators();
      expect(validators.length).to.equal(3);
    });
  });

  describe("Admin Functions", function () {
    it("Should pause and unpause", async function () {
      await bridge.pause();

      await expect(
        bridge.connect(user1).bridge(user2.address, ethers.parseEther("100"), DEST_CHAIN)
      ).to.be.revertedWithCustomError(bridge, "EnforcedPause");

      await bridge.unpause();

      await bridge.connect(user1).bridge(user2.address, ethers.parseEther("100"), DEST_CHAIN);
    });

    it("Should update chain config", async function () {
      await bridge.setChainConfig(
        DEST_CHAIN,
        true,
        ethers.parseEther("100"), // New min
        ethers.parseEther("50000"), // New max
        ethers.parseEther("500000"), // New daily limit
        50, // New fee 0.5%
        ethers.ZeroAddress
      );

      const config = await bridge.chainConfigs(DEST_CHAIN);
      expect(config.minAmount).to.equal(ethers.parseEther("100"));
      expect(config.bridgeFee).to.equal(50n);
    });
  });
});
