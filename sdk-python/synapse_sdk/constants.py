"""
SYNAPSE Protocol Constants
"""


class Tier:
    """Reputation tier levels"""
    UNVERIFIED = 0
    BRONZE = 1
    SILVER = 2
    GOLD = 3
    PLATINUM = 4
    DIAMOND = 5
    
    @classmethod
    def get_name(cls, tier: int) -> str:
        """Get tier name from value"""
        names = {
            0: "UNVERIFIED",
            1: "BRONZE",
            2: "SILVER",
            3: "GOLD",
            4: "PLATINUM",
            5: "DIAMOND"
        }
        return names.get(tier, "UNKNOWN")
    
    @classmethod
    def get_discount(cls, tier: int) -> int:
        """Get fee discount percentage for tier"""
        discounts = {
            0: 0,    # 0%
            1: 10,   # 10%
            2: 25,   # 25%
            3: 40,   # 40%
            4: 60,   # 60%
            5: 75    # 75%
        }
        return discounts.get(tier, 0)


class PricingModel:
    """Service pricing models"""
    PER_REQUEST = 0
    PER_TOKEN = 1
    PER_SECOND = 2
    PER_BYTE = 3
    SUBSCRIPTION = 4
    CUSTOM = 5
    
    @classmethod
    def get_name(cls, model: int) -> str:
        """Get pricing model name from value"""
        names = {
            0: "PER_REQUEST",
            1: "PER_TOKEN",
            2: "PER_SECOND",
            3: "PER_BYTE",
            4: "SUBSCRIPTION",
            5: "CUSTOM"
        }
        return names.get(model, "UNKNOWN")


class ChannelStatus:
    """Payment channel status"""
    NONE = 0
    OPEN = 1
    CLOSING = 2
    CLOSED = 3
    
    @classmethod
    def get_name(cls, status: int) -> str:
        """Get status name from value"""
        names = {
            0: "NONE",
            1: "OPEN",
            2: "CLOSING",
            3: "CLOSED"
        }
        return names.get(status, "UNKNOWN")


class ServiceCategory:
    """Default service categories"""
    LANGUAGE_MODEL = "language_model"
    IMAGE_GENERATION = "image_generation"
    CODE_GENERATION = "code_generation"
    TRANSLATION = "translation"
    DATA_ANALYSIS = "data_analysis"
    REASONING = "reasoning"
    EMBEDDING = "embedding"
    SPEECH = "speech"
    VISION = "vision"
    MULTIMODAL = "multimodal"
    AGENT = "agent"
    TOOL = "tool"
    CUSTOM = "custom"
    
    @classmethod
    def all(cls) -> list:
        """Get all categories"""
        return [
            cls.LANGUAGE_MODEL,
            cls.IMAGE_GENERATION,
            cls.CODE_GENERATION,
            cls.TRANSLATION,
            cls.DATA_ANALYSIS,
            cls.REASONING,
            cls.EMBEDDING,
            cls.SPEECH,
            cls.VISION,
            cls.MULTIMODAL,
            cls.AGENT,
            cls.TOOL,
            cls.CUSTOM
        ]
