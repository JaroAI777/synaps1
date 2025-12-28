"""
SYNAPSE Protocol Exceptions
"""


class SynapseError(Exception):
    """Base exception for SYNAPSE SDK"""
    pass


class InsufficientBalanceError(SynapseError):
    """Raised when account has insufficient balance"""
    
    def __init__(self, required: str, available: str):
        self.required = required
        self.available = available
        super().__init__(
            f"Insufficient balance: required {required} SYNX, available {available} SYNX"
        )


class TransactionFailedError(SynapseError):
    """Raised when a transaction fails"""
    
    def __init__(self, message: str, tx_hash: str = None):
        self.tx_hash = tx_hash
        super().__init__(message)


class InvalidSignatureError(SynapseError):
    """Raised when a signature is invalid"""
    pass


class AgentNotRegisteredError(SynapseError):
    """Raised when agent is not registered"""
    
    def __init__(self, address: str):
        self.address = address
        super().__init__(f"Agent not registered: {address}")


class ServiceNotFoundError(SynapseError):
    """Raised when service is not found"""
    
    def __init__(self, service_id: str):
        self.service_id = service_id
        super().__init__(f"Service not found: {service_id}")


class ChannelNotFoundError(SynapseError):
    """Raised when payment channel is not found"""
    
    def __init__(self, channel_id: str):
        self.channel_id = channel_id
        super().__init__(f"Channel not found: {channel_id}")


class QuoteExpiredError(SynapseError):
    """Raised when a quote has expired"""
    
    def __init__(self, quote_id: str):
        self.quote_id = quote_id
        super().__init__(f"Quote expired: {quote_id}")


class EscrowAlreadyReleasedError(SynapseError):
    """Raised when trying to release an already released escrow"""
    
    def __init__(self, escrow_id: str):
        self.escrow_id = escrow_id
        super().__init__(f"Escrow already released: {escrow_id}")


class DisputeResolutionError(SynapseError):
    """Raised when dispute resolution fails"""
    pass


class StakeTooLowError(SynapseError):
    """Raised when stake is below minimum"""
    
    def __init__(self, provided: str, minimum: str):
        self.provided = provided
        self.minimum = minimum
        super().__init__(
            f"Stake too low: provided {provided} SYNX, minimum {minimum} SYNX"
        )


class RateLimitError(SynapseError):
    """Raised when rate limit is exceeded"""
    
    def __init__(self, retry_after: int = None):
        self.retry_after = retry_after
        message = "Rate limit exceeded"
        if retry_after:
            message += f", retry after {retry_after} seconds"
        super().__init__(message)
