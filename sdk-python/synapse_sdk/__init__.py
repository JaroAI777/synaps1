"""
SYNAPSE Protocol Python SDK
AI-to-AI Payment Infrastructure

Usage:
    from synapse_sdk import SynapseClient, Tier, PricingModel
    
    client = SynapseClient(
        rpc_url="https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY",
        private_key="YOUR_PRIVATE_KEY",
        contracts={...}
    )
    
    # Send payment
    await client.pay("0xRecipient", "10.5")
"""

from .client import SynapseClient
from .constants import Tier, PricingModel, ChannelStatus
from .exceptions import (
    SynapseError,
    InsufficientBalanceError,
    TransactionFailedError,
    InvalidSignatureError
)

__version__ = "1.0.0"
__author__ = "SYNAPSE Protocol Team"
__all__ = [
    "SynapseClient",
    "Tier",
    "PricingModel", 
    "ChannelStatus",
    "SynapseError",
    "InsufficientBalanceError",
    "TransactionFailedError",
    "InvalidSignatureError"
]
