/**
 * SYNAPSE Protocol - AI Service Marketplace Aggregator
 * 
 * Aggregates and indexes AI services from multiple providers
 * Features:
 * - Service discovery and search
 * - Price comparison
 * - Quality scoring
 * - Load balancing
 * - Automatic failover
 */

const express = require('express');
const { ethers } = require('ethers');
const Redis = require('ioredis');

// Configuration
const CONFIG = {
  port: process.env.PORT || 3002,
  rpcUrl: process.env.RPC_URL || 'http://localhost:8545',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  serviceRegistryAddress: process.env.SERVICE_REGISTRY_ADDRESS,
  reputationAddress: process.env.REPUTATION_ADDRESS,
  
  // Aggregator settings
  indexInterval: 60000, // Index every minute
  healthCheckInterval: 30000, // Health check every 30s
  maxConcurrentRequests: 10,
  requestTimeout: 30000, // 30s timeout
  
  // Scoring weights
  weights: {
    price: 0.25,
    reputation: 0.30,
    successRate: 0.25,
    latency: 0.20
  }
};

// Service categories
const CATEGORIES = [
  'language_model',
  'image_generation',
  'code_generation',
  'translation',
  'speech_to_text',
  'text_to_speech',
  'embedding',
  'data_analysis',
  'vision',
  'agent',
  'tool',
  'custom'
];

// Pricing models
const PRICING_MODELS = [
  'per_request',
  'per_token',
  'per_second',
  'per_byte',
  'subscription',
  'custom'
];

/**
 * Service Marketplace Aggregator
 */
class MarketplaceAggregator {
  constructor() {
    this.app = express();
    this.provider = null;
    this.redis = null;
    this.serviceRegistry = null;
    this.reputationRegistry = null;
    
    // In-memory service index
    this.services = new Map();
    this.servicesByCategory = new Map();
    this.serviceHealth = new Map();
    this.providerStats = new Map();
  }

  /**
   * Initialize aggregator
   */
  async initialize() {
    console.log('🔄 Initializing Marketplace Aggregator...');

    // Connect to Ethereum
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);

    // Connect to Redis
    try {
      this.redis = new Redis(CONFIG.redisUrl);
      console.log('📦 Connected to Redis');
    } catch (e) {
      console.log('⚠️ Redis not available');
    }

    // Initialize contracts
    this.initializeContracts();

    // Initial index
    await this.indexServices();

    // Start background jobs
    this.startIndexer();
    this.startHealthChecker();

    // Setup routes
    this.setupRoutes();

    console.log('✅ Aggregator initialized');
  }

  /**
   * Initialize contract instances
   */
  initializeContracts() {
    const serviceABI = [
      'function services(bytes32 serviceId) view returns (address provider, string name, string category, string description, string endpoint, uint256 basePrice, uint8 pricingModel, bool active, uint256 createdAt)',
      'function getServicesByCategory(string category) view returns (bytes32[])',
      'function calculatePrice(bytes32 serviceId, uint256 quantity) view returns (uint256)',
      'event ServiceRegistered(bytes32 indexed serviceId, address indexed provider, string name, string category)',
      'event ServiceUpdated(bytes32 indexed serviceId)',
      'event ServiceDeactivated(bytes32 indexed serviceId)'
    ];

    const reputationABI = [
      'function agents(address agent) view returns (bool registered, string name, string metadataUri, uint256 stake, uint256 reputationScore, uint256 totalTransactions, uint256 successfulTransactions, uint256 registeredAt)',
      'function getTier(address agent) view returns (uint8)',
      'function getSuccessRate(address agent) view returns (uint256)'
    ];

    if (CONFIG.serviceRegistryAddress) {
      this.serviceRegistry = new ethers.Contract(
        CONFIG.serviceRegistryAddress,
        serviceABI,
        this.provider
      );
    }

    if (CONFIG.reputationAddress) {
      this.reputationRegistry = new ethers.Contract(
        CONFIG.reputationAddress,
        reputationABI,
        this.provider
      );
    }
  }

  /**
   * Index all services from the registry
   */
  async indexServices() {
    console.log('📇 Indexing services...');

    // Clear current index
    this.services.clear();
    this.servicesByCategory.clear();

    for (const category of CATEGORIES) {
      try {
        const serviceIds = await this.serviceRegistry.getServicesByCategory(category);
        
        for (const serviceId of serviceIds) {
          try {
            const service = await this.serviceRegistry.services(serviceId);
            
            if (!service.active) continue;

            // Get provider reputation
            let reputation = { score: 0, tier: 0, successRate: 0 };
            try {
              const agent = await this.reputationRegistry.agents(service.provider);
              const tier = await this.reputationRegistry.getTier(service.provider);
              const successRate = await this.reputationRegistry.getSuccessRate(service.provider);
              
              reputation = {
                score: Number(agent.reputationScore),
                tier: Number(tier),
                successRate: Number(successRate) / 100
              };
            } catch (e) {
              // Provider not registered
            }

            // Get health status
            const health = this.serviceHealth.get(serviceId) || { 
              available: true, 
              latency: 0, 
              lastCheck: null 
            };

            const indexedService = {
              serviceId,
              provider: service.provider,
              name: service.name,
              category: service.category,
              description: service.description,
              endpoint: service.endpoint,
              basePrice: ethers.formatEther(service.basePrice),
              basePriceWei: service.basePrice,
              pricingModel: Number(service.pricingModel),
              pricingModelName: PRICING_MODELS[Number(service.pricingModel)],
              active: service.active,
              createdAt: new Date(Number(service.createdAt) * 1000),
              reputation,
              health,
              score: 0 // Will be calculated
            };

            // Calculate quality score
            indexedService.score = this.calculateScore(indexedService);

            // Add to index
            this.services.set(serviceId, indexedService);

            // Add to category index
            if (!this.servicesByCategory.has(category)) {
              this.servicesByCategory.set(category, []);
            }
            this.servicesByCategory.get(category).push(serviceId);

          } catch (e) {
            console.error(`Failed to index service ${serviceId}:`, e.message);
          }
        }
      } catch (e) {
        console.error(`Failed to get services for category ${category}:`, e.message);
      }
    }

    console.log(`📇 Indexed ${this.services.size} services`);

    // Cache to Redis
    if (this.redis) {
      await this.cacheIndex();
    }
  }

  /**
   * Calculate quality score for a service
   */
  calculateScore(service) {
    const { weights } = CONFIG;
    
    // Normalize price (lower is better, scale 0-100)
    const priceScore = Math.max(0, 100 - Number(service.basePrice) * 1000);
    
    // Reputation score (0-100)
    const reputationScore = service.reputation.score;
    
    // Success rate (0-100)
    const successRateScore = service.reputation.successRate;
    
    // Latency score (lower is better, scale 0-100)
    const latencyScore = service.health.available 
      ? Math.max(0, 100 - service.health.latency / 10)
      : 0;
    
    return (
      priceScore * weights.price +
      reputationScore * weights.reputation +
      successRateScore * weights.successRate +
      latencyScore * weights.latency
    );
  }

  /**
   * Cache index to Redis
   */
  async cacheIndex() {
    const services = Array.from(this.services.values());
    await this.redis.set('marketplace:services', JSON.stringify(services));
    await this.redis.set('marketplace:lastIndex', Date.now().toString());
    
    // Cache by category
    for (const [category, serviceIds] of this.servicesByCategory) {
      await this.redis.set(
        `marketplace:category:${category}`,
        JSON.stringify(serviceIds)
      );
    }
  }

  /**
   * Start indexer background job
   */
  startIndexer() {
    setInterval(async () => {
      try {
        await this.indexServices();
      } catch (e) {
        console.error('Indexer error:', e.message);
      }
    }, CONFIG.indexInterval);
  }

  /**
   * Start health checker background job
   */
  startHealthChecker() {
    setInterval(async () => {
      try {
        await this.checkServiceHealth();
      } catch (e) {
        console.error('Health checker error:', e.message);
      }
    }, CONFIG.healthCheckInterval);
  }

  /**
   * Check health of all services
   */
  async checkServiceHealth() {
    const promises = [];
    
    for (const [serviceId, service] of this.services) {
      promises.push(this.checkSingleServiceHealth(serviceId, service));
    }
    
    await Promise.all(promises);
  }

  /**
   * Check health of a single service
   */
  async checkSingleServiceHealth(serviceId, service) {
    try {
      const start = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${service.endpoint}/health`, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      const latency = Date.now() - start;
      
      this.serviceHealth.set(serviceId, {
        available: response.ok,
        latency,
        lastCheck: new Date(),
        statusCode: response.status
      });
      
      // Update service score
      if (this.services.has(serviceId)) {
        const svc = this.services.get(serviceId);
        svc.health = this.serviceHealth.get(serviceId);
        svc.score = this.calculateScore(svc);
      }
      
    } catch (e) {
      this.serviceHealth.set(serviceId, {
        available: false,
        latency: 0,
        lastCheck: new Date(),
        error: e.message
      });
    }
  }

  /**
   * Search services
   */
  searchServices(query) {
    const results = [];
    const queryLower = query.toLowerCase();
    
    for (const service of this.services.values()) {
      const nameMatch = service.name.toLowerCase().includes(queryLower);
      const descMatch = service.description.toLowerCase().includes(queryLower);
      const categoryMatch = service.category.toLowerCase().includes(queryLower);
      
      if (nameMatch || descMatch || categoryMatch) {
        results.push({
          ...service,
          relevance: nameMatch ? 3 : descMatch ? 2 : 1
        });
      }
    }
    
    // Sort by relevance then score
    return results.sort((a, b) => {
      if (b.relevance !== a.relevance) {
        return b.relevance - a.relevance;
      }
      return b.score - a.score;
    });
  }

  /**
   * Find best service for a request
   */
  findBestService(category, requirements = {}) {
    const categoryServices = this.servicesByCategory.get(category) || [];
    
    let candidates = categoryServices
      .map(id => this.services.get(id))
      .filter(s => s && s.health.available);
    
    // Apply filters
    if (requirements.maxPrice) {
      candidates = candidates.filter(s => 
        Number(s.basePrice) <= requirements.maxPrice
      );
    }
    
    if (requirements.minReputation) {
      candidates = candidates.filter(s => 
        s.reputation.score >= requirements.minReputation
      );
    }
    
    if (requirements.minTier) {
      candidates = candidates.filter(s => 
        s.reputation.tier >= requirements.minTier
      );
    }
    
    if (requirements.pricingModel !== undefined) {
      candidates = candidates.filter(s => 
        s.pricingModel === requirements.pricingModel
      );
    }
    
    // Sort by score
    candidates.sort((a, b) => b.score - a.score);
    
    return candidates[0] || null;
  }

  /**
   * Compare services
   */
  compareServices(serviceIds) {
    const services = serviceIds
      .map(id => this.services.get(id))
      .filter(s => s);
    
    if (services.length === 0) {
      return null;
    }
    
    // Find min/max for normalization
    const prices = services.map(s => Number(s.basePrice));
    const scores = services.map(s => s.score);
    const reputations = services.map(s => s.reputation.score);
    
    return {
      services: services.map(s => ({
        serviceId: s.serviceId,
        name: s.name,
        provider: s.provider,
        price: s.basePrice,
        pricingModel: s.pricingModelName,
        score: s.score,
        reputation: s.reputation,
        health: s.health
      })),
      comparison: {
        cheapest: services.reduce((a, b) => 
          Number(a.basePrice) < Number(b.basePrice) ? a : b
        ).serviceId,
        highestRated: services.reduce((a, b) => 
          a.score > b.score ? a : b
        ).serviceId,
        mostReliable: services.reduce((a, b) => 
          a.reputation.successRate > b.reputation.successRate ? a : b
        ).serviceId,
        fastest: services.reduce((a, b) => 
          a.health.latency < b.health.latency ? a : b
        ).serviceId
      },
      stats: {
        priceRange: { min: Math.min(...prices), max: Math.max(...prices) },
        scoreRange: { min: Math.min(...scores), max: Math.max(...scores) },
        avgReputation: reputations.reduce((a, b) => a + b, 0) / reputations.length
      }
    };
  }

  /**
   * Get service recommendations
   */
  getRecommendations(userHistory = []) {
    // Get all available services
    const available = Array.from(this.services.values())
      .filter(s => s.health.available);
    
    // If no history, return top rated
    if (userHistory.length === 0) {
      return available
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    }
    
    // Analyze user preferences
    const usedCategories = new Map();
    const usedPricingModels = new Map();
    let avgPrice = 0;
    
    for (const serviceId of userHistory) {
      const service = this.services.get(serviceId);
      if (service) {
        usedCategories.set(
          service.category, 
          (usedCategories.get(service.category) || 0) + 1
        );
        usedPricingModels.set(
          service.pricingModel,
          (usedPricingModels.get(service.pricingModel) || 0) + 1
        );
        avgPrice += Number(service.basePrice);
      }
    }
    avgPrice /= userHistory.length;
    
    // Score services based on user preferences
    const recommendations = available.map(service => {
      let preferenceScore = service.score;
      
      // Boost for preferred categories
      const categoryCount = usedCategories.get(service.category) || 0;
      preferenceScore += categoryCount * 5;
      
      // Boost for similar pricing
      const priceDiff = Math.abs(Number(service.basePrice) - avgPrice);
      preferenceScore -= priceDiff * 10;
      
      return {
        ...service,
        preferenceScore
      };
    });
    
    return recommendations
      .sort((a, b) => b.preferenceScore - a.preferenceScore)
      .slice(0, 10);
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
        servicesIndexed: this.services.size,
        categories: Array.from(this.servicesByCategory.keys())
      });
    });

    // List all categories
    this.app.get('/api/categories', (req, res) => {
      const categories = CATEGORIES.map(category => ({
        name: category,
        serviceCount: (this.servicesByCategory.get(category) || []).length
      }));
      res.json({ categories });
    });

    // Get services by category
    this.app.get('/api/services/category/:category', (req, res) => {
      const { category } = req.params;
      const { 
        sortBy = 'score', 
        order = 'desc',
        limit = 50,
        offset = 0
      } = req.query;
      
      const serviceIds = this.servicesByCategory.get(category) || [];
      let services = serviceIds
        .map(id => this.services.get(id))
        .filter(s => s);
      
      // Sort
      services.sort((a, b) => {
        const multiplier = order === 'desc' ? -1 : 1;
        switch (sortBy) {
          case 'price':
            return (Number(a.basePrice) - Number(b.basePrice)) * multiplier;
          case 'reputation':
            return (a.reputation.score - b.reputation.score) * multiplier;
          case 'score':
          default:
            return (a.score - b.score) * multiplier;
        }
      });
      
      // Paginate
      const paginated = services.slice(Number(offset), Number(offset) + Number(limit));
      
      res.json({
        category,
        total: services.length,
        services: paginated
      });
    });

    // Get single service
    this.app.get('/api/services/:serviceId', (req, res) => {
      const service = this.services.get(req.params.serviceId);
      if (!service) {
        return res.status(404).json({ error: 'Service not found' });
      }
      res.json(service);
    });

    // Search services
    this.app.get('/api/search', (req, res) => {
      const { q, limit = 20 } = req.query;
      if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" required' });
      }
      
      const results = this.searchServices(q).slice(0, Number(limit));
      res.json({
        query: q,
        count: results.length,
        results
      });
    });

    // Find best service
    this.app.post('/api/find-best', (req, res) => {
      const { category, requirements } = req.body;
      
      if (!category) {
        return res.status(400).json({ error: 'Category required' });
      }
      
      const best = this.findBestService(category, requirements);
      
      if (!best) {
        return res.status(404).json({ 
          error: 'No service found matching requirements' 
        });
      }
      
      res.json(best);
    });

    // Compare services
    this.app.post('/api/compare', (req, res) => {
      const { serviceIds } = req.body;
      
      if (!serviceIds || !Array.isArray(serviceIds) || serviceIds.length < 2) {
        return res.status(400).json({ 
          error: 'At least 2 serviceIds required' 
        });
      }
      
      const comparison = this.compareServices(serviceIds);
      
      if (!comparison) {
        return res.status(404).json({ error: 'Services not found' });
      }
      
      res.json(comparison);
    });

    // Get recommendations
    this.app.post('/api/recommendations', (req, res) => {
      const { history = [] } = req.body;
      const recommendations = this.getRecommendations(history);
      res.json({ recommendations });
    });

    // Get marketplace stats
    this.app.get('/api/stats', (req, res) => {
      const services = Array.from(this.services.values());
      const available = services.filter(s => s.health.available);
      
      const stats = {
        totalServices: services.length,
        availableServices: available.length,
        categories: CATEGORIES.map(c => ({
          name: c,
          count: (this.servicesByCategory.get(c) || []).length
        })),
        pricing: {
          average: services.reduce((sum, s) => sum + Number(s.basePrice), 0) / services.length,
          min: Math.min(...services.map(s => Number(s.basePrice))),
          max: Math.max(...services.map(s => Number(s.basePrice)))
        },
        reputation: {
          average: services.reduce((sum, s) => sum + s.reputation.score, 0) / services.length
        },
        health: {
          avgLatency: available.reduce((sum, s) => sum + s.health.latency, 0) / available.length,
          availability: (available.length / services.length) * 100
        },
        lastIndexed: new Date()
      };
      
      res.json(stats);
    });

    // Refresh index
    this.app.post('/api/refresh', async (req, res) => {
      await this.indexServices();
      res.json({ 
        success: true, 
        servicesIndexed: this.services.size 
      });
    });
  }

  /**
   * Start server
   */
  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n🏪 AI Service Marketplace Aggregator running on port ${CONFIG.port}`);
      console.log('\n📡 Endpoints:');
      console.log('   GET  /api/categories          - List categories');
      console.log('   GET  /api/services/category/:cat - Services by category');
      console.log('   GET  /api/services/:id        - Get service details');
      console.log('   GET  /api/search?q=query      - Search services');
      console.log('   POST /api/find-best           - Find best service');
      console.log('   POST /api/compare             - Compare services');
      console.log('   POST /api/recommendations     - Get recommendations');
      console.log('   GET  /api/stats               - Marketplace statistics');
      console.log('   POST /api/refresh             - Refresh index\n');
    });
  }
}

// Main entry point
async function main() {
  const aggregator = new MarketplaceAggregator();
  await aggregator.initialize();
  aggregator.start();
}

main().catch(console.error);

module.exports = { MarketplaceAggregator };
