const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SynapseInsurance", function () {
  let insurance, token;
  let owner, alice, bob, underwriter, assessor;
  
  const INITIAL_SUPPLY = ethers.parseEther("1000000000");
  const DAY = 86400;

  beforeEach(async function () {
    [owner, alice, bob, underwriter, assessor] = await ethers.getSigners();

    // Deploy SYNX token
    const Token = await ethers.getContractFactory("SynapseToken");
    token = await Token.deploy("SYNAPSE", "SYNX", INITIAL_SUPPLY, owner.address, owner.address);

    // Deploy insurance contract
    const Insurance = await ethers.getContractFactory("SynapseInsurance");
    insurance = await Insurance.deploy(await token.getAddress());

    // Grant roles
    const UNDERWRITER_ROLE = await insurance.UNDERWRITER_ROLE();
    const CLAIMS_ASSESSOR_ROLE = await insurance.CLAIMS_ASSESSOR_ROLE();
    
    await insurance.grantRole(UNDERWRITER_ROLE, underwriter.address);
    await insurance.grantRole(CLAIMS_ASSESSOR_ROLE, assessor.address);

    // Distribute tokens
    await token.transfer(alice.address, ethers.parseEther("100000"));
    await token.transfer(bob.address, ethers.parseEther("100000"));
    await token.transfer(underwriter.address, ethers.parseEther("500000"));

    // Approvals
    const maxApproval = ethers.MaxUint256;
    await token.connect(alice).approve(await insurance.getAddress(), maxApproval);
    await token.connect(bob).approve(await insurance.getAddress(), maxApproval);
    await token.connect(underwriter).approve(await insurance.getAddress(), maxApproval);
  });

  describe("Deployment", function () {
    it("Should deploy with correct initial state", async function () {
      expect(await insurance.synxToken()).to.equal(await token.getAddress());
    });

    it("Should create default coverage types", async function () {
      const coverage1 = await insurance.coverageTypes(1);
      expect(coverage1.name).to.equal("Smart Contract Cover");
      expect(coverage1.isActive).to.be.true;
    });
  });

  describe("Capital Pool", function () {
    it("Should allow underwriters to deposit capital", async function () {
      const amount = ethers.parseEther("100000");
      
      await insurance.connect(underwriter).depositCapital(amount);

      const stake = await insurance.underwriterStakes(underwriter.address);
      expect(stake).to.equal(amount);
    });

    it("Should update pool info on deposit", async function () {
      const amount = ethers.parseEther("100000");
      
      await insurance.connect(underwriter).depositCapital(amount);

      const pool = await insurance.getPoolInfo();
      expect(pool.totalCapital).to.equal(amount);
      expect(pool.availableCapital).to.equal(amount);
    });

    it("Should allow withdrawal when capital not reserved", async function () {
      const amount = ethers.parseEther("100000");
      
      await insurance.connect(underwriter).depositCapital(amount);
      await insurance.connect(underwriter).withdrawCapital(amount);

      const stake = await insurance.underwriterStakes(underwriter.address);
      expect(stake).to.equal(0n);
    });
  });

  describe("Policy Purchase", function () {
    beforeEach(async function () {
      // Add capital to pool
      await insurance.connect(underwriter).depositCapital(ethers.parseEther("500000"));
    });

    it("Should allow purchasing a policy", async function () {
      const coverageAmount = ethers.parseEther("10000");
      const periodDays = 90;

      const tx = await insurance.connect(alice).purchasePolicy(
        1, // Smart Contract Cover
        coverageAmount,
        periodDays,
        ethers.ZeroAddress // Contract being covered
      );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);

      // Check policy was created
      const policy = await insurance.getPolicy(1);
      expect(policy.holder).to.equal(alice.address);
      expect(policy.coverageAmount).to.equal(coverageAmount);
    });

    it("Should calculate correct premium", async function () {
      const coverageAmount = ethers.parseEther("10000");
      const periodDays = 365;

      // 3% annual rate for Smart Contract Cover
      // Expected premium: 10000 * 0.03 * (365/365) = 300 SYNX base
      // Plus utilization adjustment

      const balanceBefore = await token.balanceOf(alice.address);
      
      await insurance.connect(alice).purchasePolicy(
        1,
        coverageAmount,
        periodDays,
        ethers.ZeroAddress
      );

      const balanceAfter = await token.balanceOf(alice.address);
      const premium = balanceBefore - balanceAfter;

      // Premium should be approximately 300 SYNX (3% of 10000)
      expect(premium).to.be.closeTo(ethers.parseEther("300"), ethers.parseEther("50"));
    });

    it("Should reject policy below minimum coverage", async function () {
      await expect(
        insurance.connect(alice).purchasePolicy(
          1,
          ethers.parseEther("100"), // Below 1000 minimum
          90,
          ethers.ZeroAddress
        )
      ).to.be.revertedWith("Below minimum");
    });

    it("Should reject policy above maximum coverage", async function () {
      await expect(
        insurance.connect(alice).purchasePolicy(
          1,
          ethers.parseEther("2000000"), // Above 1M maximum
          90,
          ethers.ZeroAddress
        )
      ).to.be.revertedWith("Above maximum");
    });
  });

  describe("Policy Cancellation", function () {
    let policyId;

    beforeEach(async function () {
      await insurance.connect(underwriter).depositCapital(ethers.parseEther("500000"));
      
      await insurance.connect(alice).purchasePolicy(
        1,
        ethers.parseEther("10000"),
        180,
        ethers.ZeroAddress
      );
      policyId = 1;
    });

    it("Should allow policy holder to cancel", async function () {
      const balanceBefore = await token.balanceOf(alice.address);
      
      await insurance.connect(alice).cancelPolicy(policyId);

      const balanceAfter = await token.balanceOf(alice.address);
      
      // Should receive partial refund (minus 20% cancellation fee)
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should update policy status", async function () {
      await insurance.connect(alice).cancelPolicy(policyId);

      const policy = await insurance.getPolicy(policyId);
      expect(policy.status).to.equal(3); // CANCELLED
    });

    it("Should reject cancellation by non-holder", async function () {
      await expect(
        insurance.connect(bob).cancelPolicy(policyId)
      ).to.be.revertedWith("Not policy holder");
    });
  });

  describe("Claims", function () {
    let policyId;

    beforeEach(async function () {
      await insurance.connect(underwriter).depositCapital(ethers.parseEther("500000"));
      
      await insurance.connect(alice).purchasePolicy(
        1,
        ethers.parseEther("10000"),
        180,
        ethers.ZeroAddress
      );
      policyId = 1;

      // Fast forward past cooldown
      await time.increase(8 * DAY);
    });

    it("Should allow submitting a claim", async function () {
      const claimAmount = ethers.parseEther("5000");
      
      const tx = await insurance.connect(alice).submitClaim(
        policyId,
        claimAmount,
        "Smart contract exploit",
        ethers.keccak256(ethers.toUtf8Bytes("evidence"))
      );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);

      const claim = await insurance.getClaim(1);
      expect(claim.claimant).to.equal(alice.address);
      expect(claim.amount).to.equal(claimAmount);
    });

    it("Should reject claim during cooldown period", async function () {
      // Create new policy
      await insurance.connect(bob).purchasePolicy(
        1,
        ethers.parseEther("5000"),
        90,
        ethers.ZeroAddress
      );

      // Try to claim immediately (within cooldown)
      await expect(
        insurance.connect(bob).submitClaim(
          2,
          ethers.parseEther("1000"),
          "Test",
          ethers.ZeroAddress
        )
      ).to.be.revertedWith("Cooldown active");
    });

    it("Should reject claim exceeding coverage", async function () {
      await expect(
        insurance.connect(alice).submitClaim(
          policyId,
          ethers.parseEther("15000"), // Exceeds 10000 coverage
          "Test",
          ethers.ZeroAddress
        )
      ).to.be.revertedWith("Exceeds coverage");
    });
  });

  describe("Claim Assessment", function () {
    let policyId, claimId;

    beforeEach(async function () {
      await insurance.connect(underwriter).depositCapital(ethers.parseEther("500000"));
      
      await insurance.connect(alice).purchasePolicy(
        1,
        ethers.parseEther("10000"),
        180,
        ethers.ZeroAddress
      );
      policyId = 1;

      await time.increase(8 * DAY);

      await insurance.connect(alice).submitClaim(
        policyId,
        ethers.parseEther("5000"),
        "Smart contract exploit",
        ethers.keccak256(ethers.toUtf8Bytes("evidence"))
      );
      claimId = 1;
    });

    it("Should allow assessor to approve claim", async function () {
      await insurance.connect(assessor).assessClaim(
        claimId,
        true,
        "Valid claim, evidence verified"
      );

      const claim = await insurance.getClaim(claimId);
      expect(claim.status).to.equal(4); // PAID (auto-paid on approval)
    });

    it("Should allow assessor to reject claim", async function () {
      await insurance.connect(assessor).assessClaim(
        claimId,
        false,
        "Insufficient evidence"
      );

      const claim = await insurance.getClaim(claimId);
      expect(claim.status).to.equal(3); // REJECTED
    });

    it("Should pay claim on approval", async function () {
      const balanceBefore = await token.balanceOf(alice.address);
      
      await insurance.connect(assessor).assessClaim(
        claimId,
        true,
        "Valid claim"
      );

      const balanceAfter = await token.balanceOf(alice.address);
      
      // Should receive payout minus deductible (5%)
      // 5000 - 5% = 4750 SYNX
      expect(balanceAfter - balanceBefore).to.be.closeTo(
        ethers.parseEther("4750"),
        ethers.parseEther("50")
      );
    });

    it("Should reject assessment by non-assessor", async function () {
      await expect(
        insurance.connect(alice).assessClaim(claimId, true, "Self-approve")
      ).to.be.reverted;
    });
  });

  describe("Pool Info", function () {
    it("Should return correct pool info", async function () {
      await insurance.connect(underwriter).depositCapital(ethers.parseEther("100000"));

      const pool = await insurance.getPoolInfo();
      
      expect(pool.totalCapital).to.equal(ethers.parseEther("100000"));
      expect(pool.underwriterCount).to.equal(1n);
    });
  });

  describe("Policy Claimability Check", function () {
    beforeEach(async function () {
      await insurance.connect(underwriter).depositCapital(ethers.parseEther("500000"));
    });

    it("Should return claimable status correctly", async function () {
      await insurance.connect(alice).purchasePolicy(
        1,
        ethers.parseEther("10000"),
        90,
        ethers.ZeroAddress
      );

      // During cooldown
      let [claimable, reason] = await insurance.isPolicyClaimable(1);
      expect(claimable).to.be.false;
      expect(reason).to.equal("Cooldown active");

      // After cooldown
      await time.increase(8 * DAY);
      [claimable, reason] = await insurance.isPolicyClaimable(1);
      expect(claimable).to.be.true;
    });
  });

  describe("Coverage Type Management", function () {
    it("Should allow admin to create new coverage type", async function () {
      const RISK_MANAGER_ROLE = await insurance.RISK_MANAGER_ROLE();
      await insurance.grantRole(RISK_MANAGER_ROLE, owner.address);

      await insurance.createCoverageType(
        "Custom Cover",
        "Custom insurance coverage",
        500,                    // 5% premium
        ethers.parseEther("100000"),
        ethers.parseEther("100"),
        30,
        180,
        300,
        ethers.parseEther("1000000")
      );

      const coverage = await insurance.coverageTypes(5);
      expect(coverage.name).to.equal("Custom Cover");
      expect(coverage.basePremiumRate).to.equal(500n);
    });
  });

  describe("Admin Functions", function () {
    it("Should allow pausing", async function () {
      await insurance.pause();
      
      await expect(
        insurance.connect(underwriter).depositCapital(ethers.parseEther("1000"))
      ).to.be.reverted;
    });

    it("Should allow unpausing", async function () {
      await insurance.pause();
      await insurance.unpause();
      
      await insurance.connect(underwriter).depositCapital(ethers.parseEther("1000"));
      
      const stake = await insurance.underwriterStakes(underwriter.address);
      expect(stake).to.equal(ethers.parseEther("1000"));
    });
  });
});
