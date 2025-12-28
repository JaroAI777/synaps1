/**
 * SYNAPSE Protocol - Event Indexer Service
 * 
 * Blockchain event indexing and querying service
 * Features:
 * - Real-time event monitoring
 * - Historical event indexing
 * - Efficient querying with filters
 * - WebSocket subscriptions
 * - Data aggregation
 */

const express = require('express');
const { ethers } = require('ethers');
const Redis = require('ioredis');
const { Pool } = require('pg');
const WebSocket = require('ws');

// Configuration
const CONFIG = {
  port: process.env.INDEXER_PORT || 3007,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  postgresUrl: process.env.DATABASE_URL || 'postgresql://localhost/synapse',
  rpcUrl: process.env.RPC_URL,
  wsRpcUrl: process.env.WS_RPC_URL,
  
  // Contract addresses
  contracts: {
    token: process.env.TOKEN_ADDRESS,
    paymentRouter: process.env.PAYMENT_ROUTER_ADDRESS,
    reputation: process.env.REPUTATION_ADDRESS,
    staking: process.env.STAKING_ADDRESS,
    bridge: process.env.BRIDGE_ADDRESS
  },
  
  // Indexing config
  startBlock: parseInt(process.env.START_BLOCK || '0'),
  batchSize: parseInt(process.env.BATCH_SIZE || '1000'),
  confirmations: parseInt(process.env.CONFIRMATIONS || '12')
};

// Event definitions
const EVENT_DEFINITIONS = {
  // Token events
  Transfer: {
    contract: 'token',
    signature: 'Transfer(address,address,uint256)',
    decode: (log, iface) => {
      const parsed = iface.parseLog(log);
      return {
        from: parsed.args[0],
        to: parsed.args[1],
        amount: parsed.args[2].toString()
      };
    }
  },
  Approval: {
    contract: 'token',
    signature: 'Approval(address,address,uint256)',
    decode: (log, iface) => {
      const parsed = iface.parseLog(log);
      return {
        owner: parsed.args[0],
        spender: parsed.args[1],
        amount: parsed.args[2].toString()
      };
    }
  },
  
  // Payment events
  PaymentSent: {
    contract: 'paymentRouter',
    signature: 'PaymentSent(address,address,uint256,uint256,bytes32)',
    decode: (log, iface) => {
      const parsed = iface.parseLog(log);
      return {
        sender: parsed.args[0],
        recipient: parsed.args[1],
        amount: parsed.args[2].toString(),
        fee: parsed.args[3].toString(),
        paymentId: parsed.args[4]
      };
    }
  },
  EscrowCreated: {
    contract: 'paymentRouter',
    signature: 'EscrowCreated(bytes32,address,address,uint256)',
    decode: (log, iface) => {
      const parsed = iface.parseLog(log);
      return {
        escrowId: parsed.args[0],
        sender: parsed.args[1],
        recipient: parsed.args[2],
        amount: parsed.args[3].toString()
      };
    }
  },
  
  // Staking events
  Staked: {
    contract: 'staking',
    signature: 'Staked(address,uint256,uint256)',
    decode: (log, iface) => {
      const parsed = iface.parseLog(log);
      return {
        user: parsed.args[0],
        amount: parsed.args[1].toString(),
        lockTier: parsed.args[2].toString()
      };
    }
  },
  RewardsClaimed: {
    contract: 'staking',
    signature: 'RewardsClaimed(address,uint256)',
    decode: (log, iface) => {
      const parsed = iface.parseLog(log);
      return {
        user: parsed.args[0],
        amount: parsed.args[1].toString()
      };
    }
  },
  
  // Reputation events
  AgentRegistered: {
    contract: 'reputation',
    signature: 'AgentRegistered(address,string,uint256)',
    decode: (log, iface) => {
      const parsed = iface.parseLog(log);
      return {
        agent: parsed.args[0],
        name: parsed.args[1],
        stake: parsed.args[2].toString()
      };
    }
  },
  
  // Bridge events
  BridgeInitiated: {
    contract: 'bridge',
    signature: 'BridgeInitiated(bytes32,address,uint256,uint256)',
    decode: (log, iface) => {
      const parsed = iface.parseLog(log);
      return {
        requestId: parsed.args[0],
        sender: parsed.args[1],
        amount: parsed.args[2].toString(),
        targetChain: parsed.args[3].toString()
      };
    }
  }
};

// Minimal ABIs for events
const ABIS = {
  token: [
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'event Approval(address indexed owner, address indexed spender, uint256 value)'
  ],
  paymentRouter: [
    'event PaymentSent(address indexed sender, address indexed recipient, uint256 amount, uint256 fee, bytes32 paymentId)',
    'event EscrowCreated(bytes32 indexed escrowId, address indexed sender, address indexed recipient, uint256 amount)'
  ],
  staking: [
    'event Staked(address indexed user, uint256 amount, uint256 lockTier)',
    'event RewardsClaimed(address indexed user, uint256 amount)'
  ],
  reputation: [
    'event AgentRegistered(address indexed agent, string name, uint256 stake)'
  ],
  bridge: [
    'event BridgeInitiated(bytes32 indexed requestId, address indexed sender, uint256 amount, uint256 targetChain)'
  ]
};

/**
 * Event Indexer Service
 */
class EventIndexerService {
  constructor() {
    this.app = express();
    this.redis = null;
    this.pg = null;
    this.provider = null;
    this.wsProvider = null;
    this.contracts = {};
    this.interfaces = {};
    this.wss = null;
    this.subscribers = new Map();
    this.lastIndexedBlock = 0;
  }

  async initialize() {
    console.log('📊 Initializing Event Indexer Service...');

    // Connect to Redis
    this.redis = new Redis(CONFIG.redisUrl);
    console.log('📦 Connected to Redis');

    // Connect to PostgreSQL
    this.pg = new Pool({ connectionString: CONFIG.postgresUrl });
    await this.initializeDatabase();
    console.log('🗄️  Connected to PostgreSQL');

    // Connect to blockchain
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    if (CONFIG.wsRpcUrl) {
      this.wsProvider = new ethers.WebSocketProvider(CONFIG.wsRpcUrl);
    }
    console.log('⛓️  Connected to blockchain');

    // Initialize contract interfaces
    this.initializeContracts();

    // Get last indexed block
    this.lastIndexedBlock = await this.getLastIndexedBlock();
    console.log(`📍 Last indexed block: ${this.lastIndexedBlock}`);

    // Setup routes
    this.setupRoutes();

    // Setup WebSocket server
    this.setupWebSocket();

    // Start indexing
    this.startIndexing();

    console.log('✅ Event Indexer initialized');
  }

  async initializeDatabase() {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        contract VARCHAR(100) NOT NULL,
        block_number BIGINT NOT NULL,
        block_timestamp TIMESTAMP NOT NULL,
        tx_hash VARCHAR(66) NOT NULL,
        log_index INT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(tx_hash, log_index)
      );

      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_block ON events(block_number);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(block_timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_data ON events USING GIN(data);

      CREATE TABLE IF NOT EXISTS indexer_state (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS aggregations (
        id SERIAL PRIMARY KEY,
        metric VARCHAR(100) NOT NULL,
        period VARCHAR(20) NOT NULL,
        period_start TIMESTAMP NOT NULL,
        value DECIMAL(78, 0) NOT NULL,
        metadata JSONB,
        UNIQUE(metric, period, period_start)
      );
    `);
  }

  initializeContracts() {
    for (const [name, abi] of Object.entries(ABIS)) {
      if (CONFIG.contracts[name]) {
        this.interfaces[name] = new ethers.Interface(abi);
        this.contracts[name] = new ethers.Contract(
          CONFIG.contracts[name],
          abi,
          this.provider
        );
      }
    }
  }

  async getLastIndexedBlock() {
    const result = await this.pg.query(
      "SELECT value FROM indexer_state WHERE key = 'last_indexed_block'"
    );
    return result.rows.length > 0 
      ? parseInt(result.rows[0].value) 
      : CONFIG.startBlock;
  }

  async setLastIndexedBlock(block) {
    await this.pg.query(`
      INSERT INTO indexer_state (key, value, updated_at)
      VALUES ('last_indexed_block', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [block.toString()]);
    this.lastIndexedBlock = block;
  }

  // ============ Indexing ============

  async startIndexing() {
    // Historical indexing
    this.indexHistorical();

    // Real-time indexing via WebSocket
    if (this.wsProvider) {
      this.subscribeToEvents();
    } else {
      // Polling fallback
      this.startPolling();
    }
  }

  async indexHistorical() {
    const currentBlock = await this.provider.getBlockNumber();
    const safeBlock = currentBlock - CONFIG.confirmations;

    console.log(`📜 Starting historical indexing from ${this.lastIndexedBlock} to ${safeBlock}`);

    let fromBlock = this.lastIndexedBlock + 1;

    while (fromBlock <= safeBlock) {
      const toBlock = Math.min(fromBlock + CONFIG.batchSize - 1, safeBlock);

      try {
        await this.indexBlockRange(fromBlock, toBlock);
        await this.setLastIndexedBlock(toBlock);
        
        const progress = ((toBlock - this.lastIndexedBlock) / (safeBlock - this.lastIndexedBlock) * 100).toFixed(2);
        console.log(`📦 Indexed blocks ${fromBlock}-${toBlock} (${progress}%)`);
      } catch (error) {
        console.error(`Error indexing blocks ${fromBlock}-${toBlock}:`, error);
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      fromBlock = toBlock + 1;
    }

    console.log('✅ Historical indexing complete');
  }

  async indexBlockRange(fromBlock, toBlock) {
    const events = [];

    for (const [eventName, eventDef] of Object.entries(EVENT_DEFINITIONS)) {
      const contractName = eventDef.contract;
      if (!this.contracts[contractName]) continue;

      try {
        const filter = {
          address: CONFIG.contracts[contractName],
          fromBlock,
          toBlock,
          topics: [ethers.id(eventDef.signature)]
        };

        const logs = await this.provider.getLogs(filter);

        for (const log of logs) {
          const block = await this.provider.getBlock(log.blockNumber);
          const decoded = eventDef.decode(log, this.interfaces[contractName]);

          events.push({
            eventType: eventName,
            contract: contractName,
            blockNumber: log.blockNumber,
            blockTimestamp: new Date(block.timestamp * 1000),
            txHash: log.transactionHash,
            logIndex: log.index,
            data: decoded
          });
        }
      } catch (error) {
        console.error(`Error fetching ${eventName} events:`, error);
      }
    }

    // Batch insert
    if (events.length > 0) {
      await this.insertEvents(events);
      await this.updateAggregations(events);
      this.broadcastEvents(events);
    }
  }

  async insertEvents(events) {
    const values = events.map(e => [
      e.eventType,
      e.contract,
      e.blockNumber,
      e.blockTimestamp,
      e.txHash,
      e.logIndex,
      JSON.stringify(e.data)
    ]);

    const placeholders = values.map((_, i) => {
      const offset = i * 7;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
    }).join(',');

    await this.pg.query(`
      INSERT INTO events (event_type, contract, block_number, block_timestamp, tx_hash, log_index, data)
      VALUES ${placeholders}
      ON CONFLICT (tx_hash, log_index) DO NOTHING
    `, values.flat());
  }

  subscribeToEvents() {
    for (const [eventName, eventDef] of Object.entries(EVENT_DEFINITIONS)) {
      const contract = this.contracts[eventDef.contract];
      if (!contract) continue;

      const eventSignature = eventDef.signature.split('(')[0];
      
      contract.on(eventSignature, async (...args) => {
        const event = args[args.length - 1]; // Last arg is event object
        const block = await this.provider.getBlock(event.blockNumber);
        const decoded = eventDef.decode(event, this.interfaces[eventDef.contract]);

        const eventData = {
          eventType: eventName,
          contract: eventDef.contract,
          blockNumber: event.blockNumber,
          blockTimestamp: new Date(block.timestamp * 1000),
          txHash: event.transactionHash,
          logIndex: event.index,
          data: decoded
        };

        await this.insertEvents([eventData]);
        await this.updateAggregations([eventData]);
        this.broadcastEvents([eventData]);
      });
    }

    console.log('📡 Subscribed to real-time events');
  }

  startPolling() {
    setInterval(async () => {
      const currentBlock = await this.provider.getBlockNumber();
      const safeBlock = currentBlock - CONFIG.confirmations;

      if (safeBlock > this.lastIndexedBlock) {
        await this.indexBlockRange(this.lastIndexedBlock + 1, safeBlock);
        await this.setLastIndexedBlock(safeBlock);
      }
    }, 15000); // Poll every 15 seconds
  }

  // ============ Aggregations ============

  async updateAggregations(events) {
    for (const event of events) {
      const timestamp = event.blockTimestamp;
      const hourStart = new Date(timestamp);
      hourStart.setMinutes(0, 0, 0);
      const dayStart = new Date(timestamp);
      dayStart.setHours(0, 0, 0, 0);

      // Event count aggregations
      await this.incrementAggregation(`${event.eventType}_count`, 'hour', hourStart, 1);
      await this.incrementAggregation(`${event.eventType}_count`, 'day', dayStart, 1);

      // Volume aggregations for transfers/payments
      if (event.data.amount) {
        const amount = BigInt(event.data.amount);
        await this.incrementAggregation(`${event.eventType}_volume`, 'hour', hourStart, amount);
        await this.incrementAggregation(`${event.eventType}_volume`, 'day', dayStart, amount);
      }
    }
  }

  async incrementAggregation(metric, period, periodStart, value) {
    await this.pg.query(`
      INSERT INTO aggregations (metric, period, period_start, value)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (metric, period, period_start) 
      DO UPDATE SET value = aggregations.value + $4
    `, [metric, period, periodStart, value.toString()]);
  }

  // ============ WebSocket ============

  setupWebSocket() {
    this.wss = new WebSocket.Server({ noServer: true });

    this.wss.on('connection', (ws) => {
      const id = Math.random().toString(36).substr(2, 9);
      this.subscribers.set(id, { ws, filters: [] });

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          
          if (data.type === 'subscribe') {
            const subscriber = this.subscribers.get(id);
            subscriber.filters = data.filters || [];
            ws.send(JSON.stringify({ type: 'subscribed', filters: subscriber.filters }));
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: 'error', message: error.message }));
        }
      });

      ws.on('close', () => {
        this.subscribers.delete(id);
      });
    });
  }

  broadcastEvents(events) {
    for (const [id, subscriber] of this.subscribers) {
      const filteredEvents = events.filter(event => {
        if (subscriber.filters.length === 0) return true;
        return subscriber.filters.some(f => {
          if (f.eventType && f.eventType !== event.eventType) return false;
          if (f.contract && f.contract !== event.contract) return false;
          if (f.address) {
            const addresses = Object.values(event.data).filter(v => 
              typeof v === 'string' && v.startsWith('0x')
            );
            if (!addresses.includes(f.address.toLowerCase())) return false;
          }
          return true;
        });
      });

      if (filteredEvents.length > 0) {
        subscriber.ws.send(JSON.stringify({
          type: 'events',
          data: filteredEvents
        }));
      }
    }
  }

  // ============ API Routes ============

  setupRoutes() {
    this.app.use(express.json());

    // Health check
    this.app.get('/health', async (req, res) => {
      const currentBlock = await this.provider.getBlockNumber();
      res.json({
        status: 'healthy',
        lastIndexedBlock: this.lastIndexedBlock,
        currentBlock,
        lag: currentBlock - this.lastIndexedBlock
      });
    });

    // Query events
    this.app.get('/api/events', async (req, res) => {
      try {
        const {
          eventType,
          contract,
          address,
          fromBlock,
          toBlock,
          fromTime,
          toTime,
          limit = 100,
          offset = 0
        } = req.query;

        let query = 'SELECT * FROM events WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        if (eventType) {
          query += ` AND event_type = $${paramIndex++}`;
          params.push(eventType);
        }

        if (contract) {
          query += ` AND contract = $${paramIndex++}`;
          params.push(contract);
        }

        if (address) {
          query += ` AND data @> $${paramIndex++}`;
          params.push(JSON.stringify({ from: address }));
        }

        if (fromBlock) {
          query += ` AND block_number >= $${paramIndex++}`;
          params.push(parseInt(fromBlock));
        }

        if (toBlock) {
          query += ` AND block_number <= $${paramIndex++}`;
          params.push(parseInt(toBlock));
        }

        if (fromTime) {
          query += ` AND block_timestamp >= $${paramIndex++}`;
          params.push(new Date(fromTime));
        }

        if (toTime) {
          query += ` AND block_timestamp <= $${paramIndex++}`;
          params.push(new Date(toTime));
        }

        query += ` ORDER BY block_number DESC, log_index DESC`;
        query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await this.pg.query(query, params);
        
        // Get total count
        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*)').split('ORDER BY')[0];
        const countResult = await this.pg.query(countQuery, params.slice(0, -2));

        res.json({
          events: result.rows,
          total: parseInt(countResult.rows[0].count),
          limit: parseInt(limit),
          offset: parseInt(offset)
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get event by tx hash
    this.app.get('/api/events/tx/:txHash', async (req, res) => {
      try {
        const result = await this.pg.query(
          'SELECT * FROM events WHERE tx_hash = $1 ORDER BY log_index',
          [req.params.txHash]
        );
        res.json({ events: result.rows });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get aggregations
    this.app.get('/api/aggregations', async (req, res) => {
      try {
        const { metric, period, from, to } = req.query;

        let query = 'SELECT * FROM aggregations WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        if (metric) {
          query += ` AND metric = $${paramIndex++}`;
          params.push(metric);
        }

        if (period) {
          query += ` AND period = $${paramIndex++}`;
          params.push(period);
        }

        if (from) {
          query += ` AND period_start >= $${paramIndex++}`;
          params.push(new Date(from));
        }

        if (to) {
          query += ` AND period_start <= $${paramIndex++}`;
          params.push(new Date(to));
        }

        query += ' ORDER BY period_start DESC LIMIT 1000';

        const result = await this.pg.query(query, params);
        res.json({ aggregations: result.rows });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get stats
    this.app.get('/api/stats', async (req, res) => {
      try {
        const [eventCounts, totalVolume, uniqueAddresses] = await Promise.all([
          this.pg.query('SELECT event_type, COUNT(*) FROM events GROUP BY event_type'),
          this.pg.query("SELECT metric, SUM(value::numeric) FROM aggregations WHERE metric LIKE '%_volume' AND period = 'day' GROUP BY metric"),
          this.pg.query("SELECT COUNT(DISTINCT data->>'from') + COUNT(DISTINCT data->>'to') as unique_addresses FROM events WHERE event_type = 'Transfer'")
        ]);

        res.json({
          eventCounts: eventCounts.rows,
          volumes: totalVolume.rows,
          uniqueAddresses: uniqueAddresses.rows[0]?.unique_addresses || 0,
          lastIndexedBlock: this.lastIndexedBlock
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  start() {
    const server = this.app.listen(CONFIG.port, () => {
      console.log(`\n📊 Event Indexer Service running on port ${CONFIG.port}`);
      console.log('\n📡 API Endpoints:');
      console.log('   GET  /api/events              - Query events');
      console.log('   GET  /api/events/tx/:txHash   - Events by transaction');
      console.log('   GET  /api/aggregations        - Get aggregations');
      console.log('   GET  /api/stats               - Protocol statistics\n');
    });

    // Handle WebSocket upgrades
    server.on('upgrade', (request, socket, head) => {
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });
  }
}

// Main
async function main() {
  const indexer = new EventIndexerService();
  await indexer.initialize();
  indexer.start();
}

main().catch(console.error);

module.exports = { EventIndexerService };
