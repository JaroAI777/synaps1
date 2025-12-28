const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SynapsePerpetual", function () {
  let perpetual, collateralToken;
  let owner, oracle, keeper, trader1, trader2, liquidator;
  
  const INITIAL_SUPPLY = ethers.parseEther("1000000000");
  const HOUR = 3600;
  
  let marketId;

  beforeEach(async function () {
    [owner, oracle, keeper, trader1, trader2, liquidator] = await ethers.getSigners();

    // Deploy collateral token
    const Token = await ethers.getContractFactory("SynapseToken");
    collateralToken = await Token.deploy("USDC", "USDC", INITIAL_SUPPLY, owner.address, owner.address);

    // Deploy perpetual
    const Perpetual = await ethers.getContractFactory("SynapsePerpetual");
    perpetual = await Perpetual.deploy(await collateralToken.getAddress());

    // Setup roles
    const ORACLE_ROLE = await perpetual.ORACLE_ROLE();
    const KEEPER_ROLE = await perpetual.KEEPER_ROLE();
    await perpetual.grantRole(ORACLE_ROLE, oracle.address);
    await perpetual.grantRole(KEEPER_ROLE, keeper.address);

    // Fund traders
    const traderFunds = ethers.parseEther("100000");
    await collateralToken.transfer(trader1.address, traderFunds);
    await collateralToken.transfer(trader2.address, traderFunds);
    await collateralToken.transfer(liquidator.address, traderFunds);

    // Approvals
    const maxApproval = ethers.MaxUint256;
    await collateralToken.connect(trader1).approve(await perpetual.getAddress(), maxApproval);
    await collateralToken.connect(trader2).approve(await perpetual.getAddress(), maxApproval);

    // Create market
    const tx = await perpetual.createMarket(
      "BTC-PERP",
      await collateralToken.getAddress(),
      100, // 100x max leverage
      100, // 1% maintenance margin
      10,  // 0.1% taker fee
      5    // 0.05% maker fee
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment?.name === 'MarketCreated');
    marketId = event.args[0];

    // Set initial price
    await perpetual.connect(oracle).updatePrice(
      marketId,
      ethers.parseUnits("50000", 8), // $50,000 index price
      ethers.parseUnits("50000", 8)  // $50,000 mark price
    );
  });

  describe("Market Creation", function () {
    it("Should create market with correct parameters", async function () {
      const market = await perpetual.getMarket(marketId);
      
      expect(market.symbol).to.equal("BTC-PERP");
      expect(market.maxLeverage).to.equal(100n);
      expect(market.maintenanceMargin).to.equal(100n);
      expect(market.isActive).to.be.true;
    });

    it("Should reject leverage > 100", async function () {
      await expect(
        perpetual.createMarket("ETH-PERP", await collateralToken.getAddress(), 150, 100, 10, 5)
      ).to.be.revertedWith("Invalid leverage");
    });

    it("Should update prices", async function () {
      await perpetual.connect(oracle).updatePrice(
        marketId,
        ethers.parseUnits("51000", 8),
        ethers.parseUnits("51000", 8)
      );

      const market = await perpetual.getMarket(marketId);
      expect(market.indexPrice).to.equal(ethers.parseUnits("51000", 8));
    });
  });

  describe("Position Opening", function () {
    it("Should open long position", async function () {
      const margin = ethers.parseEther("1000");
      const size = ethers.parseEther("0.1"); // 0.1 BTC
      const leverage = 10;

      await perpetual.connect(trader1).openPosition(
        marketId,
        0, // LONG
        size,
        margin,
        leverage
      );

      const position = await perpetual.getPosition(marketId, trader1.address);
      expect(position.size).to.equal(size);
      expect(position.side).to.equal(0); // LONG
      expect(position.leverage).to.equal(BigInt(leverage));
    });

    it("Should open short position", async function () {
      const margin = ethers.parseEther("1000");
      const size = ethers.parseEther("0.1");
      const leverage = 10;

      await perpetual.connect(trader1).openPosition(
        marketId,
        1, // SHORT
        size,
        margin,
        leverage
      );

      const position = await perpetual.getPosition(marketId, trader1.address);
      expect(position.side).to.equal(1); // SHORT
    });

    it("Should update open interest", async function () {
      await perpetual.connect(trader1).openPosition(
        marketId,
        0,
        ethers.parseEther("0.1"),
        ethers.parseEther("1000"),
        10
      );

      const market = await perpetual.getMarket(marketId);
      expect(market.openInterestLong).to.equal(ethers.parseEther("0.1"));
    });

    it("Should reject insufficient margin", async function () {
      await expect(
        perpetual.connect(trader1).openPosition(
          marketId,
          0,
          ethers.parseEther("1"),
          ethers.parseEther("100"), // Too low
          50
        )
      ).to.be.revertedWith("Insufficient margin");
    });

    it("Should increase existing position", async function () {
      // Open initial position
      await perpetual.connect(trader1).openPosition(
        marketId,
        0,
        ethers.parseEther("0.1"),
        ethers.parseEther("1000"),
        10
      );

      // Add to position
      await perpetual.connect(trader1).openPosition(
        marketId,
        0,
        ethers.parseEther("0.1"),
        ethers.parseEther("1000"),
        10
      );

      const position = await perpetual.getPosition(marketId, trader1.address);
      expect(position.size).to.equal(ethers.parseEther("0.2"));
    });
  });

  describe("Position Closing", function () {
    beforeEach(async function () {
      // Open long position
      await perpetual.connect(trader1).openPosition(
        marketId,
        0, // LONG
        ethers.parseEther("0.1"),
        ethers.parseEther("1000"),
        10
      );
    });

    it("Should close position with profit", async function () {
      // Price goes up
      await perpetual.connect(oracle).updatePrice(
        marketId,
        ethers.parseUnits("55000", 8),
        ethers.parseUnits("55000", 8)
      );

      const balanceBefore = await collateralToken.balanceOf(trader1.address);
      
      await perpetual.connect(trader1).closePosition(marketId, ethers.parseEther("0.1"));

      const balanceAfter = await collateralToken.balanceOf(trader1.address);
      
      // Should have profit
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should close position with loss", async function () {
      // Price goes down
      await perpetual.connect(oracle).updatePrice(
        marketId,
        ethers.parseUnits("45000", 8),
        ethers.parseUnits("45000", 8)
      );

      const balanceBefore = await collateralToken.balanceOf(trader1.address);
      
      await perpetual.connect(trader1).closePosition(marketId, ethers.parseEther("0.1"));

      const balanceAfter = await collateralToken.balanceOf(trader1.address);
      
      // Should get less than margin back
      expect(balanceAfter - balanceBefore).to.be.lt(ethers.parseEther("1000"));
    });

    it("Should allow partial close", async function () {
      await perpetual.connect(trader1).closePosition(marketId, ethers.parseEther("0.05"));

      const position = await perpetual.getPosition(marketId, trader1.address);
      expect(position.size).to.equal(ethers.parseEther("0.05"));
    });

    it("Should update open interest on close", async function () {
      await perpetual.connect(trader1).closePosition(marketId, ethers.parseEther("0.1"));

      const market = await perpetual.getMarket(marketId);
      expect(market.openInterestLong).to.equal(0n);
    });
  });

  describe("Margin Management", function () {
    beforeEach(async function () {
      await perpetual.connect(trader1).openPosition(
        marketId,
        0,
        ethers.parseEther("0.1"),
        ethers.parseEther("1000"),
        10
      );
    });

    it("Should add margin", async function () {
      await perpetual.connect(trader1).addMargin(marketId, ethers.parseEther("500"));

      const position = await perpetual.getPosition(marketId, trader1.address);
      // Margin should be around 1500 (minus fees)
      expect(position.margin).to.be.gt(ethers.parseEther("1400"));
    });

    it("Should remove excess margin", async function () {
      // Add extra margin first
      await perpetual.connect(trader1).addMargin(marketId, ethers.parseEther("500"));

      await perpetual.connect(trader1).removeMargin(marketId, ethers.parseEther("200"));

      const position = await perpetual.getPosition(marketId, trader1.address);
      expect(position.margin).to.be.lt(ethers.parseEther("1400"));
    });

    it("Should reject removing too much margin", async function () {
      await expect(
        perpetual.connect(trader1).removeMargin(marketId, ethers.parseEther("900"))
      ).to.be.revertedWith("Would be undercollateralized");
    });
  });

  describe("Liquidation", function () {
    beforeEach(async function () {
      // Open leveraged long position
      await perpetual.connect(trader1).openPosition(
        marketId,
        0,
        ethers.parseEther("0.1"),
        ethers.parseEther("500"), // Low margin with high leverage
        50
      );
    });

    it("Should identify liquidatable position", async function () {
      // Price drops significantly
      await perpetual.connect(oracle).updatePrice(
        marketId,
        ethers.parseUnits("48000", 8),
        ethers.parseUnits("48000", 8)
      );

      const isLiquidatable = await perpetual.isLiquidatable(marketId, trader1.address);
      expect(isLiquidatable).to.be.true;
    });

    it("Should liquidate undercollateralized position", async function () {
      // Price drops significantly
      await perpetual.connect(oracle).updatePrice(
        marketId,
        ethers.parseUnits("48000", 8),
        ethers.parseUnits("48000", 8)
      );

      await perpetual.connect(keeper).liquidate(marketId, trader1.address);

      const position = await perpetual.getPosition(marketId, trader1.address);
      expect(position.size).to.equal(0n);
    });

    it("Should reward liquidator", async function () {
      await perpetual.connect(oracle).updatePrice(
        marketId,
        ethers.parseUnits("48000", 8),
        ethers.parseUnits("48000", 8)
      );

      const balanceBefore = await collateralToken.balanceOf(keeper.address);
      
      await perpetual.connect(keeper).liquidate(marketId, trader1.address);

      const balanceAfter = await collateralToken.balanceOf(keeper.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should reject liquidation of healthy position", async function () {
      await expect(
        perpetual.connect(keeper).liquidate(marketId, trader1.address)
      ).to.be.revertedWith("Position healthy");
    });
  });

  describe("Limit Orders", function () {
    it("Should place limit order", async function () {
      await collateralToken.connect(trader1).approve(
        await perpetual.getAddress(),
        ethers.parseEther("1000")
      );

      const tx = await perpetual.connect(trader1).placeLimitOrder(
        marketId,
        0, // LONG
        ethers.parseEther("0.1"),
        ethers.parseUnits("48000", 8), // Buy at $48k
        ethers.parseEther("1000"),
        10,
        24 * HOUR
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment?.name === 'OrderPlaced');
      expect(event).to.not.be.undefined;
    });

    it("Should execute limit order when price reached", async function () {
      await collateralToken.connect(trader1).approve(
        await perpetual.getAddress(),
        ethers.parseEther("1000")
      );

      await perpetual.connect(trader1).placeLimitOrder(
        marketId,
        0,
        ethers.parseEther("0.1"),
        ethers.parseUnits("48000", 8),
        ethers.parseEther("1000"),
        10,
        24 * HOUR
      );

      // Price drops to trigger order
      await perpetual.connect(oracle).updatePrice(
        marketId,
        ethers.parseUnits("47000", 8),
        ethers.parseUnits("47000", 8)
      );

      await perpetual.connect(keeper).executeOrder(1);

      const position = await perpetual.getPosition(marketId, trader1.address);
      expect(position.size).to.be.gt(0n);
    });

    it("Should cancel order and return margin", async function () {
      await collateralToken.connect(trader1).approve(
        await perpetual.getAddress(),
        ethers.parseEther("1000")
      );

      const balanceBefore = await collateralToken.balanceOf(trader1.address);

      await perpetual.connect(trader1).placeLimitOrder(
        marketId,
        0,
        ethers.parseEther("0.1"),
        ethers.parseUnits("48000", 8),
        ethers.parseEther("1000"),
        10,
        24 * HOUR
      );

      await perpetual.connect(trader1).cancelOrder(1);

      const balanceAfter = await collateralToken.balanceOf(trader1.address);
      expect(balanceAfter).to.equal(balanceBefore);
    });
  });

  describe("Funding Rate", function () {
    beforeEach(async function () {
      // Open long position
      await perpetual.connect(trader1).openPosition(
        marketId,
        0,
        ethers.parseEther("0.1"),
        ethers.parseEther("1000"),
        10
      );
    });

    it("Should apply funding rate", async function () {
      // Fast forward 8 hours
      await time.increase(8 * HOUR);

      await perpetual.connect(keeper).applyFunding(marketId);

      const market = await perpetual.getMarket(marketId);
      // Funding rate should be set (longs pay shorts since only long exists)
      expect(market.fundingRate).to.be.gt(0);
    });

    it("Should reject funding before interval", async function () {
      await expect(
        perpetual.connect(keeper).applyFunding(marketId)
      ).to.be.revertedWith("Too early");
    });
  });

  describe("PnL Calculations", function () {
    it("Should calculate unrealized PnL for long", async function () {
      await perpetual.connect(trader1).openPosition(
        marketId,
        0,
        ethers.parseEther("0.1"),
        ethers.parseEther("1000"),
        10
      );

      // Price goes up 10%
      await perpetual.connect(oracle).updatePrice(
        marketId,
        ethers.parseUnits("55000", 8),
        ethers.parseUnits("55000", 8)
      );

      const pnl = await perpetual.getUnrealizedPnL(marketId, trader1.address);
      // 0.1 BTC * $5000 gain = $500 profit
      expect(pnl).to.be.gt(0);
    });

    it("Should calculate unrealized PnL for short", async function () {
      await perpetual.connect(trader1).openPosition(
        marketId,
        1, // SHORT
        ethers.parseEther("0.1"),
        ethers.parseEther("1000"),
        10
      );

      // Price goes down 10%
      await perpetual.connect(oracle).updatePrice(
        marketId,
        ethers.parseUnits("45000", 8),
        ethers.parseUnits("45000", 8)
      );

      const pnl = await perpetual.getUnrealizedPnL(marketId, trader1.address);
      // Short profits when price drops
      expect(pnl).to.be.gt(0);
    });
  });

  describe("Admin Functions", function () {
    it("Should set liquidation fee", async function () {
      await perpetual.setLiquidationFee(300); // 3%
      expect(await perpetual.liquidationFee()).to.equal(300n);
    });

    it("Should pause and unpause", async function () {
      await perpetual.pause();

      await expect(
        perpetual.connect(trader1).openPosition(
          marketId,
          0,
          ethers.parseEther("0.1"),
          ethers.parseEther("1000"),
          10
        )
      ).to.be.reverted;

      await perpetual.unpause();

      await perpetual.connect(trader1).openPosition(
        marketId,
        0,
        ethers.parseEther("0.1"),
        ethers.parseEther("1000"),
        10
      );
    });
  });
});
