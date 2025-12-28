/**
 * SYNAPSE Protocol - WebSocket Event Server
 * 
 * Real-time event streaming for:
 * - Payment notifications
 * - Agent status updates
 * - Service discovery
 * - Channel state changes
 * - Protocol statistics
 */

const WebSocket = require('ws');
const { ethers } = require('ethers');
const express = require('express');
const http = require('http');
const Redis = require('ioredis');

// Configuration
const CONFIG = {
  port: process.env.WS_PORT || 8080,
  rpcUrl: process.env.RPC_URL || 'http://localhost:8545',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  contracts: {
    token: process.env.TOKEN_ADDRESS,
    paymentRouter: process.env.ROUTER_ADDRESS,
    reputation: process.env.REPUTATION_ADDRESS,
    serviceRegistry: process.env.SERVICE_REGISTRY_ADDRESS,
    paymentChannel: process.env.CHANNEL_ADDRESS
  }
};

// Event types
const EventType = {
  // Connection events
  CONNECTED: 'connected',
  SUBSCRIBED: 'subscribed',
  UNSUBSCRIBED: 'unsubscribed',
  ERROR: 'error',
  
  // Payment events
  PAYMENT: 'payment',
  PAYMENT_RECEIVED: 'payment_received',
  BATCH_PAYMENT: 'batch_payment',
  ESCROW_CREATED: 'escrow_created',
  ESCROW_RELEASED: 'escrow_released',
  ESCROW_REFUNDED: 'escrow_refunded',
  STREAM_CREATED: 'stream_created',
  STREAM_WITHDRAWAL: 'stream_withdrawal',
  STREAM_CANCELLED: 'stream_cancelled',
  
  // Agent events
  AGENT_REGISTERED: 'agent_registered',
  AGENT_DEREGISTERED: 'agent_deregistered',
  STAKE_CHANGED: 'stake_changed',
  REPUTATION_UPDATED: 'reputation_updated',
  DISPUTE_CREATED: 'dispute_created',
  DISPUTE_RESOLVED: 'dispute_resolved',
  AGENT_SLASHED: 'agent_slashed',
  SERVICE_RATED: 'service_rated',
  
  // Service events
  SERVICE_REGISTERED: 'service_registered',
  SERVICE_UPDATED: 'service_updated',
  SERVICE_ACTIVATED: 'service_activated',
  SERVICE_DEACTIVATED: 'service_deactivated',
  QUOTE_REQUESTED: 'quote_requested',
  QUOTE_ACCEPTED: 'quote_accepted',
  
  // Channel events
  CHANNEL_OPENED: 'channel_opened',
  CHANNEL_FUNDED: 'channel_funded',
  CHANNEL_CLOSING: 'channel_closing',
  CHANNEL_CHALLENGED: 'channel_challenged',
  CHANNEL_CLOSED: 'channel_closed',
  
  // Protocol events
  STATS_UPDATE: 'stats_update',
  BLOCK_UPDATE: 'block_update'
};

// Event ABIs for parsing
const EVENT_ABIS = {
  Payment: 'event Payment(address indexed sender, address indexed recipient, uint256 amount, uint256 fee, bytes32 paymentId)',
  BatchPayment: 'event BatchPayment(address indexed sender, uint256 totalAmount, uint256 totalFees)',
  EscrowCreated: 'event EscrowCreated(bytes32 indexed escrowId, address indexed sender, address indexed recipient, uint256 amount, uint256 deadline)',
  EscrowReleased: 'event EscrowReleased(bytes32 indexed escrowId, uint256 amount)',
  EscrowRefunded: 'event EscrowRefunded(bytes32 indexed escrowId)',
  StreamCreated: 'event StreamCreated(bytes32 indexed streamId, address indexed sender, address indexed recipient, uint256 totalAmount, uint256 startTime, uint256 endTime)',
  StreamWithdrawal: 'event StreamWithdrawal(bytes32 indexed streamId, uint256 amount)',
  StreamCancelled: 'event StreamCancelled(bytes32 indexed streamId)',
  AgentRegistered: 'event AgentRegistered(address indexed agent, string name, uint256 stake)',
  AgentDeregistered: 'event AgentDeregistered(address indexed agent)',
  StakeIncreased: 'event StakeIncreased(address indexed agent, uint256 newStake)',
  StakeDecreased: 'event StakeDecreased(address indexed agent, uint256 newStake)',
  ReputationUpdated: 'event ReputationUpdated(address indexed agent, uint256 oldScore, uint256 newScore)',
  DisputeCreated: 'event DisputeCreated(bytes32 indexed disputeId, address indexed complainant, address indexed defendant, string reason)',
  DisputeResolved: 'event DisputeResolved(bytes32 indexed disputeId, bool inFavorOfComplainant)',
  AgentSlashed: 'event AgentSlashed(address indexed agent, uint256 amount, string reason)',
  ServiceRated: 'event ServiceRated(address indexed rater, address indexed provider, string category, uint8 rating)',
  ServiceRegistered: 'event ServiceRegistered(bytes32 indexed serviceId, address indexed provider, string name, string category)',
  ServiceUpdated: 'event ServiceUpdated(bytes32 indexed serviceId)',
  ServiceActivated: 'event ServiceActivated(bytes32 indexed serviceId)',
  ServiceDeactivated: 'event ServiceDeactivated(bytes32 indexed serviceId)',
  QuoteRequested: 'event QuoteRequested(bytes32 indexed quoteId, bytes32 indexed serviceId, address indexed requester, uint256 quantity)',
  QuoteAccepted: 'event QuoteAccepted(bytes32 indexed quoteId, uint256 price)',
  ChannelOpened: 'event ChannelOpened(bytes32 indexed channelId, address indexed party1, address indexed party2, uint256 deposit1, uint256 deposit2)',
  ChannelFunded: 'event ChannelFunded(bytes32 indexed channelId, address indexed funder, uint256 amount)',
  ChannelClosing: 'event ChannelClosing(bytes32 indexed channelId, uint256 challengeEnd)',
  ChannelChallenged: 'event ChannelChallenged(bytes32 indexed channelId, uint256 newNonce)',
  ChannelClosed: 'event ChannelClosed(bytes32 indexed channelId, uint256 finalBalance1, uint256 finalBalance2)'
};

/**
 * WebSocket Event Server
 */
class EventServer {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server });
    this.provider = null;
    this.redis = null;
    this.subscriptions = new Map(); // client -> Set of subscriptions
    this.addressSubscriptions = new Map(); // address -> Set of clients
    this.channelSubscriptions = new Map(); // channelId -> Set of clients
    this.categorySubscriptions = new Map(); // category -> Set of clients
    this.contracts = {};
    this.stats = {
      totalPayments: 0,
      totalVolume: ethers.parseEther('0'),
      activeAgents: 0,
      activeChannels: 0
    };
  }

  /**
   * Initialize the server
   */
  async initialize() {
    console.log('🚀 Initializing WebSocket Event Server...');

    // Connect to Ethereum
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    const network = await this.provider.getNetwork();
    console.log(`📡 Connected to network: ${network.name} (${network.chainId})`);

    // Connect to Redis
    if (CONFIG.redisUrl) {
      try {
        this.redis = new Redis(CONFIG.redisUrl);
        console.log('📦 Connected to Redis');
      } catch (e) {
        console.log('⚠️ Redis not available, running without caching');
      }
    }

    // Initialize contract interfaces
    this.initializeContracts();

    // Set up event listeners
    this.setupEventListeners();

    // Set up WebSocket handlers
    this.setupWebSocketHandlers();

    // Set up REST endpoints
    this.setupRestEndpoints();

    // Start periodic stats broadcast
    this.startStatsBroadcast();

    console.log('✅ Event Server initialized');
  }

  /**
   * Initialize contract interfaces
   */
  initializeContracts() {
    const iface = new ethers.Interface(Object.values(EVENT_ABIS));
    
    this.contracts = {
      token: CONFIG.contracts.token,
      paymentRouter: CONFIG.contracts.paymentRouter,
      reputation: CONFIG.contracts.reputation,
      serviceRegistry: CONFIG.contracts.serviceRegistry,
      paymentChannel: CONFIG.contracts.paymentChannel
    };

    this.eventInterface = iface;
  }

  /**
   * Set up blockchain event listeners
   */
  setupEventListeners() {
    // Listen for new blocks
    this.provider.on('block', async (blockNumber) => {
      this.broadcastToAll({
        type: EventType.BLOCK_UPDATE,
        data: { blockNumber }
      });

      // Process block events
      await this.processBlockEvents(blockNumber);
    });

    // Set up contract event filters
    this.setupContractFilters();
  }

  /**
   * Set up contract event filters
   */
  setupContractFilters() {
    const contracts = [
      { address: CONFIG.contracts.paymentRouter, name: 'PaymentRouter' },
      { address: CONFIG.contracts.reputation, name: 'Reputation' },
      { address: CONFIG.contracts.serviceRegistry, name: 'ServiceRegistry' },
      { address: CONFIG.contracts.paymentChannel, name: 'PaymentChannel' }
    ];

    contracts.forEach(({ address, name }) => {
      if (address) {
        const filter = { address };
        this.provider.on(filter, (log) => {
          this.processLog(log, name);
        });
      }
    });
  }

  /**
   * Process a single log event
   */
  processLog(log, contractName) {
    try {
      const parsed = this.eventInterface.parseLog({
        topics: log.topics,
        data: log.data
      });

      if (!parsed) return;

      const eventData = {
        event: parsed.name,
        args: {},
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        contract: contractName
      };

      // Convert args to plain object
      parsed.fragment.inputs.forEach((input, i) => {
        let value = parsed.args[i];
        if (typeof value === 'bigint') {
          value = value.toString();
        }
        eventData.args[input.name] = value;
      });

      // Route event to appropriate handler
      this.handleEvent(parsed.name, eventData);
    } catch (e) {
      // Not a recognized event
    }
  }

  /**
   * Handle parsed event
   */
  handleEvent(eventName, eventData) {
    const eventTypeMap = {
      'Payment': EventType.PAYMENT,
      'BatchPayment': EventType.BATCH_PAYMENT,
      'EscrowCreated': EventType.ESCROW_CREATED,
      'EscrowReleased': EventType.ESCROW_RELEASED,
      'EscrowRefunded': EventType.ESCROW_REFUNDED,
      'StreamCreated': EventType.STREAM_CREATED,
      'StreamWithdrawal': EventType.STREAM_WITHDRAWAL,
      'StreamCancelled': EventType.STREAM_CANCELLED,
      'AgentRegistered': EventType.AGENT_REGISTERED,
      'AgentDeregistered': EventType.AGENT_DEREGISTERED,
      'StakeIncreased': EventType.STAKE_CHANGED,
      'StakeDecreased': EventType.STAKE_CHANGED,
      'ReputationUpdated': EventType.REPUTATION_UPDATED,
      'DisputeCreated': EventType.DISPUTE_CREATED,
      'DisputeResolved': EventType.DISPUTE_RESOLVED,
      'AgentSlashed': EventType.AGENT_SLASHED,
      'ServiceRated': EventType.SERVICE_RATED,
      'ServiceRegistered': EventType.SERVICE_REGISTERED,
      'ServiceUpdated': EventType.SERVICE_UPDATED,
      'ServiceActivated': EventType.SERVICE_ACTIVATED,
      'ServiceDeactivated': EventType.SERVICE_DEACTIVATED,
      'QuoteRequested': EventType.QUOTE_REQUESTED,
      'QuoteAccepted': EventType.QUOTE_ACCEPTED,
      'ChannelOpened': EventType.CHANNEL_OPENED,
      'ChannelFunded': EventType.CHANNEL_FUNDED,
      'ChannelClosing': EventType.CHANNEL_CLOSING,
      'ChannelChallenged': EventType.CHANNEL_CHALLENGED,
      'ChannelClosed': EventType.CHANNEL_CLOSED
    };

    const eventType = eventTypeMap[eventName];
    if (!eventType) return;

    const message = {
      type: eventType,
      data: eventData.args,
      meta: {
        transactionHash: eventData.transactionHash,
        blockNumber: eventData.blockNumber,
        timestamp: Date.now()
      }
    };

    // Update stats
    this.updateStats(eventName, eventData);

    // Broadcast to relevant subscribers
    this.broadcastEvent(eventType, message, eventData.args);

    // Cache event
    this.cacheEvent(eventType, message);
  }

  /**
   * Update protocol stats
   */
  updateStats(eventName, eventData) {
    switch (eventName) {
      case 'Payment':
        this.stats.totalPayments++;
        this.stats.totalVolume = BigInt(this.stats.totalVolume) + BigInt(eventData.args.amount || 0);
        break;
      case 'AgentRegistered':
        this.stats.activeAgents++;
        break;
      case 'AgentDeregistered':
        this.stats.activeAgents--;
        break;
      case 'ChannelOpened':
        this.stats.activeChannels++;
        break;
      case 'ChannelClosed':
        this.stats.activeChannels--;
        break;
    }
  }

  /**
   * Broadcast event to relevant subscribers
   */
  broadcastEvent(eventType, message, args) {
    // Broadcast to all subscribers of this event type
    this.wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;

      const subs = this.subscriptions.get(client);
      if (!subs) return;

      // Check if subscribed to this event type
      if (subs.has(eventType) || subs.has('all')) {
        client.send(JSON.stringify(message));
        return;
      }

      // Check address-specific subscriptions
      const addresses = ['sender', 'recipient', 'agent', 'provider', 'party1', 'party2'];
      for (const addr of addresses) {
        if (args[addr]) {
          const addrSubs = this.addressSubscriptions.get(args[addr].toLowerCase());
          if (addrSubs && addrSubs.has(client)) {
            client.send(JSON.stringify(message));
            return;
          }
        }
      }

      // Check channel subscriptions
      if (args.channelId) {
        const channelSubs = this.channelSubscriptions.get(args.channelId);
        if (channelSubs && channelSubs.has(client)) {
          client.send(JSON.stringify(message));
          return;
        }
      }
    });
  }

  /**
   * Broadcast to all connected clients
   */
  broadcastToAll(message) {
    const data = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  /**
   * Cache event in Redis
   */
  async cacheEvent(eventType, message) {
    if (!this.redis) return;

    try {
      const key = `events:${eventType}`;
      await this.redis.lpush(key, JSON.stringify(message));
      await this.redis.ltrim(key, 0, 999); // Keep last 1000 events
      await this.redis.expire(key, 86400); // Expire after 24 hours
    } catch (e) {
      console.error('Redis cache error:', e.message);
    }
  }

  /**
   * Set up WebSocket handlers
   */
  setupWebSocketHandlers() {
    this.wss.on('connection', (ws, req) => {
      const clientId = req.headers['x-client-id'] || `client-${Date.now()}`;
      console.log(`📱 Client connected: ${clientId}`);

      // Initialize subscriptions for this client
      this.subscriptions.set(ws, new Set());

      // Send welcome message
      ws.send(JSON.stringify({
        type: EventType.CONNECTED,
        data: {
          clientId,
          serverTime: Date.now(),
          availableEvents: Object.values(EventType)
        }
      }));

      // Handle messages
      ws.on('message', (data) => {
        this.handleClientMessage(ws, data.toString());
      });

      // Handle close
      ws.on('close', () => {
        console.log(`📴 Client disconnected: ${clientId}`);
        this.cleanupClient(ws);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error(`Client error: ${error.message}`);
        this.cleanupClient(ws);
      });
    });
  }

  /**
   * Handle client message
   */
  handleClientMessage(ws, data) {
    try {
      const message = JSON.parse(data);
      
      switch (message.action) {
        case 'subscribe':
          this.handleSubscribe(ws, message);
          break;
        case 'unsubscribe':
          this.handleUnsubscribe(ws, message);
          break;
        case 'getHistory':
          this.handleGetHistory(ws, message);
          break;
        case 'getStats':
          this.handleGetStats(ws);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        default:
          ws.send(JSON.stringify({
            type: EventType.ERROR,
            data: { message: `Unknown action: ${message.action}` }
          }));
      }
    } catch (e) {
      ws.send(JSON.stringify({
        type: EventType.ERROR,
        data: { message: 'Invalid message format' }
      }));
    }
  }

  /**
   * Handle subscribe request
   */
  handleSubscribe(ws, message) {
    const subs = this.subscriptions.get(ws);
    
    // Subscribe to event types
    if (message.events) {
      message.events.forEach((event) => {
        subs.add(event);
      });
    }

    // Subscribe to specific address
    if (message.address) {
      const addr = message.address.toLowerCase();
      if (!this.addressSubscriptions.has(addr)) {
        this.addressSubscriptions.set(addr, new Set());
      }
      this.addressSubscriptions.get(addr).add(ws);
    }

    // Subscribe to specific channel
    if (message.channelId) {
      if (!this.channelSubscriptions.has(message.channelId)) {
        this.channelSubscriptions.set(message.channelId, new Set());
      }
      this.channelSubscriptions.get(message.channelId).add(ws);
    }

    // Subscribe to category
    if (message.category) {
      if (!this.categorySubscriptions.has(message.category)) {
        this.categorySubscriptions.set(message.category, new Set());
      }
      this.categorySubscriptions.get(message.category).add(ws);
    }

    ws.send(JSON.stringify({
      type: EventType.SUBSCRIBED,
      data: {
        events: message.events,
        address: message.address,
        channelId: message.channelId,
        category: message.category
      }
    }));
  }

  /**
   * Handle unsubscribe request
   */
  handleUnsubscribe(ws, message) {
    const subs = this.subscriptions.get(ws);

    if (message.events) {
      message.events.forEach((event) => {
        subs.delete(event);
      });
    }

    if (message.address) {
      const addrSubs = this.addressSubscriptions.get(message.address.toLowerCase());
      if (addrSubs) {
        addrSubs.delete(ws);
      }
    }

    if (message.channelId) {
      const channelSubs = this.channelSubscriptions.get(message.channelId);
      if (channelSubs) {
        channelSubs.delete(ws);
      }
    }

    ws.send(JSON.stringify({
      type: EventType.UNSUBSCRIBED,
      data: message
    }));
  }

  /**
   * Handle history request
   */
  async handleGetHistory(ws, message) {
    if (!this.redis) {
      ws.send(JSON.stringify({
        type: 'history',
        data: { events: [], message: 'History not available (Redis not connected)' }
      }));
      return;
    }

    const key = `events:${message.eventType || 'payment'}`;
    const limit = Math.min(message.limit || 100, 1000);

    try {
      const events = await this.redis.lrange(key, 0, limit - 1);
      ws.send(JSON.stringify({
        type: 'history',
        data: {
          eventType: message.eventType,
          events: events.map((e) => JSON.parse(e))
        }
      }));
    } catch (e) {
      ws.send(JSON.stringify({
        type: EventType.ERROR,
        data: { message: 'Failed to fetch history' }
      }));
    }
  }

  /**
   * Handle stats request
   */
  handleGetStats(ws) {
    ws.send(JSON.stringify({
      type: EventType.STATS_UPDATE,
      data: {
        ...this.stats,
        totalVolume: this.stats.totalVolume.toString(),
        connectedClients: this.wss.clients.size,
        timestamp: Date.now()
      }
    }));
  }

  /**
   * Clean up client subscriptions
   */
  cleanupClient(ws) {
    this.subscriptions.delete(ws);

    // Clean up address subscriptions
    this.addressSubscriptions.forEach((clients, addr) => {
      clients.delete(ws);
      if (clients.size === 0) {
        this.addressSubscriptions.delete(addr);
      }
    });

    // Clean up channel subscriptions
    this.channelSubscriptions.forEach((clients, channelId) => {
      clients.delete(ws);
      if (clients.size === 0) {
        this.channelSubscriptions.delete(channelId);
      }
    });

    // Clean up category subscriptions
    this.categorySubscriptions.forEach((clients, category) => {
      clients.delete(ws);
      if (clients.size === 0) {
        this.categorySubscriptions.delete(category);
      }
    });
  }

  /**
   * Set up REST endpoints
   */
  setupRestEndpoints() {
    this.app.use(express.json());

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        connections: this.wss.clients.size,
        uptime: process.uptime()
      });
    });

    // Get stats
    this.app.get('/stats', (req, res) => {
      res.json({
        ...this.stats,
        totalVolume: this.stats.totalVolume.toString(),
        connectedClients: this.wss.clients.size
      });
    });

    // Get recent events
    this.app.get('/events/:type', async (req, res) => {
      if (!this.redis) {
        return res.json({ events: [] });
      }

      const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
      const key = `events:${req.params.type}`;

      try {
        const events = await this.redis.lrange(key, 0, limit - 1);
        res.json({ events: events.map((e) => JSON.parse(e)) });
      } catch (e) {
        res.status(500).json({ error: 'Failed to fetch events' });
      }
    });
  }

  /**
   * Start periodic stats broadcast
   */
  startStatsBroadcast() {
    setInterval(() => {
      if (this.wss.clients.size > 0) {
        this.broadcastToAll({
          type: EventType.STATS_UPDATE,
          data: {
            ...this.stats,
            totalVolume: this.stats.totalVolume.toString(),
            connectedClients: this.wss.clients.size,
            timestamp: Date.now()
          }
        });
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Process events from a block
   */
  async processBlockEvents(blockNumber) {
    // Get block with transactions
    try {
      const block = await this.provider.getBlock(blockNumber, true);
      if (block && block.transactions) {
        // Process transactions if needed
      }
    } catch (e) {
      console.error('Error processing block:', e.message);
    }
  }

  /**
   * Start the server
   */
  start() {
    this.server.listen(CONFIG.port, () => {
      console.log(`\n🌐 WebSocket Event Server running on port ${CONFIG.port}`);
      console.log(`   WebSocket: ws://localhost:${CONFIG.port}`);
      console.log(`   REST API:  http://localhost:${CONFIG.port}`);
      console.log('\n📡 Endpoints:');
      console.log('   GET  /health     - Health check');
      console.log('   GET  /stats      - Protocol statistics');
      console.log('   GET  /events/:type - Recent events');
      console.log('\n📨 WebSocket Actions:');
      console.log('   subscribe   - Subscribe to events');
      console.log('   unsubscribe - Unsubscribe from events');
      console.log('   getHistory  - Get event history');
      console.log('   getStats    - Get protocol stats');
      console.log('   ping        - Keep-alive ping\n');
    });
  }
}

// Client example
const clientExample = `
// Example WebSocket Client Usage

const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
  // Subscribe to all payment events
  ws.send(JSON.stringify({
    action: 'subscribe',
    events: ['payment', 'payment_received']
  }));

  // Subscribe to specific address
  ws.send(JSON.stringify({
    action: 'subscribe',
    address: '0x1234...'
  }));

  // Subscribe to specific channel
  ws.send(JSON.stringify({
    action: 'subscribe',
    channelId: '0xabcd...'
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data.type, data.data);
};
`;

// Main entry point
async function main() {
  const server = new EventServer();
  await server.initialize();
  server.start();
}

main().catch(console.error);

module.exports = { EventServer, EventType };
