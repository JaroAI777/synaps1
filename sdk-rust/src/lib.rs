//! SYNAPSE Protocol Rust SDK
//!
//! High-performance SDK for interacting with SYNAPSE Protocol
//! Designed for AI agents requiring maximum throughput and minimal latency.

use ethers::{
    prelude::*,
    providers::{Http, Provider, Middleware},
    signers::{LocalWallet, Signer},
    types::{Address, H256, U256, Bytes},
    contract::abigen,
};
use std::sync::Arc;
use thiserror::Error;
use serde::{Deserialize, Serialize};

// Generate contract bindings
abigen!(
    SynapseToken,
    r#"[
        function balanceOf(address account) external view returns (uint256)
        function transfer(address to, uint256 amount) external returns (bool)
        function approve(address spender, uint256 amount) external returns (bool)
        function allowance(address owner, address spender) external view returns (uint256)
        event Transfer(address indexed from, address indexed to, uint256 value)
    ]"#
);

abigen!(
    PaymentRouter,
    r#"[
        function pay(address recipient, uint256 amount, bytes32 paymentId, bytes metadata) external returns (bool)
        function batchPay(address[] recipients, uint256[] amounts, bytes32[] paymentIds, bytes[] metadata) external returns (bool)
        function createEscrow(address recipient, address arbiter, uint256 amount, uint256 deadline, bytes32 escrowId, bytes metadata) external returns (bool)
        function releaseEscrow(bytes32 escrowId) external returns (bool)
        function refundEscrow(bytes32 escrowId) external returns (bool)
        function createStream(address recipient, uint256 totalAmount, uint256 startTime, uint256 endTime, bytes32 streamId) external returns (bool)
        event Payment(address indexed sender, address indexed recipient, uint256 amount, uint256 fee, bytes32 paymentId)
        event EscrowCreated(bytes32 indexed escrowId, address indexed sender, address indexed recipient, uint256 amount, uint256 deadline)
        event StreamCreated(bytes32 indexed streamId, address indexed sender, address indexed recipient, uint256 totalAmount, uint256 startTime, uint256 endTime)
    ]"#
);

abigen!(
    ReputationRegistry,
    r#"[
        function registerAgent(string name, string metadataUri, uint256 stake) external returns (bool)
        function deregisterAgent() external returns (bool)
        function increaseStake(uint256 amount) external returns (bool)
        function decreaseStake(uint256 amount) external returns (bool)
        function getTier(address agent) external view returns (uint8)
        function getSuccessRate(address agent) external view returns (uint256)
        function agents(address) external view returns (bool registered, string memory name, uint256 stake, uint256 reputationScore, uint256 totalTransactions, uint256 successfulTransactions, uint256 registeredAt, string memory metadataUri)
        event AgentRegistered(address indexed agent, string name, uint256 stake)
        event ReputationUpdated(address indexed agent, uint256 oldScore, uint256 newScore)
    ]"#
);

abigen!(
    ServiceRegistry,
    r#"[
        function registerService(string name, string category, string description, string endpoint, uint256 basePrice, uint8 pricingModel) external returns (bytes32)
        function updateService(bytes32 serviceId, string description, string endpoint, uint256 basePrice) external returns (bool)
        function deactivateService(bytes32 serviceId) external returns (bool)
        function activateService(bytes32 serviceId) external returns (bool)
        function getServicesByCategory(string category) external view returns (bytes32[] memory)
        function calculatePrice(bytes32 serviceId, uint256 quantity) external view returns (uint256)
        function services(bytes32) external view returns (address provider, string memory name, string memory category, string memory description, string memory endpoint, uint256 basePrice, uint8 pricingModel, bool active, uint256 totalRequests, uint256 totalRevenue, uint256 createdAt)
        event ServiceRegistered(bytes32 indexed serviceId, address indexed provider, string name, string category)
    ]"#
);

abigen!(
    PaymentChannel,
    r#"[
        function openChannel(address counterparty, uint256 myDeposit, uint256 theirDeposit) external returns (bytes32)
        function fundChannel(bytes32 channelId, uint256 amount) external returns (bool)
        function cooperativeClose(address counterparty, uint256 balance1, uint256 balance2, uint256 nonce, bytes sig1, bytes sig2) external returns (bool)
        function initiateClose(address counterparty, uint256 balance1, uint256 balance2, uint256 nonce, bytes sig1, bytes sig2) external returns (bool)
        function challengeClose(address counterparty, uint256 balance1, uint256 balance2, uint256 nonce, bytes sig1, bytes sig2) external returns (bool)
        function finalizeClose(address counterparty) external returns (bool)
        function getChannelId(address party1, address party2) external pure returns (bytes32)
        function channels(bytes32) external view returns (address participant1, address participant2, uint256 balance1, uint256 balance2, uint256 nonce, uint8 status, uint256 challengeEnd)
        event ChannelOpened(bytes32 indexed channelId, address indexed party1, address indexed party2, uint256 deposit1, uint256 deposit2)
        event ChannelClosed(bytes32 indexed channelId, uint256 finalBalance1, uint256 finalBalance2)
    ]"#
);

/// SDK Error types
#[derive(Error, Debug)]
pub enum SynapseError {
    #[error("Provider error: {0}")]
    ProviderError(#[from] ethers::providers::ProviderError),
    
    #[error("Contract error: {0}")]
    ContractError(String),
    
    #[error("Wallet error: {0}")]
    WalletError(#[from] ethers::signers::WalletError),
    
    #[error("Insufficient balance: required {required}, available {available}")]
    InsufficientBalance { required: U256, available: U256 },
    
    #[error("Agent not registered")]
    AgentNotRegistered,
    
    #[error("Service not found: {0}")]
    ServiceNotFound(String),
    
    #[error("Channel not found")]
    ChannelNotFound,
    
    #[error("Invalid signature")]
    InvalidSignature,
    
    #[error("Transaction failed: {0}")]
    TransactionFailed(String),
    
    #[error("Configuration error: {0}")]
    ConfigError(String),
}

/// Result type alias
pub type Result<T> = std::result::Result<T, SynapseError>;

/// Reputation tier levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tier {
    Unverified = 0,
    Bronze = 1,
    Silver = 2,
    Gold = 3,
    Platinum = 4,
    Diamond = 5,
}

impl From<u8> for Tier {
    fn from(value: u8) -> Self {
        match value {
            0 => Tier::Unverified,
            1 => Tier::Bronze,
            2 => Tier::Silver,
            3 => Tier::Gold,
            4 => Tier::Platinum,
            5 => Tier::Diamond,
            _ => Tier::Unverified,
        }
    }
}

/// Pricing model for services
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PricingModel {
    PerRequest = 0,
    PerToken = 1,
    PerSecond = 2,
    PerByte = 3,
    Subscription = 4,
    Custom = 5,
}

impl From<u8> for PricingModel {
    fn from(value: u8) -> Self {
        match value {
            0 => PricingModel::PerRequest,
            1 => PricingModel::PerToken,
            2 => PricingModel::PerSecond,
            3 => PricingModel::PerByte,
            4 => PricingModel::Subscription,
            5 => PricingModel::Custom,
            _ => PricingModel::Custom,
        }
    }
}

/// Channel status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChannelStatus {
    None = 0,
    Open = 1,
    Closing = 2,
    Closed = 3,
}

impl From<u8> for ChannelStatus {
    fn from(value: u8) -> Self {
        match value {
            0 => ChannelStatus::None,
            1 => ChannelStatus::Open,
            2 => ChannelStatus::Closing,
            3 => ChannelStatus::Closed,
            _ => ChannelStatus::None,
        }
    }
}

/// Contract addresses configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractAddresses {
    pub token: Address,
    pub payment_router: Address,
    pub reputation: Address,
    pub service_registry: Address,
    pub payment_channel: Address,
}

/// SDK configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub rpc_url: String,
    pub chain_id: u64,
    pub contracts: ContractAddresses,
}

/// Agent information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub registered: bool,
    pub name: String,
    pub stake: U256,
    pub reputation_score: U256,
    pub total_transactions: U256,
    pub successful_transactions: U256,
    pub registered_at: U256,
    pub metadata_uri: String,
    pub tier: Tier,
    pub success_rate: f64,
}

/// Service information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceInfo {
    pub provider: Address,
    pub name: String,
    pub category: String,
    pub description: String,
    pub endpoint: String,
    pub base_price: U256,
    pub pricing_model: PricingModel,
    pub active: bool,
    pub total_requests: U256,
    pub total_revenue: U256,
    pub created_at: U256,
}

/// Channel information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInfo {
    pub participant1: Address,
    pub participant2: Address,
    pub balance1: U256,
    pub balance2: U256,
    pub nonce: U256,
    pub status: ChannelStatus,
    pub challenge_end: U256,
}

/// Payment result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentResult {
    pub tx_hash: H256,
    pub payment_id: H256,
    pub amount: U256,
    pub fee: U256,
}

/// Stream result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamResult {
    pub tx_hash: H256,
    pub stream_id: H256,
    pub total_amount: U256,
    pub start_time: U256,
    pub end_time: U256,
}

/// SYNAPSE Protocol Client
pub struct SynapseClient<M: Middleware> {
    provider: Arc<M>,
    wallet: LocalWallet,
    config: Config,
    token: SynapseToken<M>,
    router: PaymentRouter<M>,
    reputation: ReputationRegistry<M>,
    services: ServiceRegistry<M>,
    channels: PaymentChannel<M>,
}

impl SynapseClient<SignerMiddleware<Provider<Http>, LocalWallet>> {
    /// Create a new client
    pub async fn new(
        rpc_url: &str,
        private_key: &str,
        contracts: ContractAddresses,
    ) -> Result<Self> {
        let provider = Provider::<Http>::try_from(rpc_url)
            .map_err(|e| SynapseError::ConfigError(e.to_string()))?;
        
        let chain_id = provider.get_chainid().await?;
        
        let wallet: LocalWallet = private_key
            .parse::<LocalWallet>()
            .map_err(|e| SynapseError::ConfigError(e.to_string()))?
            .with_chain_id(chain_id.as_u64());
        
        let client = SignerMiddleware::new(provider, wallet.clone());
        let client = Arc::new(client);
        
        let token = SynapseToken::new(contracts.token, client.clone());
        let router = PaymentRouter::new(contracts.payment_router, client.clone());
        let reputation = ReputationRegistry::new(contracts.reputation, client.clone());
        let services = ServiceRegistry::new(contracts.service_registry, client.clone());
        let channels = PaymentChannel::new(contracts.payment_channel, client.clone());
        
        let config = Config {
            rpc_url: rpc_url.to_string(),
            chain_id: chain_id.as_u64(),
            contracts,
        };
        
        Ok(Self {
            provider: client,
            wallet,
            config,
            token,
            router,
            reputation,
            services,
            channels,
        })
    }
    
    /// Get the client's address
    pub fn address(&self) -> Address {
        self.wallet.address()
    }
    
    /// Get chain ID
    pub fn chain_id(&self) -> u64 {
        self.config.chain_id
    }
    
    // ==================== Token Functions ====================
    
    /// Get token balance
    pub async fn get_balance(&self, address: Address) -> Result<U256> {
        let balance = self.token.balance_of(address).call().await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        Ok(balance)
    }
    
    /// Get own balance
    pub async fn balance(&self) -> Result<U256> {
        self.get_balance(self.address()).await
    }
    
    /// Transfer tokens
    pub async fn transfer(&self, to: Address, amount: U256) -> Result<H256> {
        let tx = self.token.transfer(to, amount).send().await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let receipt = tx.await
            .map_err(|e| SynapseError::TransactionFailed(e.to_string()))?
            .ok_or(SynapseError::TransactionFailed("No receipt".to_string()))?;
        
        Ok(receipt.transaction_hash)
    }
    
    /// Approve token spending
    pub async fn approve(&self, spender: Address, amount: U256) -> Result<H256> {
        let tx = self.token.approve(spender, amount).send().await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let receipt = tx.await
            .map_err(|e| SynapseError::TransactionFailed(e.to_string()))?
            .ok_or(SynapseError::TransactionFailed("No receipt".to_string()))?;
        
        Ok(receipt.transaction_hash)
    }
    
    /// Approve all protocol contracts
    pub async fn approve_all(&self) -> Result<Vec<H256>> {
        let max_uint = U256::MAX;
        let mut hashes = Vec::new();
        
        let contracts = [
            self.config.contracts.payment_router,
            self.config.contracts.reputation,
            self.config.contracts.service_registry,
            self.config.contracts.payment_channel,
        ];
        
        for contract in contracts {
            let hash = self.approve(contract, max_uint).await?;
            hashes.push(hash);
        }
        
        Ok(hashes)
    }
    
    // ==================== Payment Functions ====================
    
    /// Send a payment
    pub async fn pay(
        &self,
        recipient: Address,
        amount: U256,
        metadata: Option<Bytes>,
    ) -> Result<PaymentResult> {
        let payment_id = self.generate_payment_id("pay");
        let meta = metadata.unwrap_or_default();
        
        let tx = self.router
            .pay(recipient, amount, payment_id.into(), meta)
            .send()
            .await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let receipt = tx.await
            .map_err(|e| SynapseError::TransactionFailed(e.to_string()))?
            .ok_or(SynapseError::TransactionFailed("No receipt".to_string()))?;
        
        Ok(PaymentResult {
            tx_hash: receipt.transaction_hash,
            payment_id: payment_id.into(),
            amount,
            fee: U256::zero(), // Would need to parse from events
        })
    }
    
    /// Send batch payments
    pub async fn batch_pay(
        &self,
        recipients: Vec<Address>,
        amounts: Vec<U256>,
    ) -> Result<H256> {
        let payment_ids: Vec<[u8; 32]> = recipients
            .iter()
            .enumerate()
            .map(|(i, _)| self.generate_payment_id(&format!("batch-{}", i)))
            .collect();
        
        let metadata: Vec<Bytes> = vec![Bytes::default(); recipients.len()];
        
        let tx = self.router
            .batch_pay(recipients, amounts, payment_ids, metadata)
            .send()
            .await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let receipt = tx.await
            .map_err(|e| SynapseError::TransactionFailed(e.to_string()))?
            .ok_or(SynapseError::TransactionFailed("No receipt".to_string()))?;
        
        Ok(receipt.transaction_hash)
    }
    
    /// Create an escrow
    pub async fn create_escrow(
        &self,
        recipient: Address,
        arbiter: Address,
        amount: U256,
        deadline: U256,
    ) -> Result<H256> {
        let escrow_id = self.generate_payment_id("escrow");
        
        let tx = self.router
            .create_escrow(recipient, arbiter, amount, deadline, escrow_id.into(), Bytes::default())
            .send()
            .await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let receipt = tx.await
            .map_err(|e| SynapseError::TransactionFailed(e.to_string()))?
            .ok_or(SynapseError::TransactionFailed("No receipt".to_string()))?;
        
        Ok(receipt.transaction_hash)
    }
    
    /// Create a payment stream
    pub async fn create_stream(
        &self,
        recipient: Address,
        total_amount: U256,
        start_time: U256,
        end_time: U256,
    ) -> Result<StreamResult> {
        let stream_id = self.generate_payment_id("stream");
        
        let tx = self.router
            .create_stream(recipient, total_amount, start_time, end_time, stream_id.into())
            .send()
            .await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let receipt = tx.await
            .map_err(|e| SynapseError::TransactionFailed(e.to_string()))?
            .ok_or(SynapseError::TransactionFailed("No receipt".to_string()))?;
        
        Ok(StreamResult {
            tx_hash: receipt.transaction_hash,
            stream_id: stream_id.into(),
            total_amount,
            start_time,
            end_time,
        })
    }
    
    // ==================== Agent Functions ====================
    
    /// Register as an AI agent
    pub async fn register_agent(
        &self,
        name: &str,
        metadata_uri: &str,
        stake: U256,
    ) -> Result<H256> {
        let tx = self.reputation
            .register_agent(name.to_string(), metadata_uri.to_string(), stake)
            .send()
            .await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let receipt = tx.await
            .map_err(|e| SynapseError::TransactionFailed(e.to_string()))?
            .ok_or(SynapseError::TransactionFailed("No receipt".to_string()))?;
        
        Ok(receipt.transaction_hash)
    }
    
    /// Get agent information
    pub async fn get_agent(&self, address: Address) -> Result<AgentInfo> {
        let agent = self.reputation.agents(address).call().await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let tier = self.reputation.get_tier(address).call().await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let success_rate = self.reputation.get_success_rate(address).call().await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        Ok(AgentInfo {
            registered: agent.0,
            name: agent.1,
            stake: agent.2,
            reputation_score: agent.3,
            total_transactions: agent.4,
            successful_transactions: agent.5,
            registered_at: agent.6,
            metadata_uri: agent.7,
            tier: Tier::from(tier),
            success_rate: success_rate.as_u64() as f64 / 100.0,
        })
    }
    
    /// Increase stake
    pub async fn increase_stake(&self, amount: U256) -> Result<H256> {
        let tx = self.reputation.increase_stake(amount).send().await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let receipt = tx.await
            .map_err(|e| SynapseError::TransactionFailed(e.to_string()))?
            .ok_or(SynapseError::TransactionFailed("No receipt".to_string()))?;
        
        Ok(receipt.transaction_hash)
    }
    
    // ==================== Service Functions ====================
    
    /// Register a service
    pub async fn register_service(
        &self,
        name: &str,
        category: &str,
        description: &str,
        endpoint: &str,
        base_price: U256,
        pricing_model: PricingModel,
    ) -> Result<H256> {
        let tx = self.services
            .register_service(
                name.to_string(),
                category.to_string(),
                description.to_string(),
                endpoint.to_string(),
                base_price,
                pricing_model as u8,
            )
            .send()
            .await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let receipt = tx.await
            .map_err(|e| SynapseError::TransactionFailed(e.to_string()))?
            .ok_or(SynapseError::TransactionFailed("No receipt".to_string()))?;
        
        Ok(receipt.transaction_hash)
    }
    
    /// Get service information
    pub async fn get_service(&self, service_id: [u8; 32]) -> Result<ServiceInfo> {
        let service = self.services.services(service_id).call().await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        Ok(ServiceInfo {
            provider: service.0,
            name: service.1,
            category: service.2,
            description: service.3,
            endpoint: service.4,
            base_price: service.5,
            pricing_model: PricingModel::from(service.6),
            active: service.7,
            total_requests: service.8,
            total_revenue: service.9,
            created_at: service.10,
        })
    }
    
    /// Find services by category
    pub async fn find_services(&self, category: &str) -> Result<Vec<[u8; 32]>> {
        let services = self.services
            .get_services_by_category(category.to_string())
            .call()
            .await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        Ok(services)
    }
    
    /// Calculate service price
    pub async fn calculate_price(&self, service_id: [u8; 32], quantity: U256) -> Result<U256> {
        let price = self.services
            .calculate_price(service_id, quantity)
            .call()
            .await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        Ok(price)
    }
    
    // ==================== Channel Functions ====================
    
    /// Open a payment channel
    pub async fn open_channel(
        &self,
        counterparty: Address,
        my_deposit: U256,
        their_deposit: U256,
    ) -> Result<H256> {
        let tx = self.channels
            .open_channel(counterparty, my_deposit, their_deposit)
            .send()
            .await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let receipt = tx.await
            .map_err(|e| SynapseError::TransactionFailed(e.to_string()))?
            .ok_or(SynapseError::TransactionFailed("No receipt".to_string()))?;
        
        Ok(receipt.transaction_hash)
    }
    
    /// Get channel information
    pub async fn get_channel(&self, party1: Address, party2: Address) -> Result<ChannelInfo> {
        let channel_id = self.channels.get_channel_id(party1, party2).call().await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        let channel = self.channels.channels(channel_id).call().await
            .map_err(|e| SynapseError::ContractError(e.to_string()))?;
        
        Ok(ChannelInfo {
            participant1: channel.0,
            participant2: channel.1,
            balance1: channel.2,
            balance2: channel.3,
            nonce: channel.4,
            status: ChannelStatus::from(channel.5),
            challenge_end: channel.6,
        })
    }
    
    /// Sign channel state
    pub fn sign_channel_state(
        &self,
        channel_id: [u8; 32],
        balance1: U256,
        balance2: U256,
        nonce: U256,
    ) -> Result<Bytes> {
        use ethers::utils::keccak256;
        
        let mut data = Vec::new();
        data.extend_from_slice(&channel_id);
        data.extend_from_slice(&balance1.to_be_bytes::<32>());
        data.extend_from_slice(&balance2.to_be_bytes::<32>());
        data.extend_from_slice(&nonce.to_be_bytes::<32>());
        
        let hash = keccak256(&data);
        let signature = self.wallet.sign_hash(H256::from(hash))
            .map_err(|e| SynapseError::WalletError(e))?;
        
        Ok(signature.to_vec().into())
    }
    
    // ==================== Utility Functions ====================
    
    /// Generate a unique payment ID
    fn generate_payment_id(&self, prefix: &str) -> [u8; 32] {
        use ethers::utils::keccak256;
        use std::time::{SystemTime, UNIX_EPOCH};
        
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        
        let data = format!("{}-{}-{}", prefix, timestamp, self.address());
        keccak256(data.as_bytes())
    }
    
    /// Parse SYNX amount from string
    pub fn parse_synx(amount: &str) -> Result<U256> {
        ethers::utils::parse_ether(amount)
            .map_err(|e| SynapseError::ConfigError(e.to_string()))
    }
    
    /// Format SYNX amount to string
    pub fn format_synx(amount: U256) -> String {
        ethers::utils::format_ether(amount)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_tier_conversion() {
        assert_eq!(Tier::from(0), Tier::Unverified);
        assert_eq!(Tier::from(5), Tier::Diamond);
        assert_eq!(Tier::from(99), Tier::Unverified);
    }
    
    #[test]
    fn test_pricing_model_conversion() {
        assert_eq!(PricingModel::from(0), PricingModel::PerRequest);
        assert_eq!(PricingModel::from(4), PricingModel::Subscription);
    }
    
    #[test]
    fn test_parse_synx() {
        let amount = SynapseClient::<Provider<Http>>::parse_synx("10.5").unwrap();
        assert!(amount > U256::zero());
    }
}
