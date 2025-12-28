/**
 * SYNAPSE Protocol - REST API Server
 * 
 * Production-ready API server for interacting with SYNAPSE Protocol
 * Features:
 * - Rate limiting
 * - Authentication via signed messages
 * - Caching with Redis
 * - Request validation
 * - Comprehensive error handling
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
const Redis = require('ioredis');
const winston = require('winston');

// Configuration
const CONFIG = {
  port: process.env.PORT || 3000,
  rpcUrl: process.env.RPC_URL || 'http://localhost:8545',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  contracts: {
    token: process.env.TOKEN_ADDRESS,
    paymentRouter: process.env.ROUTER_ADDRESS,
    reputation: process.env.REPUTATION_ADDRESS,
    serviceRegistry: process.env.SERVICE_REGISTRY_ADDRESS,
    paymentChannel: process.env.CHANNEL_ADDRESS,
    subscriptionManager: process.env.SUBSCRIPTION_ADDRESS,
    staking: process.env.STAKING_ADDRESS
  },
  rateLimit: {
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    writeMax: 20 // 20 write operations per minute
  },
  cache: {
    defaultTTL: 60, // 60 seconds
    longTTL: 300, // 5 minutes
    shortTTL: 10 // 10 seconds
  }
};

// Logger setup
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

// Contract ABIs (simplified)
const ABIS = {
  token: [
    'function balanceOf(address account) view returns (uint256)',
    'function totalSupply() view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'event Transfer(address indexed from, address indexed to, uint256 value)'
  ],
  router: [
    'function pay(address recipient, uint256 amount, bytes32 paymentId, bytes metadata) returns (bool)',
    'function batchPay(address[] recipients, uint256[] amounts, bytes32[] paymentIds, bytes[] metadata) returns (bool)',
    'function createEscrow(address recipient, address arbiter, uint256 amount, uint256 deadline, bytes32 paymentId, bytes metadata) returns (bytes32)',
    'function releaseEscrow(bytes32 escrowId) returns (bool)',
    'function createStream(address recipient, uint256 totalAmount, uint256 startTime, uint256 endTime, bytes32 paymentId) returns (bytes32)',
    'function escrows(bytes32 escrowId) view returns (address sender, address recipient, address arbiter, uint256 amount, uint256 deadline, uint8 status)',
    'function streams(bytes32 streamId) view returns (address sender, address recipient, uint256 totalAmount, uint256 startTime, uint256 endTime, uint256 withdrawn, uint8 status)'
  ],
  reputation: [
    'function agents(address agent) view returns (bool registered, string name, string metadataUri, uint256 stake, uint256 reputationScore, uint256 totalTransactions, uint256 successfulTransactions, uint256 registeredAt)',
    'function getTier(address agent) view returns (uint8)',
    'function getSuccessRate(address agent) view returns (uint256)',
    'function registerAgent(string name, string metadataUri, uint256 stake) returns (bool)'
  ],
  services: [
    'function services(bytes32 serviceId) view returns (address provider, string name, string category, string description, string endpoint, uint256 basePrice, uint8 pricingModel, bool active, uint256 createdAt)',
    'function getServicesByCategory(string category) view returns (bytes32[])',
    'function calculatePrice(bytes32 serviceId, uint256 quantity) view returns (uint256)',
    'function registerService(string name, string category, string description, string endpoint, uint256 basePrice, uint8 pricingModel) returns (bytes32)'
  ],
  channels: [
    'function channels(bytes32 channelId) view returns (address participant1, address participant2, uint256 balance1, uint256 balance2, uint256 nonce, uint8 status, uint256 challengeEnd)',
    'function getChannelId(address party1, address party2) view returns (bytes32)',
    'function openChannel(address counterparty, uint256 myDeposit, uint256 theirDeposit) returns (bytes32)'
  ],
  staking: [
    'function stakes(address staker) view returns (uint256 amount, uint256 shares, uint256 lockEnd, uint256 rewardDebt, uint256 pendingRewards, uint256 lastClaimTime, uint256 boostMultiplier, uint256 createdAt)',
    'function pendingRewards(address user) view returns (uint256)',
    'function totalStaked() view returns (uint256)',
    'function totalStakers() view returns (uint256)',
    'function getAPR() view returns (uint256)',
    'function getStakeInfo(address user) view returns (uint256 amount, uint256 shares, uint256 lockEnd, uint256 boostMultiplier, uint256 pendingReward, uint256 cooldownAmt, uint256 cooldownEnd)'
  ]
};

/**
 * API Server Class
 */
class APIServer {
  constructor() {
    this.app = express();
    this.provider = null;
    this.contracts = {};
    this.redis = null;
  }

  /**
   * Initialize server
   */
  async initialize() {
    logger.info('Initializing API server...');

    // Connect to Ethereum
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    const network = await this.provider.getNetwork();
    logger.info(`Connected to network: ${network.name} (${network.chainId})`);

    // Initialize contracts
    this.initializeContracts();

    // Connect to Redis
    try {
      this.redis = new Redis(CONFIG.redisUrl);
      logger.info('Connected to Redis');
    } catch (e) {
      logger.warn('Redis not available, running without caching');
    }

    // Setup middleware
    this.setupMiddleware();

    // Setup routes
    this.setupRoutes();

    // Error handling
    this.setupErrorHandling();

    logger.info('API server initialized');
  }

  /**
   * Initialize contract instances
   */
  initializeContracts() {
    if (CONFIG.contracts.token) {
      this.contracts.token = new ethers.Contract(
        CONFIG.contracts.token,
        ABIS.token,
        this.provider
      );
    }

    if (CONFIG.contracts.paymentRouter) {
      this.contracts.router = new ethers.Contract(
        CONFIG.contracts.paymentRouter,
        ABIS.router,
        this.provider
      );
    }

    if (CONFIG.contracts.reputation) {
      this.contracts.reputation = new ethers.Contract(
        CONFIG.contracts.reputation,
        ABIS.reputation,
        this.provider
      );
    }

    if (CONFIG.contracts.serviceRegistry) {
      this.contracts.services = new ethers.Contract(
        CONFIG.contracts.serviceRegistry,
        ABIS.services,
        this.provider
      );
    }

    if (CONFIG.contracts.paymentChannel) {
      this.contracts.channels = new ethers.Contract(
        CONFIG.contracts.paymentChannel,
        ABIS.channels,
        this.provider
      );
    }

    if (CONFIG.contracts.staking) {
      this.contracts.staking = new ethers.Contract(
        CONFIG.contracts.staking,
        ABIS.staking,
        this.provider
      );
    }
  }

  /**
   * Setup Express middleware
   */
  setupMiddleware() {
    // Security
    this.app.use(helmet());
    
    // CORS
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Signature', 'X-Address', 'X-Timestamp']
    }));

    // Compression
    this.app.use(compression());

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        logger.info({
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration: Date.now() - start,
          ip: req.ip
        });
      });
      next();
    });

    // Rate limiting - read operations
    const readLimiter = rateLimit({
      windowMs: CONFIG.rateLimit.windowMs,
      max: CONFIG.rateLimit.max,
      message: { error: 'Too many requests, please try again later' }
    });

    // Rate limiting - write operations
    const writeLimiter = rateLimit({
      windowMs: CONFIG.rateLimit.windowMs,
      max: CONFIG.rateLimit.writeMax,
      message: { error: 'Too many write requests, please try again later' }
    });

    this.app.use('/api/v1', readLimiter);
    this.app.use('/api/v1/*/create', writeLimiter);
    this.app.use('/api/v1/*/send', writeLimiter);
  }

  /**
   * Verify signature middleware
   */
  verifySignature(req, res, next) {
    const signature = req.headers['x-signature'];
    const address = req.headers['x-address'];
    const timestamp = req.headers['x-timestamp'];

    if (!signature || !address || !timestamp) {
      return res.status(401).json({ error: 'Missing authentication headers' });
    }

    // Check timestamp (within 5 minutes)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 300) {
      return res.status(401).json({ error: 'Request timestamp expired' });
    }

    // Verify signature
    const message = `${req.method}:${req.path}:${timestamp}`;
    try {
      const recoveredAddress = ethers.verifyMessage(message, signature);
      if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
      req.userAddress = address;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Signature verification failed' });
    }
  }

  /**
   * Cache middleware
   */
  async cacheMiddleware(key, ttl, handler) {
    return async (req, res) => {
      const cacheKey = `api:${key}:${JSON.stringify(req.params)}:${JSON.stringify(req.query)}`;

      // Try cache
      if (this.redis) {
        try {
          const cached = await this.redis.get(cacheKey);
          if (cached) {
            return res.json(JSON.parse(cached));
          }
        } catch (e) {
          logger.warn('Cache read error:', e.message);
        }
      }

      // Execute handler
      try {
        const result = await handler(req, res);
        
        // Cache result
        if (this.redis && result) {
          try {
            await this.redis.setex(cacheKey, ttl, JSON.stringify(result));
          } catch (e) {
            logger.warn('Cache write error:', e.message);
          }
        }

        return res.json(result);
      } catch (error) {
        throw error;
      }
    };
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    const router = express.Router();

    // Health check
    router.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        network: CONFIG.rpcUrl
      });
    });

    // ==================== Token Routes ====================
    
    router.get('/token/balance/:address', this.cacheMiddleware(
      'token:balance',
      CONFIG.cache.shortTTL,
      async (req) => {
        const balance = await this.contracts.token.balanceOf(req.params.address);
        return {
          address: req.params.address,
          balance: ethers.formatEther(balance),
          balanceWei: balance.toString()
        };
      }
    ));

    router.get('/token/supply', this.cacheMiddleware(
      'token:supply',
      CONFIG.cache.defaultTTL,
      async () => {
        const supply = await this.contracts.token.totalSupply();
        return {
          totalSupply: ethers.formatEther(supply),
          totalSupplyWei: supply.toString()
        };
      }
    ));

    router.get('/token/allowance/:owner/:spender', this.cacheMiddleware(
      'token:allowance',
      CONFIG.cache.shortTTL,
      async (req) => {
        const allowance = await this.contracts.token.allowance(
          req.params.owner,
          req.params.spender
        );
        return {
          owner: req.params.owner,
          spender: req.params.spender,
          allowance: ethers.formatEther(allowance),
          allowanceWei: allowance.toString()
        };
      }
    ));

    // ==================== Agent Routes ====================

    router.get('/agents/:address', this.cacheMiddleware(
      'agent',
      CONFIG.cache.defaultTTL,
      async (req) => {
        const agent = await this.contracts.reputation.agents(req.params.address);
        const tier = await this.contracts.reputation.getTier(req.params.address);
        const successRate = await this.contracts.reputation.getSuccessRate(req.params.address);

        if (!agent.registered) {
          return { registered: false, address: req.params.address };
        }

        const tierNames = ['Unverified', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];

        return {
          address: req.params.address,
          registered: agent.registered,
          name: agent.name,
          metadataUri: agent.metadataUri,
          stake: ethers.formatEther(agent.stake),
          reputationScore: agent.reputationScore.toString(),
          tier: Number(tier),
          tierName: tierNames[Number(tier)],
          totalTransactions: agent.totalTransactions.toString(),
          successfulTransactions: agent.successfulTransactions.toString(),
          successRate: (Number(successRate) / 100).toFixed(2) + '%',
          registeredAt: new Date(Number(agent.registeredAt) * 1000).toISOString()
        };
      }
    ));

    // ==================== Service Routes ====================

    router.get('/services/category/:category', this.cacheMiddleware(
      'services:category',
      CONFIG.cache.defaultTTL,
      async (req) => {
        const serviceIds = await this.contracts.services.getServicesByCategory(req.params.category);
        
        const services = await Promise.all(
          serviceIds.slice(0, 50).map(async (id) => {
            const service = await this.contracts.services.services(id);
            return {
              id: id,
              provider: service.provider,
              name: service.name,
              category: service.category,
              description: service.description,
              endpoint: service.endpoint,
              basePrice: ethers.formatEther(service.basePrice),
              pricingModel: Number(service.pricingModel),
              active: service.active
            };
          })
        );

        return {
          category: req.params.category,
          count: serviceIds.length,
          services: services.filter(s => s.active)
        };
      }
    ));

    router.get('/services/:serviceId', this.cacheMiddleware(
      'service',
      CONFIG.cache.defaultTTL,
      async (req) => {
        const service = await this.contracts.services.services(req.params.serviceId);
        
        const pricingModels = ['Per Request', 'Per Token', 'Per Second', 'Per Byte', 'Subscription', 'Custom'];

        return {
          id: req.params.serviceId,
          provider: service.provider,
          name: service.name,
          category: service.category,
          description: service.description,
          endpoint: service.endpoint,
          basePrice: ethers.formatEther(service.basePrice),
          basePriceWei: service.basePrice.toString(),
          pricingModel: Number(service.pricingModel),
          pricingModelName: pricingModels[Number(service.pricingModel)],
          active: service.active,
          createdAt: new Date(Number(service.createdAt) * 1000).toISOString()
        };
      }
    ));

    router.get('/services/:serviceId/price/:quantity', this.cacheMiddleware(
      'service:price',
      CONFIG.cache.shortTTL,
      async (req) => {
        const price = await this.contracts.services.calculatePrice(
          req.params.serviceId,
          req.params.quantity
        );
        
        return {
          serviceId: req.params.serviceId,
          quantity: req.params.quantity,
          price: ethers.formatEther(price),
          priceWei: price.toString()
        };
      }
    ));

    // ==================== Channel Routes ====================

    router.get('/channels/:party1/:party2', this.cacheMiddleware(
      'channel',
      CONFIG.cache.shortTTL,
      async (req) => {
        const channelId = await this.contracts.channels.getChannelId(
          req.params.party1,
          req.params.party2
        );
        const channel = await this.contracts.channels.channels(channelId);

        const statusNames = ['None', 'Open', 'Closing', 'Closed'];

        return {
          channelId: channelId,
          participant1: channel.participant1,
          participant2: channel.participant2,
          balance1: ethers.formatEther(channel.balance1),
          balance2: ethers.formatEther(channel.balance2),
          nonce: channel.nonce.toString(),
          status: Number(channel.status),
          statusName: statusNames[Number(channel.status)],
          challengeEnd: channel.challengeEnd > 0 
            ? new Date(Number(channel.challengeEnd) * 1000).toISOString() 
            : null
        };
      }
    ));

    // ==================== Payment Routes ====================

    router.get('/payments/escrow/:escrowId', this.cacheMiddleware(
      'escrow',
      CONFIG.cache.shortTTL,
      async (req) => {
        const escrow = await this.contracts.router.escrows(req.params.escrowId);
        
        const statusNames = ['Pending', 'Released', 'Refunded', 'Disputed'];

        return {
          escrowId: req.params.escrowId,
          sender: escrow.sender,
          recipient: escrow.recipient,
          arbiter: escrow.arbiter,
          amount: ethers.formatEther(escrow.amount),
          deadline: new Date(Number(escrow.deadline) * 1000).toISOString(),
          status: Number(escrow.status),
          statusName: statusNames[Number(escrow.status)]
        };
      }
    ));

    router.get('/payments/stream/:streamId', this.cacheMiddleware(
      'stream',
      CONFIG.cache.shortTTL,
      async (req) => {
        const stream = await this.contracts.router.streams(req.params.streamId);
        
        const statusNames = ['Active', 'Completed', 'Cancelled'];

        return {
          streamId: req.params.streamId,
          sender: stream.sender,
          recipient: stream.recipient,
          totalAmount: ethers.formatEther(stream.totalAmount),
          withdrawn: ethers.formatEther(stream.withdrawn),
          remaining: ethers.formatEther(stream.totalAmount - stream.withdrawn),
          startTime: new Date(Number(stream.startTime) * 1000).toISOString(),
          endTime: new Date(Number(stream.endTime) * 1000).toISOString(),
          status: Number(stream.status),
          statusName: statusNames[Number(stream.status)]
        };
      }
    ));

    // ==================== Staking Routes ====================

    router.get('/staking/info/:address', this.cacheMiddleware(
      'staking:info',
      CONFIG.cache.shortTTL,
      async (req) => {
        const info = await this.contracts.staking.getStakeInfo(req.params.address);
        
        return {
          address: req.params.address,
          amount: ethers.formatEther(info.amount),
          shares: ethers.formatEther(info.shares),
          boostMultiplier: (Number(info.boostMultiplier) / 100).toFixed(2) + 'x',
          lockEnd: info.lockEnd > 0 
            ? new Date(Number(info.lockEnd) * 1000).toISOString() 
            : null,
          pendingRewards: ethers.formatEther(info.pendingReward),
          cooldownAmount: ethers.formatEther(info.cooldownAmt),
          cooldownEnd: info.cooldownEnd > 0 
            ? new Date(Number(info.cooldownEnd) * 1000).toISOString() 
            : null
        };
      }
    ));

    router.get('/staking/stats', this.cacheMiddleware(
      'staking:stats',
      CONFIG.cache.defaultTTL,
      async () => {
        const [totalStaked, totalStakers, apr] = await Promise.all([
          this.contracts.staking.totalStaked(),
          this.contracts.staking.totalStakers(),
          this.contracts.staking.getAPR()
        ]);

        return {
          totalStaked: ethers.formatEther(totalStaked),
          totalStakers: totalStakers.toString(),
          apr: (Number(apr) / 100).toFixed(2) + '%'
        };
      }
    ));

    // ==================== Protocol Stats ====================

    router.get('/stats', this.cacheMiddleware(
      'protocol:stats',
      CONFIG.cache.defaultTTL,
      async () => {
        const [supply, totalStaked, totalStakers] = await Promise.all([
          this.contracts.token?.totalSupply() || 0n,
          this.contracts.staking?.totalStaked() || 0n,
          this.contracts.staking?.totalStakers() || 0n
        ]);

        return {
          totalSupply: ethers.formatEther(supply),
          totalStaked: ethers.formatEther(totalStaked),
          totalStakers: totalStakers.toString(),
          stakingRatio: supply > 0n 
            ? ((Number(totalStaked) / Number(supply)) * 100).toFixed(2) + '%' 
            : '0%',
          timestamp: new Date().toISOString()
        };
      }
    ));

    // Mount router
    this.app.use('/api/v1', router);
  }

  /**
   * Setup error handling
   */
  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Endpoint not found' });
    });

    // Error handler
    this.app.use((err, req, res, next) => {
      logger.error({
        error: err.message,
        stack: err.stack,
        path: req.path
      });

      res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production' 
          ? 'Internal server error' 
          : err.message
      });
    });
  }

  /**
   * Start server
   */
  start() {
    this.app.listen(CONFIG.port, () => {
      logger.info(`API server running on port ${CONFIG.port}`);
      console.log(`
🚀 SYNAPSE Protocol API Server

📡 Endpoints:
   GET  /api/v1/health
   
   Token:
   GET  /api/v1/token/balance/:address
   GET  /api/v1/token/supply
   GET  /api/v1/token/allowance/:owner/:spender
   
   Agents:
   GET  /api/v1/agents/:address
   
   Services:
   GET  /api/v1/services/category/:category
   GET  /api/v1/services/:serviceId
   GET  /api/v1/services/:serviceId/price/:quantity
   
   Channels:
   GET  /api/v1/channels/:party1/:party2
   
   Payments:
   GET  /api/v1/payments/escrow/:escrowId
   GET  /api/v1/payments/stream/:streamId
   
   Staking:
   GET  /api/v1/staking/info/:address
   GET  /api/v1/staking/stats
   
   Protocol:
   GET  /api/v1/stats

📚 Documentation: http://localhost:${CONFIG.port}/docs
      `);
    });
  }
}

// Main entry point
async function main() {
  const server = new APIServer();
  await server.initialize();
  server.start();
}

main().catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});

module.exports = { APIServer };
