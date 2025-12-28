/**
 * SYNAPSE Protocol - Hardhat Tasks
 * 
 * Custom tasks for protocol management and operations
 */

const { task, subtask, types } = require("hardhat/config");
const fs = require("fs");
const path = require("path");

// ============ Deployment Tasks ============

task("deploy:all", "Deploy all contracts")
  .addParam("verify", "Verify on block explorer", false, types.boolean)
  .setAction(async (taskArgs, hre) => {
    console.log("\n🚀 Deploying SYNAPSE Protocol...\n");

    const [deployer] = await hre.ethers.getSigners();
    console.log(`Deployer: ${deployer.address}`);
    console.log(`Network: ${hre.network.name}`);
    console.log(`Balance: ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} ETH\n`);

    const deployments = {};

    // 1. Deploy Token
    console.log("1. Deploying SynapseToken...");
    const Token = await hre.ethers.getContractFactory("SynapseToken");
    const token = await Token.deploy(
      "SYNAPSE",
      "SYNX",
      hre.ethers.parseEther("1000000000"), // 1 billion
      deployer.address,
      deployer.address
    );
    await token.waitForDeployment();
    deployments.token = await token.getAddress();
    console.log(`   Token: ${deployments.token}`);

    // 2. Deploy PaymentRouter
    console.log("2. Deploying PaymentRouter...");
    const Router = await hre.ethers.getContractFactory("PaymentRouter");
    const router = await Router.deploy(deployments.token, deployer.address);
    await router.waitForDeployment();
    deployments.paymentRouter = await router.getAddress();
    console.log(`   PaymentRouter: ${deployments.paymentRouter}`);

    // 3. Deploy ReputationRegistry
    console.log("3. Deploying ReputationRegistry...");
    const Reputation = await hre.ethers.getContractFactory("ReputationRegistry");
    const reputation = await Reputation.deploy(deployments.token);
    await reputation.waitForDeployment();
    deployments.reputation = await reputation.getAddress();
    console.log(`   Reputation: ${deployments.reputation}`);

    // 4. Deploy ServiceRegistry
    console.log("4. Deploying ServiceRegistry...");
    const ServiceRegistry = await hre.ethers.getContractFactory("ServiceRegistry");
    const serviceRegistry = await ServiceRegistry.deploy(deployments.reputation);
    await serviceRegistry.waitForDeployment();
    deployments.serviceRegistry = await serviceRegistry.getAddress();
    console.log(`   ServiceRegistry: ${deployments.serviceRegistry}`);

    // 5. Deploy PaymentChannel
    console.log("5. Deploying PaymentChannel...");
    const Channel = await hre.ethers.getContractFactory("PaymentChannel");
    const channel = await Channel.deploy(deployments.token);
    await channel.waitForDeployment();
    deployments.paymentChannel = await channel.getAddress();
    console.log(`   PaymentChannel: ${deployments.paymentChannel}`);

    // 6. Deploy StakingRewards
    console.log("6. Deploying StakingRewards...");
    const Staking = await hre.ethers.getContractFactory("StakingRewards");
    const staking = await Staking.deploy(deployments.token);
    await staking.waitForDeployment();
    deployments.staking = await staking.getAddress();
    console.log(`   Staking: ${deployments.staking}`);

    // Save deployments
    const deploymentsPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
    fs.mkdirSync(path.dirname(deploymentsPath), { recursive: true });
    fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
    console.log(`\n✅ Deployments saved to ${deploymentsPath}`);

    // Verify if requested
    if (taskArgs.verify) {
      console.log("\n🔍 Verifying contracts...");
      await hre.run("verify:all", { network: hre.network.name });
    }

    console.log("\n✅ Deployment complete!\n");
    return deployments;
  });

task("verify:all", "Verify all deployed contracts")
  .setAction(async (taskArgs, hre) => {
    const deploymentsPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath));

    for (const [name, address] of Object.entries(deployments)) {
      try {
        console.log(`Verifying ${name}...`);
        await hre.run("verify:verify", { address });
        console.log(`✅ ${name} verified`);
      } catch (e) {
        console.log(`❌ ${name} verification failed: ${e.message}`);
      }
    }
  });

// ============ Token Tasks ============

task("token:info", "Get token information")
  .setAction(async (taskArgs, hre) => {
    const deployments = await hre.run("utils:load-deployments");
    const token = await hre.ethers.getContractAt("SynapseToken", deployments.token);

    console.log("\n📊 SYNX Token Info:");
    console.log(`   Name: ${await token.name()}`);
    console.log(`   Symbol: ${await token.symbol()}`);
    console.log(`   Decimals: ${await token.decimals()}`);
    console.log(`   Total Supply: ${hre.ethers.formatEther(await token.totalSupply())} SYNX`);
    console.log(`   Address: ${deployments.token}\n`);
  });

task("token:balance", "Get token balance for address")
  .addParam("address", "Address to check")
  .setAction(async (taskArgs, hre) => {
    const deployments = await hre.run("utils:load-deployments");
    const token = await hre.ethers.getContractAt("SynapseToken", deployments.token);

    const balance = await token.balanceOf(taskArgs.address);
    console.log(`Balance: ${hre.ethers.formatEther(balance)} SYNX`);
  });

task("token:transfer", "Transfer tokens")
  .addParam("to", "Recipient address")
  .addParam("amount", "Amount to transfer")
  .setAction(async (taskArgs, hre) => {
    const deployments = await hre.run("utils:load-deployments");
    const token = await hre.ethers.getContractAt("SynapseToken", deployments.token);

    const amount = hre.ethers.parseEther(taskArgs.amount);
    const tx = await token.transfer(taskArgs.to, amount);
    await tx.wait();

    console.log(`✅ Transferred ${taskArgs.amount} SYNX to ${taskArgs.to}`);
    console.log(`   TX: ${tx.hash}`);
  });

task("token:approve", "Approve token spending")
  .addParam("spender", "Spender address")
  .addParam("amount", "Amount to approve")
  .setAction(async (taskArgs, hre) => {
    const deployments = await hre.run("utils:load-deployments");
    const token = await hre.ethers.getContractAt("SynapseToken", deployments.token);

    const amount = taskArgs.amount === "max" 
      ? hre.ethers.MaxUint256 
      : hre.ethers.parseEther(taskArgs.amount);

    const tx = await token.approve(taskArgs.spender, amount);
    await tx.wait();

    console.log(`✅ Approved ${taskArgs.amount} SYNX for ${taskArgs.spender}`);
    console.log(`   TX: ${tx.hash}`);
  });

// ============ Admin Tasks ============

task("admin:pause", "Pause a contract")
  .addParam("contract", "Contract name")
  .setAction(async (taskArgs, hre) => {
    const deployments = await hre.run("utils:load-deployments");
    const address = deployments[taskArgs.contract];
    
    if (!address) {
      throw new Error(`Contract ${taskArgs.contract} not found`);
    }

    const contract = await hre.ethers.getContractAt("Pausable", address);
    const tx = await contract.pause();
    await tx.wait();

    console.log(`✅ Paused ${taskArgs.contract} at ${address}`);
  });

task("admin:unpause", "Unpause a contract")
  .addParam("contract", "Contract name")
  .setAction(async (taskArgs, hre) => {
    const deployments = await hre.run("utils:load-deployments");
    const address = deployments[taskArgs.contract];
    
    if (!address) {
      throw new Error(`Contract ${taskArgs.contract} not found`);
    }

    const contract = await hre.ethers.getContractAt("Pausable", address);
    const tx = await contract.unpause();
    await tx.wait();

    console.log(`✅ Unpaused ${taskArgs.contract} at ${address}`);
  });

task("admin:grant-role", "Grant role to address")
  .addParam("contract", "Contract name")
  .addParam("role", "Role name (ADMIN, PAUSER, etc.)")
  .addParam("account", "Account address")
  .setAction(async (taskArgs, hre) => {
    const deployments = await hre.run("utils:load-deployments");
    const address = deployments[taskArgs.contract];
    
    if (!address) {
      throw new Error(`Contract ${taskArgs.contract} not found`);
    }

    const contract = await hre.ethers.getContractAt("AccessControl", address);
    
    const roleHash = taskArgs.role === "DEFAULT_ADMIN" 
      ? hre.ethers.ZeroHash
      : hre.ethers.keccak256(hre.ethers.toUtf8Bytes(taskArgs.role));

    const tx = await contract.grantRole(roleHash, taskArgs.account);
    await tx.wait();

    console.log(`✅ Granted ${taskArgs.role} to ${taskArgs.account}`);
  });

task("admin:set-fee", "Set protocol fee")
  .addParam("contract", "Contract name")
  .addParam("fee", "Fee in basis points (e.g., 30 = 0.3%)")
  .setAction(async (taskArgs, hre) => {
    const deployments = await hre.run("utils:load-deployments");
    const address = deployments[taskArgs.contract];
    
    if (!address) {
      throw new Error(`Contract ${taskArgs.contract} not found`);
    }

    const contract = await hre.ethers.getContractAt("PaymentRouter", address);
    const tx = await contract.setProtocolFee(parseInt(taskArgs.fee));
    await tx.wait();

    console.log(`✅ Set fee to ${taskArgs.fee} basis points`);
  });

// ============ Staking Tasks ============

task("staking:info", "Get staking info")
  .setAction(async (taskArgs, hre) => {
    const deployments = await hre.run("utils:load-deployments");
    const staking = await hre.ethers.getContractAt("StakingRewards", deployments.staking);

    console.log("\n📊 Staking Info:");
    console.log(`   Total Staked: ${hre.ethers.formatEther(await staking.totalStaked())} SYNX`);
    console.log(`   Total Stakers: ${await staking.totalStakers()}`);
    console.log(`   APR: ${await staking.getAPR()}%`);
    console.log(`   Address: ${deployments.staking}\n`);
  });

task("staking:add-rewards", "Add staking rewards")
  .addParam("amount", "Amount of SYNX to add")
  .addParam("duration", "Duration in days")
  .setAction(async (taskArgs, hre) => {
    const deployments = await hre.run("utils:load-deployments");
    const token = await hre.ethers.getContractAt("SynapseToken", deployments.token);
    const staking = await hre.ethers.getContractAt("StakingRewards", deployments.staking);

    const amount = hre.ethers.parseEther(taskArgs.amount);
    const duration = parseInt(taskArgs.duration) * 86400;

    // Approve
    await (await token.approve(deployments.staking, amount)).wait();

    // Add rewards
    const tx = await staking.notifyRewardAmount(amount, duration);
    await tx.wait();

    console.log(`✅ Added ${taskArgs.amount} SYNX rewards for ${taskArgs.duration} days`);
  });

// ============ Analytics Tasks ============

task("analytics:protocol-stats", "Get protocol statistics")
  .setAction(async (taskArgs, hre) => {
    const deployments = await hre.run("utils:load-deployments");

    const token = await hre.ethers.getContractAt("SynapseToken", deployments.token);
    const router = await hre.ethers.getContractAt("PaymentRouter", deployments.paymentRouter);
    const staking = await hre.ethers.getContractAt("StakingRewards", deployments.staking);

    console.log("\n📊 SYNAPSE Protocol Statistics\n");
    console.log("Token:");
    console.log(`   Total Supply: ${hre.ethers.formatEther(await token.totalSupply())} SYNX`);

    console.log("\nPayments:");
    console.log(`   Total Volume: ${hre.ethers.formatEther(await router.totalVolume())} SYNX`);
    console.log(`   Total Fees: ${hre.ethers.formatEther(await router.totalFees())} SYNX`);

    console.log("\nStaking:");
    console.log(`   Total Staked: ${hre.ethers.formatEther(await staking.totalStaked())} SYNX`);
    console.log(`   Stakers: ${await staking.totalStakers()}`);

    console.log("");
  });

// ============ Utility Tasks ============

subtask("utils:load-deployments", "Load deployment addresses")
  .setAction(async (taskArgs, hre) => {
    const deploymentsPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
    
    if (!fs.existsSync(deploymentsPath)) {
      throw new Error(`No deployments found for network ${hre.network.name}`);
    }

    return JSON.parse(fs.readFileSync(deploymentsPath));
  });

task("utils:accounts", "Show available accounts")
  .setAction(async (taskArgs, hre) => {
    const accounts = await hre.ethers.getSigners();
    
    console.log("\n📋 Accounts:");
    for (let i = 0; i < Math.min(accounts.length, 10); i++) {
      const balance = await hre.ethers.provider.getBalance(accounts[i].address);
      console.log(`   [${i}] ${accounts[i].address} (${hre.ethers.formatEther(balance)} ETH)`);
    }
    console.log("");
  });

task("utils:gas-price", "Get current gas price")
  .setAction(async (taskArgs, hre) => {
    const feeData = await hre.ethers.provider.getFeeData();
    
    console.log("\n⛽ Gas Prices:");
    console.log(`   Gas Price: ${hre.ethers.formatUnits(feeData.gasPrice || 0, "gwei")} gwei`);
    console.log(`   Max Fee: ${hre.ethers.formatUnits(feeData.maxFeePerGas || 0, "gwei")} gwei`);
    console.log(`   Priority Fee: ${hre.ethers.formatUnits(feeData.maxPriorityFeePerGas || 0, "gwei")} gwei`);
    console.log("");
  });

task("utils:flatten", "Flatten contracts for verification")
  .addParam("contract", "Contract name")
  .setAction(async (taskArgs, hre) => {
    const outputPath = path.join(__dirname, "..", "flattened", `${taskArgs.contract}.sol`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const flattened = await hre.run("flatten:get-flattened-sources", {
      files: [`contracts/${taskArgs.contract}.sol`]
    });

    fs.writeFileSync(outputPath, flattened);
    console.log(`✅ Flattened to ${outputPath}`);
  });

task("utils:size", "Show contract sizes")
  .setAction(async (taskArgs, hre) => {
    await hre.run("compile");

    const contracts = [
      "SynapseToken",
      "PaymentRouter",
      "ReputationRegistry",
      "ServiceRegistry",
      "PaymentChannel",
      "StakingRewards",
      "SubscriptionManager",
      "TokenVesting",
      "SynapseBridge",
      "SynapseTreasury",
      "SynapseLiquidityPool"
    ];

    console.log("\n📏 Contract Sizes:\n");
    console.log("   Contract                   Size       Limit      %");
    console.log("   " + "-".repeat(60));

    for (const name of contracts) {
      try {
        const artifact = await hre.artifacts.readArtifact(name);
        const size = Buffer.from(artifact.deployedBytecode.slice(2), "hex").length;
        const limit = 24576; // 24KB
        const percent = ((size / limit) * 100).toFixed(1);
        const bar = percent > 100 ? "⚠️" : percent > 80 ? "🟡" : "🟢";

        console.log(`   ${bar} ${name.padEnd(25)} ${(size / 1024).toFixed(2).padStart(6)} KB   ${(limit / 1024).toFixed(2)} KB   ${percent.padStart(5)}%`);
      } catch (e) {
        // Contract not found, skip
      }
    }

    console.log("");
  });

module.exports = {};
