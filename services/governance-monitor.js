/**
 * SYNAPSE Protocol - Governance Monitor Service
 * 
 * Monitors governance proposals and voting activity
 * Features:
 * - Proposal tracking and notifications
 * - Voting analysis and delegation
 * - Quorum monitoring
 * - Timelock execution tracking
 * - Governance participation metrics
 */

const express = require('express');
const { ethers } = require('ethers');
const Redis = require('ioredis');
const { Pool } = require('pg');
const cron = require('node-cron');

// Configuration
const CONFIG = {
  port: process.env.GOVERNANCE_PORT || 3013,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  postgresUrl: process.env.DATABASE_URL,
  rpcUrl: process.env.RPC_URL,
  wsUrl: process.env.WS_URL,

  contracts: {
    governance: process.env.GOVERNANCE_ADDRESS,
    timelock: process.env.TIMELOCK_ADDRESS,
    token: process.env.TOKEN_ADDRESS
  },

  // Governance parameters
  params: {
    quorumThreshold: 4, // 4% of total supply
    proposalThreshold: 1, // 1% to propose
    votingPeriod: 7 * 24 * 60 * 60, // 7 days
    timelockDelay: 2 * 24 * 60 * 60 // 2 days
  }
};

// Contract ABIs
const ABIS = {
  governance: [
    'function proposalCount() view returns (uint256)',
    'function proposals(uint256) view returns (uint256 id, address proposer, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, uint256 startBlock, uint256 endBlock, bool executed, bool cancelled)',
    'function getProposalState(uint256 proposalId) view returns (uint8)',
    'function quorum() view returns (uint256)',
    'function getVotes(address account) view returns (uint256)',
    'function hasVoted(uint256 proposalId, address account) view returns (bool)',
    'function delegates(address account) view returns (address)',
    'event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string description)',
    'event VoteCast(address indexed voter, uint256 indexed proposalId, uint8 support, uint256 weight)',
    'event ProposalExecuted(uint256 indexed proposalId)',
    'event ProposalCanceled(uint256 indexed proposalId)'
  ],
  timelock: [
    'function getTimestamp(bytes32 id) view returns (uint256)',
    'function isOperation(bytes32 id) view returns (bool)',
    'function isOperationPending(bytes32 id) view returns (bool)',
    'function isOperationReady(bytes32 id) view returns (bool)',
    'function isOperationDone(bytes32 id) view returns (bool)',
    'event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)',
    'event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)'
  ],
  token: [
    'function totalSupply() view returns (uint256)',
    'function getVotes(address account) view returns (uint256)',
    'function delegates(address account) view returns (address)'
  ]
};

// Proposal states
const ProposalState = {
  0: 'Pending',
  1: 'Active',
  2: 'Canceled',
  3: 'Defeated',
  4: 'Succeeded',
  5: 'Queued',
  6: 'Expired',
  7: 'Executed'
};

/**
 * Proposal data structure
 */
class Proposal {
  constructor(id, data, state, description = '') {
    this.id = id;
    this.proposer = data.proposer;
    this.forVotes = data.forVotes;
    this.againstVotes = data.againstVotes;
    this.abstainVotes = data.abstainVotes;
    this.startBlock = data.startBlock;
    this.endBlock = data.endBlock;
    this.executed = data.executed;
    this.cancelled = data.cancelled;
    this.state = state;
    this.stateName = ProposalState[state] || 'Unknown';
    this.description = description;
    this.lastUpdate = Date.now();
  }

  get totalVotes() {
    return this.forVotes + this.againstVotes + this.abstainVotes;
  }

  get forPercentage() {
    if (this.totalVotes === 0n) return 0;
    return Number((this.forVotes * 10000n) / this.totalVotes) / 100;
  }

  get againstPercentage() {
    if (this.totalVotes === 0n) return 0;
    return Number((this.againstVotes * 10000n) / this.totalVotes) / 100;
  }
}

/**
 * Governance Monitor Service
 */
class GovernanceMonitor {
  constructor() {
    this.app = express();
    this.redis = null;
    this.pg = null;
    this.provider = null;
    this.wsProvider = null;
    this.contracts = {};

    this.proposals = new Map();
    this.timelockOps = new Map();
    this.delegates = new Map();
    
    this.stats = {
      totalProposals: 0,
      activeProposals: 0,
      totalVotes: 0,
      uniqueVoters: new Set(),
      participationRate: 0,
      lastUpdate: null
    };
  }

  async initialize() {
    console.log('🏛️  Initializing Governance Monitor...');

    // Connect to databases
    this.redis = new Redis(CONFIG.redisUrl);
    this.pg = new Pool({ connectionString: CONFIG.postgresUrl });

    // Connect to blockchain
    this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    this.wsProvider = new ethers.WebSocketProvider(CONFIG.wsUrl);
    console.log('⛓️  Connected to blockchain');

    // Initialize contracts
    await this.initializeContracts();

    // Ensure database tables
    await this.ensureTables();

    // Load existing data
    await this.loadProposals();

    // Setup event listeners
    this.setupEventListeners();

    // Setup routes
    this.setupRoutes();

    // Schedule periodic tasks
    this.schedulesTasks();

    console.log('✅ Governance Monitor initialized');
  }

  async initializeContracts() {
    if (CONFIG.contracts.governance) {
      this.contracts.governance = new ethers.Contract(
        CONFIG.contracts.governance,
        ABIS.governance,
        this.provider
      );
      console.log(`  📄 Governance: ${CONFIG.contracts.governance.slice(0, 10)}...`);
    }

    if (CONFIG.contracts.timelock) {
      this.contracts.timelock = new ethers.Contract(
        CONFIG.contracts.timelock,
        ABIS.timelock,
        this.provider
      );
      console.log(`  📄 Timelock: ${CONFIG.contracts.timelock.slice(0, 10)}...`);
    }

    if (CONFIG.contracts.token) {
      this.contracts.token = new ethers.Contract(
        CONFIG.contracts.token,
        ABIS.token,
        this.provider
      );
    }
  }

  async ensureTables() {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS governance_proposals (
        id SERIAL PRIMARY KEY,
        proposal_id VARCHAR(78) UNIQUE NOT NULL,
        proposer VARCHAR(42) NOT NULL,
        description TEXT,
        for_votes NUMERIC,
        against_votes NUMERIC,
        abstain_votes NUMERIC,
        state VARCHAR(20),
        start_block BIGINT,
        end_block BIGINT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS governance_votes (
        id SERIAL PRIMARY KEY,
        proposal_id VARCHAR(78) NOT NULL,
        voter VARCHAR(42) NOT NULL,
        support INT,
        weight NUMERIC,
        tx_hash VARCHAR(66),
        block_number BIGINT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(proposal_id, voter)
      );

      CREATE TABLE IF NOT EXISTS governance_delegates (
        id SERIAL PRIMARY KEY,
        delegator VARCHAR(42) UNIQUE NOT NULL,
        delegate VARCHAR(42) NOT NULL,
        voting_power NUMERIC,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS timelock_operations (
        id SERIAL PRIMARY KEY,
        operation_id VARCHAR(66) UNIQUE NOT NULL,
        target VARCHAR(42),
        value NUMERIC,
        data TEXT,
        status VARCHAR(20),
        scheduled_at TIMESTAMP,
        executed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_proposals_state ON governance_proposals(state);
      CREATE INDEX IF NOT EXISTS idx_votes_proposal ON governance_votes(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_votes_voter ON governance_votes(voter);
    `);
  }

  async loadProposals() {
    if (!this.contracts.governance) return;

    try {
      const count = await this.contracts.governance.proposalCount();
      console.log(`  📊 Loading ${count} proposals...`);

      for (let i = 1n; i <= count; i++) {
        await this.fetchProposal(i);
      }

      this.stats.totalProposals = this.proposals.size;
      this.stats.activeProposals = Array.from(this.proposals.values())
        .filter(p => p.stateName === 'Active').length;

    } catch (error) {
      console.error('Failed to load proposals:', error.message);
    }
  }

  async fetchProposal(proposalId) {
    try {
      const data = await this.contracts.governance.proposals(proposalId);
      const state = await this.contracts.governance.getProposalState(proposalId);

      // Try to get description from database or events
      let description = '';
      const cached = await this.pg.query(
        'SELECT description FROM governance_proposals WHERE proposal_id = $1',
        [proposalId.toString()]
      );
      if (cached.rows.length > 0) {
        description = cached.rows[0].description;
      }

      const proposal = new Proposal(proposalId, {
        proposer: data.proposer,
        forVotes: data.forVotes,
        againstVotes: data.againstVotes,
        abstainVotes: data.abstainVotes,
        startBlock: data.startBlock,
        endBlock: data.endBlock,
        executed: data.executed,
        cancelled: data.cancelled
      }, state, description);

      this.proposals.set(proposalId.toString(), proposal);

      // Store in database
      await this.pg.query(`
        INSERT INTO governance_proposals 
          (proposal_id, proposer, description, for_votes, against_votes, abstain_votes, state, start_block, end_block)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (proposal_id) DO UPDATE SET
          for_votes = EXCLUDED.for_votes,
          against_votes = EXCLUDED.against_votes,
          abstain_votes = EXCLUDED.abstain_votes,
          state = EXCLUDED.state,
          updated_at = NOW()
      `, [
        proposalId.toString(),
        proposal.proposer,
        proposal.description,
        proposal.forVotes.toString(),
        proposal.againstVotes.toString(),
        proposal.abstainVotes.toString(),
        proposal.stateName,
        Number(proposal.startBlock),
        Number(proposal.endBlock)
      ]);

      return proposal;
    } catch (error) {
      console.error(`Failed to fetch proposal ${proposalId}:`, error.message);
      return null;
    }
  }

  setupEventListeners() {
    if (!CONFIG.wsUrl) return;

    // Governance events
    if (this.contracts.governance) {
      const governanceWs = new ethers.Contract(
        CONFIG.contracts.governance,
        ABIS.governance,
        this.wsProvider
      );

      governanceWs.on('ProposalCreated', async (proposalId, proposer, description, event) => {
        console.log(`📜 New proposal created: #${proposalId}`);
        await this.fetchProposal(proposalId);
        await this.notifyNewProposal(proposalId, proposer, description);
      });

      governanceWs.on('VoteCast', async (voter, proposalId, support, weight, event) => {
        console.log(`🗳️  Vote cast: ${voter.slice(0, 10)}... on #${proposalId}`);
        await this.recordVote(proposalId, voter, support, weight, event);
        await this.fetchProposal(proposalId);
      });

      governanceWs.on('ProposalExecuted', async (proposalId) => {
        console.log(`✅ Proposal executed: #${proposalId}`);
        await this.fetchProposal(proposalId);
        await this.notifyProposalExecuted(proposalId);
      });

      governanceWs.on('ProposalCanceled', async (proposalId) => {
        console.log(`❌ Proposal canceled: #${proposalId}`);
        await this.fetchProposal(proposalId);
      });
    }

    // Timelock events
    if (this.contracts.timelock) {
      const timelockWs = new ethers.Contract(
        CONFIG.contracts.timelock,
        ABIS.timelock,
        this.wsProvider
      );

      timelockWs.on('CallScheduled', async (id, index, target, value, data, predecessor, delay) => {
        console.log(`⏰ Timelock operation scheduled: ${id.slice(0, 10)}...`);
        await this.recordTimelockOperation(id, target, value, data, 'pending');
      });

      timelockWs.on('CallExecuted', async (id, index, target, value, data) => {
        console.log(`✅ Timelock operation executed: ${id.slice(0, 10)}...`);
        await this.updateTimelockStatus(id, 'executed');
      });
    }

    console.log('📡 Event listeners active');
  }

  async recordVote(proposalId, voter, support, weight, event) {
    try {
      await this.pg.query(`
        INSERT INTO governance_votes (proposal_id, voter, support, weight, tx_hash, block_number)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (proposal_id, voter) DO UPDATE SET
          support = EXCLUDED.support,
          weight = EXCLUDED.weight
      `, [
        proposalId.toString(),
        voter,
        support,
        weight.toString(),
        event.transactionHash,
        event.blockNumber
      ]);

      this.stats.totalVotes++;
      this.stats.uniqueVoters.add(voter.toLowerCase());
    } catch (error) {
      console.error('Failed to record vote:', error.message);
    }
  }

  async recordTimelockOperation(id, target, value, data, status) {
    try {
      await this.pg.query(`
        INSERT INTO timelock_operations (operation_id, target, value, data, status, scheduled_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (operation_id) DO UPDATE SET
          status = EXCLUDED.status
      `, [id, target, value.toString(), data, status]);

      this.timelockOps.set(id, { target, value, data, status });
    } catch (error) {
      console.error('Failed to record timelock operation:', error.message);
    }
  }

  async updateTimelockStatus(id, status) {
    try {
      await this.pg.query(`
        UPDATE timelock_operations SET status = $1, executed_at = NOW() WHERE operation_id = $2
      `, [status, id]);

      if (this.timelockOps.has(id)) {
        this.timelockOps.get(id).status = status;
      }
    } catch (error) {
      console.error('Failed to update timelock status:', error.message);
    }
  }

  async notifyNewProposal(proposalId, proposer, description) {
    // Integrate with notification service
    await this.redis.publish('governance:proposals', JSON.stringify({
      type: 'new_proposal',
      proposalId: proposalId.toString(),
      proposer,
      description,
      timestamp: Date.now()
    }));
  }

  async notifyProposalExecuted(proposalId) {
    await this.redis.publish('governance:proposals', JSON.stringify({
      type: 'proposal_executed',
      proposalId: proposalId.toString(),
      timestamp: Date.now()
    }));
  }

  // ============ Analysis Functions ============

  async getVotingPower(address) {
    if (!this.contracts.token) return 0n;
    return await this.contracts.token.getVotes(address);
  }

  async getDelegateInfo(address) {
    if (!this.contracts.governance) return null;
    
    const delegate = await this.contracts.governance.delegates(address);
    const votingPower = await this.getVotingPower(address);

    return {
      address,
      delegate,
      votingPower: ethers.formatEther(votingPower),
      isDelegating: delegate.toLowerCase() !== address.toLowerCase()
    };
  }

  async getParticipationRate() {
    if (!this.contracts.token) return 0;

    const totalSupply = await this.contracts.token.totalSupply();
    
    // Get total votes cast in recent proposals
    const result = await this.pg.query(`
      SELECT SUM(weight) as total_weight
      FROM governance_votes
      WHERE created_at > NOW() - INTERVAL '30 days'
    `);

    const totalVoted = BigInt(result.rows[0].total_weight || 0);
    return Number((totalVoted * 10000n) / totalSupply) / 100;
  }

  async getTopVoters(limit = 10) {
    const result = await this.pg.query(`
      SELECT voter, COUNT(*) as vote_count, SUM(weight::numeric) as total_weight
      FROM governance_votes
      GROUP BY voter
      ORDER BY total_weight DESC
      LIMIT $1
    `, [limit]);

    return result.rows;
  }

  async getProposalAnalytics(proposalId) {
    const proposal = this.proposals.get(proposalId.toString());
    if (!proposal) return null;

    const votes = await this.pg.query(`
      SELECT support, COUNT(*) as count, SUM(weight::numeric) as total_weight
      FROM governance_votes
      WHERE proposal_id = $1
      GROUP BY support
    `, [proposalId.toString()]);

    const voters = await this.pg.query(`
      SELECT voter, support, weight
      FROM governance_votes
      WHERE proposal_id = $1
      ORDER BY weight DESC
      LIMIT 20
    `, [proposalId.toString()]);

    return {
      proposal: {
        id: proposal.id.toString(),
        state: proposal.stateName,
        forVotes: ethers.formatEther(proposal.forVotes),
        againstVotes: ethers.formatEther(proposal.againstVotes),
        abstainVotes: ethers.formatEther(proposal.abstainVotes),
        forPercentage: proposal.forPercentage,
        againstPercentage: proposal.againstPercentage
      },
      voteBreakdown: votes.rows,
      topVoters: voters.rows
    };
  }

  // ============ Scheduled Tasks ============

  schedulesTasks() {
    // Update proposals every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
      console.log('🔄 Updating proposals...');
      await this.loadProposals();
    });

    // Calculate participation rate daily
    cron.schedule('0 0 * * *', async () => {
      this.stats.participationRate = await this.getParticipationRate();
    });

    // Check for expiring proposals hourly
    cron.schedule('0 * * * *', async () => {
      await this.checkExpiringProposals();
    });
  }

  async checkExpiringProposals() {
    const currentBlock = await this.provider.getBlockNumber();

    for (const [id, proposal] of this.proposals) {
      if (proposal.stateName === 'Active') {
        const blocksRemaining = Number(proposal.endBlock) - currentBlock;
        
        // Alert if less than 1 day remaining (assuming 12s blocks)
        if (blocksRemaining < 7200 && blocksRemaining > 0) {
          await this.redis.publish('governance:alerts', JSON.stringify({
            type: 'proposal_expiring',
            proposalId: id,
            blocksRemaining,
            estimatedTimeRemaining: blocksRemaining * 12 // seconds
          }));
        }
      }
    }
  }

  // ============ API Routes ============

  setupRoutes() {
    this.app.use(express.json());

    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        stats: {
          ...this.stats,
          uniqueVoters: this.stats.uniqueVoters.size
        }
      });
    });

    // Get all proposals
    this.app.get('/api/proposals', (req, res) => {
      const { state } = req.query;
      let proposals = Array.from(this.proposals.values());

      if (state) {
        proposals = proposals.filter(p => p.stateName.toLowerCase() === state.toLowerCase());
      }

      res.json({
        proposals: proposals.map(p => ({
          id: p.id.toString(),
          proposer: p.proposer,
          state: p.stateName,
          forVotes: ethers.formatEther(p.forVotes),
          againstVotes: ethers.formatEther(p.againstVotes),
          forPercentage: p.forPercentage,
          description: p.description
        })),
        count: proposals.length
      });
    });

    // Get proposal details
    this.app.get('/api/proposals/:id', async (req, res) => {
      const analytics = await this.getProposalAnalytics(req.params.id);
      if (!analytics) {
        return res.status(404).json({ error: 'Proposal not found' });
      }
      res.json(analytics);
    });

    // Get voting power
    this.app.get('/api/voting-power/:address', async (req, res) => {
      try {
        const power = await this.getVotingPower(req.params.address);
        res.json({ address: req.params.address, votingPower: ethers.formatEther(power) });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get delegate info
    this.app.get('/api/delegates/:address', async (req, res) => {
      try {
        const info = await this.getDelegateInfo(req.params.address);
        res.json(info);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get top voters
    this.app.get('/api/top-voters', async (req, res) => {
      const { limit = 10 } = req.query;
      const voters = await this.getTopVoters(parseInt(limit));
      res.json({ voters });
    });

    // Get participation stats
    this.app.get('/api/stats', async (req, res) => {
      res.json({
        totalProposals: this.stats.totalProposals,
        activeProposals: this.stats.activeProposals,
        totalVotes: this.stats.totalVotes,
        uniqueVoters: this.stats.uniqueVoters.size,
        participationRate: this.stats.participationRate
      });
    });

    // Get timelock operations
    this.app.get('/api/timelock', (req, res) => {
      const ops = Array.from(this.timelockOps.entries()).map(([id, data]) => ({
        id,
        ...data
      }));
      res.json({ operations: ops });
    });
  }

  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n🏛️  Governance Monitor running on port ${CONFIG.port}`);
      console.log('\n📡 API Endpoints:');
      console.log('   GET  /api/proposals           - All proposals');
      console.log('   GET  /api/proposals/:id       - Proposal details');
      console.log('   GET  /api/voting-power/:addr  - Voting power');
      console.log('   GET  /api/delegates/:addr     - Delegate info');
      console.log('   GET  /api/top-voters          - Top voters');
      console.log('   GET  /api/stats               - Participation stats');
      console.log('   GET  /api/timelock            - Timelock operations\n');
    });
  }
}

// Main
async function main() {
  const monitor = new GovernanceMonitor();
  await monitor.initialize();
  monitor.start();
}

main().catch(console.error);

module.exports = { GovernanceMonitor };
