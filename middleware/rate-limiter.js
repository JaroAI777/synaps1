/**
 * SYNAPSE Protocol - Advanced Rate Limiting Middleware
 * 
 * Configurable rate limiting with multiple algorithms
 * Features:
 * - Token bucket algorithm
 * - Sliding window
 * - Per-user/IP/endpoint limits
 * - Quota management
 * - Rate limit headers
 */

const Redis = require('ioredis');

// Configuration
const DEFAULT_CONFIG = {
  // Token bucket defaults
  tokenBucket: {
    capacity: 100,      // Max tokens
    refillRate: 10,     // Tokens per second
    refillInterval: 1   // Seconds
  },
  
  // Sliding window defaults
  slidingWindow: {
    windowSize: 60,     // Seconds
    maxRequests: 60     // Requests per window
  },
  
  // Tier limits
  tiers: {
    anonymous: { rpm: 20, rph: 200, rpd: 1000 },
    free: { rpm: 60, rph: 1000, rpd: 10000 },
    basic: { rpm: 200, rph: 5000, rpd: 50000 },
    pro: { rpm: 1000, rph: 20000, rpd: 200000 },
    enterprise: { rpm: 5000, rph: 100000, rpd: 1000000 }
  },
  
  // Endpoint-specific limits
  endpoints: {
    '/api/v1/payments/pay': { rpm: 30 },
    '/api/v1/payments/batch': { rpm: 5 },
    '/api/v1/bridge/initiate': { rpm: 10 },
    '/api/v1/staking/stake': { rpm: 20 }
  }
};

/**
 * Token Bucket Rate Limiter
 */
class TokenBucket {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.capacity = options.capacity || DEFAULT_CONFIG.tokenBucket.capacity;
    this.refillRate = options.refillRate || DEFAULT_CONFIG.tokenBucket.refillRate;
    this.refillInterval = options.refillInterval || DEFAULT_CONFIG.tokenBucket.refillInterval;
  }

  async consume(key, tokens = 1) {
    const now = Date.now();
    const bucketKey = `ratelimit:bucket:${key}`;

    const script = `
      local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'lastRefill')
      local tokens = tonumber(bucket[1]) or tonumber(ARGV[1])
      local lastRefill = tonumber(bucket[2]) or tonumber(ARGV[4])
      
      local now = tonumber(ARGV[4])
      local elapsed = (now - lastRefill) / 1000
      local refillAmount = elapsed * tonumber(ARGV[2])
      
      tokens = math.min(tonumber(ARGV[1]), tokens + refillAmount)
      
      local consumed = false
      local tokensNeeded = tonumber(ARGV[3])
      
      if tokens >= tokensNeeded then
        tokens = tokens - tokensNeeded
        consumed = true
      end
      
      redis.call('HMSET', KEYS[1], 'tokens', tokens, 'lastRefill', now)
      redis.call('EXPIRE', KEYS[1], 3600)
      
      return {consumed and 1 or 0, tokens}
    `;

    const result = await this.redis.eval(
      script,
      1,
      bucketKey,
      this.capacity,
      this.refillRate,
      tokens,
      now
    );

    return {
      allowed: result[0] === 1,
      remaining: Math.floor(result[1]),
      capacity: this.capacity
    };
  }
}

/**
 * Sliding Window Rate Limiter
 */
class SlidingWindow {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.windowSize = options.windowSize || DEFAULT_CONFIG.slidingWindow.windowSize;
    this.maxRequests = options.maxRequests || DEFAULT_CONFIG.slidingWindow.maxRequests;
  }

  async check(key) {
    const now = Date.now();
    const windowKey = `ratelimit:window:${key}`;
    const windowStart = now - (this.windowSize * 1000);

    const script = `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
      local count = redis.call('ZCARD', KEYS[1])
      
      if count < tonumber(ARGV[2]) then
        redis.call('ZADD', KEYS[1], ARGV[3], ARGV[3])
        redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
        return {1, count + 1}
      end
      
      return {0, count}
    `;

    const result = await this.redis.eval(
      script,
      1,
      windowKey,
      windowStart,
      this.maxRequests,
      now,
      this.windowSize * 2
    );

    return {
      allowed: result[0] === 1,
      current: result[1],
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - result[1]),
      resetAt: new Date(now + this.windowSize * 1000).toISOString()
    };
  }
}

/**
 * Quota Manager
 */
class QuotaManager {
  constructor(redis) {
    this.redis = redis;
  }

  async getQuota(userId, tier = 'free') {
    const limits = DEFAULT_CONFIG.tiers[tier] || DEFAULT_CONFIG.tiers.free;
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const hour = Math.floor(now / 3600000);
    const day = Math.floor(now / 86400000);

    const [minuteCount, hourCount, dayCount] = await Promise.all([
      this.redis.get(`quota:${userId}:m:${minute}`),
      this.redis.get(`quota:${userId}:h:${hour}`),
      this.redis.get(`quota:${userId}:d:${day}`)
    ]);

    return {
      minute: {
        used: parseInt(minuteCount || '0'),
        limit: limits.rpm,
        remaining: Math.max(0, limits.rpm - parseInt(minuteCount || '0'))
      },
      hour: {
        used: parseInt(hourCount || '0'),
        limit: limits.rph,
        remaining: Math.max(0, limits.rph - parseInt(hourCount || '0'))
      },
      day: {
        used: parseInt(dayCount || '0'),
        limit: limits.rpd,
        remaining: Math.max(0, limits.rpd - parseInt(dayCount || '0'))
      }
    };
  }

  async increment(userId) {
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const hour = Math.floor(now / 3600000);
    const day = Math.floor(now / 86400000);

    const multi = this.redis.multi();
    
    multi.incr(`quota:${userId}:m:${minute}`);
    multi.expire(`quota:${userId}:m:${minute}`, 120);
    
    multi.incr(`quota:${userId}:h:${hour}`);
    multi.expire(`quota:${userId}:h:${hour}`, 7200);
    
    multi.incr(`quota:${userId}:d:${day}`);
    multi.expire(`quota:${userId}:d:${day}`, 172800);

    await multi.exec();
  }

  async checkAndIncrement(userId, tier = 'free') {
    const quota = await this.getQuota(userId, tier);

    if (quota.minute.remaining <= 0) {
      return { allowed: false, reason: 'minute_limit', quota };
    }
    if (quota.hour.remaining <= 0) {
      return { allowed: false, reason: 'hour_limit', quota };
    }
    if (quota.day.remaining <= 0) {
      return { allowed: false, reason: 'day_limit', quota };
    }

    await this.increment(userId);
    
    return { allowed: true, quota };
  }
}

/**
 * Rate Limiting Middleware Factory
 */
function createRateLimiter(options = {}) {
  const redis = options.redis || new Redis(options.redisUrl || 'redis://localhost:6379');
  const tokenBucket = new TokenBucket(redis, options.tokenBucket);
  const slidingWindow = new SlidingWindow(redis, options.slidingWindow);
  const quotaManager = new QuotaManager(redis);

  return async function rateLimitMiddleware(req, res, next) {
    try {
      // Determine identifier (user ID, API key, or IP)
      const identifier = req.user?.id || req.apiKey?.id || req.ip;
      const tier = req.user?.tier || req.apiKey?.tier || 'anonymous';
      const endpoint = req.path;

      // Check endpoint-specific limits
      const endpointConfig = DEFAULT_CONFIG.endpoints[endpoint];
      if (endpointConfig) {
        const endpointResult = await slidingWindow.check(`${identifier}:${endpoint}`);
        if (!endpointResult.allowed) {
          return sendRateLimitResponse(res, endpointResult, 'endpoint');
        }
      }

      // Check quota limits
      const quotaResult = await quotaManager.checkAndIncrement(identifier, tier);
      if (!quotaResult.allowed) {
        return sendRateLimitResponse(res, quotaResult, 'quota');
      }

      // Optional: Token bucket for burst control
      if (options.useBurst) {
        const bucketResult = await tokenBucket.consume(identifier);
        if (!bucketResult.allowed) {
          return sendRateLimitResponse(res, bucketResult, 'burst');
        }
      }

      // Set rate limit headers
      setRateLimitHeaders(res, quotaResult.quota);

      next();
    } catch (error) {
      console.error('Rate limiting error:', error);
      // Fail open - allow request on error
      next();
    }
  };
}

/**
 * Send rate limit exceeded response
 */
function sendRateLimitResponse(res, result, type) {
  const retryAfter = type === 'quota' 
    ? getRetryAfter(result.reason)
    : 60;

  res.set({
    'Retry-After': retryAfter,
    'X-RateLimit-Type': type
  });

  return res.status(429).json({
    error: 'Rate limit exceeded',
    type,
    message: getRateLimitMessage(type, result),
    retryAfter
  });
}

/**
 * Set rate limit headers
 */
function setRateLimitHeaders(res, quota) {
  res.set({
    'X-RateLimit-Limit-Minute': quota.minute.limit,
    'X-RateLimit-Remaining-Minute': quota.minute.remaining,
    'X-RateLimit-Limit-Hour': quota.hour.limit,
    'X-RateLimit-Remaining-Hour': quota.hour.remaining,
    'X-RateLimit-Limit-Day': quota.day.limit,
    'X-RateLimit-Remaining-Day': quota.day.remaining
  });
}

/**
 * Get retry after seconds based on limit type
 */
function getRetryAfter(reason) {
  switch (reason) {
    case 'minute_limit': return 60;
    case 'hour_limit': return 3600;
    case 'day_limit': return 86400;
    default: return 60;
  }
}

/**
 * Get user-friendly rate limit message
 */
function getRateLimitMessage(type, result) {
  switch (type) {
    case 'endpoint':
      return `Endpoint rate limit exceeded. Try again in ${result.resetAt}`;
    case 'quota':
      return `API quota exceeded (${result.reason}). Upgrade your plan for higher limits.`;
    case 'burst':
      return `Too many requests in short time. Please slow down.`;
    default:
      return 'Rate limit exceeded';
  }
}

/**
 * IP-based rate limiter (for public endpoints)
 */
function createIPRateLimiter(options = {}) {
  const redis = options.redis || new Redis(options.redisUrl || 'redis://localhost:6379');
  const windowSize = options.windowSize || 60;
  const maxRequests = options.maxRequests || 30;

  return async function ipRateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const key = `ratelimit:ip:${ip}`;
    const now = Date.now();

    try {
      const multi = redis.multi();
      multi.zadd(key, now, `${now}-${Math.random()}`);
      multi.zremrangebyscore(key, '-inf', now - windowSize * 1000);
      multi.zcard(key);
      multi.expire(key, windowSize * 2);

      const results = await multi.exec();
      const count = results[2][1];

      if (count > maxRequests) {
        res.set('Retry-After', windowSize);
        return res.status(429).json({
          error: 'Too many requests from this IP',
          retryAfter: windowSize
        });
      }

      res.set('X-RateLimit-Remaining', maxRequests - count);
      next();
    } catch (error) {
      next();
    }
  };
}

/**
 * API Key Rate Limiter
 */
class ApiKeyRateLimiter {
  constructor(redis) {
    this.redis = redis;
    this.quotaManager = new QuotaManager(redis);
  }

  async check(apiKeyId, tier) {
    return this.quotaManager.checkAndIncrement(apiKeyId, tier);
  }

  async getUsage(apiKeyId) {
    return this.quotaManager.getQuota(apiKeyId);
  }

  async resetUsage(apiKeyId) {
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const hour = Math.floor(now / 3600000);
    const day = Math.floor(now / 86400000);

    await Promise.all([
      this.redis.del(`quota:${apiKeyId}:m:${minute}`),
      this.redis.del(`quota:${apiKeyId}:h:${hour}`),
      this.redis.del(`quota:${apiKeyId}:d:${day}`)
    ]);
  }
}

module.exports = {
  createRateLimiter,
  createIPRateLimiter,
  TokenBucket,
  SlidingWindow,
  QuotaManager,
  ApiKeyRateLimiter,
  DEFAULT_CONFIG
};
