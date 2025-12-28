/**
 * SYNAPSE Protocol - React Native SDK
 * 
 * Mobile SDK for iOS and Android applications
 */

import { ethers } from 'ethers';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ============ Types ============

export interface SynapseConfig {
  rpcUrl: string;
  contracts: ContractAddresses;
  privateKey?: string;
  mnemonic?: string;
}

export interface ContractAddresses {
  token: string;
  paymentRouter: string;
  reputation: string;
  serviceRegistry: string;
  paymentChannel: string;
}

export interface WalletInfo {
  address: string;
  balance: string;
  network: string;
}

export interface PaymentParams {
  recipient: string;
  amount: string;
  metadata?: string;
}

export interface PaymentResult {
  transactionHash: string;
  paymentId: string;
  amount: string;
  fee: string;
}

export interface AgentInfo {
  address: string;
  name: string;
  reputation: number;
  tier: number;
  stake: string;
}

export interface ServiceInfo {
  serviceId: string;
  name: string;
  provider: string;
  category: string;
  price: string;
}

// ============ Constants ============

const STORAGE_KEYS = {
  WALLET: '@synapse/wallet',
  CONFIG: '@synapse/config',
  TRANSACTIONS: '@synapse/transactions',
  FAVORITES: '@synapse/favorites'
};

const TIER_NAMES = ['Unverified', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];

// ============ ABIs ============

const TOKEN_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

const ROUTER_ABI = [
  'function pay(address recipient, uint256 amount, bytes32 paymentId, bytes metadata) returns (bool)',
  'function batchPay(address[] recipients, uint256[] amounts, bytes32[] paymentIds, bytes[] metadata) returns (bool)',
  'event Payment(address indexed sender, address indexed recipient, uint256 amount, uint256 fee, bytes32 paymentId)'
];

const REPUTATION_ABI = [
  'function agents(address agent) view returns (bool registered, string name, string metadataUri, uint256 stake, uint256 reputationScore, uint256 totalTransactions, uint256 successfulTransactions, uint256 registeredAt)',
  'function getTier(address agent) view returns (uint8)'
];

const SERVICE_ABI = [
  'function services(bytes32 serviceId) view returns (address provider, string name, string category, string description, string endpoint, uint256 basePrice, uint8 pricingModel, bool active, uint256 createdAt)',
  'function getServicesByCategory(string category) view returns (bytes32[])',
  'function calculatePrice(bytes32 serviceId, uint256 quantity) view returns (uint256)'
];

// ============ Main SDK Class ============

export class SynapseSDK {
  private config: SynapseConfig;
  private provider: ethers.JsonRpcProvider | null = null;
  private wallet: ethers.Wallet | null = null;
  private contracts: {
    token?: ethers.Contract;
    router?: ethers.Contract;
    reputation?: ethers.Contract;
    services?: ethers.Contract;
  } = {};

  constructor(config: SynapseConfig) {
    this.config = config;
  }

  // ============ Initialization ============

  /**
   * Initialize SDK connection
   */
  async initialize(): Promise<void> {
    this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);

    if (this.config.privateKey) {
      this.wallet = new ethers.Wallet(this.config.privateKey, this.provider);
    } else if (this.config.mnemonic) {
      this.wallet = ethers.Wallet.fromPhrase(this.config.mnemonic).connect(this.provider);
    }

    this.initializeContracts();
  }

  /**
   * Initialize contract instances
   */
  private initializeContracts(): void {
    const signer = this.wallet || this.provider;

    if (this.config.contracts.token) {
      this.contracts.token = new ethers.Contract(
        this.config.contracts.token,
        TOKEN_ABI,
        signer
      );
    }

    if (this.config.contracts.paymentRouter) {
      this.contracts.router = new ethers.Contract(
        this.config.contracts.paymentRouter,
        ROUTER_ABI,
        signer
      );
    }

    if (this.config.contracts.reputation) {
      this.contracts.reputation = new ethers.Contract(
        this.config.contracts.reputation,
        REPUTATION_ABI,
        signer
      );
    }

    if (this.config.contracts.serviceRegistry) {
      this.contracts.services = new ethers.Contract(
        this.config.contracts.serviceRegistry,
        SERVICE_ABI,
        signer
      );
    }
  }

  // ============ Wallet Management ============

  /**
   * Create new wallet
   */
  static createWallet(): { address: string; privateKey: string; mnemonic: string } {
    const wallet = ethers.Wallet.createRandom();
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic: wallet.mnemonic?.phrase || ''
    };
  }

  /**
   * Import wallet from private key
   */
  static importFromPrivateKey(privateKey: string): { address: string } {
    const wallet = new ethers.Wallet(privateKey);
    return { address: wallet.address };
  }

  /**
   * Import wallet from mnemonic
   */
  static importFromMnemonic(mnemonic: string): { address: string; privateKey: string } {
    const wallet = ethers.Wallet.fromPhrase(mnemonic);
    return {
      address: wallet.address,
      privateKey: wallet.privateKey
    };
  }

  /**
   * Get wallet address
   */
  getAddress(): string | null {
    return this.wallet?.address || null;
  }

  /**
   * Get wallet info
   */
  async getWalletInfo(): Promise<WalletInfo | null> {
    if (!this.wallet) return null;

    const [balance, network] = await Promise.all([
      this.provider!.getBalance(this.wallet.address),
      this.provider!.getNetwork()
    ]);

    return {
      address: this.wallet.address,
      balance: ethers.formatEther(balance),
      network: network.name
    };
  }

  // ============ Token Operations ============

  /**
   * Get SYNX balance
   */
  async getBalance(address?: string): Promise<string> {
    const addr = address || this.wallet?.address;
    if (!addr || !this.contracts.token) {
      throw new Error('No address or token contract');
    }

    const balance = await this.contracts.token.balanceOf(addr);
    return ethers.formatEther(balance);
  }

  /**
   * Transfer SYNX tokens
   */
  async transfer(to: string, amount: string): Promise<string> {
    if (!this.contracts.token || !this.wallet) {
      throw new Error('Token contract or wallet not initialized');
    }

    const amountWei = ethers.parseEther(amount);
    const tx = await this.contracts.token.transfer(to, amountWei);
    const receipt = await tx.wait();

    await this.saveTransaction({
      type: 'transfer',
      to,
      amount,
      hash: receipt.hash
    });

    return receipt.hash;
  }

  /**
   * Approve token spending
   */
  async approve(spender: string, amount: string): Promise<string> {
    if (!this.contracts.token || !this.wallet) {
      throw new Error('Token contract or wallet not initialized');
    }

    const amountWei = amount === 'max' 
      ? ethers.MaxUint256 
      : ethers.parseEther(amount);
    
    const tx = await this.contracts.token.approve(spender, amountWei);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Approve all protocol contracts
   */
  async approveAll(): Promise<string[]> {
    const hashes: string[] = [];
    const contracts = [
      this.config.contracts.paymentRouter,
      this.config.contracts.reputation,
      this.config.contracts.serviceRegistry
    ].filter(Boolean);

    for (const contract of contracts) {
      const hash = await this.approve(contract, 'max');
      hashes.push(hash);
    }

    return hashes;
  }

  // ============ Payment Operations ============

  /**
   * Send payment
   */
  async pay(params: PaymentParams): Promise<PaymentResult> {
    if (!this.contracts.router || !this.wallet) {
      throw new Error('Router contract or wallet not initialized');
    }

    const amountWei = ethers.parseEther(params.amount);
    const paymentId = ethers.keccak256(
      ethers.toUtf8Bytes(`pay-${Date.now()}-${params.recipient}`)
    );
    const metadata = params.metadata 
      ? ethers.toUtf8Bytes(params.metadata) 
      : '0x';

    // Check allowance and approve if needed
    const allowance = await this.contracts.token!.allowance(
      this.wallet.address,
      this.config.contracts.paymentRouter
    );

    if (allowance < amountWei) {
      await this.approve(this.config.contracts.paymentRouter, 'max');
    }

    const tx = await this.contracts.router.pay(
      params.recipient,
      amountWei,
      paymentId,
      metadata
    );

    const receipt = await tx.wait();

    // Parse payment event
    const event = receipt.logs.find((log: any) => {
      try {
        const parsed = this.contracts.router!.interface.parseLog(log);
        return parsed?.name === 'Payment';
      } catch {
        return false;
      }
    });

    const parsedEvent = event 
      ? this.contracts.router.interface.parseLog(event)
      : null;

    const result: PaymentResult = {
      transactionHash: receipt.hash,
      paymentId: paymentId,
      amount: params.amount,
      fee: parsedEvent 
        ? ethers.formatEther(parsedEvent.args.fee) 
        : '0'
    };

    await this.saveTransaction({
      type: 'payment',
      ...result,
      recipient: params.recipient
    });

    return result;
  }

  /**
   * Send batch payment
   */
  async batchPay(
    payments: Array<{ recipient: string; amount: string }>
  ): Promise<string> {
    if (!this.contracts.router || !this.wallet) {
      throw new Error('Router contract or wallet not initialized');
    }

    const recipients = payments.map(p => p.recipient);
    const amounts = payments.map(p => ethers.parseEther(p.amount));
    const paymentIds = payments.map((_, i) => 
      ethers.keccak256(ethers.toUtf8Bytes(`batch-${Date.now()}-${i}`))
    );
    const metadata = payments.map(() => '0x');

    // Calculate total and approve
    const total = amounts.reduce((a, b) => a + b, 0n);
    const allowance = await this.contracts.token!.allowance(
      this.wallet.address,
      this.config.contracts.paymentRouter
    );

    if (allowance < total) {
      await this.approve(this.config.contracts.paymentRouter, 'max');
    }

    const tx = await this.contracts.router.batchPay(
      recipients,
      amounts,
      paymentIds,
      metadata
    );

    const receipt = await tx.wait();
    return receipt.hash;
  }

  // ============ Agent Operations ============

  /**
   * Get agent info
   */
  async getAgent(address: string): Promise<AgentInfo | null> {
    if (!this.contracts.reputation) {
      throw new Error('Reputation contract not initialized');
    }

    const [agent, tier] = await Promise.all([
      this.contracts.reputation.agents(address),
      this.contracts.reputation.getTier(address)
    ]);

    if (!agent.registered) {
      return null;
    }

    return {
      address,
      name: agent.name,
      reputation: Number(agent.reputationScore),
      tier: Number(tier),
      stake: ethers.formatEther(agent.stake)
    };
  }

  /**
   * Get tier name
   */
  getTierName(tier: number): string {
    return TIER_NAMES[tier] || 'Unknown';
  }

  // ============ Service Operations ============

  /**
   * Get service info
   */
  async getService(serviceId: string): Promise<ServiceInfo | null> {
    if (!this.contracts.services) {
      throw new Error('Services contract not initialized');
    }

    const service = await this.contracts.services.services(serviceId);

    if (!service.active) {
      return null;
    }

    return {
      serviceId,
      name: service.name,
      provider: service.provider,
      category: service.category,
      price: ethers.formatEther(service.basePrice)
    };
  }

  /**
   * Find services by category
   */
  async findServices(category: string): Promise<ServiceInfo[]> {
    if (!this.contracts.services) {
      throw new Error('Services contract not initialized');
    }

    const serviceIds = await this.contracts.services.getServicesByCategory(category);
    const services: ServiceInfo[] = [];

    for (const id of serviceIds.slice(0, 20)) {
      const service = await this.getService(id);
      if (service) {
        services.push(service);
      }
    }

    return services;
  }

  /**
   * Calculate service price
   */
  async calculatePrice(serviceId: string, quantity: number): Promise<string> {
    if (!this.contracts.services) {
      throw new Error('Services contract not initialized');
    }

    const price = await this.contracts.services.calculatePrice(serviceId, quantity);
    return ethers.formatEther(price);
  }

  // ============ Local Storage ============

  /**
   * Save wallet to storage
   */
  async saveWalletToStorage(encryptedKey: string): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEYS.WALLET, encryptedKey);
  }

  /**
   * Load wallet from storage
   */
  async loadWalletFromStorage(): Promise<string | null> {
    return AsyncStorage.getItem(STORAGE_KEYS.WALLET);
  }

  /**
   * Delete wallet from storage
   */
  async deleteWalletFromStorage(): Promise<void> {
    await AsyncStorage.removeItem(STORAGE_KEYS.WALLET);
  }

  /**
   * Save transaction to history
   */
  private async saveTransaction(tx: any): Promise<void> {
    try {
      const existing = await AsyncStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
      const transactions = existing ? JSON.parse(existing) : [];
      
      transactions.unshift({
        ...tx,
        timestamp: Date.now()
      });

      // Keep last 100 transactions
      await AsyncStorage.setItem(
        STORAGE_KEYS.TRANSACTIONS,
        JSON.stringify(transactions.slice(0, 100))
      );
    } catch (e) {
      console.error('Failed to save transaction:', e);
    }
  }

  /**
   * Get transaction history
   */
  async getTransactionHistory(): Promise<any[]> {
    const data = await AsyncStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
    return data ? JSON.parse(data) : [];
  }

  /**
   * Add service to favorites
   */
  async addFavorite(serviceId: string): Promise<void> {
    const existing = await AsyncStorage.getItem(STORAGE_KEYS.FAVORITES);
    const favorites = existing ? JSON.parse(existing) : [];
    
    if (!favorites.includes(serviceId)) {
      favorites.push(serviceId);
      await AsyncStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify(favorites));
    }
  }

  /**
   * Remove service from favorites
   */
  async removeFavorite(serviceId: string): Promise<void> {
    const existing = await AsyncStorage.getItem(STORAGE_KEYS.FAVORITES);
    const favorites = existing ? JSON.parse(existing) : [];
    
    const filtered = favorites.filter((id: string) => id !== serviceId);
    await AsyncStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify(filtered));
  }

  /**
   * Get favorite services
   */
  async getFavorites(): Promise<string[]> {
    const data = await AsyncStorage.getItem(STORAGE_KEYS.FAVORITES);
    return data ? JSON.parse(data) : [];
  }

  // ============ Utilities ============

  /**
   * Format SYNX amount
   */
  static formatSYNX(amount: string | bigint, decimals: number = 4): string {
    const value = typeof amount === 'string' ? amount : ethers.formatEther(amount);
    return parseFloat(value).toFixed(decimals);
  }

  /**
   * Parse SYNX amount
   */
  static parseSYNX(amount: string): bigint {
    return ethers.parseEther(amount);
  }

  /**
   * Validate address
   */
  static isValidAddress(address: string): boolean {
    return ethers.isAddress(address);
  }

  /**
   * Shorten address for display
   */
  static shortenAddress(address: string, chars: number = 4): string {
    return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
  }
}

// ============ React Hooks ============

export { useSynapse } from './hooks/useSynapse';
export { useBalance } from './hooks/useBalance';
export { usePayment } from './hooks/usePayment';
export { useAgent } from './hooks/useAgent';
export { useServices } from './hooks/useServices';

// ============ Components ============

export { SynapseProvider } from './components/SynapseProvider';
export { PaymentButton } from './components/PaymentButton';
export { BalanceDisplay } from './components/BalanceDisplay';
export { ServiceCard } from './components/ServiceCard';
export { TransactionHistory } from './components/TransactionHistory';

export default SynapseSDK;
