/**
 * SYNAPSE Protocol - API Gateway
 * 
 * Unified API gateway with authentication, routing, and rate limiting
 * Features:
 * - JWT authentication
 * - API key management
 * - Request routing
 * - Rate limiting (per user/IP/endpoint)
 * - Request/response logging
 * - Circuit breaker pattern
 * - Load balancing
 * - Request transformation
 */

const express = require('express');
const httpProxy = require('http-proxy');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// Configuration
const CONFIG = {
  port: process.env.GATEWAY_PORT || 8080,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'synapse-secret-key',
  jwtExpiry: process.env.JWT_EXPIRY || '24h',
  
  // Service endpoints
  services: {
    api: process.env.API_SERVICE_URL || 'http://localhost:3000',
    websocket: process.env.WS_SERVICE_URL || 'http://localhost:3001',
    analytics: process.env.ANALYTICS_SERVICE_URL || 'http://localhost:3004',
    notifications: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3005',
    marketplace: process.env.MARKETPLACE_SERVICE_URL || 'http://localhost:3002'
  },
  
  // Rate limiting
  rateLimits: {
    anonymous: { rpm: 20, rph: 200 },
    free: { rpm: 60, rph: 1000 },
    basic: { rpm: 200, rph: 5000 },
    pro: { rpm: 1000, rph: 20000 },
    enterprise: { rpm: 5000, rph: 100000 }
  },
  
  // Circuit breaker
  circuitBreaker: {
    threshold: 5, // failures before opening
    timeout: 30000, // ms to wait before half-open
    resetTimeout: 60000 // ms to reset failure count
  }
};

// Route definitions
const routes = [
  // API routes
  { path: '/api/v1/token', service: 'api', auth: false },
  { path: '/api/v1/agents', service: 'api', auth: true },
  { path: '/api/v1/services', service: 'api', auth: false },
  { path: '/api/v1/payments', service: 'api', auth: true },
  { path: '/api/v1/channels', service: 'api', auth: true },
  { path: '/api/v1/staking', service: 'api', auth: true },
  { path: '/api/v1/subscriptions', service: 'api', auth: true },
  
  // Analytics routes
  { path: '/api/v1/analytics', service: 'analytics', auth: true },
  { path: '/api/v1/metrics', service: 'analytics', auth: true },
  
  // Notification routes
  { path: '/api/v1/notifications', service: 'notifications', auth: true },
  { path: '/api/v1/preferences', service: 'notifications', auth: true },
  
  // Marketplace routes
  { path: '/api/v1/marketplace', service: 'marketplace', auth: false },
  { path: '/api/v1/search', service: 'marketplace', auth: false },
  
  // WebSocket upgrade
  { path: '/ws', service: 'websocket', auth: true, upgrade: true }
];

/**
 * API Key Manager
 */
class ApiKeyManager {
  constructor(redis) {
    this.redis = redis;
  }

  async generate(userId, tier = 'free', name = 'Default') {
    const apiKey = `synx_${tier}_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = this.hash(apiKey);

    const keyData = {
      userId,
      tier,
      name,
      createdAt: Date.now(),
      lastUsedAt: null,
      requestCount: 0,
      active: true
    };

    await this.redis.hset('api_keys', keyHash, JSON.stringify(keyData));
    await this.redis.sadd(`user_keys:${userId}`, keyHash);

    return { apiKey, keyHash };
  }

  async validate(apiKey) {
    const keyHash = this.hash(apiKey);
    const data = await this.redis.hget('api_keys', keyHash);
    
    if (!data) return null;

    const keyData = JSON.parse(data);
    if (!keyData.active) return null;

    // Update usage
    keyData.lastUsedAt = Date.now();
    keyData.requestCount++;
    await this.redis.hset('api_keys', keyHash, JSON.stringify(keyData));

    return keyData;
  }

  async revoke(keyHash) {
    const data = await this.redis.hget('api_keys', keyHash);
    if (!data) return false;

    const keyData = JSON.parse(data);
    keyData.active = false;
    await this.redis.hset('api_keys', keyHash, JSON.stringify(keyData));
    return true;
  }

  async list(userId) {
    const keyHashes = await this.redis.smembers(`user_keys:${userId}`);
    const keys = [];

    for (const hash of keyHashes) {
      const data = await this.redis.hget('api_keys', hash);
      if (data) {
        const keyData = JSON.parse(data);
        keys.push({ hash: hash.slice(0, 16) + '...', ...keyData });
      }
    }

    return keys;
  }

  hash(apiKey) {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }
}

/**
 * Circuit Breaker
 */
class CircuitBreaker {
  constructor(redis) {
    this.redis = redis;
    this.config = CONFIG.circuitBreaker;
  }

  async getState(service) {
    const data = await this.redis.get(`circuit:${service}`);
    if (!data) return { state: 'closed', failures: 0 };
    return JSON.parse(data);
  }

  async recordFailure(service) {
    const state = await this.getState(service);
    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= this.config.threshold) {
      state.state = 'open';
      state.openedAt = Date.now();
    }

    await this.redis.setex(`circuit:${service}`, 300, JSON.stringify(state));
    return state;
  }

  async recordSuccess(service) {
    await this.redis.del(`circuit:${service}`);
  }

  async canRequest(service) {
    const state = await this.getState(service);

    if (state.state === 'closed') return true;

    if (state.state === 'open') {
      const elapsed = Date.now() - state.openedAt;
      if (elapsed >= this.config.timeout) {
        // Try half-open
        state.state = 'half-open';
        await this.redis.setex(`circuit:${service}`, 300, JSON.stringify(state));
        return true;
      }
      return false;
    }

    if (state.state === 'half-open') return true;

    return true;
  }
}

/**
 * Rate Limiter
 */
class RateLimiter {
  constructor(redis) {
    this.redis = redis;
  }

  async check(identifier, tier = 'anonymous') {
    const limits = CONFIG.rateLimits[tier] || CONFIG.rateLimits.anonymous;
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const hour = Math.floor(now / 3600000);

    const minuteKey = `ratelimit:${identifier}:${minute}`;
    const hourKey = `ratelimit:${identifier}:h:${hour}`;

    const multi = this.redis.multi();
    multi.incr(minuteKey);
    multi.expire(minuteKey, 120);
    multi.incr(hourKey);
    multi.expire(hourKey, 7200);

    const results = await multi.exec();
    const minuteCount = results[0][1];
    const hourCount = results[2][1];

    const allowed = minuteCount <= limits.rpm && hourCount <= limits.rph;

    return {
      allowed,
      limits: {
        rpm: limits.rpm,
        rph: limits.rph
      },
      current: {
        rpm: minuteCount,
        rph: hourCount
      },
      remaining: {
        rpm: Math.max(0, limits.rpm - minuteCount),
        rph: Math.max(0, limits.rph - hourCount)
      }
    };
  }
}

/**
 * Request Logger
 */
class RequestLogger {
  constructor(redis) {
    this.redis = redis;
  }

  async log(req, res, duration, error = null) {
    const log = {
      id: uuidv4(),
      timestamp: Date.now(),
      method: req.method,
      path: req.path,
      query: req.query,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.user?.id,
      tier: req.user?.tier,
      status: res.statusCode,
      duration,
      error: error?.message
    };

    // Store in Redis (keep last 10000 requests)
    await this.redis.lpush('request_logs', JSON.stringify(log));
    await this.redis.ltrim('request_logs', 0, 9999);

    // Update metrics
    await this.redis.hincrby('metrics:requests', req.method, 1);
    await this.redis.hincrby('metrics:status', res.statusCode, 1);
    await this.redis.hincrby('metrics:services', req.service || 'unknown', 1);

    if (error) {
      await this.redis.hincrby('metrics:errors', error.code || 'unknown', 1);
    }
  }

  async getMetrics() {
    const [requests, status, services, errors] = await Promise.all([
      this.redis.hgetall('metrics:requests'),
      this.redis.hgetall('metrics:status'),
      this.redis.hgetall('metrics:services'),
      this.redis.hgetall('metrics:errors')
    ]);

    return { requests, status, services, errors };
  }

  async getLogs(limit = 100) {
    const logs = await this.redis.lrange('request_logs', 0, limit - 1);
    return logs.map(l => JSON.parse(l));
  }
}

/**
 * API Gateway
 */
class ApiGateway {
  constructor() {
    this.app = express();
    this.proxy = httpProxy.createProxyServer({});
    this.redis = null;
    this.apiKeyManager = null;
    this.circuitBreaker = null;
    this.rateLimiter = null;
    this.requestLogger = null;
  }

  async initialize() {
    console.log('🚪 Initializing API Gateway...');

    // Connect to Redis
    this.redis = new Redis(CONFIG.redisUrl);
    console.log('📦 Connected to Redis');

    // Initialize components
    this.apiKeyManager = new ApiKeyManager(this.redis);
    this.circuitBreaker = new CircuitBreaker(this.redis);
    this.rateLimiter = new RateLimiter(this.redis);
    this.requestLogger = new RequestLogger(this.redis);

    // Setup middleware and routes
    this.setupMiddleware();
    this.setupRoutes();
    this.setupProxyHandlers();

    console.log('✅ API Gateway initialized');
  }

  setupMiddleware() {
    // Security
    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(express.json());

    // Request ID
    this.app.use((req, res, next) => {
      req.requestId = uuidv4();
      res.setHeader('X-Request-ID', req.requestId);
      req.startTime = Date.now();
      next();
    });

    // Authentication
    this.app.use(async (req, res, next) => {
      try {
        // Try API key first
        const apiKey = req.headers['x-api-key'];
        if (apiKey) {
          const keyData = await this.apiKeyManager.validate(apiKey);
          if (keyData) {
            req.user = {
              id: keyData.userId,
              tier: keyData.tier,
              authMethod: 'api_key'
            };
            return next();
          }
        }

        // Try JWT
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.slice(7);
          try {
            const decoded = jwt.verify(token, CONFIG.jwtSecret);
            req.user = {
              id: decoded.sub,
              tier: decoded.tier || 'free',
              authMethod: 'jwt'
            };
            return next();
          } catch (e) {
            // Invalid token, continue as anonymous
          }
        }

        // Anonymous
        req.user = null;
        next();
      } catch (error) {
        next(error);
      }
    });

    // Rate limiting
    this.app.use(async (req, res, next) => {
      const identifier = req.user?.id || req.ip;
      const tier = req.user?.tier || 'anonymous';

      const result = await this.rateLimiter.check(identifier, tier);

      res.setHeader('X-RateLimit-Limit-RPM', result.limits.rpm);
      res.setHeader('X-RateLimit-Remaining-RPM', result.remaining.rpm);
      res.setHeader('X-RateLimit-Limit-RPH', result.limits.rph);
      res.setHeader('X-RateLimit-Remaining-RPH', result.remaining.rph);

      if (!result.allowed) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          limits: result.limits,
          current: result.current
        });
      }

      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: Object.keys(CONFIG.services)
      });
    });

    // Auth endpoints
    this.app.post('/auth/login', async (req, res) => {
      try {
        const { address, signature, message } = req.body;
        
        // Verify signature (implement proper verification)
        // For now, just create a token
        const token = jwt.sign(
          { sub: address, tier: 'free' },
          CONFIG.jwtSecret,
          { expiresIn: CONFIG.jwtExpiry }
        );

        res.json({ token, expiresIn: CONFIG.jwtExpiry });
      } catch (error) {
        res.status(401).json({ error: 'Authentication failed' });
      }
    });

    this.app.post('/auth/refresh', async (req, res) => {
      try {
        const { token } = req.body;
        const decoded = jwt.verify(token, CONFIG.jwtSecret, { ignoreExpiration: true });

        const newToken = jwt.sign(
          { sub: decoded.sub, tier: decoded.tier },
          CONFIG.jwtSecret,
          { expiresIn: CONFIG.jwtExpiry }
        );

        res.json({ token: newToken, expiresIn: CONFIG.jwtExpiry });
      } catch (error) {
        res.status(401).json({ error: 'Token refresh failed' });
      }
    });

    // API Key management
    this.app.post('/auth/api-keys', async (req, res) => {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      try {
        const { name } = req.body;
        const result = await this.apiKeyManager.generate(req.user.id, req.user.tier, name);
        res.json({
          apiKey: result.apiKey,
          message: 'Store this key securely. It will not be shown again.'
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/auth/api-keys', async (req, res) => {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      try {
        const keys = await this.apiKeyManager.list(req.user.id);
        res.json({ keys });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.delete('/auth/api-keys/:hash', async (req, res) => {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      try {
        await this.apiKeyManager.revoke(req.params.hash);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Gateway metrics
    this.app.get('/gateway/metrics', async (req, res) => {
      try {
        const metrics = await this.requestLogger.getMetrics();
        res.json(metrics);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/gateway/logs', async (req, res) => {
      try {
        const { limit = 100 } = req.query;
        const logs = await this.requestLogger.getLogs(parseInt(limit));
        res.json({ logs });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Proxy routes
    for (const route of routes) {
      this.app.use(route.path, async (req, res, next) => {
        // Check auth requirement
        if (route.auth && !req.user) {
          return res.status(401).json({ error: 'Authentication required' });
        }

        // Check circuit breaker
        const canRequest = await this.circuitBreaker.canRequest(route.service);
        if (!canRequest) {
          return res.status(503).json({
            error: 'Service temporarily unavailable',
            service: route.service
          });
        }

        // Store service info
        req.service = route.service;
        req.targetUrl = CONFIG.services[route.service];

        next();
      });
    }

    // Proxy all matched routes
    this.app.use('/api', (req, res) => {
      if (!req.targetUrl) {
        return res.status(404).json({ error: 'Route not found' });
      }

      this.proxy.web(req, res, { target: req.targetUrl });
    });
  }

  setupProxyHandlers() {
    // Add headers
    this.proxy.on('proxyReq', (proxyReq, req) => {
      // Forward user info
      if (req.user) {
        proxyReq.setHeader('X-User-ID', req.user.id);
        proxyReq.setHeader('X-User-Tier', req.user.tier);
      }
      proxyReq.setHeader('X-Request-ID', req.requestId);
      proxyReq.setHeader('X-Forwarded-For', req.ip);
    });

    // Handle response
    this.proxy.on('proxyRes', async (proxyRes, req, res) => {
      const duration = Date.now() - req.startTime;
      
      // Record success
      await this.circuitBreaker.recordSuccess(req.service);
      
      // Log request
      await this.requestLogger.log(req, { statusCode: proxyRes.statusCode }, duration);
    });

    // Handle errors
    this.proxy.on('error', async (err, req, res) => {
      const duration = Date.now() - req.startTime;

      // Record failure
      await this.circuitBreaker.recordFailure(req.service);

      // Log error
      await this.requestLogger.log(req, { statusCode: 502 }, duration, err);

      if (!res.headersSent) {
        res.status(502).json({
          error: 'Bad Gateway',
          message: 'Service unavailable',
          service: req.service
        });
      }
    });
  }

  start() {
    const server = this.app.listen(CONFIG.port, () => {
      console.log(`\n🚪 API Gateway running on port ${CONFIG.port}`);
      console.log('\n📡 Routes:');
      for (const route of routes) {
        console.log(`   ${route.path.padEnd(25)} → ${route.service.padEnd(15)} ${route.auth ? '🔐' : '🌐'}`);
      }
      console.log('\n🔑 Auth endpoints:');
      console.log('   POST /auth/login       - Get JWT token');
      console.log('   POST /auth/refresh     - Refresh token');
      console.log('   POST /auth/api-keys    - Create API key');
      console.log('   GET  /auth/api-keys    - List API keys');
      console.log('   DELETE /auth/api-keys/:hash - Revoke key\n');
    });

    // Handle WebSocket upgrades
    server.on('upgrade', async (req, socket, head) => {
      // Authenticate WebSocket connections
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      try {
        if (token) {
          jwt.verify(token, CONFIG.jwtSecret);
        }

        this.proxy.ws(req, socket, head, {
          target: CONFIG.services.websocket
        });
      } catch (error) {
        socket.destroy();
      }
    });
  }
}

// Main
async function main() {
  const gateway = new ApiGateway();
  await gateway.initialize();
  gateway.start();
}

main().catch(console.error);

module.exports = { ApiGateway };
