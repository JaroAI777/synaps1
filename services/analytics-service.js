/**
 * SYNAPSE Protocol - Analytics & Metrics Service
 * 
 * Real-time analytics and metrics collection
 * Features:
 * - Time-series data collection
 * - Aggregations and rollups
 * - Custom event tracking
 * - Dashboard API
 * - Export functionality
 */

const express = require('express');
const { ethers } = require('ethers');
const Redis = require('ioredis');

// Configuration
const CONFIG = {
  port: process.env.ANALYTICS_PORT || 3004,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  rpcUrl: process.env.RPC_URL || 'http://localhost:8545',
  
  // Retention periods (in seconds)
  retention: {
    minute: 24 * 60 * 60, // 24 hours
    hour: 7 * 24 * 60 * 60, // 7 days
    day: 90 * 24 * 60 * 60, // 90 days
    month: 365 * 24 * 60 * 60 // 1 year
  },
  
  // Aggregation intervals
  intervals: {
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2592000
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
 * Time Series Data Store
 */
class TimeSeriesStore {
  constructor(redis) {
    this.redis = redis;
  }

  /**
   * Record a data point
   */
  async record(metric, value, timestamp = Date.now(), tags = {}) {
    const key = this.buildKey(metric, tags);
    const score = timestamp;
    const member = JSON.stringify({ value, timestamp, tags });

    await this.redis.zadd(key, score, member);

    // Apply retention
    const retentionMs = CONFIG.retention.minute * 1000;
    await this.redis.zremrangebyscore(key, 0, timestamp - retentionMs);
  }

  /**
   * Query time range
   */
  async query(metric, startTime, endTime, tags = {}) {
    const key = this.buildKey(metric, tags);
    const results = await this.redis.zrangebyscore(key, startTime, endTime);
    return results.map(r => JSON.parse(r));
  }

  /**
   * Get latest value
   */
  async getLatest(metric, tags = {}) {
    const key = this.buildKey(metric, tags);
    const results = await this.redis.zrevrange(key, 0, 0);
    return results.length > 0 ? JSON.parse(results[0]) : null;
  }

  /**
   * Get aggregated value
   */
  async aggregate(metric, startTime, endTime, aggregation = 'sum', tags = {}) {
    const data = await this.query(metric, startTime, endTime, tags);
    const values = data.map(d => d.value);

    switch (aggregation) {
      case 'sum':
        return values.reduce((a, b) => a + b, 0);
      case 'avg':
        return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
      case 'count':
        return values.length;
      case 'last':
        return values.length > 0 ? values[values.length - 1] : null;
      default:
        return values;
    }
  }

  /**
   * Build Redis key
   */
  buildKey(metric, tags = {}) {
    let key = `ts:${metric}`;
    const tagStr = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    if (tagStr) key += `:${tagStr}`;
    return key;
  }
}

/**
 * Metrics Collector
 */
class MetricsCollector {
  constructor(redis) {
    this.redis = redis;
    this.timeSeries = new TimeSeriesStore(redis);
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
  }

  /**
   * Increment counter
   */
  async incrementCounter(name, value = 1, tags = {}) {
    const key = `counter:${name}`;
    await this.redis.incrbyfloat(key, value);
    await this.timeSeries.record(name, value, Date.now(), { ...tags, type: 'counter' });
  }

  /**
   * Set gauge value
   */
  async setGauge(name, value, tags = {}) {
    const key = `gauge:${name}`;
    await this.redis.set(key, value);
    await this.timeSeries.record(name, value, Date.now(), { ...tags, type: 'gauge' });
  }

  /**
   * Record histogram value
   */
  async recordHistogram(name, value, tags = {}) {
    const key = `histogram:${name}`;
    await this.redis.lpush(key, value);
    await this.redis.ltrim(key, 0, 9999); // Keep last 10000 values
    await this.timeSeries.record(name, value, Date.now(), { ...tags, type: 'histogram' });
  }

  /**
   * Get counter value
   */
  async getCounter(name) {
    const value = await this.redis.get(`counter:${name}`);
    return parseFloat(value) || 0;
  }

  /**
   * Get gauge value
   */
  async getGauge(name) {
    const value = await this.redis.get(`gauge:${name}`);
    return parseFloat(value) || 0;
  }

  /**
   * Get histogram statistics
   */
  async getHistogramStats(name) {
    const values = await this.redis.lrange(`histogram:${name}`, 0, -1);
    const nums = values.map(parseFloat).filter(n => !isNaN(n));

    if (nums.length === 0) {
      return { count: 0, sum: 0, avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
    }

    nums.sort((a, b) => a - b);

    return {
      count: nums.length,
      sum: nums.reduce((a, b) => a + b, 0),
      avg: nums.reduce((a, b) => a + b, 0) / nums.length,
      min: nums[0],
      max: nums[nums.length - 1],
      p50: nums[Math.floor(nums.length * 0.5)],
      p95: nums[Math.floor(nums.length * 0.95)],
      p99: nums[Math.floor(nums.length * 0.99)]
    };
  }
}

/**
 * Event Tracker
 */
class EventTracker {
  constructor(redis) {
    this.redis = redis;
    this.timeSeries = new TimeSeriesStore(redis);
  }

  /**
   * Track event
   */
  async track(eventName, properties = {}) {
    const event = {
      name: eventName,
      properties,
      timestamp: Date.now()
    };

    // Store in list
    const key = `events:${eventName}`;
    await this.redis.lpush(key, JSON.stringify(event));
    await this.redis.ltrim(key, 0, 9999);

    // Store in time series
    await this.timeSeries.record(`event:${eventName}`, 1, event.timestamp, properties);

    // Increment event counter
    await this.redis.incr(`event_count:${eventName}`);
    await this.redis.incr('event_count:total');
  }

  /**
   * Get events
   */
  async getEvents(eventName, limit = 100) {
    const key = `events:${eventName}`;
    const events = await this.redis.lrange(key, 0, limit - 1);
    return events.map(e => JSON.parse(e));
  }

  /**
   * Get event count
   */
  async getEventCount(eventName) {
    if (eventName) {
      return parseInt(await this.redis.get(`event_count:${eventName}`)) || 0;
    }
    return parseInt(await this.redis.get('event_count:total')) || 0;
  }

  /**
   * Get event timeline
   */
  async getTimeline(eventName, startTime, endTime, interval = 'hour') {
    const data = await this.timeSeries.query(
      `event:${eventName}`,
      startTime,
      endTime
    );

    // Group by interval
    const intervalMs = CONFIG.intervals[interval] * 1000;
    const buckets = new Map();

    for (const point of data) {
      const bucketTime = Math.floor(point.timestamp / intervalMs) * intervalMs;
      buckets.set(bucketTime, (buckets.get(bucketTime) || 0) + 1);
    }

    return Array.from(buckets.entries())
      .map(([timestamp, count]) => ({ timestamp, count }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }
}

/**
 * Analytics Service
 */
class AnalyticsService {
  constructor() {
    this.app = express();
    this.redis = null;
    this.provider = null;
    this.metrics = null;
    this.events = null;
    this.timeSeries = null;
  }

  /**
   * Initialize service
   */
  async initialize() {
    console.log('📊 Initializing Analytics Service...');

    // Connect to Redis
    this.redis = new Redis(CONFIG.redisUrl);
    console.log('📦 Connected to Redis');

    // Initialize components
    this.metrics = new MetricsCollector(this.redis);
    this.events = new EventTracker(this.redis);
    this.timeSeries = new TimeSeriesStore(this.redis);

    // Connect to Ethereum
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);

    // Setup routes
    this.setupRoutes();

    // Start background tasks
    this.startAggregationTasks();

    console.log('✅ Analytics Service initialized');
  }

  /**
   * Start background aggregation tasks
   */
  startAggregationTasks() {
    // Aggregate every minute
    setInterval(() => this.aggregateMetrics('minute'), 60000);

    // Aggregate every hour
    setInterval(() => this.aggregateMetrics('hour'), 3600000);

    // Aggregate every day
    setInterval(() => this.aggregateMetrics('day'), 86400000);
  }

  /**
   * Aggregate metrics for given interval
   */
  async aggregateMetrics(interval) {
    const now = Date.now();
    const intervalMs = CONFIG.intervals[interval] * 1000;
    const startTime = now - intervalMs;

    // Get all metrics keys
    const keys = await this.redis.keys('ts:*');

    for (const key of keys) {
      const metric = key.replace('ts:', '');
      
      try {
        const sum = await this.timeSeries.aggregate(metric, startTime, now, 'sum');
        const avg = await this.timeSeries.aggregate(metric, startTime, now, 'avg');
        const count = await this.timeSeries.aggregate(metric, startTime, now, 'count');

        // Store aggregated values
        await this.redis.hset(`agg:${interval}:${metric}`, {
          sum: sum.toString(),
          avg: avg.toString(),
          count: count.toString(),
          timestamp: now.toString()
        });
      } catch (e) {
        console.error(`Failed to aggregate ${metric}:`, e.message);
      }
    }
  }

  /**
   * Setup Express routes
   */
  setupRoutes() {
    this.app.use(express.json());

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    // ============ Metrics API ============

    // Record metric
    this.app.post('/api/metrics', async (req, res) => {
      try {
        const { name, type, value, tags } = req.body;

        switch (type) {
          case MetricTypes.COUNTER:
            await this.metrics.incrementCounter(name, value, tags);
            break;
          case MetricTypes.GAUGE:
            await this.metrics.setGauge(name, value, tags);
            break;
          case MetricTypes.HISTOGRAM:
            await this.metrics.recordHistogram(name, value, tags);
            break;
          default:
            return res.status(400).json({ error: 'Invalid metric type' });
        }

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get metric value
    this.app.get('/api/metrics/:name', async (req, res) => {
      try {
        const { name } = req.params;
        const { type = 'counter' } = req.query;

        let value;
        switch (type) {
          case MetricTypes.COUNTER:
            value = await this.metrics.getCounter(name);
            break;
          case MetricTypes.GAUGE:
            value = await this.metrics.getGauge(name);
            break;
          case MetricTypes.HISTOGRAM:
            value = await this.metrics.getHistogramStats(name);
            break;
        }

        res.json({ name, type, value });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Query time series
    this.app.get('/api/timeseries/:metric', async (req, res) => {
      try {
        const { metric } = req.params;
        const { start, end, aggregation } = req.query;

        const startTime = start ? parseInt(start) : Date.now() - 3600000;
        const endTime = end ? parseInt(end) : Date.now();

        if (aggregation) {
          const value = await this.timeSeries.aggregate(metric, startTime, endTime, aggregation);
          res.json({ metric, aggregation, value, startTime, endTime });
        } else {
          const data = await this.timeSeries.query(metric, startTime, endTime);
          res.json({ metric, data, startTime, endTime });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ============ Events API ============

    // Track event
    this.app.post('/api/events', async (req, res) => {
      try {
        const { name, properties } = req.body;
        await this.events.track(name, properties);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get events
    this.app.get('/api/events/:name', async (req, res) => {
      try {
        const { name } = req.params;
        const { limit = 100 } = req.query;

        const events = await this.events.getEvents(name, parseInt(limit));
        const count = await this.events.getEventCount(name);

        res.json({ name, count, events });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get event timeline
    this.app.get('/api/events/:name/timeline', async (req, res) => {
      try {
        const { name } = req.params;
        const { start, end, interval = 'hour' } = req.query;

        const startTime = start ? parseInt(start) : Date.now() - 86400000;
        const endTime = end ? parseInt(end) : Date.now();

        const timeline = await this.events.getTimeline(name, startTime, endTime, interval);
        res.json({ name, interval, timeline });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ============ Dashboard API ============

    // Get dashboard summary
    this.app.get('/api/dashboard/summary', async (req, res) => {
      try {
        const now = Date.now();
        const dayAgo = now - 86400000;

        const summary = {
          payments: {
            total: await this.metrics.getCounter('payments_total'),
            last24h: await this.timeSeries.aggregate('payments_total', dayAgo, now, 'sum'),
            volume: await this.metrics.getCounter('payment_volume'),
            volumeLast24h: await this.timeSeries.aggregate('payment_volume', dayAgo, now, 'sum')
          },
          agents: {
            active: await this.metrics.getGauge('active_agents'),
            registered: await this.metrics.getCounter('agent_registrations')
          },
          services: {
            active: await this.metrics.getGauge('active_services'),
            requests: await this.metrics.getCounter('service_requests')
          },
          channels: {
            open: await this.metrics.getGauge('open_channels'),
            volume: await this.metrics.getCounter('channel_volume')
          },
          staking: {
            totalStaked: await this.metrics.getGauge('total_staked'),
            stakers: await this.metrics.getGauge('total_stakers')
          },
          latency: await this.metrics.getHistogramStats('request_latency'),
          errorRate: await this.metrics.getGauge('error_rate')
        };

        res.json(summary);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get charts data
    this.app.get('/api/dashboard/charts/:chart', async (req, res) => {
      try {
        const { chart } = req.params;
        const { period = '24h' } = req.query;

        const periodMs = {
          '1h': 3600000,
          '24h': 86400000,
          '7d': 604800000,
          '30d': 2592000000
        }[period] || 86400000;

        const now = Date.now();
        const startTime = now - periodMs;
        const interval = periodMs > 86400000 ? 'day' : 'hour';

        let data;
        switch (chart) {
          case 'volume':
            data = await this.events.getTimeline('payment', startTime, now, interval);
            break;
          case 'transactions':
            data = await this.events.getTimeline('transaction', startTime, now, interval);
            break;
          case 'agents':
            data = await this.timeSeries.query('active_agents', startTime, now);
            break;
          default:
            return res.status(400).json({ error: 'Unknown chart type' });
        }

        res.json({ chart, period, data });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get top performers
    this.app.get('/api/dashboard/top/:type', async (req, res) => {
      try {
        const { type } = req.params;
        const { limit = 10 } = req.query;

        const key = `leaderboard:${type}`;
        const results = await this.redis.zrevrange(key, 0, parseInt(limit) - 1, 'WITHSCORES');

        const items = [];
        for (let i = 0; i < results.length; i += 2) {
          items.push({
            id: results[i],
            score: parseFloat(results[i + 1])
          });
        }

        res.json({ type, items });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ============ Export API ============

    // Export data
    this.app.get('/api/export', async (req, res) => {
      try {
        const { type, start, end, format = 'json' } = req.query;

        const startTime = start ? parseInt(start) : Date.now() - 86400000;
        const endTime = end ? parseInt(end) : Date.now();

        let data;
        switch (type) {
          case 'events':
            data = await this.timeSeries.query('event:*', startTime, endTime);
            break;
          case 'metrics':
            data = await this.timeSeries.query('*', startTime, endTime);
            break;
          default:
            return res.status(400).json({ error: 'Unknown export type' });
        }

        if (format === 'csv') {
          const csv = this.toCSV(data);
          res.setHeader('Content-Type', 'text/csv');
          res.setHeader('Content-Disposition', `attachment; filename=${type}_export.csv`);
          res.send(csv);
        } else {
          res.json({ type, startTime, endTime, data });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  /**
   * Convert data to CSV
   */
  toCSV(data) {
    if (data.length === 0) return '';

    const headers = Object.keys(data[0]);
    const rows = data.map(item => 
      headers.map(h => JSON.stringify(item[h] ?? '')).join(',')
    );

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Start server
   */
  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n📊 Analytics Service running on port ${CONFIG.port}`);
      console.log('\n📡 Endpoints:');
      console.log('   POST /api/metrics           - Record metric');
      console.log('   GET  /api/metrics/:name     - Get metric value');
      console.log('   GET  /api/timeseries/:metric - Query time series');
      console.log('   POST /api/events            - Track event');
      console.log('   GET  /api/events/:name      - Get events');
      console.log('   GET  /api/events/:name/timeline - Event timeline');
      console.log('   GET  /api/dashboard/summary - Dashboard summary');
      console.log('   GET  /api/dashboard/charts/:chart - Charts data');
      console.log('   GET  /api/dashboard/top/:type - Top performers');
      console.log('   GET  /api/export            - Export data\n');
    });
  }
}

// Main entry point
async function main() {
  const service = new AnalyticsService();
  await service.initialize();
  service.start();
}

main().catch(console.error);

module.exports = { AnalyticsService, MetricsCollector, EventTracker, TimeSeriesStore };
