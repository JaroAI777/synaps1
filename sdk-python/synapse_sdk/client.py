"""
SYNAPSE Protocol Python Client
Main SDK client for interacting with SYNAPSE smart contracts
"""

import asyncio
import json
import time
from typing import Optional, List, Dict, Any, Union
from dataclasses import dataclass
from decimal import Decimal

from web3 import Web3, AsyncWeb3
from web3.middleware import geth_poa_middleware
from eth_account import Account
from eth_account.messages import encode_defunct, encode_structured_data

from .constants import Tier, PricingModel, ChannelStatus
from .abis import (
    TOKEN_ABI,
    PAYMENT_ROUTER_ABI,
    REPUTATION_REGISTRY_ABI,
    SERVICE_REGISTRY_ABI,
    PAYMENT_CHANNEL_ABI
)
from .exceptions import (
    SynapseError,
    InsufficientBalanceError,
    TransactionFailedError
)


@dataclass
class AgentInfo:
    """AI Agent information"""
    registered: bool
    name: str
    stake: Decimal
    reputation_score: int
    total_transactions: int
    successful_transactions: int
    registered_at: int
    tier: int
    tier_name: str
    success_rate: float


@dataclass
class ServiceInfo:
    """Service information"""
    provider: str
    name: str
    category: str
    description: str
    endpoint: str
    base_price: Decimal
    pricing_model: int
    pricing_model_name: str
    active: bool
    created_at: int


@dataclass
class ChannelInfo:
    """Payment channel information"""
    channel_id: str
    participant1: str
    participant2: str
    balance1: Decimal
    balance2: Decimal
    nonce: int
    status: int
    status_name: str
    challenge_end: Optional[int]


class SynapseClient:
    """
    Main client for SYNAPSE Protocol
    
    Example:
        client = SynapseClient(
            rpc_url="https://arb-sepolia.g.alchemy.com/v2/KEY",
            private_key="0x...",
            contracts={
                "token": "0x...",
                "payment_router": "0x...",
                "reputation": "0x...",
                "service_registry": "0x...",
                "payment_channel": "0x..."
            }
        )
        
        balance = await client.get_balance()
        await client.pay("0xRecipient", "10.5")
    """
    
    def __init__(
        self,
        rpc_url: str,
        private_key: Optional[str] = None,
        contracts: Optional[Dict[str, str]] = None
    ):
        """
        Initialize SYNAPSE client
        
        Args:
            rpc_url: JSON-RPC endpoint URL
            private_key: Private key for signing transactions (optional)
            contracts: Dictionary of contract addresses
        """
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        self.w3.middleware_onion.inject(geth_poa_middleware, layer=0)
        
        self.account = None
        if private_key:
            self.account = Account.from_key(private_key)
        
        self.contracts = contracts or {}
        self._init_contracts()
    
    def _init_contracts(self):
        """Initialize contract instances"""
        if self.contracts.get("token"):
            self.token = self.w3.eth.contract(
                address=Web3.to_checksum_address(self.contracts["token"]),
                abi=TOKEN_ABI
            )
        
        if self.contracts.get("payment_router"):
            self.payment_router = self.w3.eth.contract(
                address=Web3.to_checksum_address(self.contracts["payment_router"]),
                abi=PAYMENT_ROUTER_ABI
            )
        
        if self.contracts.get("reputation"):
            self.reputation = self.w3.eth.contract(
                address=Web3.to_checksum_address(self.contracts["reputation"]),
                abi=REPUTATION_REGISTRY_ABI
            )
        
        if self.contracts.get("service_registry"):
            self.service_registry = self.w3.eth.contract(
                address=Web3.to_checksum_address(self.contracts["service_registry"]),
                abi=SERVICE_REGISTRY_ABI
            )
        
        if self.contracts.get("payment_channel"):
            self.payment_channel = self.w3.eth.contract(
                address=Web3.to_checksum_address(self.contracts["payment_channel"]),
                abi=PAYMENT_CHANNEL_ABI
            )
    
    @property
    def address(self) -> str:
        """Get current account address"""
        if not self.account:
            raise SynapseError("No account connected")
        return self.account.address
    
    def _to_wei(self, amount: Union[str, Decimal, float]) -> int:
        """Convert SYNX amount to wei"""
        return Web3.to_wei(Decimal(str(amount)), 'ether')
    
    def _from_wei(self, amount: int) -> Decimal:
        """Convert wei to SYNX amount"""
        return Decimal(str(Web3.from_wei(amount, 'ether')))
    
    def _build_tx(self, func, value: int = 0) -> Dict:
        """Build transaction dictionary"""
        return func.build_transaction({
            'from': self.address,
            'nonce': self.w3.eth.get_transaction_count(self.address),
            'gas': 500000,
            'gasPrice': self.w3.eth.gas_price,
            'value': value
        })
    
    def _send_tx(self, tx: Dict) -> str:
        """Sign and send transaction"""
        signed = self.account.sign_transaction(tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed.rawTransaction)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
        
        if receipt['status'] != 1:
            raise TransactionFailedError(f"Transaction failed: {tx_hash.hex()}")
        
        return tx_hash.hex()
    
    # ==================== Token Functions ====================
    
    def get_balance(self, address: Optional[str] = None) -> Decimal:
        """
        Get SYNX token balance
        
        Args:
            address: Address to check (default: current account)
            
        Returns:
            Balance in SYNX
        """
        addr = address or self.address
        balance = self.token.functions.balanceOf(
            Web3.to_checksum_address(addr)
        ).call()
        return self._from_wei(balance)
    
    def transfer(self, to: str, amount: str) -> str:
        """
        Transfer SYNX tokens
        
        Args:
            to: Recipient address
            amount: Amount in SYNX
            
        Returns:
            Transaction hash
        """
        func = self.token.functions.transfer(
            Web3.to_checksum_address(to),
            self._to_wei(amount)
        )
        tx = self._build_tx(func)
        return self._send_tx(tx)
    
    def approve(self, spender: str, amount: str) -> str:
        """
        Approve token spending
        
        Args:
            spender: Spender address
            amount: Amount in SYNX
            
        Returns:
            Transaction hash
        """
        func = self.token.functions.approve(
            Web3.to_checksum_address(spender),
            self._to_wei(amount)
        )
        tx = self._build_tx(func)
        return self._send_tx(tx)
    
    def approve_all(self) -> List[str]:
        """
        Approve all contracts for maximum spending
        
        Returns:
            List of transaction hashes
        """
        max_amount = 2**256 - 1
        tx_hashes = []
        
        for key in ['payment_router', 'reputation', 'service_registry', 'payment_channel']:
            if self.contracts.get(key):
                func = self.token.functions.approve(
                    Web3.to_checksum_address(self.contracts[key]),
                    max_amount
                )
                tx = self._build_tx(func)
                tx_hashes.append(self._send_tx(tx))
        
        return tx_hashes
    
    # ==================== Payment Functions ====================
    
    def pay(
        self,
        recipient: str,
        amount: str,
        payment_id: Optional[bytes] = None,
        metadata: bytes = b''
    ) -> Dict[str, Any]:
        """
        Send a direct payment
        
        Args:
            recipient: Recipient address
            amount: Amount in SYNX
            payment_id: Optional 32-byte payment identifier
            metadata: Optional metadata bytes
            
        Returns:
            Dictionary with tx_hash and payment_id
        """
        if payment_id is None:
            payment_id = Web3.keccak(text=f"pay-{int(time.time())}")
        
        func = self.payment_router.functions.pay(
            Web3.to_checksum_address(recipient),
            self._to_wei(amount),
            payment_id,
            metadata
        )
        tx = self._build_tx(func)
        tx_hash = self._send_tx(tx)
        
        return {
            "tx_hash": tx_hash,
            "payment_id": payment_id.hex()
        }
    
    def batch_pay(self, payments: List[Dict[str, str]]) -> str:
        """
        Send batch payments
        
        Args:
            payments: List of {"recipient": "0x...", "amount": "10.5"}
            
        Returns:
            Transaction hash
        """
        recipients = [Web3.to_checksum_address(p["recipient"]) for p in payments]
        amounts = [self._to_wei(p["amount"]) for p in payments]
        payment_ids = [
            Web3.keccak(text=f"batch-{int(time.time())}-{i}")
            for i in range(len(payments))
        ]
        
        func = self.payment_router.functions.batchPay(
            recipients,
            amounts,
            payment_ids,
            []
        )
        tx = self._build_tx(func)
        return self._send_tx(tx)
    
    def create_escrow(
        self,
        recipient: str,
        arbiter: str,
        amount: str,
        deadline: int,
        payment_id: Optional[bytes] = None
    ) -> Dict[str, Any]:
        """
        Create an escrow payment
        
        Args:
            recipient: Recipient address
            arbiter: Arbiter address
            amount: Amount in SYNX
            deadline: Unix timestamp deadline
            payment_id: Optional payment identifier
            
        Returns:
            Dictionary with tx_hash and escrow_id
        """
        if payment_id is None:
            payment_id = Web3.keccak(text=f"escrow-{int(time.time())}")
        
        func = self.payment_router.functions.createEscrow(
            Web3.to_checksum_address(recipient),
            Web3.to_checksum_address(arbiter),
            self._to_wei(amount),
            deadline,
            payment_id,
            b''
        )
        tx = self._build_tx(func)
        tx_hash = self._send_tx(tx)
        
        # Calculate escrow ID
        escrow_id = Web3.keccak(
            Web3.solidity_keccak(
                ['address', 'address', 'bytes32', 'uint256'],
                [self.address, recipient, payment_id, deadline]
            )
        )
        
        return {
            "tx_hash": tx_hash,
            "escrow_id": escrow_id.hex(),
            "payment_id": payment_id.hex()
        }
    
    def release_escrow(self, escrow_id: str) -> str:
        """
        Release an escrow payment
        
        Args:
            escrow_id: Escrow identifier
            
        Returns:
            Transaction hash
        """
        func = self.payment_router.functions.releaseEscrow(
            bytes.fromhex(escrow_id.replace("0x", ""))
        )
        tx = self._build_tx(func)
        return self._send_tx(tx)
    
    def create_stream(
        self,
        recipient: str,
        total_amount: str,
        start_time: int,
        end_time: int
    ) -> Dict[str, Any]:
        """
        Create a payment stream
        
        Args:
            recipient: Recipient address
            total_amount: Total amount in SYNX
            start_time: Unix timestamp start
            end_time: Unix timestamp end
            
        Returns:
            Dictionary with tx_hash and stream_id
        """
        func = self.payment_router.functions.createStream(
            Web3.to_checksum_address(recipient),
            self._to_wei(total_amount),
            start_time,
            end_time
        )
        tx = self._build_tx(func)
        tx_hash = self._send_tx(tx)
        
        # Calculate stream ID
        stream_id = Web3.keccak(
            Web3.solidity_keccak(
                ['address', 'address', 'uint256', 'uint256'],
                [self.address, recipient, start_time, end_time]
            )
        )
        
        return {
            "tx_hash": tx_hash,
            "stream_id": stream_id.hex()
        }
    
    # ==================== Reputation Functions ====================
    
    def register_agent(
        self,
        name: str,
        metadata_uri: str = "",
        stake: str = "100"
    ) -> str:
        """
        Register as an AI agent
        
        Args:
            name: Agent name
            metadata_uri: IPFS URI for metadata
            stake: Stake amount in SYNX
            
        Returns:
            Transaction hash
        """
        func = self.reputation.functions.registerAgent(
            name,
            metadata_uri,
            self._to_wei(stake)
        )
        tx = self._build_tx(func)
        return self._send_tx(tx)
    
    def get_agent(self, address: Optional[str] = None) -> AgentInfo:
        """
        Get agent information
        
        Args:
            address: Agent address (default: current account)
            
        Returns:
            AgentInfo dataclass
        """
        addr = Web3.to_checksum_address(address or self.address)
        
        agent = self.reputation.functions.agents(addr).call()
        tier = self.reputation.functions.getTier(addr).call()
        success_rate = self.reputation.functions.getSuccessRate(addr).call()
        
        tier_names = {v: k for k, v in Tier.__dict__.items() if not k.startswith('_')}
        
        return AgentInfo(
            registered=agent[0],
            name=agent[1],
            stake=self._from_wei(agent[2]),
            reputation_score=agent[3],
            total_transactions=agent[4],
            successful_transactions=agent[5],
            registered_at=agent[6],
            tier=tier,
            tier_name=tier_names.get(tier, "UNKNOWN"),
            success_rate=success_rate / 100
        )
    
    def increase_stake(self, amount: str) -> str:
        """
        Increase agent stake
        
        Args:
            amount: Additional stake in SYNX
            
        Returns:
            Transaction hash
        """
        func = self.reputation.functions.increaseStake(self._to_wei(amount))
        tx = self._build_tx(func)
        return self._send_tx(tx)
    
    def create_dispute(
        self,
        defendant: str,
        reason: str,
        transaction_id: bytes
    ) -> Dict[str, Any]:
        """
        Create a dispute against another agent
        
        Args:
            defendant: Defendant address
            reason: Dispute reason
            transaction_id: Related transaction ID
            
        Returns:
            Dictionary with tx_hash and dispute_id
        """
        func = self.reputation.functions.createDispute(
            Web3.to_checksum_address(defendant),
            reason,
            transaction_id
        )
        tx = self._build_tx(func)
        tx_hash = self._send_tx(tx)
        
        return {
            "tx_hash": tx_hash,
            "dispute_id": None  # Would need to parse events
        }
    
    def rate_service(self, provider: str, category: str, rating: int) -> str:
        """
        Rate a service provider
        
        Args:
            provider: Provider address
            category: Service category
            rating: Rating (1-5)
            
        Returns:
            Transaction hash
        """
        if not 1 <= rating <= 5:
            raise ValueError("Rating must be between 1 and 5")
        
        func = self.reputation.functions.rateService(
            Web3.to_checksum_address(provider),
            category,
            rating
        )
        tx = self._build_tx(func)
        return self._send_tx(tx)
    
    # ==================== Service Registry Functions ====================
    
    def register_service(
        self,
        name: str,
        category: str,
        description: str,
        endpoint: str,
        base_price: str,
        pricing_model: int = PricingModel.PER_REQUEST
    ) -> Dict[str, Any]:
        """
        Register a new service
        
        Args:
            name: Service name
            category: Service category
            description: Service description
            endpoint: API endpoint URL
            base_price: Base price in SYNX
            pricing_model: Pricing model constant
            
        Returns:
            Dictionary with tx_hash and service_id
        """
        func = self.service_registry.functions.registerService(
            name,
            category,
            description,
            endpoint,
            self._to_wei(base_price),
            pricing_model
        )
        tx = self._build_tx(func)
        tx_hash = self._send_tx(tx)
        
        return {
            "tx_hash": tx_hash,
            "service_id": None  # Would need to parse events
        }
    
    def get_service(self, service_id: str) -> ServiceInfo:
        """
        Get service information
        
        Args:
            service_id: Service identifier
            
        Returns:
            ServiceInfo dataclass
        """
        service = self.service_registry.functions.services(
            bytes.fromhex(service_id.replace("0x", ""))
        ).call()
        
        pricing_names = {v: k for k, v in PricingModel.__dict__.items() if not k.startswith('_')}
        
        return ServiceInfo(
            provider=service[0],
            name=service[1],
            category=service[2],
            description=service[3],
            endpoint=service[4],
            base_price=self._from_wei(service[5]),
            pricing_model=service[6],
            pricing_model_name=pricing_names.get(service[6], "UNKNOWN"),
            active=service[7],
            created_at=service[8]
        )
    
    def find_services_by_category(self, category: str) -> List[str]:
        """
        Find services by category
        
        Args:
            category: Service category
            
        Returns:
            List of service IDs
        """
        service_ids = self.service_registry.functions.getServicesByCategory(
            category
        ).call()
        return [sid.hex() for sid in service_ids]
    
    def calculate_price(self, service_id: str, quantity: int) -> Decimal:
        """
        Calculate price for a service
        
        Args:
            service_id: Service identifier
            quantity: Quantity/units
            
        Returns:
            Price in SYNX
        """
        price = self.service_registry.functions.calculatePrice(
            bytes.fromhex(service_id.replace("0x", "")),
            quantity
        ).call()
        return self._from_wei(price)
    
    def request_quote(
        self,
        service_id: str,
        quantity: int,
        specs: bytes = b''
    ) -> Dict[str, Any]:
        """
        Request a quote for a service
        
        Args:
            service_id: Service identifier
            quantity: Quantity needed
            specs: Optional specifications
            
        Returns:
            Dictionary with tx_hash and quote_id
        """
        func = self.service_registry.functions.requestQuote(
            bytes.fromhex(service_id.replace("0x", "")),
            quantity,
            specs
        )
        tx = self._build_tx(func)
        tx_hash = self._send_tx(tx)
        
        return {
            "tx_hash": tx_hash,
            "quote_id": None  # Would need to parse events
        }
    
    def accept_quote(self, quote_id: str) -> str:
        """
        Accept a quote and make payment
        
        Args:
            quote_id: Quote identifier
            
        Returns:
            Transaction hash
        """
        func = self.service_registry.functions.acceptQuote(
            bytes.fromhex(quote_id.replace("0x", ""))
        )
        tx = self._build_tx(func)
        return self._send_tx(tx)
    
    # ==================== Payment Channel Functions ====================
    
    def open_channel(
        self,
        counterparty: str,
        my_deposit: str,
        their_deposit: str = "0"
    ) -> Dict[str, Any]:
        """
        Open a payment channel
        
        Args:
            counterparty: Other party address
            my_deposit: My deposit in SYNX
            their_deposit: Expected deposit from them in SYNX
            
        Returns:
            Dictionary with tx_hash and channel_id
        """
        func = self.payment_channel.functions.openChannel(
            Web3.to_checksum_address(counterparty),
            self._to_wei(my_deposit),
            self._to_wei(their_deposit)
        )
        tx = self._build_tx(func)
        tx_hash = self._send_tx(tx)
        
        channel_id = self.payment_channel.functions.getChannelId(
            self.address,
            counterparty
        ).call()
        
        return {
            "tx_hash": tx_hash,
            "channel_id": channel_id.hex()
        }
    
    def get_channel(self, party1: str, party2: str) -> ChannelInfo:
        """
        Get channel information
        
        Args:
            party1: First party address
            party2: Second party address
            
        Returns:
            ChannelInfo dataclass
        """
        channel_id = self.payment_channel.functions.getChannelId(
            Web3.to_checksum_address(party1),
            Web3.to_checksum_address(party2)
        ).call()
        
        channel = self.payment_channel.functions.channels(channel_id).call()
        
        status_names = {v: k for k, v in ChannelStatus.__dict__.items() if not k.startswith('_')}
        
        return ChannelInfo(
            channel_id=channel_id.hex(),
            participant1=channel[0],
            participant2=channel[1],
            balance1=self._from_wei(channel[2]),
            balance2=self._from_wei(channel[3]),
            nonce=channel[4],
            status=channel[5],
            status_name=status_names.get(channel[5], "UNKNOWN"),
            challenge_end=channel[6] if channel[6] > 0 else None
        )
    
    def sign_channel_state(
        self,
        channel_id: str,
        balance1: str,
        balance2: str,
        nonce: int
    ) -> str:
        """
        Sign a channel state update
        
        Args:
            channel_id: Channel identifier
            balance1: Balance for party 1 in SYNX
            balance2: Balance for party 2 in SYNX
            nonce: State nonce
            
        Returns:
            Signature hex string
        """
        message_hash = Web3.solidity_keccak(
            ['bytes32', 'uint256', 'uint256', 'uint256'],
            [
                bytes.fromhex(channel_id.replace("0x", "")),
                self._to_wei(balance1),
                self._to_wei(balance2),
                nonce
            ]
        )
        
        message = encode_defunct(message_hash)
        signed = self.account.sign_message(message)
        
        return signed.signature.hex()
    
    # ==================== Utility Functions ====================
    
    def get_network_info(self) -> Dict[str, Any]:
        """
        Get network information
        
        Returns:
            Dictionary with chain_id, block_number, gas_price
        """
        return {
            "chain_id": self.w3.eth.chain_id,
            "block_number": self.w3.eth.block_number,
            "gas_price_gwei": Web3.from_wei(self.w3.eth.gas_price, 'gwei')
        }
    
    def wait_for_transaction(self, tx_hash: str, timeout: int = 120) -> Dict:
        """
        Wait for transaction confirmation
        
        Args:
            tx_hash: Transaction hash
            timeout: Timeout in seconds
            
        Returns:
            Transaction receipt
        """
        return self.w3.eth.wait_for_transaction_receipt(
            tx_hash,
            timeout=timeout
        )
