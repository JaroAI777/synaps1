/**
 * SYNAPSE Protocol SDK - Usage Examples
 * 
 * This file demonstrates common usage patterns for the SYNAPSE SDK
 */

const { SynapseSDK, Tier, PricingModel } = require('./index');

// Contract addresses (replace with actual deployed addresses)
const CONTRACTS = {
  token: '0x...', // SynapseToken address
  paymentRouter: '0x...', // PaymentRouter address
  reputation: '0x...', // ReputationRegistry address
  serviceRegistry: '0x...', // ServiceRegistry address
  paymentChannel: '0x...' // PaymentChannel address
};

// ==================== Example 1: Basic Setup ====================
async function basicSetup() {
  // Initialize SDK with RPC and private key
  const sdk = new SynapseSDK({
    rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
    privateKey: 'YOUR_PRIVATE_KEY',
    contracts: CONTRACTS
  });

  // Get network info
  const network = await sdk.getNetworkInfo();
  console.log('Connected to:', network.name, 'Chain ID:', network.chainId);

  // Get token balance
  const address = await sdk.getAddress();
  const balance = await sdk.getBalance(address);
  console.log('SYNX Balance:', balance);

  // Approve all contracts for spending
  await sdk.approveAll();
  console.log('All contracts approved');
}

// ==================== Example 2: AI Agent Registration ====================
async function registerAsAgent() {
  const sdk = new SynapseSDK({
    rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
    privateKey: 'YOUR_PRIVATE_KEY',
    contracts: CONTRACTS
  });

  // Register as an AI agent
  const receipt = await sdk.registerAgent({
    name: 'GPT-4-Agent',
    metadataUri: 'ipfs://QmYourMetadataHash',
    stake: '1000' // 1000 SYNX stake
  });
  console.log('Agent registered! TX:', receipt.hash);

  // Check agent status
  const address = await sdk.getAddress();
  const agent = await sdk.getAgent(address);
  console.log('Agent Info:', {
    name: agent.name,
    tier: agent.tierName,
    reputationScore: agent.reputationScore,
    stake: agent.stake + ' SYNX'
  });
}

// ==================== Example 3: Direct Payment ====================
async function sendPayment() {
  const sdk = new SynapseSDK({
    rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
    privateKey: 'YOUR_PRIVATE_KEY',
    contracts: CONTRACTS
  });

  // Send a direct payment
  const result = await sdk.pay(
    '0xRecipientAddress',
    '10.5', // 10.5 SYNX
    null, // Auto-generate payment ID
    '0x' // No metadata
  );

  console.log('Payment sent!');
  console.log('Payment ID:', result.paymentId);
  console.log('TX Hash:', result.receipt.hash);
}

// ==================== Example 4: Batch Payments ====================
async function sendBatchPayments() {
  const sdk = new SynapseSDK({
    rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
    privateKey: 'YOUR_PRIVATE_KEY',
    contracts: CONTRACTS
  });

  // Send multiple payments in one transaction
  const payments = [
    { recipient: '0xAgent1', amount: '5.0' },
    { recipient: '0xAgent2', amount: '10.0' },
    { recipient: '0xAgent3', amount: '7.5' },
    { recipient: '0xAgent4', amount: '2.5' }
  ];

  const receipt = await sdk.batchPay(payments);
  console.log('Batch payment sent! TX:', receipt.hash);
  console.log('Total paid:', payments.reduce((sum, p) => sum + parseFloat(p.amount), 0), 'SYNX');
}

// ==================== Example 5: Escrow Payment ====================
async function createEscrowPayment() {
  const sdk = new SynapseSDK({
    rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
    privateKey: 'YOUR_PRIVATE_KEY',
    contracts: CONTRACTS
  });

  // Create an escrow payment (releases when service is delivered)
  const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
  
  const result = await sdk.createEscrow({
    recipient: '0xServiceProvider',
    arbiter: '0xTrustedArbiter',
    amount: '100', // 100 SYNX
    deadline: deadline
  });

  console.log('Escrow created!');
  console.log('Escrow ID:', result.escrowId);
  console.log('Deadline:', new Date(deadline * 1000));

  // Later, release the escrow when satisfied
  // await sdk.releaseEscrow(result.escrowId);
}

// ==================== Example 6: Payment Stream ====================
async function createPaymentStream() {
  const sdk = new SynapseSDK({
    rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
    privateKey: 'YOUR_PRIVATE_KEY',
    contracts: CONTRACTS
  });

  const now = Math.floor(Date.now() / 1000);
  const oneWeek = 7 * 24 * 60 * 60;

  // Create a payment stream (continuous payment over time)
  const result = await sdk.createStream({
    recipient: '0xWorkerAgent',
    totalAmount: '1000', // 1000 SYNX total
    startTime: now,
    endTime: now + oneWeek // 1 week stream
  });

  console.log('Stream created!');
  console.log('Stream ID:', result.streamId);
  console.log('Rate: ~142.86 SYNX per day');
}

// ==================== Example 7: Gasless Payment ====================
async function signGaslessPayment() {
  const sdk = new SynapseSDK({
    rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
    privateKey: 'YOUR_PRIVATE_KEY',
    contracts: CONTRACTS
  });

  // Sign a gasless payment (someone else pays the gas)
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour validity
  
  const signedPayment = await sdk.signGaslessPayment({
    recipient: '0xRecipient',
    amount: '50',
    paymentId: '0x' + Buffer.from('gasless-001').toString('hex').padEnd(64, '0'),
    deadline: deadline
  });

  console.log('Gasless payment signed!');
  console.log('Signature:', signedPayment.signature);
  console.log('Can be submitted by any relayer before:', new Date(deadline * 1000));

  // The relayer would then call:
  // await router.gaslessPay(
  //   signedPayment.sender,
  //   signedPayment.recipient,
  //   signedPayment.amount,
  //   signedPayment.paymentId,
  //   signedPayment.deadline,
  //   signedPayment.signature
  // );
}

// ==================== Example 8: Service Registration ====================
async function registerService() {
  const sdk = new SynapseSDK({
    rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
    privateKey: 'YOUR_PRIVATE_KEY',
    contracts: CONTRACTS
  });

  // Register a new AI service
  const result = await sdk.registerService({
    name: 'GPT-4 Translation Service',
    category: 'translation',
    description: 'High-quality translation between 100+ languages using GPT-4',
    endpoint: 'https://api.myagent.ai/v1/translate',
    basePrice: '0.001', // 0.001 SYNX per request
    pricingModel: PricingModel.PER_REQUEST
  });

  console.log('Service registered!');
  console.log('Service ID:', result.serviceId);
}

// ==================== Example 9: Service Discovery & Usage ====================
async function useService() {
  const sdk = new SynapseSDK({
    rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
    privateKey: 'YOUR_PRIVATE_KEY',
    contracts: CONTRACTS
  });

  // Find translation services
  const serviceIds = await sdk.findServicesByCategory('translation');
  console.log('Found', serviceIds.length, 'translation services');

  // Get details of first service
  const service = await sdk.getService(serviceIds[0]);
  console.log('Service:', service.name);
  console.log('Price:', service.basePrice, 'SYNX per', service.pricingModelName);
  console.log('Endpoint:', service.endpoint);

  // Calculate price for 100 requests
  const price = await sdk.calculatePrice(serviceIds[0], 100);
  console.log('Price for 100 requests:', price, 'SYNX');

  // Request a quote
  const quote = await sdk.requestQuote(serviceIds[0], 100);
  console.log('Quote ID:', quote.quoteId);

  // Accept the quote (makes payment)
  const receipt = await sdk.acceptQuote(quote.quoteId);
  console.log('Quote accepted! Now call the service endpoint');
}

// ==================== Example 10: Payment Channels ====================
async function usePaymentChannel() {
  const sdk = new SynapseSDK({
    rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
    privateKey: 'YOUR_PRIVATE_KEY',
    contracts: CONTRACTS
  });

  const counterparty = '0xOtherAgent';

  // Open a bidirectional payment channel
  const result = await sdk.openChannel({
    counterparty: counterparty,
    myDeposit: '1000', // 1000 SYNX
    theirDeposit: '500' // Expecting 500 SYNX from them
  });
  console.log('Channel opened!');
  console.log('Channel ID:', result.channelId);

  // Get channel info
  const channel = await sdk.getChannel(await sdk.getAddress(), counterparty);
  console.log('Channel Status:', channel.statusName);
  console.log('My Balance:', channel.balance1, 'SYNX');
  console.log('Their Balance:', channel.balance2, 'SYNX');

  // Off-chain: Sign state updates
  // After many off-chain transactions, final state is:
  const finalState = {
    channelId: result.channelId,
    balance1: '700', // I have 700 SYNX
    balance2: '800', // They have 800 SYNX
    nonce: 100 // After 100 state updates
  };

  // Sign the final state
  const mySignature = await sdk.signChannelState(finalState);
  console.log('My signature for final state:', mySignature);

  // When both parties have signed, close cooperatively
  // await sdk.cooperativeCloseChannel({
  //   counterparty: counterparty,
  //   balance1: '700',
  //   balance2: '800',
  //   nonce: 100,
  //   sig1: mySignature,
  //   sig2: theirSignature
  // });
}

// ==================== Example 11: Dispute Resolution ====================
async function handleDispute() {
  const sdk = new SynapseSDK({
    rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
    privateKey: 'YOUR_PRIVATE_KEY',
    contracts: CONTRACTS
  });

  // Create a dispute against a bad actor
  const result = await sdk.createDispute({
    defendant: '0xBadAgent',
    reason: 'Service was not delivered as promised',
    transactionId: '0x...' // Payment ID of the failed transaction
  });

  console.log('Dispute created!');
  console.log('Dispute ID:', result.disputeId);
  console.log('An arbiter will review and resolve');
}

// ==================== Example 12: Rate a Service ====================
async function rateServiceProvider() {
  const sdk = new SynapseSDK({
    rpcUrl: 'https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY',
    privateKey: 'YOUR_PRIVATE_KEY',
    contracts: CONTRACTS
  });

  // Rate a service after using it
  await sdk.rateService(
    '0xServiceProvider',
    'translation',
    5 // 5 stars
  );

  console.log('Service rated!');
}

// ==================== Main ====================
async function main() {
  console.log('SYNAPSE SDK Examples\n');
  
  // Run examples (uncomment as needed)
  // await basicSetup();
  // await registerAsAgent();
  // await sendPayment();
  // await sendBatchPayments();
  // await createEscrowPayment();
  // await createPaymentStream();
  // await signGaslessPayment();
  // await registerService();
  // await useService();
  // await usePaymentChannel();
  // await handleDispute();
  // await rateServiceProvider();
  
  console.log('\nExamples completed!');
}

main().catch(console.error);
