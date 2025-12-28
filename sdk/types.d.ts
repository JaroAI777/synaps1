/**
 * SYNAPSE Protocol TypeScript Type Definitions
 * 
 * Complete type definitions for SYNAPSE Protocol SDK
 */

// ============ Enums ============

export enum Tier {
  UNVERIFIED = 0,
  BRONZE = 1,
  SILVER = 2,
  GOLD = 3,
  PLATINUM = 4,
  DIAMOND = 5
}

export enum PricingModel {
  PER_REQUEST = 0,
  PER_TOKEN = 1,
  PER_SECOND = 2,
  PER_BYTE = 3,
  SUBSCRIPTION = 4,
  CUSTOM = 5
}

export enum ChannelStatus {
  NONE = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3
}

export enum EscrowStatus {
  PENDING = 0,
  RELEASED = 1,
  REFUNDED = 2,
  DISPUTED = 3
}

export enum StreamStatus {
  ACTIVE = 0,
  COMPLETED = 1,
  CANCELLED = 2
}

export enum DisputeStatus {
  OPEN = 0,
  RESOLVED = 1,
  EXPIRED = 2
}

// ============ Configuration Types ============

export interface ContractAddresses {
  token: string;
  paymentRouter: string;
  reputation: string;
  serviceRegistry: string;
  paymentChannel: string;
  subscriptionManager?: string;
  staking?: string;
  governance?: string;
}

export interface SDKConfig {
  rpcUrl: string;
  privateKey?: string;
  contracts: ContractAddresses;
  gasLimit?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface NetworkInfo {
  chainId: number;
  name: string;
  blockNumber: number;
  gasPrice: bigint;
}

// ============ Token Types ============

export interface TokenBalance {
  balance: string;
  balanceWei: bigint;
  decimals: number;
}

export interface TokenAllowance {
  owner: string;
  spender: string;
  allowance: string;
  allowanceWei: bigint;
}

export interface TokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  totalSupplyWei: bigint;
}

// ============ Agent Types ============

export interface AgentInfo {
  address: string;
  registered: boolean;
  name: string;
  metadataUri: string;
  stake: string;
  stakeWei: bigint;
  reputationScore: number;
  tier: Tier;
  tierName: string;
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  successRate: number;
  registeredAt: Date;
}

export interface RegisterAgentParams {
  name: string;
  metadataUri?: string;
  stake: string;
}

export interface AgentStakeParams {
  amount: string;
}

export interface DisputeParams {
  defendant: string;
  reason: string;
  transactionId: string;
}

export interface DisputeInfo {
  disputeId: string;
  complainant: string;
  defendant: string;
  reason: string;
  transactionId: string;
  status: DisputeStatus;
  createdAt: Date;
  resolvedAt?: Date;
  inFavorOfComplainant?: boolean;
}

export interface RatingParams {
  provider: string;
  category: string;
  rating: number; // 1-5
}

// ============ Service Types ============

export interface ServiceInfo {
  serviceId: string;
  provider: string;
  name: string;
  category: string;
  description: string;
  endpoint: string;
  basePrice: string;
  basePriceWei: bigint;
  pricingModel: PricingModel;
  pricingModelName: string;
  active: boolean;
  createdAt: Date;
  totalRequests?: number;
  averageRating?: number;
}

export interface RegisterServiceParams {
  name: string;
  category: string;
  description: string;
  endpoint: string;
  basePrice: string;
  pricingModel: PricingModel;
}

export interface UpdateServiceParams {
  serviceId: string;
  description?: string;
  endpoint?: string;
  basePrice?: string;
}

export interface QuoteRequest {
  serviceId: string;
  quantity: number;
  specs?: Record<string, unknown>;
}

export interface QuoteInfo {
  quoteId: string;
  serviceId: string;
  requester: string;
  quantity: number;
  price: string;
  priceWei: bigint;
  validUntil: Date;
  accepted: boolean;
  createdAt: Date;
}

export interface ServiceCategory {
  name: string;
  description: string;
  serviceCount: number;
}

// ============ Payment Types ============

export interface PaymentParams {
  recipient: string;
  amount: string;
  metadata?: string;
}

export interface PaymentResult {
  transactionHash: string;
  paymentId: string;
  sender: string;
  recipient: string;
  amount: string;
  amountWei: bigint;
  fee: string;
  feeWei: bigint;
  blockNumber: number;
  timestamp: Date;
}

export interface BatchPaymentParams {
  payments: Array<{
    recipient: string;
    amount: string;
    metadata?: string;
  }>;
}

export interface BatchPaymentResult {
  transactionHash: string;
  totalAmount: string;
  totalFees: string;
  paymentCount: number;
  paymentIds: string[];
}

// ============ Escrow Types ============

export interface CreateEscrowParams {
  recipient: string;
  arbiter: string;
  amount: string;
  deadline: number; // Unix timestamp
  metadata?: string;
}

export interface EscrowInfo {
  escrowId: string;
  sender: string;
  recipient: string;
  arbiter: string;
  amount: string;
  amountWei: bigint;
  deadline: Date;
  status: EscrowStatus;
  statusName: string;
  createdAt: Date;
  releasedAt?: Date;
  refundedAt?: Date;
}

// ============ Stream Types ============

export interface CreateStreamParams {
  recipient: string;
  totalAmount: string;
  startTime: number; // Unix timestamp
  endTime: number; // Unix timestamp
}

export interface StreamInfo {
  streamId: string;
  sender: string;
  recipient: string;
  totalAmount: string;
  totalAmountWei: bigint;
  withdrawn: string;
  withdrawnWei: bigint;
  remaining: string;
  remainingWei: bigint;
  startTime: Date;
  endTime: Date;
  status: StreamStatus;
  statusName: string;
  withdrawable: string;
  withdrawableWei: bigint;
}

// ============ Channel Types ============

export interface OpenChannelParams {
  counterparty: string;
  myDeposit: string;
  theirDeposit?: string;
}

export interface ChannelInfo {
  channelId: string;
  participant1: string;
  participant2: string;
  balance1: string;
  balance1Wei: bigint;
  balance2: string;
  balance2Wei: bigint;
  nonce: number;
  status: ChannelStatus;
  statusName: string;
  challengeEnd?: Date;
}

export interface ChannelState {
  channelId: string;
  balance1: string;
  balance2: string;
  nonce: number;
}

export interface SignedChannelState extends ChannelState {
  signature1?: string;
  signature2?: string;
}

export interface CloseChannelParams {
  counterparty: string;
  balance1: string;
  balance2: string;
  nonce: number;
  signature1: string;
  signature2: string;
}

// ============ Subscription Types ============

export interface SubscriptionPlan {
  planId: string;
  provider: string;
  name: string;
  description: string;
  basePrice: string;
  basePriceWei: bigint;
  billingPeriod: number; // seconds
  trialPeriod: number; // seconds
  usageLimit: number;
  overageRate: string;
  active: boolean;
  subscriberCount: number;
  totalRevenue: string;
  createdAt: Date;
}

export interface CreatePlanParams {
  name: string;
  description: string;
  basePrice: string;
  billingPeriod: number;
  trialPeriod?: number;
  usageLimit?: number;
  overageRate?: string;
}

export interface SubscriptionInfo {
  subscriptionId: string;
  planId: string;
  subscriber: string;
  startTime: Date;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  usageThisPeriod: number;
  totalPaid: string;
  balance: string;
  active: boolean;
  inTrial: boolean;
  cancelledAt?: Date;
}

export interface SubscriptionStatus {
  active: boolean;
  inTrial: boolean;
  cancelled: boolean;
  expired: boolean;
  daysRemaining: number;
  usageRemaining: number;
}

// ============ Staking Types ============

export interface StakeInfo {
  address: string;
  amount: string;
  amountWei: bigint;
  shares: string;
  sharesWei: bigint;
  lockEnd?: Date;
  boostMultiplier: number;
  pendingRewards: string;
  pendingRewardsWei: bigint;
  cooldownAmount?: string;
  cooldownEnd?: Date;
  createdAt: Date;
}

export interface StakeParams {
  amount: string;
  lockTierId?: number;
}

export interface LockTier {
  tierId: number;
  duration: number; // seconds
  boostMultiplier: number; // 100 = 1x
  earlyWithdrawPenalty: number; // basis points
  active: boolean;
}

export interface StakingStats {
  totalStaked: string;
  totalStakedWei: bigint;
  totalStakers: number;
  totalShares: string;
  apr: number;
  rewardRate: string;
  rewardEndTime?: Date;
}

export interface RewardEpoch {
  epochId: number;
  startTime: Date;
  endTime: Date;
  totalRewards: string;
  rewardRate: string;
  distributed: boolean;
}

// ============ Governance Types ============

export interface Proposal {
  proposalId: string;
  proposer: string;
  targets: string[];
  values: bigint[];
  calldatas: string[];
  description: string;
  startBlock: number;
  endBlock: number;
  forVotes: string;
  againstVotes: string;
  abstainVotes: string;
  executed: boolean;
  cancelled: boolean;
  eta?: number;
}

export interface VoteParams {
  proposalId: string;
  support: 0 | 1 | 2; // Against, For, Abstain
  reason?: string;
}

export interface DelegateParams {
  delegatee: string;
}

// ============ Event Types ============

export interface PaymentEvent {
  type: 'payment';
  paymentId: string;
  sender: string;
  recipient: string;
  amount: string;
  fee: string;
  transactionHash: string;
  blockNumber: number;
  timestamp: Date;
}

export interface AgentEvent {
  type: 'agent_registered' | 'agent_deregistered' | 'reputation_updated' | 'stake_changed';
  agent: string;
  data: Record<string, unknown>;
  transactionHash: string;
  blockNumber: number;
  timestamp: Date;
}

export interface ServiceEvent {
  type: 'service_registered' | 'service_updated' | 'quote_requested' | 'quote_accepted';
  serviceId: string;
  data: Record<string, unknown>;
  transactionHash: string;
  blockNumber: number;
  timestamp: Date;
}

export interface ChannelEvent {
  type: 'channel_opened' | 'channel_funded' | 'channel_closing' | 'channel_closed';
  channelId: string;
  data: Record<string, unknown>;
  transactionHash: string;
  blockNumber: number;
  timestamp: Date;
}

export type ProtocolEvent = PaymentEvent | AgentEvent | ServiceEvent | ChannelEvent;

// ============ Error Types ============

export class SynapseError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SynapseError';
  }
}

export class InsufficientBalanceError extends SynapseError {
  constructor(required: string, available: string) {
    super(
      `Insufficient balance: required ${required}, available ${available}`,
      'INSUFFICIENT_BALANCE',
      { required, available }
    );
    this.name = 'InsufficientBalanceError';
  }
}

export class TransactionFailedError extends SynapseError {
  constructor(transactionHash: string, reason?: string) {
    super(
      `Transaction failed: ${reason || 'unknown reason'}`,
      'TRANSACTION_FAILED',
      { transactionHash, reason }
    );
    this.name = 'TransactionFailedError';
  }
}

export class InvalidSignatureError extends SynapseError {
  constructor() {
    super('Invalid signature', 'INVALID_SIGNATURE');
    this.name = 'InvalidSignatureError';
  }
}

export class AgentNotRegisteredError extends SynapseError {
  constructor(address: string) {
    super(`Agent not registered: ${address}`, 'AGENT_NOT_REGISTERED', { address });
    this.name = 'AgentNotRegisteredError';
  }
}

export class ServiceNotFoundError extends SynapseError {
  constructor(serviceId: string) {
    super(`Service not found: ${serviceId}`, 'SERVICE_NOT_FOUND', { serviceId });
    this.name = 'ServiceNotFoundError';
  }
}

export class ChannelNotFoundError extends SynapseError {
  constructor(channelId: string) {
    super(`Channel not found: ${channelId}`, 'CHANNEL_NOT_FOUND', { channelId });
    this.name = 'ChannelNotFoundError';
  }
}

export class QuoteExpiredError extends SynapseError {
  constructor(quoteId: string) {
    super(`Quote expired: ${quoteId}`, 'QUOTE_EXPIRED', { quoteId });
    this.name = 'QuoteExpiredError';
  }
}

// ============ SDK Interface ============

export interface ISynapseSDK {
  // Configuration
  readonly config: SDKConfig;
  readonly address: string;
  
  // Network
  getNetworkInfo(): Promise<NetworkInfo>;
  
  // Token
  getBalance(address?: string): Promise<TokenBalance>;
  transfer(to: string, amount: string): Promise<PaymentResult>;
  approve(spender: string, amount: string): Promise<string>;
  approveAll(): Promise<string[]>;
  
  // Payments
  pay(params: PaymentParams): Promise<PaymentResult>;
  batchPay(params: BatchPaymentParams): Promise<BatchPaymentResult>;
  createEscrow(params: CreateEscrowParams): Promise<EscrowInfo>;
  releaseEscrow(escrowId: string): Promise<string>;
  refundEscrow(escrowId: string): Promise<string>;
  getEscrow(escrowId: string): Promise<EscrowInfo>;
  createStream(params: CreateStreamParams): Promise<StreamInfo>;
  withdrawFromStream(streamId: string): Promise<string>;
  cancelStream(streamId: string): Promise<string>;
  getStream(streamId: string): Promise<StreamInfo>;
  
  // Agents
  registerAgent(params: RegisterAgentParams): Promise<string>;
  deregisterAgent(): Promise<string>;
  getAgent(address?: string): Promise<AgentInfo>;
  increaseStake(params: AgentStakeParams): Promise<string>;
  decreaseStake(params: AgentStakeParams): Promise<string>;
  createDispute(params: DisputeParams): Promise<DisputeInfo>;
  rateService(params: RatingParams): Promise<string>;
  
  // Services
  registerService(params: RegisterServiceParams): Promise<ServiceInfo>;
  updateService(params: UpdateServiceParams): Promise<string>;
  deactivateService(serviceId: string): Promise<string>;
  activateService(serviceId: string): Promise<string>;
  getService(serviceId: string): Promise<ServiceInfo>;
  findServicesByCategory(category: string): Promise<ServiceInfo[]>;
  calculatePrice(serviceId: string, quantity: number): Promise<string>;
  requestQuote(params: QuoteRequest): Promise<QuoteInfo>;
  acceptQuote(quoteId: string): Promise<string>;
  
  // Channels
  openChannel(params: OpenChannelParams): Promise<ChannelInfo>;
  getChannel(party1: string, party2: string): Promise<ChannelInfo>;
  signChannelState(state: ChannelState): Promise<string>;
  cooperativeClose(params: CloseChannelParams): Promise<string>;
  initiateClose(params: CloseChannelParams): Promise<string>;
  challengeClose(params: CloseChannelParams): Promise<string>;
  finalizeClose(counterparty: string): Promise<string>;
  
  // Subscriptions
  createPlan(params: CreatePlanParams): Promise<SubscriptionPlan>;
  subscribe(planId: string, prepayPeriods: number): Promise<SubscriptionInfo>;
  cancelSubscription(subscriptionId: string): Promise<string>;
  getSubscription(subscriptionId: string): Promise<SubscriptionInfo>;
  getSubscriptionStatus(subscriptionId: string): Promise<SubscriptionStatus>;
  
  // Staking
  stake(params: StakeParams): Promise<StakeInfo>;
  unstake(amount: string): Promise<string>;
  claimRewards(): Promise<string>;
  compound(): Promise<string>;
  getStakeInfo(address?: string): Promise<StakeInfo>;
  getStakingStats(): Promise<StakingStats>;
  
  // Events
  on(event: string, callback: (event: ProtocolEvent) => void): void;
  off(event: string, callback: (event: ProtocolEvent) => void): void;
  
  // Utilities
  waitForTransaction(txHash: string): Promise<{ status: number; blockNumber: number }>;
}

// ============ Factory Function Types ============

export type CreateSynapseSDK = (config: SDKConfig) => ISynapseSDK;

// ============ Export Default ============

declare const SynapseSDK: CreateSynapseSDK;
export default SynapseSDK;
