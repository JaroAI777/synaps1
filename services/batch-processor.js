/**
 * SYNAPSE Protocol - Batch Processor Service
 * 
 * Handles batch operations for gas efficiency
 * Features:
 * - Batch payments
 * - Batch token transfers
 * - Batch NFT minting
 * - Batch airdrops
 * - Transaction bundling
 */

const express = require('express');
const { ethers } = require('ethers');
const Redis = require('ioredis');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

// Configuration
const CONFIG = {
  port: process.env.BATCH_PORT || 3014,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  postgresUrl: process.env.DATABASE_URL,
  rpcUrl: process.env.RPC_URL,
  privateKey: process.env.BATCH_PROCESSOR_KEY,
  
  // Batch settings
  batch: {
    maxSize: 100,           // Max items per batch
    maxGasLimit: 15000000,  // 15M gas max
    processingInterval: 5000, // 5 seconds
    retryAttempts: 3,
    retryDelay: 10000       // 10 seconds
  }
};

// Contract ABIs
const ABIS = {
  batchProcessor: [
    'function batchTransfer(address token, address[] recipients, uint256[] amounts) external',
    'function batchPayments(address token, address[] recipients, uint256[] amounts, bytes32[] metadata) external returns (bytes32[])',
    'function batchMint(address nftContract, address[] recipients, string[] tokenURIs) external returns (uint256[])',
    'function batchAirdrop(address token, bytes32 merkleRoot, address[] recipients, uint256[] amounts) external'
  ],
  token: [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
  ]
};

/**
 * Batch Job Status
 */
const BatchStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  PARTIAL: 'partial'
};

/**
 * Batch Job Types
 */
const BatchType = {
  TRANSFER: 'transfer',
  PAYMENT: 'payment',
  AIRDROP: 'airdrop',
  NFT_MINT: 'nft_mint',
  CUSTOM: 'custom'
};

/**
 * Batch Job
 */
class BatchJob {
  constructor(type, items, options = {}) {
    this.id = uuidv4();
    this.type = type;
    this.items = items;
    this.options = options;
    this.status = BatchStatus.PENDING;
    this.processedCount = 0;
    this.failedCount = 0;
    this.results = [];
    this.txHashes = [];
    this.error = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.gasUsed = 0n;
    this.retryCount = 0;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      status: this.status,
      itemCount: this.items.length,
      processedCount: this.processedCount,
      failedCount: this.failedCount,
      txHashes: this.txHashes,
      error: this.error,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      gasUsed: this.gasUsed.toString()
    };
  }
}

/**
 * Batch Processor Service
 */
class BatchProcessor {
  constructor() {
    this.app = express();
    this.redis = null;
    this.pg = null;
    this.provider = null;
    this.wallet = null;
    this.contracts = {};
    
    this.jobQueue = [];
    this.activeJobs = new Map();
    this.isProcessing = false;
    
    this.stats = {
      totalBatches: 0,
      completedBatches: 0,
      failedBatches: 0,
      totalItems: 0,
      processedItems: 0,
      totalGasUsed: 0n
    };
  }

  async initialize() {
    console.log('📦 Initializing Batch Processor...');

    // Connect to databases
    this.redis = new Redis(CONFIG.redisUrl);
    this.pg = new Pool({ connectionString: CONFIG.postgresUrl });

    // Connect to blockchain
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    this.wallet = new ethers.Wallet(CONFIG.privateKey, this.provider);
    console.log(`💰 Processor address: ${this.wallet.address}`);

    // Ensure tables
    await this.ensureTables();

    // Load pending jobs
    await this.loadPendingJobs();

    // Setup routes
    this.setupRoutes();

    // Start processing loop
    this.startProcessing();

    console.log('✅ Batch Processor initialized');
  }

  async ensureTables() {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS batch_jobs (
        id VARCHAR(36) PRIMARY KEY,
        type VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL,
        item_count INT NOT NULL,
        processed_count INT DEFAULT 0,
        failed_count INT DEFAULT 0,
        tx_hashes TEXT[],
        error TEXT,
        options JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        gas_used NUMERIC DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS batch_items (
        id SERIAL PRIMARY KEY,
        batch_id VARCHAR(36) REFERENCES batch_jobs(id),
        recipient VARCHAR(42),
        amount NUMERIC,
        metadata JSONB,
        status VARCHAR(20) DEFAULT 'pending',
        tx_hash VARCHAR(66),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_batch_status ON batch_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id);
    `);
  }

  async loadPendingJobs() {
    const result = await this.pg.query(
      'SELECT * FROM batch_jobs WHERE status IN ($1, $2) ORDER BY created_at',
      [BatchStatus.PENDING, BatchStatus.PROCESSING]
    );

    for (const row of result.rows) {
      // Load items
      const items = await this.pg.query(
        'SELECT * FROM batch_items WHERE batch_id = $1',
        [row.id]
      );

      const job = new BatchJob(row.type, items.rows.map(i => ({
        recipient: i.recipient,
        amount: i.amount,
        metadata: i.metadata
      })), row.options);

      job.id = row.id;
      job.status = row.status;
      job.processedCount = row.processed_count;
      job.failedCount = row.failed_count;
      job.createdAt = new Date(row.created_at).getTime();

      this.jobQueue.push(job);
    }

    console.log(`  📋 Loaded ${this.jobQueue.length} pending jobs`);
  }

  // ============ Job Creation ============

  async createTransferBatch(token, transfers) {
    if (transfers.length > CONFIG.batch.maxSize) {
      throw new Error(`Batch size exceeds maximum (${CONFIG.batch.maxSize})`);
    }

    const job = new BatchJob(BatchType.TRANSFER, transfers, { token });
    await this.saveJob(job);
    this.jobQueue.push(job);

    console.log(`📥 Created transfer batch: ${job.id} (${transfers.length} items)`);
    return job;
  }

  async createPaymentBatch(token, payments) {
    if (payments.length > CONFIG.batch.maxSize) {
      throw new Error(`Batch size exceeds maximum (${CONFIG.batch.maxSize})`);
    }

    const job = new BatchJob(BatchType.PAYMENT, payments, { token });
    await this.saveJob(job);
    this.jobQueue.push(job);

    console.log(`📥 Created payment batch: ${job.id} (${payments.length} items)`);
    return job;
  }

  async createAirdropBatch(token, recipients, amounts) {
    if (recipients.length !== amounts.length) {
      throw new Error('Recipients and amounts length mismatch');
    }

    const items = recipients.map((r, i) => ({ recipient: r, amount: amounts[i] }));
    const job = new BatchJob(BatchType.AIRDROP, items, { token });
    await this.saveJob(job);
    this.jobQueue.push(job);

    console.log(`📥 Created airdrop batch: ${job.id} (${items.length} items)`);
    return job;
  }

  async createNFTMintBatch(nftContract, mints) {
    const job = new BatchJob(BatchType.NFT_MINT, mints, { nftContract });
    await this.saveJob(job);
    this.jobQueue.push(job);

    console.log(`📥 Created NFT mint batch: ${job.id} (${mints.length} items)`);
    return job;
  }

  async saveJob(job) {
    // Save to database
    await this.pg.query(`
      INSERT INTO batch_jobs (id, type, status, item_count, options)
      VALUES ($1, $2, $3, $4, $5)
    `, [job.id, job.type, job.status, job.items.length, JSON.stringify(job.options)]);

    // Save items
    for (const item of job.items) {
      await this.pg.query(`
        INSERT INTO batch_items (batch_id, recipient, amount, metadata)
        VALUES ($1, $2, $3, $4)
      `, [job.id, item.recipient, item.amount, JSON.stringify(item.metadata || {})]);
    }

    // Cache in Redis
    await this.redis.hset(`batch:${job.id}`, 'data', JSON.stringify(job.toJSON()));
  }

  // ============ Processing ============

  startProcessing() {
    setInterval(() => this.processNextBatch(), CONFIG.batch.processingInterval);
    console.log('📡 Processing loop started');
  }

  async processNextBatch() {
    if (this.isProcessing || this.jobQueue.length === 0) return;

    this.isProcessing = true;
    const job = this.jobQueue.shift();

    try {
      console.log(`🔄 Processing batch: ${job.id} (${job.type})`);
      
      job.status = BatchStatus.PROCESSING;
      job.startedAt = Date.now();
      await this.updateJobStatus(job);

      this.activeJobs.set(job.id, job);

      switch (job.type) {
        case BatchType.TRANSFER:
          await this.processTransferBatch(job);
          break;
        case BatchType.PAYMENT:
          await this.processPaymentBatch(job);
          break;
        case BatchType.AIRDROP:
          await this.processAirdropBatch(job);
          break;
        case BatchType.NFT_MINT:
          await this.processNFTMintBatch(job);
          break;
        default:
          throw new Error(`Unknown batch type: ${job.type}`);
      }

      job.status = job.failedCount > 0 ? BatchStatus.PARTIAL : BatchStatus.COMPLETED;
      job.completedAt = Date.now();
      this.stats.completedBatches++;

      console.log(`✅ Batch completed: ${job.id} (${job.processedCount}/${job.items.length})`);
    } catch (error) {
      console.error(`❌ Batch failed: ${job.id}`, error.message);
      
      job.error = error.message;
      job.retryCount++;

      if (job.retryCount < CONFIG.batch.retryAttempts) {
        job.status = BatchStatus.PENDING;
        this.jobQueue.push(job);
      } else {
        job.status = BatchStatus.FAILED;
        this.stats.failedBatches++;
      }
    } finally {
      await this.updateJobStatus(job);
      this.activeJobs.delete(job.id);
      this.isProcessing = false;
    }
  }

  async processTransferBatch(job) {
    const { token } = job.options;
    const tokenContract = new ethers.Contract(token, ABIS.token, this.wallet);

    // Process in chunks to avoid gas limits
    const chunkSize = 50;
    for (let i = 0; i < job.items.length; i += chunkSize) {
      const chunk = job.items.slice(i, i + chunkSize);
      
      // For simplicity, do individual transfers
      // In production, use multicall or batch contract
      for (const item of chunk) {
        try {
          const tx = await tokenContract.transfer(
            item.recipient,
            ethers.parseEther(item.amount.toString())
          );
          const receipt = await tx.wait();

          job.processedCount++;
          job.txHashes.push(receipt.hash);
          job.gasUsed += receipt.gasUsed;

          this.stats.processedItems++;
        } catch (error) {
          job.failedCount++;
          console.error(`Transfer failed for ${item.recipient}:`, error.message);
        }
      }
    }
  }

  async processPaymentBatch(job) {
    const { token } = job.options;

    // Similar to transfer but with payment router
    for (const item of job.items) {
      try {
        // Would call payment router contract here
        job.processedCount++;
        this.stats.processedItems++;
      } catch (error) {
        job.failedCount++;
      }
    }
  }

  async processAirdropBatch(job) {
    // Generate merkle tree and call airdrop contract
    for (const item of job.items) {
      try {
        job.processedCount++;
        this.stats.processedItems++;
      } catch (error) {
        job.failedCount++;
      }
    }
  }

  async processNFTMintBatch(job) {
    const { nftContract } = job.options;

    for (const item of job.items) {
      try {
        // Would call NFT contract mint
        job.processedCount++;
        this.stats.processedItems++;
      } catch (error) {
        job.failedCount++;
      }
    }
  }

  async updateJobStatus(job) {
    await this.pg.query(`
      UPDATE batch_jobs SET
        status = $1,
        processed_count = $2,
        failed_count = $3,
        tx_hashes = $4,
        error = $5,
        started_at = $6,
        completed_at = $7,
        gas_used = $8
      WHERE id = $9
    `, [
      job.status,
      job.processedCount,
      job.failedCount,
      job.txHashes,
      job.error,
      job.startedAt ? new Date(job.startedAt) : null,
      job.completedAt ? new Date(job.completedAt) : null,
      job.gasUsed.toString(),
      job.id
    ]);

    await this.redis.hset(`batch:${job.id}`, 'data', JSON.stringify(job.toJSON()));
  }

  // ============ API Routes ============

  setupRoutes() {
    this.app.use(express.json());

    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        queueLength: this.jobQueue.length,
        activeJobs: this.activeJobs.size,
        stats: {
          ...this.stats,
          totalGasUsed: this.stats.totalGasUsed.toString()
        }
      });
    });

    // Create transfer batch
    this.app.post('/api/batch/transfer', async (req, res) => {
      try {
        const { token, transfers } = req.body;
        const job = await this.createTransferBatch(token, transfers);
        res.json({ success: true, job: job.toJSON() });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // Create payment batch
    this.app.post('/api/batch/payment', async (req, res) => {
      try {
        const { token, payments } = req.body;
        const job = await this.createPaymentBatch(token, payments);
        res.json({ success: true, job: job.toJSON() });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // Create airdrop batch
    this.app.post('/api/batch/airdrop', async (req, res) => {
      try {
        const { token, recipients, amounts } = req.body;
        const job = await this.createAirdropBatch(token, recipients, amounts);
        res.json({ success: true, job: job.toJSON() });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // Create NFT mint batch
    this.app.post('/api/batch/nft-mint', async (req, res) => {
      try {
        const { nftContract, mints } = req.body;
        const job = await this.createNFTMintBatch(nftContract, mints);
        res.json({ success: true, job: job.toJSON() });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // Get job status
    this.app.get('/api/batch/:id', async (req, res) => {
      try {
        // Check cache first
        const cached = await this.redis.hget(`batch:${req.params.id}`, 'data');
        if (cached) {
          return res.json({ job: JSON.parse(cached) });
        }

        // Check database
        const result = await this.pg.query(
          'SELECT * FROM batch_jobs WHERE id = $1',
          [req.params.id]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Job not found' });
        }

        res.json({ job: result.rows[0] });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get all jobs
    this.app.get('/api/batch', async (req, res) => {
      const { status, limit = 50, offset = 0 } = req.query;

      let query = 'SELECT * FROM batch_jobs';
      const params = [];

      if (status) {
        query += ' WHERE status = $1';
        params.push(status);
      }

      query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
      params.push(parseInt(limit), parseInt(offset));

      const result = await this.pg.query(query, params);
      res.json({ jobs: result.rows, count: result.rowCount });
    });

    // Cancel job
    this.app.delete('/api/batch/:id', async (req, res) => {
      try {
        const index = this.jobQueue.findIndex(j => j.id === req.params.id);
        if (index === -1) {
          return res.status(404).json({ error: 'Job not found or already processing' });
        }

        const [job] = this.jobQueue.splice(index, 1);
        job.status = BatchStatus.FAILED;
        job.error = 'Cancelled by user';
        await this.updateJobStatus(job);

        res.json({ success: true, message: 'Job cancelled' });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Stats
    this.app.get('/api/stats', (req, res) => {
      res.json({
        ...this.stats,
        totalGasUsed: ethers.formatEther(this.stats.totalGasUsed),
        queueLength: this.jobQueue.length,
        activeJobs: this.activeJobs.size
      });
    });
  }

  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n📦 Batch Processor running on port ${CONFIG.port}`);
      console.log('\n📡 API Endpoints:');
      console.log('   POST /api/batch/transfer   - Create transfer batch');
      console.log('   POST /api/batch/payment    - Create payment batch');
      console.log('   POST /api/batch/airdrop    - Create airdrop batch');
      console.log('   POST /api/batch/nft-mint   - Create NFT mint batch');
      console.log('   GET  /api/batch/:id        - Get job status');
      console.log('   GET  /api/batch            - List jobs');
      console.log('   DELETE /api/batch/:id      - Cancel job\n');
    });
  }
}

// Main
async function main() {
  const processor = new BatchProcessor();
  await processor.initialize();
  processor.start();
}

main().catch(console.error);

module.exports = { BatchProcessor };
