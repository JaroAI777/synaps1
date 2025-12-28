/**
 * SYNAPSE Protocol - Analytics Aggregator Service
 * 
 * Collects, aggregates, and serves protocol analytics
 * Features:
 * - Real-time metrics collection
 * - Time-series data aggregation
 * - Customizable dashboards
 * - Export capabilities
 * - Alerting system
 */

const express = require('express');
const { ethers } = require('ethers');
const Redis = require('ioredis');
const cron = require('node-cron');

// Configuration
const CONFIG = {
  port: process.env.ANALYTICS_PORT || 3005,
  rpcUrl: process.env.RPC_URL || 'http://localhost:8545',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  
  // Aggregation intervals
  intervals: {
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800
  },
  
  // Retention periods (in seconds)
  retention: {
    minute: 86400,      // 1 day
    hour: 604800,       // 1 week
    day: 2592000,       // 30 days
    week: 31536000      // 1 year
  },
  
  // Alert thresholds
  alerts: {
    highVolume: 1000000,    // 1M SYNX
    lowTPS: 0.1,            // Less than 0.1 TPS
    highErrorRate: 0.05,    // More than 5% errors
    lowSuccessRate: 0.95    // Less than 95% success
  }
};

// Metric types
const MetricTypes = {
  COUNTER: 'counter',
  GAUGE: 'gauge',
  HISTOGRAM: 'histogram',
  SUMMARY: 'summary'
};

/**
 * Analytics Aggregator Service
 */
class AnalyticsAggregator {
  constructor() {
    this.app = express();
    this.redis = null;
    this.provider = null;
    
    // In-memory buffers
    this.metricBuffer = new Map();
    this.eventBuffer = [];
    
    // Active alerts
    this.activeAlerts = new Map();
    
    // Registered metrics
    this.metrics = new Map();
  }

  /**
   * Initialize service
   */
  async initialize() {
    console.log('📊 Initializing Analytics Aggregator...');

    // Connect to Redis
    try {
      this.redis = new Redis(CONFIG.redisUrl);
      console.log('📦 Connected to Redis');
    } catch (e) {
      console.log('⚠️ Redis not available');
    }

    // Connect to Ethereum
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);

    // Register default metrics
    this.registerDefaultMetrics();

    // Setup routes
    this.setupRoutes();

    // Start aggregation jobs
    this.startAggregationJobs();

    // Start alert checker
    this.startAlertChecker();

    console.log('✅ Analytics Aggregator initialized');
  }

  /**
   * Register default metrics
   */
  registerDefaultMetrics() {
    // Payment metrics
    this.registerMetric('payments_total', MetricTypes.COUNTER, 'Total number of payments');
    this.registerMetric('payments_volume', MetricTypes.COUNTER, 'Total payment volume in SYNX');
    this.registerMetric('payments_fee', MetricTypes.COUNTER, 'Total fees collected');
    this.registerMetric('payment_amount', MetricTypes.HISTOGRAM, 'Payment amount distribution');
    
    // Agent metrics
    this.registerMetric('agents_registered', MetricTypes.GAUGE, 'Number of registered agents');
    this.registerMetric('agents_active', MetricTypes.GAUGE, 'Number of active agents (24h)');
    this.registerMetric('agents_reputation_avg', MetricTypes.GAUGE, 'Average agent reputation');
    
    // Service metrics
    this.registerMetric('services_registered', MetricTypes.GAUGE, 'Number of registered services');
    this.registerMetric('services_active', MetricTypes.GAUGE, 'Number of active services');
    this.registerMetric('service_requests', MetricTypes.COUNTER, 'Total service requests');
    
    // Channel metrics
    this.registerMetric('channels_opened', MetricTypes.COUNTER, 'Total channels opened');
    this.registerMetric('channels_active', MetricTypes.GAUGE, 'Number of active channels');
    this.registerMetric('channels_volume', MetricTypes.COUNTER, 'Total channel volume');
    
    // Staking metrics
    this.registerMetric('staking_total', MetricTypes.GAUGE, 'Total staked SYNX');
    this.registerMetric('staking_apr', MetricTypes.GAUGE, 'Current staking APR');
    this.registerMetric('stakers_count', MetricTypes.GAUGE, 'Number of stakers');
    
    // Bridge metrics
    this.registerMetric('bridge_volume_out', MetricTypes.COUNTER, 'Total bridged out');
    this.registerMetric('bridge_volume_in', MetricTypes.COUNTER, 'Total bridged in');
    this.registerMetric('bridge_pending', MetricTypes.GAUGE, 'Pending bridge transfers');
    
    // Network metrics
    this.registerMetric('tps', MetricTypes.GAUGE, 'Transactions per second');
    this.registerMetric('gas_price', MetricTypes.GAUGE, 'Current gas price');
    this.registerMetric('block_number', MetricTypes.GAUGE, 'Current block number');
  }

  /**
   * Register a metric
   */
  registerMetric(name, type, description, labels = []) {
    this.metrics.set(name, {
      name,
      type,
      description,
      labels,
      createdAt: Date.now()
    });
  }

  /**
   * Record metric value
   */
  async recordMetric(name, value, labels = {}, timestamp = Date.now()) {
    const metric = this.metrics.get(name);
    if (!metric) {
      console.warn(`Unknown metric: ${name}`);
      return;
    }

    const key = this.buildMetricKey(name, labels);
    
    // Add to buffer
    if (!this.metricBuffer.has(key)) {
      this.metricBuffer.set(key, []);
    }
    this.metricBuffer.get(key).push({ value, timestamp });

    // Store in Redis
    if (this.redis) {
      const redisKey = `metric:${key}:${Math.floor(timestamp / 1000)}`;
      
      if (metric.type === MetricTypes.COUNTER) {
        await this.redis.incrbyfloat(redisKey, value);
      } else {
        await this.redis.set(redisKey, value);
      }
      
      await this.redis.expire(redisKey, CONFIG.retention.minute);
    }
  }

  /**
   * Record event
   */
  async recordEvent(eventType, data, timestamp = Date.now()) {
    const event = {
      type: eventType,
      data,
      timestamp
    };

    this.eventBuffer.push(event);

    // Store in Redis
    if (this.redis) {
      await this.redis.lpush('events:stream', JSON.stringify(event));
      await this.redis.ltrim('events:stream', 0, 9999);
    }
  }

  /**
   * Build metric key from name and labels
   */
  buildMetricKey(name, labels) {
    if (Object.keys(labels).length === 0) {
      return name;
    }
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${name}{${labelStr}}`;
  }

  /**
   * Aggregate metrics for interval
   */
  async aggregateMetrics(interval) {
    const now = Math.floor(Date.now() / 1000);
    const periodStart = now - CONFIG.intervals[interval];
    const bucketKey = `agg:${interval}:${now}`;

    for (const [name, metric] of this.metrics) {
      const key = `metric:${name}`;
      
      if (this.redis) {
        // Get values from Redis
        const pattern = `${key}:*`;
        const keys = await this.redis.keys(pattern);
        
        const values = [];
        for (const k of keys) {
          const ts = parseInt(k.split(':').pop());
          if (ts >= periodStart) {
            const val = await this.redis.get(k);
            values.push(parseFloat(val) || 0);
          }
        }

        if (values.length > 0) {
          const aggregated = this.calculateAggregates(values, metric.type);
          await this.redis.hset(bucketKey, name, JSON.stringify(aggregated));
        }
      }
    }

    // Set expiry for aggregated data
    if (this.redis) {
      await this.redis.expire(bucketKey, CONFIG.retention[interval]);
    }
  }

  /**
   * Calculate aggregates for values
   */
  calculateAggregates(values, type) {
    if (values.length === 0) return null;

    const sum = values.reduce((a, b) => a + b, 0);
    const sorted = [...values].sort((a, b) => a - b);

    return {
      count: values.length,
      sum,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sum / values.length,
      p50: this.percentile(sorted, 50),
      p95: this.percentile(sorted, 95),
      p99: this.percentile(sorted, 99)
    };
  }

  /**
   * Calculate percentile
   */
  percentile(sorted, p) {
    const idx = Math.ceil(sorted.length * (p / 100)) - 1;
    return sorted[Math.max(0, idx)];
  }

  /**
   * Start aggregation jobs
   */
  startAggregationJobs() {
    // Aggregate every minute
    cron.schedule('* * * * *', () => {
      this.aggregateMetrics('minute');
    });

    // Aggregate every hour
    cron.schedule('0 * * * *', () => {
      this.aggregateMetrics('hour');
    });

    // Aggregate every day
    cron.schedule('0 0 * * *', () => {
      this.aggregateMetrics('day');
    });

    // Aggregate every week
    cron.schedule('0 0 * * 0', () => {
      this.aggregateMetrics('week');
    });

    // Flush buffer every 10 seconds
    setInterval(() => this.flushBuffer(), 10000);

    console.log('📅 Aggregation jobs scheduled');
  }

  /**
   * Flush metric buffer
   */
  async flushBuffer() {
    // Process and clear buffer
    for (const [key, values] of this.metricBuffer) {
      if (values.length > 100) {
        // Keep only last 100 values in buffer
        this.metricBuffer.set(key, values.slice(-100));
      }
    }

    // Process event buffer
    if (this.eventBuffer.length > 1000) {
      this.eventBuffer = this.eventBuffer.slice(-1000);
    }
  }

  /**
   * Start alert checker
   */
  startAlertChecker() {
    setInterval(async () => {
      await this.checkAlerts();
    }, 60000); // Check every minute
  }

  /**
   * Check alert conditions
   */
  async checkAlerts() {
    // Check high volume alert
    const hourlyVolume = await this.getMetricValue('payments_volume', 'hour');
    if (hourlyVolume > CONFIG.alerts.highVolume) {
      this.triggerAlert('high_volume', {
        message: `High payment volume: ${hourlyVolume} SYNX/hour`,
        value: hourlyVolume,
        threshold: CONFIG.alerts.highVolume
      });
    }

    // Check low TPS alert
    const tps = await this.getMetricValue('tps', 'minute');
    if (tps < CONFIG.alerts.lowTPS) {
      this.triggerAlert('low_tps', {
        message: `Low TPS: ${tps}`,
        value: tps,
        threshold: CONFIG.alerts.lowTPS
      });
    }
  }

  /**
   * Trigger an alert
   */
  triggerAlert(alertId, data) {
    const alert = {
      id: alertId,
      ...data,
      triggeredAt: Date.now()
    };

    this.activeAlerts.set(alertId, alert);

    // Store in Redis
    if (this.redis) {
      this.redis.lpush('alerts:active', JSON.stringify(alert));
      this.redis.ltrim('alerts:active', 0, 99);
    }

    console.log(`🚨 Alert triggered: ${alertId}`);
  }

  /**
   * Get metric value for interval
   */
  async getMetricValue(name, interval) {
    if (!this.redis) return 0;

    const now = Math.floor(Date.now() / 1000);
    const bucketKey = `agg:${interval}:${now - (now % CONFIG.intervals[interval])}`;
    
    const data = await this.redis.hget(bucketKey, name);
    if (!data) return 0;

    const parsed = JSON.parse(data);
    return parsed.sum || 0;
  }

  /**
   * Get time series data
   */
  async getTimeSeries(metric, interval, count = 24) {
    if (!this.redis) return [];

    const now = Math.floor(Date.now() / 1000);
    const step = CONFIG.intervals[interval];
    const series = [];

    for (let i = 0; i < count; i++) {
      const ts = now - (i * step) - (now % step);
      const bucketKey = `agg:${interval}:${ts}`;
      const data = await this.redis.hget(bucketKey, metric);
      
      series.push({
        timestamp: ts * 1000,
        ...( data ? JSON.parse(data) : { sum: 0, avg: 0, count: 0 })
      });
    }

    return series.reverse();
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    this.app.use(express.json());

    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', '*');
      next();
    });

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        metricsCount: this.metrics.size,
        bufferSize: this.metricBuffer.size,
        activeAlerts: this.activeAlerts.size
      });
    });

    // Record metric
    this.app.post('/api/metrics', async (req, res) => {
      try {
        const { name, value, labels } = req.body;
        await this.recordMetric(name, value, labels);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Record event
    this.app.post('/api/events', async (req, res) => {
      try {
        const { type, data } = req.body;
        await this.recordEvent(type, data);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get metric info
    this.app.get('/api/metrics', (req, res) => {
      const metrics = Array.from(this.metrics.values());
      res.json({ metrics });
    });

    // Get time series
    this.app.get('/api/series/:metric', async (req, res) => {
      try {
        const { metric } = req.params;
        const { interval = 'hour', count = 24 } = req.query;
        const series = await this.getTimeSeries(metric, interval, parseInt(count));
        res.json({ metric, interval, series });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get current values
    this.app.get('/api/current', async (req, res) => {
      try {
        const values = {};
        
        for (const [name] of this.metrics) {
          values[name] = await this.getMetricValue(name, 'minute');
        }

        res.json({ values, timestamp: Date.now() });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get dashboard data
    this.app.get('/api/dashboard', async (req, res) => {
      try {
        const [
          paymentsTotal,
          paymentsVolume,
          agentsActive,
          servicesActive,
          stakingTotal,
          tps
        ] = await Promise.all([
          this.getMetricValue('payments_total', 'day'),
          this.getMetricValue('payments_volume', 'day'),
          this.getMetricValue('agents_active', 'hour'),
          this.getMetricValue('services_active', 'hour'),
          this.getMetricValue('staking_total', 'hour'),
          this.getMetricValue('tps', 'minute')
        ]);

        // Get time series for charts
        const volumeSeries = await this.getTimeSeries('payments_volume', 'hour', 24);
        const tpsSeries = await this.getTimeSeries('tps', 'minute', 60);

        res.json({
          summary: {
            paymentsTotal,
            paymentsVolume,
            agentsActive,
            servicesActive,
            stakingTotal,
            tps
          },
          charts: {
            volume: volumeSeries,
            tps: tpsSeries
          },
          alerts: Array.from(this.activeAlerts.values()),
          timestamp: Date.now()
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get alerts
    this.app.get('/api/alerts', (req, res) => {
      res.json({
        active: Array.from(this.activeAlerts.values()),
        thresholds: CONFIG.alerts
      });
    });

    // Acknowledge alert
    this.app.post('/api/alerts/:id/acknowledge', (req, res) => {
      const { id } = req.params;
      this.activeAlerts.delete(id);
      res.json({ success: true });
    });

    // Export data
    this.app.get('/api/export', async (req, res) => {
      try {
        const { metric, interval = 'hour', format = 'json' } = req.query;
        const series = await this.getTimeSeries(metric, interval, 168); // 1 week

        if (format === 'csv') {
          const csv = [
            'timestamp,sum,avg,min,max,count',
            ...series.map(s => 
              `${new Date(s.timestamp).toISOString()},${s.sum},${s.avg},${s.min},${s.max},${s.count}`
            )
          ].join('\n');

          res.set('Content-Type', 'text/csv');
          res.set('Content-Disposition', `attachment; filename="${metric}_${interval}.csv"`);
          res.send(csv);
        } else {
          res.json({ metric, interval, series });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Prometheus metrics endpoint
    this.app.get('/metrics', async (req, res) => {
      try {
        let output = '';

        for (const [name, metric] of this.metrics) {
          const value = await this.getMetricValue(name, 'minute');
          output += `# HELP synapse_${name} ${metric.description}\n`;
          output += `# TYPE synapse_${name} ${metric.type}\n`;
          output += `synapse_${name} ${value}\n`;
        }

        res.set('Content-Type', 'text/plain');
        res.send(output);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  /**
   * Start server
   */
  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n📊 Analytics Aggregator running on port ${CONFIG.port}`);
      console.log('\n📡 Endpoints:');
      console.log('   POST /api/metrics         - Record metric');
      console.log('   POST /api/events          - Record event');
      console.log('   GET  /api/metrics         - List metrics');
      console.log('   GET  /api/series/:metric  - Get time series');
      console.log('   GET  /api/current         - Current values');
      console.log('   GET  /api/dashboard       - Dashboard data');
      console.log('   GET  /api/alerts          - Active alerts');
      console.log('   GET  /api/export          - Export data');
      console.log('   GET  /metrics             - Prometheus format\n');
    });
  }
}

// Main entry point
async function main() {
  const aggregator = new AnalyticsAggregator();
  await aggregator.initialize();
  aggregator.start();
}

main().catch(console.error);

module.exports = { AnalyticsAggregator, MetricTypes };
