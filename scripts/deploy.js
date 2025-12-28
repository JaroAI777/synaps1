/**
 * SYNAPSE Protocol - Deployment Script
 * 
 * Deploys all core contracts to Ethereum/Arbitrum
 * Run with: npx hardhat run scripts/deploy.js --network <network>
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Deployment configuration
const CONFIG = {
    // Token settings
    TOKEN: {
        NAME: "SYNAPSE Token",
        SYMBOL: "SYNX",
        INITIAL_SUPPLY: hre.ethers.parseEther("1000000000"), // 1 billion
        TRANSFER_FEE: 10, // 0.1% in basis points
    },
    
    // Governance settings
    GOVERNANCE: {
        VOTING_DELAY: 7200,      // 1 day in blocks (12s blocks)
        VOTING_PERIOD: 36000,    // 5 days in blocks
        PROPOSAL_THRESHOLD: hre.ethers.parseEther("100000"), // 100k SYNX
        QUORUM_PERCENTAGE: 10,   // 10%
        TIMELOCK_DELAY: 172800,  // 2 days in seconds
    },
    
    // Reputation settings
    REPUTATION: {
        MIN_STAKE: hre.ethers.parseEther("10"),      // 10 SYNX
        REGISTRATION_FEE: hre.ethers.parseEther("1"), // 1 SYNX
    },
    
    // Service Registry settings
    SERVICE: {
        MAX_SERVICES_PER_AGENT: 100,
        QUOTE_VALIDITY: 3600, // 1 hour
    },
    
    // Payment Channel settings
    CHANNEL: {
        CHALLENGE_PERIOD: 3600, // 1 hour
    },
};

// Deployment addresses storage
const deployedContracts = {};

async function main() {
    console.log("╔═══════════════════════════════════════════════════════════╗");
    console.log("║         SYNAPSE Protocol - Deployment Script              ║");
    console.log("╚═══════════════════════════════════════════════════════════╝");
    console.log("");
    
    const [deployer] = await hre.ethers.getSigners();
    const network = hre.network.name;
    
    console.log(`📡 Network: ${network}`);
    console.log(`👤 Deployer: ${deployer.address}`);
    console.log(`💰 Balance: ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} ETH`);
    console.log("");
    console.log("─".repeat(60));
    
    // 1. Deploy SynapseToken
    console.log("\n📦 Deploying SynapseToken...");
    const SynapseToken = await hre.ethers.getContractFactory("SynapseToken");
    const token = await SynapseToken.deploy(
        CONFIG.TOKEN.NAME,
        CONFIG.TOKEN.SYMBOL,
        CONFIG.TOKEN.INITIAL_SUPPLY,
        deployer.address,
        deployer.address
    );
    await token.waitForDeployment();
    deployedContracts.SynapseToken = await token.getAddress();
    console.log(`   ✅ SynapseToken deployed at: ${deployedContracts.SynapseToken}`);
    
    // 2. Deploy Timelock
    console.log("\n📦 Deploying SynapseTimelock...");
    const SynapseTimelock = await hre.ethers.getContractFactory("SynapseTimelock");
    const timelock = await SynapseTimelock.deploy(
        CONFIG.GOVERNANCE.TIMELOCK_DELAY,
        [], // proposers - will be set to governor
        [], // executors - will be set to governor
        deployer.address // admin
    );
    await timelock.waitForDeployment();
    deployedContracts.SynapseTimelock = await timelock.getAddress();
    console.log(`   ✅ SynapseTimelock deployed at: ${deployedContracts.SynapseTimelock}`);
    
    // 3. Deploy Governor
    console.log("\n📦 Deploying SynapseGovernor...");
    const SynapseGovernor = await hre.ethers.getContractFactory("SynapseGovernor");
    const governor = await SynapseGovernor.deploy(
        deployedContracts.SynapseToken,
        deployedContracts.SynapseTimelock
    );
    await governor.waitForDeployment();
    deployedContracts.SynapseGovernor = await governor.getAddress();
    console.log(`   ✅ SynapseGovernor deployed at: ${deployedContracts.SynapseGovernor}`);
    
    // 4. Deploy Treasury
    console.log("\n📦 Deploying Treasury...");
    const Treasury = await hre.ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(
        deployedContracts.SynapseGovernor,
        deployedContracts.SynapseTimelock
    );
    await treasury.waitForDeployment();
    deployedContracts.Treasury = await treasury.getAddress();
    console.log(`   ✅ Treasury deployed at: ${deployedContracts.Treasury}`);
    
    // 5. Deploy ReputationRegistry
    console.log("\n📦 Deploying ReputationRegistry...");
    const ReputationRegistry = await hre.ethers.getContractFactory("ReputationRegistry");
    const reputation = await ReputationRegistry.deploy(
        deployedContracts.SynapseToken,
        CONFIG.REPUTATION.MIN_STAKE,
        CONFIG.REPUTATION.REGISTRATION_FEE
    );
    await reputation.waitForDeployment();
    deployedContracts.ReputationRegistry = await reputation.getAddress();
    console.log(`   ✅ ReputationRegistry deployed at: ${deployedContracts.ReputationRegistry}`);
    
    // 6. Deploy PaymentRouter
    console.log("\n📦 Deploying PaymentRouter...");
    const PaymentRouter = await hre.ethers.getContractFactory("PaymentRouter");
    const router = await PaymentRouter.deploy(
        deployedContracts.SynapseToken,
        deployedContracts.ReputationRegistry,
        deployedContracts.Treasury
    );
    await router.waitForDeployment();
    deployedContracts.PaymentRouter = await router.getAddress();
    console.log(`   ✅ PaymentRouter deployed at: ${deployedContracts.PaymentRouter}`);
    
    // 7. Deploy PaymentChannel
    console.log("\n📦 Deploying PaymentChannel...");
    const PaymentChannel = await hre.ethers.getContractFactory("PaymentChannel");
    const channel = await PaymentChannel.deploy(
        deployedContracts.SynapseToken,
        deployedContracts.ReputationRegistry
    );
    await channel.waitForDeployment();
    deployedContracts.PaymentChannel = await channel.getAddress();
    console.log(`   ✅ PaymentChannel deployed at: ${deployedContracts.PaymentChannel}`);
    
    // 8. Deploy ServiceRegistry
    console.log("\n📦 Deploying ServiceRegistry...");
    const ServiceRegistry = await hre.ethers.getContractFactory("ServiceRegistry");
    const service = await ServiceRegistry.deploy(
        deployedContracts.SynapseToken,
        deployedContracts.ReputationRegistry,
        deployedContracts.PaymentRouter
    );
    await service.waitForDeployment();
    deployedContracts.ServiceRegistry = await service.getAddress();
    console.log(`   ✅ ServiceRegistry deployed at: ${deployedContracts.ServiceRegistry}`);
    
    // Configure contracts
    console.log("\n⚙️  Configuring contracts...");
    
    // Set fee exemptions
    await token.setFeeExempt(deployedContracts.Treasury, true);
    await token.setFeeExempt(deployedContracts.PaymentRouter, true);
    await token.setFeeExempt(deployedContracts.PaymentChannel, true);
    console.log("   ✅ Fee exemptions set");
    
    // Grant router role to PaymentRouter
    const OPERATOR_ROLE = await router.OPERATOR_ROLE();
    await router.grantRole(OPERATOR_ROLE, deployer.address);
    console.log("   ✅ Operator role granted");
    
    // Approve token for treasury
    await treasury.approveToken(deployedContracts.SynapseToken);
    console.log("   ✅ Token approved for treasury");
    
    // Setup timelock roles
    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
    const ADMIN_ROLE = await timelock.DEFAULT_ADMIN_ROLE();
    
    await timelock.grantRole(PROPOSER_ROLE, deployedContracts.SynapseGovernor);
    await timelock.grantRole(EXECUTOR_ROLE, deployedContracts.SynapseGovernor);
    console.log("   ✅ Timelock roles configured");
    
    // Save deployment info
    console.log("\n💾 Saving deployment info...");
    const deploymentInfo = {
        network,
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        blockNumber: await hre.ethers.provider.getBlockNumber(),
        contracts: deployedContracts,
        config: CONFIG,
    };
    
    const deploymentsDir = path.join(__dirname, "..", "deployments");
    if (!fs.existsSync(deploymentsDir)) {
        fs.mkdirSync(deploymentsDir, { recursive: true });
    }
    
    const deploymentPath = path.join(deploymentsDir, `${network}.json`);
    fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
    console.log(`   ✅ Saved to ${deploymentPath}`);
    
    // Print summary
    console.log("\n");
    console.log("╔═══════════════════════════════════════════════════════════╗");
    console.log("║               DEPLOYMENT COMPLETE ✅                      ║");
    console.log("╚═══════════════════════════════════════════════════════════╝");
    console.log("");
    console.log("📋 Deployed Contracts:");
    console.log("─".repeat(60));
    for (const [name, address] of Object.entries(deployedContracts)) {
        console.log(`   ${name.padEnd(25)} ${address}`);
    }
    console.log("─".repeat(60));
    console.log("");
    
    // Verify contracts if not localhost
    if (network !== "localhost" && network !== "hardhat") {
        console.log("🔍 Verifying contracts on Etherscan...");
        console.log("   (This may take a few minutes)");
        console.log("");
        
        try {
            await verifyContracts(deployedContracts, CONFIG, deployer.address);
            console.log("   ✅ All contracts verified");
        } catch (error) {
            console.log(`   ⚠️  Verification failed: ${error.message}`);
            console.log("   You can verify manually later using:");
            console.log(`   npx hardhat verify --network ${network} <address> <args>`);
        }
    }
    
    console.log("");
    console.log("🚀 SYNAPSE Protocol is ready!");
    console.log("");
    
    return deployedContracts;
}

async function verifyContracts(contracts, config, deployer) {
    const verifications = [
        {
            address: contracts.SynapseToken,
            constructorArguments: [
                config.TOKEN.NAME,
                config.TOKEN.SYMBOL,
                config.TOKEN.INITIAL_SUPPLY,
                deployer,
                deployer,
            ],
        },
        {
            address: contracts.SynapseTimelock,
            constructorArguments: [
                config.GOVERNANCE.TIMELOCK_DELAY,
                [],
                [],
                deployer,
            ],
        },
        {
            address: contracts.SynapseGovernor,
            constructorArguments: [
                contracts.SynapseToken,
                contracts.SynapseTimelock,
            ],
        },
        {
            address: contracts.Treasury,
            constructorArguments: [
                contracts.SynapseGovernor,
                contracts.SynapseTimelock,
            ],
        },
        {
            address: contracts.ReputationRegistry,
            constructorArguments: [
                contracts.SynapseToken,
                config.REPUTATION.MIN_STAKE,
                config.REPUTATION.REGISTRATION_FEE,
            ],
        },
        {
            address: contracts.PaymentRouter,
            constructorArguments: [
                contracts.SynapseToken,
                contracts.ReputationRegistry,
                contracts.Treasury,
            ],
        },
        {
            address: contracts.PaymentChannel,
            constructorArguments: [
                contracts.SynapseToken,
                contracts.ReputationRegistry,
            ],
        },
        {
            address: contracts.ServiceRegistry,
            constructorArguments: [
                contracts.SynapseToken,
                contracts.ReputationRegistry,
                contracts.PaymentRouter,
            ],
        },
    ];
    
    for (const verification of verifications) {
        try {
            await hre.run("verify:verify", verification);
        } catch (error) {
            if (error.message.includes("Already Verified")) {
                console.log(`   ${verification.address} already verified`);
            } else {
                throw error;
            }
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

module.exports = { main, CONFIG };
