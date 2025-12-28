/**
 * SYNAPSE Protocol - Rate Limiter Service
 * 
 * Distributed rate limiting for API and service protection
 * Features:
 * - Token bucket algorithm
 * - Sliding window counters
 * - Per-user and per-IP limits
 * - Tier-based rate limits
 * - Redis-backed for distributed deployments
 */

const express = require('express');
const Redis = require('ioredis');
const crypto = require('crypto');

// Configuration
const CONFIG = {
  port: process.env.RATE_LIMITER_PORT || 3004,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  
  // Default limits (requests per window)
  defaults: {
    anonymous: { requests: 100, windowSeconds: 60 },
    authenticated: { requests: 500, windowSeconds: 60 },
    premium: { requests: 2000, windowSeconds: 60 }
  },
  
  // Tier multipliers
  tierMultipliers: {
    0: 1.0,   // Unverified
    1: 1.2,   // Bronze
    2: 1.5,   // Silver
    3: 2.0,   // Gold
    4: 3.0,   // Platinum
    5: 5.0    // Diamond
  },
  
  // Burst allowance (percentage of limit)
  burstAllowance: 0.2,
  
  // Cleanup interval
  cleanupInterval: 60000, // 1 minute
  
  // Ban settings
  banThreshold: 10, // violations before ban
  banDuration: 3600 // 1 hour ban
};

// Rate limit algorithms
const Algorithms = {
  TOKEN_BUCKET: 'token_bucket',
  SLIDING_WINDOW: 'sliding_window',
  FIXED_WINDOW: 'fixed_window',
  LEAKY_BUCKET: 'leaky_bucket'
};

/**
 * Rate Limiter Service
 */
class RateLimiterService {
  constructor() {
    this.app = express();
    this.redis = null;
    this.localCache = new Map();
    this.violationCounts = new Map();
  }

  /**
   * Initialize service
   */
  async initialize() {
    console.log('⏱️ Initializing Rate Limiter Service...');

    // Connect to Redis
    try {
      this.redis = new Redis(CONFIG.redisUrl);
      console.log('📦 Connected to Redis');
    } catch (e) {
      console.log('⚠️ Redis not available, using local cache');
    }

    // Setup routes
    this.setupRoutes();

    // Start cleanup job
    this.startCleanupJob();

    console.log('✅ Rate Limiter Service initialized');
  }

  /**
   * Generate rate limit key
   */
  generateKey(identifier, endpoint = 'global') {
    const hash = crypto.createHash('sha256')
      .update(`${identifier}:${endpoint}`)
      .digest('hex')
      .slice(0, 16);
    return `ratelimit:${hash}`;
  }

  /**
   * Token Bucket Algorithm
   */
  async tokenBucket(key, maxTokens, refillRate, tokensNeeded = 1) {
    const now = Date.now();
    const bucketKey = `${key}:bucket`;

    if (this.redis) {
      // Lua script for atomic token bucket
      const script = `
        local key = KEYS[1]
        local max_tokens = tonumber(ARGV[1])
        local refill_rate = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local tokens_needed = tonumber(ARGV[4])
        
        local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
        local tokens = tonumber(bucket[1]) or max_tokens
        local last_refill = tonumber(bucket[2]) or now
        
        -- Refill tokens
        local elapsed = (now - last_refill) / 1000
        local new_tokens = math.min(max_tokens, tokens + (elapsed * refill_rate))
        
        -- Check if we have enough tokens
        if new_tokens >= tokens_needed then
          new_tokens = new_tokens - tokens_needed
          redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
          redis.call('EXPIRE', key, 3600)
          return {1, new_tokens, max_tokens}
        else
          redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
          redis.call('EXPIRE', key, 3600)
          return {0, new_tokens, max_tokens}
        end
      `;

      const result = await this.redis.eval(
        script,
        1,
        bucketKey,
        maxTokens,
        refillRate,
        now,
        tokensNeeded
      );

      return {
        allowed: result[0] === 1,
        remaining: Math.floor(result[1]),
        limit: maxTokens,
        resetIn: Math.ceil((maxTokens - result[1]) / refillRate * 1000)
      };
    }

    // Local fallback
    let bucket = this.localCache.get(bucketKey) || {
      tokens: maxTokens,
      lastRefill: now
    };

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= tokensNeeded) {
      bucket.tokens -= tokensNeeded;
      this.localCache.set(bucketKey, bucket);
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        limit: maxTokens,
        resetIn: 0
      };
    }

    this.localCache.set(bucketKey, bucket);
    return {
      allowed: false,
      remaining: Math.floor(bucket.tokens),
      limit: maxTokens,
      resetIn: Math.ceil((tokensNeeded - bucket.tokens) / refillRate * 1000)
    };
  }

  /**
   * Sliding Window Algorithm
   */
  async slidingWindow(key, maxRequests, windowSeconds) {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;
    const windowKey = `${key}:sliding`;

    if (this.redis) {
      // Remove old entries and count current
      await this.redis.zremrangebyscore(windowKey, 0, windowStart);
      const count = await this.redis.zcard(windowKey);

      if (count < maxRequests) {
        await this.redis.zadd(windowKey, now, `${now}:${Math.random()}`);
        await this.redis.expire(windowKey, windowSeconds + 1);
        
        return {
          allowed: true,
          remaining: maxRequests - count - 1,
          limit: maxRequests,
          resetIn: windowSeconds * 1000
        };
      }

      // Get oldest entry to calculate reset time
      const oldest = await this.redis.zrange(windowKey, 0, 0, 'WITHSCORES');
      const resetIn = oldest.length ? parseInt(oldest[1]) + windowSeconds * 1000 - now : 0;

      return {
        allowed: false,
        remaining: 0,
        limit: maxRequests,
        resetIn: Math.max(0, resetIn)
      };
    }

    // Local fallback
    let window = this.localCache.get(windowKey) || [];
    window = window.filter(ts => ts > windowStart);

    if (window.length < maxRequests) {
      window.push(now);
      this.localCache.set(windowKey, window);
      return {
        allowed: true,
        remaining: maxRequests - window.length,
        limit: maxRequests,
        resetIn: windowSeconds * 1000
      };
    }

    this.localCache.set(windowKey, window);
    return {
      allowed: false,
      remaining: 0,
      limit: maxRequests,
      resetIn: Math.max(0, window[0] + windowSeconds * 1000 - now)
    };
  }

  /**
   * Fixed Window Algorithm
   */
  async fixedWindow(key, maxRequests, windowSeconds) {
    const now = Date.now();
    const windowId = Math.floor(now / (windowSeconds * 1000));
    const windowKey = `${key}:fixed:${windowId}`;

    if (this.redis) {
      const count = await this.redis.incr(windowKey);
      
      if (count === 1) {
        await this.redis.expire(windowKey, windowSeconds);
      }

      const windowEnd = (windowId + 1) * windowSeconds * 1000;

      return {
        allowed: count <= maxRequests,
        remaining: Math.max(0, maxRequests - count),
        limit: maxRequests,
        resetIn: windowEnd - now
      };
    }

    // Local fallback
    let count = this.localCache.get(windowKey) || 0;
    count++;
    this.localCache.set(windowKey, count);

    const windowEnd = (windowId + 1) * windowSeconds * 1000;

    return {
      allowed: count <= maxRequests,
      remaining: Math.max(0, maxRequests - count),
      limit: maxRequests,
      resetIn: windowEnd - now
    };
  }

  /**
   * Check rate limit
   */
  async checkLimit(params) {
    const {
      identifier,
      endpoint = 'global',
      tier = 0,
      algorithm = Algorithms.SLIDING_WINDOW,
      customLimit
    } = params;

    // Check if banned
    const banKey = `ban:${identifier}`;
    if (this.redis) {
      const banned = await this.redis.get(banKey);
      if (banned) {
        const ttl = await this.redis.ttl(banKey);
        return {
          allowed: false,
          banned: true,
          remaining: 0,
          limit: 0,
          resetIn: ttl * 1000,
          message: 'Temporarily banned due to rate limit violations'
        };
      }
    }

    // Calculate limit based on tier
    const baseLimit = customLimit || CONFIG.defaults.authenticated;
    const multiplier = CONFIG.tierMultipliers[tier] || 1.0;
    const limit = Math.floor(baseLimit.requests * multiplier);
    const windowSeconds = baseLimit.windowSeconds;

    const key = this.generateKey(identifier, endpoint);

    let result;
    switch (algorithm) {
      case Algorithms.TOKEN_BUCKET:
        const refillRate = limit / windowSeconds;
        result = await this.tokenBucket(key, limit, refillRate);
        break;
      case Algorithms.FIXED_WINDOW:
        result = await this.fixedWindow(key, limit, windowSeconds);
        break;
      case Algorithms.SLIDING_WINDOW:
      default:
        result = await this.slidingWindow(key, limit, windowSeconds);
    }

    // Track violations
    if (!result.allowed) {
      await this.trackViolation(identifier);
    }

    return {
      ...result,
      banned: false,
      tier,
      algorithm
    };
  }

  /**
   * Track rate limit violations
   */
  async trackViolation(identifier) {
    const violationKey = `violations:${identifier}`;

    if (this.redis) {
      const count = await this.redis.incr(violationKey);
      await this.redis.expire(violationKey, CONFIG.banDuration);

      if (count >= CONFIG.banThreshold) {
        await this.redis.setex(
          `ban:${identifier}`,
          CONFIG.banDuration,
          'rate_limit_exceeded'
        );
        await this.redis.del(violationKey);
      }
    } else {
      let count = this.violationCounts.get(identifier) || 0;
      count++;
      this.violationCounts.set(identifier, count);

      if (count >= CONFIG.banThreshold) {
        // Local ban (limited functionality)
        this.localCache.set(`ban:${identifier}`, Date.now() + CONFIG.banDuration * 1000);
        this.violationCounts.delete(identifier);
      }
    }
  }

  /**
   * Reset limit for identifier
   */
  async resetLimit(identifier, endpoint = 'global') {
    const key = this.generateKey(identifier, endpoint);

    if (this.redis) {
      await this.redis.del(`${key}:bucket`);
      await this.redis.del(`${key}:sliding`);
      
      // Clear all fixed window keys
      const pattern = `${key}:fixed:*`;
      const keys = await this.redis.keys(pattern);
      if (keys.length) {
        await this.redis.del(...keys);
      }
    } else {
      // Clear local cache
      for (const [k] of this.localCache) {
        if (k.startsWith(key)) {
          this.localCache.delete(k);
        }
      }
    }
  }

  /**
   * Unban identifier
   */
  async unban(identifier) {
    if (this.redis) {
      await this.redis.del(`ban:${identifier}`);
      await this.redis.del(`violations:${identifier}`);
    } else {
      this.localCache.delete(`ban:${identifier}`);
      this.violationCounts.delete(identifier);
    }
  }

  /**
   * Get rate limit status
   */
  async getStatus(identifier, endpoint = 'global') {
    const key = this.generateKey(identifier, endpoint);

    if (this.redis) {
      const [bucket, sliding, banned] = await Promise.all([
        this.redis.hgetall(`${key}:bucket`),
        this.redis.zcard(`${key}:sliding`),
        this.redis.get(`ban:${identifier}`)
      ]);

      return {
        identifier,
        endpoint,
        bucket: bucket.tokens ? parseFloat(bucket.tokens) : null,
        slidingCount: sliding,
        banned: !!banned,
        banTTL: banned ? await this.redis.ttl(`ban:${identifier}`) : 0
      };
    }

    return {
      identifier,
      endpoint,
      bucket: null,
      slidingCount: 0,
      banned: false,
      banTTL: 0
    };
  }

  /**
   * Start cleanup job
   */
  startCleanupJob() {
    setInterval(() => {
      // Clean local cache
      const now = Date.now();
      for (const [key, value] of this.localCache) {
        // Clean old sliding windows
        if (Array.isArray(value)) {
          const filtered = value.filter(ts => ts > now - 300000); // 5 min
          if (filtered.length === 0) {
            this.localCache.delete(key);
          } else {
            this.localCache.set(key, filtered);
          }
        }
        // Clean expired bans
        if (key.startsWith('ban:') && value < now) {
          this.localCache.delete(key);
        }
      }
    }, CONFIG.cleanupInterval);
  }

  /**
   * Express middleware factory
   */
  middleware(options = {}) {
    return async (req, res, next) => {
      const identifier = options.getIdentifier?.(req) || 
        req.headers['x-api-key'] ||
        req.headers['x-user-id'] ||
        req.ip;

      const tier = options.getTier?.(req) || 0;
      const endpoint = options.perEndpoint ? req.path : 'global';

      const result = await this.checkLimit({
        identifier,
        endpoint,
        tier,
        algorithm: options.algorithm,
        customLimit: options.limit
      });

      // Set headers
      res.set('X-RateLimit-Limit', result.limit);
      res.set('X-RateLimit-Remaining', result.remaining);
      res.set('X-RateLimit-Reset', Math.ceil((Date.now() + result.resetIn) / 1000));

      if (!result.allowed) {
        res.set('Retry-After', Math.ceil(result.resetIn / 1000));
        
        return res.status(429).json({
          error: 'Too Many Requests',
          message: result.banned 
            ? result.message 
            : 'Rate limit exceeded. Please try again later.',
          retryAfter: Math.ceil(result.resetIn / 1000),
          limit: result.limit,
          remaining: 0
        });
      }

      next();
    };
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    this.app.use(express.json());

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        redis: !!this.redis,
        cacheSize: this.localCache.size
      });
    });

    // Check rate limit
    this.app.post('/api/check', async (req, res) => {
      try {
        const result = await this.checkLimit(req.body);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get status
    this.app.get('/api/status/:identifier', async (req, res) => {
      try {
        const { identifier } = req.params;
        const { endpoint } = req.query;
        const status = await this.getStatus(identifier, endpoint);
        res.json(status);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Reset limit
    this.app.post('/api/reset', async (req, res) => {
      try {
        const { identifier, endpoint } = req.body;
        await this.resetLimit(identifier, endpoint);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Unban
    this.app.post('/api/unban', async (req, res) => {
      try {
        const { identifier } = req.body;
        await this.unban(identifier);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get configuration
    this.app.get('/api/config', (req, res) => {
      res.json({
        defaults: CONFIG.defaults,
        tierMultipliers: CONFIG.tierMultipliers,
        algorithms: Object.values(Algorithms),
        banThreshold: CONFIG.banThreshold,
        banDuration: CONFIG.banDuration
      });
    });

    // Update limits (admin)
    this.app.put('/api/config/limits', (req, res) => {
      const { tier, requests, windowSeconds } = req.body;
      
      if (tier && CONFIG.defaults[tier]) {
        if (requests) CONFIG.defaults[tier].requests = requests;
        if (windowSeconds) CONFIG.defaults[tier].windowSeconds = windowSeconds;
      }
      
      res.json({ success: true, config: CONFIG.defaults });
    });
  }

  /**
   * Start server
   */
  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n⏱️ Rate Limiter Service running on port ${CONFIG.port}`);
      console.log('\n📡 Endpoints:');
      console.log('   POST /api/check           - Check rate limit');
      console.log('   GET  /api/status/:id      - Get status');
      console.log('   POST /api/reset           - Reset limit');
      console.log('   POST /api/unban           - Unban identifier');
      console.log('   GET  /api/config          - Get configuration');
      console.log('   PUT  /api/config/limits   - Update limits\n');
    });
  }
}

// Export for use as middleware
module.exports = { RateLimiterService, Algorithms, CONFIG };

// Main entry point
if (require.main === module) {
  const service = new RateLimiterService();
  service.initialize().then(() => service.start());
}
