const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SynapseToken", function () {
  // Fixture - deploy fresh contracts for each test
  async function deployTokenFixture() {
    const [owner, treasury, user1, user2, bridge, blocked] = await ethers.getSigners();
    
    const SynapseToken = await ethers.getContractFactory("SynapseToken");
    const token = await SynapseToken.deploy(treasury.address);
    await token.waitForDeployment();
    
    const tokenAddress = await token.getAddress();
    
    return { token, tokenAddress, owner, treasury, user1, user2, bridge, blocked };
  }

  describe("Deployment", function () {
    it("Should set correct name and symbol", async function () {
      const { token } = await loadFixture(deployTokenFixture);
      
      expect(await token.name()).to.equal("SYNAPSE Protocol");
      expect(await token.symbol()).to.equal("SYNX");
    });

    it("Should mint total supply to treasury", async function () {
      const { token, treasury } = await loadFixture(deployTokenFixture);
      
      const totalSupply = await token.totalSupply();
      const treasuryBalance = await token.balanceOf(treasury.address);
      
      expect(totalSupply).to.equal(ethers.parseEther("1000000000")); // 1 billion
      expect(treasuryBalance).to.equal(totalSupply);
    });

    it("Should set owner as default admin", async function () {
      const { token, owner } = await loadFixture(deployTokenFixture);
      
      const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
      expect(await token.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("Should have correct decimals", async function () {
      const { token } = await loadFixture(deployTokenFixture);
      expect(await token.decimals()).to.equal(18);
    });
  });

  describe("Transfers", function () {
    it("Should transfer tokens between accounts", async function () {
      const { token, treasury, user1 } = await loadFixture(deployTokenFixture);
      
      const amount = ethers.parseEther("1000");
      await token.connect(treasury).transfer(user1.address, amount);
      
      expect(await token.balanceOf(user1.address)).to.equal(amount);
    });

    it("Should collect transfer fee", async function () {
      const { token, treasury, user1, user2 } = await loadFixture(deployTokenFixture);
      
      // First transfer tokens to user1 (treasury is fee exempt)
      await token.connect(treasury).transfer(user1.address, ethers.parseEther("10000"));
      
      // Transfer from user1 to user2 (not fee exempt)
      const amount = ethers.parseEther("1000");
      await token.connect(user1).transfer(user2.address, amount);
      
      // Fee is 0.1% = 1 token
      const fee = amount * 10n / 10000n; // 0.1%
      const expectedReceived = amount - fee;
      
      expect(await token.balanceOf(user2.address)).to.equal(expectedReceived);
    });

    it("Should not collect fee from exempt addresses", async function () {
      const { token, owner, treasury, user1 } = await loadFixture(deployTokenFixture);
      
      // Make user1 fee exempt
      await token.connect(owner).setFeeExempt(user1.address, true);
      
      // Transfer to user1 first
      await token.connect(treasury).transfer(user1.address, ethers.parseEther("10000"));
      
      const amount = ethers.parseEther("1000");
      const balanceBefore = await token.balanceOf(treasury.address);
      
      await token.connect(user1).transfer(treasury.address, amount);
      
      const balanceAfter = await token.balanceOf(treasury.address);
      expect(balanceAfter - balanceBefore).to.equal(amount); // No fee deducted
    });

    it("Should fail transfer from blocked address", async function () {
      const { token, owner, treasury, user1, blocked } = await loadFixture(deployTokenFixture);
      
      // Transfer tokens to blocked user
      await token.connect(treasury).transfer(blocked.address, ethers.parseEther("1000"));
      
      // Block the user
      await token.connect(owner).setBlocked(blocked.address, true);
      
      // Try to transfer - should fail
      await expect(
        token.connect(blocked).transfer(user1.address, ethers.parseEther("100"))
      ).to.be.revertedWith("SynapseToken: sender blocked");
    });

    it("Should fail transfer to blocked address", async function () {
      const { token, owner, treasury, blocked } = await loadFixture(deployTokenFixture);
      
      // Block the user
      await token.connect(owner).setBlocked(blocked.address, true);
      
      // Try to transfer to blocked - should fail
      await expect(
        token.connect(treasury).transfer(blocked.address, ethers.parseEther("100"))
      ).to.be.revertedWith("SynapseToken: recipient blocked");
    });
  });

  describe("Fee Management", function () {
    it("Should allow admin to update fee", async function () {
      const { token, owner } = await loadFixture(deployTokenFixture);
      
      await token.connect(owner).setTransferFee(50); // 0.5%
      expect(await token.transferFeeBps()).to.equal(50);
    });

    it("Should not allow fee above maximum", async function () {
      const { token, owner } = await loadFixture(deployTokenFixture);
      
      await expect(
        token.connect(owner).setTransferFee(501) // 5.01%
      ).to.be.revertedWith("SynapseToken: fee too high");
    });

    it("Should not allow non-admin to set fee", async function () {
      const { token, user1 } = await loadFixture(deployTokenFixture);
      
      await expect(
        token.connect(user1).setTransferFee(50)
      ).to.be.reverted;
    });

    it("Should track total fees collected", async function () {
      const { token, treasury, user1, user2 } = await loadFixture(deployTokenFixture);
      
      await token.connect(treasury).transfer(user1.address, ethers.parseEther("10000"));
      
      const amount = ethers.parseEther("1000");
      await token.connect(user1).transfer(user2.address, amount);
      
      const expectedFee = amount * 10n / 10000n; // 0.1%
      expect(await token.totalFeesCollected()).to.equal(expectedFee);
    });
  });

  describe("Burning", function () {
    it("Should allow token holders to burn", async function () {
      const { token, treasury } = await loadFixture(deployTokenFixture);
      
      const burnAmount = ethers.parseEther("1000000");
      const supplyBefore = await token.totalSupply();
      
      await token.connect(treasury).burn(burnAmount);
      
      const supplyAfter = await token.totalSupply();
      expect(supplyBefore - supplyAfter).to.equal(burnAmount);
    });

    it("Should track total burned", async function () {
      const { token, treasury } = await loadFixture(deployTokenFixture);
      
      const burnAmount = ethers.parseEther("1000000");
      await token.connect(treasury).burn(burnAmount);
      
      expect(await token.totalBurned()).to.equal(burnAmount);
    });
  });

  describe("Bridge Functions", function () {
    it("Should allow admin to set bridge role", async function () {
      const { token, owner, bridge } = await loadFixture(deployTokenFixture);
      
      const BRIDGE_ROLE = await token.BRIDGE_ROLE();
      await token.connect(owner).grantRole(BRIDGE_ROLE, bridge.address);
      
      expect(await token.hasRole(BRIDGE_ROLE, bridge.address)).to.be.true;
    });

    it("Should allow bridge to mint", async function () {
      const { token, owner, bridge, user1 } = await loadFixture(deployTokenFixture);
      
      const BRIDGE_ROLE = await token.BRIDGE_ROLE();
      await token.connect(owner).grantRole(BRIDGE_ROLE, bridge.address);
      
      const mintAmount = ethers.parseEther("1000");
      await token.connect(bridge).bridgeMint(user1.address, mintAmount);
      
      expect(await token.balanceOf(user1.address)).to.equal(mintAmount);
    });

    it("Should allow bridge to burn", async function () {
      const { token, owner, treasury, bridge } = await loadFixture(deployTokenFixture);
      
      const BRIDGE_ROLE = await token.BRIDGE_ROLE();
      await token.connect(owner).grantRole(BRIDGE_ROLE, bridge.address);
      
      // Transfer some tokens to bridge
      await token.connect(treasury).transfer(bridge.address, ethers.parseEther("10000"));
      
      const burnAmount = ethers.parseEther("1000");
      const supplyBefore = await token.totalSupply();
      
      await token.connect(bridge).bridgeBurn(burnAmount);
      
      expect(await token.totalSupply()).to.equal(supplyBefore - burnAmount);
    });

    it("Should not allow non-bridge to mint", async function () {
      const { token, user1 } = await loadFixture(deployTokenFixture);
      
      await expect(
        token.connect(user1).bridgeMint(user1.address, ethers.parseEther("1000"))
      ).to.be.reverted;
    });
  });

  describe("Permit (EIP-2612)", function () {
    it("Should allow gasless approvals via permit", async function () {
      const { token, treasury, user1, user2 } = await loadFixture(deployTokenFixture);
      
      // Transfer tokens to user1
      await token.connect(treasury).transfer(user1.address, ethers.parseEther("1000"));
      
      const tokenAddress = await token.getAddress();
      const value = ethers.parseEther("500");
      const nonce = await token.nonces(user1.address);
      const deadline = (await time.latest()) + 3600;
      
      // Create permit signature
      const domain = {
        name: "SYNAPSE Protocol",
        version: "1",
        chainId: 31337,
        verifyingContract: tokenAddress
      };
      
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };
      
      const message = {
        owner: user1.address,
        spender: user2.address,
        value: value,
        nonce: nonce,
        deadline: deadline
      };
      
      const signature = await user1.signTypedData(domain, types, message);
      const { v, r, s } = ethers.Signature.from(signature);
      
      // Execute permit
      await token.permit(user1.address, user2.address, value, deadline, v, r, s);
      
      expect(await token.allowance(user1.address, user2.address)).to.equal(value);
    });
  });

  describe("Voting Power (ERC20Votes)", function () {
    it("Should delegate voting power", async function () {
      const { token, treasury, user1 } = await loadFixture(deployTokenFixture);
      
      const amount = ethers.parseEther("1000000");
      await token.connect(treasury).transfer(user1.address, amount);
      
      // Delegate to self
      await token.connect(user1).delegate(user1.address);
      
      expect(await token.getVotes(user1.address)).to.equal(amount);
    });

    it("Should allow delegation to another address", async function () {
      const { token, treasury, user1, user2 } = await loadFixture(deployTokenFixture);
      
      const amount = ethers.parseEther("1000000");
      await token.connect(treasury).transfer(user1.address, amount);
      
      // Delegate to user2
      await token.connect(user1).delegate(user2.address);
      
      expect(await token.getVotes(user2.address)).to.equal(amount);
      expect(await token.getVotes(user1.address)).to.equal(0);
    });

    it("Should track historical voting power", async function () {
      const { token, treasury, user1 } = await loadFixture(deployTokenFixture);
      
      const amount = ethers.parseEther("1000000");
      await token.connect(treasury).transfer(user1.address, amount);
      await token.connect(user1).delegate(user1.address);
      
      // Mine a block
      await time.increase(1);
      
      const blockNumber = await ethers.provider.getBlockNumber();
      
      // Check past votes (need to check block before current)
      const pastVotes = await token.getPastVotes(user1.address, blockNumber - 1);
      expect(pastVotes).to.equal(amount);
    });
  });

  describe("Pausable", function () {
    it("Should allow admin to pause", async function () {
      const { token, owner } = await loadFixture(deployTokenFixture);
      
      await token.connect(owner).pause();
      expect(await token.paused()).to.be.true;
    });

    it("Should block transfers when paused", async function () {
      const { token, owner, treasury, user1 } = await loadFixture(deployTokenFixture);
      
      await token.connect(owner).pause();
      
      await expect(
        token.connect(treasury).transfer(user1.address, ethers.parseEther("1000"))
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("Should allow admin to unpause", async function () {
      const { token, owner, treasury, user1 } = await loadFixture(deployTokenFixture);
      
      await token.connect(owner).pause();
      await token.connect(owner).unpause();
      
      // Transfer should work now
      await token.connect(treasury).transfer(user1.address, ethers.parseEther("1000"));
      expect(await token.balanceOf(user1.address)).to.equal(ethers.parseEther("1000"));
    });
  });
});
