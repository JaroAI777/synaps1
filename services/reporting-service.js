/**
 * SYNAPSE Protocol - Reporting Service
 * 
 * Comprehensive reporting and analytics generation
 * Features:
 * - Protocol metrics reports
 * - User activity reports
 * - Financial summaries
 * - Scheduled report generation
 * - Export to multiple formats
 */

const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const { ethers } = require('ethers');

// Configuration
const CONFIG = {
  port: process.env.REPORTING_PORT || 3010,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  postgresUrl: process.env.DATABASE_URL || 'postgresql://localhost/synapse',
  
  // Report schedules
  schedules: {
    daily: '0 1 * * *',       // 1 AM daily
    weekly: '0 2 * * 1',      // 2 AM Monday
    monthly: '0 3 1 * *'      // 3 AM first of month
  }
};

/**
 * Reporting Service
 */
class ReportingService {
  constructor() {
    this.app = express();
    this.redis = null;
    this.pg = null;
  }

  async initialize() {
    console.log('📊 Initializing Reporting Service...');

    this.redis = new Redis(CONFIG.redisUrl);
    this.pg = new Pool({ connectionString: CONFIG.postgresUrl });
    
    await this.ensureTables();
    this.setupRoutes();
    this.scheduleReports();

    console.log('✅ Reporting Service initialized');
  }

  async ensureTables() {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        period VARCHAR(20) NOT NULL,
        period_start TIMESTAMP NOT NULL,
        period_end TIMESTAMP NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(type);
      CREATE INDEX IF NOT EXISTS idx_reports_period ON reports(period_start);
    `);
  }

  // ============ Report Generators ============

  /**
   * Generate protocol overview report
   */
  async generateProtocolReport(periodStart, periodEnd) {
    const report = {
      period: { start: periodStart, end: periodEnd },
      generated: new Date().toISOString(),
      sections: {}
    };

    // Transaction summary
    const txSummary = await this.pg.query(`
      SELECT 
        COUNT(*) as total_transactions,
        COALESCE(SUM(amount), 0) as total_volume,
        COALESCE(SUM(fee), 0) as total_fees,
        COUNT(DISTINCT from_address) as unique_senders,
        COUNT(DISTINCT to_address) as unique_recipients
      FROM transactions
      WHERE block_timestamp BETWEEN $1 AND $2
    `, [periodStart, periodEnd]);

    report.sections.transactions = txSummary.rows[0];

    // Payment breakdown
    const paymentBreakdown = await this.pg.query(`
      SELECT 
        payment_type,
        COUNT(*) as count,
        COALESCE(SUM(amount), 0) as volume
      FROM payments
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY payment_type
    `, [periodStart, periodEnd]);

    report.sections.paymentBreakdown = paymentBreakdown.rows;

    // Staking metrics
    const stakingMetrics = await this.pg.query(`
      SELECT 
        COUNT(*) as total_positions,
        COALESCE(SUM(amount), 0) as total_staked,
        COALESCE(SUM(rewards_claimed), 0) as rewards_claimed,
        AVG(amount) as avg_stake
      FROM staking_positions
      WHERE status = 'active'
    `);

    report.sections.staking = stakingMetrics.rows[0];

    // Agent activity
    const agentActivity = await this.pg.query(`
      SELECT 
        COUNT(*) as total_agents,
        COUNT(*) FILTER (WHERE is_active = true) as active_agents,
        AVG(reputation_score) as avg_reputation,
        COALESCE(SUM(total_transactions), 0) as total_agent_tx
      FROM agents
    `);

    report.sections.agents = agentActivity.rows[0];

    // Service usage
    const serviceUsage = await this.pg.query(`
      SELECT 
        COUNT(*) as total_services,
        COUNT(*) FILTER (WHERE is_active = true) as active_services,
        COALESCE(SUM(usage_count), 0) as total_usage
      FROM services
    `);

    report.sections.services = serviceUsage.rows[0];

    // Bridge activity
    const bridgeActivity = await this.pg.query(`
      SELECT 
        source_chain,
        target_chain,
        COUNT(*) as request_count,
        COALESCE(SUM(amount), 0) as volume,
        COUNT(*) FILTER (WHERE status = 'completed') as completed
      FROM bridge_requests
      WHERE initiated_at BETWEEN $1 AND $2
      GROUP BY source_chain, target_chain
    `, [periodStart, periodEnd]);

    report.sections.bridge = bridgeActivity.rows;

    // Top performers
    const topAgents = await this.pg.query(`
      SELECT address, name, reputation_score, total_transactions, tier
      FROM agents
      WHERE is_active = true
      ORDER BY reputation_score DESC
      LIMIT 10
    `);

    report.sections.topAgents = topAgents.rows;

    return report;
  }

  /**
   * Generate user activity report
   */
  async generateUserReport(userAddress, periodStart, periodEnd) {
    const report = {
      user: userAddress,
      period: { start: periodStart, end: periodEnd },
      generated: new Date().toISOString(),
      sections: {}
    };

    // Payment history
    const payments = await this.pg.query(`
      SELECT 
        payment_id, amount, fee, payment_type, created_at
      FROM payments
      WHERE (sender = $1 OR recipient = $1)
        AND created_at BETWEEN $2 AND $3
      ORDER BY created_at DESC
    `, [userAddress, periodStart, periodEnd]);

    report.sections.payments = {
      count: payments.rows.length,
      history: payments.rows
    };

    // Staking activity
    const staking = await this.pg.query(`
      SELECT 
        amount, lock_tier, rewards_claimed, staked_at, status
      FROM staking_positions
      WHERE user_address = $1
      ORDER BY staked_at DESC
    `, [userAddress]);

    report.sections.staking = staking.rows;

    // Subscriptions
    const subscriptions = await this.pg.query(`
      SELECT 
        plan_id, amount, status, start_date, end_date, usage_count
      FROM subscriptions
      WHERE subscriber = $1
    `, [userAddress]);

    report.sections.subscriptions = subscriptions.rows;

    // Summary stats
    const summary = await this.pg.query(`
      SELECT 
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE sender = $1) as total_sent,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE recipient = $1) as total_received,
        (SELECT COALESCE(SUM(amount), 0) FROM staking_positions WHERE user_address = $1 AND status = 'active') as total_staked
    `, [userAddress]);

    report.sections.summary = summary.rows[0];

    return report;
  }

  /**
   * Generate financial report
   */
  async generateFinancialReport(periodStart, periodEnd) {
    const report = {
      period: { start: periodStart, end: periodEnd },
      generated: new Date().toISOString(),
      sections: {}
    };

    // Revenue
    const revenue = await this.pg.query(`
      SELECT 
        DATE(block_timestamp) as date,
        COALESCE(SUM(fee), 0) as fees_collected
      FROM transactions
      WHERE block_timestamp BETWEEN $1 AND $2
      GROUP BY DATE(block_timestamp)
      ORDER BY date
    `, [periodStart, periodEnd]);

    report.sections.dailyRevenue = revenue.rows;

    // Total metrics
    const totals = await this.pg.query(`
      SELECT 
        COALESCE(SUM(fee), 0) as total_fees,
        COALESCE(SUM(amount), 0) as total_volume,
        COUNT(*) as transaction_count,
        AVG(fee) as avg_fee
      FROM transactions
      WHERE block_timestamp BETWEEN $1 AND $2
    `, [periodStart, periodEnd]);

    report.sections.totals = totals.rows[0];

    // TVL history
    const tvlHistory = await this.pg.query(`
      SELECT 
        date,
        value as tvl
      FROM aggregations
      WHERE metric = 'tvl' AND period = 'day'
        AND period_start BETWEEN $1 AND $2
      ORDER BY period_start
    `, [periodStart, periodEnd]);

    report.sections.tvlHistory = tvlHistory.rows;

    return report;
  }

  /**
   * Generate daily stats report
   */
  async generateDailyStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const stats = await this.pg.query(`
      INSERT INTO daily_stats (
        date,
        total_transactions,
        total_volume,
        total_fees,
        unique_users,
        new_users,
        active_agents,
        total_staked
      )
      SELECT 
        $1::date as date,
        (SELECT COUNT(*) FROM transactions WHERE DATE(block_timestamp) = $1),
        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE DATE(block_timestamp) = $1),
        (SELECT COALESCE(SUM(fee), 0) FROM transactions WHERE DATE(block_timestamp) = $1),
        (SELECT COUNT(DISTINCT from_address) FROM transactions WHERE DATE(block_timestamp) = $1),
        (SELECT COUNT(*) FROM users WHERE DATE(created_at) = $1),
        (SELECT COUNT(*) FROM agents WHERE is_active = true),
        (SELECT COALESCE(SUM(amount), 0) FROM staking_positions WHERE status = 'active')
      ON CONFLICT (date) DO UPDATE SET
        total_transactions = EXCLUDED.total_transactions,
        total_volume = EXCLUDED.total_volume,
        total_fees = EXCLUDED.total_fees,
        unique_users = EXCLUDED.unique_users,
        new_users = EXCLUDED.new_users,
        active_agents = EXCLUDED.active_agents,
        total_staked = EXCLUDED.total_staked
      RETURNING *
    `, [yesterday.toISOString().split('T')[0]]);

    return stats.rows[0];
  }

  // ============ Export Functions ============

  /**
   * Export report to Excel
   */
  async exportToExcel(report, filename) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SYNAPSE Protocol';
    workbook.created = new Date();

    // Summary sheet
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.columns = [
      { header: 'Metric', key: 'metric', width: 30 },
      { header: 'Value', key: 'value', width: 20 }
    ];

    if (report.sections.transactions) {
      summarySheet.addRow({ metric: 'Total Transactions', value: report.sections.transactions.total_transactions });
      summarySheet.addRow({ metric: 'Total Volume', value: ethers.formatEther(report.sections.transactions.total_volume || '0') });
      summarySheet.addRow({ metric: 'Total Fees', value: ethers.formatEther(report.sections.transactions.total_fees || '0') });
      summarySheet.addRow({ metric: 'Unique Senders', value: report.sections.transactions.unique_senders });
    }

    // Add other sheets based on report type
    for (const [sectionName, sectionData] of Object.entries(report.sections)) {
      if (Array.isArray(sectionData) && sectionData.length > 0) {
        const sheet = workbook.addWorksheet(sectionName);
        const columns = Object.keys(sectionData[0]).map(key => ({
          header: key,
          key: key,
          width: 15
        }));
        sheet.columns = columns;
        sectionData.forEach(row => sheet.addRow(row));
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  /**
   * Export report to PDF
   */
  async exportToPDF(report, filename) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument();
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fontSize(24).text('SYNAPSE Protocol Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(12).text(`Generated: ${report.generated}`, { align: 'center' });
      doc.moveDown(2);

      // Summary
      if (report.sections.transactions) {
        doc.fontSize(16).text('Transaction Summary');
        doc.moveDown(0.5);
        doc.fontSize(10);
        doc.text(`Total Transactions: ${report.sections.transactions.total_transactions}`);
        doc.text(`Total Volume: ${ethers.formatEther(report.sections.transactions.total_volume || '0')} SYNX`);
        doc.text(`Total Fees: ${ethers.formatEther(report.sections.transactions.total_fees || '0')} SYNX`);
        doc.moveDown();
      }

      // Staking
      if (report.sections.staking) {
        doc.fontSize(16).text('Staking Metrics');
        doc.moveDown(0.5);
        doc.fontSize(10);
        doc.text(`Total Staked: ${ethers.formatEther(report.sections.staking.total_staked || '0')} SYNX`);
        doc.text(`Total Positions: ${report.sections.staking.total_positions}`);
        doc.moveDown();
      }

      // Top Agents
      if (report.sections.topAgents && report.sections.topAgents.length > 0) {
        doc.fontSize(16).text('Top Agents');
        doc.moveDown(0.5);
        doc.fontSize(10);
        report.sections.topAgents.forEach((agent, i) => {
          doc.text(`${i + 1}. ${agent.name} - Reputation: ${agent.reputation_score}`);
        });
      }

      doc.end();
    });
  }

  // ============ Scheduled Reports ============

  scheduleReports() {
    // Daily report
    cron.schedule(CONFIG.schedules.daily, async () => {
      console.log('📊 Generating daily report...');
      try {
        await this.generateDailyStats();
        console.log('✅ Daily stats updated');
      } catch (error) {
        console.error('❌ Daily report failed:', error);
      }
    });

    // Weekly report
    cron.schedule(CONFIG.schedules.weekly, async () => {
      console.log('📊 Generating weekly report...');
      try {
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - 7);

        const report = await this.generateProtocolReport(start, end);
        await this.saveReport('weekly', start, end, report);
        console.log('✅ Weekly report generated');
      } catch (error) {
        console.error('❌ Weekly report failed:', error);
      }
    });

    // Monthly report
    cron.schedule(CONFIG.schedules.monthly, async () => {
      console.log('📊 Generating monthly report...');
      try {
        const end = new Date();
        const start = new Date();
        start.setMonth(start.getMonth() - 1);

        const report = await this.generateProtocolReport(start, end);
        await this.saveReport('monthly', start, end, report);
        console.log('✅ Monthly report generated');
      } catch (error) {
        console.error('❌ Monthly report failed:', error);
      }
    });

    console.log('📅 Report schedules configured');
  }

  async saveReport(type, periodStart, periodEnd, data) {
    await this.pg.query(`
      INSERT INTO reports (type, period, period_start, period_end, data)
      VALUES ($1, $2, $3, $4, $5)
    `, [type, type, periodStart, periodEnd, JSON.stringify(data)]);
  }

  // ============ API Routes ============

  setupRoutes() {
    this.app.use(express.json());

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'healthy' });
    });

    // Generate protocol report
    this.app.get('/api/reports/protocol', async (req, res) => {
      try {
        const { start, end } = req.query;
        const periodStart = start ? new Date(start) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const periodEnd = end ? new Date(end) : new Date();

        const report = await this.generateProtocolReport(periodStart, periodEnd);
        res.json(report);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Generate user report
    this.app.get('/api/reports/user/:address', async (req, res) => {
      try {
        const { address } = req.params;
        const { start, end } = req.query;
        const periodStart = start ? new Date(start) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const periodEnd = end ? new Date(end) : new Date();

        const report = await this.generateUserReport(address, periodStart, periodEnd);
        res.json(report);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Generate financial report
    this.app.get('/api/reports/financial', async (req, res) => {
      try {
        const { start, end } = req.query;
        const periodStart = start ? new Date(start) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const periodEnd = end ? new Date(end) : new Date();

        const report = await this.generateFinancialReport(periodStart, periodEnd);
        res.json(report);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Export to Excel
    this.app.get('/api/reports/protocol/excel', async (req, res) => {
      try {
        const { start, end } = req.query;
        const periodStart = start ? new Date(start) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const periodEnd = end ? new Date(end) : new Date();

        const report = await this.generateProtocolReport(periodStart, periodEnd);
        const buffer = await this.exportToExcel(report);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=synapse-report.xlsx');
        res.send(buffer);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Export to PDF
    this.app.get('/api/reports/protocol/pdf', async (req, res) => {
      try {
        const { start, end } = req.query;
        const periodStart = start ? new Date(start) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const periodEnd = end ? new Date(end) : new Date();

        const report = await this.generateProtocolReport(periodStart, periodEnd);
        const buffer = await this.exportToPDF(report);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=synapse-report.pdf');
        res.send(buffer);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get historical reports
    this.app.get('/api/reports/history', async (req, res) => {
      try {
        const { type, limit = 10 } = req.query;

        let query = 'SELECT id, type, period, period_start, period_end, created_at FROM reports';
        const params = [];

        if (type) {
          query += ' WHERE type = $1';
          params.push(type);
        }

        query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
        params.push(parseInt(limit));

        const result = await this.pg.query(query, params);
        res.json({ reports: result.rows });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get specific report
    this.app.get('/api/reports/:id', async (req, res) => {
      try {
        const result = await this.pg.query(
          'SELECT * FROM reports WHERE id = $1',
          [req.params.id]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Report not found' });
        }

        res.json(result.rows[0]);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get daily stats
    this.app.get('/api/stats/daily', async (req, res) => {
      try {
        const { days = 30 } = req.query;

        const result = await this.pg.query(`
          SELECT * FROM daily_stats
          ORDER BY date DESC
          LIMIT $1
        `, [parseInt(days)]);

        res.json({ stats: result.rows });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n📊 Reporting Service running on port ${CONFIG.port}`);
      console.log('\n📡 API Endpoints:');
      console.log('   GET  /api/reports/protocol       - Protocol report');
      console.log('   GET  /api/reports/user/:address  - User report');
      console.log('   GET  /api/reports/financial      - Financial report');
      console.log('   GET  /api/reports/protocol/excel - Export to Excel');
      console.log('   GET  /api/reports/protocol/pdf   - Export to PDF');
      console.log('   GET  /api/reports/history        - Historical reports');
      console.log('   GET  /api/stats/daily            - Daily statistics\n');
    });
  }
}

// Main
async function main() {
  const service = new ReportingService();
  await service.initialize();
  service.start();
}

main().catch(console.error);

module.exports = { ReportingService };
