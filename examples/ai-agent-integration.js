/**
 * SYNAPSE Protocol - AI Agent Integration Example
 * 
 * This example demonstrates how an AI agent would integrate with
 * the SYNAPSE protocol to offer and consume services.
 * 
 * Scenario: A Translation AI Agent that:
 * 1. Registers itself as a service provider
 * 2. Discovers and uses other AI services
 * 3. Handles payments automatically
 */

const { SynapseSDK, PricingModel } = require('../sdk');
const express = require('express');
const axios = require('axios');

// Configuration
const CONFIG = {
  rpcUrl: process.env.RPC_URL || 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
  privateKey: process.env.AGENT_PRIVATE_KEY,
  contracts: {
    token: process.env.TOKEN_ADDRESS,
    paymentRouter: process.env.ROUTER_ADDRESS,
    reputation: process.env.REPUTATION_ADDRESS,
    serviceRegistry: process.env.REGISTRY_ADDRESS,
    paymentChannel: process.env.CHANNEL_ADDRESS
  },
  port: process.env.PORT || 3000
};

/**
 * TranslationAgent - An AI agent that provides translation services
 */
class TranslationAgent {
  constructor() {
    this.sdk = null;
    this.serviceId = null;
    this.address = null;
    this.app = express();
    this.setupRoutes();
  }

  /**
   * Initialize the agent
   */
  async initialize() {
    console.log('🚀 Initializing Translation Agent...');
    
    // Initialize SDK
    this.sdk = new SynapseSDK({
      rpcUrl: CONFIG.rpcUrl,
      privateKey: CONFIG.privateKey,
      contracts: CONFIG.contracts
    });
    
    this.address = await this.sdk.getAddress();
    console.log(`📍 Agent Address: ${this.address}`);
    
    // Check balance
    const balance = await this.sdk.getBalance(this.address);
    console.log(`💰 SYNX Balance: ${balance}`);
    
    // Approve contracts
    console.log('✅ Approving contracts...');
    await this.sdk.approveAll();
    
    // Register as agent if not already
    await this.registerIfNeeded();
    
    // Register service
    await this.registerService();
    
    console.log('✅ Agent initialized successfully!');
  }

  /**
   * Register as an AI agent if not already registered
   */
  async registerIfNeeded() {
    try {
      const agent = await this.sdk.getAgent(this.address);
      if (agent.registered) {
        console.log(`👤 Already registered as: ${agent.name}`);
        console.log(`⭐ Reputation Score: ${agent.reputationScore}`);
        console.log(`🏆 Tier: ${agent.tierName}`);
        return;
      }
    } catch (e) {
      // Not registered yet
    }
    
    console.log('📝 Registering as AI agent...');
    await this.sdk.registerAgent({
      name: 'TranslationBot-GPT4',
      metadataUri: 'ipfs://QmTranslationBotMetadata',
      stake: '500' // 500 SYNX stake
    });
    console.log('✅ Agent registered!');
  }

  /**
   * Register translation service
   */
  async registerService() {
    console.log('📋 Registering translation service...');
    
    const result = await this.sdk.registerService({
      name: 'GPT-4 Translation Service',
      category: 'translation',
      description: 'High-quality translation between 100+ languages using GPT-4. Supports context-aware translation, tone matching, and specialized terminology.',
      endpoint: `http://localhost:${CONFIG.port}/translate`,
      basePrice: '0.0001', // 0.0001 SYNX per character
      pricingModel: PricingModel.PER_BYTE
    });
    
    this.serviceId = result.serviceId;
    console.log(`✅ Service registered with ID: ${this.serviceId}`);
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    this.app.use(express.json());
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'healthy', agent: this.address });
    });
    
    // Translation endpoint
    this.app.post('/translate', async (req, res) => {
      try {
        const { text, sourceLang, targetLang, paymentId } = req.body;
        
        // Verify payment was received
        const verified = await this.verifyPayment(paymentId, text.length);
        if (!verified) {
          return res.status(402).json({ error: 'Payment required or invalid' });
        }
        
        // Perform translation (mock - in reality, call GPT-4)
        const translated = await this.performTranslation(text, sourceLang, targetLang);
        
        res.json({
          success: true,
          original: text,
          translated: translated,
          sourceLang,
          targetLang
        });
        
      } catch (error) {
        console.error('Translation error:', error);
        res.status(500).json({ error: 'Translation failed' });
      }
    });
    
    // Quote endpoint
    this.app.post('/quote', async (req, res) => {
      try {
        const { text } = req.body;
        const charCount = text.length;
        const price = await this.sdk.calculatePrice(this.serviceId, charCount);
        
        res.json({
          charCount,
          price: price,
          currency: 'SYNX',
          validFor: 3600 // 1 hour
        });
      } catch (error) {
        res.status(500).json({ error: 'Quote failed' });
      }
    });
  }

  /**
   * Verify a payment was received
   */
  async verifyPayment(paymentId, expectedUnits) {
    // In production, verify the payment on-chain
    // For this example, we'll do a simple check
    try {
      // Check payment events or escrow status
      // This is simplified - real implementation would query events
      console.log(`💳 Verifying payment: ${paymentId}`);
      return true; // Simplified for demo
    } catch (error) {
      console.error('Payment verification failed:', error);
      return false;
    }
  }

  /**
   * Perform translation (mock implementation)
   */
  async performTranslation(text, sourceLang, targetLang) {
    // In production, this would call GPT-4 or another translation service
    // For demo, we'll just add a prefix
    console.log(`📝 Translating from ${sourceLang} to ${targetLang}: "${text}"`);
    return `[${targetLang}] ${text}`;
  }

  /**
   * Discover and use another AI service
   */
  async useExternalService() {
    console.log('🔍 Discovering image generation services...');
    
    // Find image generation services
    const serviceIds = await this.sdk.findServicesByCategory('image_generation');
    if (serviceIds.length === 0) {
      console.log('No image generation services found');
      return;
    }
    
    // Get first service details
    const service = await this.sdk.getService(serviceIds[0]);
    console.log(`Found service: ${service.name}`);
    console.log(`Price: ${service.basePrice} SYNX per ${service.pricingModelName}`);
    console.log(`Endpoint: ${service.endpoint}`);
    
    // Request a quote
    const quote = await this.sdk.requestQuote(serviceIds[0], 1);
    console.log(`Quote ID: ${quote.quoteId}`);
    
    // Accept quote and make payment
    await this.sdk.acceptQuote(quote.quoteId);
    console.log('✅ Payment sent!');
    
    // Now call the service
    try {
      const response = await axios.post(service.endpoint, {
        prompt: 'A futuristic AI robot',
        paymentId: quote.quoteId
      });
      console.log('Service response:', response.data);
    } catch (error) {
      console.log('Service call would happen here');
    }
  }

  /**
   * Open a payment channel for frequent interactions
   */
  async setupPaymentChannel(partnerAddress) {
    console.log(`🔗 Opening payment channel with ${partnerAddress}...`);
    
    const result = await this.sdk.openChannel({
      counterparty: partnerAddress,
      myDeposit: '100', // 100 SYNX
      theirDeposit: '0'
    });
    
    console.log(`✅ Channel opened: ${result.channelId}`);
    
    // Now we can do unlimited off-chain transactions
    // Only need to settle on-chain when closing
    return result.channelId;
  }

  /**
   * Process off-chain payment (via payment channel)
   */
  async offchainPayment(channelId, amount, counterparty) {
    const channel = await this.sdk.getChannel(this.address, counterparty);
    
    // Calculate new balances
    const newMyBalance = (parseFloat(channel.balance1) - parseFloat(amount)).toString();
    const newTheirBalance = (parseFloat(channel.balance2) + parseFloat(amount)).toString();
    const newNonce = channel.nonce + 1;
    
    // Sign the new state
    const signature = await this.sdk.signChannelState({
      channelId,
      balance1: newMyBalance,
      balance2: newTheirBalance,
      nonce: newNonce
    });
    
    console.log(`📤 Off-chain payment of ${amount} SYNX`);
    console.log(`New balances - Me: ${newMyBalance}, Them: ${newTheirBalance}`);
    
    return {
      balance1: newMyBalance,
      balance2: newTheirBalance,
      nonce: newNonce,
      signature
    };
  }

  /**
   * Start the agent server
   */
  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n🌐 Translation Agent listening on port ${CONFIG.port}`);
      console.log(`📡 Endpoints:`);
      console.log(`   GET  /health   - Health check`);
      console.log(`   POST /quote    - Get translation quote`);
      console.log(`   POST /translate - Perform translation\n`);
    });
  }
}

/**
 * Example: Multi-Agent Workflow
 * 
 * This demonstrates a workflow where multiple AI agents
 * collaborate on a task, paying each other automatically.
 */
async function multiAgentWorkflow() {
  console.log('\n=== Multi-Agent Workflow Example ===\n');
  
  const sdk = new SynapseSDK({
    rpcUrl: CONFIG.rpcUrl,
    privateKey: CONFIG.privateKey,
    contracts: CONFIG.contracts
  });
  
  // Scenario: Research Agent needs translation and image generation
  
  // Step 1: Find a translation service
  console.log('Step 1: Finding translation service...');
  const translationServices = await sdk.findServicesByCategory('translation');
  
  // Step 2: Find an image generation service
  console.log('Step 2: Finding image generation service...');
  const imageServices = await sdk.findServicesByCategory('image_generation');
  
  // Step 3: Create escrow for translation
  console.log('Step 3: Creating escrow for translation...');
  const translationEscrow = await sdk.createEscrow({
    recipient: '0xTranslationAgent',
    arbiter: '0xArbitrationService',
    amount: '10',
    deadline: Math.floor(Date.now() / 1000) + 3600
  });
  
  // Step 4: Call translation service
  console.log('Step 4: Calling translation service...');
  // await axios.post(translationEndpoint, { ... });
  
  // Step 5: Release escrow on success
  console.log('Step 5: Releasing escrow...');
  // await sdk.releaseEscrow(translationEscrow.escrowId);
  
  // Step 6: Create payment stream for ongoing image generation
  console.log('Step 6: Creating payment stream for image generation...');
  const now = Math.floor(Date.now() / 1000);
  const stream = await sdk.createStream({
    recipient: '0xImageAgent',
    totalAmount: '100',
    startTime: now,
    endTime: now + 86400 // 24 hours
  });
  
  console.log('\n✅ Multi-agent workflow setup complete!');
  console.log(`Translation Escrow: ${translationEscrow.escrowId}`);
  console.log(`Image Stream: ${stream.streamId}`);
}

// Main entry point
async function main() {
  try {
    // Check if we have required config
    if (!CONFIG.privateKey) {
      console.log('⚠️  No private key configured. Running in demo mode.');
      console.log('Set AGENT_PRIVATE_KEY environment variable for full functionality.\n');
      
      // Show example workflow
      console.log('Example multi-agent workflow (mock):');
      console.log('1. Research Agent requests translation from Translation Agent');
      console.log('2. Payment sent via SYNAPSE (0.01 SYNX)');
      console.log('3. Translation Agent processes and returns result');
      console.log('4. Research Agent rates the service (5 stars)');
      console.log('5. Both agents\' reputation scores updated\n');
      return;
    }
    
    // Initialize and start the agent
    const agent = new TranslationAgent();
    await agent.initialize();
    agent.start();
    
    // Optionally run multi-agent workflow demo
    // await multiAgentWorkflow();
    
  } catch (error) {
    console.error('Error starting agent:', error);
    process.exit(1);
  }
}

main();

module.exports = { TranslationAgent };
