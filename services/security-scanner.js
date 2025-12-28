/**
 * SYNAPSE Protocol - Security Scanner Service
 * 
 * Real-time security monitoring and threat detection
 * Features:
 * - Transaction anomaly detection
 * - Whale movement alerts
 * - Contract interaction monitoring
 * - Rate limit enforcement
 * - Blacklist management
 */

const express = require('express');
const { ethers } = require('ethers');
const Redis = require('ioredis');
const { Pool } = require('pg');

// Configuration
const CONFIG = {
  port: process.env.SECURITY_PORT || 3011,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  postgresUrl: process.env.DATABASE_URL,
  rpcUrl: process.env.RPC_URL,
  
  // Thresholds
  thresholds: {
    largeTransaction: ethers.parseEther('100000'),  // 100k SYNX
    whaleThreshold: ethers.parseEther('1000000'),   // 1M SYNX
    rapidTxCount: 10,                                // Max tx in window
    rapidTxWindow: 60,                               // 60 seconds
    priceImpactWarning: 0.05,                        // 5%
    priceImpactCritical: 0.10                        // 10%
  },
  
  // Alert levels
  alertLevels: {
    INFO: 'info',
    WARNING: 'warning',
    CRITICAL: 'critical',
    EMERGENCY: 'emergency'
  }
};

// Contract ABIs
const ABIS = {
  token: [
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'event Approval(address indexed owner, address indexed spender, uint256 value)',
    'function balanceOf(address) view returns (uint256)',
    'function totalSupply() view returns (uint256)'
  ],
  paymentRouter: [
    'event PaymentSent(address indexed sender, address indexed recipient, uint256 amount, uint256 fee, bytes32 paymentId)',
    'event EscrowCreated(bytes32 indexed escrowId, address indexed sender, address indexed recipient, uint256 amount)'
  ]
};

/**
 * Security Alert
 */
class SecurityAlert {
  constructor(level, type, message, data = {}) {
    this.id = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.level = level;
    this.type = type;
    this.message = message;
    this.data = data;
    this.timestamp = new Date().toISOString();
    this.acknowledged = false;
  }
}

/**
 * Security Scanner Service
 */
class SecurityScanner {
  constructor() {
    this.app = express();
    this.redis = null;
    this.pg = null;
    this.provider = null;
    this.contracts = {};
    this.alerts = [];
    this.blacklist = new Set();
    this.whitelist = new Set();
    this.watchlist = new Map();
    this.txHistory = new Map();
  }

  async initialize() {
    console.log('🔒 Initializing Security Scanner...');

    // Connect to databases
    this.redis = new Redis(CONFIG.redisUrl);
    this.pg = new Pool({ connectionString: CONFIG.postgresUrl });

    // Connect to blockchain
    this.provider = new ethers.WebSocketProvider(CONFIG.rpcUrl.replace('https', 'wss'));
    console.log('⛓️  Connected to blockchain');

    // Load lists
    await this.loadLists();

    // Initialize contracts
    await this.initializeContracts();

    // Setup routes
    this.setupRoutes();

    // Start monitoring
    this.startMonitoring();

    console.log('✅ Security Scanner initialized');
  }

  async loadLists() {
    // Load blacklist
    const blacklisted = await this.redis.smembers('security:blacklist');
    blacklisted.forEach(addr => this.blacklist.add(addr.toLowerCase()));
    console.log(`  📋 Loaded ${this.blacklist.size} blacklisted addresses`);

    // Load whitelist
    const whitelisted = await this.redis.smembers('security:whitelist');
    whitelisted.forEach(addr => this.whitelist.add(addr.toLowerCase()));
    console.log(`  ✅ Loaded ${this.whitelist.size} whitelisted addresses`);

    // Load watchlist
    const watchlisted = await this.redis.hgetall('security:watchlist');
    for (const [addr, reason] of Object.entries(watchlisted)) {
      this.watchlist.set(addr.toLowerCase(), reason);
    }
    console.log(`  👁️  Loaded ${this.watchlist.size} watched addresses`);
  }

  async initializeContracts() {
    const tokenAddress = process.env.TOKEN_ADDRESS;
    const routerAddress = process.env.ROUTER_ADDRESS;

    if (tokenAddress) {
      this.contracts.token = new ethers.Contract(tokenAddress, ABIS.token, this.provider);
    }

    if (routerAddress) {
      this.contracts.router = new ethers.Contract(routerAddress, ABIS.paymentRouter, this.provider);
    }
  }

  // ============ Monitoring ============

  startMonitoring() {
    // Monitor token transfers
    if (this.contracts.token) {
      this.contracts.token.on('Transfer', async (from, to, value, event) => {
        await this.analyzeTransfer(from, to, value, event);
      });
      console.log('📡 Monitoring token transfers');
    }

    // Monitor payments
    if (this.contracts.router) {
      this.contracts.router.on('PaymentSent', async (sender, recipient, amount, fee, paymentId, event) => {
        await this.analyzePayment(sender, recipient, amount, event);
      });
      console.log('📡 Monitoring payments');
    }

    // Periodic checks
    setInterval(() => this.runPeriodicChecks(), 60000); // Every minute
  }

  async analyzeTransfer(from, to, value, event) {
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();

    // Skip whitelisted addresses
    if (this.whitelist.has(fromLower) && this.whitelist.has(toLower)) {
      return;
    }

    // Check blacklist
    if (this.blacklist.has(fromLower)) {
      await this.createAlert(
        CONFIG.alertLevels.CRITICAL,
        'BLACKLIST_TRANSFER',
        `Blacklisted address ${from} attempted transfer`,
        { from, to, value: ethers.formatEther(value), txHash: event.transactionHash }
      );
      return;
    }

    if (this.blacklist.has(toLower)) {
      await this.createAlert(
        CONFIG.alertLevels.WARNING,
        'BLACKLIST_RECIPIENT',
        `Transfer to blacklisted address ${to}`,
        { from, to, value: ethers.formatEther(value), txHash: event.transactionHash }
      );
    }

    // Check watchlist
    if (this.watchlist.has(fromLower) || this.watchlist.has(toLower)) {
      await this.createAlert(
        CONFIG.alertLevels.INFO,
        'WATCHLIST_ACTIVITY',
        `Watched address activity detected`,
        { 
          from, 
          to, 
          value: ethers.formatEther(value),
          reason: this.watchlist.get(fromLower) || this.watchlist.get(toLower)
        }
      );
    }

    // Large transaction detection
    if (value >= CONFIG.thresholds.largeTransaction) {
      await this.createAlert(
        CONFIG.alertLevels.WARNING,
        'LARGE_TRANSACTION',
        `Large transfer detected: ${ethers.formatEther(value)} SYNX`,
        { from, to, value: ethers.formatEther(value), txHash: event.transactionHash }
      );
    }

    // Whale movement detection
    if (value >= CONFIG.thresholds.whaleThreshold) {
      await this.createAlert(
        CONFIG.alertLevels.CRITICAL,
        'WHALE_MOVEMENT',
        `Whale movement detected: ${ethers.formatEther(value)} SYNX`,
        { from, to, value: ethers.formatEther(value), txHash: event.transactionHash }
      );
    }

    // Rapid transaction detection
    await this.checkRapidTransactions(fromLower);
  }

  async analyzePayment(sender, recipient, amount, event) {
    const senderLower = sender.toLowerCase();

    // Check for suspicious patterns
    if (amount >= CONFIG.thresholds.largeTransaction) {
      await this.createAlert(
        CONFIG.alertLevels.WARNING,
        'LARGE_PAYMENT',
        `Large payment detected: ${ethers.formatEther(amount)} SYNX`,
        { sender, recipient, amount: ethers.formatEther(amount), txHash: event.transactionHash }
      );
    }
  }

  async checkRapidTransactions(address) {
    const key = `tx_history:${address}`;
    const now = Date.now();
    const windowStart = now - (CONFIG.thresholds.rapidTxWindow * 1000);

    // Add current transaction
    await this.redis.zadd(key, now, now.toString());
    
    // Remove old transactions
    await this.redis.zremrangebyscore(key, 0, windowStart);
    
    // Count transactions in window
    const count = await this.redis.zcard(key);

    if (count > CONFIG.thresholds.rapidTxCount) {
      await this.createAlert(
        CONFIG.alertLevels.WARNING,
        'RAPID_TRANSACTIONS',
        `Rapid transaction activity: ${count} txs in ${CONFIG.thresholds.rapidTxWindow}s`,
        { address, count, window: CONFIG.thresholds.rapidTxWindow }
      );
    }

    // Set expiry
    await this.redis.expire(key, CONFIG.thresholds.rapidTxWindow * 2);
  }

  async runPeriodicChecks() {
    try {
      // Check for unusual contract interactions
      await this.checkContractInteractions();

      // Check token supply changes
      await this.checkSupplyChanges();

      // Clean up old alerts
      await this.cleanupAlerts();
    } catch (error) {
      console.error('Periodic check error:', error);
    }
  }

  async checkContractInteractions() {
    // Monitor for unusual patterns in contract calls
    // This would integrate with event indexer data
  }

  async checkSupplyChanges() {
    if (!this.contracts.token) return;

    try {
      const currentSupply = await this.contracts.token.totalSupply();
      const cachedSupply = await this.redis.get('security:totalSupply');

      if (cachedSupply) {
        const change = currentSupply - BigInt(cachedSupply);
        const changePercent = Number(change * 10000n / BigInt(cachedSupply)) / 100;

        if (Math.abs(changePercent) > 1) {
          await this.createAlert(
            CONFIG.alertLevels.WARNING,
            'SUPPLY_CHANGE',
            `Token supply changed by ${changePercent.toFixed(2)}%`,
            { 
              previousSupply: cachedSupply,
              currentSupply: currentSupply.toString(),
              change: change.toString()
            }
          );
        }
      }

      await this.redis.set('security:totalSupply', currentSupply.toString());
    } catch (error) {
      console.error('Supply check error:', error);
    }
  }

  async cleanupAlerts() {
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    const cutoff = Date.now() - maxAge;

    this.alerts = this.alerts.filter(alert => 
      new Date(alert.timestamp).getTime() > cutoff
    );
  }

  // ============ Alert Management ============

  async createAlert(level, type, message, data = {}) {
    const alert = new SecurityAlert(level, type, message, data);
    
    // Store in memory
    this.alerts.push(alert);

    // Store in Redis
    await this.redis.lpush('security:alerts', JSON.stringify(alert));
    await this.redis.ltrim('security:alerts', 0, 999); // Keep last 1000

    // Store in PostgreSQL for history
    if (this.pg) {
      try {
        await this.pg.query(`
          INSERT INTO security_alerts (id, level, type, message, data, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [alert.id, level, type, message, JSON.stringify(data), alert.timestamp]);
      } catch (error) {
        console.error('Failed to store alert in database:', error);
      }
    }

    // Log based on level
    const emoji = {
      info: 'ℹ️',
      warning: '⚠️',
      critical: '🚨',
      emergency: '🆘'
    };

    console.log(`${emoji[level] || '📢'} [${level.toUpperCase()}] ${type}: ${message}`);

    // Send notifications for critical alerts
    if (level === CONFIG.alertLevels.CRITICAL || level === CONFIG.alertLevels.EMERGENCY) {
      await this.sendNotification(alert);
    }

    return alert;
  }

  async sendNotification(alert) {
    // Would integrate with notification service
    // Slack, Discord, Telegram, Email, etc.
    console.log(`📤 Sending notification for alert: ${alert.id}`);
  }

  // ============ List Management ============

  async addToBlacklist(address, reason) {
    const addr = address.toLowerCase();
    this.blacklist.add(addr);
    await this.redis.sadd('security:blacklist', addr);
    await this.redis.hset('security:blacklist_reasons', addr, reason);

    await this.createAlert(
      CONFIG.alertLevels.INFO,
      'BLACKLIST_ADD',
      `Address added to blacklist: ${address}`,
      { address, reason }
    );
  }

  async removeFromBlacklist(address) {
    const addr = address.toLowerCase();
    this.blacklist.delete(addr);
    await this.redis.srem('security:blacklist', addr);
    await this.redis.hdel('security:blacklist_reasons', addr);
  }

  async addToWatchlist(address, reason) {
    const addr = address.toLowerCase();
    this.watchlist.set(addr, reason);
    await this.redis.hset('security:watchlist', addr, reason);
  }

  async removeFromWatchlist(address) {
    const addr = address.toLowerCase();
    this.watchlist.delete(addr);
    await this.redis.hdel('security:watchlist', addr);
  }

  async addToWhitelist(address) {
    const addr = address.toLowerCase();
    this.whitelist.add(addr);
    await this.redis.sadd('security:whitelist', addr);
  }

  // ============ Risk Assessment ============

  async assessAddressRisk(address) {
    const addr = address.toLowerCase();
    let riskScore = 0;
    const factors = [];

    // Check blacklist
    if (this.blacklist.has(addr)) {
      return { score: 100, factors: ['Blacklisted'], risk: 'CRITICAL' };
    }

    // Check watchlist
    if (this.watchlist.has(addr)) {
      riskScore += 30;
      factors.push('On watchlist');
    }

    // Check transaction history
    const txCount = await this.redis.zcard(`tx_history:${addr}`);
    if (txCount > 50) {
      riskScore += 10;
      factors.push('High transaction frequency');
    }

    // Check for alerts involving this address
    const alertCount = this.alerts.filter(a => 
      a.data.from?.toLowerCase() === addr || 
      a.data.to?.toLowerCase() === addr ||
      a.data.address?.toLowerCase() === addr
    ).length;

    if (alertCount > 5) {
      riskScore += 20;
      factors.push(`${alertCount} security alerts`);
    }

    // Check balance for whale status
    if (this.contracts.token) {
      try {
        const balance = await this.contracts.token.balanceOf(address);
        if (balance >= CONFIG.thresholds.whaleThreshold) {
          riskScore += 5;
          factors.push('Whale account');
        }
      } catch (error) {
        // Ignore balance check errors
      }
    }

    let risk = 'LOW';
    if (riskScore >= 70) risk = 'CRITICAL';
    else if (riskScore >= 50) risk = 'HIGH';
    else if (riskScore >= 30) risk = 'MEDIUM';

    return { score: Math.min(riskScore, 100), factors, risk };
  }

  // ============ API Routes ============

  setupRoutes() {
    this.app.use(express.json());

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        alerts: this.alerts.length,
        blacklist: this.blacklist.size,
        watchlist: this.watchlist.size
      });
    });

    // Get recent alerts
    this.app.get('/api/alerts', (req, res) => {
      const { level, limit = 50 } = req.query;
      let filtered = this.alerts;

      if (level) {
        filtered = filtered.filter(a => a.level === level);
      }

      res.json({
        alerts: filtered.slice(-parseInt(limit)).reverse(),
        total: filtered.length
      });
    });

    // Acknowledge alert
    this.app.post('/api/alerts/:id/acknowledge', async (req, res) => {
      const alert = this.alerts.find(a => a.id === req.params.id);
      if (!alert) {
        return res.status(404).json({ error: 'Alert not found' });
      }

      alert.acknowledged = true;
      res.json({ success: true, alert });
    });

    // Risk assessment
    this.app.get('/api/risk/:address', async (req, res) => {
      try {
        const risk = await this.assessAddressRisk(req.params.address);
        res.json(risk);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Blacklist management
    this.app.get('/api/blacklist', (req, res) => {
      res.json({ addresses: Array.from(this.blacklist) });
    });

    this.app.post('/api/blacklist', async (req, res) => {
      const { address, reason } = req.body;
      if (!address || !reason) {
        return res.status(400).json({ error: 'Address and reason required' });
      }

      await this.addToBlacklist(address, reason);
      res.json({ success: true });
    });

    this.app.delete('/api/blacklist/:address', async (req, res) => {
      await this.removeFromBlacklist(req.params.address);
      res.json({ success: true });
    });

    // Watchlist management
    this.app.get('/api/watchlist', (req, res) => {
      const watchlist = {};
      this.watchlist.forEach((reason, addr) => {
        watchlist[addr] = reason;
      });
      res.json({ addresses: watchlist });
    });

    this.app.post('/api/watchlist', async (req, res) => {
      const { address, reason } = req.body;
      await this.addToWatchlist(address, reason);
      res.json({ success: true });
    });

    // Whitelist management
    this.app.get('/api/whitelist', (req, res) => {
      res.json({ addresses: Array.from(this.whitelist) });
    });

    this.app.post('/api/whitelist', async (req, res) => {
      const { address } = req.body;
      await this.addToWhitelist(address);
      res.json({ success: true });
    });

    // Stats
    this.app.get('/api/stats', async (req, res) => {
      const stats = {
        totalAlerts: this.alerts.length,
        alertsByLevel: {
          info: this.alerts.filter(a => a.level === 'info').length,
          warning: this.alerts.filter(a => a.level === 'warning').length,
          critical: this.alerts.filter(a => a.level === 'critical').length,
          emergency: this.alerts.filter(a => a.level === 'emergency').length
        },
        blacklistSize: this.blacklist.size,
        watchlistSize: this.watchlist.size,
        whitelistSize: this.whitelist.size
      };

      res.json(stats);
    });
  }

  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n🔒 Security Scanner running on port ${CONFIG.port}`);
      console.log('\n📡 API Endpoints:');
      console.log('   GET  /api/alerts              - Recent alerts');
      console.log('   POST /api/alerts/:id/acknowledge');
      console.log('   GET  /api/risk/:address       - Risk assessment');
      console.log('   GET  /api/blacklist           - Blacklist');
      console.log('   POST /api/blacklist           - Add to blacklist');
      console.log('   GET  /api/watchlist           - Watchlist');
      console.log('   GET  /api/whitelist           - Whitelist');
      console.log('   GET  /api/stats               - Statistics\n');
    });
  }
}

// Main
async function main() {
  const scanner = new SecurityScanner();
  await scanner.initialize();
  scanner.start();
}

main().catch(console.error);

module.exports = { SecurityScanner };
