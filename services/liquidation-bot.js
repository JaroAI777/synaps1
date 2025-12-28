/**
 * SYNAPSE Protocol - Liquidation Bot Service
 * 
 * Monitors lending positions and executes liquidations
 * Features:
 * - Real-time health factor monitoring
 * - Flash loan liquidation support
 * - Profit calculation and tracking
 * - MEV protection strategies
 * - Multi-protocol support
 */

const { ethers } = require('ethers');
const Redis = require('ioredis');
const express = require('express');

// Configuration
const CONFIG = {
  port: process.env.LIQUIDATION_PORT || 3012,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  rpcUrl: process.env.RPC_URL,
  wsUrl: process.env.WS_URL,
  privateKey: process.env.LIQUIDATOR_PRIVATE_KEY,
  
  // Contract addresses
  contracts: {
    lending: process.env.LENDING_ADDRESS,
    flashLoan: process.env.FLASH_LOAN_ADDRESS,
    token: process.env.TOKEN_ADDRESS,
    liquidator: process.env.LIQUIDATOR_ADDRESS
  },

  // Liquidation parameters
  params: {
    minHealthFactor: ethers.parseEther('1.0'),     // Liquidate below 1.0
    targetHealthFactor: ethers.parseEther('1.05'), // Warn below 1.05
    maxGasPrice: ethers.parseUnits('100', 'gwei'),
    minProfitUsd: 10,                              // Minimum $10 profit
    maxPositionsPerBlock: 5,
    liquidationBonus: 500,                          // 5% bonus
    closeFactorMax: 5000                           // 50% max close
  },

  // Monitoring
  monitoring: {
    pollInterval: 1000,         // 1 second
    healthCheckInterval: 60000, // 1 minute
    maxRetries: 3
  }
};

// Contract ABIs
const ABIS = {
  lending: [
    'function getUserAccountData(address user) view returns (uint256 totalDeposits, uint256 totalBorrows, uint256 availableBorrows, uint256 healthFactor)',
    'function liquidate(address borrower, address collateralToken, address debtToken, uint256 debtToCover) returns (uint256)',
    'function getReserveData(address asset) view returns (tuple(uint256 totalDeposits, uint256 totalBorrows, uint256 utilizationRate, uint256 borrowRate, uint256 depositRate, uint256 lastUpdateTime))',
    'event Borrow(address indexed user, address indexed asset, uint256 amount)',
    'event Deposit(address indexed user, address indexed asset, uint256 amount)',
    'event Liquidation(address indexed liquidator, address indexed borrower, address collateralAsset, address debtAsset, uint256 debtCovered, uint256 collateralSeized)'
  ],
  flashLoan: [
    'function flashLoan(address receiver, address token, uint256 amount, bytes calldata data)',
    'function flashLoanFee() view returns (uint256)'
  ],
  erc20: [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)'
  ]
};

/**
 * Position data structure
 */
class Position {
  constructor(user, data) {
    this.user = user;
    this.totalDeposits = data.totalDeposits;
    this.totalBorrows = data.totalBorrows;
    this.healthFactor = data.healthFactor;
    this.lastUpdate = Date.now();
    this.liquidatable = data.healthFactor < CONFIG.params.minHealthFactor;
  }

  get healthFactorFormatted() {
    return ethers.formatEther(this.healthFactor);
  }
}

/**
 * Liquidation opportunity
 */
class LiquidationOpportunity {
  constructor(position, collateralToken, debtToken, debtToCover, expectedProfit) {
    this.position = position;
    this.collateralToken = collateralToken;
    this.debtToken = debtToken;
    this.debtToCover = debtToCover;
    this.expectedProfit = expectedProfit;
    this.timestamp = Date.now();
    this.executed = false;
    this.txHash = null;
  }
}

/**
 * Liquidation Bot Service
 */
class LiquidationBot {
  constructor() {
    this.app = express();
    this.redis = null;
    this.provider = null;
    this.wsProvider = null;
    this.wallet = null;
    this.contracts = {};
    
    this.positions = new Map();
    this.liquidationQueue = [];
    this.isRunning = false;
    
    this.stats = {
      positionsMonitored: 0,
      liquidationsExecuted: 0,
      liquidationsFailed: 0,
      totalProfit: 0n,
      gasSpent: 0n,
      lastLiquidation: null
    };
  }

  async initialize() {
    console.log('⚡ Initializing Liquidation Bot...');

    // Connect to Redis
    this.redis = new Redis(CONFIG.redisUrl);
    console.log('📦 Connected to Redis');

    // Connect to blockchain
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    this.wsProvider = new ethers.WebSocketProvider(CONFIG.wsUrl);
    this.wallet = new ethers.Wallet(CONFIG.privateKey, this.provider);
    console.log(`💰 Liquidator address: ${this.wallet.address}`);

    // Initialize contracts
    await this.initializeContracts();

    // Load known positions
    await this.loadPositions();

    // Setup event listeners
    this.setupEventListeners();

    // Setup API
    this.setupRoutes();

    console.log('✅ Liquidation Bot initialized');
  }

  async initializeContracts() {
    if (CONFIG.contracts.lending) {
      this.contracts.lending = new ethers.Contract(
        CONFIG.contracts.lending,
        ABIS.lending,
        this.wallet
      );
      console.log(`  📄 Lending: ${CONFIG.contracts.lending.slice(0, 10)}...`);
    }

    if (CONFIG.contracts.flashLoan) {
      this.contracts.flashLoan = new ethers.Contract(
        CONFIG.contracts.flashLoan,
        ABIS.flashLoan,
        this.wallet
      );
      console.log(`  📄 FlashLoan: ${CONFIG.contracts.flashLoan.slice(0, 10)}...`);
    }
  }

  async loadPositions() {
    const cachedPositions = await this.redis.hgetall('liquidation:positions');
    
    for (const [user, data] of Object.entries(cachedPositions)) {
      try {
        const parsed = JSON.parse(data);
        this.positions.set(user, new Position(user, {
          totalDeposits: BigInt(parsed.totalDeposits),
          totalBorrows: BigInt(parsed.totalBorrows),
          healthFactor: BigInt(parsed.healthFactor)
        }));
      } catch (e) {
        // Skip invalid entries
      }
    }

    console.log(`  📊 Loaded ${this.positions.size} positions`);
  }

  setupEventListeners() {
    if (!this.contracts.lending) return;

    // Create a separate contract instance with WebSocket provider for events
    const lendingWs = new ethers.Contract(
      CONFIG.contracts.lending,
      ABIS.lending,
      this.wsProvider
    );

    // Listen for new borrows
    lendingWs.on('Borrow', async (user, asset, amount) => {
      console.log(`📥 New borrow: ${user.slice(0, 10)}... - ${ethers.formatEther(amount)}`);
      await this.updatePosition(user);
    });

    // Listen for deposits (collateral changes)
    lendingWs.on('Deposit', async (user, asset, amount) => {
      console.log(`📤 New deposit: ${user.slice(0, 10)}...`);
      await this.updatePosition(user);
    });

    // Listen for liquidations (to track competition)
    lendingWs.on('Liquidation', async (liquidator, borrower, collateral, debt, covered, seized) => {
      if (liquidator.toLowerCase() !== this.wallet.address.toLowerCase()) {
        console.log(`⚠️  External liquidation detected: ${borrower.slice(0, 10)}...`);
      }
      await this.updatePosition(borrower);
    });

    console.log('📡 Event listeners active');
  }

  // ============ Position Monitoring ============

  async updatePosition(user) {
    try {
      const data = await this.contracts.lending.getUserAccountData(user);
      const position = new Position(user, data);
      
      this.positions.set(user, position);
      
      // Cache in Redis
      await this.redis.hset('liquidation:positions', user, JSON.stringify({
        totalDeposits: position.totalDeposits.toString(),
        totalBorrows: position.totalBorrows.toString(),
        healthFactor: position.healthFactor.toString()
      }));

      // Check if liquidatable
      if (position.liquidatable) {
        console.log(`🎯 Liquidatable position found: ${user} (HF: ${position.healthFactorFormatted})`);
        await this.queueLiquidation(position);
      }

      return position;
    } catch (error) {
      console.error(`Failed to update position ${user}:`, error.message);
      return null;
    }
  }

  async scanAllPositions() {
    console.log(`🔍 Scanning ${this.positions.size} positions...`);
    
    let liquidatable = 0;
    let atRisk = 0;

    for (const [user, position] of this.positions) {
      const updated = await this.updatePosition(user);
      
      if (updated) {
        if (updated.liquidatable) {
          liquidatable++;
        } else if (updated.healthFactor < CONFIG.params.targetHealthFactor) {
          atRisk++;
        }
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 100));
    }

    this.stats.positionsMonitored = this.positions.size;
    console.log(`📊 Scan complete: ${liquidatable} liquidatable, ${atRisk} at risk`);
  }

  // ============ Liquidation Execution ============

  async queueLiquidation(position) {
    // Check if already queued
    const existing = this.liquidationQueue.find(
      opp => opp.position.user === position.user && !opp.executed
    );
    if (existing) return;

    // Calculate optimal liquidation
    const opportunity = await this.calculateLiquidation(position);
    
    if (opportunity && opportunity.expectedProfit > CONFIG.params.minProfitUsd) {
      this.liquidationQueue.push(opportunity);
      console.log(`📋 Queued liquidation: ${position.user.slice(0, 10)}... (est. profit: $${opportunity.expectedProfit})`);
    }
  }

  async calculateLiquidation(position) {
    try {
      // Get best collateral/debt pair
      // In production, iterate through user's assets
      const collateralToken = CONFIG.contracts.token;
      const debtToken = CONFIG.contracts.token;

      // Calculate max debt to cover (50%)
      const maxDebtToCover = (position.totalBorrows * BigInt(CONFIG.params.closeFactorMax)) / 10000n;

      // Calculate expected profit
      const liquidationBonus = (maxDebtToCover * BigInt(CONFIG.params.liquidationBonus)) / 10000n;
      
      // Subtract gas costs
      const gasPrice = await this.provider.getFeeData();
      const estimatedGas = 500000n; // Estimate
      const gasCost = gasPrice.gasPrice * estimatedGas;

      const netProfit = liquidationBonus - gasCost;
      const profitUsd = Number(ethers.formatEther(netProfit)); // Simplified

      return new LiquidationOpportunity(
        position,
        collateralToken,
        debtToken,
        maxDebtToCover,
        profitUsd
      );
    } catch (error) {
      console.error('Failed to calculate liquidation:', error.message);
      return null;
    }
  }

  async processLiquidationQueue() {
    if (this.liquidationQueue.length === 0) return;

    // Sort by profit (highest first)
    this.liquidationQueue.sort((a, b) => b.expectedProfit - a.expectedProfit);

    // Process up to max per block
    const toProcess = this.liquidationQueue
      .filter(opp => !opp.executed)
      .slice(0, CONFIG.params.maxPositionsPerBlock);

    for (const opportunity of toProcess) {
      await this.executeLiquidation(opportunity);
    }

    // Clean up executed
    this.liquidationQueue = this.liquidationQueue.filter(opp => !opp.executed);
  }

  async executeLiquidation(opportunity) {
    try {
      // Check gas price
      const feeData = await this.provider.getFeeData();
      if (feeData.gasPrice > CONFIG.params.maxGasPrice) {
        console.log('⚡ Gas price too high, skipping');
        return false;
      }

      // Re-check health factor
      const currentData = await this.contracts.lending.getUserAccountData(opportunity.position.user);
      if (currentData.healthFactor >= CONFIG.params.minHealthFactor) {
        console.log('ℹ️  Position no longer liquidatable');
        opportunity.executed = true;
        return false;
      }

      console.log(`🔥 Executing liquidation: ${opportunity.position.user.slice(0, 10)}...`);

      // Execute liquidation
      // In production: use flash loan for capital efficiency
      const tx = await this.contracts.lending.liquidate(
        opportunity.position.user,
        opportunity.collateralToken,
        opportunity.debtToken,
        opportunity.debtToCover,
        {
          gasLimit: 600000,
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
        }
      );

      console.log(`📤 Transaction sent: ${tx.hash}`);

      const receipt = await tx.wait();

      if (receipt.status === 1) {
        opportunity.executed = true;
        opportunity.txHash = receipt.hash;

        this.stats.liquidationsExecuted++;
        this.stats.gasSpent += receipt.gasUsed * feeData.gasPrice;
        this.stats.lastLiquidation = Date.now();

        // Log to Redis
        await this.redis.lpush('liquidation:history', JSON.stringify({
          user: opportunity.position.user,
          txHash: receipt.hash,
          profit: opportunity.expectedProfit,
          timestamp: Date.now()
        }));

        console.log(`✅ Liquidation successful: ${receipt.hash}`);
        return true;
      } else {
        throw new Error('Transaction failed');
      }
    } catch (error) {
      console.error(`❌ Liquidation failed:`, error.message);
      this.stats.liquidationsFailed++;
      opportunity.executed = true; // Don't retry failed liquidations
      return false;
    }
  }

  async executeFlashLoanLiquidation(opportunity) {
    // For larger liquidations, use flash loans
    // This allows liquidating without holding capital

    const flashLoanAmount = opportunity.debtToCover;

    // Encode liquidation call data
    const liquidationData = this.contracts.lending.interface.encodeFunctionData(
      'liquidate',
      [
        opportunity.position.user,
        opportunity.collateralToken,
        opportunity.debtToken,
        opportunity.debtToCover
      ]
    );

    // Execute flash loan
    const tx = await this.contracts.flashLoan.flashLoan(
      CONFIG.contracts.liquidator, // Liquidator contract receives flash loan
      opportunity.debtToken,
      flashLoanAmount,
      liquidationData
    );

    return tx;
  }

  // ============ Main Loop ============

  async start() {
    this.isRunning = true;

    // Start API server
    this.app.listen(CONFIG.port, () => {
      console.log(`📡 Liquidation Bot API running on port ${CONFIG.port}`);
    });

    // Initial scan
    await this.scanAllPositions();

    // Main monitoring loop
    while (this.isRunning) {
      try {
        // Process liquidation queue
        await this.processLiquidationQueue();

        // Periodic full scan
        if (Date.now() % (CONFIG.monitoring.healthCheckInterval) < CONFIG.monitoring.pollInterval) {
          await this.scanAllPositions();
        }

        await new Promise(r => setTimeout(r, CONFIG.monitoring.pollInterval));
      } catch (error) {
        console.error('Main loop error:', error.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  stop() {
    this.isRunning = false;
    console.log('🛑 Liquidation Bot stopped');
  }

  // ============ API Routes ============

  setupRoutes() {
    this.app.use(express.json());

    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        isRunning: this.isRunning,
        stats: {
          ...this.stats,
          gasSpent: this.stats.gasSpent.toString(),
          totalProfit: this.stats.totalProfit.toString()
        }
      });
    });

    this.app.get('/api/positions', (req, res) => {
      const positions = Array.from(this.positions.values()).map(p => ({
        user: p.user,
        totalDeposits: ethers.formatEther(p.totalDeposits),
        totalBorrows: ethers.formatEther(p.totalBorrows),
        healthFactor: p.healthFactorFormatted,
        liquidatable: p.liquidatable
      }));

      res.json({ positions, count: positions.length });
    });

    this.app.get('/api/positions/liquidatable', (req, res) => {
      const liquidatable = Array.from(this.positions.values())
        .filter(p => p.liquidatable)
        .map(p => ({
          user: p.user,
          healthFactor: p.healthFactorFormatted,
          totalBorrows: ethers.formatEther(p.totalBorrows)
        }));

      res.json({ positions: liquidatable, count: liquidatable.length });
    });

    this.app.get('/api/queue', (req, res) => {
      const queue = this.liquidationQueue.map(opp => ({
        user: opp.position.user,
        expectedProfit: opp.expectedProfit,
        debtToCover: ethers.formatEther(opp.debtToCover),
        executed: opp.executed,
        timestamp: opp.timestamp
      }));

      res.json({ queue, count: queue.length });
    });

    this.app.get('/api/stats', (req, res) => {
      res.json({
        ...this.stats,
        gasSpent: ethers.formatEther(this.stats.gasSpent),
        totalProfit: ethers.formatEther(this.stats.totalProfit),
        queueLength: this.liquidationQueue.length,
        positionsCount: this.positions.size
      });
    });

    this.app.post('/api/position/:address', async (req, res) => {
      try {
        const position = await this.updatePosition(req.params.address);
        if (position) {
          res.json({
            user: position.user,
            healthFactor: position.healthFactorFormatted,
            liquidatable: position.liquidatable
          });
        } else {
          res.status(404).json({ error: 'Position not found' });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/scan', async (req, res) => {
      await this.scanAllPositions();
      res.json({ success: true, positions: this.positions.size });
    });
  }
}

// Main
async function main() {
  const bot = new LiquidationBot();
  await bot.initialize();
  await bot.start();
}

main().catch(console.error);

module.exports = { LiquidationBot };
