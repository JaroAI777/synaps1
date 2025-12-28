/**
 * SYNAPSE Protocol - GraphQL API Server
 * 
 * Provides a unified GraphQL interface for querying protocol data
 * Combines on-chain data with The Graph indexing
 */

const express = require('express');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { ethers } = require('ethers');
const DataLoader = require('dataloader');
const Redis = require('ioredis');
const cors = require('cors');

// Configuration
const CONFIG = {
  port: process.env.PORT || 4000,
  rpcUrl: process.env.RPC_URL || 'http://localhost:8545',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  graphUrl: process.env.GRAPH_URL || 'http://localhost:8000/subgraphs/name/synapse',
  cacheTimeout: parseInt(process.env.CACHE_TIMEOUT) || 60
};

// GraphQL Schema
const typeDefs = `
  scalar BigInt
  scalar Bytes
  scalar DateTime

  type Query {
    # Token queries
    token: Token!
    tokenBalance(address: String!): BigInt!
    
    # Agent queries
    agent(address: String!): Agent
    agents(
      first: Int = 10
      skip: Int = 0
      orderBy: AgentOrderBy = reputationScore
      orderDirection: OrderDirection = desc
      where: AgentFilter
    ): [Agent!]!
    agentCount: Int!
    
    # Service queries
    service(id: ID!): Service
    services(
      first: Int = 10
      skip: Int = 0
      category: String
      active: Boolean
      orderBy: ServiceOrderBy = totalRevenue
      orderDirection: OrderDirection = desc
    ): [Service!]!
    serviceCount: Int!
    serviceCategories: [Category!]!
    
    # Payment queries
    payment(id: ID!): Payment
    payments(
      first: Int = 10
      skip: Int = 0
      sender: String
      recipient: String
      orderBy: PaymentOrderBy = timestamp
      orderDirection: OrderDirection = desc
    ): [Payment!]!
    paymentCount: Int!
    
    # Channel queries
    channel(id: ID!): Channel
    channels(
      first: Int = 10
      skip: Int = 0
      participant: String
      status: ChannelStatus
    ): [Channel!]!
    channelCount: Int!
    
    # Escrow queries
    escrow(id: ID!): Escrow
    escrows(
      first: Int = 10
      skip: Int = 0
      sender: String
      recipient: String
      status: EscrowStatus
    ): [Escrow!]!
    
    # Stream queries
    stream(id: ID!): Stream
    streams(
      first: Int = 10
      skip: Int = 0
      sender: String
      recipient: String
      status: StreamStatus
    ): [Stream!]!
    
    # Statistics
    protocolStats: ProtocolStats!
    dailyStats(days: Int = 30): [DailyStats!]!
    hourlyStats(hours: Int = 24): [HourlyStats!]!
    
    # Search
    search(query: String!): SearchResult!
  }

  type Mutation {
    # These would typically be handled by the SDK, but included for completeness
    refreshCache(key: String!): Boolean!
  }

  type Subscription {
    paymentReceived(recipient: String!): Payment!
    agentUpdated(address: String!): Agent!
    channelUpdated(id: ID!): Channel!
    newBlock: Block!
  }

  # Enums
  enum Tier {
    UNVERIFIED
    BRONZE
    SILVER
    GOLD
    PLATINUM
    DIAMOND
  }

  enum PricingModel {
    PER_REQUEST
    PER_TOKEN
    PER_SECOND
    PER_BYTE
    SUBSCRIPTION
    CUSTOM
  }

  enum ChannelStatus {
    NONE
    OPEN
    CLOSING
    CLOSED
  }

  enum EscrowStatus {
    PENDING
    RELEASED
    REFUNDED
    DISPUTED
  }

  enum StreamStatus {
    ACTIVE
    PAUSED
    CANCELLED
    COMPLETED
  }

  enum AgentOrderBy {
    reputationScore
    stake
    totalTransactions
    successRate
    registeredAt
  }

  enum ServiceOrderBy {
    totalRevenue
    totalRequests
    basePrice
    createdAt
  }

  enum PaymentOrderBy {
    amount
    timestamp
  }

  enum OrderDirection {
    asc
    desc
  }

  # Types
  type Token {
    address: String!
    name: String!
    symbol: String!
    decimals: Int!
    totalSupply: BigInt!
    totalBurned: BigInt!
    totalFees: BigInt!
    holders: Int!
  }

  type Agent {
    address: String!
    name: String!
    metadataUri: String
    stake: BigInt!
    reputationScore: Int!
    tier: Tier!
    totalTransactions: Int!
    successfulTransactions: Int!
    failedTransactions: Int!
    successRate: Float!
    totalVolumeSent: BigInt!
    totalVolumeReceived: BigInt!
    registeredAt: DateTime!
    active: Boolean!
    services: [Service!]!
    payments: [Payment!]!
    channels: [Channel!]!
    disputes: [Dispute!]!
    ratings: [Rating!]!
    averageRating: Float
  }

  type Service {
    id: ID!
    provider: Agent!
    name: String!
    category: Category!
    description: String!
    endpoint: String!
    basePrice: BigInt!
    pricingModel: PricingModel!
    active: Boolean!
    totalRequests: Int!
    totalRevenue: BigInt!
    averageResponseTime: Int
    uptime: Float
    createdAt: DateTime!
    updatedAt: DateTime
    quotes: [Quote!]!
  }

  type Category {
    id: ID!
    name: String!
    description: String
    serviceCount: Int!
    totalVolume: BigInt!
    services: [Service!]!
  }

  type Payment {
    id: ID!
    sender: Agent!
    recipient: Agent!
    amount: BigInt!
    fee: BigInt!
    metadata: Bytes
    timestamp: DateTime!
    transactionHash: String!
    blockNumber: Int!
  }

  type BatchPayment {
    id: ID!
    sender: Agent!
    recipients: [Agent!]!
    amounts: [BigInt!]!
    totalAmount: BigInt!
    totalFees: BigInt!
    timestamp: DateTime!
    transactionHash: String!
  }

  type Escrow {
    id: ID!
    sender: Agent!
    recipient: Agent!
    arbiter: Agent
    amount: BigInt!
    deadline: DateTime!
    status: EscrowStatus!
    createdAt: DateTime!
    releasedAt: DateTime
    transactionHash: String!
  }

  type Stream {
    id: ID!
    sender: Agent!
    recipient: Agent!
    totalAmount: BigInt!
    withdrawnAmount: BigInt!
    remainingAmount: BigInt!
    startTime: DateTime!
    endTime: DateTime!
    status: StreamStatus!
    createdAt: DateTime!
    withdrawals: [StreamWithdrawal!]!
  }

  type StreamWithdrawal {
    id: ID!
    stream: Stream!
    amount: BigInt!
    timestamp: DateTime!
    transactionHash: String!
  }

  type Channel {
    id: ID!
    participant1: Agent!
    participant2: Agent!
    balance1: BigInt!
    balance2: BigInt!
    totalDeposited: BigInt!
    nonce: Int!
    status: ChannelStatus!
    challengeEnd: DateTime
    createdAt: DateTime!
    closedAt: DateTime
    events: [ChannelEvent!]!
  }

  type ChannelEvent {
    id: ID!
    channel: Channel!
    type: String!
    data: String
    timestamp: DateTime!
    transactionHash: String!
  }

  type Dispute {
    id: ID!
    complainant: Agent!
    defendant: Agent!
    reason: String!
    transactionId: Bytes
    status: String!
    createdAt: DateTime!
    resolvedAt: DateTime
    resolution: String
    slashAmount: BigInt
  }

  type Rating {
    id: ID!
    rater: Agent!
    provider: Agent!
    category: String!
    rating: Int!
    comment: String
    timestamp: DateTime!
  }

  type Quote {
    id: ID!
    service: Service!
    requester: Agent!
    quantity: BigInt!
    price: BigInt!
    validUntil: DateTime!
    status: String!
    createdAt: DateTime!
    acceptedAt: DateTime
  }

  type ProtocolStats {
    totalPayments: Int!
    totalPaymentVolume: BigInt!
    totalFees: BigInt!
    totalAgents: Int!
    activeAgents: Int!
    totalServices: Int!
    activeServices: Int!
    totalChannels: Int!
    activeChannels: Int!
    totalEscrows: Int!
    totalStreams: Int!
    averagePaymentSize: BigInt!
    averageSuccessRate: Float!
  }

  type DailyStats {
    date: DateTime!
    payments: Int!
    volume: BigInt!
    fees: BigInt!
    newAgents: Int!
    newServices: Int!
    activeUsers: Int!
  }

  type HourlyStats {
    hour: DateTime!
    payments: Int!
    volume: BigInt!
    fees: BigInt!
  }

  type Block {
    number: Int!
    timestamp: DateTime!
    hash: String!
  }

  type SearchResult {
    agents: [Agent!]!
    services: [Service!]!
    payments: [Payment!]!
  }

  input AgentFilter {
    tier: Tier
    minStake: BigInt
    minReputation: Int
    active: Boolean
  }
`;

// Resolvers
const createResolvers = (dataSources) => ({
  Query: {
    // Token
    token: () => dataSources.contracts.getToken(),
    tokenBalance: (_, { address }) => dataSources.contracts.getBalance(address),
    
    // Agents
    agent: (_, { address }) => dataSources.graph.getAgent(address),
    agents: (_, args) => dataSources.graph.getAgents(args),
    agentCount: () => dataSources.graph.getAgentCount(),
    
    // Services
    service: (_, { id }) => dataSources.graph.getService(id),
    services: (_, args) => dataSources.graph.getServices(args),
    serviceCount: () => dataSources.graph.getServiceCount(),
    serviceCategories: () => dataSources.graph.getCategories(),
    
    // Payments
    payment: (_, { id }) => dataSources.graph.getPayment(id),
    payments: (_, args) => dataSources.graph.getPayments(args),
    paymentCount: () => dataSources.graph.getPaymentCount(),
    
    // Channels
    channel: (_, { id }) => dataSources.graph.getChannel(id),
    channels: (_, args) => dataSources.graph.getChannels(args),
    channelCount: () => dataSources.graph.getChannelCount(),
    
    // Escrows
    escrow: (_, { id }) => dataSources.graph.getEscrow(id),
    escrows: (_, args) => dataSources.graph.getEscrows(args),
    
    // Streams
    stream: (_, { id }) => dataSources.graph.getStream(id),
    streams: (_, args) => dataSources.graph.getStreams(args),
    
    // Stats
    protocolStats: () => dataSources.graph.getProtocolStats(),
    dailyStats: (_, { days }) => dataSources.graph.getDailyStats(days),
    hourlyStats: (_, { hours }) => dataSources.graph.getHourlyStats(hours),
    
    // Search
    search: (_, { query }) => dataSources.graph.search(query)
  },
  
  Mutation: {
    refreshCache: async (_, { key }) => {
      await dataSources.cache.del(key);
      return true;
    }
  },
  
  // Type resolvers
  Agent: {
    services: (agent, _, { dataSources }) => 
      dataSources.graph.getServicesByProvider(agent.address),
    payments: (agent, _, { dataSources }) =>
      dataSources.graph.getPaymentsByAddress(agent.address),
    channels: (agent, _, { dataSources }) =>
      dataSources.graph.getChannelsByParticipant(agent.address),
    disputes: (agent, _, { dataSources }) =>
      dataSources.graph.getDisputesByAgent(agent.address),
    ratings: (agent, _, { dataSources }) =>
      dataSources.graph.getRatingsByProvider(agent.address),
    averageRating: async (agent, _, { dataSources }) => {
      const ratings = await dataSources.graph.getRatingsByProvider(agent.address);
      if (ratings.length === 0) return null;
      return ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;
    }
  },
  
  Service: {
    provider: (service, _, { dataSources }) =>
      dataSources.graph.getAgent(service.provider),
    category: (service, _, { dataSources }) =>
      dataSources.graph.getCategory(service.category),
    quotes: (service, _, { dataSources }) =>
      dataSources.graph.getQuotesByService(service.id)
  },
  
  Payment: {
    sender: (payment, _, { dataSources }) =>
      dataSources.graph.getAgent(payment.sender),
    recipient: (payment, _, { dataSources }) =>
      dataSources.graph.getAgent(payment.recipient)
  },
  
  Channel: {
    participant1: (channel, _, { dataSources }) =>
      dataSources.graph.getAgent(channel.participant1),
    participant2: (channel, _, { dataSources }) =>
      dataSources.graph.getAgent(channel.participant2),
    events: (channel, _, { dataSources }) =>
      dataSources.graph.getChannelEvents(channel.id)
  },
  
  // Scalar resolvers
  BigInt: {
    __serialize: (value) => value.toString(),
    __parseValue: (value) => BigInt(value),
    __parseLiteral: (ast) => BigInt(ast.value)
  },
  
  DateTime: {
    __serialize: (value) => new Date(value * 1000).toISOString(),
    __parseValue: (value) => Math.floor(new Date(value).getTime() / 1000),
    __parseLiteral: (ast) => Math.floor(new Date(ast.value).getTime() / 1000)
  },
  
  Bytes: {
    __serialize: (value) => value,
    __parseValue: (value) => value,
    __parseLiteral: (ast) => ast.value
  }
});

// Data Sources
class ContractsDataSource {
  constructor(provider) {
    this.provider = provider;
  }
  
  async getToken() {
    // Get token info from contract
    return {
      address: process.env.TOKEN_ADDRESS,
      name: 'SYNAPSE',
      symbol: 'SYNX',
      decimals: 18,
      totalSupply: '1000000000000000000000000000',
      totalBurned: '0',
      totalFees: '0',
      holders: 0
    };
  }
  
  async getBalance(address) {
    // Get balance from contract
    return '0';
  }
}

class GraphDataSource {
  constructor(graphUrl, cache) {
    this.graphUrl = graphUrl;
    this.cache = cache;
  }
  
  async query(queryString, variables = {}) {
    const cacheKey = `graph:${JSON.stringify({ queryString, variables })}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
    
    try {
      const response = await fetch(this.graphUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryString, variables })
      });
      
      const { data } = await response.json();
      await this.cache.set(cacheKey, JSON.stringify(data), 'EX', CONFIG.cacheTimeout);
      return data;
    } catch (error) {
      console.error('Graph query error:', error);
      return null;
    }
  }
  
  async getAgent(address) {
    const data = await this.query(`
      query GetAgent($address: String!) {
        agent(id: $address) {
          id
          name
          stake
          reputationScore
          tier
          totalTransactions
          successfulTransactions
          failedTransactions
          totalVolumeSent
          totalVolumeReceived
          registeredAt
          active
        }
      }
    `, { address: address.toLowerCase() });
    
    if (!data?.agent) return null;
    
    return {
      ...data.agent,
      address: data.agent.id,
      successRate: data.agent.totalTransactions > 0
        ? (data.agent.successfulTransactions / data.agent.totalTransactions) * 100
        : 0
    };
  }
  
  async getAgents({ first, skip, orderBy, orderDirection, where }) {
    const data = await this.query(`
      query GetAgents($first: Int!, $skip: Int!, $orderBy: String!, $orderDirection: String!) {
        agents(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection) {
          id
          name
          stake
          reputationScore
          tier
          totalTransactions
          successfulTransactions
          registeredAt
          active
        }
      }
    `, { first, skip, orderBy, orderDirection });
    
    return data?.agents?.map(a => ({
      ...a,
      address: a.id,
      successRate: a.totalTransactions > 0
        ? (a.successfulTransactions / a.totalTransactions) * 100
        : 0
    })) || [];
  }
  
  async getAgentCount() {
    const data = await this.query(`
      query { protocolStats(id: "global") { totalAgents } }
    `);
    return data?.protocolStats?.totalAgents || 0;
  }
  
  async getService(id) {
    const data = await this.query(`
      query GetService($id: ID!) {
        service(id: $id) {
          id provider name category description endpoint
          basePrice pricingModel active totalRequests totalRevenue createdAt
        }
      }
    `, { id });
    return data?.service;
  }
  
  async getServices({ first, skip, category, active, orderBy, orderDirection }) {
    let whereClause = '';
    if (category) whereClause += `category: "${category}"`;
    if (active !== undefined) whereClause += `${whereClause ? ', ' : ''}active: ${active}`;
    
    const data = await this.query(`
      query GetServices($first: Int!, $skip: Int!, $orderBy: String!, $orderDirection: String!) {
        services(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection${whereClause ? `, where: {${whereClause}}` : ''}) {
          id provider name category description endpoint
          basePrice pricingModel active totalRequests totalRevenue createdAt
        }
      }
    `, { first, skip, orderBy, orderDirection });
    return data?.services || [];
  }
  
  async getServiceCount() {
    const data = await this.query(`
      query { protocolStats(id: "global") { totalServices } }
    `);
    return data?.protocolStats?.totalServices || 0;
  }
  
  async getCategories() {
    const data = await this.query(`
      query { categories { id name description serviceCount totalVolume } }
    `);
    return data?.categories || [];
  }
  
  async getPayment(id) {
    const data = await this.query(`
      query GetPayment($id: ID!) {
        payment(id: $id) {
          id sender recipient amount fee metadata timestamp transactionHash blockNumber
        }
      }
    `, { id });
    return data?.payment;
  }
  
  async getPayments({ first, skip, sender, recipient, orderBy, orderDirection }) {
    const data = await this.query(`
      query GetPayments($first: Int!, $skip: Int!, $orderBy: String!, $orderDirection: String!) {
        payments(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection) {
          id sender recipient amount fee timestamp transactionHash blockNumber
        }
      }
    `, { first, skip, orderBy, orderDirection });
    return data?.payments || [];
  }
  
  async getPaymentCount() {
    const data = await this.query(`
      query { protocolStats(id: "global") { totalPayments } }
    `);
    return data?.protocolStats?.totalPayments || 0;
  }
  
  async getChannel(id) {
    const data = await this.query(`
      query GetChannel($id: ID!) {
        channel(id: $id) {
          id participant1 participant2 balance1 balance2 nonce status challengeEnd createdAt closedAt
        }
      }
    `, { id });
    return data?.channel;
  }
  
  async getChannels({ first, skip, participant, status }) {
    const data = await this.query(`
      query GetChannels($first: Int!, $skip: Int!) {
        channels(first: $first, skip: $skip) {
          id participant1 participant2 balance1 balance2 nonce status createdAt
        }
      }
    `, { first, skip });
    return data?.channels || [];
  }
  
  async getChannelCount() {
    const data = await this.query(`
      query { protocolStats(id: "global") { totalChannels } }
    `);
    return data?.protocolStats?.totalChannels || 0;
  }
  
  async getEscrow(id) {
    const data = await this.query(`
      query GetEscrow($id: ID!) {
        escrow(id: $id) {
          id sender recipient arbiter amount deadline status createdAt releasedAt transactionHash
        }
      }
    `, { id });
    return data?.escrow;
  }
  
  async getEscrows({ first, skip }) {
    const data = await this.query(`
      query { escrows(first: ${first}, skip: ${skip}) {
        id sender recipient amount deadline status createdAt
      }}
    `);
    return data?.escrows || [];
  }
  
  async getStream(id) {
    const data = await this.query(`
      query GetStream($id: ID!) {
        stream(id: $id) {
          id sender recipient totalAmount withdrawnAmount startTime endTime status createdAt
        }
      }
    `, { id });
    if (!data?.stream) return null;
    return {
      ...data.stream,
      remainingAmount: (BigInt(data.stream.totalAmount) - BigInt(data.stream.withdrawnAmount)).toString()
    };
  }
  
  async getStreams({ first, skip }) {
    const data = await this.query(`
      query { streams(first: ${first}, skip: ${skip}) {
        id sender recipient totalAmount withdrawnAmount startTime endTime status createdAt
      }}
    `);
    return data?.streams || [];
  }
  
  async getProtocolStats() {
    const data = await this.query(`
      query { protocolStats(id: "global") {
        totalPayments totalPaymentVolume totalFees
        totalAgents activeAgents
        totalServices activeServices
        totalChannels activeChannels
        totalEscrows totalStreams
      }}
    `);
    
    const stats = data?.protocolStats || {};
    return {
      ...stats,
      averagePaymentSize: stats.totalPayments > 0
        ? (BigInt(stats.totalPaymentVolume || 0) / BigInt(stats.totalPayments || 1)).toString()
        : '0',
      averageSuccessRate: 98.5 // Would calculate from agent data
    };
  }
  
  async getDailyStats(days) {
    const data = await this.query(`
      query GetDailyStats($first: Int!) {
        dailyStats(first: $first, orderBy: date, orderDirection: desc) {
          date payments volume fees newAgents newServices activeUsers
        }
      }
    `, { first: days });
    return data?.dailyStats || [];
  }
  
  async getHourlyStats(hours) {
    const data = await this.query(`
      query GetHourlyStats($first: Int!) {
        hourlyStats(first: $first, orderBy: hour, orderDirection: desc) {
          hour payments volume fees
        }
      }
    `, { first: hours });
    return data?.hourlyStats || [];
  }
  
  async search(query) {
    // Search across multiple entities
    const [agents, services, payments] = await Promise.all([
      this.query(`query { agents(where: { name_contains_nocase: "${query}" }, first: 5) { id name } }`),
      this.query(`query { services(where: { name_contains_nocase: "${query}" }, first: 5) { id name } }`),
      this.query(`query { payments(where: { id_contains: "${query}" }, first: 5) { id } }`)
    ]);
    
    return {
      agents: agents?.agents || [],
      services: services?.services || [],
      payments: payments?.payments || []
    };
  }
  
  // Helper methods for nested resolvers
  async getServicesByProvider(address) {
    const data = await this.query(`
      query { services(where: { provider: "${address.toLowerCase()}" }) { id name category } }
    `);
    return data?.services || [];
  }
  
  async getPaymentsByAddress(address) {
    const addr = address.toLowerCase();
    const data = await this.query(`
      query { payments(where: { or: [{ sender: "${addr}" }, { recipient: "${addr}" }] }, first: 10) {
        id sender recipient amount timestamp
      }}
    `);
    return data?.payments || [];
  }
  
  async getChannelsByParticipant(address) {
    const addr = address.toLowerCase();
    const data = await this.query(`
      query { channels(where: { or: [{ participant1: "${addr}" }, { participant2: "${addr}" }] }) {
        id participant1 participant2 balance1 balance2 status
      }}
    `);
    return data?.channels || [];
  }
  
  async getDisputesByAgent(address) {
    return []; // Implementation
  }
  
  async getRatingsByProvider(address) {
    return []; // Implementation
  }
  
  async getCategory(id) {
    return { id, name: id, serviceCount: 0, totalVolume: '0' };
  }
  
  async getQuotesByService(serviceId) {
    return []; // Implementation
  }
  
  async getChannelEvents(channelId) {
    return []; // Implementation
  }
}

// Main server
async function startServer() {
  console.log('🚀 Starting SYNAPSE GraphQL Server...');
  
  // Initialize connections
  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  const redis = new Redis(CONFIG.redisUrl);
  
  // Create data sources
  const dataSources = {
    contracts: new ContractsDataSource(provider),
    graph: new GraphDataSource(CONFIG.graphUrl, redis),
    cache: redis
  };
  
  // Create schema
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: createResolvers(dataSources)
  });
  
  // Create Apollo server
  const server = new ApolloServer({
    schema,
    introspection: true,
    plugins: [
      {
        requestDidStart: async () => ({
          willSendResponse: async ({ response, contextValue }) => {
            // Add timing header
            response.http.headers.set('X-Response-Time', Date.now().toString());
          }
        })
      }
    ]
  });
  
  await server.start();
  
  // Create Express app
  const app = express();
  
  app.use(cors());
  
  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: Date.now() });
  });
  
  // GraphQL endpoint
  app.use('/graphql', express.json(), expressMiddleware(server, {
    context: async ({ req }) => ({
      dataSources,
      headers: req.headers
    })
  }));
  
  // Start listening
  app.listen(CONFIG.port, () => {
    console.log(`\n🌐 GraphQL Server running on http://localhost:${CONFIG.port}/graphql`);
    console.log('📊 GraphQL Playground available at the same URL\n');
  });
}

startServer().catch(console.error);

module.exports = { startServer };
