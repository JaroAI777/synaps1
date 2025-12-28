const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("PaymentChannel", function () {
  async function deployChannelFixture() {
    const [owner, treasury, alice, bob, charlie] = await ethers.getSigners();
    
    // Deploy token
    const SynapseToken = await ethers.getContractFactory("SynapseToken");
    const token = await SynapseToken.deploy(treasury.address);
    await token.waitForDeployment();
    
    // Deploy payment channel
    const PaymentChannel = await ethers.getContractFactory("PaymentChannel");
    const channel = await PaymentChannel.deploy(await token.getAddress());
    await channel.waitForDeployment();
    
    // Setup: Transfer tokens
    await token.connect(treasury).transfer(alice.address, ethers.parseEther("100000"));
    await token.connect(treasury).transfer(bob.address, ethers.parseEther("100000"));
    
    // Approve channel contract
    const channelAddress = await channel.getAddress();
    await token.connect(alice).approve(channelAddress, ethers.MaxUint256);
    await token.connect(bob).approve(channelAddress, ethers.MaxUint256);
    
    return {
      token,
      channel,
      owner,
      treasury,
      alice,
      bob,
      charlie,
      channelAddress
    };
  }

  describe("Deployment", function () {
    it("Should set correct token address", async function () {
      const { channel, token } = await loadFixture(deployChannelFixture);
      expect(await channel.token()).to.equal(await token.getAddress());
    });

    it("Should set correct challenge period", async function () {
      const { channel } = await loadFixture(deployChannelFixture);
      expect(await channel.challengePeriod()).to.equal(3600); // 1 hour
    });
  });

  describe("Channel Opening", function () {
    it("Should open channel with deposits from both parties", async function () {
      const { channel, alice, bob } = await loadFixture(deployChannelFixture);
      
      const aliceDeposit = ethers.parseEther("1000");
      const bobDeposit = ethers.parseEther("500");
      
      // Alice opens channel
      await channel.connect(alice).openChannel(bob.address, aliceDeposit, bobDeposit);
      
      // Bob funds their side
      await channel.connect(bob).fundChannel(alice.address, bobDeposit);
      
      const channelId = await channel.getChannelId(alice.address, bob.address);
      const channelData = await channel.channels(channelId);
      
      expect(channelData.participant1).to.equal(alice.address);
      expect(channelData.participant2).to.equal(bob.address);
      expect(channelData.balance1).to.equal(aliceDeposit);
      expect(channelData.balance2).to.equal(bobDeposit);
      expect(channelData.status).to.equal(1); // Open
    });

    it("Should emit ChannelOpened event", async function () {
      const { channel, alice, bob } = await loadFixture(deployChannelFixture);
      
      const aliceDeposit = ethers.parseEther("1000");
      
      await expect(channel.connect(alice).openChannel(bob.address, aliceDeposit, 0))
        .to.emit(channel, "ChannelOpened");
    });

    it("Should fail to open duplicate channel", async function () {
      const { channel, alice, bob } = await loadFixture(deployChannelFixture);
      
      await channel.connect(alice).openChannel(bob.address, ethers.parseEther("1000"), 0);
      
      await expect(
        channel.connect(alice).openChannel(bob.address, ethers.parseEther("500"), 0)
      ).to.be.revertedWith("PaymentChannel: channel exists");
    });

    it("Should fail to open channel with self", async function () {
      const { channel, alice } = await loadFixture(deployChannelFixture);
      
      await expect(
        channel.connect(alice).openChannel(alice.address, ethers.parseEther("1000"), 0)
      ).to.be.revertedWith("PaymentChannel: self-channel");
    });
  });

  describe("Channel Funding", function () {
    it("Should allow adding funds to open channel", async function () {
      const { channel, alice, bob } = await loadFixture(deployChannelFixture);
      
      await channel.connect(alice).openChannel(bob.address, ethers.parseEther("1000"), 0);
      await channel.connect(bob).fundChannel(alice.address, ethers.parseEther("500"));
      
      // Add more funds
      await channel.connect(alice).addFunds(bob.address, ethers.parseEther("200"));
      
      const channelId = await channel.getChannelId(alice.address, bob.address);
      const channelData = await channel.channels(channelId);
      
      expect(channelData.balance1).to.equal(ethers.parseEther("1200"));
    });

    it("Should emit FundsAdded event", async function () {
      const { channel, alice, bob } = await loadFixture(deployChannelFixture);
      
      await channel.connect(alice).openChannel(bob.address, ethers.parseEther("1000"), 0);
      
      await expect(channel.connect(alice).addFunds(bob.address, ethers.parseEther("100")))
        .to.emit(channel, "FundsAdded");
    });
  });

  describe("Cooperative Close", function () {
    async function openChannelFixture() {
      const base = await deployChannelFixture();
      const { channel, alice, bob } = base;
      
      // Open and fund channel
      await channel.connect(alice).openChannel(bob.address, ethers.parseEther("1000"), ethers.parseEther("500"));
      await channel.connect(bob).fundChannel(alice.address, ethers.parseEther("500"));
      
      return base;
    }

    it("Should close channel cooperatively", async function () {
      const { channel, token, alice, bob, channelAddress } = await loadFixture(openChannelFixture);
      
      const channelId = await channel.getChannelId(alice.address, bob.address);
      const nonce = 10;
      const aliceFinal = ethers.parseEther("800");
      const bobFinal = ethers.parseEther("700");
      
      // Create signatures for final state
      const messageHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "uint256", "uint256"],
        [channelId, aliceFinal, bobFinal, nonce]
      );
      
      const aliceSig = await alice.signMessage(ethers.getBytes(messageHash));
      const bobSig = await bob.signMessage(ethers.getBytes(messageHash));
      
      const aliceBalanceBefore = await token.balanceOf(alice.address);
      const bobBalanceBefore = await token.balanceOf(bob.address);
      
      // Cooperative close
      await channel.connect(alice).cooperativeClose(
        bob.address,
        aliceFinal,
        bobFinal,
        nonce,
        aliceSig,
        bobSig
      );
      
      const aliceBalanceAfter = await token.balanceOf(alice.address);
      const bobBalanceAfter = await token.balanceOf(bob.address);
      
      expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(aliceFinal);
      expect(bobBalanceAfter - bobBalanceBefore).to.equal(bobFinal);
      
      // Channel should be closed
      const channelData = await channel.channels(channelId);
      expect(channelData.status).to.equal(3); // Closed
    });

    it("Should emit ChannelClosed event", async function () {
      const { channel, alice, bob } = await loadFixture(openChannelFixture);
      
      const channelId = await channel.getChannelId(alice.address, bob.address);
      const nonce = 5;
      const aliceFinal = ethers.parseEther("600");
      const bobFinal = ethers.parseEther("900");
      
      const messageHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "uint256", "uint256"],
        [channelId, aliceFinal, bobFinal, nonce]
      );
      
      const aliceSig = await alice.signMessage(ethers.getBytes(messageHash));
      const bobSig = await bob.signMessage(ethers.getBytes(messageHash));
      
      await expect(
        channel.connect(alice).cooperativeClose(bob.address, aliceFinal, bobFinal, nonce, aliceSig, bobSig)
      ).to.emit(channel, "ChannelClosed");
    });

    it("Should fail with invalid signatures", async function () {
      const { channel, alice, bob, charlie } = await loadFixture(openChannelFixture);
      
      const channelId = await channel.getChannelId(alice.address, bob.address);
      const nonce = 1;
      const aliceFinal = ethers.parseEther("600");
      const bobFinal = ethers.parseEther("900");
      
      const messageHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "uint256", "uint256"],
        [channelId, aliceFinal, bobFinal, nonce]
      );
      
      const aliceSig = await alice.signMessage(ethers.getBytes(messageHash));
      const charlieSig = await charlie.signMessage(ethers.getBytes(messageHash)); // Wrong signer!
      
      await expect(
        channel.connect(alice).cooperativeClose(bob.address, aliceFinal, bobFinal, nonce, aliceSig, charlieSig)
      ).to.be.revertedWith("PaymentChannel: invalid signature");
    });

    it("Should fail if balances don't match total", async function () {
      const { channel, alice, bob } = await loadFixture(openChannelFixture);
      
      const channelId = await channel.getChannelId(alice.address, bob.address);
      const nonce = 1;
      // Total should be 1500, but we're claiming 2000
      const aliceFinal = ethers.parseEther("1200");
      const bobFinal = ethers.parseEther("800");
      
      const messageHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "uint256", "uint256"],
        [channelId, aliceFinal, bobFinal, nonce]
      );
      
      const aliceSig = await alice.signMessage(ethers.getBytes(messageHash));
      const bobSig = await bob.signMessage(ethers.getBytes(messageHash));
      
      await expect(
        channel.connect(alice).cooperativeClose(bob.address, aliceFinal, bobFinal, nonce, aliceSig, bobSig)
      ).to.be.revertedWith("PaymentChannel: balance mismatch");
    });
  });

  describe("Unilateral Close", function () {
    async function openChannelFixture() {
      const base = await deployChannelFixture();
      const { channel, alice, bob } = base;
      
      await channel.connect(alice).openChannel(bob.address, ethers.parseEther("1000"), ethers.parseEther("500"));
      await channel.connect(bob).fundChannel(alice.address, ethers.parseEther("500"));
      
      return base;
    }

    it("Should initiate unilateral close", async function () {
      const { channel, alice, bob } = await loadFixture(openChannelFixture);
      
      const channelId = await channel.getChannelId(alice.address, bob.address);
      const nonce = 5;
      const aliceFinal = ethers.parseEther("700");
      const bobFinal = ethers.parseEther("800");
      
      const messageHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "uint256", "uint256"],
        [channelId, aliceFinal, bobFinal, nonce]
      );
      
      const aliceSig = await alice.signMessage(ethers.getBytes(messageHash));
      const bobSig = await bob.signMessage(ethers.getBytes(messageHash));
      
      await channel.connect(alice).initiateClose(
        bob.address,
        aliceFinal,
        bobFinal,
        nonce,
        aliceSig,
        bobSig
      );
      
      const channelData = await channel.channels(channelId);
      expect(channelData.status).to.equal(2); // Closing
    });

    it("Should allow challenge with higher nonce", async function () {
      const { channel, alice, bob } = await loadFixture(openChannelFixture);
      
      const channelId = await channel.getChannelId(alice.address, bob.address);
      
      // Initial close with nonce 5
      const nonce1 = 5;
      const aliceFinal1 = ethers.parseEther("700");
      const bobFinal1 = ethers.parseEther("800");
      
      const messageHash1 = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "uint256", "uint256"],
        [channelId, aliceFinal1, bobFinal1, nonce1]
      );
      
      const aliceSig1 = await alice.signMessage(ethers.getBytes(messageHash1));
      const bobSig1 = await bob.signMessage(ethers.getBytes(messageHash1));
      
      await channel.connect(alice).initiateClose(
        bob.address, aliceFinal1, bobFinal1, nonce1, aliceSig1, bobSig1
      );
      
      // Challenge with nonce 10 (higher)
      const nonce2 = 10;
      const aliceFinal2 = ethers.parseEther("600");
      const bobFinal2 = ethers.parseEther("900");
      
      const messageHash2 = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "uint256", "uint256"],
        [channelId, aliceFinal2, bobFinal2, nonce2]
      );
      
      const aliceSig2 = await alice.signMessage(ethers.getBytes(messageHash2));
      const bobSig2 = await bob.signMessage(ethers.getBytes(messageHash2));
      
      await channel.connect(bob).challengeClose(
        alice.address, aliceFinal2, bobFinal2, nonce2, aliceSig2, bobSig2
      );
      
      const channelData = await channel.channels(channelId);
      expect(channelData.nonce).to.equal(nonce2);
      expect(channelData.proposedBalance1).to.equal(aliceFinal2);
    });

    it("Should finalize after challenge period", async function () {
      const { channel, token, alice, bob } = await loadFixture(openChannelFixture);
      
      const channelId = await channel.getChannelId(alice.address, bob.address);
      const nonce = 5;
      const aliceFinal = ethers.parseEther("700");
      const bobFinal = ethers.parseEther("800");
      
      const messageHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "uint256", "uint256"],
        [channelId, aliceFinal, bobFinal, nonce]
      );
      
      const aliceSig = await alice.signMessage(ethers.getBytes(messageHash));
      const bobSig = await bob.signMessage(ethers.getBytes(messageHash));
      
      await channel.connect(alice).initiateClose(
        bob.address, aliceFinal, bobFinal, nonce, aliceSig, bobSig
      );
      
      // Fast forward past challenge period
      await time.increase(3601);
      
      const aliceBalanceBefore = await token.balanceOf(alice.address);
      
      await channel.connect(alice).finalizeClose(bob.address);
      
      const aliceBalanceAfter = await token.balanceOf(alice.address);
      expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(aliceFinal);
      
      const channelData = await channel.channels(channelId);
      expect(channelData.status).to.equal(3); // Closed
    });

    it("Should fail to finalize before challenge period ends", async function () {
      const { channel, alice, bob } = await loadFixture(openChannelFixture);
      
      const channelId = await channel.getChannelId(alice.address, bob.address);
      const nonce = 5;
      const aliceFinal = ethers.parseEther("700");
      const bobFinal = ethers.parseEther("800");
      
      const messageHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "uint256", "uint256"],
        [channelId, aliceFinal, bobFinal, nonce]
      );
      
      const aliceSig = await alice.signMessage(ethers.getBytes(messageHash));
      const bobSig = await bob.signMessage(ethers.getBytes(messageHash));
      
      await channel.connect(alice).initiateClose(
        bob.address, aliceFinal, bobFinal, nonce, aliceSig, bobSig
      );
      
      // Try to finalize immediately
      await expect(
        channel.connect(alice).finalizeClose(bob.address)
      ).to.be.revertedWith("PaymentChannel: challenge period active");
    });
  });

  describe("Emergency Withdraw", function () {
    it("Should allow emergency withdraw after timeout", async function () {
      const { channel, token, alice, bob } = await loadFixture(deployChannelFixture);
      
      // Open channel but bob never funds
      await channel.connect(alice).openChannel(bob.address, ethers.parseEther("1000"), ethers.parseEther("500"));
      
      // Fast forward past emergency timeout (e.g., 7 days)
      await time.increase(7 * 24 * 3600 + 1);
      
      const aliceBalanceBefore = await token.balanceOf(alice.address);
      
      await channel.connect(alice).emergencyWithdraw(bob.address);
      
      const aliceBalanceAfter = await token.balanceOf(alice.address);
      expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(ethers.parseEther("1000"));
    });
  });

  describe("View Functions", function () {
    it("Should return correct channel ID", async function () {
      const { channel, alice, bob } = await loadFixture(deployChannelFixture);
      
      const channelId1 = await channel.getChannelId(alice.address, bob.address);
      const channelId2 = await channel.getChannelId(bob.address, alice.address);
      
      // Channel ID should be same regardless of order
      expect(channelId1).to.equal(channelId2);
    });

    it("Should return channel balance", async function () {
      const { channel, alice, bob } = await loadFixture(deployChannelFixture);
      
      await channel.connect(alice).openChannel(bob.address, ethers.parseEther("1000"), 0);
      await channel.connect(bob).fundChannel(alice.address, ethers.parseEther("500"));
      
      const totalBalance = await channel.getChannelBalance(alice.address, bob.address);
      expect(totalBalance).to.equal(ethers.parseEther("1500"));
    });
  });
});
