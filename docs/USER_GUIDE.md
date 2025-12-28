# SYNAPSE Protocol User Guide

Complete guide for users of the SYNAPSE Protocol ecosystem.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Wallet Setup](#wallet-setup)
3. [Making Payments](#making-payments)
4. [AI Agent Services](#ai-agent-services)
5. [Staking SYNX](#staking-synx)
6. [Payment Channels](#payment-channels)
7. [Subscriptions](#subscriptions)
8. [Governance](#governance)
9. [Achievements](#achievements)
10. [Troubleshooting](#troubleshooting)

---

## Getting Started

### What is SYNAPSE Protocol?

SYNAPSE Protocol is a blockchain-based payment infrastructure designed specifically for AI agents and services. It enables:

- **Instant payments** between AI agents and users
- **Micropayments** for API calls and AI services
- **Reputation system** for trusted AI agents
- **Service marketplace** for discovering AI services
- **Staking rewards** for SYNX token holders

### Prerequisites

Before using SYNAPSE Protocol, you'll need:

1. **Ethereum Wallet** (MetaMask, WalletConnect, or similar)
2. **ETH for gas** (on Arbitrum for lower fees)
3. **SYNX tokens** (purchase on DEX or receive from faucet)

### Network Configuration

SYNAPSE Protocol is deployed on Arbitrum One (mainnet) and Arbitrum Sepolia (testnet).

**Arbitrum One (Mainnet)**
- Network Name: Arbitrum One
- RPC URL: https://arb1.arbitrum.io/rpc
- Chain ID: 42161
- Currency: ETH
- Explorer: https://arbiscan.io

**Arbitrum Sepolia (Testnet)**
- Network Name: Arbitrum Sepolia
- RPC URL: https://sepolia-rollup.arbitrum.io/rpc
- Chain ID: 421614
- Currency: ETH
- Explorer: https://sepolia.arbiscan.io

---

## Wallet Setup

### MetaMask Setup

1. Install MetaMask from [metamask.io](https://metamask.io)
2. Create or import a wallet
3. Add Arbitrum network:
   - Click network dropdown → Add Network
   - Enter Arbitrum details from above
4. Bridge ETH from Ethereum mainnet using [bridge.arbitrum.io](https://bridge.arbitrum.io)

### Adding SYNX Token

1. Open MetaMask
2. Click "Import tokens"
3. Enter SYNX contract address: `0x...` (see official docs)
4. Token will appear in your wallet

### Getting Testnet Tokens

For testing on Arbitrum Sepolia:

1. Get testnet ETH from [Arbitrum faucet](https://faucet.arbitrum.io)
2. Get SYNX from our faucet at [faucet.synapse-protocol.ai](https://faucet.synapse-protocol.ai)
3. Connect wallet, complete captcha, receive 100 SYNX

---

## Making Payments

### Direct Payments

Send SYNX tokens to any address:

1. Go to [app.synapse-protocol.ai](https://app.synapse-protocol.ai)
2. Connect your wallet
3. Click "Send"
4. Enter recipient address and amount
5. Add optional metadata (for tracking)
6. Confirm transaction

**Fees**: 0.3% protocol fee (lower for high-tier agents)

### Batch Payments

Send to multiple recipients in one transaction:

1. Click "Batch Send"
2. Upload CSV file with format:
   ```
   address,amount
   0x123...,100
   0x456...,50
   ```
3. Or add recipients manually
4. Review total and fees
5. Confirm transaction

**Benefits**: Save 40-60% on gas vs individual transactions

### Escrow Payments

For milestone-based payments:

1. Click "Create Escrow"
2. Enter:
   - Recipient address
   - Arbiter address (optional)
   - Amount
   - Deadline
3. Funds are locked in contract
4. Release when work is complete
5. Arbiter can resolve disputes

**Use cases**: Freelance work, service agreements, conditional payments

### Payment Streams

Continuous payments over time:

1. Click "Create Stream"
2. Enter:
   - Recipient address
   - Total amount
   - Start date
   - End date
3. Tokens flow continuously to recipient
4. Recipient can withdraw accrued amount anytime
5. Sender can cancel and recover remaining funds

**Use cases**: Salaries, subscriptions, ongoing services

---

## AI Agent Services

### Discovering Services

Browse the AI service marketplace:

1. Go to "Marketplace"
2. Browse categories:
   - Language Models (GPT, Claude, etc.)
   - Image Generation
   - Voice/Audio
   - Code Generation
   - Data Analysis
   - Custom AI
3. Filter by:
   - Price range
   - Provider reputation
   - Usage statistics
   - Rating

### Using a Service

1. Select service from marketplace
2. View details:
   - Description
   - Pricing model
   - API endpoint
   - Usage examples
3. Click "Use Service"
4. Calculate cost for your usage
5. Pay and receive API access

### Pricing Models

- **Per Request**: Fixed price per API call
- **Per Token**: Based on input/output tokens
- **Tiered**: Volume discounts
- **Subscription**: Monthly unlimited access
- **Custom**: Negotiated rates

### Rating Services

After using a service:

1. Go to "Transaction History"
2. Find the service transaction
3. Click "Rate"
4. Provide 1-5 star rating
5. Optional: Add review text

Your ratings help other users and affect provider reputation.

---

## Staking SYNX

### Why Stake?

- Earn passive income (10-50% APR)
- Higher staking = better tier benefits
- Governance voting power
- Reduced protocol fees

### How to Stake

1. Go to "Staking"
2. Enter amount to stake
3. Select lock period:
   - No lock: 1x rewards
   - 30 days: 1.25x boost
   - 90 days: 1.5x boost
   - 180 days: 2x boost
   - 365 days: 3x boost
4. Confirm transaction
5. Start earning immediately

### Lock Tiers

| Tier | Lock Period | Boost | Early Withdrawal |
|------|-------------|-------|------------------|
| Flexible | 0 days | 1x | Anytime |
| Bronze | 30 days | 1.25x | 10% penalty |
| Silver | 90 days | 1.5x | 15% penalty |
| Gold | 180 days | 2x | 20% penalty |
| Diamond | 365 days | 3x | 25% penalty |

### Claiming Rewards

1. View accumulated rewards on dashboard
2. Click "Claim" to withdraw to wallet
3. Or click "Compound" to reinvest rewards

### Unstaking

1. Click "Unstake"
2. If locked: Wait for lock period OR pay early withdrawal penalty
3. 7-day cooldown begins
4. Claim tokens after cooldown

---

## Payment Channels

### What are Payment Channels?

Off-chain payment solution for high-frequency micropayments:

- Open channel once, pay unlimited times
- Near-zero fees for individual payments
- Instant settlement
- Perfect for AI API calls

### Opening a Channel

1. Go to "Channels"
2. Click "Open Channel"
3. Enter:
   - Counterparty address
   - Your deposit amount
   - Their deposit amount (optional)
4. Channel opens after confirmation
5. Both parties can now transact off-chain

### Using a Channel

Once open, payments happen off-chain:

1. Sign payment messages locally
2. Exchange signatures with counterparty
3. Balances update instantly
4. No gas fees for individual payments

### Closing a Channel

**Cooperative Close** (recommended):
1. Both parties agree on final balance
2. Single transaction to close
3. Funds distributed immediately

**Dispute Close**:
1. Submit last valid state
2. 24-hour challenge period
3. If no challenge, finalize
4. If challenged, submit proof

---

## Subscriptions

### Finding Subscription Plans

1. Go to "Subscriptions"
2. Browse available plans
3. View plan details:
   - Price and billing period
   - Features included
   - Usage limits
   - Overage rates

### Subscribing

1. Select a plan
2. Choose billing period (1-12 months)
3. Pay upfront or from prepaid balance
4. Subscription activates immediately

### Managing Subscriptions

- **View usage**: Track API calls, storage, etc.
- **Upgrade/Downgrade**: Change plan anytime
- **Cancel**: Stop auto-renewal
- **Renew**: Manual renewal before expiry

### Prepaid Balance

Add funds to your subscription wallet:

1. Go to "Prepaid Balance"
2. Deposit SYNX
3. Subscriptions auto-debit from balance
4. No need to approve each renewal

---

## Governance

### Governance Power

Your voting power is based on:
- SYNX tokens held
- Staked SYNX (weighted higher)
- Delegation from others

### Viewing Proposals

1. Go to "Governance"
2. See active proposals
3. Read proposal details:
   - Title and description
   - Proposer
   - Voting period
   - Current votes

### Voting

1. Select proposal
2. Choose: For / Against / Abstain
3. Confirm vote transaction
4. Vote is recorded on-chain

### Creating Proposals

Requirements:
- Hold minimum 100,000 SYNX (or delegated)
- Stake collateral (returned if proposal passes quorum)

Process:
1. Click "Create Proposal"
2. Enter title and description
3. Specify actions (contract calls)
4. Submit and stake collateral
5. Voting period begins (7 days)
6. If passed, execution after timelock (2 days)

### Delegation

Delegate your voting power:

1. Go to "Delegation"
2. Enter delegate address
3. Confirm transaction
4. Delegate can now vote on your behalf
5. Revoke anytime

---

## Achievements

### Achievement System

Earn NFT achievements for protocol participation:

- **Payment Achievements**: First payment, 100 payments, whale payment
- **Staking Achievements**: Diamond hands, top staker
- **Service Achievements**: First service, popular service
- **Governance Achievements**: Voter, proposal creator

### Viewing Achievements

1. Go to "Profile" → "Achievements"
2. See unlocked and available achievements
3. View rarity and points

### Leaderboard

Compete with other users:
- Points based on achievements
- Higher rarity = more points
- View global and friend rankings

### Benefits

- **Badges**: Display on profile
- **Points**: Leaderboard ranking
- **Future Benefits**: Airdrops, exclusive access

---

## Troubleshooting

### Transaction Failed

**Possible causes**:
1. Insufficient ETH for gas
2. Insufficient SYNX balance
3. Contract paused
4. Slippage too low (for swaps)

**Solutions**:
1. Add more ETH to wallet
2. Reduce payment amount
3. Wait for contract to unpause
4. Increase slippage tolerance

### Transaction Pending

If stuck pending for >10 minutes:
1. Check network status
2. Speed up with higher gas
3. Or cancel and retry

### Wallet Connection Issues

1. Refresh the page
2. Disconnect and reconnect wallet
3. Clear browser cache
4. Try different browser

### Wrong Network

If MetaMask shows wrong network:
1. Click network dropdown
2. Select Arbitrum One
3. Retry transaction

### Contact Support

If issues persist:
- Discord: https://discord.gg/synapse
- Email: support@synapse-protocol.ai
- Twitter: @SynapseProtocol

---

## Glossary

| Term | Definition |
|------|------------|
| **SYNX** | Native token of SYNAPSE Protocol |
| **Agent** | Registered AI service provider |
| **Tier** | Reputation level (Bronze → Diamond) |
| **Escrow** | Locked payment with release conditions |
| **Stream** | Continuous payment over time |
| **Channel** | Off-chain payment pathway |
| **TVL** | Total Value Locked in protocol |
| **APR** | Annual Percentage Rate for staking |

---

## Quick Reference

### Key Addresses

| Contract | Arbitrum One | Arbitrum Sepolia |
|----------|--------------|------------------|
| SYNX Token | `0x...` | `0x...` |
| Payment Router | `0x...` | `0x...` |
| Staking | `0x...` | `0x...` |

### Important Links

- Website: https://synapse-protocol.ai
- App: https://app.synapse-protocol.ai
- Docs: https://docs.synapse-protocol.ai
- GitHub: https://github.com/synapse-protocol
- Discord: https://discord.gg/synapse
- Twitter: https://twitter.com/SynapseProtocol

---

*Last updated: December 2024*
