/**
 * SYNAPSE Protocol - OpenAI Integration Example
 * 
 * This example demonstrates how to create an AI agent that:
 * 1. Uses OpenAI's API for inference
 * 2. Accepts payments via SYNAPSE Protocol
 * 3. Automatically bills users based on token usage
 */

const express = require('express');
const { OpenAI } = require('openai');
const { SynapseSDK, PricingModel } = require('../sdk');

// Configuration
const CONFIG = {
  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
  
  // SYNAPSE
  rpcUrl: process.env.RPC_URL || 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
  privateKey: process.env.AGENT_PRIVATE_KEY,
  contracts: {
    token: process.env.TOKEN_ADDRESS,
    paymentRouter: process.env.ROUTER_ADDRESS,
    reputation: process.env.REPUTATION_ADDRESS,
    serviceRegistry: process.env.REGISTRY_ADDRESS
  },
  
  // Pricing (in SYNX per 1000 tokens)
  pricing: {
    inputTokens: '0.01',   // 0.01 SYNX per 1K input tokens
    outputTokens: '0.03',  // 0.03 SYNX per 1K output tokens
    minCharge: '0.001'     // Minimum charge per request
  },
  
  // Server
  port: process.env.PORT || 3000
};

/**
 * OpenAI Agent with SYNAPSE payments
 */
class OpenAIPaymentAgent {
  constructor() {
    this.openai = new OpenAI({ apiKey: CONFIG.openaiApiKey });
    this.sdk = null;
    this.serviceId = null;
    this.app = express();
    this.pendingPayments = new Map(); // Track pending payments
  }

  /**
   * Initialize the agent
   */
  async initialize() {
    console.log('🚀 Initializing OpenAI Payment Agent...');
    
    // Initialize SYNAPSE SDK
    this.sdk = new SynapseSDK({
      rpcUrl: CONFIG.rpcUrl,
      privateKey: CONFIG.privateKey,
      contracts: CONFIG.contracts
    });
    
    const address = await this.sdk.getAddress();
    console.log(`📍 Agent Address: ${address}`);
    
    // Approve all contracts
    await this.sdk.approveAll();
    
    // Register as agent if needed
    await this.registerIfNeeded();
    
    // Register service
    await this.registerService();
    
    // Setup API routes
    this.setupRoutes();
    
    console.log('✅ Agent initialized!');
  }

  /**
   * Register as AI agent
   */
  async registerIfNeeded() {
    try {
      const agent = await this.sdk.getAgent(await this.sdk.getAddress());
      if (agent.registered) {
        console.log(`👤 Already registered as: ${agent.name}`);
        return;
      }
    } catch (e) {
      // Not registered
    }
    
    console.log('📝 Registering as AI agent...');
    await this.sdk.registerAgent({
      name: 'OpenAI-GPT4-Agent',
      metadataUri: 'ipfs://QmOpenAIAgentMetadata',
      stake: '500'
    });
    console.log('✅ Agent registered!');
  }

  /**
   * Register OpenAI service
   */
  async registerService() {
    console.log('📋 Registering OpenAI service...');
    
    const result = await this.sdk.registerService({
      name: 'GPT-4 Turbo Inference',
      category: 'language_model',
      description: 'High-performance GPT-4 Turbo inference with streaming support. Supports chat completions, function calling, and vision.',
      endpoint: `http://localhost:${CONFIG.port}/v1/chat/completions`,
      basePrice: CONFIG.pricing.inputTokens,
      pricingModel: PricingModel.PER_TOKEN
    });
    
    this.serviceId = result.serviceId;
    console.log(`✅ Service registered: ${this.serviceId}`);
  }

  /**
   * Calculate cost for a request
   */
  calculateCost(inputTokens, outputTokens) {
    const inputCost = (inputTokens / 1000) * parseFloat(CONFIG.pricing.inputTokens);
    const outputCost = (outputTokens / 1000) * parseFloat(CONFIG.pricing.outputTokens);
    const total = Math.max(inputCost + outputCost, parseFloat(CONFIG.pricing.minCharge));
    return {
      inputCost,
      outputCost,
      total: total.toFixed(6)
    };
  }

  /**
   * Verify payment for a request
   */
  async verifyPayment(paymentId, expectedAmount) {
    // In production, verify on-chain
    // For this example, check pending payments map
    const payment = this.pendingPayments.get(paymentId);
    if (!payment) {
      return { valid: false, reason: 'Payment not found' };
    }
    
    if (parseFloat(payment.amount) < parseFloat(expectedAmount)) {
      return { valid: false, reason: 'Insufficient payment' };
    }
    
    return { valid: true };
  }

  /**
   * Record successful service delivery
   */
  async recordSuccess(customerAddress) {
    try {
      // This would be called by the reputation system
      // to record a successful transaction
      console.log(`✅ Service delivered to ${customerAddress}`);
    } catch (e) {
      console.error('Error recording success:', e.message);
    }
  }

  /**
   * Setup Express routes
   */
  setupRoutes() {
    this.app.use(express.json());

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy',
        model: CONFIG.model,
        serviceId: this.serviceId
      });
    });

    // Pricing endpoint
    this.app.get('/v1/pricing', (req, res) => {
      res.json({
        model: CONFIG.model,
        pricing: {
          inputTokens: {
            per1k: CONFIG.pricing.inputTokens,
            unit: 'SYNX'
          },
          outputTokens: {
            per1k: CONFIG.pricing.outputTokens,
            unit: 'SYNX'
          },
          minCharge: CONFIG.pricing.minCharge
        }
      });
    });

    // Quote endpoint - estimate cost before calling
    this.app.post('/v1/quote', async (req, res) => {
      try {
        const { messages, max_tokens = 1000 } = req.body;
        
        // Estimate input tokens (rough: 4 chars = 1 token)
        const inputText = messages.map(m => m.content).join(' ');
        const estimatedInputTokens = Math.ceil(inputText.length / 4);
        const estimatedOutputTokens = max_tokens;
        
        const cost = this.calculateCost(estimatedInputTokens, estimatedOutputTokens);
        
        // Generate quote ID
        const quoteId = `quote-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        res.json({
          quoteId,
          estimatedTokens: {
            input: estimatedInputTokens,
            output: estimatedOutputTokens
          },
          estimatedCost: cost,
          validFor: 3600, // 1 hour
          paymentAddress: await this.sdk.getAddress()
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Register payment (called before inference)
    this.app.post('/v1/payment', async (req, res) => {
      try {
        const { paymentId, amount, sender } = req.body;
        
        // Store pending payment
        this.pendingPayments.set(paymentId, {
          amount,
          sender,
          timestamp: Date.now()
        });
        
        res.json({
          status: 'registered',
          paymentId,
          expiresIn: 3600
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Main chat completions endpoint
    this.app.post('/v1/chat/completions', async (req, res) => {
      try {
        const { 
          messages, 
          max_tokens = 1000,
          temperature = 0.7,
          stream = false,
          paymentId 
        } = req.body;

        // Verify payment
        if (!paymentId) {
          return res.status(402).json({ 
            error: 'Payment required',
            message: 'Please call /v1/quote first, then make payment, then include paymentId'
          });
        }

        // Estimate minimum cost
        const inputText = messages.map(m => m.content).join(' ');
        const estimatedInputTokens = Math.ceil(inputText.length / 4);
        const minCost = this.calculateCost(estimatedInputTokens, 100);
        
        const paymentCheck = await this.verifyPayment(paymentId, minCost.total);
        if (!paymentCheck.valid) {
          return res.status(402).json({
            error: 'Payment verification failed',
            reason: paymentCheck.reason
          });
        }

        // Call OpenAI
        const startTime = Date.now();
        
        const completion = await this.openai.chat.completions.create({
          model: CONFIG.model,
          messages,
          max_tokens,
          temperature,
          stream: false
        });

        const endTime = Date.now();
        
        // Calculate actual cost
        const actualCost = this.calculateCost(
          completion.usage.prompt_tokens,
          completion.usage.completion_tokens
        );

        // Remove used payment
        const payment = this.pendingPayments.get(paymentId);
        this.pendingPayments.delete(paymentId);

        // Record successful delivery
        if (payment?.sender) {
          await this.recordSuccess(payment.sender);
        }

        // Return response with billing info
        res.json({
          ...completion,
          billing: {
            paymentId,
            tokens: {
              input: completion.usage.prompt_tokens,
              output: completion.usage.completion_tokens,
              total: completion.usage.total_tokens
            },
            cost: actualCost,
            currency: 'SYNX',
            processingTime: endTime - startTime
          }
        });

      } catch (error) {
        console.error('Inference error:', error);
        res.status(500).json({ 
          error: 'Inference failed',
          message: error.message 
        });
      }
    });

    // Streaming endpoint
    this.app.post('/v1/chat/completions/stream', async (req, res) => {
      try {
        const { 
          messages, 
          max_tokens = 1000,
          temperature = 0.7,
          paymentId 
        } = req.body;

        if (!paymentId) {
          return res.status(402).json({ error: 'Payment required' });
        }

        // Set up SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const stream = await this.openai.chat.completions.create({
          model: CONFIG.model,
          messages,
          max_tokens,
          temperature,
          stream: true
        });

        let totalTokens = 0;

        for await (const chunk of stream) {
          const data = JSON.stringify(chunk);
          res.write(`data: ${data}\n\n`);
          
          if (chunk.usage) {
            totalTokens = chunk.usage.total_tokens;
          }
        }

        // Final message with billing
        const finalMessage = {
          type: 'billing',
          paymentId,
          estimatedTokens: totalTokens,
          currency: 'SYNX'
        };
        res.write(`data: ${JSON.stringify(finalMessage)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();

      } catch (error) {
        console.error('Stream error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Function calling endpoint
    this.app.post('/v1/chat/completions/functions', async (req, res) => {
      try {
        const { 
          messages, 
          functions,
          function_call = 'auto',
          max_tokens = 1000,
          paymentId 
        } = req.body;

        if (!paymentId) {
          return res.status(402).json({ error: 'Payment required' });
        }

        const completion = await this.openai.chat.completions.create({
          model: CONFIG.model,
          messages,
          functions,
          function_call,
          max_tokens
        });

        const cost = this.calculateCost(
          completion.usage.prompt_tokens,
          completion.usage.completion_tokens
        );

        res.json({
          ...completion,
          billing: {
            paymentId,
            cost,
            currency: 'SYNX'
          }
        });

      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Rate endpoint - rate the service
    this.app.post('/v1/rate', async (req, res) => {
      try {
        const { raterAddress, rating, category = 'language_model' } = req.body;
        
        // This would typically be called by the customer's agent
        // For demo, we just acknowledge
        res.json({
          status: 'acknowledged',
          message: 'Thank you for your rating!'
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  /**
   * Start the server
   */
  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n🌐 OpenAI Payment Agent running on port ${CONFIG.port}`);
      console.log('\n📡 Endpoints:');
      console.log(`   GET  /health                    - Health check`);
      console.log(`   GET  /v1/pricing                - Get pricing info`);
      console.log(`   POST /v1/quote                  - Get cost quote`);
      console.log(`   POST /v1/payment                - Register payment`);
      console.log(`   POST /v1/chat/completions       - Chat completion`);
      console.log(`   POST /v1/chat/completions/stream - Streaming completion`);
      console.log(`   POST /v1/chat/completions/functions - Function calling`);
      console.log(`   POST /v1/rate                   - Rate service`);
      console.log('\n💰 Pricing:');
      console.log(`   Input:  ${CONFIG.pricing.inputTokens} SYNX per 1K tokens`);
      console.log(`   Output: ${CONFIG.pricing.outputTokens} SYNX per 1K tokens`);
      console.log(`   Min:    ${CONFIG.pricing.minCharge} SYNX per request\n`);
    });
  }
}

/**
 * Example: Client using the OpenAI Payment Agent
 */
async function exampleClient() {
  console.log('\n=== Example Client Usage ===\n');
  
  // 1. Get quote
  console.log('1. Getting quote...');
  // const quoteResponse = await fetch('http://localhost:3000/v1/quote', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     messages: [{ role: 'user', content: 'Hello, how are you?' }],
  //     max_tokens: 100
  //   })
  // });
  // const quote = await quoteResponse.json();
  // console.log('Quote:', quote);
  
  // 2. Make payment via SYNAPSE
  console.log('2. Making payment via SYNAPSE...');
  // const sdk = new SynapseSDK({ ... });
  // const payment = await sdk.pay(agentAddress, quote.estimatedCost.total);
  
  // 3. Register payment
  console.log('3. Registering payment...');
  // const paymentReg = await fetch('http://localhost:3000/v1/payment', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     paymentId: payment.paymentId,
  //     amount: quote.estimatedCost.total,
  //     sender: myAddress
  //   })
  // });
  
  // 4. Make inference request
  console.log('4. Making inference request...');
  // const response = await fetch('http://localhost:3000/v1/chat/completions', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     messages: [{ role: 'user', content: 'Hello, how are you?' }],
  //     max_tokens: 100,
  //     paymentId: payment.paymentId
  //   })
  // });
  // const result = await response.json();
  // console.log('Response:', result);
  
  console.log('\nExample workflow complete (commented out for demo)\n');
}

// Main entry point
async function main() {
  // Check configuration
  if (!CONFIG.openaiApiKey) {
    console.log('⚠️  OPENAI_API_KEY not set');
    console.log('Running in demo mode without actual OpenAI calls\n');
  }
  
  if (!CONFIG.privateKey) {
    console.log('⚠️  AGENT_PRIVATE_KEY not set');
    console.log('Running in demo mode without SYNAPSE integration\n');
    
    // Show example usage
    await exampleClient();
    return;
  }
  
  // Start the agent
  const agent = new OpenAIPaymentAgent();
  await agent.initialize();
  agent.start();
}

main().catch(console.error);

module.exports = { OpenAIPaymentAgent };
