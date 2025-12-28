import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  Payment as PaymentEvent,
  BatchPayment as BatchPaymentEvent,
  EscrowCreated,
  EscrowReleased,
  EscrowRefunded,
  StreamCreated,
  StreamWithdrawal as StreamWithdrawalEvent,
  StreamCancelled
} from "../generated/PaymentRouter/PaymentRouter";
import {
  Payment,
  BatchPayment,
  Escrow,
  Stream,
  StreamWithdrawal,
  Account,
  Agent,
  ProtocolStats,
  DailyStats,
  HourlyStats
} from "../generated/schema";

// Helper functions
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
    stats.save();
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
    stats.save();
  }
  
  return stats;
}

function getHourId(timestamp: BigInt): string {
  let hourTimestamp = timestamp.toI32() / 3600;
  return hourTimestamp.toString();
}

function getOrCreateHourlyStats(timestamp: BigInt): HourlyStats {
  let id = getHourId(timestamp);
  let stats = HourlyStats.load(id);
  
  if (stats == null) {
    stats = new HourlyStats(id);
    stats.timestamp = BigInt.fromI32(timestamp.toI32() / 3600 * 3600);
    stats.paymentCount = 0;
    stats.paymentVolume = BigInt.fromI32(0);
    stats.feesCollected = BigInt.fromI32(0);
    stats.save();
  }
  
  return stats;
}

// Event Handlers
export function handlePayment(event: PaymentEvent): void {
  let id = event.params.paymentId.toHexString();
  
  let payment = new Payment(id);
  payment.sender = getOrCreateAccount(event.params.sender).id;
  payment.recipient = getOrCreateAccount(event.params.recipient).id;
  payment.amount = event.params.amount;
  payment.fee = event.params.fee;
  payment.paymentId = event.params.paymentId;
  payment.timestamp = event.block.timestamp;
  payment.blockNumber = event.block.number;
  payment.transactionHash = event.transaction.hash;
  payment.save();
  
  // Update agent stats if sender is an agent
  let senderAgent = Agent.load(event.params.sender.toHexString());
  if (senderAgent != null) {
    senderAgent.totalTransactions = senderAgent.totalTransactions + 1;
    senderAgent.successfulTransactions = senderAgent.successfulTransactions + 1;
    senderAgent.totalVolumeSent = senderAgent.totalVolumeSent.plus(event.params.amount);
    senderAgent.save();
  }
  
  let recipientAgent = Agent.load(event.params.recipient.toHexString());
  if (recipientAgent != null) {
    recipientAgent.totalVolumeReceived = recipientAgent.totalVolumeReceived.plus(event.params.amount);
    recipientAgent.save();
  }
  
  // Update protocol stats
  let protocolStats = getOrCreateProtocolStats();
  protocolStats.totalPayments = protocolStats.totalPayments + 1;
  protocolStats.totalPaymentVolume = protocolStats.totalPaymentVolume.plus(event.params.amount);
  protocolStats.totalFees = protocolStats.totalFees.plus(event.params.fee);
  protocolStats.updatedAt = event.block.timestamp;
  protocolStats.save();
  
  // Update daily stats
  let dailyStats = getOrCreateDailyStats(event.block.timestamp);
  dailyStats.paymentCount = dailyStats.paymentCount + 1;
  dailyStats.paymentVolume = dailyStats.paymentVolume.plus(event.params.amount);
  dailyStats.feesCollected = dailyStats.feesCollected.plus(event.params.fee);
  dailyStats.save();
  
  // Update hourly stats
  let hourlyStats = getOrCreateHourlyStats(event.block.timestamp);
  hourlyStats.paymentCount = hourlyStats.paymentCount + 1;
  hourlyStats.paymentVolume = hourlyStats.paymentVolume.plus(event.params.amount);
  hourlyStats.feesCollected = hourlyStats.feesCollected.plus(event.params.fee);
  hourlyStats.save();
}

export function handleBatchPayment(event: BatchPaymentEvent): void {
  let id = event.transaction.hash.toHexString();
  
  let batchPayment = new BatchPayment(id);
  batchPayment.sender = getOrCreateAccount(event.params.sender).id;
  batchPayment.totalAmount = event.params.totalAmount;
  batchPayment.totalFees = event.params.totalFees;
  batchPayment.recipientCount = 0; // Would need to track from individual payments
  batchPayment.timestamp = event.block.timestamp;
  batchPayment.blockNumber = event.block.number;
  batchPayment.transactionHash = event.transaction.hash;
  batchPayment.save();
  
  // Update protocol stats
  let protocolStats = getOrCreateProtocolStats();
  protocolStats.totalPayments = protocolStats.totalPayments + 1;
  protocolStats.totalPaymentVolume = protocolStats.totalPaymentVolume.plus(event.params.totalAmount);
  protocolStats.totalFees = protocolStats.totalFees.plus(event.params.totalFees);
  protocolStats.updatedAt = event.block.timestamp;
  protocolStats.save();
}

export function handleEscrowCreated(event: EscrowCreated): void {
  let id = event.params.escrowId.toHexString();
  
  let escrow = new Escrow(id);
  escrow.sender = getOrCreateAccount(event.params.sender).id;
  escrow.recipient = getOrCreateAccount(event.params.recipient).id;
  escrow.arbiter = getOrCreateAccount(Bytes.empty()).id; // Would need arbiter from event
  escrow.amount = event.params.amount;
  escrow.deadline = event.params.deadline;
  escrow.paymentId = event.params.escrowId;
  escrow.status = "PENDING";
  escrow.createdAt = event.block.timestamp;
  escrow.blockNumber = event.block.number;
  escrow.transactionHash = event.transaction.hash;
  escrow.save();
  
  // Update protocol stats
  let protocolStats = getOrCreateProtocolStats();
  protocolStats.totalEscrows = protocolStats.totalEscrows + 1;
  protocolStats.updatedAt = event.block.timestamp;
  protocolStats.save();
}

export function handleEscrowReleased(event: EscrowReleased): void {
  let id = event.params.escrowId.toHexString();
  let escrow = Escrow.load(id);
  
  if (escrow != null) {
    escrow.status = "RELEASED";
    escrow.releasedAt = event.block.timestamp;
    escrow.save();
  }
}

export function handleEscrowRefunded(event: EscrowRefunded): void {
  let id = event.params.escrowId.toHexString();
  let escrow = Escrow.load(id);
  
  if (escrow != null) {
    escrow.status = "REFUNDED";
    escrow.refundedAt = event.block.timestamp;
    escrow.save();
  }
}

export function handleStreamCreated(event: StreamCreated): void {
  let id = event.params.streamId.toHexString();
  
  let stream = new Stream(id);
  stream.sender = getOrCreateAccount(event.params.sender).id;
  stream.recipient = getOrCreateAccount(event.params.recipient).id;
  stream.totalAmount = event.params.totalAmount;
  stream.withdrawnAmount = BigInt.fromI32(0);
  stream.startTime = event.params.startTime;
  stream.endTime = event.params.endTime;
  stream.status = "ACTIVE";
  stream.createdAt = event.block.timestamp;
  stream.blockNumber = event.block.number;
  stream.transactionHash = event.transaction.hash;
  stream.save();
  
  // Update protocol stats
  let protocolStats = getOrCreateProtocolStats();
  protocolStats.totalStreams = protocolStats.totalStreams + 1;
  protocolStats.updatedAt = event.block.timestamp;
  protocolStats.save();
}

export function handleStreamWithdrawal(event: StreamWithdrawalEvent): void {
  let streamId = event.params.streamId.toHexString();
  let stream = Stream.load(streamId);
  
  if (stream != null) {
    stream.withdrawnAmount = stream.withdrawnAmount.plus(event.params.amount);
    
    // Check if stream is complete
    if (stream.withdrawnAmount.ge(stream.totalAmount)) {
      stream.status = "COMPLETED";
    }
    stream.save();
    
    // Create withdrawal record
    let withdrawalId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
    let withdrawal = new StreamWithdrawal(withdrawalId);
    withdrawal.stream = streamId;
    withdrawal.amount = event.params.amount;
    withdrawal.timestamp = event.block.timestamp;
    withdrawal.transactionHash = event.transaction.hash;
    withdrawal.save();
  }
}

export function handleStreamCancelled(event: StreamCancelled): void {
  let id = event.params.streamId.toHexString();
  let stream = Stream.load(id);
  
  if (stream != null) {
    stream.status = "CANCELLED";
    stream.cancelledAt = event.block.timestamp;
    stream.save();
  }
}
