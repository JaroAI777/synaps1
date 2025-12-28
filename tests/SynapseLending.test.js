const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SynapseLending", function () {
  let lending, token, stableToken;
  let owner, alice, bob, charlie, liquidator;
  
  const INITIAL_SUPPLY = ethers.parseEther("1000000000");
  const DAY = 86400;

  beforeEach(async function () {
    [owner, alice, bob, charlie, liquidator] = await ethers.getSigners();

    // Deploy SYNX token
    const Token = await ethers.getContractFactory("SynapseToken");
    token = await Token.deploy("SYNAPSE", "SYNX", INITIAL_SUPPLY, owner.address, owner.address);

    // Deploy mock stable token
    stableToken = await Token.deploy("USD Stable", "USDS", INITIAL_SUPPLY, owner.address, owner.address);

    // Deploy lending contract
    const Lending = await ethers.getContractFactory("SynapseLending");
    lending = await Lending.deploy(await token.getAddress());

    // Add stable token market
    await lending.createMarket(
      await stableToken.getAddress(),
      8000,  // 80% collateral factor
      500,   // 5% liquidation bonus
      1000   // 10% reserve factor
    );

    // Set prices (1 SYNX = 1 USD for simplicity)
    await lending.setPrice(await stableToken.getAddress(), ethers.parseEther("1"));

    // Distribute tokens
    await token.transfer(alice.address, ethers.parseEther("100000"));
    await token.transfer(bob.address, ethers.parseEther("100000"));
    await token.transfer(charlie.address, ethers.parseEther("100000"));
    await token.transfer(liquidator.address, ethers.parseEther("100000"));

    await stableToken.transfer(alice.address, ethers.parseEther("100000"));
    await stableToken.transfer(bob.address, ethers.parseEther("100000"));
    await stableToken.transfer(charlie.address, ethers.parseEther("100000"));

    // Approvals
    const maxApproval = ethers.MaxUint256;
    await token.connect(alice).approve(await lending.getAddress(), maxApproval);
    await token.connect(bob).approve(await lending.getAddress(), maxApproval);
    await token.connect(charlie).approve(await lending.getAddress(), maxApproval);
    await token.connect(liquidator).approve(await lending.getAddress(), maxApproval);

    await stableToken.connect(alice).approve(await lending.getAddress(), maxApproval);
    await stableToken.connect(bob).approve(await lending.getAddress(), maxApproval);
    await stableToken.connect(charlie).approve(await lending.getAddress(), maxApproval);
  });

  describe("Market Creation", function () {
    it("Should create SYNX market on deployment", async function () {
      const market = await lending.markets(await token.getAddress());
      expect(market.isActive).to.be.true;
      expect(market.collateralFactor).to.equal(7500n);
    });

    it("Should create additional markets", async function () {
      const market = await lending.markets(await stableToken.getAddress());
      expect(market.isActive).to.be.true;
      expect(market.collateralFactor).to.equal(8000n);
    });

    it("Should reject duplicate markets", async function () {
      await expect(
        lending.createMarket(await token.getAddress(), 7500, 500, 1000)
      ).to.be.revertedWith("Market exists");
    });
  });

  describe("Deposits", function () {
    it("Should deposit tokens", async function () {
      const amount = ethers.parseEther("1000");
      
      await lending.connect(alice).deposit(await token.getAddress(), amount);

      const balance = await lending.getDepositBalance(alice.address, await token.getAddress());
      expect(balance).to.equal(amount);
    });

    it("Should update market total deposits", async function () {
      const amount = ethers.parseEther("1000");
      
      await lending.connect(alice).deposit(await token.getAddress(), amount);

      const marketData = await lending.getMarketData(await token.getAddress());
      expect(marketData.totalDeposits).to.equal(amount);
    });

    it("Should allow multiple deposits", async function () {
      await lending.connect(alice).deposit(await token.getAddress(), ethers.parseEther("500"));
      await lending.connect(alice).deposit(await token.getAddress(), ethers.parseEther("500"));

      const balance = await lending.getDepositBalance(alice.address, await token.getAddress());
      expect(balance).to.equal(ethers.parseEther("1000"));
    });
  });

  describe("Withdrawals", function () {
    beforeEach(async function () {
      await lending.connect(alice).deposit(await token.getAddress(), ethers.parseEther("1000"));
    });

    it("Should withdraw tokens", async function () {
      const balanceBefore = await token.balanceOf(alice.address);
      
      await lending.connect(alice).withdraw(await token.getAddress(), ethers.parseEther("500"));

      const balanceAfter = await token.balanceOf(alice.address);
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("500"));
    });

    it("Should reject withdrawal exceeding balance", async function () {
      await expect(
        lending.connect(alice).withdraw(await token.getAddress(), ethers.parseEther("2000"))
      ).to.be.revertedWith("Insufficient balance");
    });

    it("Should allow full withdrawal", async function () {
      await lending.connect(alice).withdraw(await token.getAddress(), ethers.parseEther("1000"));

      const balance = await lending.getDepositBalance(alice.address, await token.getAddress());
      expect(balance).to.equal(0n);
    });
  });

  describe("Borrowing", function () {
    beforeEach(async function () {
      // Alice deposits as collateral
      await lending.connect(alice).deposit(await token.getAddress(), ethers.parseEther("10000"));
      await lending.connect(alice).toggleCollateral(await token.getAddress(), true);
      
      // Bob deposits stable to provide liquidity
      await lending.connect(bob).deposit(await stableToken.getAddress(), ethers.parseEther("50000"));
    });

    it("Should borrow against collateral", async function () {
      const borrowAmount = ethers.parseEther("5000"); // 50% of collateral value
      
      await lending.connect(alice).borrow(await stableToken.getAddress(), borrowAmount);

      const borrowed = await lending.getBorrowBalance(alice.address, await stableToken.getAddress());
      expect(borrowed).to.equal(borrowAmount);
    });

    it("Should reject borrow exceeding collateral", async function () {
      const borrowAmount = ethers.parseEther("10000"); // 100% of collateral value
      
      await expect(
        lending.connect(alice).borrow(await stableToken.getAddress(), borrowAmount)
      ).to.be.revertedWith("Insufficient collateral");
    });

    it("Should reject borrow without collateral enabled", async function () {
      // Charlie deposits but doesn't enable collateral
      await lending.connect(charlie).deposit(await token.getAddress(), ethers.parseEther("10000"));

      await expect(
        lending.connect(charlie).borrow(await stableToken.getAddress(), ethers.parseEther("1000"))
      ).to.be.revertedWith("Insufficient collateral");
    });

    it("Should update market total borrows", async function () {
      await lending.connect(alice).borrow(await stableToken.getAddress(), ethers.parseEther("5000"));

      const marketData = await lending.getMarketData(await stableToken.getAddress());
      expect(marketData.totalBorrows).to.equal(ethers.parseEther("5000"));
    });
  });

  describe("Repayment", function () {
    beforeEach(async function () {
      await lending.connect(alice).deposit(await token.getAddress(), ethers.parseEther("10000"));
      await lending.connect(alice).toggleCollateral(await token.getAddress(), true);
      await lending.connect(bob).deposit(await stableToken.getAddress(), ethers.parseEther("50000"));
      await lending.connect(alice).borrow(await stableToken.getAddress(), ethers.parseEther("5000"));
    });

    it("Should repay debt", async function () {
      // Alice needs stable tokens to repay
      await stableToken.transfer(alice.address, ethers.parseEther("5000"));
      
      await lending.connect(alice).repay(await stableToken.getAddress(), ethers.parseEther("2500"));

      const borrowed = await lending.getBorrowBalance(alice.address, await stableToken.getAddress());
      expect(borrowed).to.be.closeTo(ethers.parseEther("2500"), ethers.parseEther("1"));
    });

    it("Should allow full repayment", async function () {
      await stableToken.transfer(alice.address, ethers.parseEther("10000"));
      
      await lending.connect(alice).repay(await stableToken.getAddress(), ethers.parseEther("10000"));

      const borrowed = await lending.getBorrowBalance(alice.address, await stableToken.getAddress());
      expect(borrowed).to.equal(0n);
    });

    it("Should allow repay for others", async function () {
      // Bob repays Alice's debt
      await lending.connect(bob).repayFor(
        await stableToken.getAddress(),
        alice.address,
        ethers.parseEther("2500")
      );

      const borrowed = await lending.getBorrowBalance(alice.address, await stableToken.getAddress());
      expect(borrowed).to.be.closeTo(ethers.parseEther("2500"), ethers.parseEther("1"));
    });
  });

  describe("Interest Accrual", function () {
    beforeEach(async function () {
      await lending.connect(alice).deposit(await token.getAddress(), ethers.parseEther("10000"));
      await lending.connect(alice).toggleCollateral(await token.getAddress(), true);
      await lending.connect(bob).deposit(await stableToken.getAddress(), ethers.parseEther("50000"));
    });

    it("Should accrue interest on borrows", async function () {
      await lending.connect(alice).borrow(await stableToken.getAddress(), ethers.parseEther("5000"));

      const borrowedBefore = await lending.getBorrowBalance(alice.address, await stableToken.getAddress());

      // Fast forward 365 days
      await time.increase(365 * DAY);

      // Trigger interest accrual
      await lending.connect(alice).repay(await stableToken.getAddress(), 0);

      const borrowedAfter = await lending.getBorrowBalance(alice.address, await stableToken.getAddress());
      
      // Should have accrued interest
      expect(borrowedAfter).to.be.gt(borrowedBefore);
    });

    it("Should accrue interest for depositors", async function () {
      const depositAmount = ethers.parseEther("10000");
      await lending.connect(charlie).deposit(await stableToken.getAddress(), depositAmount);

      // Create utilization by borrowing
      await lending.connect(alice).borrow(await stableToken.getAddress(), ethers.parseEther("30000"));

      // Fast forward time
      await time.increase(365 * DAY);

      // Trigger accrual
      await lending.connect(bob).withdraw(await stableToken.getAddress(), 1);

      const depositBalance = await lending.getDepositBalance(charlie.address, await stableToken.getAddress());
      
      // Should have earned interest
      expect(depositBalance).to.be.gt(depositAmount);
    });
  });

  describe("Health Factor", function () {
    beforeEach(async function () {
      await lending.connect(alice).deposit(await token.getAddress(), ethers.parseEther("10000"));
      await lending.connect(alice).toggleCollateral(await token.getAddress(), true);
      await lending.connect(bob).deposit(await stableToken.getAddress(), ethers.parseEther("50000"));
    });

    it("Should have infinite health factor with no debt", async function () {
      const healthFactor = await lending.getHealthFactor(alice.address);
      expect(healthFactor).to.equal(ethers.MaxUint256);
    });

    it("Should calculate health factor with debt", async function () {
      await lending.connect(alice).borrow(await stableToken.getAddress(), ethers.parseEther("5000"));

      const healthFactor = await lending.getHealthFactor(alice.address);
      
      // 10000 * 0.75 / 5000 = 1.5
      expect(healthFactor).to.be.closeTo(ethers.parseEther("1.5"), ethers.parseEther("0.1"));
    });

    it("Should decrease health factor with more debt", async function () {
      await lending.connect(alice).borrow(await stableToken.getAddress(), ethers.parseEther("3000"));
      const hf1 = await lending.getHealthFactor(alice.address);

      await lending.connect(alice).borrow(await stableToken.getAddress(), ethers.parseEther("2000"));
      const hf2 = await lending.getHealthFactor(alice.address);

      expect(hf2).to.be.lt(hf1);
    });
  });

  describe("Liquidation", function () {
    beforeEach(async function () {
      await lending.connect(alice).deposit(await token.getAddress(), ethers.parseEther("10000"));
      await lending.connect(alice).toggleCollateral(await token.getAddress(), true);
      await lending.connect(bob).deposit(await stableToken.getAddress(), ethers.parseEther("50000"));
      
      // Alice borrows close to max
      await lending.connect(alice).borrow(await stableToken.getAddress(), ethers.parseEther("7000"));
    });

    it("Should not liquidate healthy position", async function () {
      await expect(
        lending.connect(liquidator).liquidate(
          alice.address,
          await token.getAddress(),
          await stableToken.getAddress(),
          ethers.parseEther("1000")
        )
      ).to.be.revertedWith("Position healthy");
    });

    it("Should liquidate unhealthy position", async function () {
      // Drop SYNX price to make position unhealthy
      // If SYNX drops to 0.8, collateral = 10000 * 0.8 * 0.75 = 6000 < 7000 debt
      await lending.setPrice(await token.getAddress(), ethers.parseEther("0.8"));

      const healthFactor = await lending.getHealthFactor(alice.address);
      expect(healthFactor).to.be.lt(ethers.parseEther("1"));

      // Liquidator repays part of debt
      await stableToken.transfer(liquidator.address, ethers.parseEther("10000"));
      await stableToken.connect(liquidator).approve(await lending.getAddress(), ethers.MaxUint256);

      await lending.connect(liquidator).liquidate(
        alice.address,
        await token.getAddress(),
        await stableToken.getAddress(),
        ethers.parseEther("3500") // 50% of debt
      );

      // Alice's debt should be reduced
      const newDebt = await lending.getBorrowBalance(alice.address, await stableToken.getAddress());
      expect(newDebt).to.be.lt(ethers.parseEther("7000"));
    });

    it("Should not allow self-liquidation", async function () {
      await lending.setPrice(await token.getAddress(), ethers.parseEther("0.8"));

      await expect(
        lending.connect(alice).liquidate(
          alice.address,
          await token.getAddress(),
          await stableToken.getAddress(),
          ethers.parseEther("1000")
        )
      ).to.be.revertedWith("Cannot self-liquidate");
    });
  });

  describe("User Account Data", function () {
    it("Should return correct account data", async function () {
      await lending.connect(alice).deposit(await token.getAddress(), ethers.parseEther("10000"));
      await lending.connect(alice).toggleCollateral(await token.getAddress(), true);
      await lending.connect(bob).deposit(await stableToken.getAddress(), ethers.parseEther("50000"));
      await lending.connect(alice).borrow(await stableToken.getAddress(), ethers.parseEther("5000"));

      const accountData = await lending.getUserAccountData(alice.address);

      expect(accountData.totalDeposits).to.equal(ethers.parseEther("10000"));
      expect(accountData.totalBorrows).to.equal(ethers.parseEther("5000"));
      expect(accountData.availableBorrows).to.be.closeTo(ethers.parseEther("2500"), ethers.parseEther("100"));
      expect(accountData.healthFactor).to.be.closeTo(ethers.parseEther("1.5"), ethers.parseEther("0.1"));
    });
  });

  describe("Admin Functions", function () {
    it("Should update market parameters", async function () {
      await lending.updateMarket(
        await token.getAddress(),
        8000, // new collateral factor
        600,  // new liquidation bonus
        true,
        true
      );

      const market = await lending.markets(await token.getAddress());
      expect(market.collateralFactor).to.equal(8000n);
      expect(market.liquidationBonus).to.equal(600n);
    });

    it("Should pause and unpause", async function () {
      await lending.pause();

      await expect(
        lending.connect(alice).deposit(await token.getAddress(), ethers.parseEther("1000"))
      ).to.be.reverted;

      await lending.unpause();

      await lending.connect(alice).deposit(await token.getAddress(), ethers.parseEther("1000"));
    });
  });
});
