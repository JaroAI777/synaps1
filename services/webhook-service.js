/**
 * SYNAPSE Protocol - Webhook Notification Service
 * 
 * Provides webhook notifications for protocol events
 * Features:
 * - Event subscriptions
 * - Retry mechanism with exponential backoff
 * - Webhook verification
 * - Delivery tracking
 * - Rate limiting per endpoint
 */

const express = require('express');
const { ethers } = require('ethers');
const Redis = require('ioredis');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// Configuration
const CONFIG = {
  port: process.env.WEBHOOK_PORT || 3003,
  rpcUrl: process.env.RPC_URL || 'http://localhost:8545',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  
  // Webhook settings
  maxRetries: 5,
  retryDelayMs: 1000, // Base delay (exponential backoff)
  deliveryTimeout: 30000, // 30 seconds
  maxWebhooksPerUser: 10,
  maxEventsPerSecond: 100,
  
  // Security
  signatureHeader: 'X-Synapse-Signature',
  timestampHeader: 'X-Synapse-Timestamp',
  signatureVersion: 'v1'
};

// Event types
const EventTypes = {
  // Payment events
  PAYMENT_SENT: 'payment.sent',
  PAYMENT_RECEIVED: 'payment.received',
  BATCH_PAYMENT: 'payment.batch',
  
  // Escrow events
  ESCROW_CREATED: 'escrow.created',
  ESCROW_RELEASED: 'escrow.released',
  ESCROW_REFUNDED: 'escrow.refunded',
  ESCROW_DISPUTED: 'escrow.disputed',
  
  // Stream events
  STREAM_CREATED: 'stream.created',
  STREAM_WITHDRAWAL: 'stream.withdrawal',
  STREAM_CANCELLED: 'stream.cancelled',
  
  // Agent events
  AGENT_REGISTERED: 'agent.registered',
  AGENT_DEREGISTERED: 'agent.deregistered',
  REPUTATION_UPDATED: 'agent.reputation_updated',
  STAKE_CHANGED: 'agent.stake_changed',
  
  // Service events
  SERVICE_REGISTERED: 'service.registered',
  SERVICE_UPDATED: 'service.updated',
  QUOTE_REQUESTED: 'service.quote_requested',
  QUOTE_ACCEPTED: 'service.quote_accepted',
  
  // Channel events
  CHANNEL_OPENED: 'channel.opened',
  CHANNEL_FUNDED: 'channel.funded',
  CHANNEL_CLOSING: 'channel.closing',
  CHANNEL_CLOSED: 'channel.closed',
  
  // Subscription events
  SUBSCRIPTION_CREATED: 'subscription.created',
  SUBSCRIPTION_RENEWED: 'subscription.renewed',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',
  
  // Staking events
  STAKE_DEPOSITED: 'staking.deposited',
  STAKE_WITHDRAWN: 'staking.withdrawn',
  REWARDS_CLAIMED: 'staking.rewards_claimed',
  
  // Bridge events
  BRIDGE_INITIATED: 'bridge.initiated',
  BRIDGE_COMPLETED: 'bridge.completed',
  BRIDGE_REFUNDED: 'bridge.refunded'
};

/**
 * Webhook Subscription
 */
class WebhookSubscription {
  constructor(data) {
    this.id = data.id || uuidv4();
    this.userId = data.userId;
    this.url = data.url;
    this.secret = data.secret || crypto.randomBytes(32).toString('hex');
    this.events = data.events || ['*'];
    this.filters = data.filters || {}; // e.g., { address: '0x...' }
    this.enabled = data.enabled !== false;
    this.createdAt = data.createdAt || new Date();
    this.metadata = data.metadata || {};
    
    // Stats
    this.totalDeliveries = data.totalDeliveries || 0;
    this.successfulDeliveries = data.successfulDeliveries || 0;
    this.failedDeliveries = data.failedDeliveries || 0;
    this.lastDeliveryAt = data.lastDeliveryAt || null;
    this.lastDeliveryStatus = data.lastDeliveryStatus || null;
  }
}

/**
 * Webhook Event
 */
class WebhookEvent {
  constructor(type, data, metadata = {}) {
    this.id = uuidv4();
    this.type = type;
    this.data = data;
    this.metadata = {
      ...metadata,
      timestamp: Date.now(),
      version: '1.0'
    };
  }
}

/**
 * Delivery Attempt
 */
class DeliveryAttempt {
  constructor(subscriptionId, event) {
    this.id = uuidv4();
    this.subscriptionId = subscriptionId;
    this.eventId = event.id;
    this.eventType = event.type;
    this.attempt = 1;
    this.maxAttempts = CONFIG.maxRetries;
    this.status = 'pending';
    this.createdAt = new Date();
    this.nextRetryAt = null;
    this.completedAt = null;
    this.responseStatus = null;
    this.responseBody = null;
    this.error = null;
  }
}

/**
 * Webhook Service
 */
class WebhookService {
  constructor() {
    this.app = express();
    this.redis = null;
    this.provider = null;
    this.subscriptions = new Map();
    this.deliveryQueue = [];
    this.processing = false;
  }

  /**
   * Initialize service
   */
  async initialize() {
    console.log('🔔 Initializing Webhook Service...');

    // Connect to Redis
    try {
      this.redis = new Redis(CONFIG.redisUrl);
      console.log('📦 Connected to Redis');
      
      // Load subscriptions from Redis
      await this.loadSubscriptions();
    } catch (e) {
      console.log('⚠️ Redis not available, using in-memory storage');
    }

    // Connect to Ethereum
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);

    // Setup Express
    this.setupRoutes();

    // Start delivery processor
    this.startDeliveryProcessor();

    // Setup blockchain event listeners
    this.setupEventListeners();

    console.log('✅ Webhook Service initialized');
  }

  /**
   * Load subscriptions from Redis
   */
  async loadSubscriptions() {
    if (!this.redis) return;

    const keys = await this.redis.keys('webhook:subscription:*');
    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        const sub = new WebhookSubscription(JSON.parse(data));
        this.subscriptions.set(sub.id, sub);
      }
    }
    
    console.log(`📋 Loaded ${this.subscriptions.size} webhook subscriptions`);
  }

  /**
   * Save subscription to Redis
   */
  async saveSubscription(subscription) {
    if (this.redis) {
      await this.redis.set(
        `webhook:subscription:${subscription.id}`,
        JSON.stringify(subscription)
      );
    }
    this.subscriptions.set(subscription.id, subscription);
  }

  /**
   * Delete subscription from Redis
   */
  async deleteSubscription(id) {
    if (this.redis) {
      await this.redis.del(`webhook:subscription:${id}`);
    }
    this.subscriptions.delete(id);
  }

  /**
   * Generate webhook signature
   */
  generateSignature(payload, secret, timestamp) {
    const signedPayload = `${timestamp}.${JSON.stringify(payload)}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');
    return `${CONFIG.signatureVersion}=${signature}`;
  }

  /**
   * Verify webhook signature
   */
  verifySignature(payload, signature, secret, timestamp) {
    const expectedSignature = this.generateSignature(payload, secret, timestamp);
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Deliver webhook to endpoint
   */
  async deliverWebhook(subscription, event) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = {
      id: event.id,
      type: event.type,
      data: event.data,
      metadata: event.metadata
    };

    const signature = this.generateSignature(payload, subscription.secret, timestamp);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONFIG.deliveryTimeout);

      const response = await fetch(subscription.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CONFIG.signatureHeader]: signature,
          [CONFIG.timestampHeader]: timestamp,
          'User-Agent': 'Synapse-Webhook/1.0'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeout);

      return {
        success: response.ok,
        status: response.status,
        body: await response.text().catch(() => null)
      };
    } catch (error) {
      return {
        success: false,
        status: 0,
        error: error.message
      };
    }
  }

  /**
   * Queue event for delivery
   */
  async queueEvent(event) {
    // Find matching subscriptions
    for (const [id, subscription] of this.subscriptions) {
      if (!subscription.enabled) continue;

      // Check if subscription listens to this event
      const matchesEvent = 
        subscription.events.includes('*') ||
        subscription.events.includes(event.type) ||
        subscription.events.some(e => event.type.startsWith(e.replace('.*', '')));

      if (!matchesEvent) continue;

      // Check filters
      if (subscription.filters.address) {
        const eventAddress = event.data.sender || event.data.recipient || event.data.agent;
        if (eventAddress?.toLowerCase() !== subscription.filters.address.toLowerCase()) {
          continue;
        }
      }

      // Create delivery attempt
      const attempt = new DeliveryAttempt(subscription.id, event);
      this.deliveryQueue.push({ subscription, event, attempt });

      // Store in Redis for persistence
      if (this.redis) {
        await this.redis.lpush('webhook:queue', JSON.stringify({
          subscriptionId: subscription.id,
          event,
          attempt
        }));
      }
    }
  }

  /**
   * Process delivery queue
   */
  async processDeliveryQueue() {
    if (this.processing || this.deliveryQueue.length === 0) return;

    this.processing = true;

    while (this.deliveryQueue.length > 0) {
      const { subscription, event, attempt } = this.deliveryQueue.shift();

      // Check rate limit
      const rateLimitKey = `webhook:ratelimit:${subscription.id}`;
      if (this.redis) {
        const count = await this.redis.incr(rateLimitKey);
        if (count === 1) {
          await this.redis.expire(rateLimitKey, 1);
        }
        if (count > CONFIG.maxEventsPerSecond) {
          // Re-queue with delay
          setTimeout(() => this.deliveryQueue.push({ subscription, event, attempt }), 1000);
          continue;
        }
      }

      // Attempt delivery
      const result = await this.deliverWebhook(subscription, event);

      // Update attempt
      attempt.responseStatus = result.status;
      attempt.responseBody = result.body;
      attempt.error = result.error;

      if (result.success) {
        attempt.status = 'delivered';
        attempt.completedAt = new Date();
        subscription.successfulDeliveries++;
        subscription.lastDeliveryStatus = 'success';
      } else {
        attempt.attempt++;
        
        if (attempt.attempt <= attempt.maxAttempts) {
          // Calculate retry delay with exponential backoff
          const delay = CONFIG.retryDelayMs * Math.pow(2, attempt.attempt - 1);
          attempt.nextRetryAt = new Date(Date.now() + delay);
          attempt.status = 'retrying';

          // Re-queue for retry
          setTimeout(() => {
            this.deliveryQueue.push({ subscription, event, attempt });
          }, delay);
        } else {
          attempt.status = 'failed';
          attempt.completedAt = new Date();
          subscription.failedDeliveries++;
          subscription.lastDeliveryStatus = 'failed';
        }
      }

      subscription.totalDeliveries++;
      subscription.lastDeliveryAt = new Date();

      // Save updated subscription
      await this.saveSubscription(subscription);

      // Store delivery log
      if (this.redis) {
        await this.redis.lpush(
          `webhook:deliveries:${subscription.id}`,
          JSON.stringify(attempt)
        );
        await this.redis.ltrim(`webhook:deliveries:${subscription.id}`, 0, 99);
      }
    }

    this.processing = false;
  }

  /**
   * Start delivery processor
   */
  startDeliveryProcessor() {
    setInterval(() => this.processDeliveryQueue(), 100);
  }

  /**
   * Setup blockchain event listeners
   */
  setupEventListeners() {
    // This would listen to actual contract events
    // For demo, we'll expose an endpoint to trigger events
    console.log('📡 Event listeners setup complete');
  }

  /**
   * Trigger an event (called from other services or contracts)
   */
  async triggerEvent(type, data, metadata = {}) {
    const event = new WebhookEvent(type, data, metadata);
    await this.queueEvent(event);
    return event;
  }

  /**
   * Setup Express routes
   */
  setupRoutes() {
    this.app.use(express.json());

    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        subscriptions: this.subscriptions.size,
        queueLength: this.deliveryQueue.length
      });
    });

    // Create webhook subscription
    this.app.post('/api/webhooks', async (req, res) => {
      try {
        const { userId, url, events, filters, metadata } = req.body;

        if (!userId || !url) {
          return res.status(400).json({ error: 'userId and url are required' });
        }

        // Validate URL
        try {
          new URL(url);
        } catch (e) {
          return res.status(400).json({ error: 'Invalid URL' });
        }

        // Check user's webhook count
        const userWebhooks = Array.from(this.subscriptions.values())
          .filter(s => s.userId === userId);
        
        if (userWebhooks.length >= CONFIG.maxWebhooksPerUser) {
          return res.status(400).json({ 
            error: `Maximum ${CONFIG.maxWebhooksPerUser} webhooks per user` 
          });
        }

        // Validate events
        if (events && events.length > 0) {
          const validEvents = Object.values(EventTypes);
          for (const event of events) {
            if (event !== '*' && !validEvents.includes(event) && !event.endsWith('.*')) {
              return res.status(400).json({ error: `Invalid event type: ${event}` });
            }
          }
        }

        const subscription = new WebhookSubscription({
          userId,
          url,
          events: events || ['*'],
          filters: filters || {},
          metadata: metadata || {}
        });

        await this.saveSubscription(subscription);

        res.status(201).json({
          id: subscription.id,
          url: subscription.url,
          secret: subscription.secret,
          events: subscription.events,
          enabled: subscription.enabled,
          createdAt: subscription.createdAt
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // List webhooks for user
    this.app.get('/api/webhooks', (req, res) => {
      const { userId } = req.query;

      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }

      const webhooks = Array.from(this.subscriptions.values())
        .filter(s => s.userId === userId)
        .map(s => ({
          id: s.id,
          url: s.url,
          events: s.events,
          enabled: s.enabled,
          totalDeliveries: s.totalDeliveries,
          successfulDeliveries: s.successfulDeliveries,
          failedDeliveries: s.failedDeliveries,
          lastDeliveryAt: s.lastDeliveryAt,
          lastDeliveryStatus: s.lastDeliveryStatus,
          createdAt: s.createdAt
        }));

      res.json({ webhooks });
    });

    // Get webhook details
    this.app.get('/api/webhooks/:id', (req, res) => {
      const subscription = this.subscriptions.get(req.params.id);

      if (!subscription) {
        return res.status(404).json({ error: 'Webhook not found' });
      }

      res.json({
        id: subscription.id,
        url: subscription.url,
        events: subscription.events,
        filters: subscription.filters,
        enabled: subscription.enabled,
        totalDeliveries: subscription.totalDeliveries,
        successfulDeliveries: subscription.successfulDeliveries,
        failedDeliveries: subscription.failedDeliveries,
        lastDeliveryAt: subscription.lastDeliveryAt,
        lastDeliveryStatus: subscription.lastDeliveryStatus,
        createdAt: subscription.createdAt,
        metadata: subscription.metadata
      });
    });

    // Update webhook
    this.app.put('/api/webhooks/:id', async (req, res) => {
      const subscription = this.subscriptions.get(req.params.id);

      if (!subscription) {
        return res.status(404).json({ error: 'Webhook not found' });
      }

      const { url, events, filters, enabled, metadata } = req.body;

      if (url) {
        try {
          new URL(url);
          subscription.url = url;
        } catch (e) {
          return res.status(400).json({ error: 'Invalid URL' });
        }
      }

      if (events) subscription.events = events;
      if (filters) subscription.filters = filters;
      if (enabled !== undefined) subscription.enabled = enabled;
      if (metadata) subscription.metadata = { ...subscription.metadata, ...metadata };

      await this.saveSubscription(subscription);

      res.json({
        id: subscription.id,
        url: subscription.url,
        events: subscription.events,
        enabled: subscription.enabled
      });
    });

    // Delete webhook
    this.app.delete('/api/webhooks/:id', async (req, res) => {
      const subscription = this.subscriptions.get(req.params.id);

      if (!subscription) {
        return res.status(404).json({ error: 'Webhook not found' });
      }

      await this.deleteSubscription(req.params.id);

      res.json({ deleted: true });
    });

    // Rotate webhook secret
    this.app.post('/api/webhooks/:id/rotate-secret', async (req, res) => {
      const subscription = this.subscriptions.get(req.params.id);

      if (!subscription) {
        return res.status(404).json({ error: 'Webhook not found' });
      }

      subscription.secret = crypto.randomBytes(32).toString('hex');
      await this.saveSubscription(subscription);

      res.json({
        id: subscription.id,
        secret: subscription.secret
      });
    });

    // Get delivery history
    this.app.get('/api/webhooks/:id/deliveries', async (req, res) => {
      const subscription = this.subscriptions.get(req.params.id);

      if (!subscription) {
        return res.status(404).json({ error: 'Webhook not found' });
      }

      let deliveries = [];
      if (this.redis) {
        const data = await this.redis.lrange(
          `webhook:deliveries:${subscription.id}`,
          0,
          49
        );
        deliveries = data.map(d => JSON.parse(d));
      }

      res.json({ deliveries });
    });

    // Test webhook (send test event)
    this.app.post('/api/webhooks/:id/test', async (req, res) => {
      const subscription = this.subscriptions.get(req.params.id);

      if (!subscription) {
        return res.status(404).json({ error: 'Webhook not found' });
      }

      const testEvent = new WebhookEvent('test.webhook', {
        message: 'This is a test webhook event',
        timestamp: new Date().toISOString()
      });

      const result = await this.deliverWebhook(subscription, testEvent);

      res.json({
        eventId: testEvent.id,
        delivered: result.success,
        status: result.status,
        error: result.error
      });
    });

    // List available event types
    this.app.get('/api/event-types', (req, res) => {
      res.json({
        eventTypes: Object.entries(EventTypes).map(([key, value]) => ({
          name: key,
          type: value
        }))
      });
    });

    // Trigger event (internal API)
    this.app.post('/api/internal/trigger', async (req, res) => {
      // This should be protected in production
      const { type, data, metadata } = req.body;

      if (!type || !data) {
        return res.status(400).json({ error: 'type and data are required' });
      }

      const event = await this.triggerEvent(type, data, metadata);

      res.json({
        eventId: event.id,
        type: event.type,
        queued: true
      });
    });

    // Webhook verification endpoint (for external services to verify)
    this.app.post('/api/verify-signature', (req, res) => {
      const { payload, signature, timestamp } = req.body;
      const { webhookId } = req.query;

      const subscription = this.subscriptions.get(webhookId);
      if (!subscription) {
        return res.status(404).json({ error: 'Webhook not found' });
      }

      const valid = this.verifySignature(payload, signature, subscription.secret, timestamp);

      res.json({ valid });
    });
  }

  /**
   * Start server
   */
  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n🔔 Webhook Service running on port ${CONFIG.port}`);
      console.log('\n📡 Endpoints:');
      console.log('   POST   /api/webhooks              - Create webhook');
      console.log('   GET    /api/webhooks              - List webhooks');
      console.log('   GET    /api/webhooks/:id          - Get webhook');
      console.log('   PUT    /api/webhooks/:id          - Update webhook');
      console.log('   DELETE /api/webhooks/:id          - Delete webhook');
      console.log('   POST   /api/webhooks/:id/rotate-secret - Rotate secret');
      console.log('   GET    /api/webhooks/:id/deliveries    - Delivery history');
      console.log('   POST   /api/webhooks/:id/test     - Test webhook');
      console.log('   GET    /api/event-types           - List event types\n');
    });
  }
}

// Main entry point
async function main() {
  const service = new WebhookService();
  await service.initialize();
  service.start();
}

main().catch(console.error);

module.exports = { WebhookService, EventTypes, WebhookSubscription };
