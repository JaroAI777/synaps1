import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts";
import {
  AgentRegistered,
  AgentDeregistered,
  StakeIncreased,
  StakeDecreased,
  ReputationUpdated,
  DisputeCreated,
  DisputeResolved,
  AgentSlashed,
  ServiceRated
} from "../generated/ReputationRegistry/ReputationRegistry";
import {
  Agent,
  Account,
  Dispute,
  Rating,
  SlashEvent,
  ProtocolStats,
  DailyStats
} from "../generated/schema";

function getOrCreateAccount(address: Bytes): Account {
  let id = address.toHexString();
  let account = Account.load(id);
  
  if (account == null) {
    account = new Account(id);
    account.balance = BigInt.fromI32(0);
    account.save();
  }
  
  return account;
}

function getOrCreateProtocolStats(): ProtocolStats {
  let stats = ProtocolStats.load("global");
  
  if (stats == null) {
    stats = new ProtocolStats("global");
    stats.totalPayments = 0;
    stats.totalPaymentVolume = BigInt.fromI32(0);
    stats.totalFees = BigInt.fromI32(0);
    stats.totalAgents = 0;
    stats.activeAgents = 0;
    stats.totalServices = 0;
    stats.activeServices = 0;
    stats.totalChannels = 0;
    stats.activeChannels = 0;
    stats.totalEscrows = 0;
    stats.totalStreams = 0;
    stats.updatedAt = BigInt.fromI32(0);
  }
  
  return stats;
}

function getDayId(timestamp: BigInt): string {
  let dayTimestamp = timestamp.toI32() / 86400;
  return dayTimestamp.toString();
}

function getOrCreateDailyStats(timestamp: BigInt): DailyStats {
  let id = getDayId(timestamp);
  let stats = DailyStats.load(id);
  
  if (stats == null) {
    stats = new DailyStats(id);
    stats.date = timestamp.toI32() / 86400 * 86400;
    stats.paymentCount = 0;
    stats.paymentVolume = BigInt.fromI32(0);
    stats.feesCollected = BigInt.fromI32(0);
    stats.newAgents = 0;
    stats.newServices = 0;
    stats.activeAgents = 0;
    stats.channelsOpened = 0;
    stats.channelsClosed = 0;
  }
  
  return stats;
}

export function handleAgentRegistered(event: AgentRegistered): void {
  let id = event.params.agent.toHexString();
  
  // Create or get account
  let account = getOrCreateAccount(event.params.agent);
  
  // Create agent
  let agent = new Agent(id);
  agent.account = account.id;
  agent.name = event.params.name;
  agent.stake = event.params.stake;
  agent.reputationScore = 500; // Initial score
  agent.tier = 0; // Unverified
  agent.totalTransactions = 0;
  agent.successfulTransactions = 0;
  agent.failedTransactions = 0;
  agent.totalVolumeSent = BigInt.fromI32(0);
  agent.totalVolumeReceived = BigInt.fromI32(0);
  agent.registeredAt = event.block.timestamp;
  agent.active = true;
  agent.save();
  
  // Link account to agent
  account.agent = id;
  account.save();
  
  // Update protocol stats
  let protocolStats = getOrCreateProtocolStats();
  protocolStats.totalAgents = protocolStats.totalAgents + 1;
  protocolStats.activeAgents = protocolStats.activeAgents + 1;
  protocolStats.updatedAt = event.block.timestamp;
  protocolStats.save();
  
  // Update daily stats
  let dailyStats = getOrCreateDailyStats(event.block.timestamp);
  dailyStats.newAgents = dailyStats.newAgents + 1;
  dailyStats.save();
}

export function handleAgentDeregistered(event: AgentDeregistered): void {
  let id = event.params.agent.toHexString();
  let agent = Agent.load(id);
  
  if (agent != null) {
    agent.active = false;
    agent.deregisteredAt = event.block.timestamp;
    agent.save();
    
    // Update protocol stats
    let protocolStats = getOrCreateProtocolStats();
    protocolStats.activeAgents = protocolStats.activeAgents - 1;
    protocolStats.updatedAt = event.block.timestamp;
    protocolStats.save();
  }
}

export function handleStakeIncreased(event: StakeIncreased): void {
  let id = event.params.agent.toHexString();
  let agent = Agent.load(id);
  
  if (agent != null) {
    agent.stake = event.params.newStake;
    agent.save();
  }
}

export function handleStakeDecreased(event: StakeDecreased): void {
  let id = event.params.agent.toHexString();
  let agent = Agent.load(id);
  
  if (agent != null) {
    agent.stake = event.params.newStake;
    agent.save();
  }
}

export function handleReputationUpdated(event: ReputationUpdated): void {
  let id = event.params.agent.toHexString();
  let agent = Agent.load(id);
  
  if (agent != null) {
    agent.reputationScore = event.params.newScore.toI32();
    agent.tier = event.params.newTier.toI32();
    agent.save();
  }
}

export function handleDisputeCreated(event: DisputeCreated): void {
  let id = event.params.disputeId.toHexString();
  
  let dispute = new Dispute(id);
  dispute.complainant = event.params.complainant.toHexString();
  dispute.defendant = event.params.defendant.toHexString();
  dispute.reason = event.params.reason;
  dispute.status = "PENDING";
  dispute.createdAt = event.block.timestamp;
  dispute.blockNumber = event.block.number;
  dispute.transactionHash = event.transaction.hash;
  dispute.save();
}

export function handleDisputeResolved(event: DisputeResolved): void {
  let id = event.params.disputeId.toHexString();
  let dispute = Dispute.load(id);
  
  if (dispute != null) {
    dispute.status = "RESOLVED";
    dispute.inFavorOfComplainant = event.params.inFavorOfComplainant;
    dispute.resolvedAt = event.block.timestamp;
    dispute.save();
    
    // Update agent stats based on resolution
    if (event.params.inFavorOfComplainant) {
      let defendant = Agent.load(dispute.defendant);
      if (defendant != null) {
        defendant.failedTransactions = defendant.failedTransactions + 1;
        defendant.save();
      }
    }
  }
}

export function handleAgentSlashed(event: AgentSlashed): void {
  let agentId = event.params.agent.toHexString();
  let agent = Agent.load(agentId);
  
  if (agent != null) {
    agent.stake = agent.stake.minus(event.params.amount);
    agent.save();
  }
  
  // Create slash event record
  let slashId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let slashEvent = new SlashEvent(slashId);
  slashEvent.agent = agentId;
  slashEvent.amount = event.params.amount;
  slashEvent.reason = event.params.reason;
  slashEvent.timestamp = event.block.timestamp;
  slashEvent.transactionHash = event.transaction.hash;
  slashEvent.save();
}

export function handleServiceRated(event: ServiceRated): void {
  let id = event.params.rater.toHexString() + "-" + 
           event.params.provider.toHexString() + "-" + 
           event.params.category;
  
  let rating = new Rating(id);
  rating.rater = event.params.rater.toHexString();
  rating.provider = event.params.provider.toHexString();
  rating.category = event.params.category;
  rating.rating = event.params.rating;
  rating.timestamp = event.block.timestamp;
  rating.transactionHash = event.transaction.hash;
  rating.save();
}
