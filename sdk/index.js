/**
 * SYNAPSE Protocol SDK
 * JavaScript/TypeScript SDK for AI-to-AI payments
 * 
 * @version 1.0.0
 * @license MIT
 */

const { ethers } = require('ethers');

// Contract ABIs (simplified for SDK)
const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function delegate(address delegatee)",
  "function getVotes(address account) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)"
];

const PAYMENT_ROUTER_ABI = [
  "function pay(address recipient, uint256 amount, bytes32 paymentId, bytes calldata metadata) returns (bool)",
  "function batchPay(address[] recipients, uint256[] amounts, bytes32[] paymentIds, bytes[] metadata) returns (bool)",
  "function createEscrow(address recipient, address arbiter, uint256 amount, uint256 deadline, bytes32 paymentId, bytes metadata) returns (bytes32)",
  "function releaseEscrow(bytes32 escrowId) returns (bool)",
  "function refundEscrow(bytes32 escrowId) returns (bool)",
  "function createStream(address recipient, uint256 totalAmount, uint256 startTime, uint256 endTime) returns (bytes32)",
  "function withdrawFromStream(bytes32 streamId) returns (uint256)",
  "function cancelStream(bytes32 streamId) returns (bool)",
  "function gaslessPay(address sender, address recipient, uint256 amount, bytes32 paymentId, uint256 deadline, bytes signature) returns (bool)",
  "function baseFeeBps() view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function agentStats(address) view returns (uint256 totalPaymentsSent, uint256 totalPaymentsReceived, uint256 totalVolumeSent, uint256 totalVolumeReceived)",
  "event Payment(address indexed sender, address indexed recipient, uint256 amount, uint256 fee, bytes32 paymentId)",
  "event EscrowCreated(bytes32 indexed escrowId, address indexed sender, address indexed recipient, uint256 amount)",
  "event StreamCreated(bytes32 indexed streamId, address indexed sender, address indexed recipient, uint256 totalAmount)"
];

const REPUTATION_REGISTRY_ABI = [
  "function registerAgent(string name, string metadataUri, uint256 stakeAmount) returns (bool)",
  "function deregisterAgent() returns (bool)",
  "function increaseStake(uint256 amount) returns (bool)",
  "function decreaseStake(uint256 amount) returns (bool)",
  "function agents(address) view returns (bool registered, string name, uint256 stake, uint256 reputationScore, uint256 totalTransactions, uint256 successfulTransactions, uint256 registeredAt)",
  "function getTier(address agent) view returns (uint8)",
  "function getTierDiscount(uint8 tier) view returns (uint256)",
  "function getSuccessRate(address agent) view returns (uint256)",
  "function createDispute(address defendant, string reason, bytes32 transactionId) returns (bytes32)",
  "function rateService(address provider, string category, uint8 rating) returns (bool)",
  "function getServiceRating(address provider, string category) view returns (uint256 totalRatings, uint256 averageRating)",
  "event AgentRegistered(address indexed agent, string name, uint256 stake)",
  "event AgentDeregistered(address indexed agent)",
  "event DisputeCreated(bytes32 indexed disputeId, address indexed complainant, address indexed defendant)"
];

const SERVICE_REGISTRY_ABI = [
  "function registerService(string name, string category, string description, string endpoint, uint256 basePrice, uint8 pricingModel) returns (bytes32)",
  "function updateServiceDescription(bytes32 serviceId, string description) returns (bool)",
  "function updateServiceEndpoint(bytes32 serviceId, string endpoint) returns (bool)",
  "function updateServicePrice(bytes32 serviceId, uint256 newPrice) returns (bool)",
  "function activateService(bytes32 serviceId) returns (bool)",
  "function deactivateService(bytes32 serviceId) returns (bool)",
  "function setVolumeDiscounts(bytes32 serviceId, uint256[] thresholds, uint256[] discounts) returns (bool)",
  "function requestQuote(bytes32 serviceId, uint256 quantity, bytes specs) returns (bytes32)",
  "function acceptQuote(bytes32 quoteId) returns (bool)",
  "function calculatePrice(bytes32 serviceId, uint256 quantity) view returns (uint256)",
  "function services(bytes32) view returns (address provider, string name, string category, string description, string endpoint, uint256 basePrice, uint8 pricingModel, bool active, uint256 createdAt)",
  "function getProviderServices(address provider) view returns (tuple(bytes32 serviceId, string name, string category, bool active)[])",
  "function getServicesByCategory(string category) view returns (bytes32[])",
  "function categoryExists(string category) view returns (bool)",
  "event ServiceRegistered(bytes32 indexed serviceId, address indexed provider, string name, string category)",
  "event QuoteRequested(bytes32 indexed quoteId, bytes32 indexed serviceId, address indexed requester, uint256 quantity)"
];

const PAYMENT_CHANNEL_ABI = [
  "function openChannel(address counterparty, uint256 myDeposit, uint256 theirDeposit) returns (bytes32)",
  "function fundChannel(address initiator, uint256 amount) returns (bool)",
  "function addFunds(address counterparty, uint256 amount) returns (bool)",
  "function cooperativeClose(address counterparty, uint256 balance1, uint256 balance2, uint256 nonce, bytes sig1, bytes sig2) returns (bool)",
  "function initiateClose(address counterparty, uint256 balance1, uint256 balance2, uint256 nonce, bytes sig1, bytes sig2) returns (bool)",
  "function challengeClose(address counterparty, uint256 balance1, uint256 balance2, uint256 nonce, bytes sig1, bytes sig2) returns (bool)",
  "function finalizeClose(address counterparty) returns (bool)",
  "function getChannelId(address party1, address party2) view returns (bytes32)",
  "function getChannelBalance(address party1, address party2) view returns (uint256)",
  "function channels(bytes32) view returns (address participant1, address participant2, uint256 balance1, uint256 balance2, uint256 nonce, uint8 status, uint256 challengeEnd)",
  "function challengePeriod() view returns (uint256)",
  "event ChannelOpened(bytes32 indexed channelId, address indexed participant1, address indexed participant2)",
  "event ChannelClosed(bytes32 indexed channelId, uint256 balance1, uint256 balance2)"
];

/**
 * Tier levels for reputation system
 */
const Tier = {
  UNVERIFIED: 0,
  BRONZE: 1,
  SILVER: 2,
  GOLD: 3,
  PLATINUM: 4,
  DIAMOND: 5
};

/**
 * Pricing models for services
 */
const PricingModel = {
  PER_REQUEST: 0,
  PER_TOKEN: 1,
  PER_SECOND: 2,
  PER_BYTE: 3,
  SUBSCRIPTION: 4,
  CUSTOM: 5
};

/**
 * Channel status
 */
const ChannelStatus = {
  NONE: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
};

/**
 * Main SYNAPSE SDK class
 */
class SynapseSDK {
  /**
   * Create a new SYNAPSE SDK instance
   * @param {Object} config - Configuration object
   * @param {string} config.rpcUrl - JSON-RPC endpoint URL
   * @param {string} [config.privateKey] - Private key for signing transactions
   * @param {Object} config.contracts - Contract addresses
   */
  constructor(config) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    
    if (config.privateKey) {
      this.signer = new ethers.Wallet(config.privateKey, this.provider);
    }
    
    this.contracts = config.contracts;
    this._initContracts();
  }

  /**
   * Initialize contract instances
   * @private
   */
  _initContracts() {
    const signerOrProvider = this.signer || this.provider;
    
    if (this.contracts.token) {
      this.token = new ethers.Contract(this.contracts.token, TOKEN_ABI, signerOrProvider);
    }
    if (this.contracts.paymentRouter) {
      this.paymentRouter = new ethers.Contract(this.contracts.paymentRouter, PAYMENT_ROUTER_ABI, signerOrProvider);
    }
    if (this.contracts.reputation) {
      this.reputation = new ethers.Contract(this.contracts.reputation, REPUTATION_REGISTRY_ABI, signerOrProvider);
    }
    if (this.contracts.serviceRegistry) {
      this.serviceRegistry = new ethers.Contract(this.contracts.serviceRegistry, SERVICE_REGISTRY_ABI, signerOrProvider);
    }
    if (this.contracts.paymentChannel) {
      this.paymentChannel = new ethers.Contract(this.contracts.paymentChannel, PAYMENT_CHANNEL_ABI, signerOrProvider);
    }
  }

  /**
   * Connect with a signer (wallet)
   * @param {ethers.Signer} signer - Ethers signer instance
   * @returns {SynapseSDK} - New SDK instance with signer
   */
  connect(signer) {
    const newSdk = Object.create(this);
    newSdk.signer = signer;
    newSdk._initContracts();
    return newSdk;
  }

  /**
   * Get current address
   * @returns {Promise<string>} - Current signer address
   */
  async getAddress() {
    if (!this.signer) throw new Error('No signer connected');
    return this.signer.getAddress();
  }

  // ==================== Token Functions ====================

  /**
   * Get token balance
   * @param {string} address - Address to check
   * @returns {Promise<string>} - Balance in SYNX (formatted)
   */
  async getBalance(address) {
    const balance = await this.token.balanceOf(address);
    return ethers.formatEther(balance);
  }

  /**
   * Transfer tokens
   * @param {string} to - Recipient address
   * @param {string} amount - Amount in SYNX
   * @returns {Promise<Object>} - Transaction receipt
   */
  async transfer(to, amount) {
    const tx = await this.token.transfer(to, ethers.parseEther(amount));
    return tx.wait();
  }

  /**
   * Approve token spending
   * @param {string} spender - Spender address
   * @param {string} amount - Amount in SYNX
   * @returns {Promise<Object>} - Transaction receipt
   */
  async approve(spender, amount) {
    const tx = await this.token.approve(spender, ethers.parseEther(amount));
    return tx.wait();
  }

  /**
   * Approve all contracts for maximum spending
   * @returns {Promise<Object[]>} - Transaction receipts
   */
  async approveAll() {
    const maxAmount = ethers.MaxUint256;
    const receipts = [];
    
    if (this.contracts.paymentRouter) {
      const tx = await this.token.approve(this.contracts.paymentRouter, maxAmount);
      receipts.push(await tx.wait());
    }
    if (this.contracts.reputation) {
      const tx = await this.token.approve(this.contracts.reputation, maxAmount);
      receipts.push(await tx.wait());
    }
    if (this.contracts.serviceRegistry) {
      const tx = await this.token.approve(this.contracts.serviceRegistry, maxAmount);
      receipts.push(await tx.wait());
    }
    if (this.contracts.paymentChannel) {
      const tx = await this.token.approve(this.contracts.paymentChannel, maxAmount);
      receipts.push(await tx.wait());
    }
    
    return receipts;
  }

  // ==================== Payment Functions ====================

  /**
   * Send a direct payment
   * @param {string} recipient - Recipient address
   * @param {string} amount - Amount in SYNX
   * @param {string} [paymentId] - Optional payment identifier
   * @param {string} [metadata] - Optional metadata (hex)
   * @returns {Promise<Object>} - Transaction receipt with payment details
   */
  async pay(recipient, amount, paymentId = null, metadata = '0x') {
    const id = paymentId || ethers.encodeBytes32String(Date.now().toString());
    const tx = await this.paymentRouter.pay(
      recipient,
      ethers.parseEther(amount),
      id,
      metadata
    );
    const receipt = await tx.wait();
    
    // Parse Payment event
    const paymentEvent = receipt.logs.find(log => {
      try {
        return this.paymentRouter.interface.parseLog(log)?.name === 'Payment';
      } catch { return false; }
    });
    
    return {
      receipt,
      paymentId: id,
      event: paymentEvent ? this.paymentRouter.interface.parseLog(paymentEvent) : null
    };
  }

  /**
   * Send batch payments
   * @param {Array<{recipient: string, amount: string}>} payments - Array of payments
   * @returns {Promise<Object>} - Transaction receipt
   */
  async batchPay(payments) {
    const recipients = payments.map(p => p.recipient);
    const amounts = payments.map(p => ethers.parseEther(p.amount));
    const paymentIds = payments.map((_, i) => 
      ethers.encodeBytes32String(`batch-${Date.now()}-${i}`)
    );
    
    const tx = await this.paymentRouter.batchPay(recipients, amounts, paymentIds, []);
    return tx.wait();
  }

  /**
   * Create an escrow payment
   * @param {Object} params - Escrow parameters
   * @param {string} params.recipient - Recipient address
   * @param {string} params.arbiter - Arbiter address
   * @param {string} params.amount - Amount in SYNX
   * @param {number} params.deadline - Unix timestamp deadline
   * @param {string} [params.paymentId] - Optional payment ID
   * @returns {Promise<Object>} - Transaction receipt with escrow ID
   */
  async createEscrow({ recipient, arbiter, amount, deadline, paymentId = null }) {
    const id = paymentId || ethers.encodeBytes32String(`escrow-${Date.now()}`);
    const tx = await this.paymentRouter.createEscrow(
      recipient,
      arbiter,
      ethers.parseEther(amount),
      deadline,
      id,
      '0x'
    );
    const receipt = await tx.wait();
    
    // Parse EscrowCreated event
    const event = receipt.logs.find(log => {
      try {
        return this.paymentRouter.interface.parseLog(log)?.name === 'EscrowCreated';
      } catch { return false; }
    });
    
    const parsedEvent = event ? this.paymentRouter.interface.parseLog(event) : null;
    
    return {
      receipt,
      escrowId: parsedEvent?.args.escrowId,
      paymentId: id
    };
  }

  /**
   * Release an escrow payment
   * @param {string} escrowId - Escrow ID
   * @returns {Promise<Object>} - Transaction receipt
   */
  async releaseEscrow(escrowId) {
    const tx = await this.paymentRouter.releaseEscrow(escrowId);
    return tx.wait();
  }

  /**
   * Create a payment stream
   * @param {Object} params - Stream parameters
   * @param {string} params.recipient - Recipient address
   * @param {string} params.totalAmount - Total amount in SYNX
   * @param {number} params.startTime - Unix timestamp start
   * @param {number} params.endTime - Unix timestamp end
   * @returns {Promise<Object>} - Transaction receipt with stream ID
   */
  async createStream({ recipient, totalAmount, startTime, endTime }) {
    const tx = await this.paymentRouter.createStream(
      recipient,
      ethers.parseEther(totalAmount),
      startTime,
      endTime
    );
    const receipt = await tx.wait();
    
    const event = receipt.logs.find(log => {
      try {
        return this.paymentRouter.interface.parseLog(log)?.name === 'StreamCreated';
      } catch { return false; }
    });
    
    const parsedEvent = event ? this.paymentRouter.interface.parseLog(event) : null;
    
    return {
      receipt,
      streamId: parsedEvent?.args.streamId
    };
  }

  /**
   * Create a gasless payment signature
   * @param {Object} params - Payment parameters
   * @param {string} params.recipient - Recipient address
   * @param {string} params.amount - Amount in SYNX
   * @param {string} params.paymentId - Payment ID
   * @param {number} params.deadline - Unix timestamp deadline
   * @returns {Promise<Object>} - Signature and parameters for gasless payment
   */
  async signGaslessPayment({ recipient, amount, paymentId, deadline }) {
    const sender = await this.getAddress();
    const nonce = await this.paymentRouter.nonces(sender);
    
    const domain = {
      name: 'SYNAPSE PaymentRouter',
      version: '1',
      chainId: (await this.provider.getNetwork()).chainId,
      verifyingContract: this.contracts.paymentRouter
    };
    
    const types = {
      GaslessPayment: [
        { name: 'sender', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'paymentId', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }
      ]
    };
    
    const message = {
      sender,
      recipient,
      amount: ethers.parseEther(amount),
      paymentId,
      nonce,
      deadline
    };
    
    const signature = await this.signer.signTypedData(domain, types, message);
    
    return {
      sender,
      recipient,
      amount: ethers.parseEther(amount).toString(),
      paymentId,
      deadline,
      signature
    };
  }

  // ==================== Reputation Functions ====================

  /**
   * Register as an AI agent
   * @param {Object} params - Registration parameters
   * @param {string} params.name - Agent name
   * @param {string} [params.metadataUri] - IPFS URI for metadata
   * @param {string} params.stake - Stake amount in SYNX
   * @returns {Promise<Object>} - Transaction receipt
   */
  async registerAgent({ name, metadataUri = '', stake }) {
    const tx = await this.reputation.registerAgent(
      name,
      metadataUri,
      ethers.parseEther(stake)
    );
    return tx.wait();
  }

  /**
   * Get agent information
   * @param {string} address - Agent address
   * @returns {Promise<Object>} - Agent data
   */
  async getAgent(address) {
    const agent = await this.reputation.agents(address);
    const tier = await this.reputation.getTier(address);
    const successRate = await this.reputation.getSuccessRate(address);
    
    return {
      registered: agent.registered,
      name: agent.name,
      stake: ethers.formatEther(agent.stake),
      reputationScore: Number(agent.reputationScore),
      totalTransactions: Number(agent.totalTransactions),
      successfulTransactions: Number(agent.successfulTransactions),
      registeredAt: new Date(Number(agent.registeredAt) * 1000),
      tier: tier,
      tierName: Object.keys(Tier).find(k => Tier[k] === tier),
      successRate: Number(successRate) / 100 // Convert to percentage
    };
  }

  /**
   * Increase stake
   * @param {string} amount - Additional stake in SYNX
   * @returns {Promise<Object>} - Transaction receipt
   */
  async increaseStake(amount) {
    const tx = await this.reputation.increaseStake(ethers.parseEther(amount));
    return tx.wait();
  }

  /**
   * Create a dispute
   * @param {Object} params - Dispute parameters
   * @param {string} params.defendant - Defendant address
   * @param {string} params.reason - Dispute reason
   * @param {string} params.transactionId - Related transaction ID
   * @returns {Promise<Object>} - Transaction receipt with dispute ID
   */
  async createDispute({ defendant, reason, transactionId }) {
    const tx = await this.reputation.createDispute(defendant, reason, transactionId);
    const receipt = await tx.wait();
    
    const event = receipt.logs.find(log => {
      try {
        return this.reputation.interface.parseLog(log)?.name === 'DisputeCreated';
      } catch { return false; }
    });
    
    return {
      receipt,
      disputeId: event ? this.reputation.interface.parseLog(event).args.disputeId : null
    };
  }

  /**
   * Rate a service provider
   * @param {string} provider - Provider address
   * @param {string} category - Service category
   * @param {number} rating - Rating (1-5)
   * @returns {Promise<Object>} - Transaction receipt
   */
  async rateService(provider, category, rating) {
    if (rating < 1 || rating > 5) throw new Error('Rating must be 1-5');
    const tx = await this.reputation.rateService(provider, category, rating);
    return tx.wait();
  }

  // ==================== Service Registry Functions ====================

  /**
   * Register a new service
   * @param {Object} params - Service parameters
   * @param {string} params.name - Service name
   * @param {string} params.category - Service category
   * @param {string} params.description - Service description
   * @param {string} params.endpoint - API endpoint URL
   * @param {string} params.basePrice - Base price in SYNX
   * @param {number} [params.pricingModel] - Pricing model (default: PER_REQUEST)
   * @returns {Promise<Object>} - Transaction receipt with service ID
   */
  async registerService({ name, category, description, endpoint, basePrice, pricingModel = PricingModel.PER_REQUEST }) {
    const tx = await this.serviceRegistry.registerService(
      name,
      category,
      description,
      endpoint,
      ethers.parseEther(basePrice),
      pricingModel
    );
    const receipt = await tx.wait();
    
    const event = receipt.logs.find(log => {
      try {
        return this.serviceRegistry.interface.parseLog(log)?.name === 'ServiceRegistered';
      } catch { return false; }
    });
    
    return {
      receipt,
      serviceId: event ? this.serviceRegistry.interface.parseLog(event).args.serviceId : null
    };
  }

  /**
   * Get service information
   * @param {string} serviceId - Service ID
   * @returns {Promise<Object>} - Service data
   */
  async getService(serviceId) {
    const service = await this.serviceRegistry.services(serviceId);
    return {
      provider: service.provider,
      name: service.name,
      category: service.category,
      description: service.description,
      endpoint: service.endpoint,
      basePrice: ethers.formatEther(service.basePrice),
      pricingModel: Number(service.pricingModel),
      pricingModelName: Object.keys(PricingModel).find(k => PricingModel[k] === Number(service.pricingModel)),
      active: service.active,
      createdAt: new Date(Number(service.createdAt) * 1000)
    };
  }

  /**
   * Find services by category
   * @param {string} category - Service category
   * @returns {Promise<string[]>} - Array of service IDs
   */
  async findServicesByCategory(category) {
    return this.serviceRegistry.getServicesByCategory(category);
  }

  /**
   * Request a quote for a service
   * @param {string} serviceId - Service ID
   * @param {number} quantity - Quantity/units needed
   * @param {string} [specs] - Optional specifications (hex)
   * @returns {Promise<Object>} - Transaction receipt with quote ID
   */
  async requestQuote(serviceId, quantity, specs = '0x') {
    const tx = await this.serviceRegistry.requestQuote(serviceId, quantity, specs);
    const receipt = await tx.wait();
    
    const event = receipt.logs.find(log => {
      try {
        return this.serviceRegistry.interface.parseLog(log)?.name === 'QuoteRequested';
      } catch { return false; }
    });
    
    return {
      receipt,
      quoteId: event ? this.serviceRegistry.interface.parseLog(event).args.quoteId : null
    };
  }

  /**
   * Accept a quote and make payment
   * @param {string} quoteId - Quote ID
   * @returns {Promise<Object>} - Transaction receipt
   */
  async acceptQuote(quoteId) {
    const tx = await this.serviceRegistry.acceptQuote(quoteId);
    return tx.wait();
  }

  /**
   * Calculate price for a service
   * @param {string} serviceId - Service ID
   * @param {number} quantity - Quantity
   * @returns {Promise<string>} - Price in SYNX
   */
  async calculatePrice(serviceId, quantity) {
    const price = await this.serviceRegistry.calculatePrice(serviceId, quantity);
    return ethers.formatEther(price);
  }

  // ==================== Payment Channel Functions ====================

  /**
   * Open a payment channel
   * @param {Object} params - Channel parameters
   * @param {string} params.counterparty - Other party address
   * @param {string} params.myDeposit - My deposit in SYNX
   * @param {string} [params.theirDeposit] - Their expected deposit in SYNX
   * @returns {Promise<Object>} - Transaction receipt with channel ID
   */
  async openChannel({ counterparty, myDeposit, theirDeposit = '0' }) {
    const tx = await this.paymentChannel.openChannel(
      counterparty,
      ethers.parseEther(myDeposit),
      ethers.parseEther(theirDeposit)
    );
    const receipt = await tx.wait();
    
    const event = receipt.logs.find(log => {
      try {
        return this.paymentChannel.interface.parseLog(log)?.name === 'ChannelOpened';
      } catch { return false; }
    });
    
    return {
      receipt,
      channelId: event ? this.paymentChannel.interface.parseLog(event).args.channelId : null
    };
  }

  /**
   * Get channel information
   * @param {string} party1 - First party address
   * @param {string} party2 - Second party address
   * @returns {Promise<Object>} - Channel data
   */
  async getChannel(party1, party2) {
    const channelId = await this.paymentChannel.getChannelId(party1, party2);
    const channel = await this.paymentChannel.channels(channelId);
    
    return {
      channelId,
      participant1: channel.participant1,
      participant2: channel.participant2,
      balance1: ethers.formatEther(channel.balance1),
      balance2: ethers.formatEther(channel.balance2),
      nonce: Number(channel.nonce),
      status: Number(channel.status),
      statusName: Object.keys(ChannelStatus).find(k => ChannelStatus[k] === Number(channel.status)),
      challengeEnd: channel.challengeEnd > 0 ? new Date(Number(channel.challengeEnd) * 1000) : null
    };
  }

  /**
   * Sign a channel state update
   * @param {Object} params - State parameters
   * @param {string} params.channelId - Channel ID
   * @param {string} params.balance1 - Balance for party 1 in SYNX
   * @param {string} params.balance2 - Balance for party 2 in SYNX
   * @param {number} params.nonce - State nonce
   * @returns {Promise<string>} - Signature
   */
  async signChannelState({ channelId, balance1, balance2, nonce }) {
    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'uint256', 'uint256', 'uint256'],
      [channelId, ethers.parseEther(balance1), ethers.parseEther(balance2), nonce]
    );
    
    return this.signer.signMessage(ethers.getBytes(messageHash));
  }

  /**
   * Cooperatively close a channel
   * @param {Object} params - Close parameters
   * @param {string} params.counterparty - Other party address
   * @param {string} params.balance1 - Final balance for party 1
   * @param {string} params.balance2 - Final balance for party 2
   * @param {number} params.nonce - Final nonce
   * @param {string} params.sig1 - Party 1 signature
   * @param {string} params.sig2 - Party 2 signature
   * @returns {Promise<Object>} - Transaction receipt
   */
  async cooperativeCloseChannel({ counterparty, balance1, balance2, nonce, sig1, sig2 }) {
    const tx = await this.paymentChannel.cooperativeClose(
      counterparty,
      ethers.parseEther(balance1),
      ethers.parseEther(balance2),
      nonce,
      sig1,
      sig2
    );
    return tx.wait();
  }

  // ==================== Utility Functions ====================

  /**
   * Get network information
   * @returns {Promise<Object>} - Network data
   */
  async getNetworkInfo() {
    const network = await this.provider.getNetwork();
    const blockNumber = await this.provider.getBlockNumber();
    const gasPrice = await this.provider.getFeeData();
    
    return {
      chainId: Number(network.chainId),
      name: network.name,
      blockNumber,
      gasPrice: ethers.formatUnits(gasPrice.gasPrice || 0, 'gwei') + ' gwei'
    };
  }

  /**
   * Wait for transaction confirmation
   * @param {string} txHash - Transaction hash
   * @param {number} [confirmations] - Number of confirmations to wait for
   * @returns {Promise<Object>} - Transaction receipt
   */
  async waitForTransaction(txHash, confirmations = 1) {
    return this.provider.waitForTransaction(txHash, confirmations);
  }

  /**
   * Estimate gas for a transaction
   * @param {Object} tx - Transaction object
   * @returns {Promise<string>} - Estimated gas
   */
  async estimateGas(tx) {
    const gas = await this.provider.estimateGas(tx);
    return gas.toString();
  }
}

// Export SDK and constants
module.exports = {
  SynapseSDK,
  Tier,
  PricingModel,
  ChannelStatus,
  TOKEN_ABI,
  PAYMENT_ROUTER_ABI,
  REPUTATION_REGISTRY_ABI,
  SERVICE_REGISTRY_ABI,
  PAYMENT_CHANNEL_ABI
};
