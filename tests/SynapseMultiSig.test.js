const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SynapseMultiSig", function () {
  let multiSig, token;
  let owner1, owner2, owner3, nonOwner, recipient;
  
  const INITIAL_SUPPLY = ethers.parseEther("1000000000");
  const DAY = 86400;

  beforeEach(async function () {
    [owner1, owner2, owner3, nonOwner, recipient] = await ethers.getSigners();

    // Deploy token
    const Token = await ethers.getContractFactory("SynapseToken");
    token = await Token.deploy("SYNAPSE", "SYNX", INITIAL_SUPPLY, owner1.address, owner1.address);

    // Deploy multiSig with 3 owners, 2 threshold
    const MultiSig = await ethers.getContractFactory("SynapseMultiSig");
    multiSig = await MultiSig.deploy(
      [owner1.address, owner2.address, owner3.address],
      2 // 2-of-3 threshold
    );

    // Fund multiSig with ETH and tokens
    await owner1.sendTransaction({
      to: await multiSig.getAddress(),
      value: ethers.parseEther("100")
    });

    await token.transfer(await multiSig.getAddress(), ethers.parseEther("100000"));
  });

  describe("Deployment", function () {
    it("Should set correct owners", async function () {
      const owners = await multiSig.getOwners();
      expect(owners.length).to.equal(3);
      expect(owners).to.include(owner1.address);
      expect(owners).to.include(owner2.address);
      expect(owners).to.include(owner3.address);
    });

    it("Should set correct threshold", async function () {
      expect(await multiSig.threshold()).to.equal(2n);
    });

    it("Should receive ETH", async function () {
      const balance = await ethers.provider.getBalance(await multiSig.getAddress());
      expect(balance).to.equal(ethers.parseEther("100"));
    });

    it("Should reject empty owners array", async function () {
      const MultiSig = await ethers.getContractFactory("SynapseMultiSig");
      await expect(
        MultiSig.deploy([], 1)
      ).to.be.revertedWith("Owners required");
    });

    it("Should reject invalid threshold", async function () {
      const MultiSig = await ethers.getContractFactory("SynapseMultiSig");
      await expect(
        MultiSig.deploy([owner1.address], 2)
      ).to.be.revertedWith("Invalid threshold");
    });
  });

  describe("Transaction Submission", function () {
    it("Should allow owner to submit transaction", async function () {
      const tx = await multiSig.connect(owner1).submitTransaction(
        recipient.address,
        ethers.parseEther("1"),
        "0x",
        "Test transfer"
      );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);

      expect(await multiSig.getTransactionCount()).to.equal(1n);
    });

    it("Should auto-confirm by submitter", async function () {
      await multiSig.connect(owner1).submitTransaction(
        recipient.address,
        ethers.parseEther("1"),
        "0x",
        "Test transfer"
      );

      const isConfirmed = await multiSig.isConfirmed(0, owner1.address);
      expect(isConfirmed).to.be.true;
    });

    it("Should reject non-owner submission", async function () {
      await expect(
        multiSig.connect(nonOwner).submitTransaction(
          recipient.address,
          ethers.parseEther("1"),
          "0x",
          "Test"
        )
      ).to.be.revertedWith("Not an owner");
    });
  });

  describe("Confirmation", function () {
    beforeEach(async function () {
      await multiSig.connect(owner1).submitTransaction(
        recipient.address,
        ethers.parseEther("1"),
        "0x",
        "Test transfer"
      );
    });

    it("Should allow owner to confirm", async function () {
      await multiSig.connect(owner2).confirmTransaction(0);

      const isConfirmed = await multiSig.isConfirmed(0, owner2.address);
      expect(isConfirmed).to.be.true;
    });

    it("Should auto-execute when threshold reached", async function () {
      const balanceBefore = await ethers.provider.getBalance(recipient.address);

      await multiSig.connect(owner2).confirmTransaction(0);

      const balanceAfter = await ethers.provider.getBalance(recipient.address);
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("1"));

      const txn = await multiSig.getTransaction(0);
      expect(txn.executed).to.be.true;
    });

    it("Should reject double confirmation", async function () {
      await expect(
        multiSig.connect(owner1).confirmTransaction(0)
      ).to.be.revertedWith("Already confirmed");
    });

    it("Should reject confirmation of non-existent tx", async function () {
      await expect(
        multiSig.connect(owner2).confirmTransaction(999)
      ).to.be.revertedWith("Transaction does not exist");
    });
  });

  describe("Revocation", function () {
    beforeEach(async function () {
      await multiSig.connect(owner1).submitTransaction(
        recipient.address,
        ethers.parseEther("1"),
        "0x",
        "Test transfer"
      );
    });

    it("Should allow revoking confirmation", async function () {
      await multiSig.connect(owner1).revokeConfirmation(0);

      const isConfirmed = await multiSig.isConfirmed(0, owner1.address);
      expect(isConfirmed).to.be.false;

      const txn = await multiSig.getTransaction(0);
      expect(txn.numConfirmations).to.equal(0n);
    });

    it("Should reject revoking non-confirmed tx", async function () {
      await expect(
        multiSig.connect(owner2).revokeConfirmation(0)
      ).to.be.revertedWith("Not confirmed");
    });
  });

  describe("Execution", function () {
    it("Should execute when manually triggered after threshold", async function () {
      // Submit without auto-execute by having submitter revoke
      await multiSig.connect(owner1).submitTransaction(
        recipient.address,
        ethers.parseEther("1"),
        "0x",
        "Test transfer"
      );

      await multiSig.connect(owner2).confirmTransaction(0);

      // Should already be executed (auto-execute)
      const txn = await multiSig.getTransaction(0);
      expect(txn.executed).to.be.true;
    });

    it("Should reject execution without enough confirmations", async function () {
      await multiSig.connect(owner1).submitTransaction(
        recipient.address,
        ethers.parseEther("1"),
        "0x",
        "Test transfer"
      );

      await multiSig.connect(owner1).revokeConfirmation(0);

      await expect(
        multiSig.connect(owner1).executeTransaction(0)
      ).to.be.revertedWith("Not enough confirmations");
    });
  });

  describe("Quick Transfers", function () {
    it("Should allow quick ETH transfer within daily limit", async function () {
      const balanceBefore = await ethers.provider.getBalance(recipient.address);

      await multiSig.connect(owner1).quickTransferETH(
        recipient.address,
        ethers.parseEther("1")
      );

      const balanceAfter = await ethers.provider.getBalance(recipient.address);
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("1"));
    });

    it("Should track daily spending", async function () {
      await multiSig.connect(owner1).quickTransferETH(
        recipient.address,
        ethers.parseEther("50")
      );

      const remaining = await multiSig.getRemainingDailyLimit(ethers.ZeroAddress);
      expect(remaining).to.equal(ethers.parseEther("50"));
    });

    it("Should reject transfer exceeding daily limit", async function () {
      await multiSig.connect(owner1).quickTransferETH(
        recipient.address,
        ethers.parseEther("100")
      );

      await expect(
        multiSig.connect(owner1).quickTransferETH(
          recipient.address,
          ethers.parseEther("1")
        )
      ).to.be.revertedWith("Daily limit exceeded");
    });

    it("Should reset daily limit after 24 hours", async function () {
      await multiSig.connect(owner1).quickTransferETH(
        recipient.address,
        ethers.parseEther("100")
      );

      // Fast forward 1 day
      await time.increase(DAY + 1);

      const remaining = await multiSig.getRemainingDailyLimit(ethers.ZeroAddress);
      expect(remaining).to.equal(ethers.parseEther("100"));
    });
  });

  describe("Owner Management", function () {
    it("Should add owner via multisig tx", async function () {
      const addOwnerData = multiSig.interface.encodeFunctionData("addOwner", [nonOwner.address]);

      await multiSig.connect(owner1).submitTransaction(
        await multiSig.getAddress(),
        0,
        addOwnerData,
        "Add new owner"
      );

      await multiSig.connect(owner2).confirmTransaction(0);

      expect(await multiSig.isOwner(nonOwner.address)).to.be.true;
    });

    it("Should remove owner via multisig tx", async function () {
      const removeOwnerData = multiSig.interface.encodeFunctionData("removeOwner", [owner3.address]);

      await multiSig.connect(owner1).submitTransaction(
        await multiSig.getAddress(),
        0,
        removeOwnerData,
        "Remove owner"
      );

      await multiSig.connect(owner2).confirmTransaction(0);

      expect(await multiSig.isOwner(owner3.address)).to.be.false;
    });

    it("Should change threshold via multisig tx", async function () {
      const changeThresholdData = multiSig.interface.encodeFunctionData("changeThreshold", [3]);

      await multiSig.connect(owner1).submitTransaction(
        await multiSig.getAddress(),
        0,
        changeThresholdData,
        "Change threshold"
      );

      await multiSig.connect(owner2).confirmTransaction(0);

      expect(await multiSig.threshold()).to.equal(3n);
    });
  });

  describe("View Functions", function () {
    it("Should return pending transactions", async function () {
      await multiSig.connect(owner1).submitTransaction(
        recipient.address,
        ethers.parseEther("1"),
        "0x",
        "Test 1"
      );

      await multiSig.connect(owner1).revokeConfirmation(0);

      await multiSig.connect(owner1).submitTransaction(
        recipient.address,
        ethers.parseEther("2"),
        "0x",
        "Test 2"
      );

      await multiSig.connect(owner1).revokeConfirmation(1);

      const pending = await multiSig.getPendingTransactions();
      expect(pending.length).to.equal(2);
    });

    it("Should return confirmations for transaction", async function () {
      await multiSig.connect(owner1).submitTransaction(
        recipient.address,
        ethers.parseEther("1"),
        "0x",
        "Test"
      );

      await multiSig.connect(owner1).revokeConfirmation(0);
      await multiSig.connect(owner2).confirmTransaction(0);
      await multiSig.connect(owner3).confirmTransaction(0);

      const confirmations = await multiSig.getConfirmations(0);
      expect(confirmations.length).to.equal(2);
      expect(confirmations).to.include(owner2.address);
      expect(confirmations).to.include(owner3.address);
    });

    it("Should return wallet stats", async function () {
      const stats = await multiSig.getStats();
      
      expect(stats.ownerCount).to.equal(3n);
      expect(stats.ethBalance).to.equal(ethers.parseEther("100"));
    });
  });

  describe("Contract Calls", function () {
    it("Should execute ERC20 transfer via multisig", async function () {
      const transferData = token.interface.encodeFunctionData("transfer", [
        recipient.address,
        ethers.parseEther("1000")
      ]);

      await multiSig.connect(owner1).submitTransaction(
        await token.getAddress(),
        0,
        transferData,
        "Transfer tokens"
      );

      await multiSig.connect(owner2).confirmTransaction(0);

      const balance = await token.balanceOf(recipient.address);
      expect(balance).to.equal(ethers.parseEther("1000"));
    });
  });
});
