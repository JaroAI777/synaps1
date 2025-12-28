/**
 * SYNAPSE Protocol - TypeScript SDK
 * 
 * Comprehensive SDK for interacting with SYNAPSE Protocol
 * Supports all protocol features with full TypeScript type safety
 */

import { ethers, Contract, Signer, Provider, BigNumberish, BytesLike } from 'ethers';

// ============ Types ============

export interface SynapseConfig {
  rpcUrl: string;
  chainId: number;
  contracts: ContractAddresses;
  apiUrl?: string;
  wsUrl?: string;
}

export interface ContractAddresses {
  token: string;
  paymentRouter: string;
  reputation: string;
  serviceRegistry: string;
  staking: string;
  subscriptions: string;
  bridge: string;
  governance: string;
}

export interface PaymentResult {
  transactionHash: string;
  paymentId: string;
  amount: bigint;
  fee: bigint;
  blockNumber: number;
}

export interface EscrowResult {
  transactionHash: string;
  escrowId: string;
  amount: bigint;
  deadline: number;
}

export interface StreamResult {
  transactionHash: string;
  streamId: string;
  totalAmount: bigint;
  startTime: number;
  endTime: number;
}

export interface AgentInfo {
  address: string;
  name: string;
  metadataUri: string;
  reputation: number;
  tier: number;
  totalTransactions: bigint;
  stake: bigint;
  isActive: boolean;
}

export interface ServiceInfo {
  id: string;
  provider: string;
  name: string;
  category: string;
  description: string;
  endpoint: string;
  basePrice: bigint;
  pricingModel: PricingModel;
  isActive: boolean;
}

export enum PricingModel {
  PER_REQUEST = 0,
  PER_TOKEN = 1,
  TIERED = 2,
  SUBSCRIPTION = 3,
  CUSTOM = 4
}

export interface StakeInfo {
  amount: bigint;
  lockTier: number;
  lockEnd: number;
  pendingRewards: bigint;
  lastClaim: number;
}

export interface SubscriptionInfo {
  id: string;
  planId: string;
  subscriber: string;
  provider: string;
  status: SubscriptionStatus;
  currentPeriodEnd: number;
  usageCount: bigint;
  usageLimit: bigint;
}

export enum SubscriptionStatus {
  ACTIVE = 0,
  PAUSED = 1,
  CANCELLED = 2,
  EXPIRED = 3
}

export interface BridgeRequest {
  requestId: string;
  sender: string;
  recipient: string;
  amount: bigint;
  sourceChain: number;
  targetChain: number;
  status: BridgeStatus;
}

export enum BridgeStatus {
  PENDING = 0,
  VALIDATED = 1,
  COMPLETED = 2,
  FAILED = 3,
  REFUNDED = 4
}

export interface TransactionOptions {
  gasLimit?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
}

// ============ ABIs ============

const TOKEN_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)'
];

const PAYMENT_ROUTER_ABI = [
  'function pay(address recipient, uint256 amount, string metadata) returns (bytes32)',
  'function batchPay(address[] recipients, uint256[] amounts, string metadata)',
  'function createEscrow(address recipient, address arbiter, uint256 amount, uint256 deadline) returns (bytes32)',
  'function releaseEscrow(bytes32 escrowId)',
  'function refundEscrow(bytes32 escrowId)',
  'function createStream(address recipient, uint256 amount, uint256 startTime, uint256 endTime) returns (bytes32)',
  'function withdrawFromStream(bytes32 streamId)',
  'function cancelStream(bytes32 streamId)',
  'function getEscrow(bytes32 escrowId) view returns (tuple(address sender, address recipient, address arbiter, uint256 amount, uint256 deadline, uint8 status))',
  'function getStream(bytes32 streamId) view returns (tuple(address sender, address recipient, uint256 totalAmount, uint256 withdrawn, uint256 startTime, uint256 endTime, bool cancelled))',
  'function protocolFee() view returns (uint256)',
  'event PaymentSent(address indexed sender, address indexed recipient, uint256 amount, uint256 fee, bytes32 paymentId)',
  'event EscrowCreated(bytes32 indexed escrowId, address indexed sender, address indexed recipient, uint256 amount)',
  'event StreamCreated(bytes32 indexed streamId, address indexed sender, address indexed recipient, uint256 amount)'
];

const STAKING_ABI = [
  'function stake(uint256 amount, uint8 lockTier)',
  'function unstake(uint256 amount)',
  'function claimRewards()',
  'function compound()',
  'function getStakeInfo(address user) view returns (tuple(uint256 amount, uint8 lockTier, uint256 lockEnd, uint256 pendingRewards, uint256 lastClaim))',
  'function earned(address user) view returns (uint256)',
  'function totalStaked() view returns (uint256)',
  'function rewardRate() view returns (uint256)',
  'event Staked(address indexed user, uint256 amount, uint8 lockTier)',
  'event Unstaked(address indexed user, uint256 amount)',
  'event RewardsClaimed(address indexed user, uint256 amount)'
];

const REPUTATION_ABI = [
  'function registerAgent(string name, string metadataUri, uint256 stake)',
  'function updateAgent(string name, string metadataUri)',
  'function getAgent(address agent) view returns (tuple(address addr, string name, string metadataUri, uint256 reputation, uint8 tier, uint256 totalTx, uint256 stake, bool active))',
  'function rateService(address agent, string category, uint8 rating)',
  'event AgentRegistered(address indexed agent, string name, uint256 stake)',
  'event ReputationUpdated(address indexed agent, uint256 newReputation, uint8 newTier)'
];

const SERVICE_REGISTRY_ABI = [
  'function registerService(string name, string category, string description, string endpoint, uint256 basePrice, uint8 pricingModel) returns (bytes32)',
  'function updateService(bytes32 serviceId, string endpoint, uint256 basePrice, bool active)',
  'function getService(bytes32 serviceId) view returns (tuple(bytes32 id, address provider, string name, string category, string description, string endpoint, uint256 basePrice, uint8 pricingModel, bool active))',
  'function getServicesByCategory(string category) view returns (bytes32[])',
  'function calculatePrice(bytes32 serviceId, uint256 quantity) view returns (uint256)',
  'event ServiceRegistered(bytes32 indexed serviceId, address indexed provider, string name, string category)'
];

// ============ Main SDK Class ============

export class SynapseSDK {
  private provider: Provider;
  private signer: Signer | null = null;
  private config: SynapseConfig;
  
  // Contracts
  private tokenContract: Contract;
  private paymentRouter: Contract;
  private stakingContract: Contract;
  private reputationContract: Contract;
  private serviceRegistry: Contract;

  constructor(config: SynapseConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    
    // Initialize read-only contracts
    this.tokenContract = new Contract(config.contracts.token, TOKEN_ABI, this.provider);
    this.paymentRouter = new Contract(config.contracts.paymentRouter, PAYMENT_ROUTER_ABI, this.provider);
    this.stakingContract = new Contract(config.contracts.staking, STAKING_ABI, this.provider);
    this.reputationContract = new Contract(config.contracts.reputation, REPUTATION_ABI, this.provider);
    this.serviceRegistry = new Contract(config.contracts.serviceRegistry, SERVICE_REGISTRY_ABI, this.provider);
  }

  // ============ Connection ============

  /**
   * Connect with a signer for write operations
   */
  connect(signer: Signer): SynapseSDK {
    this.signer = signer;
    
    // Reconnect contracts with signer
    this.tokenContract = this.tokenContract.connect(signer) as Contract;
    this.paymentRouter = this.paymentRouter.connect(signer) as Contract;
    this.stakingContract = this.stakingContract.connect(signer) as Contract;
    this.reputationContract = this.reputationContract.connect(signer) as Contract;
    this.serviceRegistry = this.serviceRegistry.connect(signer) as Contract;
    
    return this;
  }

  /**
   * Connect with private key
   */
  connectWithPrivateKey(privateKey: string): SynapseSDK {
    const wallet = new ethers.Wallet(privateKey, this.provider);
    return this.connect(wallet);
  }

  /**
   * Get connected address
   */
  async getAddress(): Promise<string> {
    if (!this.signer) throw new Error('Not connected');
    return this.signer.getAddress();
  }

  // ============ Token Operations ============

  /**
   * Get token balance
   */
  async getBalance(address: string): Promise<bigint> {
    return this.tokenContract.balanceOf(address);
  }

  /**
   * Transfer tokens
   */
  async transfer(to: string, amount: BigNumberish, options?: TransactionOptions): Promise<string> {
    this.requireSigner();
    const tx = await this.tokenContract.transfer(to, amount, options || {});
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Approve spending
   */
  async approve(spender: string, amount: BigNumberish): Promise<string> {
    this.requireSigner();
    const tx = await this.tokenContract.approve(spender, amount);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Check allowance
   */
  async getAllowance(owner: string, spender: string): Promise<bigint> {
    return this.tokenContract.allowance(owner, spender);
  }

  // ============ Payment Operations ============

  /**
   * Send direct payment
   */
  async pay(recipient: string, amount: BigNumberish, metadata?: string): Promise<PaymentResult> {
    this.requireSigner();
    
    // Ensure approval
    await this.ensureApproval(this.config.contracts.paymentRouter, amount);
    
    const tx = await this.paymentRouter.pay(recipient, amount, metadata || '');
    const receipt = await tx.wait();
    
    const event = receipt.logs.find((log: any) => 
      this.paymentRouter.interface.parseLog(log)?.name === 'PaymentSent'
    );
    const parsed = this.paymentRouter.interface.parseLog(event);
    
    return {
      transactionHash: receipt.hash,
      paymentId: parsed.args.paymentId,
      amount: parsed.args.amount,
      fee: parsed.args.fee,
      blockNumber: receipt.blockNumber
    };
  }

  /**
   * Send batch payment
   */
  async batchPay(
    recipients: string[],
    amounts: BigNumberish[],
    metadata?: string
  ): Promise<string> {
    this.requireSigner();
    
    const totalAmount = amounts.reduce((sum, a) => sum + BigInt(a), 0n);
    await this.ensureApproval(this.config.contracts.paymentRouter, totalAmount);
    
    const tx = await this.paymentRouter.batchPay(recipients, amounts, metadata || '');
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Create escrow payment
   */
  async createEscrow(
    recipient: string,
    amount: BigNumberish,
    deadline: number,
    arbiter?: string
  ): Promise<EscrowResult> {
    this.requireSigner();
    
    await this.ensureApproval(this.config.contracts.paymentRouter, amount);
    
    const tx = await this.paymentRouter.createEscrow(
      recipient,
      arbiter || ethers.ZeroAddress,
      amount,
      deadline
    );
    const receipt = await tx.wait();
    
    const event = receipt.logs.find((log: any) =>
      this.paymentRouter.interface.parseLog(log)?.name === 'EscrowCreated'
    );
    const parsed = this.paymentRouter.interface.parseLog(event);
    
    return {
      transactionHash: receipt.hash,
      escrowId: parsed.args.escrowId,
      amount: parsed.args.amount,
      deadline
    };
  }

  /**
   * Release escrow
   */
  async releaseEscrow(escrowId: string): Promise<string> {
    this.requireSigner();
    const tx = await this.paymentRouter.releaseEscrow(escrowId);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Create payment stream
   */
  async createStream(
    recipient: string,
    amount: BigNumberish,
    startTime: number,
    endTime: number
  ): Promise<StreamResult> {
    this.requireSigner();
    
    await this.ensureApproval(this.config.contracts.paymentRouter, amount);
    
    const tx = await this.paymentRouter.createStream(recipient, amount, startTime, endTime);
    const receipt = await tx.wait();
    
    const event = receipt.logs.find((log: any) =>
      this.paymentRouter.interface.parseLog(log)?.name === 'StreamCreated'
    );
    const parsed = this.paymentRouter.interface.parseLog(event);
    
    return {
      transactionHash: receipt.hash,
      streamId: parsed.args.streamId,
      totalAmount: parsed.args.amount,
      startTime,
      endTime
    };
  }

  // ============ Staking Operations ============

  /**
   * Stake tokens
   */
  async stake(amount: BigNumberish, lockTier: number = 0): Promise<string> {
    this.requireSigner();
    
    await this.ensureApproval(this.config.contracts.staking, amount);
    
    const tx = await this.stakingContract.stake(amount, lockTier);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Unstake tokens
   */
  async unstake(amount: BigNumberish): Promise<string> {
    this.requireSigner();
    const tx = await this.stakingContract.unstake(amount);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Claim staking rewards
   */
  async claimRewards(): Promise<string> {
    this.requireSigner();
    const tx = await this.stakingContract.claimRewards();
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Compound rewards
   */
  async compound(): Promise<string> {
    this.requireSigner();
    const tx = await this.stakingContract.compound();
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Get stake info
   */
  async getStakeInfo(address: string): Promise<StakeInfo> {
    const info = await this.stakingContract.getStakeInfo(address);
    return {
      amount: info.amount,
      lockTier: info.lockTier,
      lockEnd: Number(info.lockEnd),
      pendingRewards: info.pendingRewards,
      lastClaim: Number(info.lastClaim)
    };
  }

  /**
   * Get pending rewards
   */
  async getPendingRewards(address: string): Promise<bigint> {
    return this.stakingContract.earned(address);
  }

  // ============ Agent & Service Operations ============

  /**
   * Register as agent
   */
  async registerAgent(name: string, metadataUri: string, stake: BigNumberish): Promise<string> {
    this.requireSigner();
    
    await this.ensureApproval(this.config.contracts.reputation, stake);
    
    const tx = await this.reputationContract.registerAgent(name, metadataUri, stake);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Get agent info
   */
  async getAgent(address: string): Promise<AgentInfo> {
    const agent = await this.reputationContract.getAgent(address);
    return {
      address: agent.addr,
      name: agent.name,
      metadataUri: agent.metadataUri,
      reputation: Number(agent.reputation),
      tier: agent.tier,
      totalTransactions: agent.totalTx,
      stake: agent.stake,
      isActive: agent.active
    };
  }

  /**
   * Register service
   */
  async registerService(
    name: string,
    category: string,
    description: string,
    endpoint: string,
    basePrice: BigNumberish,
    pricingModel: PricingModel
  ): Promise<string> {
    this.requireSigner();
    
    const tx = await this.serviceRegistry.registerService(
      name, category, description, endpoint, basePrice, pricingModel
    );
    const receipt = await tx.wait();
    
    const event = receipt.logs.find((log: any) =>
      this.serviceRegistry.interface.parseLog(log)?.name === 'ServiceRegistered'
    );
    const parsed = this.serviceRegistry.interface.parseLog(event);
    
    return parsed.args.serviceId;
  }

  /**
   * Get service info
   */
  async getService(serviceId: string): Promise<ServiceInfo> {
    const service = await this.serviceRegistry.getService(serviceId);
    return {
      id: service.id,
      provider: service.provider,
      name: service.name,
      category: service.category,
      description: service.description,
      endpoint: service.endpoint,
      basePrice: service.basePrice,
      pricingModel: service.pricingModel,
      isActive: service.active
    };
  }

  /**
   * Find services by category
   */
  async findServices(category: string): Promise<string[]> {
    return this.serviceRegistry.getServicesByCategory(category);
  }

  /**
   * Calculate service price
   */
  async calculateServicePrice(serviceId: string, quantity: number): Promise<bigint> {
    return this.serviceRegistry.calculatePrice(serviceId, quantity);
  }

  // ============ Utility Methods ============

  /**
   * Ensure token approval
   */
  private async ensureApproval(spender: string, amount: BigNumberish): Promise<void> {
    const address = await this.getAddress();
    const allowance = await this.getAllowance(address, spender);
    
    if (allowance < BigInt(amount)) {
      await this.approve(spender, ethers.MaxUint256);
    }
  }

  /**
   * Check if signer is connected
   */
  private requireSigner(): void {
    if (!this.signer) {
      throw new Error('Signer not connected. Call connect() first.');
    }
  }

  /**
   * Format token amount
   */
  static formatAmount(amount: bigint, decimals: number = 18): string {
    return ethers.formatUnits(amount, decimals);
  }

  /**
   * Parse token amount
   */
  static parseAmount(amount: string, decimals: number = 18): bigint {
    return ethers.parseUnits(amount, decimals);
  }

  /**
   * Validate address
   */
  static isValidAddress(address: string): boolean {
    return ethers.isAddress(address);
  }

  /**
   * Get current timestamp
   */
  static now(): number {
    return Math.floor(Date.now() / 1000);
  }
}

// ============ Preset Configurations ============

export const ARBITRUM_CONFIG: Partial<SynapseConfig> = {
  rpcUrl: 'https://arb1.arbitrum.io/rpc',
  chainId: 42161
};

export const ARBITRUM_SEPOLIA_CONFIG: Partial<SynapseConfig> = {
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  chainId: 421614
};

// ============ Factory Function ============

export function createSynapseSDK(config: SynapseConfig): SynapseSDK {
  return new SynapseSDK(config);
}

export default SynapseSDK;
