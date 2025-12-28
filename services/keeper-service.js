/**
 * SYNAPSE Protocol - Keeper Service
 * 
 * Automated task execution and protocol maintenance
 * Features:
 * - Periodic task scheduling
 * - Liquidation monitoring
 * - Vault harvesting
 * - Oracle price updates
 * - Subscription renewals
 * - Bridge request processing
 */

const { ethers } = require('ethers');
const Redis = require('ioredis');
const cron = require('node-cron');

// Configuration
const CONFIG = {
  port: process.env.KEEPER_PORT || 3009,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  rpcUrl: process.env.RPC_URL,
  privateKey: process.env.KEEPER_PRIVATE_KEY,
  
  // Contract addresses
  contracts: {
    lending: process.env.LENDING_ADDRESS,
    vault: process.env.VAULT_ADDRESS,
    staking: process.env.STAKING_ADDRESS,
    subscriptions: process.env.SUBSCRIPTIONS_ADDRESS,
    bridge: process.env.BRIDGE_ADDRESS,
    yieldFarm: process.env.YIELD_FARM_ADDRESS
  },
  
  // Task intervals
  intervals: {
    liquidationCheck: '*/30 * * * * *',    // Every 30 seconds
    vaultHarvest: '0 */4 * * *',           // Every 4 hours
    stakingRewards: '0 0 * * *',           // Daily at midnight
    subscriptionRenew: '*/5 * * * *',      // Every 5 minutes
    bridgeProcess: '*/1 * * * *',          // Every minute
    priceUpdate: '*/1 * * * *'             // Every minute
  },
  
  // Thresholds
  thresholds: {
    minHealthFactor: ethers.parseEther('1.05'), // Liquidate below 1.05
    minProfit: ethers.parseEther('10'),         // Min 10 SYNX profit for harvest
    maxGasPrice: ethers.parseUnits('50', 'gwei')
  }
};

// Contract ABIs
const ABIS = {
  lending: [
    'function getHealthFactor(address user) view returns (uint256)',
    'function liquidate(address borrower, address collateralToken, address debtToken, uint256 debtToCover)',
    'function getUserAccountData(address user) view returns (uint256 totalDeposits, uint256 totalBorrows, uint256 availableBorrows, uint256 healthFactor)'
  ],
  vault: [
    'function harvestAll()',
    'function rebalance()',
    'function totalAssets() view returns (uint256)',
    'function pricePerShare() view returns (uint256)'
  ],
  staking: [
    'function notifyRewardAmount(uint256 amount, uint256 duration)',
    'function totalStaked() view returns (uint256)',
    'function rewardRate() view returns (uint256)'
  ],
  subscriptions: [
    'function processRenewals(uint256 limit)',
    'function getPendingRenewals() view returns (uint256)'
  ],
  bridge: [
    'function processPendingRequests(uint256 limit)',
    'function getPendingCount() view returns (uint256)'
  ],
  yieldFarm: [
    'function massUpdatePools()'
  ]
};

/**
 * Task Result
 */
class TaskResult {
  constructor(taskName, success, data = null, error = null) {
    this.taskName = taskName;
    this.success = success;
    this.data = data;
    this.error = error;
    this.timestamp = Date.now();
  }
}

/**
 * Keeper Service
 */
class KeeperService {
  constructor() {
    this.redis = null;
    this.provider = null;
    this.wallet = null;
    this.contracts = {};
    this.tasks = new Map();
    this.isRunning = false;
    this.stats = {
      tasksExecuted: 0,
      tasksSucceeded: 0,
      tasksFailed: 0,
      totalGasUsed: 0n,
      liquidationsPerformed: 0,
      harvestsPerformed: 0
    };
  }

  async initialize() {
    console.log('🤖 Initializing Keeper Service...');

    // Connect to Redis
    this.redis = new Redis(CONFIG.redisUrl);
    console.log('📦 Connected to Redis');

    // Connect to blockchain
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    this.wallet = new ethers.Wallet(CONFIG.privateKey, this.provider);
    console.log(`⛓️  Connected as ${this.wallet.address}`);

    // Initialize contracts
    await this.initializeContracts();

    // Register tasks
    this.registerTasks();

    // Load state from Redis
    await this.loadState();

    console.log('✅ Keeper Service initialized');
  }

  async initializeContracts() {
    for (const [name, address] of Object.entries(CONFIG.contracts)) {
      if (address && ABIS[name]) {
        this.contracts[name] = new ethers.Contract(address, ABIS[name], this.wallet);
        console.log(`  📄 ${name}: ${address.slice(0, 10)}...`);
      }
    }
  }

  registerTasks() {
    // Liquidation monitoring
    this.tasks.set('liquidation', {
      name: 'Liquidation Check',
      schedule: CONFIG.intervals.liquidationCheck,
      handler: this.checkLiquidations.bind(this),
      enabled: !!this.contracts.lending
    });

    // Vault harvesting
    this.tasks.set('harvest', {
      name: 'Vault Harvest',
      schedule: CONFIG.intervals.vaultHarvest,
      handler: this.harvestVaults.bind(this),
      enabled: !!this.contracts.vault
    });

    // Staking rewards distribution
    this.tasks.set('staking', {
      name: 'Staking Rewards',
      schedule: CONFIG.intervals.stakingRewards,
      handler: this.distributeStakingRewards.bind(this),
      enabled: !!this.contracts.staking
    });

    // Subscription renewals
    this.tasks.set('subscriptions', {
      name: 'Subscription Renewals',
      schedule: CONFIG.intervals.subscriptionRenew,
      handler: this.processSubscriptions.bind(this),
      enabled: !!this.contracts.subscriptions
    });

    // Bridge request processing
    this.tasks.set('bridge', {
      name: 'Bridge Processing',
      schedule: CONFIG.intervals.bridgeProcess,
      handler: this.processBridgeRequests.bind(this),
      enabled: !!this.contracts.bridge
    });

    // Yield farm pool updates
    this.tasks.set('yieldFarm', {
      name: 'Yield Farm Update',
      schedule: '0 * * * *', // Every hour
      handler: this.updateYieldFarmPools.bind(this),
      enabled: !!this.contracts.yieldFarm
    });

    console.log(`📋 Registered ${this.tasks.size} tasks`);
  }

  async loadState() {
    const state = await this.redis.get('keeper:state');
    if (state) {
      const parsed = JSON.parse(state);
      this.stats = { ...this.stats, ...parsed.stats };
    }
  }

  async saveState() {
    await this.redis.set('keeper:state', JSON.stringify({
      stats: this.stats,
      lastUpdate: Date.now()
    }));
  }

  // ============ Task Handlers ============

  /**
   * Check for liquidatable positions
   */
  async checkLiquidations() {
    const results = [];
    
    try {
      // Get list of borrowers from indexer or events
      const borrowers = await this.getBorrowers();
      
      for (const borrower of borrowers) {
        const healthFactor = await this.contracts.lending.getHealthFactor(borrower);
        
        if (healthFactor < CONFIG.thresholds.minHealthFactor) {
          console.log(`⚠️  Unhealthy position: ${borrower} (HF: ${ethers.formatEther(healthFactor)})`);
          
          // Check if profitable to liquidate
          const isProfitable = await this.checkLiquidationProfitability(borrower);
          
          if (isProfitable) {
            const result = await this.executeLiquidation(borrower);
            results.push(result);
          }
        }
      }
    } catch (error) {
      console.error('Liquidation check error:', error.message);
    }

    return new TaskResult('liquidation', results.length > 0, { liquidations: results.length });
  }

  async getBorrowers() {
    // In production, this would query the indexer or scan events
    const cached = await this.redis.smembers('keeper:borrowers');
    return cached || [];
  }

  async checkLiquidationProfitability(borrower) {
    // Calculate potential profit from liquidation
    // Consider: liquidation bonus, gas costs, flash loan fees
    return true; // Simplified
  }

  async executeLiquidation(borrower) {
    try {
      const gasPrice = await this.provider.getFeeData();
      if (gasPrice.gasPrice > CONFIG.thresholds.maxGasPrice) {
        console.log('⚡ Gas price too high, skipping liquidation');
        return null;
      }

      // Get user's debt and collateral
      const userData = await this.contracts.lending.getUserAccountData(borrower);
      
      // Execute liquidation (simplified)
      // In production: use flash loans for capital efficiency
      const tx = await this.contracts.lending.liquidate(
        borrower,
        CONFIG.contracts.token, // collateral
        CONFIG.contracts.token, // debt
        userData.totalBorrows / 2n // 50% of debt
      );

      const receipt = await tx.wait();
      
      this.stats.liquidationsPerformed++;
      this.stats.totalGasUsed += receipt.gasUsed;

      console.log(`✅ Liquidated ${borrower} (tx: ${receipt.hash.slice(0, 10)}...)`);

      return { borrower, txHash: receipt.hash, gasUsed: receipt.gasUsed.toString() };
    } catch (error) {
      console.error(`❌ Liquidation failed for ${borrower}:`, error.message);
      return null;
    }
  }

  /**
   * Harvest vault profits
   */
  async harvestVaults() {
    try {
      const pricePerShareBefore = await this.contracts.vault.pricePerShare();
      
      const tx = await this.contracts.vault.harvestAll();
      const receipt = await tx.wait();

      const pricePerShareAfter = await this.contracts.vault.pricePerShare();
      const profit = pricePerShareAfter - pricePerShareBefore;

      this.stats.harvestsPerformed++;
      this.stats.totalGasUsed += receipt.gasUsed;

      console.log(`🌾 Vault harvested (profit: ${ethers.formatEther(profit)} per share)`);

      // Also rebalance if needed
      await this.contracts.vault.rebalance();

      return new TaskResult('harvest', true, {
        txHash: receipt.hash,
        profitPerShare: ethers.formatEther(profit)
      });
    } catch (error) {
      console.error('Harvest error:', error.message);
      return new TaskResult('harvest', false, null, error.message);
    }
  }

  /**
   * Distribute staking rewards
   */
  async distributeStakingRewards() {
    try {
      // Check if rewards need to be added
      const rewardRate = await this.contracts.staking.rewardRate();
      
      if (rewardRate === 0n) {
        // Add new rewards period
        const rewardAmount = ethers.parseEther('100000'); // 100k SYNX
        const duration = 30 * 24 * 60 * 60; // 30 days

        const tx = await this.contracts.staking.notifyRewardAmount(rewardAmount, duration);
        await tx.wait();

        console.log(`💰 Added ${ethers.formatEther(rewardAmount)} SYNX rewards`);
      }

      return new TaskResult('staking', true);
    } catch (error) {
      console.error('Staking rewards error:', error.message);
      return new TaskResult('staking', false, null, error.message);
    }
  }

  /**
   * Process subscription renewals
   */
  async processSubscriptions() {
    try {
      const pending = await this.contracts.subscriptions.getPendingRenewals();
      
      if (pending > 0n) {
        const tx = await this.contracts.subscriptions.processRenewals(100);
        const receipt = await tx.wait();

        console.log(`📅 Processed ${pending} subscription renewals`);

        return new TaskResult('subscriptions', true, { processed: pending.toString() });
      }

      return new TaskResult('subscriptions', true, { processed: 0 });
    } catch (error) {
      console.error('Subscription processing error:', error.message);
      return new TaskResult('subscriptions', false, null, error.message);
    }
  }

  /**
   * Process bridge requests
   */
  async processBridgeRequests() {
    try {
      const pending = await this.contracts.bridge.getPendingCount();
      
      if (pending > 0n) {
        const tx = await this.contracts.bridge.processPendingRequests(50);
        const receipt = await tx.wait();

        console.log(`🌉 Processed ${pending} bridge requests`);

        return new TaskResult('bridge', true, { processed: pending.toString() });
      }

      return new TaskResult('bridge', true, { processed: 0 });
    } catch (error) {
      console.error('Bridge processing error:', error.message);
      return new TaskResult('bridge', false, null, error.message);
    }
  }

  /**
   * Update yield farm pools
   */
  async updateYieldFarmPools() {
    try {
      const tx = await this.contracts.yieldFarm.massUpdatePools();
      await tx.wait();

      console.log('🌱 Updated yield farm pools');

      return new TaskResult('yieldFarm', true);
    } catch (error) {
      console.error('Yield farm update error:', error.message);
      return new TaskResult('yieldFarm', false, null, error.message);
    }
  }

  // ============ Scheduler ============

  start() {
    this.isRunning = true;

    for (const [id, task] of this.tasks) {
      if (!task.enabled) {
        console.log(`⏸️  ${task.name}: disabled`);
        continue;
      }

      cron.schedule(task.schedule, async () => {
        if (!this.isRunning) return;

        console.log(`\n⏰ Running: ${task.name}`);
        
        try {
          const result = await task.handler();
          
          this.stats.tasksExecuted++;
          if (result.success) {
            this.stats.tasksSucceeded++;
          } else {
            this.stats.tasksFailed++;
          }

          // Log result
          await this.logTaskResult(id, result);
        } catch (error) {
          this.stats.tasksFailed++;
          console.error(`❌ ${task.name} failed:`, error.message);
        }

        await this.saveState();
      });

      console.log(`✅ ${task.name}: scheduled (${task.schedule})`);
    }

    console.log('\n🚀 Keeper Service started\n');
  }

  stop() {
    this.isRunning = false;
    console.log('🛑 Keeper Service stopped');
  }

  async logTaskResult(taskId, result) {
    const key = `keeper:results:${taskId}`;
    await this.redis.lpush(key, JSON.stringify(result));
    await this.redis.ltrim(key, 0, 99); // Keep last 100 results
  }

  // ============ Status API ============

  getStatus() {
    return {
      isRunning: this.isRunning,
      walletAddress: this.wallet.address,
      stats: this.stats,
      tasks: Array.from(this.tasks.entries()).map(([id, task]) => ({
        id,
        name: task.name,
        enabled: task.enabled,
        schedule: task.schedule
      }))
    };
  }
}

// Express API for monitoring
const express = require('express');
const app = express();

async function main() {
  const keeper = new KeeperService();
  await keeper.initialize();

  // Status endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', ...keeper.getStatus() });
  });

  app.get('/stats', (req, res) => {
    res.json(keeper.stats);
  });

  app.post('/run/:taskId', async (req, res) => {
    const task = keeper.tasks.get(req.params.taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    try {
      const result = await task.handler();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  const server = app.listen(CONFIG.port, () => {
    console.log(`📡 Keeper API running on port ${CONFIG.port}`);
  });

  keeper.start();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    keeper.stop();
    server.close();
  });
}

main().catch(console.error);

module.exports = { KeeperService };
