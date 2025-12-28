/**
 * SYNAPSE Protocol - Price Oracle Service
 * 
 * Multi-source price aggregation and reporting service
 * Features:
 * - Multiple price sources (exchanges, DEXs, oracles)
 * - TWAP calculation
 * - Anomaly detection
 * - On-chain price reporting
 */

const express = require('express');
const { ethers } = require('ethers');
const Redis = require('ioredis');
const cron = require('node-cron');

// Configuration
const CONFIG = {
  port: process.env.ORACLE_PORT || 3008,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  rpcUrl: process.env.RPC_URL,
  privateKey: process.env.ORACLE_PRIVATE_KEY,
  priceFeedAddress: process.env.PRICE_FEED_ADDRESS,
  
  // Update intervals
  updateInterval: 60,  // seconds
  heartbeat: 300,      // seconds
  
  // Price sources
  sources: {
    coingecko: {
      enabled: true,
      weight: 30,
      baseUrl: 'https://api.coingecko.com/api/v3'
    },
    chainlink: {
      enabled: true,
      weight: 40
    },
    uniswap: {
      enabled: true,
      weight: 30
    }
  },
  
  // Supported tokens
  tokens: [
    { symbol: 'SYNX', address: process.env.TOKEN_ADDRESS, coingeckoId: 'synapse-protocol' },
    { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', coingeckoId: 'ethereum' },
    { symbol: 'USDC', address: process.env.USDC_ADDRESS, coingeckoId: 'usd-coin' },
    { symbol: 'USDT', address: process.env.USDT_ADDRESS, coingeckoId: 'tether' }
  ],
  
  // Anomaly detection
  maxDeviation: 0.05, // 5% max deviation between sources
  maxPriceChange: 0.10 // 10% max change in short period
};

// Price Feed ABI
const PRICE_FEED_ABI = [
  'function reportPrice(address token, uint256 price) external',
  'function batchReportPrices(address[] tokens, uint256[] prices) external',
  'function getLatestPrice(address token) view returns (uint256 price, uint256 timestamp, uint8 decimals)'
];

/**
 * Price Oracle Service
 */
class PriceOracleService {
  constructor() {
    this.app = express();
    this.redis = null;
    this.provider = null;
    this.wallet = null;
    this.priceFeed = null;
    this.prices = new Map();
    this.priceHistory = new Map();
  }

  async initialize() {
    console.log('🔮 Initializing Price Oracle Service...');

    // Connect to Redis
    this.redis = new Redis(CONFIG.redisUrl);
    console.log('📦 Connected to Redis');

    // Connect to blockchain
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    this.wallet = new ethers.Wallet(CONFIG.privateKey, this.provider);
    this.priceFeed = new ethers.Contract(
      CONFIG.priceFeedAddress,
      PRICE_FEED_ABI,
      this.wallet
    );
    console.log('⛓️  Connected to blockchain');

    // Load cached prices
    await this.loadCachedPrices();

    // Setup routes
    this.setupRoutes();

    // Start price fetching
    this.startPriceFetching();

    console.log('✅ Price Oracle Service initialized');
  }

  async loadCachedPrices() {
    for (const token of CONFIG.tokens) {
      const cached = await this.redis.get(`price:${token.symbol}`);
      if (cached) {
        this.prices.set(token.symbol, JSON.parse(cached));
      }
    }
  }

  // ============ Price Fetching ============

  startPriceFetching() {
    // Fetch prices every minute
    cron.schedule(`*/${Math.floor(CONFIG.updateInterval / 60)} * * * *`, async () => {
      await this.fetchAndReportPrices();
    });

    // Initial fetch
    this.fetchAndReportPrices();

    console.log(`📊 Price fetching started (every ${CONFIG.updateInterval}s)`);
  }

  async fetchAndReportPrices() {
    console.log('🔄 Fetching prices...');

    const aggregatedPrices = [];

    for (const token of CONFIG.tokens) {
      try {
        const prices = await this.fetchPricesFromAllSources(token);
        const aggregated = this.aggregatePrices(prices, token);
        
        if (aggregated) {
          // Check for anomalies
          const isValid = this.validatePrice(token, aggregated);
          
          if (isValid) {
            this.prices.set(token.symbol, {
              price: aggregated.price,
              sources: aggregated.sources,
              timestamp: Date.now(),
              confidence: aggregated.confidence
            });

            // Cache in Redis
            await this.redis.set(
              `price:${token.symbol}`,
              JSON.stringify(this.prices.get(token.symbol)),
              'EX',
              CONFIG.heartbeat
            );

            // Store in history for TWAP
            await this.storePriceHistory(token.symbol, aggregated.price);

            aggregatedPrices.push({
              token: token.address,
              price: ethers.parseUnits(aggregated.price.toFixed(8), 8)
            });

            console.log(`  ${token.symbol}: $${aggregated.price.toFixed(4)} (confidence: ${(aggregated.confidence * 100).toFixed(1)}%)`);
          } else {
            console.warn(`  ⚠️  ${token.symbol}: Price anomaly detected, skipping`);
          }
        }
      } catch (error) {
        console.error(`  ❌ ${token.symbol}: ${error.message}`);
      }
    }

    // Report to on-chain oracle
    if (aggregatedPrices.length > 0) {
      await this.reportToChain(aggregatedPrices);
    }
  }

  async fetchPricesFromAllSources(token) {
    const prices = [];

    // CoinGecko
    if (CONFIG.sources.coingecko.enabled && token.coingeckoId) {
      try {
        const price = await this.fetchFromCoinGecko(token.coingeckoId);
        if (price) {
          prices.push({
            source: 'coingecko',
            price,
            weight: CONFIG.sources.coingecko.weight
          });
        }
      } catch (error) {
        console.error(`CoinGecko error for ${token.symbol}:`, error.message);
      }
    }

    // Chainlink (if available)
    if (CONFIG.sources.chainlink.enabled) {
      try {
        const price = await this.fetchFromChainlink(token);
        if (price) {
          prices.push({
            source: 'chainlink',
            price,
            weight: CONFIG.sources.chainlink.weight
          });
        }
      } catch (error) {
        // Chainlink might not have all tokens
      }
    }

    // Uniswap TWAP
    if (CONFIG.sources.uniswap.enabled && token.address !== ethers.ZeroAddress) {
      try {
        const price = await this.fetchFromUniswap(token);
        if (price) {
          prices.push({
            source: 'uniswap',
            price,
            weight: CONFIG.sources.uniswap.weight
          });
        }
      } catch (error) {
        // Pool might not exist
      }
    }

    return prices;
  }

  async fetchFromCoinGecko(coingeckoId) {
    const response = await fetch(
      `${CONFIG.sources.coingecko.baseUrl}/simple/price?ids=${coingeckoId}&vs_currencies=usd`
    );
    
    if (!response.ok) throw new Error('CoinGecko API error');
    
    const data = await response.json();
    return data[coingeckoId]?.usd;
  }

  async fetchFromChainlink(token) {
    // Chainlink aggregator addresses would be configured
    // This is a placeholder for the integration
    const chainlinkFeeds = {
      'ETH': '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
      'USDC': '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6'
    };

    const feedAddress = chainlinkFeeds[token.symbol];
    if (!feedAddress) return null;

    const feed = new ethers.Contract(
      feedAddress,
      ['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)'],
      this.provider
    );

    const [, answer] = await feed.latestRoundData();
    return Number(answer) / 1e8;
  }

  async fetchFromUniswap(token) {
    // Uniswap V3 TWAP implementation would go here
    // This is a placeholder
    return null;
  }

  // ============ Price Aggregation ============

  aggregatePrices(prices, token) {
    if (prices.length === 0) return null;

    // Check for significant deviations between sources
    if (prices.length >= 2) {
      const deviation = this.calculateMaxDeviation(prices);
      if (deviation > CONFIG.maxDeviation) {
        console.warn(`  ⚠️  ${token.symbol}: High deviation between sources (${(deviation * 100).toFixed(2)}%)`);
      }
    }

    // Calculate weighted average
    let totalWeight = 0;
    let weightedSum = 0;

    for (const p of prices) {
      weightedSum += p.price * p.weight;
      totalWeight += p.weight;
    }

    const weightedPrice = weightedSum / totalWeight;

    // Calculate confidence based on source count and agreement
    const confidence = this.calculateConfidence(prices, weightedPrice);

    return {
      price: weightedPrice,
      sources: prices.map(p => p.source),
      confidence,
      sourceCount: prices.length
    };
  }

  calculateMaxDeviation(prices) {
    const values = prices.map(p => p.price);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return (max - min) / min;
  }

  calculateConfidence(prices, aggregatedPrice) {
    // Base confidence on number of sources
    let confidence = Math.min(prices.length / 3, 1) * 0.5;

    // Add confidence based on agreement
    const deviations = prices.map(p => Math.abs(p.price - aggregatedPrice) / aggregatedPrice);
    const avgDeviation = deviations.reduce((a, b) => a + b, 0) / deviations.length;
    
    confidence += (1 - Math.min(avgDeviation / CONFIG.maxDeviation, 1)) * 0.5;

    return confidence;
  }

  // ============ Validation ============

  validatePrice(token, aggregated) {
    // Check against recent history
    const history = this.priceHistory.get(token.symbol) || [];
    
    if (history.length >= 5) {
      const recentAvg = history.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const change = Math.abs(aggregated.price - recentAvg) / recentAvg;
      
      if (change > CONFIG.maxPriceChange) {
        console.warn(`  ⚠️  ${token.symbol}: Price change ${(change * 100).toFixed(2)}% exceeds threshold`);
        return false;
      }
    }

    // Minimum confidence threshold
    if (aggregated.confidence < 0.5) {
      console.warn(`  ⚠️  ${token.symbol}: Low confidence ${(aggregated.confidence * 100).toFixed(1)}%`);
      return false;
    }

    return true;
  }

  async storePriceHistory(symbol, price) {
    const key = `price_history:${symbol}`;
    await this.redis.lpush(key, price.toString());
    await this.redis.ltrim(key, 0, 999); // Keep last 1000 prices

    // Update local cache
    if (!this.priceHistory.has(symbol)) {
      this.priceHistory.set(symbol, []);
    }
    const history = this.priceHistory.get(symbol);
    history.push(price);
    if (history.length > 100) history.shift();
  }

  // ============ On-Chain Reporting ============

  async reportToChain(prices) {
    try {
      const tokens = prices.map(p => p.token);
      const values = prices.map(p => p.price);

      const tx = await this.priceFeed.batchReportPrices(tokens, values);
      const receipt = await tx.wait();

      console.log(`✅ Reported ${prices.length} prices to chain (tx: ${receipt.hash.slice(0, 10)}...)`);
    } catch (error) {
      console.error('❌ Failed to report prices:', error.message);
    }
  }

  // ============ TWAP Calculation ============

  async getTWAP(symbol, period) {
    const key = `price_history:${symbol}`;
    const prices = await this.redis.lrange(key, 0, period - 1);
    
    if (prices.length === 0) return null;

    const sum = prices.reduce((a, b) => a + parseFloat(b), 0);
    return sum / prices.length;
  }

  // ============ API Routes ============

  setupRoutes() {
    this.app.use(express.json());

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        prices: this.prices.size,
        lastUpdate: Math.max(...Array.from(this.prices.values()).map(p => p.timestamp))
      });
    });

    // Get all prices
    this.app.get('/api/prices', (req, res) => {
      const prices = {};
      for (const [symbol, data] of this.prices) {
        prices[symbol] = {
          price: data.price,
          sources: data.sources,
          timestamp: data.timestamp,
          confidence: data.confidence,
          age: Date.now() - data.timestamp
        };
      }
      res.json({ prices });
    });

    // Get specific price
    this.app.get('/api/prices/:symbol', async (req, res) => {
      const { symbol } = req.params;
      const data = this.prices.get(symbol.toUpperCase());

      if (!data) {
        return res.status(404).json({ error: 'Price not found' });
      }

      // Get TWAP
      const twap1h = await this.getTWAP(symbol.toUpperCase(), 60);
      const twap24h = await this.getTWAP(symbol.toUpperCase(), 1440);

      res.json({
        symbol: symbol.toUpperCase(),
        price: data.price,
        sources: data.sources,
        timestamp: data.timestamp,
        confidence: data.confidence,
        twap: {
          '1h': twap1h,
          '24h': twap24h
        }
      });
    });

    // Get price history
    this.app.get('/api/prices/:symbol/history', async (req, res) => {
      const { symbol } = req.params;
      const { limit = 100 } = req.query;

      const key = `price_history:${symbol.toUpperCase()}`;
      const prices = await this.redis.lrange(key, 0, parseInt(limit) - 1);

      res.json({
        symbol: symbol.toUpperCase(),
        history: prices.map(p => parseFloat(p)),
        count: prices.length
      });
    });

    // Manual price refresh
    this.app.post('/api/refresh', async (req, res) => {
      try {
        await this.fetchAndReportPrices();
        res.json({ success: true, message: 'Prices refreshed' });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get supported tokens
    this.app.get('/api/tokens', (req, res) => {
      res.json({
        tokens: CONFIG.tokens.map(t => ({
          symbol: t.symbol,
          address: t.address
        }))
      });
    });

    // Get oracle stats
    this.app.get('/api/stats', async (req, res) => {
      const stats = {
        totalTokens: CONFIG.tokens.length,
        activePrices: this.prices.size,
        sources: Object.keys(CONFIG.sources).filter(s => CONFIG.sources[s].enabled),
        updateInterval: CONFIG.updateInterval,
        lastUpdate: Math.max(...Array.from(this.prices.values()).map(p => p.timestamp), 0)
      };

      res.json(stats);
    });
  }

  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n🔮 Price Oracle Service running on port ${CONFIG.port}`);
      console.log('\n📊 API Endpoints:');
      console.log('   GET  /api/prices              - All prices');
      console.log('   GET  /api/prices/:symbol      - Specific price + TWAP');
      console.log('   GET  /api/prices/:symbol/history - Price history');
      console.log('   POST /api/refresh             - Force refresh');
      console.log('   GET  /api/tokens              - Supported tokens');
      console.log('   GET  /api/stats               - Oracle statistics\n');
    });
  }
}

// Main
async function main() {
  const oracle = new PriceOracleService();
  await oracle.initialize();
  oracle.start();
}

main().catch(console.error);

module.exports = { PriceOracleService };
