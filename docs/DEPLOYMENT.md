# SYNAPSE Protocol - Production Deployment Guide

This guide covers deploying SYNAPSE Protocol to production environments.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Infrastructure Setup](#infrastructure-setup)
3. [Contract Deployment](#contract-deployment)
4. [Backend Services](#backend-services)
5. [Monitoring Setup](#monitoring-setup)
6. [Security Checklist](#security-checklist)
7. [Maintenance](#maintenance)

---

## Prerequisites

### Required Tools

```bash
# Node.js 20+
node --version  # v20.x.x

# Hardhat
npx hardhat --version

# Docker & Docker Compose
docker --version
docker-compose --version

# kubectl (for Kubernetes deployments)
kubectl version
```

### Required Accounts & Keys

- [ ] Ethereum wallet with deployment funds
- [ ] Alchemy/Infura API key
- [ ] Etherscan API key for verification
- [ ] The Graph hosted service account
- [ ] AWS/GCP/Azure account for infrastructure

### Environment Variables

Create `.env.production`:

```bash
# Network
NETWORK=arbitrum
RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
CHAIN_ID=42161

# Deployment
DEPLOYER_PRIVATE_KEY=0x...
TREASURY_ADDRESS=0x...
INITIAL_SUPPLY=1000000000

# Contract Parameters
MIN_STAKE=100000000000000000000  # 100 SYNX
BASE_FEE_BPS=50                   # 0.5%
PLATFORM_FEE_BPS=250             # 2.5%

# Verification
ETHERSCAN_API_KEY=your_key
ARBISCAN_API_KEY=your_key

# Services
REDIS_URL=redis://redis:6379
POSTGRES_URL=postgres://user:pass@postgres:5432/synapse
GRAPH_NODE_URL=http://graph-node:8020

# Monitoring
PROMETHEUS_URL=http://prometheus:9090
GRAFANA_ADMIN_PASSWORD=secure_password

# API
API_SECRET=your_api_secret
JWT_SECRET=your_jwt_secret
```

---

## Infrastructure Setup

### Option A: Kubernetes (Recommended)

```bash
# 1. Create namespace
kubectl create namespace synapse-protocol

# 2. Create secrets
kubectl create secret generic synapse-secrets \
  --from-env-file=.env.production \
  -n synapse-protocol

# 3. Apply base configuration
kubectl apply -k k8s/overlays/production/

# 4. Verify deployment
kubectl get pods -n synapse-protocol
```

### Option B: Docker Compose

```bash
# 1. Build images
docker-compose -f docker-compose.prod.yml build

# 2. Start services
docker-compose -f docker-compose.prod.yml up -d

# 3. Check logs
docker-compose -f docker-compose.prod.yml logs -f
```

### Database Setup

```sql
-- PostgreSQL for The Graph
CREATE DATABASE graph_node;
CREATE USER graph WITH PASSWORD 'secure_password';
GRANT ALL PRIVILEGES ON DATABASE graph_node TO graph;

-- PostgreSQL for API (optional)
CREATE DATABASE synapse_api;
CREATE USER api WITH PASSWORD 'secure_password';
GRANT ALL PRIVILEGES ON DATABASE synapse_api TO api;
```

---

## Contract Deployment

### Pre-Deployment Checklist

- [ ] Audit completed and issues resolved
- [ ] All tests passing
- [ ] Gas optimization done
- [ ] Deployment parameters reviewed
- [ ] Multi-sig wallet setup for admin

### Deploy to Mainnet

```bash
# 1. Compile contracts
npx hardhat compile

# 2. Run final tests
npx hardhat test

# 3. Deploy to mainnet
npx hardhat run scripts/deploy.js --network arbitrum

# 4. Verify contracts
npx hardhat verify --network arbitrum <CONTRACT_ADDRESS> <CONSTRUCTOR_ARGS>
```

### Deployment Script

```javascript
// scripts/deploy-production.js
const { ethers, upgrades } = require("hardhat");

async function main() {
  console.log("Starting production deployment...");
  
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await deployer.provider.getBalance(deployer.address)));
  
  // Deploy Token
  console.log("\n1. Deploying SynapseToken...");
  const Token = await ethers.getContractFactory("SynapseToken");
  const token = await Token.deploy(
    "SYNAPSE",
    "SYNX",
    ethers.parseEther(process.env.INITIAL_SUPPLY),
    process.env.TREASURY_ADDRESS,
    deployer.address
  );
  await token.waitForDeployment();
  console.log("Token deployed:", await token.getAddress());
  
  // Deploy PaymentRouter
  console.log("\n2. Deploying PaymentRouter...");
  const Router = await ethers.getContractFactory("PaymentRouter");
  const router = await Router.deploy(
    await token.getAddress(),
    process.env.TREASURY_ADDRESS,
    parseInt(process.env.BASE_FEE_BPS)
  );
  await router.waitForDeployment();
  console.log("Router deployed:", await router.getAddress());
  
  // Deploy ReputationRegistry
  console.log("\n3. Deploying ReputationRegistry...");
  const Reputation = await ethers.getContractFactory("ReputationRegistry");
  const reputation = await Reputation.deploy(
    await token.getAddress(),
    process.env.MIN_STAKE
  );
  await reputation.waitForDeployment();
  console.log("Reputation deployed:", await reputation.getAddress());
  
  // Deploy ServiceRegistry
  console.log("\n4. Deploying ServiceRegistry...");
  const Services = await ethers.getContractFactory("ServiceRegistry");
  const services = await Services.deploy(
    await token.getAddress(),
    await reputation.getAddress(),
    ethers.parseEther("10")
  );
  await services.waitForDeployment();
  console.log("Services deployed:", await services.getAddress());
  
  // Deploy PaymentChannel
  console.log("\n5. Deploying PaymentChannel...");
  const Channels = await ethers.getContractFactory("PaymentChannel");
  const channels = await Channels.deploy(
    await token.getAddress(),
    86400 // 1 day challenge
  );
  await channels.waitForDeployment();
  console.log("Channels deployed:", await channels.getAddress());
  
  // Deploy SubscriptionManager
  console.log("\n6. Deploying SubscriptionManager...");
  const Subscriptions = await ethers.getContractFactory("SubscriptionManager");
  const subscriptions = await Subscriptions.deploy(
    await token.getAddress(),
    process.env.TREASURY_ADDRESS,
    parseInt(process.env.PLATFORM_FEE_BPS)
  );
  await subscriptions.waitForDeployment();
  console.log("Subscriptions deployed:", await subscriptions.getAddress());
  
  // Deploy StakingRewards
  console.log("\n7. Deploying StakingRewards...");
  const Staking = await ethers.getContractFactory("StakingRewards");
  const staking = await Staking.deploy(
    await token.getAddress(),
    await token.getAddress(),
    ethers.parseEther("100"),
    ethers.parseEther("1000000"),
    86400
  );
  await staking.waitForDeployment();
  console.log("Staking deployed:", await staking.getAddress());
  
  // Setup roles
  console.log("\n8. Setting up roles...");
  const REPORTER_ROLE = await router.REPORTER_ROLE();
  await router.grantRole(REPORTER_ROLE, await reputation.getAddress());
  
  // Save deployment
  const deployment = {
    network: hre.network.name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      token: await token.getAddress(),
      paymentRouter: await router.getAddress(),
      reputation: await reputation.getAddress(),
      serviceRegistry: await services.getAddress(),
      paymentChannel: await channels.getAddress(),
      subscriptionManager: await subscriptions.getAddress(),
      staking: await staking.getAddress()
    }
  };
  
  const fs = require("fs");
  fs.writeFileSync(
    `deployments/${hre.network.name}.json`,
    JSON.stringify(deployment, null, 2)
  );
  
  console.log("\n✅ Deployment complete!");
  console.log(deployment);
}

main().catch(console.error);
```

### Post-Deployment

```bash
# 1. Verify all contracts
npx hardhat run scripts/verify-all.js --network arbitrum

# 2. Transfer ownership to multi-sig
npx hardhat run scripts/transfer-ownership.js --network arbitrum

# 3. Initialize categories
npx hardhat run scripts/init-categories.js --network arbitrum
```

---

## Backend Services

### API Server

```bash
# Build
cd services
npm install --production
npm run build

# Run with PM2
pm2 start api-server.js --name synapse-api -i max
pm2 save
```

### WebSocket Server

```bash
pm2 start websocket-server.js --name synapse-ws
```

### Marketplace Aggregator

```bash
pm2 start marketplace-aggregator.js --name synapse-marketplace
```

### Service Configuration

```nginx
# /etc/nginx/sites-available/synapse-api
upstream synapse_api {
    server 127.0.0.1:3000;
    server 127.0.0.1:3001;
    keepalive 64;
}

server {
    listen 443 ssl http2;
    server_name api.synapse-protocol.ai;
    
    ssl_certificate /etc/letsencrypt/live/synapse-protocol.ai/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/synapse-protocol.ai/privkey.pem;
    
    location / {
        proxy_pass http://synapse_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## Monitoring Setup

### Prometheus Configuration

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets:
          - alertmanager:9093

rule_files:
  - "alerts/*.yml"

scrape_configs:
  - job_name: 'synapse-api'
    static_configs:
      - targets: ['api:3000']
    
  - job_name: 'synapse-ws'
    static_configs:
      - targets: ['ws:8080']
    
  - job_name: 'graph-node'
    static_configs:
      - targets: ['graph-node:8040']
```

### Alert Rules

```yaml
# alerts/synapse.yml
groups:
  - name: synapse
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: High error rate detected
          
      - alert: LowTPS
        expr: rate(synapse_payments_total[5m]) < 1
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: Low transaction throughput
```

### Grafana Dashboards

Import dashboards from `monitoring/grafana/dashboards/`.

---

## Security Checklist

### Smart Contracts

- [ ] External audit completed
- [ ] Slither analysis clean
- [ ] Mythril scan clean
- [ ] Access controls verified
- [ ] Pausability tested
- [ ] Upgrade mechanism secured (if applicable)
- [ ] Admin keys in multi-sig

### Infrastructure

- [ ] TLS/SSL enabled everywhere
- [ ] Firewall rules configured
- [ ] DDoS protection enabled
- [ ] Rate limiting configured
- [ ] API authentication enabled
- [ ] Secrets in secure vault
- [ ] Regular backups configured

### Operational

- [ ] Incident response plan documented
- [ ] On-call rotation established
- [ ] Runbooks created
- [ ] Monitoring alerts configured
- [ ] Log aggregation setup
- [ ] Security scanning scheduled

---

## Maintenance

### Regular Tasks

| Task | Frequency | Command |
|------|-----------|---------|
| Update dependencies | Weekly | `npm update` |
| Database backup | Daily | `pg_dump synapse > backup.sql` |
| Log rotation | Daily | Automatic via logrotate |
| Security scan | Weekly | `npm audit` |
| Performance review | Monthly | Dashboard analysis |

### Upgrade Procedure

1. Announce maintenance window
2. Create database backup
3. Deploy to staging
4. Run integration tests
5. Blue-green deployment to production
6. Monitor for 30 minutes
7. Announce completion

### Emergency Procedures

#### Contract Pause

```javascript
// Emergency pause
await paymentRouter.pause();
await reputation.pause();
await serviceRegistry.pause();
```

#### Rollback

```bash
# Kubernetes
kubectl rollout undo deployment/synapse-api -n synapse-protocol

# Docker
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d --scale api=0
git checkout v1.0.0
docker-compose -f docker-compose.prod.yml up -d
```

---

## Support

- Documentation: https://docs.synapse-protocol.ai
- Discord: https://discord.gg/synapse
- Email: support@synapse-protocol.ai
- Security: security@synapse-protocol.ai
