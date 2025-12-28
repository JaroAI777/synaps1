# ==========================================
# SYNAPSE Protocol - Multi-stage Dockerfile
# ==========================================

# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache git python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source files
COPY . .

# Compile contracts
RUN npm run compile

# Stage 2: Test stage
FROM builder AS tester

# Install dev dependencies
RUN npm ci

# Run tests
RUN npm run test

# Stage 3: Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 synapse && \
    adduser -u 1001 -G synapse -s /bin/sh -D synapse

# Copy built artifacts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/artifacts ./artifacts
COPY --from=builder /app/contracts ./contracts
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/hardhat.config.js ./
COPY --from=builder /app/package.json ./

# Set ownership
RUN chown -R synapse:synapse /app

# Switch to non-root user
USER synapse

# Expose port for local node
EXPOSE 8545

# Default command
CMD ["npm", "run", "node"]

# ==========================================
# Alternative: Development stage
# ==========================================
FROM node:20-alpine AS development

WORKDIR /app

# Install dependencies
RUN apk add --no-cache git python3 make g++

# Copy all files
COPY . .

# Install all dependencies including dev
RUN npm ci

# Compile contracts
RUN npm run compile

# Expose ports
EXPOSE 8545
EXPOSE 3000

# Development command
CMD ["npm", "run", "node"]
