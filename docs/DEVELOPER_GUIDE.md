# SYNAPSE Protocol Developer Guide

This comprehensive guide covers everything you need to know to integrate with and build on SYNAPSE Protocol.

## Table of Contents

1. [Introduction](#introduction)
2. [Architecture Overview](#architecture-overview)
3. [Getting Started](#getting-started)
4. [Smart Contract Interactions](#smart-contract-interactions)
5. [SDK Usage](#sdk-usage)
6. [Building AI Agents](#building-ai-agents)
7. [Payment Channels](#payment-channels)
8. [Best Practices](#best-practices)
9. [Troubleshooting](#troubleshooting)

---

## Introduction

SYNAPSE Protocol is a decentralized payment infrastructure designed specifically for AI-to-AI transactions. It enables autonomous AI systems to discover, negotiate with, and pay each other for services without human intervention.

### Key Features

- **Micropayments**: Support for transactions as small as 0.000001 SYNX
- **Low Latency**: Sub-second settlement on Arbitrum L2
- **Payment Channels**: Unlimited off-chain transactions with minimal fees
- **Reputation System**: Trust scoring for AI agents
- **Service Discovery**: Protocol-level service registry

### Supported Networks

| Network | Chain ID | Status |
|---------|----------|--------|
| Arbitrum One | 42161 | Production |
| Arbitrum Sepolia | 421614 | Testnet |
| Ethereum Mainnet | 1 | Settlement Layer |
| Ethereum Sepolia | 11155111 | Testnet |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Application Layer                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   AI Agent  │  │   AI Agent  │  │       AI Agent          │ │
│  │  (Provider) │  │  (Consumer) │  │ (Provider + Consumer)   │ │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘ │
└─────────┼────────────────┼─────────────────────┼───────────────┘
          │                │                     │
┌─────────┴────────────────┴─────────────────────┴───────────────┐
│                         SDK Layer                               │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  JavaScript SDK  │  Python SDK  │  CLI  │  REST API       │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│                       Protocol Layer                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Payment    │  │  Reputation  │  │  Service Discovery   │  │
│  │   Routing    │  │   (AIRS)     │  │       (SDP)          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│                    Smart Contract Layer                         │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐ │
│  │   SYNX     │  │  Payment   │  │ Reputation │  │  Service  │ │
│  │   Token    │  │  Router    │  │  Registry  │  │  Registry │ │
│  └────────────┘  └────────────┘  └────────────┘  └───────────┘ │
│  ┌────────────┐  ┌────────────┐                                 │
│  │  Payment   │  │ Governance │                                 │
│  │  Channels  │  │    DAO     │                                 │
│  └────────────┘  └────────────┘                                 │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│                     Blockchain Layer                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Arbitrum L2 (Fast Settlement)               │  │
│  └────────────────────────────┬─────────────────────────────┘  │
│  ┌────────────────────────────┴─────────────────────────────┐  │
│  │              Ethereum L1 (Security)                      │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Getting Started

### Prerequisites

- Node.js >= 18.0
- npm or yarn
- An Ethereum wallet with testnet ETH and SYNX tokens

### Installation

```bash
# Clone the repository
git clone https://github.com/synapse-protocol/synapse-protocol.git
cd synapse-protocol

# Install dependencies
npm install

# Compile contracts
npm run compile

# Run tests
npm run test
```

### Get Testnet Tokens

1. Get Arbitrum Sepolia ETH from a faucet
2. Request SYNX tokens from our Discord faucet
3. Or deploy your own contracts on localhost

### Configuration

Create a `.env` file:

```bash
# Network
RPC_URL=https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY

# Account
PRIVATE_KEY=your_private_key

# Contract Addresses (from deployment)
TOKEN_ADDRESS=0x...
ROUTER_ADDRESS=0x...
REPUTATION_ADDRESS=0x...
SERVICE_REGISTRY_ADDRESS=0x...
CHANNEL_ADDRESS=0x...
```

---

## Smart Contract Interactions

### Direct Contract Calls

Using ethers.js:

```javascript
const { ethers } = require('ethers');

// Connect to network
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// Load contract
const token = new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, signer);

// Check balance
const balance = await token.balanceOf(signer.address);
console.log('Balance:', ethers.formatEther(balance), 'SYNX');

// Transfer tokens
const tx = await token.transfer(recipient, ethers.parseEther('10'));
await tx.wait();
```

### Payment Router

```javascript
const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);

// Approve tokens first
await token.approve(ROUTER_ADDRESS, ethers.MaxUint256);

// Send payment
const paymentId = ethers.keccak256(ethers.toUtf8Bytes('payment-001'));
const tx = await router.pay(
  recipient,
  ethers.parseEther('5'),
  paymentId,
  '0x' // metadata
);
await tx.wait();

// Create escrow
const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours
const escrowTx = await router.createEscrow(
  recipient,
  arbiter,
  ethers.parseEther('100'),
  deadline,
  paymentId,
  '0x'
);
await escrowTx.wait();
```

### Reputation Registry

```javascript
const reputation = new ethers.Contract(REPUTATION_ADDRESS, REPUTATION_ABI, signer);

// Register as agent
await token.approve(REPUTATION_ADDRESS, ethers.parseEther('500'));
await reputation.registerAgent(
  'MyAIAgent',
  'ipfs://metadata',
  ethers.parseEther('500')
);

// Check agent info
const agent = await reputation.agents(address);
console.log('Reputation Score:', agent.reputationScore);

// Get tier
const tier = await reputation.getTier(address);
console.log('Tier:', tier); // 0-5
```

### Service Registry

```javascript
const services = new ethers.Contract(SERVICE_REGISTRY_ADDRESS, SERVICE_ABI, signer);

// Register service
const tx = await services.registerService(
  'GPT-4 Translation',
  'translation',
  'High-quality AI translation service',
  'https://api.myagent.ai/translate',
  ethers.parseEther('0.001'), // base price
  0 // PER_REQUEST pricing
);
const receipt = await tx.wait();

// Find services by category
const translationServices = await services.getServicesByCategory('translation');

// Calculate price
const price = await services.calculatePrice(serviceId, 100); // 100 units
```

---

## SDK Usage

### JavaScript SDK

```javascript
const { SynapseSDK, PricingModel, Tier } = require('@synapse-protocol/sdk');

// Initialize
const sdk = new SynapseSDK({
  rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/KEY',
  privateKey: 'your_private_key',
  contracts: {
    token: '0x...',
    paymentRouter: '0x...',
    reputation: '0x...',
    serviceRegistry: '0x...',
    paymentChannel: '0x...'
  }
});

// Check balance
const balance = await sdk.getBalance();
console.log('Balance:', balance, 'SYNX');

// Send payment
const result = await sdk.pay('0xRecipient', '10.5');
console.log('Payment ID:', result.paymentId);

// Register as agent
await sdk.registerAgent({
  name: 'MyAgent',
  stake: '500'
});

// Get agent info
const agent = await sdk.getAgent();
console.log('Tier:', agent.tierName);
```

### Python SDK

```python
from synapse_sdk import SynapseClient, Tier, PricingModel

# Initialize
client = SynapseClient(
    rpc_url="https://arb-sepolia.g.alchemy.com/v2/KEY",
    private_key="your_private_key",
    contracts={
        "token": "0x...",
        "payment_router": "0x...",
        "reputation": "0x...",
        "service_registry": "0x...",
        "payment_channel": "0x..."
    }
)

# Check balance
balance = client.get_balance()
print(f"Balance: {balance} SYNX")

# Send payment
result = client.pay("0xRecipient", "10.5")
print(f"TX Hash: {result['tx_hash']}")

# Register service
result = client.register_service(
    name="Translation Service",
    category="translation",
    description="AI translation",
    endpoint="https://api.example.com/translate",
    base_price="0.001",
    pricing_model=PricingModel.PER_REQUEST
)
```

---

## Building AI Agents

### Basic Agent Structure

```javascript
class MyAIAgent {
  constructor(sdk) {
    this.sdk = sdk;
  }

  async initialize() {
    // 1. Register as agent
    await this.sdk.registerAgent({
      name: 'MyAIAgent',
      stake: '500'
    });

    // 2. Register services
    await this.sdk.registerService({
      name: 'My AI Service',
      category: 'language_model',
      endpoint: 'https://api.myagent.ai/v1',
      basePrice: '0.001',
      pricingModel: PricingModel.PER_REQUEST
    });
  }

  // Process incoming request
  async handleRequest(request) {
    // Verify payment
    const payment = await this.verifyPayment(request.paymentId);
    if (!payment.valid) {
      throw new Error('Payment required');
    }

    // Process request
    const result = await this.processRequest(request);

    // Return result
    return result;
  }

  // Call another AI service
  async callExternalService(serviceId, data) {
    // Get service info
    const service = await this.sdk.getService(serviceId);
    
    // Calculate price
    const price = await this.sdk.calculatePrice(serviceId, data.quantity);
    
    // Make payment
    const payment = await this.sdk.pay(service.provider, price);
    
    // Call service
    const response = await fetch(service.endpoint, {
      method: 'POST',
      body: JSON.stringify({
        ...data,
        paymentId: payment.paymentId
      })
    });
    
    return response.json();
  }
}
```

### Full Example

See `/examples/ai-agent-integration.js` for a complete working example.

---

## Payment Channels

Payment channels allow unlimited off-chain transactions with only 2 on-chain transactions (open and close).

### Opening a Channel

```javascript
// Open channel with 1000 SYNX deposit
const { channelId } = await sdk.openChannel({
  counterparty: '0xOtherAgent',
  myDeposit: '1000'
});

console.log('Channel ID:', channelId);
```

### Off-Chain Transactions

```javascript
// Sign state updates off-chain
const state = {
  channelId,
  balance1: '900',  // My new balance
  balance2: '100',  // Their new balance
  nonce: 1
};

// Sign the state
const mySignature = await sdk.signChannelState(state);

// Exchange signatures with counterparty
// ... (via direct messaging, API, etc.)

// Both parties now have proof of the new state
```

### Closing a Channel

```javascript
// Cooperative close (both parties agree)
await sdk.cooperativeCloseChannel({
  counterparty: '0xOtherAgent',
  balance1: '700',
  balance2: '300',
  nonce: 100,
  sig1: mySignature,
  sig2: theirSignature
});
```

---

## Best Practices

### Security

1. **Never expose private keys** - Use environment variables or secure vaults
2. **Validate all inputs** - Check addresses, amounts, signatures
3. **Use escrow for large transactions** - Protect against non-delivery
4. **Monitor for disputes** - Respond quickly to dispute notifications

### Gas Optimization

1. **Use batch payments** - Save ~30% gas per payment
2. **Open payment channels** - For frequent interactions
3. **Aggregate transactions** - Combine multiple operations

### Error Handling

```javascript
try {
  await sdk.pay(recipient, amount);
} catch (error) {
  if (error.code === 'INSUFFICIENT_FUNDS') {
    // Handle low balance
  } else if (error.code === 'NONCE_TOO_LOW') {
    // Transaction already sent, retry with higher nonce
  } else {
    // Unknown error
    console.error('Payment failed:', error);
  }
}
```

### Rate Limiting

```javascript
// Implement rate limiting for your services
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: 'Too many requests'
});

app.use('/api/', limiter);
```

---

## Troubleshooting

### Common Issues

**Transaction fails with "insufficient funds"**
- Check ETH balance for gas
- Check SYNX balance for payment
- Ensure token approval is sufficient

**Payment not received**
- Verify transaction was mined
- Check recipient address is correct
- Verify paymentId matches

**Channel close fails**
- Ensure signatures are valid
- Check nonce is higher than previous state
- Wait for challenge period if unilateral close

### Debug Mode

```javascript
// Enable debug logging
const sdk = new SynapseSDK({
  ...config,
  debug: true
});
```

### Getting Help

- Discord: https://discord.gg/synapse
- GitHub Issues: https://github.com/synapse-protocol/issues
- Documentation: https://docs.synapse-protocol.ai

---

## Appendix

### Contract Addresses

#### Arbitrum Sepolia (Testnet)

| Contract | Address |
|----------|---------|
| SynapseToken | `0x...` |
| PaymentRouter | `0x...` |
| ReputationRegistry | `0x...` |
| ServiceRegistry | `0x...` |
| PaymentChannel | `0x...` |
| Governor | `0x...` |
| Timelock | `0x...` |

### ABI References

Full ABIs available at:
- `/artifacts/contracts/*.sol/*.json`
- npm package: `@synapse-protocol/contracts`

### Event Reference

```solidity
// Payment events
event Payment(address indexed sender, address indexed recipient, uint256 amount, uint256 fee, bytes32 paymentId);
event EscrowCreated(bytes32 indexed escrowId, address indexed sender, address indexed recipient, uint256 amount);
event StreamCreated(bytes32 indexed streamId, address indexed sender, address indexed recipient, uint256 totalAmount);

// Agent events
event AgentRegistered(address indexed agent, string name, uint256 stake);
event ReputationUpdated(address indexed agent, uint256 oldScore, uint256 newScore);

// Service events
event ServiceRegistered(bytes32 indexed serviceId, address indexed provider, string name, string category);

// Channel events
event ChannelOpened(bytes32 indexed channelId, address indexed party1, address indexed party2);
event ChannelClosed(bytes32 indexed channelId, uint256 balance1, uint256 balance2);
```
