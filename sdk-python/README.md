# SYNAPSE Protocol Python SDK

Python SDK for integrating with SYNAPSE Protocol - the AI-to-AI payment infrastructure.

## Installation

```bash
pip install synapse-protocol-sdk
```

Or install from source:

```bash
git clone https://github.com/synapse-protocol/synapse-protocol.git
cd synapse-protocol/sdk-python
pip install -e .
```

## Quick Start

```python
from synapse_sdk import SynapseClient, Tier, PricingModel

# Initialize client
client = SynapseClient(
    rpc_url="https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY",
    private_key="YOUR_PRIVATE_KEY",
    contracts={
        "token": "0x...",
        "payment_router": "0x...",
        "reputation": "0x...",
        "service_registry": "0x...",
        "payment_channel": "0x..."
    }
)

# Check balance
balance = client.get_balance()
print(f"Balance: {balance} SYNX")

# Send payment
result = client.pay("0xRecipient", "10.5")
print(f"Payment sent: {result['tx_hash']}")
```

## Features

### Token Operations

```python
# Get balance
balance = client.get_balance()
balance = client.get_balance("0xOtherAddress")

# Transfer tokens
tx_hash = client.transfer("0xRecipient", "100")

# Approve spending
tx_hash = client.approve("0xSpender", "1000")

# Approve all protocol contracts
tx_hashes = client.approve_all()
```

### Payments

```python
# Direct payment
result = client.pay(
    recipient="0xRecipient",
    amount="10.5",
    payment_id=None,  # Auto-generated
    metadata=b''
)

# Batch payments
tx_hash = client.batch_pay([
    {"recipient": "0xAgent1", "amount": "5.0"},
    {"recipient": "0xAgent2", "amount": "10.0"},
    {"recipient": "0xAgent3", "amount": "7.5"}
])

# Escrow payment
import time
deadline = int(time.time()) + 86400  # 24 hours

result = client.create_escrow(
    recipient="0xProvider",
    arbiter="0xArbiter",
    amount="100",
    deadline=deadline
)

# Release escrow
tx_hash = client.release_escrow(result["escrow_id"])

# Payment stream
now = int(time.time())
result = client.create_stream(
    recipient="0xWorker",
    total_amount="1000",
    start_time=now,
    end_time=now + 604800  # 1 week
)
```

### Agent Registration

```python
# Register as AI agent
tx_hash = client.register_agent(
    name="MyAIAgent",
    metadata_uri="ipfs://QmMetadata",
    stake="500"
)

# Get agent info
agent = client.get_agent()
print(f"Name: {agent.name}")
print(f"Tier: {agent.tier_name}")
print(f"Reputation: {agent.reputation_score}")
print(f"Success Rate: {agent.success_rate}%")

# Increase stake
tx_hash = client.increase_stake("100")
```

### Service Registry

```python
# Register a service
result = client.register_service(
    name="GPT-4 Translation",
    category="translation",
    description="High-quality AI translation",
    endpoint="https://api.myagent.ai/translate",
    base_price="0.001",
    pricing_model=PricingModel.PER_REQUEST
)

# Find services
service_ids = client.find_services_by_category("translation")

# Get service details
service = client.get_service(service_ids[0])
print(f"Service: {service.name}")
print(f"Price: {service.base_price} SYNX")

# Calculate price
price = client.calculate_price(service_ids[0], quantity=100)
print(f"Price for 100 requests: {price} SYNX")

# Request and accept quote
quote = client.request_quote(service_ids[0], quantity=100)
tx_hash = client.accept_quote(quote["quote_id"])
```

### Payment Channels

```python
# Open channel
result = client.open_channel(
    counterparty="0xOtherAgent",
    my_deposit="1000",
    their_deposit="500"
)

# Get channel info
channel = client.get_channel(client.address, "0xOtherAgent")
print(f"Status: {channel.status_name}")
print(f"My Balance: {channel.balance1}")

# Sign state update
signature = client.sign_channel_state(
    channel_id=result["channel_id"],
    balance1="800",
    balance2="700",
    nonce=1
)
```

## Constants

### Tiers

```python
from synapse_sdk import Tier

Tier.UNVERIFIED  # 0 - No discount
Tier.BRONZE      # 1 - 10% discount
Tier.SILVER      # 2 - 25% discount
Tier.GOLD        # 3 - 40% discount
Tier.PLATINUM    # 4 - 60% discount
Tier.DIAMOND     # 5 - 75% discount
```

### Pricing Models

```python
from synapse_sdk import PricingModel

PricingModel.PER_REQUEST    # 0
PricingModel.PER_TOKEN      # 1
PricingModel.PER_SECOND     # 2
PricingModel.PER_BYTE       # 3
PricingModel.SUBSCRIPTION   # 4
PricingModel.CUSTOM         # 5
```

### Channel Status

```python
from synapse_sdk import ChannelStatus

ChannelStatus.NONE     # 0
ChannelStatus.OPEN     # 1
ChannelStatus.CLOSING  # 2
ChannelStatus.CLOSED   # 3
```

## Error Handling

```python
from synapse_sdk import (
    SynapseError,
    InsufficientBalanceError,
    TransactionFailedError,
    InvalidSignatureError
)

try:
    client.pay("0xRecipient", "1000000")
except InsufficientBalanceError as e:
    print(f"Not enough balance: need {e.required}, have {e.available}")
except TransactionFailedError as e:
    print(f"Transaction failed: {e.tx_hash}")
except SynapseError as e:
    print(f"SYNAPSE error: {e}")
```

## Network Information

```python
info = client.get_network_info()
print(f"Chain ID: {info['chain_id']}")
print(f"Block: {info['block_number']}")
print(f"Gas Price: {info['gas_price_gwei']} gwei")
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run with coverage
pytest --cov=synapse_sdk

# Format code
black synapse_sdk/
isort synapse_sdk/

# Type checking
mypy synapse_sdk/
```

## Requirements

- Python >= 3.9
- web3.py >= 6.0.0

## License

MIT License - see [LICENSE](../LICENSE)

## Links

- [Documentation](https://docs.synapse-protocol.ai)
- [GitHub](https://github.com/synapse-protocol/synapse-protocol)
- [Discord](https://discord.gg/synapse)
