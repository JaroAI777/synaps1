const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("PaymentRouter", function () {
  async function deployPaymentFixture() {
    const [owner, treasury, agent1, agent2, agent3, arbiter, operator] = await ethers.getSigners();
    
    // Deploy token
    const SynapseToken = await ethers.getContractFactory("SynapseToken");
    const token = await SynapseToken.deploy(treasury.address);
    await token.waitForDeployment();
    
    // Deploy reputation registry (mock minimal version)
    const ReputationRegistry = await ethers.getContractFactory("ReputationRegistry");
    const reputation = await ReputationRegistry.deploy(
      await token.getAddress(),
      ethers.parseEther("100"), // min stake
      ethers.parseEther("10")  // registration fee
    );
    await reputation.waitForDeployment();
    
    // Deploy payment router
    const PaymentRouter = await ethers.getContractFactory("PaymentRouter");
    const router = await PaymentRouter.deploy(
      await token.getAddress(),
      await reputation.getAddress()
    );
    await router.waitForDeployment();
    
    // Setup: Transfer tokens to agents
    const tokenAddress = await token.getAddress();
    await token.connect(treasury).transfer(agent1.address, ethers.parseEther("100000"));
    await token.connect(treasury).transfer(agent2.address, ethers.parseEther("100000"));
    await token.connect(treasury).transfer(agent3.address, ethers.parseEther("100000"));
    
    // Approve router
    const routerAddress = await router.getAddress();
    await token.connect(agent1).approve(routerAddress, ethers.MaxUint256);
    await token.connect(agent2).approve(routerAddress, ethers.MaxUint256);
    await token.connect(agent3).approve(routerAddress, ethers.MaxUint256);
    
    return { 
      token, 
      reputation, 
      router, 
      owner, 
      treasury, 
      agent1, 
      agent2, 
      agent3, 
      arbiter,
      operator,
      routerAddress,
      tokenAddress
    };
  }

  describe("Deployment", function () {
    it("Should set correct token address", async function () {
      const { router, tokenAddress } = await loadFixture(deployPaymentFixture);
      expect(await router.synapseToken()).to.equal(tokenAddress);
    });

    it("Should set correct base fee", async function () {
      const { router } = await loadFixture(deployPaymentFixture);
      expect(await router.baseFeeBps()).to.equal(10); // 0.1%
    });
  });

  describe("Direct Payments", function () {
    it("Should process direct payment", async function () {
      const { router, token, agent1, agent2 } = await loadFixture(deployPaymentFixture);
      
      const amount = ethers.parseEther("1000");
      const balanceBefore = await token.balanceOf(agent2.address);
      
      await router.connect(agent1).pay(
        agent2.address,
        amount,
        ethers.encodeBytes32String("test-payment"),
        "0x"
      );
      
      const balanceAfter = await token.balanceOf(agent2.address);
      // Agent2 should receive amount minus fee (0.1%)
      const fee = amount * 10n / 10000n;
      expect(balanceAfter - balanceBefore).to.equal(amount - fee);
    });

    it("Should emit Payment event", async function () {
      const { router, agent1, agent2 } = await loadFixture(deployPaymentFixture);
      
      const amount = ethers.parseEther("1000");
      const paymentId = ethers.encodeBytes32String("test-payment");
      
      await expect(router.connect(agent1).pay(agent2.address, amount, paymentId, "0x"))
        .to.emit(router, "Payment")
        .withArgs(
          agent1.address, 
          agent2.address, 
          amount - (amount * 10n / 10000n),
          amount * 10n / 10000n,
          paymentId
        );
    });

    it("Should track agent statistics", async function () {
      const { router, agent1, agent2 } = await loadFixture(deployPaymentFixture);
      
      const amount = ethers.parseEther("1000");
      await router.connect(agent1).pay(
        agent2.address,
        amount,
        ethers.encodeBytes32String("payment-1"),
        "0x"
      );
      
      const stats = await router.agentStats(agent1.address);
      expect(stats.totalPaymentsSent).to.equal(1);
      expect(stats.totalVolumeSent).to.be.gt(0);
    });

    it("Should fail for zero amount", async function () {
      const { router, agent1, agent2 } = await loadFixture(deployPaymentFixture);
      
      await expect(
        router.connect(agent1).pay(agent2.address, 0, ethers.encodeBytes32String(""), "0x")
      ).to.be.revertedWith("PaymentRouter: zero amount");
    });

    it("Should fail for self-payment", async function () {
      const { router, agent1 } = await loadFixture(deployPaymentFixture);
      
      await expect(
        router.connect(agent1).pay(
          agent1.address, 
          ethers.parseEther("100"), 
          ethers.encodeBytes32String(""), 
          "0x"
        )
      ).to.be.revertedWith("PaymentRouter: self-payment");
    });
  });

  describe("Batch Payments", function () {
    it("Should process batch payments", async function () {
      const { router, token, agent1, agent2, agent3 } = await loadFixture(deployPaymentFixture);
      
      const recipients = [agent2.address, agent3.address];
      const amounts = [ethers.parseEther("500"), ethers.parseEther("300")];
      const paymentIds = [
        ethers.encodeBytes32String("batch-1"),
        ethers.encodeBytes32String("batch-2")
      ];
      
      const balance2Before = await token.balanceOf(agent2.address);
      const balance3Before = await token.balanceOf(agent3.address);
      
      await router.connect(agent1).batchPay(recipients, amounts, paymentIds, []);
      
      const balance2After = await token.balanceOf(agent2.address);
      const balance3After = await token.balanceOf(agent3.address);
      
      const fee1 = amounts[0] * 10n / 10000n;
      const fee2 = amounts[1] * 10n / 10000n;
      
      expect(balance2After - balance2Before).to.equal(amounts[0] - fee1);
      expect(balance3After - balance3Before).to.equal(amounts[1] - fee2);
    });

    it("Should emit BatchPayment event", async function () {
      const { router, agent1, agent2, agent3 } = await loadFixture(deployPaymentFixture);
      
      const recipients = [agent2.address, agent3.address];
      const amounts = [ethers.parseEther("500"), ethers.parseEther("300")];
      const paymentIds = [
        ethers.encodeBytes32String("batch-1"),
        ethers.encodeBytes32String("batch-2")
      ];
      
      await expect(router.connect(agent1).batchPay(recipients, amounts, paymentIds, []))
        .to.emit(router, "BatchPayment");
    });

    it("Should fail with mismatched arrays", async function () {
      const { router, agent1, agent2 } = await loadFixture(deployPaymentFixture);
      
      await expect(
        router.connect(agent1).batchPay(
          [agent2.address],
          [ethers.parseEther("100"), ethers.parseEther("200")],
          [],
          []
        )
      ).to.be.revertedWith("PaymentRouter: array mismatch");
    });
  });

  describe("Escrow Payments", function () {
    it("Should create escrow payment", async function () {
      const { router, agent1, agent2, arbiter } = await loadFixture(deployPaymentFixture);
      
      const amount = ethers.parseEther("1000");
      const deadline = (await time.latest()) + 86400; // 24 hours
      
      await router.connect(agent1).createEscrow(
        agent2.address,
        arbiter.address,
        amount,
        deadline,
        ethers.encodeBytes32String("escrow-1"),
        "0x"
      );
      
      // Verify escrow was created
      const escrowId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "bytes32", "uint256"],
          [agent1.address, agent2.address, ethers.encodeBytes32String("escrow-1"), deadline]
        )
      );
      
      const escrow = await router.escrows(escrowId);
      expect(escrow.sender).to.equal(agent1.address);
      expect(escrow.recipient).to.equal(agent2.address);
      expect(escrow.amount).to.equal(amount);
      expect(escrow.released).to.be.false;
    });

    it("Should allow sender to release escrow", async function () {
      const { router, token, agent1, agent2, arbiter } = await loadFixture(deployPaymentFixture);
      
      const amount = ethers.parseEther("1000");
      const deadline = (await time.latest()) + 86400;
      const paymentId = ethers.encodeBytes32String("escrow-release");
      
      await router.connect(agent1).createEscrow(
        agent2.address,
        arbiter.address,
        amount,
        deadline,
        paymentId,
        "0x"
      );
      
      const escrowId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "bytes32", "uint256"],
          [agent1.address, agent2.address, paymentId, deadline]
        )
      );
      
      const balanceBefore = await token.balanceOf(agent2.address);
      
      await router.connect(agent1).releaseEscrow(escrowId);
      
      const balanceAfter = await token.balanceOf(agent2.address);
      const fee = amount * 10n / 10000n;
      expect(balanceAfter - balanceBefore).to.equal(amount - fee);
    });

    it("Should allow arbiter to release escrow", async function () {
      const { router, token, agent1, agent2, arbiter } = await loadFixture(deployPaymentFixture);
      
      const amount = ethers.parseEther("1000");
      const deadline = (await time.latest()) + 86400;
      const paymentId = ethers.encodeBytes32String("arbiter-release");
      
      await router.connect(agent1).createEscrow(
        agent2.address,
        arbiter.address,
        amount,
        deadline,
        paymentId,
        "0x"
      );
      
      const escrowId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "bytes32", "uint256"],
          [agent1.address, agent2.address, paymentId, deadline]
        )
      );
      
      const balanceBefore = await token.balanceOf(agent2.address);
      
      await router.connect(arbiter).releaseEscrow(escrowId);
      
      const balanceAfter = await token.balanceOf(agent2.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should allow refund after deadline", async function () {
      const { router, token, agent1, agent2, arbiter } = await loadFixture(deployPaymentFixture);
      
      const amount = ethers.parseEther("1000");
      const deadline = (await time.latest()) + 3600; // 1 hour
      const paymentId = ethers.encodeBytes32String("refund-test");
      
      const balanceBeforeEscrow = await token.balanceOf(agent1.address);
      
      await router.connect(agent1).createEscrow(
        agent2.address,
        arbiter.address,
        amount,
        deadline,
        paymentId,
        "0x"
      );
      
      const escrowId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "bytes32", "uint256"],
          [agent1.address, agent2.address, paymentId, deadline]
        )
      );
      
      // Fast forward past deadline
      await time.increase(3601);
      
      await router.connect(agent1).refundEscrow(escrowId);
      
      const balanceAfterRefund = await token.balanceOf(agent1.address);
      // Should get refund minus any fees
      expect(balanceAfterRefund).to.be.closeTo(balanceBeforeEscrow, ethers.parseEther("10"));
    });

    it("Should fail refund before deadline", async function () {
      const { router, agent1, agent2, arbiter } = await loadFixture(deployPaymentFixture);
      
      const amount = ethers.parseEther("1000");
      const deadline = (await time.latest()) + 86400;
      const paymentId = ethers.encodeBytes32String("early-refund");
      
      await router.connect(agent1).createEscrow(
        agent2.address,
        arbiter.address,
        amount,
        deadline,
        paymentId,
        "0x"
      );
      
      const escrowId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "bytes32", "uint256"],
          [agent1.address, agent2.address, paymentId, deadline]
        )
      );
      
      await expect(
        router.connect(agent1).refundEscrow(escrowId)
      ).to.be.revertedWith("PaymentRouter: deadline not passed");
    });
  });

  describe("Payment Streams", function () {
    it("Should create payment stream", async function () {
      const { router, agent1, agent2 } = await loadFixture(deployPaymentFixture);
      
      const totalAmount = ethers.parseEther("10000");
      const duration = 86400; // 24 hours
      const startTime = await time.latest();
      
      await router.connect(agent1).createStream(
        agent2.address,
        totalAmount,
        startTime,
        startTime + duration
      );
      
      const streamId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256", "uint256"],
          [agent1.address, agent2.address, startTime, startTime + duration]
        )
      );
      
      const stream = await router.streams(streamId);
      expect(stream.sender).to.equal(agent1.address);
      expect(stream.recipient).to.equal(agent2.address);
      expect(stream.totalAmount).to.equal(totalAmount);
    });

    it("Should allow withdrawal from stream", async function () {
      const { router, token, agent1, agent2 } = await loadFixture(deployPaymentFixture);
      
      const totalAmount = ethers.parseEther("10000");
      const duration = 86400;
      const startTime = await time.latest();
      
      await router.connect(agent1).createStream(
        agent2.address,
        totalAmount,
        startTime,
        startTime + duration
      );
      
      const streamId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256", "uint256"],
          [agent1.address, agent2.address, startTime, startTime + duration]
        )
      );
      
      // Fast forward 50%
      await time.increase(duration / 2);
      
      const balanceBefore = await token.balanceOf(agent2.address);
      
      await router.connect(agent2).withdrawFromStream(streamId);
      
      const balanceAfter = await token.balanceOf(agent2.address);
      // Should receive approximately 50% (minus fees)
      const expectedMin = totalAmount / 2n - ethers.parseEther("100"); // Allow some variance
      expect(balanceAfter - balanceBefore).to.be.gt(expectedMin);
    });

    it("Should allow sender to cancel stream", async function () {
      const { router, token, agent1, agent2 } = await loadFixture(deployPaymentFixture);
      
      const totalAmount = ethers.parseEther("10000");
      const duration = 86400;
      const startTime = await time.latest();
      
      const balanceBeforeStream = await token.balanceOf(agent1.address);
      
      await router.connect(agent1).createStream(
        agent2.address,
        totalAmount,
        startTime,
        startTime + duration
      );
      
      const streamId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256", "uint256"],
          [agent1.address, agent2.address, startTime, startTime + duration]
        )
      );
      
      // Fast forward 25%
      await time.increase(duration / 4);
      
      await router.connect(agent1).cancelStream(streamId);
      
      // Sender should get back ~75% of funds
      const balanceAfterCancel = await token.balanceOf(agent1.address);
      const expectedRefund = totalAmount * 3n / 4n;
      expect(balanceAfterCancel).to.be.closeTo(
        balanceBeforeStream - totalAmount + expectedRefund,
        ethers.parseEther("100")
      );
    });
  });

  describe("Gasless Payments (Meta-transactions)", function () {
    it("Should process gasless payment with valid signature", async function () {
      const { router, token, agent1, agent2, operator, routerAddress } = await loadFixture(deployPaymentFixture);
      
      const amount = ethers.parseEther("1000");
      const nonce = await router.nonces(agent1.address);
      const deadline = (await time.latest()) + 3600;
      const paymentId = ethers.encodeBytes32String("gasless-1");
      
      // Create signature
      const domain = {
        name: "SYNAPSE PaymentRouter",
        version: "1",
        chainId: 31337,
        verifyingContract: routerAddress
      };
      
      const types = {
        GaslessPayment: [
          { name: "sender", type: "address" },
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "paymentId", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };
      
      const message = {
        sender: agent1.address,
        recipient: agent2.address,
        amount: amount,
        paymentId: paymentId,
        nonce: nonce,
        deadline: deadline
      };
      
      const signature = await agent1.signTypedData(domain, types, message);
      
      const balanceBefore = await token.balanceOf(agent2.address);
      
      // Operator executes the payment
      await router.connect(operator).gaslessPay(
        agent1.address,
        agent2.address,
        amount,
        paymentId,
        deadline,
        signature
      );
      
      const balanceAfter = await token.balanceOf(agent2.address);
      const fee = amount * 10n / 10000n;
      expect(balanceAfter - balanceBefore).to.equal(amount - fee);
    });

    it("Should fail with expired deadline", async function () {
      const { router, agent1, agent2, operator, routerAddress } = await loadFixture(deployPaymentFixture);
      
      const amount = ethers.parseEther("1000");
      const nonce = await router.nonces(agent1.address);
      const deadline = (await time.latest()) - 1; // Already expired
      const paymentId = ethers.encodeBytes32String("expired");
      
      const domain = {
        name: "SYNAPSE PaymentRouter",
        version: "1",
        chainId: 31337,
        verifyingContract: routerAddress
      };
      
      const types = {
        GaslessPayment: [
          { name: "sender", type: "address" },
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "paymentId", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };
      
      const message = {
        sender: agent1.address,
        recipient: agent2.address,
        amount: amount,
        paymentId: paymentId,
        nonce: nonce,
        deadline: deadline
      };
      
      const signature = await agent1.signTypedData(domain, types, message);
      
      await expect(
        router.connect(operator).gaslessPay(
          agent1.address,
          agent2.address,
          amount,
          paymentId,
          deadline,
          signature
        )
      ).to.be.revertedWith("PaymentRouter: expired deadline");
    });

    it("Should fail with invalid signature", async function () {
      const { router, agent1, agent2, agent3, operator } = await loadFixture(deployPaymentFixture);
      
      const amount = ethers.parseEther("1000");
      const deadline = (await time.latest()) + 3600;
      const paymentId = ethers.encodeBytes32String("invalid-sig");
      
      // Use wrong signer (agent3 instead of agent1)
      const wrongSignature = await agent3.signMessage("wrong");
      
      await expect(
        router.connect(operator).gaslessPay(
          agent1.address,
          agent2.address,
          amount,
          paymentId,
          deadline,
          wrongSignature
        )
      ).to.be.reverted;
    });
  });

  describe("Fee Management", function () {
    it("Should allow admin to update base fee", async function () {
      const { router, owner } = await loadFixture(deployPaymentFixture);
      
      await router.connect(owner).setBaseFee(20); // 0.2%
      expect(await router.baseFeeBps()).to.equal(20);
    });

    it("Should collect fees to treasury", async function () {
      const { router, token, owner, agent1, agent2 } = await loadFixture(deployPaymentFixture);
      
      // Set treasury
      const treasuryAddress = owner.address;
      await router.connect(owner).setTreasury(treasuryAddress);
      
      const treasuryBalanceBefore = await token.balanceOf(treasuryAddress);
      
      const amount = ethers.parseEther("10000");
      await router.connect(agent1).pay(
        agent2.address,
        amount,
        ethers.encodeBytes32String("fee-test"),
        "0x"
      );
      
      const treasuryBalanceAfter = await token.balanceOf(treasuryAddress);
      const expectedFee = amount * 10n / 10000n;
      
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedFee);
    });
  });

  describe("Pausable", function () {
    it("Should allow admin to pause", async function () {
      const { router, owner } = await loadFixture(deployPaymentFixture);
      
      await router.connect(owner).pause();
      expect(await router.paused()).to.be.true;
    });

    it("Should block payments when paused", async function () {
      const { router, owner, agent1, agent2 } = await loadFixture(deployPaymentFixture);
      
      await router.connect(owner).pause();
      
      await expect(
        router.connect(agent1).pay(
          agent2.address,
          ethers.parseEther("100"),
          ethers.encodeBytes32String(""),
          "0x"
        )
      ).to.be.revertedWithCustomError(router, "EnforcedPause");
    });
  });
});
