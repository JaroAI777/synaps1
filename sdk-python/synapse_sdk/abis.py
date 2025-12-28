"""
SYNAPSE Protocol Contract ABIs
Simplified ABIs for SDK usage
"""

TOKEN_ABI = [
    {
        "inputs": [{"name": "account", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "to", "type": "address"},
            {"name": "amount", "type": "uint256"}
        ],
        "name": "transfer",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "spender", "type": "address"},
            {"name": "amount", "type": "uint256"}
        ],
        "name": "approve",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"}
        ],
        "name": "allowance",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "totalSupply",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "name",
        "outputs": [{"name": "", "type": "string"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "symbol",
        "outputs": [{"name": "", "type": "string"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "decimals",
        "outputs": [{"name": "", "type": "uint8"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"name": "delegatee", "type": "address"}],
        "name": "delegate",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "account", "type": "address"}],
        "name": "getVotes",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    }
]

PAYMENT_ROUTER_ABI = [
    {
        "inputs": [
            {"name": "recipient", "type": "address"},
            {"name": "amount", "type": "uint256"},
            {"name": "paymentId", "type": "bytes32"},
            {"name": "metadata", "type": "bytes"}
        ],
        "name": "pay",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "recipients", "type": "address[]"},
            {"name": "amounts", "type": "uint256[]"},
            {"name": "paymentIds", "type": "bytes32[]"},
            {"name": "metadata", "type": "bytes[]"}
        ],
        "name": "batchPay",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "recipient", "type": "address"},
            {"name": "arbiter", "type": "address"},
            {"name": "amount", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
            {"name": "paymentId", "type": "bytes32"},
            {"name": "metadata", "type": "bytes"}
        ],
        "name": "createEscrow",
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "escrowId", "type": "bytes32"}],
        "name": "releaseEscrow",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "escrowId", "type": "bytes32"}],
        "name": "refundEscrow",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "recipient", "type": "address"},
            {"name": "totalAmount", "type": "uint256"},
            {"name": "startTime", "type": "uint256"},
            {"name": "endTime", "type": "uint256"}
        ],
        "name": "createStream",
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "streamId", "type": "bytes32"}],
        "name": "withdrawFromStream",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "streamId", "type": "bytes32"}],
        "name": "cancelStream",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "baseFeeBps",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"name": "", "type": "address"}],
        "name": "nonces",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"name": "", "type": "address"}],
        "name": "agentStats",
        "outputs": [
            {"name": "totalPaymentsSent", "type": "uint256"},
            {"name": "totalPaymentsReceived", "type": "uint256"},
            {"name": "totalVolumeSent", "type": "uint256"},
            {"name": "totalVolumeReceived", "type": "uint256"}
        ],
        "stateMutability": "view",
        "type": "function"
    }
]

REPUTATION_REGISTRY_ABI = [
    {
        "inputs": [
            {"name": "name", "type": "string"},
            {"name": "metadataUri", "type": "string"},
            {"name": "stakeAmount", "type": "uint256"}
        ],
        "name": "registerAgent",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "deregisterAgent",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "amount", "type": "uint256"}],
        "name": "increaseStake",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "amount", "type": "uint256"}],
        "name": "decreaseStake",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "", "type": "address"}],
        "name": "agents",
        "outputs": [
            {"name": "registered", "type": "bool"},
            {"name": "name", "type": "string"},
            {"name": "stake", "type": "uint256"},
            {"name": "reputationScore", "type": "uint256"},
            {"name": "totalTransactions", "type": "uint256"},
            {"name": "successfulTransactions", "type": "uint256"},
            {"name": "registeredAt", "type": "uint256"}
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"name": "agent", "type": "address"}],
        "name": "getTier",
        "outputs": [{"name": "", "type": "uint8"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"name": "tier", "type": "uint8"}],
        "name": "getTierDiscount",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"name": "agent", "type": "address"}],
        "name": "getSuccessRate",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "defendant", "type": "address"},
            {"name": "reason", "type": "string"},
            {"name": "transactionId", "type": "bytes32"}
        ],
        "name": "createDispute",
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "provider", "type": "address"},
            {"name": "category", "type": "string"},
            {"name": "rating", "type": "uint8"}
        ],
        "name": "rateService",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "provider", "type": "address"},
            {"name": "category", "type": "string"}
        ],
        "name": "getServiceRating",
        "outputs": [
            {"name": "totalRatings", "type": "uint256"},
            {"name": "averageRating", "type": "uint256"}
        ],
        "stateMutability": "view",
        "type": "function"
    }
]

SERVICE_REGISTRY_ABI = [
    {
        "inputs": [
            {"name": "name", "type": "string"},
            {"name": "category", "type": "string"},
            {"name": "description", "type": "string"},
            {"name": "endpoint", "type": "string"},
            {"name": "basePrice", "type": "uint256"},
            {"name": "pricingModel", "type": "uint8"}
        ],
        "name": "registerService",
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "serviceId", "type": "bytes32"},
            {"name": "description", "type": "string"}
        ],
        "name": "updateServiceDescription",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "serviceId", "type": "bytes32"},
            {"name": "endpoint", "type": "string"}
        ],
        "name": "updateServiceEndpoint",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "serviceId", "type": "bytes32"},
            {"name": "newPrice", "type": "uint256"}
        ],
        "name": "updateServicePrice",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "serviceId", "type": "bytes32"}],
        "name": "activateService",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "serviceId", "type": "bytes32"}],
        "name": "deactivateService",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "", "type": "bytes32"}],
        "name": "services",
        "outputs": [
            {"name": "provider", "type": "address"},
            {"name": "name", "type": "string"},
            {"name": "category", "type": "string"},
            {"name": "description", "type": "string"},
            {"name": "endpoint", "type": "string"},
            {"name": "basePrice", "type": "uint256"},
            {"name": "pricingModel", "type": "uint8"},
            {"name": "active", "type": "bool"},
            {"name": "createdAt", "type": "uint256"}
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"name": "category", "type": "string"}],
        "name": "getServicesByCategory",
        "outputs": [{"name": "", "type": "bytes32[]"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"name": "category", "type": "string"}],
        "name": "categoryExists",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "serviceId", "type": "bytes32"},
            {"name": "quantity", "type": "uint256"}
        ],
        "name": "calculatePrice",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "serviceId", "type": "bytes32"},
            {"name": "quantity", "type": "uint256"},
            {"name": "specs", "type": "bytes"}
        ],
        "name": "requestQuote",
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "quoteId", "type": "bytes32"}],
        "name": "acceptQuote",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    }
]

PAYMENT_CHANNEL_ABI = [
    {
        "inputs": [
            {"name": "counterparty", "type": "address"},
            {"name": "myDeposit", "type": "uint256"},
            {"name": "theirDeposit", "type": "uint256"}
        ],
        "name": "openChannel",
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "initiator", "type": "address"},
            {"name": "amount", "type": "uint256"}
        ],
        "name": "fundChannel",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "counterparty", "type": "address"},
            {"name": "amount", "type": "uint256"}
        ],
        "name": "addFunds",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "counterparty", "type": "address"},
            {"name": "balance1", "type": "uint256"},
            {"name": "balance2", "type": "uint256"},
            {"name": "nonce", "type": "uint256"},
            {"name": "sig1", "type": "bytes"},
            {"name": "sig2", "type": "bytes"}
        ],
        "name": "cooperativeClose",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "counterparty", "type": "address"},
            {"name": "balance1", "type": "uint256"},
            {"name": "balance2", "type": "uint256"},
            {"name": "nonce", "type": "uint256"},
            {"name": "sig1", "type": "bytes"},
            {"name": "sig2", "type": "bytes"}
        ],
        "name": "initiateClose",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "counterparty", "type": "address"},
            {"name": "balance1", "type": "uint256"},
            {"name": "balance2", "type": "uint256"},
            {"name": "nonce", "type": "uint256"},
            {"name": "sig1", "type": "bytes"},
            {"name": "sig2", "type": "bytes"}
        ],
        "name": "challengeClose",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{"name": "counterparty", "type": "address"}],
        "name": "finalizeClose",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "party1", "type": "address"},
            {"name": "party2", "type": "address"}
        ],
        "name": "getChannelId",
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {"name": "party1", "type": "address"},
            {"name": "party2", "type": "address"}
        ],
        "name": "getChannelBalance",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"name": "", "type": "bytes32"}],
        "name": "channels",
        "outputs": [
            {"name": "participant1", "type": "address"},
            {"name": "participant2", "type": "address"},
            {"name": "balance1", "type": "uint256"},
            {"name": "balance2", "type": "uint256"},
            {"name": "nonce", "type": "uint256"},
            {"name": "status", "type": "uint8"},
            {"name": "challengeEnd", "type": "uint256"}
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "challengePeriod",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    }
]
