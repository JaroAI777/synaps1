/**
 * SYNAPSE Protocol - Portfolio Tracker Service
 * 
 * Comprehensive portfolio management and analytics
 * Features:
 * - Multi-chain portfolio tracking
 * - Real-time P&L calculations
 * - Historical performance
 * - Tax reporting
 * - Alerts and notifications
 */

const express = require('express');
const { ethers } = require('ethers');
const Redis = require('ioredis');
const { Pool } = require('pg');
const cron = require('node-cron');

// Configuration
const CONFIG = {
  port: process.env.PORTFOLIO_PORT || 3016,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  postgresUrl: process.env.DATABASE_URL,

  // Price update interval (seconds)
  priceUpdateInterval: 60,

  // Supported chains
  chains: {
    arbitrum: { chainId: 42161, rpcUrl: process.env.ARBITRUM_RPC },
    ethereum: { chainId: 1, rpcUrl: process.env.ETHEREUM_RPC },
    polygon: { chainId: 137, rpcUrl: process.env.POLYGON_RPC },
    optimism: { chainId: 10, rpcUrl: process.env.OPTIMISM_RPC }
  }
};

// ABIs
const ABIS = {
  erc20: [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)'
  ],
  erc721: [
    'function balanceOf(address) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ],
  staking: [
    'function getStakeInfo(address) view returns (uint256 amount, uint8 tier, uint256 lockEnd, uint256 pendingRewards)'
  ],
  lending: [
    'function getUserAccountData(address) view returns (uint256 totalDeposits, uint256 totalBorrows, uint256 availableBorrows, uint256 healthFactor)'
  ]
};

/**
 * Asset types
 */
const AssetType = {
  TOKEN: 'token',
  NFT: 'nft',
  LP: 'lp',
  STAKING: 'staking',
  LENDING: 'lending',
  YIELD: 'yield'
};

/**
 * Portfolio asset
 */
class PortfolioAsset {
  constructor(data) {
    this.id = data.id;
    this.chainId = data.chainId;
    this.type = data.type;
    this.address = data.address;
    this.symbol = data.symbol;
    this.name = data.name;
    this.balance = data.balance;
    this.price = data.price || 0;
    this.value = data.value || 0;
    this.change24h = data.change24h || 0;
    this.metadata = data.metadata || {};
    this.lastUpdated = data.lastUpdated || Date.now();
  }

  get valueFormatted() {
    return `$${this.value.toFixed(2)}`;
  }
}

/**
 * Portfolio snapshot
 */
class PortfolioSnapshot {
  constructor(wallet, assets) {
    this.wallet = wallet;
    this.assets = assets;
    this.totalValue = assets.reduce((sum, a) => sum + a.value, 0);
    this.timestamp = Date.now();
  }

  getAssetsByType(type) {
    return this.assets.filter(a => a.type === type);
  }

  getAssetsByChain(chainId) {
    return this.assets.filter(a => a.chainId === chainId);
  }

  getTopAssets(n = 5) {
    return [...this.assets].sort((a, b) => b.value - a.value).slice(0, n);
  }

  getAllocation() {
    return this.assets.map(a => ({
      symbol: a.symbol,
      percentage: (a.value / this.totalValue) * 100
    }));
  }
}

/**
 * Portfolio Tracker Service
 */
class PortfolioTracker {
  constructor() {
    this.app = express();
    this.redis = null;
    this.pg = null;
    this.providers = {};

    this.priceCache = new Map();
    this.portfolioCache = new Map();

    this.stats = {
      walletsTracked: 0,
      assetsTracked: 0,
      totalValueTracked: 0,
      priceUpdates: 0
    };
  }

  async initialize() {
    console.log('📊 Initializing Portfolio Tracker...');

    // Connect to databases
    this.redis = new Redis(CONFIG.redisUrl);
    this.pg = new Pool({ connectionString: CONFIG.postgresUrl });

    // Initialize chain providers
    for (const [name, chain] of Object.entries(CONFIG.chains)) {
      if (chain.rpcUrl) {
        this.providers[name] = new ethers.JsonRpcProvider(chain.rpcUrl);
        console.log(`  ✅ ${name} connected`);
      }
    }

    // Ensure tables
    await this.ensureTables();

    // Setup routes
    this.setupRoutes();

    // Start price updates
    this.startPriceUpdates();

    // Start periodic snapshots
    this.startSnapshotScheduler();

    console.log('✅ Portfolio Tracker initialized');
  }

  async ensureTables() {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS portfolios (
        id SERIAL PRIMARY KEY,
        wallet VARCHAR(42) UNIQUE NOT NULL,
        label VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS portfolio_assets (
        id SERIAL PRIMARY KEY,
        wallet VARCHAR(42) NOT NULL,
        chain_id INT NOT NULL,
        asset_type VARCHAR(20) NOT NULL,
        contract_address VARCHAR(42),
        token_id VARCHAR(78),
        symbol VARCHAR(20),
        name VARCHAR(100),
        balance NUMERIC,
        price NUMERIC,
        value NUMERIC,
        metadata JSONB,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(wallet, chain_id, contract_address, token_id)
      );

      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id SERIAL PRIMARY KEY,
        wallet VARCHAR(42) NOT NULL,
        total_value NUMERIC NOT NULL,
        assets JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS portfolio_transactions (
        id SERIAL PRIMARY KEY,
        wallet VARCHAR(42) NOT NULL,
        chain_id INT NOT NULL,
        tx_hash VARCHAR(66) NOT NULL,
        tx_type VARCHAR(30),
        asset_address VARCHAR(42),
        amount NUMERIC,
        value_usd NUMERIC,
        gas_used NUMERIC,
        timestamp TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS price_alerts (
        id SERIAL PRIMARY KEY,
        wallet VARCHAR(42) NOT NULL,
        asset_address VARCHAR(42) NOT NULL,
        alert_type VARCHAR(20) NOT NULL,
        target_price NUMERIC NOT NULL,
        is_triggered BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_assets_wallet ON portfolio_assets(wallet);
      CREATE INDEX IF NOT EXISTS idx_snapshots_wallet ON portfolio_snapshots(wallet);
      CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON portfolio_transactions(wallet);
    `);
  }

  // ============ Portfolio Management ============

  /**
   * Fetch complete portfolio for a wallet
   */
  async getPortfolio(wallet, forceRefresh = false) {
    wallet = wallet.toLowerCase();

    // Check cache
    if (!forceRefresh && this.portfolioCache.has(wallet)) {
      const cached = this.portfolioCache.get(wallet);
      if (Date.now() - cached.timestamp < 60000) { // 1 minute cache
        return cached;
      }
    }

    const assets = [];

    // Fetch assets from each chain
    for (const [chainName, chain] of Object.entries(CONFIG.chains)) {
      if (!this.providers[chainName]) continue;

      try {
        // Get token balances
        const tokens = await this.fetchTokenBalances(wallet, chainName, chain.chainId);
        assets.push(...tokens);

        // Get NFTs
        const nfts = await this.fetchNFTBalances(wallet, chainName, chain.chainId);
        assets.push(...nfts);

        // Get staking positions
        const staking = await this.fetchStakingPositions(wallet, chainName, chain.chainId);
        assets.push(...staking);

        // Get lending positions
        const lending = await this.fetchLendingPositions(wallet, chainName, chain.chainId);
        assets.push(...lending);

      } catch (error) {
        console.error(`Error fetching ${chainName} portfolio:`, error.message);
      }
    }

    // Create snapshot
    const snapshot = new PortfolioSnapshot(wallet, assets);

    // Cache
    this.portfolioCache.set(wallet, snapshot);

    // Store in database
    await this.savePortfolioSnapshot(wallet, snapshot);

    return snapshot;
  }

  async fetchTokenBalances(wallet, chainName, chainId) {
    const assets = [];

    // Get tracked tokens for this chain
    const trackedTokens = await this.getTrackedTokens(chainId);
    const provider = this.providers[chainName];

    for (const token of trackedTokens) {
      try {
        const contract = new ethers.Contract(token.address, ABIS.erc20, provider);
        const balance = await contract.balanceOf(wallet);

        if (balance > 0n) {
          const decimals = await contract.decimals();
          const formattedBalance = parseFloat(ethers.formatUnits(balance, decimals));
          const price = this.priceCache.get(token.address.toLowerCase()) || 0;

          assets.push(new PortfolioAsset({
            id: `${chainId}-${token.address}`,
            chainId,
            type: AssetType.TOKEN,
            address: token.address,
            symbol: token.symbol,
            name: token.name,
            balance: formattedBalance,
            price,
            value: formattedBalance * price
          }));
        }
      } catch (error) {
        // Skip failed tokens
      }
    }

    // Also check native token (ETH)
    const nativeBalance = await provider.getBalance(wallet);
    if (nativeBalance > 0n) {
      const formattedBalance = parseFloat(ethers.formatEther(nativeBalance));
      const ethPrice = this.priceCache.get('eth') || 0;

      assets.push(new PortfolioAsset({
        id: `${chainId}-native`,
        chainId,
        type: AssetType.TOKEN,
        address: '0x0000000000000000000000000000000000000000',
        symbol: 'ETH',
        name: 'Ethereum',
        balance: formattedBalance,
        price: ethPrice,
        value: formattedBalance * ethPrice
      }));
    }

    return assets;
  }

  async fetchNFTBalances(wallet, chainName, chainId) {
    // In production, use NFT API (Alchemy, Moralis, etc.)
    return [];
  }

  async fetchStakingPositions(wallet, chainName, chainId) {
    const assets = [];

    // Fetch from SYNAPSE staking contract
    // This would be customized per protocol

    return assets;
  }

  async fetchLendingPositions(wallet, chainName, chainId) {
    const assets = [];

    // Fetch from SYNAPSE lending contract
    // This would be customized per protocol

    return assets;
  }

  // ============ Historical Data ============

  /**
   * Get portfolio history
   */
  async getPortfolioHistory(wallet, days = 30) {
    wallet = wallet.toLowerCase();

    const result = await this.pg.query(`
      SELECT 
        DATE(created_at) as date,
        MAX(total_value) as total_value,
        assets
      FROM portfolio_snapshots
      WHERE wallet = $1 AND created_at > NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at), assets
      ORDER BY date
    `, [wallet]);

    return result.rows.map(row => ({
      date: row.date,
      totalValue: parseFloat(row.total_value),
      topAssets: JSON.parse(row.assets).slice(0, 5)
    }));
  }

  /**
   * Get P&L calculations
   */
  async calculatePnL(wallet, period = '30d') {
    wallet = wallet.toLowerCase();

    // Get current portfolio
    const current = await this.getPortfolio(wallet);

    // Get historical snapshot
    let interval;
    switch (period) {
      case '24h': interval = '1 day'; break;
      case '7d': interval = '7 days'; break;
      case '30d': interval = '30 days'; break;
      case '1y': interval = '1 year'; break;
      default: interval = '30 days';
    }

    const historical = await this.pg.query(`
      SELECT total_value FROM portfolio_snapshots
      WHERE wallet = $1 AND created_at <= NOW() - INTERVAL '${interval}'
      ORDER BY created_at DESC LIMIT 1
    `, [wallet]);

    const previousValue = historical.rows[0]?.total_value || current.totalValue;
    const pnlAbsolute = current.totalValue - parseFloat(previousValue);
    const pnlPercentage = previousValue > 0 
      ? (pnlAbsolute / parseFloat(previousValue)) * 100 
      : 0;

    return {
      period,
      currentValue: current.totalValue,
      previousValue: parseFloat(previousValue),
      pnlAbsolute,
      pnlPercentage,
      isPositive: pnlAbsolute >= 0
    };
  }

  // ============ Tax Reporting ============

  /**
   * Generate tax report
   */
  async generateTaxReport(wallet, year) {
    wallet = wallet.toLowerCase();

    // Fetch all transactions for the year
    const transactions = await this.pg.query(`
      SELECT * FROM portfolio_transactions
      WHERE wallet = $1 
        AND EXTRACT(YEAR FROM timestamp) = $2
      ORDER BY timestamp
    `, [wallet, year]);

    // Calculate realized gains/losses
    const trades = transactions.rows.filter(t => 
      ['swap', 'sell', 'transfer_out'].includes(t.tx_type)
    );

    let totalRealizedGain = 0;
    let totalRealizedLoss = 0;

    for (const trade of trades) {
      // Would need cost basis tracking for accurate calculation
      if (trade.value_usd > 0) {
        totalRealizedGain += parseFloat(trade.value_usd);
      } else {
        totalRealizedLoss += Math.abs(parseFloat(trade.value_usd));
      }
    }

    return {
      year,
      wallet,
      totalTransactions: transactions.rowCount,
      totalRealizedGain,
      totalRealizedLoss,
      netGain: totalRealizedGain - totalRealizedLoss,
      transactions: transactions.rows
    };
  }

  // ============ Alerts ============

  /**
   * Create price alert
   */
  async createPriceAlert(wallet, assetAddress, alertType, targetPrice) {
    await this.pg.query(`
      INSERT INTO price_alerts (wallet, asset_address, alert_type, target_price)
      VALUES ($1, $2, $3, $4)
    `, [wallet.toLowerCase(), assetAddress.toLowerCase(), alertType, targetPrice]);
  }

  /**
   * Check and trigger alerts
   */
  async checkAlerts() {
    const alerts = await this.pg.query(
      'SELECT * FROM price_alerts WHERE is_triggered = false'
    );

    for (const alert of alerts.rows) {
      const currentPrice = this.priceCache.get(alert.asset_address.toLowerCase());
      if (!currentPrice) continue;

      let shouldTrigger = false;

      if (alert.alert_type === 'above' && currentPrice >= parseFloat(alert.target_price)) {
        shouldTrigger = true;
      } else if (alert.alert_type === 'below' && currentPrice <= parseFloat(alert.target_price)) {
        shouldTrigger = true;
      }

      if (shouldTrigger) {
        await this.pg.query(
          'UPDATE price_alerts SET is_triggered = true WHERE id = $1',
          [alert.id]
        );

        // Send notification
        await this.redis.publish('portfolio:alerts', JSON.stringify({
          wallet: alert.wallet,
          asset: alert.asset_address,
          alertType: alert.alert_type,
          targetPrice: alert.target_price,
          currentPrice
        }));
      }
    }
  }

  // ============ Price Updates ============

  startPriceUpdates() {
    // Update prices every minute
    setInterval(() => this.updatePrices(), CONFIG.priceUpdateInterval * 1000);
    this.updatePrices(); // Initial update
  }

  async updatePrices() {
    try {
      // In production, fetch from price oracle or CoinGecko/CMC
      // For now, use mock prices
      const mockPrices = {
        'eth': 2500,
        'synx': 1.50,
        'usdc': 1.00,
        'usdt': 1.00
      };

      for (const [symbol, price] of Object.entries(mockPrices)) {
        this.priceCache.set(symbol, price);
      }

      this.stats.priceUpdates++;

      // Check alerts after price update
      await this.checkAlerts();
    } catch (error) {
      console.error('Price update failed:', error.message);
    }
  }

  // ============ Helpers ============

  async getTrackedTokens(chainId) {
    // In production, fetch from database or config
    return [
      { address: '0x...synx', symbol: 'SYNX', name: 'Synapse Token' },
      { address: '0x...usdc', symbol: 'USDC', name: 'USD Coin' }
    ];
  }

  async savePortfolioSnapshot(wallet, snapshot) {
    await this.pg.query(`
      INSERT INTO portfolio_snapshots (wallet, total_value, assets)
      VALUES ($1, $2, $3)
    `, [wallet, snapshot.totalValue, JSON.stringify(snapshot.assets.map(a => ({
      symbol: a.symbol,
      value: a.value,
      balance: a.balance
    })))]);
  }

  startSnapshotScheduler() {
    // Daily snapshots for all tracked wallets
    cron.schedule('0 0 * * *', async () => {
      console.log('📸 Creating daily snapshots...');
      const wallets = await this.pg.query('SELECT wallet FROM portfolios');
      for (const row of wallets.rows) {
        await this.getPortfolio(row.wallet, true);
      }
    });
  }

  // ============ API Routes ============

  setupRoutes() {
    this.app.use(express.json());

    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        stats: this.stats,
        priceCache: this.priceCache.size
      });
    });

    // Get portfolio
    this.app.get('/api/portfolio/:wallet', async (req, res) => {
      try {
        const { refresh } = req.query;
        const portfolio = await this.getPortfolio(req.params.wallet, refresh === 'true');
        res.json({
          wallet: portfolio.wallet,
          totalValue: portfolio.totalValue,
          assets: portfolio.assets,
          allocation: portfolio.getAllocation(),
          topAssets: portfolio.getTopAssets()
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get portfolio history
    this.app.get('/api/portfolio/:wallet/history', async (req, res) => {
      try {
        const { days = 30 } = req.query;
        const history = await this.getPortfolioHistory(req.params.wallet, parseInt(days));
        res.json({ history });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get P&L
    this.app.get('/api/portfolio/:wallet/pnl', async (req, res) => {
      try {
        const { period = '30d' } = req.query;
        const pnl = await this.calculatePnL(req.params.wallet, period);
        res.json(pnl);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get tax report
    this.app.get('/api/portfolio/:wallet/tax/:year', async (req, res) => {
      try {
        const report = await this.generateTaxReport(req.params.wallet, parseInt(req.params.year));
        res.json(report);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Create price alert
    this.app.post('/api/alerts', async (req, res) => {
      try {
        const { wallet, assetAddress, alertType, targetPrice } = req.body;
        await this.createPriceAlert(wallet, assetAddress, alertType, targetPrice);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get alerts
    this.app.get('/api/alerts/:wallet', async (req, res) => {
      const result = await this.pg.query(
        'SELECT * FROM price_alerts WHERE wallet = $1',
        [req.params.wallet.toLowerCase()]
      );
      res.json({ alerts: result.rows });
    });
  }

  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n📊 Portfolio Tracker running on port ${CONFIG.port}`);
      console.log('\n📡 API Endpoints:');
      console.log('   GET  /api/portfolio/:wallet         - Get portfolio');
      console.log('   GET  /api/portfolio/:wallet/history - Portfolio history');
      console.log('   GET  /api/portfolio/:wallet/pnl     - P&L calculations');
      console.log('   GET  /api/portfolio/:wallet/tax/:year - Tax report');
      console.log('   POST /api/alerts                    - Create alert');
      console.log('   GET  /api/alerts/:wallet            - Get alerts\n');
    });
  }
}

// Main
async function main() {
  const tracker = new PortfolioTracker();
  await tracker.initialize();
  tracker.start();
}

main().catch(console.error);

module.exports = { PortfolioTracker };
