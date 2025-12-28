/**
 * SYNAPSE Protocol - Cross-Chain Messaging Service
 * 
 * Facilitates cross-chain communication and asset transfers
 * Features:
 * - Message relay between chains
 * - Cross-chain token transfers
 * - Multi-chain state synchronization
 * - Bridge transaction monitoring
 */

const express = require('express');
const { ethers } = require('ethers');
const Redis = require('ioredis');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

// Configuration
const CONFIG = {
  port: process.env.CROSSCHAIN_PORT || 3015,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  postgresUrl: process.env.DATABASE_URL,
  
  // Chain configurations
  chains: {
    arbitrum: {
      chainId: 42161,
      name: 'Arbitrum One',
      rpcUrl: process.env.ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc',
      wsUrl: process.env.ARBITRUM_WS || 'wss://arb1.arbitrum.io/ws',
      bridgeAddress: process.env.ARBITRUM_BRIDGE,
      confirmations: 1
    },
    ethereum: {
      chainId: 1,
      name: 'Ethereum',
      rpcUrl: process.env.ETHEREUM_RPC || 'https://eth.llamarpc.com',
      wsUrl: process.env.ETHEREUM_WS,
      bridgeAddress: process.env.ETHEREUM_BRIDGE,
      confirmations: 12
    },
    polygon: {
      chainId: 137,
      name: 'Polygon',
      rpcUrl: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
      wsUrl: process.env.POLYGON_WS,
      bridgeAddress: process.env.POLYGON_BRIDGE,
      confirmations: 128
    },
    optimism: {
      chainId: 10,
      name: 'Optimism',
      rpcUrl: process.env.OPTIMISM_RPC || 'https://mainnet.optimism.io',
      wsUrl: process.env.OPTIMISM_WS,
      bridgeAddress: process.env.OPTIMISM_BRIDGE,
      confirmations: 1
    },
    base: {
      chainId: 8453,
      name: 'Base',
      rpcUrl: process.env.BASE_RPC || 'https://mainnet.base.org',
      wsUrl: process.env.BASE_WS,
      bridgeAddress: process.env.BASE_BRIDGE,
      confirmations: 1
    }
  },
  
  relayerKey: process.env.RELAYER_PRIVATE_KEY,
  
  // Limits
  maxMessageSize: 10000,
  minTransferAmount: '0.001',
  maxTransferAmount: '1000000'
};

// ABIs
const ABIS = {
  bridge: [
    'event MessageSent(bytes32 indexed messageId, uint256 indexed sourceChain, uint256 indexed destChain, address sender, bytes message)',
    'event MessageReceived(bytes32 indexed messageId, uint256 indexed sourceChain, address sender)',
    'event TokensBridged(bytes32 indexed transferId, address indexed token, address indexed sender, address recipient, uint256 amount, uint256 destChain)',
    'event TokensReleased(bytes32 indexed transferId, address indexed recipient, uint256 amount)',
    'function sendMessage(uint256 destChain, address target, bytes calldata message) external payable returns (bytes32)',
    'function receiveMessage(bytes32 messageId, uint256 sourceChain, address sender, bytes calldata message, bytes calldata proof) external',
    'function bridgeTokens(address token, uint256 amount, uint256 destChain, address recipient) external returns (bytes32)',
    'function releaseTokens(bytes32 transferId, address token, address recipient, uint256 amount, bytes calldata proof) external',
    'function getMessageStatus(bytes32 messageId) view returns (uint8)'
  ]
};

/**
 * Message Status
 */
const MessageStatus = {
  PENDING: 'pending',
  SENT: 'sent',
  CONFIRMED: 'confirmed',
  RELAYED: 'relayed',
  EXECUTED: 'executed',
  FAILED: 'failed'
};

/**
 * Cross-chain message
 */
class CrossChainMessage {
  constructor(data) {
    this.id = data.id || uuidv4();
    this.messageId = data.messageId;
    this.sourceChain = data.sourceChain;
    this.destChain = data.destChain;
    this.sender = data.sender;
    this.target = data.target;
    this.message = data.message;
    this.status = data.status || MessageStatus.PENDING;
    this.sourceTxHash = data.sourceTxHash;
    this.destTxHash = data.destTxHash;
    this.proof = data.proof;
    this.createdAt = data.createdAt || Date.now();
    this.confirmedAt = data.confirmedAt;
    this.executedAt = data.executedAt;
    this.error = data.error;
    this.retryCount = data.retryCount || 0;
  }

  toJSON() {
    return {
      id: this.id,
      messageId: this.messageId,
      sourceChain: this.sourceChain,
      destChain: this.destChain,
      sender: this.sender,
      target: this.target,
      status: this.status,
      sourceTxHash: this.sourceTxHash,
      destTxHash: this.destTxHash,
      createdAt: this.createdAt,
      confirmedAt: this.confirmedAt,
      executedAt: this.executedAt,
      error: this.error
    };
  }
}

/**
 * Token bridge transfer
 */
class BridgeTransfer {
  constructor(data) {
    this.id = data.id || uuidv4();
    this.transferId = data.transferId;
    this.sourceChain = data.sourceChain;
    this.destChain = data.destChain;
    this.token = data.token;
    this.sender = data.sender;
    this.recipient = data.recipient;
    this.amount = data.amount;
    this.status = data.status || MessageStatus.PENDING;
    this.sourceTxHash = data.sourceTxHash;
    this.destTxHash = data.destTxHash;
    this.fee = data.fee || '0';
    this.createdAt = data.createdAt || Date.now();
    this.completedAt = data.completedAt;
  }
}

/**
 * Cross-Chain Messaging Service
 */
class CrossChainService {
  constructor() {
    this.app = express();
    this.redis = null;
    this.pg = null;
    
    this.providers = {};
    this.wsProviders = {};
    this.contracts = {};
    this.relayerWallets = {};
    
    this.pendingMessages = new Map();
    this.pendingTransfers = new Map();
    
    this.stats = {
      totalMessages: 0,
      relayedMessages: 0,
      failedMessages: 0,
      totalTransfers: 0,
      completedTransfers: 0,
      totalVolume: {}
    };
  }

  async initialize() {
    console.log('🌐 Initializing Cross-Chain Messaging Service...');

    // Connect to databases
    this.redis = new Redis(CONFIG.redisUrl);
    this.pg = new Pool({ connectionString: CONFIG.postgresUrl });

    // Ensure tables
    await this.ensureTables();

    // Initialize chain connections
    await this.initializeChains();

    // Load pending operations
    await this.loadPendingOperations();

    // Setup event listeners
    this.setupEventListeners();

    // Setup routes
    this.setupRoutes();

    // Start relay loop
    this.startRelayLoop();

    console.log('✅ Cross-Chain Messaging Service initialized');
  }

  async ensureTables() {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS crosschain_messages (
        id VARCHAR(36) PRIMARY KEY,
        message_id VARCHAR(66),
        source_chain INT NOT NULL,
        dest_chain INT NOT NULL,
        sender VARCHAR(42) NOT NULL,
        target VARCHAR(42),
        message TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        source_tx_hash VARCHAR(66),
        dest_tx_hash VARCHAR(66),
        proof TEXT,
        error TEXT,
        retry_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        confirmed_at TIMESTAMP,
        executed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bridge_transfers (
        id VARCHAR(36) PRIMARY KEY,
        transfer_id VARCHAR(66),
        source_chain INT NOT NULL,
        dest_chain INT NOT NULL,
        token VARCHAR(42) NOT NULL,
        sender VARCHAR(42) NOT NULL,
        recipient VARCHAR(42) NOT NULL,
        amount NUMERIC NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        source_tx_hash VARCHAR(66),
        dest_tx_hash VARCHAR(66),
        fee NUMERIC DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chain_state (
        chain_id INT PRIMARY KEY,
        last_processed_block BIGINT DEFAULT 0,
        is_healthy BOOLEAN DEFAULT true,
        last_update TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_messages_status ON crosschain_messages(status);
      CREATE INDEX IF NOT EXISTS idx_transfers_status ON bridge_transfers(status);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON crosschain_messages(sender);
    `);
  }

  async initializeChains() {
    for (const [chainName, chainConfig] of Object.entries(CONFIG.chains)) {
      try {
        // HTTP provider
        this.providers[chainName] = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
        
        // WebSocket provider for events
        if (chainConfig.wsUrl) {
          this.wsProviders[chainName] = new ethers.WebSocketProvider(chainConfig.wsUrl);
        }

        // Relayer wallet
        if (CONFIG.relayerKey) {
          this.relayerWallets[chainName] = new ethers.Wallet(
            CONFIG.relayerKey,
            this.providers[chainName]
          );
        }

        // Bridge contract
        if (chainConfig.bridgeAddress) {
          this.contracts[chainName] = new ethers.Contract(
            chainConfig.bridgeAddress,
            ABIS.bridge,
            this.relayerWallets[chainName] || this.providers[chainName]
          );
        }

        // Initialize chain state
        await this.pg.query(`
          INSERT INTO chain_state (chain_id, last_processed_block)
          VALUES ($1, 0)
          ON CONFLICT (chain_id) DO NOTHING
        `, [chainConfig.chainId]);

        console.log(`  ✅ ${chainConfig.name} (${chainConfig.chainId}) connected`);
      } catch (error) {
        console.error(`  ❌ ${chainConfig.name} connection failed:`, error.message);
      }
    }
  }

  async loadPendingOperations() {
    // Load pending messages
    const messages = await this.pg.query(
      'SELECT * FROM crosschain_messages WHERE status IN ($1, $2, $3)',
      [MessageStatus.PENDING, MessageStatus.SENT, MessageStatus.CONFIRMED]
    );

    for (const row of messages.rows) {
      this.pendingMessages.set(row.id, new CrossChainMessage(row));
    }

    // Load pending transfers
    const transfers = await this.pg.query(
      'SELECT * FROM bridge_transfers WHERE status IN ($1, $2)',
      [MessageStatus.PENDING, MessageStatus.CONFIRMED]
    );

    for (const row of transfers.rows) {
      this.pendingTransfers.set(row.id, new BridgeTransfer(row));
    }

    console.log(`  📋 Loaded ${this.pendingMessages.size} pending messages`);
    console.log(`  📋 Loaded ${this.pendingTransfers.size} pending transfers`);
  }

  setupEventListeners() {
    for (const [chainName, contract] of Object.entries(this.contracts)) {
      if (!contract) continue;

      const wsContract = this.wsProviders[chainName] 
        ? new ethers.Contract(contract.target, ABIS.bridge, this.wsProviders[chainName])
        : null;

      if (wsContract) {
        // Listen for outgoing messages
        wsContract.on('MessageSent', async (messageId, sourceChain, destChain, sender, message, event) => {
          console.log(`📤 Message sent from ${chainName}: ${messageId}`);
          await this.handleMessageSent(chainName, messageId, sourceChain, destChain, sender, message, event);
        });

        // Listen for bridge transfers
        wsContract.on('TokensBridged', async (transferId, token, sender, recipient, amount, destChain, event) => {
          console.log(`💸 Tokens bridged from ${chainName}: ${transferId}`);
          await this.handleTokensBridged(chainName, transferId, token, sender, recipient, amount, destChain, event);
        });
      }
    }

    console.log('📡 Event listeners active');
  }

  // ============ Message Handling ============

  async handleMessageSent(chainName, messageId, sourceChain, destChain, sender, message, event) {
    const msg = new CrossChainMessage({
      messageId,
      sourceChain: Number(sourceChain),
      destChain: Number(destChain),
      sender,
      message,
      status: MessageStatus.SENT,
      sourceTxHash: event.transactionHash
    });

    await this.saveMessage(msg);
    this.pendingMessages.set(msg.id, msg);
    this.stats.totalMessages++;
  }

  async handleTokensBridged(chainName, transferId, token, sender, recipient, amount, destChain, event) {
    const chainConfig = CONFIG.chains[chainName];
    
    const transfer = new BridgeTransfer({
      transferId,
      sourceChain: chainConfig.chainId,
      destChain: Number(destChain),
      token,
      sender,
      recipient,
      amount: ethers.formatEther(amount),
      status: MessageStatus.SENT,
      sourceTxHash: event.transactionHash
    });

    await this.saveTransfer(transfer);
    this.pendingTransfers.set(transfer.id, transfer);
    this.stats.totalTransfers++;
  }

  // ============ Relay Loop ============

  startRelayLoop() {
    // Process messages every 10 seconds
    setInterval(() => this.processMessages(), 10000);
    
    // Process transfers every 15 seconds
    setInterval(() => this.processTransfers(), 15000);

    // Health check every minute
    setInterval(() => this.healthCheck(), 60000);

    console.log('🔄 Relay loop started');
  }

  async processMessages() {
    for (const [id, msg] of this.pendingMessages) {
      try {
        if (msg.status === MessageStatus.SENT) {
          // Check for confirmations
          await this.checkMessageConfirmation(msg);
        } else if (msg.status === MessageStatus.CONFIRMED) {
          // Relay to destination
          await this.relayMessage(msg);
        }
      } catch (error) {
        console.error(`Error processing message ${id}:`, error.message);
        msg.retryCount++;
        
        if (msg.retryCount >= 5) {
          msg.status = MessageStatus.FAILED;
          msg.error = error.message;
          await this.updateMessage(msg);
          this.pendingMessages.delete(id);
          this.stats.failedMessages++;
        }
      }
    }
  }

  async checkMessageConfirmation(msg) {
    const chainName = this.getChainName(msg.sourceChain);
    if (!chainName) return;

    const provider = this.providers[chainName];
    const receipt = await provider.getTransactionReceipt(msg.sourceTxHash);

    if (!receipt) return;

    const currentBlock = await provider.getBlockNumber();
    const confirmations = currentBlock - receipt.blockNumber;
    const required = CONFIG.chains[chainName].confirmations;

    if (confirmations >= required) {
      msg.status = MessageStatus.CONFIRMED;
      msg.confirmedAt = Date.now();
      msg.proof = await this.generateProof(msg);
      await this.updateMessage(msg);
      console.log(`✅ Message confirmed: ${msg.messageId}`);
    }
  }

  async relayMessage(msg) {
    const destChainName = this.getChainName(msg.destChain);
    if (!destChainName) {
      throw new Error(`Unknown destination chain: ${msg.destChain}`);
    }

    const contract = this.contracts[destChainName];
    if (!contract) {
      throw new Error(`No contract for chain: ${destChainName}`);
    }

    console.log(`🔄 Relaying message to ${destChainName}...`);

    const tx = await contract.receiveMessage(
      msg.messageId,
      msg.sourceChain,
      msg.sender,
      msg.message,
      msg.proof || '0x'
    );

    const receipt = await tx.wait();

    msg.status = MessageStatus.EXECUTED;
    msg.destTxHash = receipt.hash;
    msg.executedAt = Date.now();
    await this.updateMessage(msg);
    
    this.pendingMessages.delete(msg.id);
    this.stats.relayedMessages++;

    console.log(`✅ Message relayed: ${msg.messageId}`);
  }

  async processTransfers() {
    for (const [id, transfer] of this.pendingTransfers) {
      try {
        if (transfer.status === MessageStatus.SENT) {
          await this.checkTransferConfirmation(transfer);
        } else if (transfer.status === MessageStatus.CONFIRMED) {
          await this.releaseTokens(transfer);
        }
      } catch (error) {
        console.error(`Error processing transfer ${id}:`, error.message);
      }
    }
  }

  async checkTransferConfirmation(transfer) {
    const chainName = this.getChainName(transfer.sourceChain);
    if (!chainName) return;

    const provider = this.providers[chainName];
    const receipt = await provider.getTransactionReceipt(transfer.sourceTxHash);

    if (!receipt) return;

    const currentBlock = await provider.getBlockNumber();
    const confirmations = currentBlock - receipt.blockNumber;
    const required = CONFIG.chains[chainName].confirmations;

    if (confirmations >= required) {
      transfer.status = MessageStatus.CONFIRMED;
      await this.updateTransfer(transfer);
      console.log(`✅ Transfer confirmed: ${transfer.transferId}`);
    }
  }

  async releaseTokens(transfer) {
    const destChainName = this.getChainName(transfer.destChain);
    if (!destChainName) return;

    const contract = this.contracts[destChainName];
    if (!contract) return;

    console.log(`💰 Releasing tokens on ${destChainName}...`);

    const tx = await contract.releaseTokens(
      transfer.transferId,
      transfer.token,
      transfer.recipient,
      ethers.parseEther(transfer.amount),
      '0x' // proof
    );

    const receipt = await tx.wait();

    transfer.status = MessageStatus.EXECUTED;
    transfer.destTxHash = receipt.hash;
    transfer.completedAt = Date.now();
    await this.updateTransfer(transfer);

    this.pendingTransfers.delete(transfer.id);
    this.stats.completedTransfers++;

    console.log(`✅ Tokens released: ${transfer.transferId}`);
  }

  // ============ Helper Functions ============

  getChainName(chainId) {
    for (const [name, config] of Object.entries(CONFIG.chains)) {
      if (config.chainId === chainId) return name;
    }
    return null;
  }

  async generateProof(msg) {
    // In production, generate merkle proof or use messaging protocol's proof mechanism
    return ethers.keccak256(ethers.toUtf8Bytes(msg.messageId + msg.sourceTxHash));
  }

  async saveMessage(msg) {
    await this.pg.query(`
      INSERT INTO crosschain_messages 
        (id, message_id, source_chain, dest_chain, sender, target, message, status, source_tx_hash, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    `, [msg.id, msg.messageId, msg.sourceChain, msg.destChain, msg.sender, msg.target, msg.message, msg.status, msg.sourceTxHash]);

    await this.redis.hset(`crosschain:message:${msg.id}`, 'data', JSON.stringify(msg.toJSON()));
  }

  async updateMessage(msg) {
    await this.pg.query(`
      UPDATE crosschain_messages SET
        status = $1, dest_tx_hash = $2, proof = $3, error = $4, retry_count = $5,
        confirmed_at = $6, executed_at = $7
      WHERE id = $8
    `, [msg.status, msg.destTxHash, msg.proof, msg.error, msg.retryCount, 
        msg.confirmedAt ? new Date(msg.confirmedAt) : null,
        msg.executedAt ? new Date(msg.executedAt) : null,
        msg.id]);

    await this.redis.hset(`crosschain:message:${msg.id}`, 'data', JSON.stringify(msg.toJSON()));
  }

  async saveTransfer(transfer) {
    await this.pg.query(`
      INSERT INTO bridge_transfers
        (id, transfer_id, source_chain, dest_chain, token, sender, recipient, amount, status, source_tx_hash, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
    `, [transfer.id, transfer.transferId, transfer.sourceChain, transfer.destChain, transfer.token,
        transfer.sender, transfer.recipient, transfer.amount, transfer.status, transfer.sourceTxHash]);
  }

  async updateTransfer(transfer) {
    await this.pg.query(`
      UPDATE bridge_transfers SET
        status = $1, dest_tx_hash = $2, completed_at = $3
      WHERE id = $4
    `, [transfer.status, transfer.destTxHash, 
        transfer.completedAt ? new Date(transfer.completedAt) : null, transfer.id]);
  }

  async healthCheck() {
    for (const [chainName, provider] of Object.entries(this.providers)) {
      try {
        await provider.getBlockNumber();
        await this.pg.query(
          'UPDATE chain_state SET is_healthy = true, last_update = NOW() WHERE chain_id = $1',
          [CONFIG.chains[chainName].chainId]
        );
      } catch (error) {
        await this.pg.query(
          'UPDATE chain_state SET is_healthy = false, last_update = NOW() WHERE chain_id = $1',
          [CONFIG.chains[chainName].chainId]
        );
      }
    }
  }

  // ============ API Routes ============

  setupRoutes() {
    this.app.use(express.json());

    this.app.get('/health', async (req, res) => {
      const chains = await this.pg.query('SELECT * FROM chain_state');
      res.json({
        status: 'healthy',
        pendingMessages: this.pendingMessages.size,
        pendingTransfers: this.pendingTransfers.size,
        chains: chains.rows,
        stats: this.stats
      });
    });

    // Get message status
    this.app.get('/api/message/:id', async (req, res) => {
      const cached = await this.redis.hget(`crosschain:message:${req.params.id}`, 'data');
      if (cached) {
        return res.json({ message: JSON.parse(cached) });
      }

      const result = await this.pg.query(
        'SELECT * FROM crosschain_messages WHERE id = $1 OR message_id = $1',
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Message not found' });
      }

      res.json({ message: result.rows[0] });
    });

    // Get transfer status
    this.app.get('/api/transfer/:id', async (req, res) => {
      const result = await this.pg.query(
        'SELECT * FROM bridge_transfers WHERE id = $1 OR transfer_id = $1',
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Transfer not found' });
      }

      res.json({ transfer: result.rows[0] });
    });

    // Get user messages
    this.app.get('/api/messages/:address', async (req, res) => {
      const { limit = 50, offset = 0 } = req.query;
      
      const result = await this.pg.query(
        'SELECT * FROM crosschain_messages WHERE sender = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [req.params.address.toLowerCase(), parseInt(limit), parseInt(offset)]
      );

      res.json({ messages: result.rows });
    });

    // Get user transfers
    this.app.get('/api/transfers/:address', async (req, res) => {
      const { limit = 50, offset = 0 } = req.query;

      const result = await this.pg.query(
        'SELECT * FROM bridge_transfers WHERE sender = $1 OR recipient = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [req.params.address.toLowerCase(), parseInt(limit), parseInt(offset)]
      );

      res.json({ transfers: result.rows });
    });

    // Get supported chains
    this.app.get('/api/chains', (req, res) => {
      const chains = Object.entries(CONFIG.chains).map(([name, config]) => ({
        name,
        chainId: config.chainId,
        displayName: config.name,
        confirmations: config.confirmations
      }));
      res.json({ chains });
    });

    // Stats
    this.app.get('/api/stats', (req, res) => {
      res.json({
        ...this.stats,
        pendingMessages: this.pendingMessages.size,
        pendingTransfers: this.pendingTransfers.size
      });
    });
  }

  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n🌐 Cross-Chain Messaging Service running on port ${CONFIG.port}`);
      console.log('\n📡 Supported Chains:');
      for (const [name, config] of Object.entries(CONFIG.chains)) {
        console.log(`   - ${config.name} (${config.chainId})`);
      }
      console.log('\n📡 API Endpoints:');
      console.log('   GET  /api/message/:id       - Message status');
      console.log('   GET  /api/transfer/:id      - Transfer status');
      console.log('   GET  /api/messages/:address - User messages');
      console.log('   GET  /api/transfers/:address- User transfers');
      console.log('   GET  /api/chains            - Supported chains');
      console.log('   GET  /api/stats             - Statistics\n');
    });
  }
}

// Main
async function main() {
  const service = new CrossChainService();
  await service.initialize();
  service.start();
}

main().catch(console.error);

module.exports = { CrossChainService };
