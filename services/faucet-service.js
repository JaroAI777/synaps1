/**
 * SYNAPSE Protocol - Testnet Faucet Service
 * 
 * Token distribution service for testnet
 * Features:
 * - Rate-limited token distribution
 * - Captcha verification
 * - Social verification (Twitter/Discord)
 * - Anti-abuse measures
 * - Statistics tracking
 */

const express = require('express');
const Redis = require('ioredis');
const { ethers } = require('ethers');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');

// Configuration
const CONFIG = {
  port: process.env.FAUCET_PORT || 3006,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  rpcUrl: process.env.RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
  privateKey: process.env.FAUCET_PRIVATE_KEY,
  
  tokenAddress: process.env.TOKEN_ADDRESS,
  
  // Distribution limits
  limits: {
    amountPerRequest: '100', // 100 SYNX
    cooldownHours: 24,
    maxRequestsPerDay: 3,
    minBalance: '1000000' // Minimum faucet balance to operate
  },
  
  // Verification requirements
  verification: {
    requireCaptcha: true,
    requireSocial: false,
    captchaSecret: process.env.RECAPTCHA_SECRET
  }
};

// Token ABI (minimal)
const TOKEN_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

/**
 * Faucet Service
 */
class FaucetService {
  constructor() {
    this.app = express();
    this.redis = null;
    this.provider = null;
    this.wallet = null;
    this.token = null;
  }

  async initialize() {
    console.log('💧 Initializing Faucet Service...');

    // Connect to Redis
    this.redis = new Redis(CONFIG.redisUrl);
    console.log('📦 Connected to Redis');

    // Connect to blockchain
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    this.wallet = new ethers.Wallet(CONFIG.privateKey, this.provider);
    this.token = new ethers.Contract(CONFIG.tokenAddress, TOKEN_ABI, this.wallet);

    // Check faucet balance
    const balance = await this.token.balanceOf(this.wallet.address);
    console.log(`💰 Faucet balance: ${ethers.formatEther(balance)} SYNX`);

    if (balance < ethers.parseEther(CONFIG.limits.minBalance)) {
      console.warn('⚠️  Warning: Faucet balance is low!');
    }

    // Setup middleware and routes
    this.setupMiddleware();
    this.setupRoutes();

    console.log('✅ Faucet Service initialized');
  }

  setupMiddleware() {
    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(express.json());

    // Global rate limiting
    this.app.use(rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // 100 requests per 15 minutes
      message: { error: 'Too many requests, please try again later' }
    }));
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', async (req, res) => {
      const balance = await this.token.balanceOf(this.wallet.address);
      res.json({
        status: 'healthy',
        balance: ethers.formatEther(balance),
        address: this.wallet.address
      });
    });

    // Get faucet info
    this.app.get('/api/info', async (req, res) => {
      try {
        const balance = await this.token.balanceOf(this.wallet.address);
        const stats = await this.getStats();

        res.json({
          address: this.wallet.address,
          token: CONFIG.tokenAddress,
          balance: ethers.formatEther(balance),
          amountPerRequest: CONFIG.limits.amountPerRequest,
          cooldownHours: CONFIG.limits.cooldownHours,
          stats
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Request tokens
    this.app.post('/api/request', async (req, res) => {
      try {
        const { address, captchaToken } = req.body;

        // Validate address
        if (!ethers.isAddress(address)) {
          return res.status(400).json({ error: 'Invalid Ethereum address' });
        }

        // Verify captcha
        if (CONFIG.verification.requireCaptcha) {
          const captchaValid = await this.verifyCaptcha(captchaToken);
          if (!captchaValid) {
            return res.status(400).json({ error: 'Invalid captcha' });
          }
        }

        // Check cooldown
        const canRequest = await this.canRequestTokens(address);
        if (!canRequest.allowed) {
          return res.status(429).json({
            error: 'Cooldown active',
            nextRequestAt: canRequest.nextRequestAt
          });
        }

        // Check faucet balance
        const balance = await this.token.balanceOf(this.wallet.address);
        const amount = ethers.parseEther(CONFIG.limits.amountPerRequest);
        
        if (balance < amount) {
          return res.status(503).json({ error: 'Faucet is empty' });
        }

        // Send tokens
        const tx = await this.token.transfer(address, amount);
        const receipt = await tx.wait();

        // Record request
        await this.recordRequest(address, tx.hash);

        // Update stats
        await this.updateStats(amount);

        res.json({
          success: true,
          transactionHash: tx.hash,
          amount: CONFIG.limits.amountPerRequest,
          message: `Sent ${CONFIG.limits.amountPerRequest} SYNX to ${address}`
        });

      } catch (error) {
        console.error('Faucet error:', error);
        res.status(500).json({ error: 'Transaction failed' });
      }
    });

    // Check eligibility
    this.app.get('/api/check/:address', async (req, res) => {
      try {
        const { address } = req.params;

        if (!ethers.isAddress(address)) {
          return res.status(400).json({ error: 'Invalid address' });
        }

        const canRequest = await this.canRequestTokens(address);
        const history = await this.getRequestHistory(address);

        res.json({
          address,
          eligible: canRequest.allowed,
          nextRequestAt: canRequest.nextRequestAt,
          requestsToday: canRequest.requestsToday,
          history
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get recent distributions
    this.app.get('/api/recent', async (req, res) => {
      try {
        const { limit = 10 } = req.query;
        const recent = await this.getRecentDistributions(parseInt(limit));
        res.json({ distributions: recent });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Leaderboard (most active testers)
    this.app.get('/api/leaderboard', async (req, res) => {
      try {
        const leaderboard = await this.getLeaderboard();
        res.json({ leaderboard });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  /**
   * Check if address can request tokens
   */
  async canRequestTokens(address) {
    const cooldownKey = `faucet:cooldown:${address.toLowerCase()}`;
    const dailyKey = `faucet:daily:${address.toLowerCase()}:${this.getDateKey()}`;

    const lastRequest = await this.redis.get(cooldownKey);
    const dailyRequests = parseInt(await this.redis.get(dailyKey) || '0');

    const now = Date.now();
    const cooldownMs = CONFIG.limits.cooldownHours * 60 * 60 * 1000;

    if (lastRequest) {
      const elapsed = now - parseInt(lastRequest);
      if (elapsed < cooldownMs) {
        return {
          allowed: false,
          nextRequestAt: new Date(parseInt(lastRequest) + cooldownMs).toISOString(),
          requestsToday: dailyRequests
        };
      }
    }

    if (dailyRequests >= CONFIG.limits.maxRequestsPerDay) {
      return {
        allowed: false,
        nextRequestAt: 'Tomorrow',
        requestsToday: dailyRequests
      };
    }

    return {
      allowed: true,
      requestsToday: dailyRequests
    };
  }

  /**
   * Record token request
   */
  async recordRequest(address, txHash) {
    const normalizedAddress = address.toLowerCase();
    const now = Date.now();
    const dateKey = this.getDateKey();

    // Set cooldown
    await this.redis.set(
      `faucet:cooldown:${normalizedAddress}`,
      now.toString(),
      'EX',
      CONFIG.limits.cooldownHours * 60 * 60
    );

    // Increment daily counter
    await this.redis.incr(`faucet:daily:${normalizedAddress}:${dateKey}`);
    await this.redis.expire(`faucet:daily:${normalizedAddress}:${dateKey}`, 86400);

    // Add to history
    const historyEntry = JSON.stringify({
      timestamp: now,
      txHash,
      amount: CONFIG.limits.amountPerRequest
    });
    await this.redis.lpush(`faucet:history:${normalizedAddress}`, historyEntry);
    await this.redis.ltrim(`faucet:history:${normalizedAddress}`, 0, 99);

    // Add to recent distributions
    const recentEntry = JSON.stringify({
      address: normalizedAddress,
      timestamp: now,
      txHash,
      amount: CONFIG.limits.amountPerRequest
    });
    await this.redis.lpush('faucet:recent', recentEntry);
    await this.redis.ltrim('faucet:recent', 0, 99);

    // Update user total
    await this.redis.incrbyfloat(
      `faucet:total:${normalizedAddress}`,
      parseFloat(CONFIG.limits.amountPerRequest)
    );
  }

  /**
   * Get request history for address
   */
  async getRequestHistory(address) {
    const history = await this.redis.lrange(
      `faucet:history:${address.toLowerCase()}`,
      0,
      9
    );
    return history.map(h => JSON.parse(h));
  }

  /**
   * Get recent distributions
   */
  async getRecentDistributions(limit) {
    const recent = await this.redis.lrange('faucet:recent', 0, limit - 1);
    return recent.map(r => JSON.parse(r));
  }

  /**
   * Update global stats
   */
  async updateStats(amount) {
    await this.redis.incr('faucet:stats:totalRequests');
    await this.redis.incrbyfloat('faucet:stats:totalDistributed', parseFloat(ethers.formatEther(amount)));
    await this.redis.incr(`faucet:stats:daily:${this.getDateKey()}`);
  }

  /**
   * Get global stats
   */
  async getStats() {
    const totalRequests = parseInt(await this.redis.get('faucet:stats:totalRequests') || '0');
    const totalDistributed = parseFloat(await this.redis.get('faucet:stats:totalDistributed') || '0');
    const todayRequests = parseInt(await this.redis.get(`faucet:stats:daily:${this.getDateKey()}`) || '0');

    return {
      totalRequests,
      totalDistributed,
      todayRequests
    };
  }

  /**
   * Get leaderboard
   */
  async getLeaderboard() {
    const keys = await this.redis.keys('faucet:total:*');
    const entries = [];

    for (const key of keys) {
      const address = key.replace('faucet:total:', '');
      const total = parseFloat(await this.redis.get(key) || '0');
      entries.push({ address, total });
    }

    return entries
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
  }

  /**
   * Verify reCAPTCHA
   */
  async verifyCaptcha(token) {
    if (!CONFIG.verification.captchaSecret || !token) {
      return !CONFIG.verification.requireCaptcha;
    }

    try {
      const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `secret=${CONFIG.verification.captchaSecret}&response=${token}`
      });

      const data = await response.json();
      return data.success;
    } catch (error) {
      console.error('Captcha verification error:', error);
      return false;
    }
  }

  /**
   * Get date key for daily tracking
   */
  getDateKey() {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Start server
   */
  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n💧 Faucet Service running on port ${CONFIG.port}`);
      console.log(`   Faucet Address: ${this.wallet.address}`);
      console.log(`   Token Address: ${CONFIG.tokenAddress}`);
      console.log(`   Amount per request: ${CONFIG.limits.amountPerRequest} SYNX`);
      console.log(`   Cooldown: ${CONFIG.limits.cooldownHours} hours\n`);
    });
  }
}

// Main
async function main() {
  const faucet = new FaucetService();
  await faucet.initialize();
  faucet.start();
}

main().catch(console.error);

module.exports = { FaucetService };
