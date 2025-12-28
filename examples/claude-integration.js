/**
 * SYNAPSE Protocol - Anthropic Claude Integration
 * 
 * This example demonstrates an AI agent that:
 * 1. Uses Anthropic's Claude API for inference
 * 2. Accepts SYNX payments via SYNAPSE Protocol
 * 3. Supports streaming responses
 * 4. Implements multi-turn conversations
 * 5. Supports tool use / function calling
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { SynapseSDK, PricingModel } = require('../sdk');
const crypto = require('crypto');

// Configuration
const CONFIG = {
  // Anthropic
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
  maxTokens: parseInt(process.env.MAX_TOKENS) || 4096,
  
  // SYNAPSE
  rpcUrl: process.env.RPC_URL || 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
  privateKey: process.env.AGENT_PRIVATE_KEY,
  contracts: {
    token: process.env.TOKEN_ADDRESS,
    paymentRouter: process.env.ROUTER_ADDRESS,
    reputation: process.env.REPUTATION_ADDRESS,
    serviceRegistry: process.env.REGISTRY_ADDRESS
  },
  
  // Pricing (in SYNX)
  pricing: {
    // Claude 3.5 Sonnet pricing
    inputTokens: '0.003',    // 0.003 SYNX per 1K input tokens
    outputTokens: '0.015',   // 0.015 SYNX per 1K output tokens
    minCharge: '0.0001',     // Minimum charge per request
    
    // Model-specific pricing
    models: {
      'claude-3-5-sonnet-20241022': { input: '0.003', output: '0.015' },
      'claude-3-opus-20240229': { input: '0.015', output: '0.075' },
      'claude-3-sonnet-20240229': { input: '0.003', output: '0.015' },
      'claude-3-haiku-20240307': { input: '0.00025', output: '0.00125' }
    }
  },
  
  // Server
  port: process.env.PORT || 3001
};

/**
 * Claude Payment Agent
 */
class ClaudePaymentAgent {
  constructor() {
    this.anthropic = new Anthropic({ apiKey: CONFIG.anthropicApiKey });
    this.sdk = null;
    this.serviceId = null;
    this.app = express();
    
    // Payment tracking
    this.pendingPayments = new Map();
    this.sessions = new Map(); // Store conversation sessions
    this.usageStats = {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRevenue: 0n
    };
  }

  /**
   * Initialize the agent
   */
  async initialize() {
    console.log('🤖 Initializing Claude Payment Agent...');
    
    // Initialize SYNAPSE SDK
    if (CONFIG.privateKey) {
      this.sdk = new SynapseSDK({
        rpcUrl: CONFIG.rpcUrl,
        privateKey: CONFIG.privateKey,
        contracts: CONFIG.contracts
      });
      
      const address = await this.sdk.getAddress();
      console.log(`📍 Agent Address: ${address}`);
      
      await this.sdk.approveAll();
      await this.registerIfNeeded();
      await this.registerServices();
    }
    
    // Setup routes
    this.setupRoutes();
    
    console.log('✅ Claude Agent initialized!');
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
      name: 'Claude-AI-Agent',
      metadataUri: 'ipfs://QmClaudeAgentMetadata',
      stake: '1000'
    });
    console.log('✅ Agent registered!');
  }

  /**
   * Register Claude services
   */
  async registerServices() {
    console.log('📋 Registering Claude services...');
    
    // Chat completion service
    const chatResult = await this.sdk.registerService({
      name: 'Claude Chat Completion',
      category: 'language_model',
      description: 'Claude 3.5 Sonnet chat completion with streaming support, tool use, and multi-turn conversations.',
      endpoint: `http://localhost:${CONFIG.port}/v1/messages`,
      basePrice: CONFIG.pricing.inputTokens,
      pricingModel: PricingModel.PER_TOKEN
    });
    
    // Analysis service
    const analysisResult = await this.sdk.registerService({
      name: 'Claude Document Analysis',
      category: 'data_analysis',
      description: 'Deep document analysis and summarization powered by Claude.',
      endpoint: `http://localhost:${CONFIG.port}/v1/analyze`,
      basePrice: '0.01',
      pricingModel: PricingModel.PER_REQUEST
    });
    
    // Code generation service
    const codeResult = await this.sdk.registerService({
      name: 'Claude Code Generation',
      category: 'code_generation',
      description: 'AI-powered code generation, review, and debugging.',
      endpoint: `http://localhost:${CONFIG.port}/v1/code`,
      basePrice: CONFIG.pricing.inputTokens,
      pricingModel: PricingModel.PER_TOKEN
    });
    
    console.log('✅ Services registered');
  }

  /**
   * Get pricing for a model
   */
  getPricing(model) {
    return CONFIG.pricing.models[model] || CONFIG.pricing.models[CONFIG.model];
  }

  /**
   * Calculate cost
   */
  calculateCost(model, inputTokens, outputTokens) {
    const pricing = this.getPricing(model);
    const inputCost = (inputTokens / 1000) * parseFloat(pricing.input);
    const outputCost = (outputTokens / 1000) * parseFloat(pricing.output);
    const total = Math.max(inputCost + outputCost, parseFloat(CONFIG.pricing.minCharge));
    
    return {
      inputCost: inputCost.toFixed(8),
      outputCost: outputCost.toFixed(8),
      total: total.toFixed(8)
    };
  }

  /**
   * Verify payment
   */
  async verifyPayment(paymentId, expectedAmount) {
    const payment = this.pendingPayments.get(paymentId);
    if (!payment) {
      return { valid: false, reason: 'Payment not found' };
    }
    
    if (parseFloat(payment.amount) < parseFloat(expectedAmount)) {
      return { valid: false, reason: 'Insufficient payment' };
    }
    
    return { valid: true, payment };
  }

  /**
   * Generate session ID
   */
  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Get or create session
   */
  getSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        messages: [],
        totalTokens: 0,
        createdAt: Date.now()
      });
    }
    return this.sessions.get(sessionId);
  }

  /**
   * Setup Express routes
   */
  setupRoutes() {
    this.app.use(express.json({ limit: '10mb' }));

    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        model: CONFIG.model,
        availableModels: Object.keys(CONFIG.pricing.models)
      });
    });

    // Pricing endpoint
    this.app.get('/v1/pricing', (req, res) => {
      res.json({
        defaultModel: CONFIG.model,
        models: Object.entries(CONFIG.pricing.models).map(([model, pricing]) => ({
          model,
          inputPer1k: pricing.input + ' SYNX',
          outputPer1k: pricing.output + ' SYNX'
        })),
        minCharge: CONFIG.pricing.minCharge + ' SYNX'
      });
    });

    // Quote endpoint
    this.app.post('/v1/quote', async (req, res) => {
      try {
        const { 
          model = CONFIG.model,
          messages,
          max_tokens = CONFIG.maxTokens,
          system
        } = req.body;
        
        // Estimate input tokens
        let inputText = system || '';
        if (messages) {
          inputText += messages.map(m => 
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          ).join(' ');
        }
        const estimatedInputTokens = Math.ceil(inputText.length / 4);
        const estimatedOutputTokens = max_tokens;
        
        const cost = this.calculateCost(model, estimatedInputTokens, estimatedOutputTokens);
        const quoteId = `quote-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        
        res.json({
          quoteId,
          model,
          estimatedTokens: {
            input: estimatedInputTokens,
            output: estimatedOutputTokens
          },
          estimatedCost: cost,
          validFor: 3600,
          paymentAddress: this.sdk ? await this.sdk.getAddress() : 'demo-mode'
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Register payment
    this.app.post('/v1/payment', (req, res) => {
      const { paymentId, amount, sender } = req.body;
      
      this.pendingPayments.set(paymentId, {
        amount,
        sender,
        timestamp: Date.now()
      });
      
      // Clean up old payments
      const oneHourAgo = Date.now() - 3600000;
      this.pendingPayments.forEach((payment, id) => {
        if (payment.timestamp < oneHourAgo) {
          this.pendingPayments.delete(id);
        }
      });
      
      res.json({ status: 'registered', paymentId });
    });

    // Main messages endpoint (Claude API compatible)
    this.app.post('/v1/messages', async (req, res) => {
      try {
        const {
          model = CONFIG.model,
          messages,
          max_tokens = CONFIG.maxTokens,
          system,
          temperature,
          top_p,
          top_k,
          stop_sequences,
          stream = false,
          tools,
          tool_choice,
          paymentId,
          sessionId
        } = req.body;

        // Verify payment
        if (!paymentId && !process.env.DEMO_MODE) {
          return res.status(402).json({
            error: 'Payment required',
            message: 'Please call /v1/quote and make payment first'
          });
        }

        if (paymentId) {
          const inputText = (system || '') + messages.map(m => 
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          ).join(' ');
          const minCost = this.calculateCost(model, inputText.length / 4, 100);
          
          const verification = await this.verifyPayment(paymentId, minCost.total);
          if (!verification.valid) {
            return res.status(402).json({
              error: 'Payment verification failed',
              reason: verification.reason
            });
          }
        }

        // Handle session
        let conversationMessages = messages;
        if (sessionId) {
          const session = this.getSession(sessionId);
          // Append new messages to session
          if (messages && messages.length > 0) {
            session.messages.push(...messages);
          }
          conversationMessages = session.messages;
        }

        // Build request
        const requestParams = {
          model,
          max_tokens,
          messages: conversationMessages
        };

        if (system) requestParams.system = system;
        if (temperature !== undefined) requestParams.temperature = temperature;
        if (top_p !== undefined) requestParams.top_p = top_p;
        if (top_k !== undefined) requestParams.top_k = top_k;
        if (stop_sequences) requestParams.stop_sequences = stop_sequences;
        if (tools) requestParams.tools = tools;
        if (tool_choice) requestParams.tool_choice = tool_choice;

        const startTime = Date.now();

        if (stream) {
          // Streaming response
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const stream = await this.anthropic.messages.stream(requestParams);
          
          let totalInputTokens = 0;
          let totalOutputTokens = 0;

          for await (const event of stream) {
            res.write(`event: ${event.type}\n`);
            res.write(`data: ${JSON.stringify(event)}\n\n`);

            if (event.type === 'message_start' && event.message.usage) {
              totalInputTokens = event.message.usage.input_tokens;
            }
            if (event.type === 'message_delta' && event.usage) {
              totalOutputTokens = event.usage.output_tokens;
            }
          }

          // Send billing info
          const cost = this.calculateCost(model, totalInputTokens, totalOutputTokens);
          res.write(`event: billing\n`);
          res.write(`data: ${JSON.stringify({
            paymentId,
            tokens: { input: totalInputTokens, output: totalOutputTokens },
            cost,
            processingTime: Date.now() - startTime
          })}\n\n`);

          res.write('event: done\ndata: [DONE]\n\n');
          res.end();

          // Update stats
          this.updateStats(totalInputTokens, totalOutputTokens, cost);
          
        } else {
          // Non-streaming response
          const response = await this.anthropic.messages.create(requestParams);
          
          const cost = this.calculateCost(
            model,
            response.usage.input_tokens,
            response.usage.output_tokens
          );

          // Update session if applicable
          if (sessionId && response.content) {
            const session = this.getSession(sessionId);
            session.messages.push({
              role: 'assistant',
              content: response.content
            });
            session.totalTokens += response.usage.input_tokens + response.usage.output_tokens;
          }

          // Remove used payment
          if (paymentId) {
            this.pendingPayments.delete(paymentId);
          }

          // Update stats
          this.updateStats(response.usage.input_tokens, response.usage.output_tokens, cost);

          res.json({
            ...response,
            billing: {
              paymentId,
              tokens: response.usage,
              cost,
              currency: 'SYNX',
              processingTime: Date.now() - startTime
            },
            sessionId: sessionId || undefined
          });
        }

      } catch (error) {
        console.error('Messages error:', error);
        res.status(error.status || 500).json({
          error: error.message,
          type: error.type || 'api_error'
        });
      }
    });

    // Document analysis endpoint
    this.app.post('/v1/analyze', async (req, res) => {
      try {
        const { document, analysisType = 'summary', paymentId } = req.body;

        if (!paymentId && !process.env.DEMO_MODE) {
          return res.status(402).json({ error: 'Payment required' });
        }

        const systemPrompts = {
          summary: 'You are an expert document analyst. Provide a comprehensive summary of the document.',
          entities: 'Extract all named entities (people, organizations, locations, dates) from the document.',
          sentiment: 'Analyze the sentiment and tone of the document.',
          keypoints: 'Extract the key points and main arguments from the document.',
          questions: 'Generate relevant questions that could be answered by this document.'
        };

        const response = await this.anthropic.messages.create({
          model: CONFIG.model,
          max_tokens: 2048,
          system: systemPrompts[analysisType] || systemPrompts.summary,
          messages: [
            { role: 'user', content: document }
          ]
        });

        const cost = this.calculateCost(
          CONFIG.model,
          response.usage.input_tokens,
          response.usage.output_tokens
        );

        res.json({
          analysisType,
          result: response.content[0].text,
          usage: response.usage,
          billing: { cost, currency: 'SYNX' }
        });

      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Code generation endpoint
    this.app.post('/v1/code', async (req, res) => {
      try {
        const {
          task,
          language = 'python',
          context,
          existingCode,
          paymentId
        } = req.body;

        if (!paymentId && !process.env.DEMO_MODE) {
          return res.status(402).json({ error: 'Payment required' });
        }

        let prompt = `Task: ${task}\nLanguage: ${language}\n`;
        if (context) prompt += `Context: ${context}\n`;
        if (existingCode) prompt += `Existing code:\n\`\`\`${language}\n${existingCode}\n\`\`\`\n`;

        const response = await this.anthropic.messages.create({
          model: CONFIG.model,
          max_tokens: 4096,
          system: `You are an expert ${language} programmer. Generate clean, efficient, well-documented code. Include error handling and follow best practices.`,
          messages: [
            { role: 'user', content: prompt }
          ]
        });

        const cost = this.calculateCost(
          CONFIG.model,
          response.usage.input_tokens,
          response.usage.output_tokens
        );

        res.json({
          code: response.content[0].text,
          language,
          usage: response.usage,
          billing: { cost, currency: 'SYNX' }
        });

      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Tool use example endpoint
    this.app.post('/v1/tools', async (req, res) => {
      try {
        const { messages, tools, paymentId } = req.body;

        if (!paymentId && !process.env.DEMO_MODE) {
          return res.status(402).json({ error: 'Payment required' });
        }

        // Example tools
        const defaultTools = [
          {
            name: 'get_weather',
            description: 'Get current weather for a location',
            input_schema: {
              type: 'object',
              properties: {
                location: { type: 'string', description: 'City name' }
              },
              required: ['location']
            }
          },
          {
            name: 'calculate',
            description: 'Perform mathematical calculations',
            input_schema: {
              type: 'object',
              properties: {
                expression: { type: 'string', description: 'Math expression' }
              },
              required: ['expression']
            }
          }
        ];

        const response = await this.anthropic.messages.create({
          model: CONFIG.model,
          max_tokens: 1024,
          tools: tools || defaultTools,
          messages
        });

        const cost = this.calculateCost(
          CONFIG.model,
          response.usage.input_tokens,
          response.usage.output_tokens
        );

        res.json({
          ...response,
          billing: { cost, currency: 'SYNX' }
        });

      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Session management
    this.app.post('/v1/sessions', (req, res) => {
      const sessionId = this.generateSessionId();
      this.sessions.set(sessionId, {
        messages: [],
        totalTokens: 0,
        createdAt: Date.now()
      });
      res.json({ sessionId });
    });

    this.app.get('/v1/sessions/:sessionId', (req, res) => {
      const session = this.sessions.get(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json({
        sessionId: req.params.sessionId,
        messageCount: session.messages.length,
        totalTokens: session.totalTokens,
        createdAt: session.createdAt
      });
    });

    this.app.delete('/v1/sessions/:sessionId', (req, res) => {
      this.sessions.delete(req.params.sessionId);
      res.json({ deleted: true });
    });

    // Usage stats
    this.app.get('/v1/stats', (req, res) => {
      res.json({
        totalRequests: this.usageStats.totalRequests,
        totalInputTokens: this.usageStats.totalInputTokens,
        totalOutputTokens: this.usageStats.totalOutputTokens,
        totalRevenue: this.usageStats.totalRevenue.toString() + ' SYNX (wei)',
        activeSessions: this.sessions.size,
        pendingPayments: this.pendingPayments.size
      });
    });
  }

  /**
   * Update usage stats
   */
  updateStats(inputTokens, outputTokens, cost) {
    this.usageStats.totalRequests++;
    this.usageStats.totalInputTokens += inputTokens;
    this.usageStats.totalOutputTokens += outputTokens;
    // Convert cost to wei-like representation
    this.usageStats.totalRevenue += BigInt(Math.floor(parseFloat(cost.total) * 1e18));
  }

  /**
   * Start server
   */
  start() {
    this.app.listen(CONFIG.port, () => {
      console.log(`\n🤖 Claude Payment Agent running on port ${CONFIG.port}`);
      console.log('\n📡 Endpoints:');
      console.log(`   GET  /health              - Health check`);
      console.log(`   GET  /v1/pricing          - Get pricing`);
      console.log(`   POST /v1/quote            - Get cost quote`);
      console.log(`   POST /v1/payment          - Register payment`);
      console.log(`   POST /v1/messages         - Chat completion`);
      console.log(`   POST /v1/analyze          - Document analysis`);
      console.log(`   POST /v1/code             - Code generation`);
      console.log(`   POST /v1/tools            - Tool use`);
      console.log(`   POST /v1/sessions         - Create session`);
      console.log(`   GET  /v1/sessions/:id     - Get session`);
      console.log(`   DELETE /v1/sessions/:id   - Delete session`);
      console.log(`   GET  /v1/stats            - Usage statistics`);
      console.log(`\n💰 Model: ${CONFIG.model}`);
      const pricing = this.getPricing(CONFIG.model);
      console.log(`   Input:  ${pricing.input} SYNX per 1K tokens`);
      console.log(`   Output: ${pricing.output} SYNX per 1K tokens\n`);
    });
  }
}

// Main
async function main() {
  if (!CONFIG.anthropicApiKey) {
    console.log('⚠️  ANTHROPIC_API_KEY not set');
    console.log('Set DEMO_MODE=true to run without API key\n');
    process.env.DEMO_MODE = 'true';
  }
  
  const agent = new ClaudePaymentAgent();
  await agent.initialize();
  agent.start();
}

main().catch(console.error);

module.exports = { ClaudePaymentAgent };
