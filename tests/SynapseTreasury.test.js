const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SynapseTreasury", function () {
  let treasury;
  let token;
  let owner, signer1, signer2, signer3, signer4, emergencyAdmin, user;
  
  const HOUR = 3600;
  const DAY = 86400;

  beforeEach(async function () {
    [owner, signer1, signer2, signer3, signer4, emergencyAdmin, user] = await ethers.getSigners();

    // Deploy token
    const Token = await ethers.getContractFactory("SynapseToken");
    token = await Token.deploy(
      "SYNAPSE",
      "SYNX",
      ethers.parseEther("1000000000"),
      owner.address,
      owner.address
    );

    // Deploy treasury
    const Treasury = await ethers.getContractFactory("SynapseTreasury");
    treasury = await Treasury.deploy(
      [signer1.address, signer2.address, signer3.address],
      ["Signer 1", "Signer 2", "Signer 3"],
      2, // 2 of 3 required
      HOUR, // 1 hour timelock
      emergencyAdmin.address
    );

    // Fund treasury
    await token.transfer(await treasury.getAddress(), ethers.parseEther("1000000"));
  });

  describe("Initialization", function () {
    it("Should initialize with correct signers", async function () {
      expect(await treasury.signerCount()).to.equal(3n);
      expect(await treasury.confirmationsRequired()).to.equal(2n);
    });

    it("Should recognize all signers", async function () {
      const signer1Info = await treasury.signers(signer1.address);
      expect(signer1Info.isActive).to.be.true;
      expect(signer1Info.name).to.equal("Signer 1");
    });

    it("Should set timelock correctly", async function () {
      expect(await treasury.timelockDuration()).to.equal(BigInt(HOUR));
    });

    it("Should reject less than 3 signers", async function () {
      const Treasury = await ethers.getContractFactory("SynapseTreasury");
      await expect(
        Treasury.deploy(
          [signer1.address, signer2.address],
          ["Signer 1", "Signer 2"],
          2,
          HOUR,
          emergencyAdmin.address
        )
      ).to.be.revertedWith("Need at least 3 signers");
    });
  });

  describe("Transaction Proposal", function () {
    it("Should propose a transaction", async function () {
      const tx = await treasury.connect(signer1).proposeTransfer(
        await token.getAddress(),
        user.address,
        ethers.parseEther("1000"),
        "Test transfer"
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => treasury.interface.parseLog(log)?.name === "TransactionProposed"
      );

      expect(event).to.not.be.undefined;
    });

    it("Should auto-confirm for proposer", async function () {
      const tx = await treasury.connect(signer1).proposeTransfer(
        await token.getAddress(),
        user.address,
        ethers.parseEther("1000"),
        "Test transfer"
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => treasury.interface.parseLog(log)?.name === "TransactionProposed"
      );
      const txId = treasury.interface.parseLog(event).args.txId;

      const transaction = await treasury.transactions(txId);
      expect(transaction.confirmations).to.equal(1n);
    });

    it("Should reject non-signer proposals", async function () {
      await expect(
        treasury.connect(user).proposeTransfer(
          await token.getAddress(),
          user.address,
          ethers.parseEther("1000"),
          "Test"
        )
      ).to.be.revertedWith("Not a signer");
    });
  });

  describe("Confirmation", function () {
    let txId;

    beforeEach(async function () {
      const tx = await treasury.connect(signer1).proposeTransfer(
        await token.getAddress(),
        user.address,
        ethers.parseEther("1000"),
        "Test transfer"
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => treasury.interface.parseLog(log)?.name === "TransactionProposed"
      );
      txId = treasury.interface.parseLog(event).args.txId;
    });

    it("Should confirm transaction", async function () {
      await treasury.connect(signer2).confirmTransaction(txId);

      const transaction = await treasury.transactions(txId);
      expect(transaction.confirmations).to.equal(2n);
    });

    it("Should not allow double confirmation", async function () {
      await expect(
        treasury.connect(signer1).confirmTransaction(txId)
      ).to.be.revertedWith("Already confirmed");
    });

    it("Should allow revocation", async function () {
      await treasury.connect(signer1).revokeConfirmation(txId);

      const transaction = await treasury.transactions(txId);
      expect(transaction.confirmations).to.equal(0n);
    });
  });

  describe("Execution", function () {
    let txId;

    beforeEach(async function () {
      const tx = await treasury.connect(signer1).proposeTransfer(
        await token.getAddress(),
        user.address,
        ethers.parseEther("1000"),
        "Test transfer"
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => treasury.interface.parseLog(log)?.name === "TransactionProposed"
      );
      txId = treasury.interface.parseLog(event).args.txId;

      // Second confirmation
      await treasury.connect(signer2).confirmTransaction(txId);
    });

    it("Should not execute before timelock", async function () {
      await expect(
        treasury.connect(signer1).executeTransaction(txId)
      ).to.be.revertedWith("Timelock not passed");
    });

    it("Should execute after timelock", async function () {
      // Fast forward past timelock
      await time.increase(HOUR + 1);

      const balanceBefore = await token.balanceOf(user.address);
      
      await treasury.connect(signer1).executeTransaction(txId);

      const balanceAfter = await token.balanceOf(user.address);
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("1000"));
    });

    it("Should not execute without enough confirmations", async function () {
      // Revoke one confirmation
      await treasury.connect(signer2).revokeConfirmation(txId);
      
      await time.increase(HOUR + 1);

      await expect(
        treasury.connect(signer1).executeTransaction(txId)
      ).to.be.revertedWith("Not enough confirmations");
    });

    it("Should not execute twice", async function () {
      await time.increase(HOUR + 1);
      await treasury.connect(signer1).executeTransaction(txId);

      await expect(
        treasury.connect(signer1).executeTransaction(txId)
      ).to.be.revertedWith("Already executed");
    });
  });

  describe("Spending Limits", function () {
    beforeEach(async function () {
      // Set spending limits via multisig (simulate by calling from treasury)
      const setLimitsData = treasury.interface.encodeFunctionData("setTokenLimits", [
        await token.getAddress(),
        ethers.parseEther("5000"), // daily
        ethers.parseEther("50000") // monthly
      ]);

      // Propose setting limits
      const tx = await treasury.connect(signer1).proposeTransaction(
        await treasury.getAddress(),
        0,
        setLimitsData,
        5, // UPDATE_LIMITS
        "Set token limits"
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => treasury.interface.parseLog(log)?.name === "TransactionProposed"
      );
      const txId = treasury.interface.parseLog(event).args.txId;

      // Confirm and execute
      await treasury.connect(signer2).confirmTransaction(txId);
      await time.increase(HOUR + 1);
      await treasury.connect(signer1).executeTransaction(txId);
    });

    it("Should enforce daily limits", async function () {
      // First transfer should work
      let tx = await treasury.connect(signer1).proposeTransfer(
        await token.getAddress(),
        user.address,
        ethers.parseEther("3000"),
        "Transfer 1"
      );
      let receipt = await tx.wait();
      let event = receipt.logs.find(
        log => treasury.interface.parseLog(log)?.name === "TransactionProposed"
      );
      let txId = treasury.interface.parseLog(event).args.txId;

      await treasury.connect(signer2).confirmTransaction(txId);
      await time.increase(HOUR + 1);
      await treasury.connect(signer1).executeTransaction(txId);

      // Second transfer should fail (exceeds daily limit)
      tx = await treasury.connect(signer1).proposeTransfer(
        await token.getAddress(),
        user.address,
        ethers.parseEther("3000"),
        "Transfer 2"
      );
      receipt = await tx.wait();
      event = receipt.logs.find(
        log => treasury.interface.parseLog(log)?.name === "TransactionProposed"
      );
      txId = treasury.interface.parseLog(event).args.txId;

      await treasury.connect(signer2).confirmTransaction(txId);
      await time.increase(HOUR + 1);

      await expect(
        treasury.connect(signer1).executeTransaction(txId)
      ).to.be.revertedWith("Daily limit exceeded");
    });
  });

  describe("Signer Management", function () {
    it("Should add new signer via multisig", async function () {
      const addSignerData = treasury.interface.encodeFunctionData("addSigner", [
        signer4.address,
        "Signer 4"
      ]);

      const tx = await treasury.connect(signer1).proposeTransaction(
        await treasury.getAddress(),
        0,
        addSignerData,
        3, // ADD_SIGNER
        "Add signer 4"
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => treasury.interface.parseLog(log)?.name === "TransactionProposed"
      );
      const txId = treasury.interface.parseLog(event).args.txId;

      await treasury.connect(signer2).confirmTransaction(txId);
      await time.increase(HOUR + 1);
      await treasury.connect(signer1).executeTransaction(txId);

      expect(await treasury.signerCount()).to.equal(4n);
      const signerInfo = await treasury.signers(signer4.address);
      expect(signerInfo.isActive).to.be.true;
    });

    it("Should remove signer via multisig", async function () {
      // First add a 4th signer
      let addData = treasury.interface.encodeFunctionData("addSigner", [signer4.address, "Signer 4"]);
      let tx = await treasury.connect(signer1).proposeTransaction(await treasury.getAddress(), 0, addData, 3, "Add");
      let receipt = await tx.wait();
      let event = receipt.logs.find(log => treasury.interface.parseLog(log)?.name === "TransactionProposed");
      let txId = treasury.interface.parseLog(event).args.txId;
      await treasury.connect(signer2).confirmTransaction(txId);
      await time.increase(HOUR + 1);
      await treasury.connect(signer1).executeTransaction(txId);

      // Now remove signer3
      const removeData = treasury.interface.encodeFunctionData("removeSigner", [signer3.address]);
      tx = await treasury.connect(signer1).proposeTransaction(await treasury.getAddress(), 0, removeData, 4, "Remove");
      receipt = await tx.wait();
      event = receipt.logs.find(log => treasury.interface.parseLog(log)?.name === "TransactionProposed");
      txId = treasury.interface.parseLog(event).args.txId;
      await treasury.connect(signer2).confirmTransaction(txId);
      await time.increase(HOUR + 1);
      await treasury.connect(signer1).executeTransaction(txId);

      expect(await treasury.signerCount()).to.equal(3n);
      const signerInfo = await treasury.signers(signer3.address);
      expect(signerInfo.isActive).to.be.false;
    });

    it("Should not remove signer below threshold", async function () {
      const removeData = treasury.interface.encodeFunctionData("removeSigner", [signer3.address]);
      const tx = await treasury.connect(signer1).proposeTransaction(
        await treasury.getAddress(),
        0,
        removeData,
        4,
        "Remove"
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => treasury.interface.parseLog(log)?.name === "TransactionProposed"
      );
      const txId = treasury.interface.parseLog(event).args.txId;

      await treasury.connect(signer2).confirmTransaction(txId);
      await time.increase(HOUR + 1);

      await expect(
        treasury.connect(signer1).executeTransaction(txId)
      ).to.be.revertedWith("Need at least 3 signers");
    });
  });

  describe("Emergency Mode", function () {
    it("Should activate emergency mode", async function () {
      await treasury.connect(emergencyAdmin).activateEmergencyMode();

      expect(await treasury.emergencyMode()).to.be.true;
    });

    it("Should only allow emergency admin to activate", async function () {
      await expect(
        treasury.connect(signer1).activateEmergencyMode()
      ).to.be.revertedWith("Not emergency admin");
    });

    it("Should block normal operations in emergency", async function () {
      await treasury.connect(emergencyAdmin).activateEmergencyMode();

      await expect(
        treasury.connect(signer1).proposeTransfer(
          await token.getAddress(),
          user.address,
          ethers.parseEther("100"),
          "Test"
        )
      ).to.be.revertedWith("Emergency mode active");
    });

    it("Should allow emergency withdrawal", async function () {
      await treasury.connect(emergencyAdmin).activateEmergencyMode();

      const balanceBefore = await token.balanceOf(user.address);

      await treasury.connect(signer1).emergencyWithdraw(
        await token.getAddress(),
        user.address,
        ethers.parseEther("1000")
      );

      const balanceAfter = await token.balanceOf(user.address);
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("1000"));
    });

    it("Should not allow emergency withdrawal after period expires", async function () {
      await treasury.connect(emergencyAdmin).activateEmergencyMode();

      // Fast forward past emergency period
      await time.increase(DAY + 1);

      await expect(
        treasury.connect(signer1).emergencyWithdraw(
          await token.getAddress(),
          user.address,
          ethers.parseEther("1000")
        )
      ).to.be.revertedWith("Emergency period expired");
    });
  });

  describe("View Functions", function () {
    it("Should get pending transactions", async function () {
      // Propose two transactions
      await treasury.connect(signer1).proposeTransfer(
        await token.getAddress(),
        user.address,
        ethers.parseEther("100"),
        "Transfer 1"
      );

      await treasury.connect(signer1).proposeTransfer(
        await token.getAddress(),
        user.address,
        ethers.parseEther("200"),
        "Transfer 2"
      );

      const pending = await treasury.getPendingTransactions();
      expect(pending.length).to.equal(2);
    });

    it("Should check if transaction can be executed", async function () {
      const tx = await treasury.connect(signer1).proposeTransfer(
        await token.getAddress(),
        user.address,
        ethers.parseEther("100"),
        "Test"
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        log => treasury.interface.parseLog(log)?.name === "TransactionProposed"
      );
      const txId = treasury.interface.parseLog(event).args.txId;

      // Not enough confirmations
      let [canExec, reason] = await treasury.canExecute(txId);
      expect(canExec).to.be.false;
      expect(reason).to.equal("Not enough confirmations");

      // Add confirmation
      await treasury.connect(signer2).confirmTransaction(txId);

      // Timelock active
      [canExec, reason] = await treasury.canExecute(txId);
      expect(canExec).to.be.false;
      expect(reason).to.equal("Timelock active");

      // Wait for timelock
      await time.increase(HOUR + 1);

      // Ready
      [canExec, reason] = await treasury.canExecute(txId);
      expect(canExec).to.be.true;
      expect(reason).to.equal("Ready");
    });

    it("Should get treasury balances", async function () {
      const balances = await treasury.getBalances([await token.getAddress()]);
      
      expect(balances[0]).to.equal(0n); // ETH
      expect(balances[1]).to.equal(ethers.parseEther("1000000")); // Token
    });

    it("Should get all signers", async function () {
      const signers = await treasury.getSigners();
      expect(signers.length).to.equal(3);
    });
  });
});
