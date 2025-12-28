-- SYNAPSE Protocol Database Migrations
-- PostgreSQL schema for protocol services

-- ============================================
-- Migration: 001_initial_schema
-- ============================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    address VARCHAR(42) UNIQUE NOT NULL,
    nonce VARCHAR(66),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_login TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_users_address ON users(address);

-- API Keys table
CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    key_hash VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(100),
    tier VARCHAR(20) DEFAULT 'free',
    created_at TIMESTAMP DEFAULT NOW(),
    last_used_at TIMESTAMP,
    expires_at TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    request_count BIGINT DEFAULT 0
);

CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    tx_hash VARCHAR(66) UNIQUE NOT NULL,
    block_number BIGINT NOT NULL,
    block_timestamp TIMESTAMP NOT NULL,
    from_address VARCHAR(42) NOT NULL,
    to_address VARCHAR(42),
    contract_address VARCHAR(42),
    method_name VARCHAR(100),
    amount DECIMAL(78, 0),
    fee DECIMAL(78, 0),
    status VARCHAR(20),
    gas_used BIGINT,
    gas_price DECIMAL(78, 0),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transactions_hash ON transactions(tx_hash);
CREATE INDEX idx_transactions_from ON transactions(from_address);
CREATE INDEX idx_transactions_to ON transactions(to_address);
CREATE INDEX idx_transactions_block ON transactions(block_number);
CREATE INDEX idx_transactions_timestamp ON transactions(block_timestamp);

-- Payments table
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    payment_id VARCHAR(66) UNIQUE NOT NULL,
    tx_hash VARCHAR(66) REFERENCES transactions(tx_hash),
    sender VARCHAR(42) NOT NULL,
    recipient VARCHAR(42) NOT NULL,
    amount DECIMAL(78, 0) NOT NULL,
    fee DECIMAL(78, 0),
    payment_type VARCHAR(20),
    metadata TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_payments_sender ON payments(sender);
CREATE INDEX idx_payments_recipient ON payments(recipient);
CREATE INDEX idx_payments_tx ON payments(tx_hash);

-- Escrows table
CREATE TABLE IF NOT EXISTS escrows (
    id SERIAL PRIMARY KEY,
    escrow_id VARCHAR(66) UNIQUE NOT NULL,
    tx_hash VARCHAR(66),
    sender VARCHAR(42) NOT NULL,
    recipient VARCHAR(42) NOT NULL,
    arbiter VARCHAR(42),
    amount DECIMAL(78, 0) NOT NULL,
    deadline TIMESTAMP,
    status VARCHAR(20) DEFAULT 'pending',
    released_at TIMESTAMP,
    refunded_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_escrows_sender ON escrows(sender);
CREATE INDEX idx_escrows_recipient ON escrows(recipient);
CREATE INDEX idx_escrows_status ON escrows(status);

-- Streams table
CREATE TABLE IF NOT EXISTS payment_streams (
    id SERIAL PRIMARY KEY,
    stream_id VARCHAR(66) UNIQUE NOT NULL,
    tx_hash VARCHAR(66),
    sender VARCHAR(42) NOT NULL,
    recipient VARCHAR(42) NOT NULL,
    total_amount DECIMAL(78, 0) NOT NULL,
    withdrawn_amount DECIMAL(78, 0) DEFAULT 0,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_streams_sender ON payment_streams(sender);
CREATE INDEX idx_streams_recipient ON payment_streams(recipient);
CREATE INDEX idx_streams_status ON payment_streams(status);

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
    id SERIAL PRIMARY KEY,
    address VARCHAR(42) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    metadata_uri TEXT,
    reputation_score INTEGER DEFAULT 50,
    tier INTEGER DEFAULT 0,
    stake DECIMAL(78, 0) DEFAULT 0,
    total_transactions BIGINT DEFAULT 0,
    success_rate DECIMAL(5, 2),
    is_active BOOLEAN DEFAULT TRUE,
    registered_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_agents_address ON agents(address);
CREATE INDEX idx_agents_tier ON agents(tier);
CREATE INDEX idx_agents_reputation ON agents(reputation_score);

-- Services table
CREATE TABLE IF NOT EXISTS services (
    id SERIAL PRIMARY KEY,
    service_id VARCHAR(66) UNIQUE NOT NULL,
    provider_address VARCHAR(42) NOT NULL REFERENCES agents(address),
    name VARCHAR(200) NOT NULL,
    category VARCHAR(100) NOT NULL,
    description TEXT,
    endpoint TEXT,
    base_price DECIMAL(78, 0),
    pricing_model INTEGER,
    usage_count BIGINT DEFAULT 0,
    rating DECIMAL(3, 2),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_services_provider ON services(provider_address);
CREATE INDEX idx_services_category ON services(category);
CREATE INDEX idx_services_active ON services(is_active);

-- Staking positions table
CREATE TABLE IF NOT EXISTS staking_positions (
    id SERIAL PRIMARY KEY,
    user_address VARCHAR(42) NOT NULL,
    amount DECIMAL(78, 0) NOT NULL,
    lock_tier INTEGER DEFAULT 0,
    lock_until TIMESTAMP,
    rewards_claimed DECIMAL(78, 0) DEFAULT 0,
    last_claim_at TIMESTAMP,
    staked_at TIMESTAMP NOT NULL,
    unstaked_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_staking_user ON staking_positions(user_address);
CREATE INDEX idx_staking_status ON staking_positions(status);

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    subscription_id VARCHAR(66) UNIQUE NOT NULL,
    plan_id VARCHAR(66) NOT NULL,
    subscriber VARCHAR(42) NOT NULL,
    provider VARCHAR(42) NOT NULL,
    amount DECIMAL(78, 0) NOT NULL,
    period_days INTEGER,
    start_date TIMESTAMP NOT NULL,
    end_date TIMESTAMP NOT NULL,
    usage_count BIGINT DEFAULT 0,
    usage_limit BIGINT,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_subscriber ON subscriptions(subscriber);
CREATE INDEX idx_subscriptions_provider ON subscriptions(provider);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

-- Bridge requests table
CREATE TABLE IF NOT EXISTS bridge_requests (
    id SERIAL PRIMARY KEY,
    request_id VARCHAR(66) UNIQUE NOT NULL,
    sender VARCHAR(42) NOT NULL,
    recipient VARCHAR(42) NOT NULL,
    source_chain INTEGER NOT NULL,
    target_chain INTEGER NOT NULL,
    amount DECIMAL(78, 0) NOT NULL,
    fee DECIMAL(78, 0),
    status VARCHAR(20) DEFAULT 'pending',
    validations INTEGER DEFAULT 0,
    required_validations INTEGER,
    source_tx_hash VARCHAR(66),
    target_tx_hash VARCHAR(66),
    initiated_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_bridge_sender ON bridge_requests(sender);
CREATE INDEX idx_bridge_status ON bridge_requests(status);
CREATE INDEX idx_bridge_chains ON bridge_requests(source_chain, target_chain);

-- Webhooks table
CREATE TABLE IF NOT EXISTS webhooks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    url TEXT NOT NULL,
    secret VARCHAR(64),
    events TEXT[] NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    failure_count INTEGER DEFAULT 0,
    last_triggered_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_webhooks_user ON webhooks(user_id);
CREATE INDEX idx_webhooks_active ON webhooks(is_active);

-- Webhook deliveries table
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id SERIAL PRIMARY KEY,
    webhook_id INTEGER REFERENCES webhooks(id),
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    response_status INTEGER,
    response_body TEXT,
    attempt INTEGER DEFAULT 1,
    delivered_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_address VARCHAR(42) NOT NULL,
    type VARCHAR(100) NOT NULL,
    title VARCHAR(200),
    message TEXT,
    data JSONB,
    is_read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_address);
CREATE INDEX idx_notifications_read ON notifications(is_read);
CREATE INDEX idx_notifications_created ON notifications(created_at);

-- Analytics events table (for detailed tracking)
CREATE TABLE IF NOT EXISTS analytics_events (
    id SERIAL PRIMARY KEY,
    event_name VARCHAR(100) NOT NULL,
    user_address VARCHAR(42),
    properties JSONB,
    session_id VARCHAR(36),
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_analytics_name ON analytics_events(event_name);
CREATE INDEX idx_analytics_user ON analytics_events(user_address);
CREATE INDEX idx_analytics_created ON analytics_events(created_at);

-- Daily stats table
CREATE TABLE IF NOT EXISTS daily_stats (
    id SERIAL PRIMARY KEY,
    date DATE UNIQUE NOT NULL,
    total_transactions BIGINT DEFAULT 0,
    total_volume DECIMAL(78, 0) DEFAULT 0,
    total_fees DECIMAL(78, 0) DEFAULT 0,
    unique_users INTEGER DEFAULT 0,
    new_users INTEGER DEFAULT 0,
    active_agents INTEGER DEFAULT 0,
    total_staked DECIMAL(78, 0) DEFAULT 0,
    avg_gas_price DECIMAL(78, 0),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_daily_stats_date ON daily_stats(date);

-- ============================================
-- Functions and Triggers
-- ============================================

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply update trigger to relevant tables
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_services_updated_at
    BEFORE UPDATE ON services
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- ============================================
-- Views
-- ============================================

-- Active services view
CREATE OR REPLACE VIEW v_active_services AS
SELECT 
    s.*,
    a.name as provider_name,
    a.reputation_score,
    a.tier as provider_tier
FROM services s
JOIN agents a ON s.provider_address = a.address
WHERE s.is_active = TRUE AND a.is_active = TRUE;

-- User activity view
CREATE OR REPLACE VIEW v_user_activity AS
SELECT 
    u.address,
    u.created_at as registered_at,
    COUNT(DISTINCT p.id) as payment_count,
    COALESCE(SUM(p.amount), 0) as total_volume,
    MAX(p.created_at) as last_activity
FROM users u
LEFT JOIN payments p ON u.address = p.sender OR u.address = p.recipient
GROUP BY u.address, u.created_at;

-- Protocol stats view
CREATE OR REPLACE VIEW v_protocol_stats AS
SELECT 
    (SELECT COUNT(*) FROM users WHERE is_active = TRUE) as total_users,
    (SELECT COUNT(*) FROM agents WHERE is_active = TRUE) as total_agents,
    (SELECT COUNT(*) FROM services WHERE is_active = TRUE) as total_services,
    (SELECT COALESCE(SUM(amount), 0) FROM payments) as total_volume,
    (SELECT COALESCE(SUM(amount), 0) FROM staking_positions WHERE status = 'active') as total_staked,
    (SELECT COUNT(*) FROM subscriptions WHERE status = 'active') as active_subscriptions;

-- ============================================
-- Initial seed data (optional)
-- ============================================

-- Insert protocol admin
-- INSERT INTO users (address, nonce) VALUES ('0x...', 'initial_nonce') ON CONFLICT DO NOTHING;
