# ==========================================
# SYNAPSE Protocol - Makefile
# ==========================================

.PHONY: help install compile test coverage deploy clean docker docs

# Default target
help:
	@echo "SYNAPSE Protocol - Available commands:"
	@echo ""
	@echo "Development:"
	@echo "  make install      - Install dependencies"
	@echo "  make compile      - Compile smart contracts"
	@echo "  make test         - Run tests"
	@echo "  make coverage     - Run tests with coverage"
	@echo "  make lint         - Lint Solidity code"
	@echo "  make format       - Format code"
	@echo "  make clean        - Clean build artifacts"
	@echo ""
	@echo "Local Development:"
	@echo "  make node         - Start local Hardhat node"
	@echo "  make deploy-local - Deploy to local node"
	@echo ""
	@echo "Docker:"
	@echo "  make docker-build - Build Docker images"
	@echo "  make docker-up    - Start all services"
	@echo "  make docker-down  - Stop all services"
	@echo "  make docker-logs  - View logs"
	@echo ""
	@echo "Deployment:"
	@echo "  make deploy-sepolia   - Deploy to Sepolia"
	@echo "  make deploy-arbitrum  - Deploy to Arbitrum Sepolia"
	@echo "  make deploy-mainnet   - Deploy to mainnet (CAREFUL!)"
	@echo ""
	@echo "Subgraph:"
	@echo "  make subgraph-codegen  - Generate subgraph code"
	@echo "  make subgraph-build    - Build subgraph"
	@echo "  make subgraph-deploy   - Deploy subgraph"
	@echo ""
	@echo "SDK:"
	@echo "  make sdk-build    - Build JavaScript SDK"
	@echo "  make sdk-python   - Build Python SDK"

# ==========================================
# Development
# ==========================================

install:
	npm ci

compile:
	npx hardhat compile

test:
	npx hardhat test

test-verbose:
	npx hardhat test --verbose

coverage:
	npx hardhat coverage

lint:
	npx solhint 'contracts/**/*.sol'

format:
	npx prettier --write 'contracts/**/*.sol' 'tests/**/*.js' 'scripts/**/*.js'

clean:
	npx hardhat clean
	rm -rf cache artifacts coverage coverage.json typechain-types

# ==========================================
# Local Development
# ==========================================

node:
	npx hardhat node

deploy-local:
	npx hardhat run scripts/deploy.js --network localhost

console:
	npx hardhat console --network localhost

# ==========================================
# Docker
# ==========================================

docker-build:
	docker-compose build

docker-up:
	docker-compose up -d

docker-down:
	docker-compose down

docker-logs:
	docker-compose logs -f

docker-clean:
	docker-compose down -v --remove-orphans
	docker system prune -f

docker-rebuild:
	docker-compose down
	docker-compose build --no-cache
	docker-compose up -d

# ==========================================
# Deployment
# ==========================================

deploy-sepolia:
	npx hardhat run scripts/deploy.js --network sepolia

deploy-arbitrum-sepolia:
	npx hardhat run scripts/deploy.js --network arbitrumSepolia

deploy-arbitrum:
	npx hardhat run scripts/deploy.js --network arbitrumOne

deploy-mainnet:
	@echo "⚠️  WARNING: Deploying to mainnet!"
	@read -p "Are you sure? [y/N] " confirm && [ "$$confirm" = "y" ]
	npx hardhat run scripts/deploy.js --network mainnet

verify-sepolia:
	npx hardhat verify --network sepolia

verify-arbitrum:
	npx hardhat verify --network arbitrumOne

# ==========================================
# Subgraph
# ==========================================

subgraph-codegen:
	cd subgraph && graph codegen

subgraph-build:
	cd subgraph && graph build

subgraph-deploy-local:
	cd subgraph && graph deploy --node http://localhost:8020/ synapse-protocol

subgraph-deploy:
	cd subgraph && graph deploy --studio synapse-protocol

# ==========================================
# SDK
# ==========================================

sdk-build:
	cd sdk && npm ci && npm run build

sdk-test:
	cd sdk && npm test

sdk-publish:
	cd sdk && npm publish

sdk-python:
	cd sdk-python && pip install -e .

sdk-python-test:
	cd sdk-python && pytest

sdk-python-publish:
	cd sdk-python && python -m build && twine upload dist/*

# ==========================================
# Documentation
# ==========================================

docs:
	npx hardhat docgen

docs-serve:
	cd docs && python -m http.server 8080

# ==========================================
# Security
# ==========================================

slither:
	slither . --exclude-dependencies

mythril:
	myth analyze contracts/*.sol

audit-prepare:
	@echo "Preparing for audit..."
	make compile
	make test
	make coverage
	make slither
	@echo "Audit preparation complete!"

# ==========================================
# Utilities
# ==========================================

size:
	npx hardhat size-contracts

gas-report:
	REPORT_GAS=true npx hardhat test

flatten:
	npx hardhat flatten contracts/SynapseToken.sol > flattened/SynapseToken.sol
	npx hardhat flatten contracts/PaymentRouter.sol > flattened/PaymentRouter.sol

accounts:
	npx hardhat accounts

balance:
	npx hardhat run scripts/check-balance.js

# ==========================================
# Quick Start
# ==========================================

quick-start: install compile test
	@echo "✅ Quick start complete!"
	@echo "Run 'make node' to start local node"
	@echo "Run 'make deploy-local' to deploy contracts"

full-stack: docker-build docker-up
	@echo "✅ Full stack is running!"
	@echo "Frontend: http://localhost"
	@echo "API: http://localhost:3000"
	@echo "GraphQL: http://localhost:8000"
	@echo "Grafana: http://localhost:3001 (admin/synapse)"

# ==========================================
# Services
# ==========================================

start-api:
	node services/api-server.js

start-ws:
	node services/websocket-server.js

start-analytics:
	node services/analytics-service.js

start-webhook:
	node services/webhook-service.js

start-marketplace:
	node services/marketplace-aggregator.js

start-all-services:
	pm2 start services/api-server.js --name synapse-api
	pm2 start services/websocket-server.js --name synapse-ws
	pm2 start services/analytics-service.js --name synapse-analytics
	pm2 start services/webhook-service.js --name synapse-webhook
	pm2 start services/marketplace-aggregator.js --name synapse-marketplace

stop-all-services:
	pm2 stop all
	pm2 delete all

# ==========================================
# Kubernetes
# ==========================================

k8s-deploy-dev:
	kubectl apply -k k8s/overlays/development/

k8s-deploy-staging:
	kubectl apply -k k8s/overlays/staging/

k8s-deploy-prod:
	@echo "⚠️  WARNING: Deploying to production!"
	@read -p "Are you sure? [y/N] " confirm && [ "$$confirm" = "y" ]
	kubectl apply -k k8s/overlays/production/

k8s-delete:
	kubectl delete -k k8s/base/

k8s-status:
	kubectl get pods -n synapse-protocol
	kubectl get services -n synapse-protocol

k8s-logs:
	kubectl logs -f -l app=synapse-api -n synapse-protocol

# ==========================================
# Testing Extended
# ==========================================

test-contracts:
	npx hardhat test tests/SynapseToken.test.js
	npx hardhat test tests/PaymentRouter.test.js
	npx hardhat test tests/ReputationRegistry.test.js
	npx hardhat test tests/ServiceRegistry.test.js
	npx hardhat test tests/PaymentChannel.test.js
	npx hardhat test tests/SubscriptionManager.test.js
	npx hardhat test tests/StakingRewards.test.js
	npx hardhat test tests/TokenVesting.test.js
	npx hardhat test tests/SynapseBridge.test.js

test-integration:
	npx hardhat test tests/Integration.test.js

benchmark:
	node scripts/benchmark.js

stress-test:
	node loadtest/loadtest.js

# ==========================================
# SDK Extended
# ==========================================

sdk-go-build:
	cd sdk-go && go build ./...

sdk-go-test:
	cd sdk-go && go test ./...

sdk-rust-build:
	cd sdk-rust && cargo build

sdk-rust-test:
	cd sdk-rust && cargo test

sdk-rn-build:
	cd sdk-react-native && npm ci && npm run build

sdk-all: sdk-build sdk-python sdk-go-build sdk-rust-build sdk-rn-build
	@echo "✅ All SDKs built!"

# ==========================================
# Admin
# ==========================================

admin-pause:
	node scripts/admin.js pause

admin-unpause:
	node scripts/admin.js unpause

admin-status:
	node scripts/admin.js status

admin-fees:
	node scripts/admin.js fees

# ==========================================
# Monitoring
# ==========================================

prometheus:
	prometheus --config.file=monitoring/prometheus.yml

grafana:
	grafana-server --config=monitoring/grafana/grafana.ini

monitor-stack:
	docker-compose -f docker-compose.monitoring.yml up -d

# ==========================================
# CI/CD
# ==========================================

ci-test:
	npm ci
	make compile
	make test
	make lint

ci-build:
	make docker-build
	make sdk-all

ci-deploy-staging:
	make ci-build
	make k8s-deploy-staging

# ==========================================
# Reports
# ==========================================

report-gas:
	REPORT_GAS=true npx hardhat test > reports/gas-report.txt

report-coverage:
	npx hardhat coverage
	mv coverage reports/

report-security:
	make slither > reports/slither-report.txt 2>&1 || true

report-all: report-gas report-coverage report-security
	@echo "✅ All reports generated in reports/"
