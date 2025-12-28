"""
SYNAPSE Protocol Python SDK
"""

from setuptools import setup, find_packages

with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

setup(
    name="synapse-protocol-sdk",
    version="1.0.0",
    author="SYNAPSE Protocol Team",
    author_email="dev@synapse-protocol.ai",
    description="Python SDK for SYNAPSE Protocol - AI-to-AI Payment Infrastructure",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/synapse-protocol/synapse-protocol",
    project_urls={
        "Bug Tracker": "https://github.com/synapse-protocol/synapse-protocol/issues",
        "Documentation": "https://docs.synapse-protocol.ai",
        "Source Code": "https://github.com/synapse-protocol/synapse-protocol",
    },
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "Topic :: Office/Business :: Financial",
        "Topic :: Scientific/Engineering :: Artificial Intelligence",
    ],
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[
        "web3>=6.0.0",
        "eth-account>=0.10.0",
        "eth-typing>=3.0.0",
        "eth-utils>=2.0.0",
    ],
    extras_require={
        "dev": [
            "pytest>=7.0.0",
            "pytest-asyncio>=0.21.0",
            "pytest-cov>=4.0.0",
            "black>=23.0.0",
            "isort>=5.0.0",
            "mypy>=1.0.0",
            "flake8>=6.0.0",
        ],
        "docs": [
            "sphinx>=6.0.0",
            "sphinx-rtd-theme>=1.0.0",
            "myst-parser>=1.0.0",
        ],
    },
    keywords=[
        "synapse",
        "protocol",
        "blockchain",
        "ethereum",
        "arbitrum",
        "ai",
        "payments",
        "micropayments",
        "web3",
        "defi",
        "ai-agents",
    ],
)
