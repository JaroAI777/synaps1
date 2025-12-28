/**
 * SYNAPSE Protocol - Liquidation Bot
 * 
 * Automated liquidation service for the lending protocol
 * Features:
 * - Position monitoring
 * - Health factor tracking
 * - Automated liquidations
 * - Profit calculation
 * - Gas optimization
 */

const { ethers } = require('ethers');
const Redis = require('ioredis');

// Configuration
const CONFIG = {
  rpcUrl: process.env.RPC_URL,
  wsRpcUrl: process.env.WS_RPC_URL,
  privateKey: process.env.LIQUIDATOR_PRIVATE_KEY,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  
  // Contract addresses
  contracts: {
    lending: process.env.LENDING_ADDRESS,
    token: process.env.TOKEN_ADDRESS
  },
  
  // Liquidation parameters
  params: {
    minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || '10'),
    maxGasPrice: parseFloat(process.env.MAX_GAS_GWEI || '50'),
    healthFactorThreshold: parseFloat(process.env.HF_THRESHOLD || '1.0'),
    checkInterval: parseInt(process.env.CHECK_INTERVAL || '5000'),
    batchSize: parseInt(process.env.BATCH_SIZE || '100'),
    maxConcurrentLiquidations: parseInt(process.env.MAX_CONCURRENT || '3')
  },
  
  // Telegram alerts
  telegram: {
    enabled: process.env.TELEGRAM_ENABLED === 'true',
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  }
};

// ABIs
const LENDING_ABI = [
  'function getHealthFactor(address user) view returns (uint256)',
  'function getUserAccountData(address user) view returns (uint256 totalDeposits, uint256 totalBorrows, uint256 availableBorrows, uint256 healthFactor)',
  'function liquidate(address borrower, address collateralToken, address debtToken, uint256 debtToCover)',
  'function markets(address token) view returns (address token, uint256 totalDeposits, uint256 totalBorrows, uint256 depositRate, uint256 borrowRate, uint256 collateralFactor, uint256 liquidationBonus, uint256 reserveFactor, uint256 lastUpdateTime, uint256 borrowIndex, uint256 depositIndex, bool isActive, bool canBorrow, bool canCollateral)',
  'function getDepositBalance(address user, address token) view returns (uint256)',
  'function getBorrowBalance(address user, address token) view returns (uint256)',
  'function getPrice(address token) view returns (uint256)',
  'event Deposit(address indexed user, address indexed token, uint256 amount)',
  'event Borrow(address indexed user, address indexed token, uint256 amount)',
  'event Repay(address indexed user, address indexed token, uint256 amount)',
  'event Liquidation(address indexed liquidator, address indexed borrower, address indexed collateralToken, address debtToken, uint256 debtRepaid, uint256 collateralSeized)'
];

const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

/**
 * Liquidation Bot
 */
class LiquidationBot {
  constructor() {
    this.provider = null;
    this.wallet = null;
    this.redis = null;
    this.lendingContract = null;
    this.trackedPositions = new Map();
    this.pendingLiquidations = new Set();
    this.stats = {
      positionsChecked: 0,
      liquidationsAttempted: 0,
      liquidationsSuccessful: 0,
      totalProfit: 0n,
      lastCheck: null
    };
  }

  async initialize() {
    console.log('🤖 Initializing Liquidation Bot...');

    // Connect to provider
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    this.wallet = new ethers.Wallet(CONFIG.privateKey, this.provider);
    
    console.log(`📍 Liquidator address: ${this.wallet.address}`);

    // Connect to Redis
    this.redis = new Redis(CONFIG.redisUrl);
    console.log('📦 Connected to Redis');

    // Initialize contracts
    this.lendingContract = new ethers.Contract(
      CONFIG.contracts.lending,
      LENDING_ABI,
      this.wallet
    );

    // Load tracked positions
    await this.loadTrackedPositions();

    // Subscribe to events
    if (CONFIG.wsRpcUrl) {
      await this.subscribeToEvents();
    }

    console.log('✅ Liquidation Bot initialized');
  }

  async loadTrackedPositions() {
    const positions = await this.redis.smembers('liquidation:tracked_positions');
    
    for (const position of positions) {
      const data = await this.redis.hgetall(`liquidation:position:${position}`);
      if (data && Object.keys(data).length > 0) {
        this.trackedPositions.set(position, {
          address: position,
          lastHealthFactor: parseFloat(data.healthFactor || '0'),
          lastCheck: parseInt(data.lastCheck || '0'),
          deposits: JSON.parse(data.deposits || '{}'),
          borrows: JSON.parse(data.borrows || '{}')
        });
      }
    }

    console.log(`📋 Loaded ${this.trackedPositions.size} tracked positions`);
  }

  async subscribeToEvents() {
    const wsProvider = new ethers.WebSocketProvider(CONFIG.wsRpcUrl);
    const wsContract = new ethers.Contract(
      CONFIG.contracts.lending,
      LENDING_ABI,
      wsProvider
    );

    // Track new deposits
    wsContract.on('Deposit', async (user, token, amount) => {
      console.log(`📥 Deposit: ${user} deposited ${ethers.formatEther(amount)}`);
      await this.trackPosition(user);
    });

    // Track new borrows
    wsContract.on('Borrow', async (user, token, amount) => {
      console.log(`💰 Borrow: ${user} borrowed ${ethers.formatEther(amount)}`);
      await this.trackPosition(user);
    });

    // Track repayments
    wsContract.on('Repay', async (user, token, amount) => {
      console.log(`💳 Repay: ${user} repaid ${ethers.formatEther(amount)}`);
      await this.updatePosition(user);
    });

    console.log('📡 Subscribed to lending events');
  }

  async trackPosition(user) {
    await this.redis.sadd('liquidation:tracked_positions', user);
    await this.updatePosition(user);
  }

  async updatePosition(user) {
    try {
      const accountData = await this.lendingContract.getUserAccountData(user);
      const healthFactor = parseFloat(ethers.formatEther(accountData.healthFactor));

      const position = {
        address: user,
        lastHealthFactor: healthFactor,
        lastCheck: Date.now(),
        totalDeposits: accountData.totalDeposits.toString(),
        totalBorrows: accountData.totalBorrows.toString()
      };

      this.trackedPositions.set(user, position);

      await this.redis.hset(`liquidation:position:${user}`, {
        healthFactor: healthFactor.toString(),
        lastCheck: position.lastCheck.toString(),
        totalDeposits: position.totalDeposits,
        totalBorrows: position.totalBorrows
      });

      // Check if liquidatable
      if (healthFactor < CONFIG.params.healthFactorThreshold && !this.pendingLiquidations.has(user)) {
        console.log(`⚠️  Position ${user} is liquidatable! HF: ${healthFactor.toFixed(4)}`);
        await this.queueLiquidation(user);
      }
    } catch (error) {
      console.error(`Error updating position ${user}:`, error.message);
    }
  }

  async queueLiquidation(user) {
    if (this.pendingLiquidations.size >= CONFIG.params.maxConcurrentLiquidations) {
      await this.redis.lpush('liquidation:queue', user);
      return;
    }

    this.pendingLiquidations.add(user);
    
    try {
      await this.executeLiquidation(user);
    } finally {
      this.pendingLiquidations.delete(user);
      
      // Process queue
      const next = await this.redis.rpop('liquidation:queue');
      if (next) {
        await this.queueLiquidation(next);
      }
    }
  }

  async executeLiquidation(borrower) {
    console.log(`\n🎯 Attempting liquidation of ${borrower}`);
    this.stats.liquidationsAttempted++;

    try {
      // Check gas price
      const feeData = await this.provider.getFeeData();
      const gasPriceGwei = parseFloat(ethers.formatUnits(feeData.gasPrice, 'gwei'));
      
      if (gasPriceGwei > CONFIG.params.maxGasPrice) {
        console.log(`⏸️  Gas price too high: ${gasPriceGwei.toFixed(2)} gwei`);
        return;
      }

      // Get position details
      const accountData = await this.lendingContract.getUserAccountData(borrower);
      const healthFactor = parseFloat(ethers.formatEther(accountData.healthFactor));

      if (healthFactor >= CONFIG.params.healthFactorThreshold) {
        console.log(`Position ${borrower} is no longer liquidatable`);
        return;
      }

      // Find best liquidation opportunity
      const opportunity = await this.findBestOpportunity(borrower);
      if (!opportunity) {
        console.log('No profitable liquidation opportunity found');
        return;
      }

      console.log(`📊 Opportunity found:`);
      console.log(`   Collateral: ${opportunity.collateralToken}`);
      console.log(`   Debt:       ${opportunity.debtToken}`);
      console.log(`   Amount:     ${ethers.formatEther(opportunity.debtToCover)}`);
      console.log(`   Profit:     ${ethers.formatEther(opportunity.expectedProfit)}`);

      // Ensure we have enough tokens
      const tokenContract = new ethers.Contract(opportunity.debtToken, TOKEN_ABI, this.wallet);
      const balance = await tokenContract.balanceOf(this.wallet.address);
      
      if (balance < opportunity.debtToCover) {
        console.log('Insufficient balance for liquidation');
        await this.sendAlert(`Insufficient balance for liquidation of ${borrower}`);
        return;
      }

      // Check and set allowance
      const allowance = await tokenContract.allowance(this.wallet.address, CONFIG.contracts.lending);
      if (allowance < opportunity.debtToCover) {
        console.log('Approving tokens...');
        const approveTx = await tokenContract.approve(CONFIG.contracts.lending, ethers.MaxUint256);
        await approveTx.wait();
      }

      // Execute liquidation
      console.log('Executing liquidation...');
      const tx = await this.lendingContract.liquidate(
        borrower,
        opportunity.collateralToken,
        opportunity.debtToken,
        opportunity.debtToCover,
        {
          gasLimit: 500000,
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
        }
      );

      const receipt = await tx.wait();

      if (receipt.status === 1) {
        this.stats.liquidationsSuccessful++;
        this.stats.totalProfit += opportunity.expectedProfit;

        console.log(`✅ Liquidation successful!`);
        console.log(`   TX: ${receipt.hash}`);
        console.log(`   Gas used: ${receipt.gasUsed.toString()}`);

        await this.sendAlert(
          `🎉 Liquidation successful!\n` +
          `Borrower: ${borrower}\n` +
          `Profit: ${ethers.formatEther(opportunity.expectedProfit)} SYNX\n` +
          `TX: ${receipt.hash}`
        );

        // Log to Redis
        await this.redis.lpush('liquidation:history', JSON.stringify({
          borrower,
          collateralToken: opportunity.collateralToken,
          debtToken: opportunity.debtToken,
          debtRepaid: opportunity.debtToCover.toString(),
          profit: opportunity.expectedProfit.toString(),
          txHash: receipt.hash,
          timestamp: Date.now()
        }));
      }
    } catch (error) {
      console.error(`❌ Liquidation failed:`, error.message);
      await this.sendAlert(`Liquidation of ${borrower} failed: ${error.message}`);
    }
  }

  async findBestOpportunity(borrower) {
    // This is simplified - in production, you'd iterate through all markets
    // and find the best collateral/debt pair
    
    const tokenAddress = CONFIG.contracts.token;
    
    try {
      const [depositBalance, borrowBalance, price, marketInfo] = await Promise.all([
        this.lendingContract.getDepositBalance(borrower, tokenAddress),
        this.lendingContract.getBorrowBalance(borrower, tokenAddress),
        this.lendingContract.getPrice(tokenAddress),
        this.lendingContract.markets(tokenAddress)
      ]);

      if (borrowBalance === 0n) return null;

      // Calculate max liquidatable (50% of debt)
      const maxLiquidatable = borrowBalance / 2n;
      const liquidationBonus = marketInfo.liquidationBonus;

      // Calculate expected profit
      const collateralValue = (maxLiquidatable * price * (10000n + liquidationBonus)) / (10000n * ethers.parseEther('1'));
      const expectedProfit = (collateralValue * liquidationBonus) / 10000n;

      // Check if profitable after gas
      const minProfit = ethers.parseEther(CONFIG.params.minProfitUsd.toString());
      if (expectedProfit < minProfit) return null;

      return {
        collateralToken: tokenAddress,
        debtToken: tokenAddress,
        debtToCover: maxLiquidatable,
        collateralToSeize: collateralValue,
        expectedProfit,
        liquidationBonus: Number(liquidationBonus)
      };
    } catch (error) {
      console.error('Error finding opportunity:', error.message);
      return null;
    }
  }

  async checkAllPositions() {
    console.log(`\n🔍 Checking ${this.trackedPositions.size} positions...`);
    this.stats.lastCheck = new Date();

    const positions = Array.from(this.trackedPositions.keys());
    
    for (let i = 0; i < positions.length; i += CONFIG.params.batchSize) {
      const batch = positions.slice(i, i + CONFIG.params.batchSize);
      
      await Promise.all(batch.map(async (user) => {
        await this.updatePosition(user);
        this.stats.positionsChecked++;
      }));

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`✅ Check complete. Stats: ${JSON.stringify(this.getStats())}`);
  }

  async sendAlert(message) {
    if (!CONFIG.telegram.enabled) return;

    try {
      const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CONFIG.telegram.chatId,
          text: message,
          parse_mode: 'HTML'
        })
      });
    } catch (error) {
      console.error('Failed to send Telegram alert:', error.message);
    }
  }

  getStats() {
    return {
      ...this.stats,
      totalProfit: ethers.formatEther(this.stats.totalProfit),
      trackedPositions: this.trackedPositions.size,
      pendingLiquidations: this.pendingLiquidations.size
    };
  }

  async start() {
    console.log('\n🚀 Starting Liquidation Bot...\n');

    // Initial check
    await this.checkAllPositions();

    // Periodic checks
    setInterval(async () => {
      await this.checkAllPositions();
    }, CONFIG.params.checkInterval);

    // Stats logging
    setInterval(() => {
      console.log(`📊 Stats: ${JSON.stringify(this.getStats())}`);
    }, 60000);

    console.log(`\n⏰ Running checks every ${CONFIG.params.checkInterval / 1000}s`);
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
