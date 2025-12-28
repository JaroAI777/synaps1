# SYNAPSE Protocol SDK Documentation

Complete reference for all SYNAPSE Protocol SDKs.

## Table of Contents

1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [JavaScript SDK](#javascript-sdk)
4. [Python SDK](#python-sdk)
5. [Go SDK](#go-sdk)
6. [React Native SDK](#react-native-sdk)
7. [CLI Tool](#cli-tool)
8. [Common Patterns](#common-patterns)
9. [Error Handling](#error-handling)
10. [Best Practices](#best-practices)

---

## Installation

### JavaScript / TypeScript

```bash
npm install @synapse-protocol/sdk
# or
yarn add @synapse-protocol/sdk
```

### Python

```bash
pip install synapse-protocol
```

### Go

```bash
go get github.com/synapse-protocol/sdk-go
```

### React Native

```bash
npm install @synapse-protocol/react-native-sdk
```

### CLI

```bash
npm install -g @synapse-protocol/cli
```

---

## Quick Start

### JavaScript

```javascript
import { SynapseSDK } from '@synapse-protocol/sdk';

const sdk = new SynapseSDK({
  rpcUrl: 'https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY',
  privateKey: process.env.PRIVATE_KEY,
  contracts: {
    token: '0x...',
    paymentRouter: '0x...',
    reputation: '0x...',
    serviceRegistry: '0x...',
    paymentChannel: '0x...'
  }
});

await sdk.initialize();

// Send payment
const result = await sdk.pay({
  recipient: '0x...',
  amount: '10.5',
  metadata: 'Service payment'
});

console.log('Payment sent:', result.transactionHash);
```

### Python

```python
from synapse_sdk import SynapseSDK

sdk = SynapseSDK(
    rpc_url='https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY',
    private_key=os.environ['PRIVATE_KEY'],
    contracts={
        'token': '0x...',
        'payment_router': '0x...',
        'reputation': '0x...',
        'service_registry': '0x...',
        'payment_channel': '0x...'
    }
)

# Send payment
result = sdk.pay(
    recipient='0x...',
    amount='10.5',
    metadata='Service payment'
)

print(f'Payment sent: {result.transaction_hash}')
```

### Go

```go
package main

import (
    "github.com/synapse-protocol/sdk-go"
)

func main() {
    client, err := synapse.NewClient(synapse.Config{
        RPCUrl:     "https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY",
        PrivateKey: os.Getenv("PRIVATE_KEY"),
        Contracts: synapse.ContractAddresses{
            Token:         "0x...",
            PaymentRouter: "0x...",
        },
    })

    result, err := client.Pay("0x...", "10.5", "")
    fmt.Printf("Payment sent: %s\n", result.TransactionHash)
}
```

---

## JavaScript SDK

### Configuration

```typescript
interface SDKConfig {
  rpcUrl: string;           // Ethereum RPC URL
  privateKey?: string;      // Optional: for signing transactions
  contracts: {
    token: string;
    paymentRouter: string;
    reputation: string;
    serviceRegistry: string;
    paymentChannel: string;
    subscriptionManager?: string;
    staking?: string;
  };
  gasLimit?: number;        // Default: 500000
  maxFeePerGas?: bigint;    // EIP-1559
  maxPriorityFeePerGas?: bigint;
}
```

### Token Operations

```javascript
// Get balance
const balance = await sdk.getBalance('0x...');
console.log(balance); // "1234.5678"

// Transfer tokens
const txHash = await sdk.transfer('0x...', '100');

// Approve spending
await sdk.approve('0x...', '1000');

// Approve all protocol contracts
await sdk.approveAll();
```

### Payment Operations

```javascript
// Direct payment
const payment = await sdk.pay({
  recipient: '0x...',
  amount: '10.5',
  metadata: 'Payment for API call'
});

// Batch payment
const batch = await sdk.batchPay([
  { recipient: '0x...', amount: '5' },
  { recipient: '0x...', amount: '10' },
  { recipient: '0x...', amount: '15' }
]);

// Create escrow
const escrow = await sdk.createEscrow({
  recipient: '0x...',
  arbiter: '0x...',
  amount: '100',
  deadline: Math.floor(Date.now() / 1000) + 86400 // 24 hours
});

// Release escrow
await sdk.releaseEscrow(escrow.escrowId);

// Create payment stream
const stream = await sdk.createStream({
  recipient: '0x...',
  totalAmount: '1000',
  startTime: Math.floor(Date.now() / 1000),
  endTime: Math.floor(Date.now() / 1000) + 2592000 // 30 days
});

// Withdraw from stream
await sdk.withdrawFromStream(stream.streamId);
```

### Agent Operations

```javascript
// Register as AI agent
await sdk.registerAgent({
  name: 'My AI Agent',
  metadataUri: 'ipfs://...',
  stake: '1000'
});

// Get agent info
const agent = await sdk.getAgent('0x...');
console.log(agent);
// {
//   address: '0x...',
//   name: 'My AI Agent',
//   reputation: 85,
//   tier: 3, // Gold
//   stake: '1000',
//   successRate: 98.5
// }

// Increase stake
await sdk.increaseStake('500');

// Rate a service
await sdk.rateService({
  provider: '0x...',
  category: 'language_model',
  rating: 5
});

// Create dispute
await sdk.createDispute({
  defendant: '0x...',
  reason: 'Service not delivered',
  transactionId: '0x...'
});
```

### Service Operations

```javascript
// Register service
const service = await sdk.registerService({
  name: 'GPT-4 API',
  category: 'language_model',
  description: 'High-quality language model API',
  endpoint: 'https://api.example.com/v1/chat',
  basePrice: '0.001',
  pricingModel: 0 // PER_REQUEST
});

// Get service
const info = await sdk.getService(serviceId);

// Find services by category
const services = await sdk.findServicesByCategory('language_model');

// Calculate price
const price = await sdk.calculatePrice(serviceId, 100);

// Request quote
const quote = await sdk.requestQuote({
  serviceId,
  quantity: 100,
  specs: { model: 'gpt-4', maxTokens: 4096 }
});

// Accept quote (pays automatically)
await sdk.acceptQuote(quote.quoteId);
```

### Channel Operations

```javascript
// Open payment channel
const channel = await sdk.openChannel({
  counterparty: '0x...',
  myDeposit: '100',
  theirDeposit: '0'
});

// Get channel info
const info = await sdk.getChannel('0x...', '0x...');

// Sign channel state (off-chain)
const signature = await sdk.signChannelState({
  channelId: channel.channelId,
  balance1: '80',
  balance2: '20',
  nonce: 1
});

// Cooperative close
await sdk.cooperativeClose({
  counterparty: '0x...',
  balance1: '80',
  balance2: '20',
  nonce: 100,
  signature1: sig1,
  signature2: sig2
});
```

### Subscription Operations

```javascript
// Create subscription plan (as provider)
const plan = await sdk.createPlan({
  name: 'Pro Plan',
  description: 'Unlimited API access',
  basePrice: '100',
  billingPeriod: 30 * 24 * 3600, // 30 days
  trialPeriod: 7 * 24 * 3600, // 7 days
  usageLimit: 10000,
  overageRate: '0.01'
});

// Subscribe to plan
const subscription = await sdk.subscribe(plan.planId, 1);

// Get subscription status
const status = await sdk.getSubscriptionStatus(subscription.subscriptionId);

// Cancel subscription
await sdk.cancelSubscription(subscription.subscriptionId);
```

### Staking Operations

```javascript
// Stake tokens
const stake = await sdk.stake({
  amount: '1000',
  lockTierId: 2 // 90-day lock, 1.5x boost
});

// Get staking info
const info = await sdk.getStakeInfo();
console.log(info);
// {
//   amount: '1000',
//   shares: '1500',
//   lockEnd: Date,
//   boostMultiplier: 1.5,
//   pendingRewards: '12.5'
// }

// Claim rewards
await sdk.claimRewards();

// Compound rewards
await sdk.compound();

// Initiate unstake
await sdk.unstake('500');
```

### Event Listening

```javascript
// Listen for payments
sdk.on('payment', (event) => {
  console.log('Payment received:', event);
});

// Listen for specific event types
sdk.on('agent_registered', (event) => {
  console.log('New agent:', event.agent);
});

sdk.on('channel_opened', (event) => {
  console.log('Channel opened:', event.channelId);
});

// Remove listener
sdk.off('payment', handler);
```

---

## Python SDK

### Async Support

```python
import asyncio
from synapse_sdk import AsyncSynapseSDK

async def main():
    sdk = AsyncSynapseSDK(config)
    
    # Async operations
    balance = await sdk.get_balance()
    result = await sdk.pay(recipient='0x...', amount='10')
    
asyncio.run(main())
```

### Type Hints

```python
from synapse_sdk.types import (
    PaymentParams,
    PaymentResult,
    AgentInfo,
    ServiceInfo
)

def process_payment(params: PaymentParams) -> PaymentResult:
    return sdk.pay(**params.dict())
```

---

## Go SDK

### Error Handling

```go
result, err := client.Pay(recipient, amount, metadata)
if err != nil {
    switch e := err.(type) {
    case *synapse.InsufficientBalanceError:
        log.Printf("Not enough balance: need %s, have %s", e.Required, e.Available)
    case *synapse.TransactionFailedError:
        log.Printf("Transaction failed: %s", e.Reason)
    default:
        log.Printf("Unknown error: %v", err)
    }
    return
}
```

### Context Support

```go
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()

result, err := client.PayWithContext(ctx, recipient, amount, metadata)
```

---

## React Native SDK

### Provider Setup

```jsx
import { SynapseProvider } from '@synapse-protocol/react-native-sdk';

function App() {
  return (
    <SynapseProvider config={config}>
      <YourApp />
    </SynapseProvider>
  );
}
```

### Hooks

```jsx
import { 
  useBalance, 
  usePayment, 
  useAgent, 
  useServices 
} from '@synapse-protocol/react-native-sdk';

function PaymentScreen() {
  const { balance, refresh } = useBalance();
  const { pay, loading, error } = usePayment();
  
  const handlePay = async () => {
    const result = await pay({
      recipient: '0x...',
      amount: '10'
    });
    if (result) {
      Alert.alert('Success', `Payment sent: ${result.transactionHash}`);
    }
  };
  
  return (
    <View>
      <Text>Balance: {balance} SYNX</Text>
      <Button onPress={handlePay} disabled={loading}>
        Pay 10 SYNX
      </Button>
    </View>
  );
}
```

### Components

```jsx
import { 
  BalanceDisplay,
  PaymentButton,
  ServiceCard,
  TransactionHistory
} from '@synapse-protocol/react-native-sdk';

function WalletScreen() {
  return (
    <View>
      <BalanceDisplay showRefresh />
      
      <PaymentButton
        recipient="0x..."
        amount="10"
        onSuccess={(result) => console.log(result)}
      />
      
      <TransactionHistory limit={10} />
    </View>
  );
}
```

---

## CLI Tool

### Commands

```bash
# Configuration
synapse config set rpc-url https://...
synapse config set private-key 0x...

# Token operations
synapse balance
synapse balance 0x...
synapse transfer 0x... 100
synapse approve 0x... 1000

# Payments
synapse pay 0x... 10 --metadata "Payment"
synapse batch-pay recipients.json

# Agents
synapse agent register "My Agent" --stake 1000
synapse agent info 0x...
synapse agent stake 500

# Services
synapse service list language_model
synapse service info <serviceId>
synapse service register --name "API" --category "language_model"

# Channels
synapse channel open 0x... --deposit 100
synapse channel info 0x... 0x...
synapse channel close 0x...

# Staking
synapse stake 1000 --lock 90
synapse stake info
synapse stake claim

# Admin
synapse admin pause token
synapse admin unpause token
```

---

## Common Patterns

### Retry with Exponential Backoff

```javascript
async function withRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
}

const result = await withRetry(() => sdk.pay(params));
```

### Transaction Monitoring

```javascript
const result = await sdk.pay(params);

// Wait for confirmation
const receipt = await sdk.waitForTransaction(result.transactionHash);

if (receipt.status === 1) {
  console.log('Transaction confirmed in block:', receipt.blockNumber);
} else {
  console.log('Transaction failed');
}
```

### Balance Checking

```javascript
async function ensureBalance(amount) {
  const balance = await sdk.getBalance();
  if (parseFloat(balance) < parseFloat(amount)) {
    throw new Error(`Insufficient balance: ${balance} < ${amount}`);
  }
}

await ensureBalance('100');
await sdk.pay({ recipient, amount: '100' });
```

---

## Error Handling

### Error Types

```typescript
// Insufficient balance
class InsufficientBalanceError extends Error {
  required: string;
  available: string;
}

// Transaction failed
class TransactionFailedError extends Error {
  transactionHash: string;
  reason: string;
}

// Invalid signature
class InvalidSignatureError extends Error {}

// Agent not registered
class AgentNotRegisteredError extends Error {
  address: string;
}

// Service not found
class ServiceNotFoundError extends Error {
  serviceId: string;
}
```

### Error Handling Pattern

```javascript
try {
  await sdk.pay(params);
} catch (error) {
  if (error instanceof InsufficientBalanceError) {
    console.log(`Need ${error.required}, have ${error.available}`);
  } else if (error instanceof TransactionFailedError) {
    console.log(`TX failed: ${error.reason}`);
  } else {
    throw error;
  }
}
```

---

## Best Practices

### 1. Always Check Allowances

```javascript
const allowance = await sdk.getAllowance(spender);
if (allowance < amount) {
  await sdk.approve(spender, amount);
}
```

### 2. Use Batch Operations

```javascript
// Instead of multiple single payments
for (const p of payments) {
  await sdk.pay(p); // Expensive!
}

// Use batch payment
await sdk.batchPay(payments); // Single transaction
```

### 3. Handle Gas Properly

```javascript
const sdk = new SynapseSDK({
  ...config,
  gasLimit: 500000,
  maxFeePerGas: ethers.parseUnits('50', 'gwei'),
  maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei')
});
```

### 4. Secure Key Management

```javascript
// Never hardcode keys
const privateKey = process.env.PRIVATE_KEY;

// Use secure key storage in production
const privateKey = await keyVault.getSecret('synapse-private-key');
```

### 5. Monitor Events

```javascript
// Set up monitoring
sdk.on('payment', async (event) => {
  await analytics.track('payment', event);
  await notifications.send(event.recipient, 'Payment received');
});
```

---

## Support

- Documentation: https://docs.synapse-protocol.ai
- Discord: https://discord.gg/synapse
- GitHub: https://github.com/synapse-protocol
- Email: developers@synapse-protocol.ai
