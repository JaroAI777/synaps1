#!/usr/bin/env node

/**
 * SYNAPSE Protocol CLI
 * 
 * Command-line interface for interacting with SYNAPSE Protocol
 * Features:
 * - Wallet management
 * - Token operations
 * - Payment operations
 * - Staking management
 * - Agent/Service management
 * - Protocol analytics
 */

const { Command } = require('commander');
const { ethers } = require('ethers');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const Table = require('cli-table3');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuration
const CONFIG_DIR = path.join(os.homedir(), '.synapse');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const KEYSTORE_FILE = path.join(CONFIG_DIR, 'keystore.json');

// Network configurations
const NETWORKS = {
  'arbitrum-one': {
    name: 'Arbitrum One',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    chainId: 42161,
    explorer: 'https://arbiscan.io'
  },
  'arbitrum-sepolia': {
    name: 'Arbitrum Sepolia',
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    chainId: 421614,
    explorer: 'https://sepolia.arbiscan.io'
  }
};

// Contract ABIs (minimal)
const TOKEN_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)'
];

const ROUTER_ABI = [
  'function pay(address recipient, uint256 amount, string metadata) returns (bytes32)',
  'function batchPay(address[] recipients, uint256[] amounts, string metadata)',
  'function createEscrow(address recipient, address arbiter, uint256 amount, uint256 deadline) returns (bytes32)',
  'function releaseEscrow(bytes32 escrowId)',
  'function getEscrow(bytes32 escrowId) view returns (tuple(address sender, address recipient, address arbiter, uint256 amount, uint256 deadline, uint8 status))'
];

const STAKING_ABI = [
  'function stake(uint256 amount, uint256 lockTierId)',
  'function unstake(uint256 amount)',
  'function claimRewards()',
  'function compound()',
  'function getStakeInfo(address user) view returns (tuple(uint256 amount, uint256 lockTierId, uint256 lockUntil, uint256 rewardDebt))',
  'function earned(address user) view returns (uint256)',
  'function totalStaked() view returns (uint256)'
];

// CLI Program
const program = new Command();

program
  .name('synapse')
  .description('SYNAPSE Protocol CLI')
  .version('1.0.0');

// ============================================
// Configuration Commands
// ============================================

program
  .command('init')
  .description('Initialize CLI configuration')
  .action(async () => {
    const spinner = ora('Initializing...').start();

    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }

      const answers = await inquirer.prompt([
        {
          type: 'list',
          name: 'network',
          message: 'Select network:',
          choices: Object.entries(NETWORKS).map(([id, net]) => ({
            name: net.name,
            value: id
          }))
        },
        {
          type: 'input',
          name: 'tokenAddress',
          message: 'SYNX Token address:',
          validate: (v) => ethers.isAddress(v) || 'Invalid address'
        },
        {
          type: 'input',
          name: 'routerAddress',
          message: 'Payment Router address:',
          validate: (v) => ethers.isAddress(v) || 'Invalid address'
        },
        {
          type: 'input',
          name: 'stakingAddress',
          message: 'Staking contract address:',
          validate: (v) => ethers.isAddress(v) || 'Invalid address'
        }
      ]);

      const config = {
        network: answers.network,
        contracts: {
          token: answers.tokenAddress,
          router: answers.routerAddress,
          staking: answers.stakingAddress
        }
      };

      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      
      spinner.succeed('Configuration saved!');
      console.log(chalk.dim(`Config file: ${CONFIG_FILE}`));
    } catch (error) {
      spinner.fail('Initialization failed');
      console.error(chalk.red(error.message));
    }
  });

program
  .command('config')
  .description('Show current configuration')
  .action(() => {
    if (!fs.existsSync(CONFIG_FILE)) {
      console.log(chalk.yellow('No configuration found. Run: synapse init'));
      return;
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE));
    const network = NETWORKS[config.network];

    console.log(chalk.bold('\n📋 Current Configuration\n'));
    console.log(`Network:    ${chalk.cyan(network.name)}`);
    console.log(`Chain ID:   ${chalk.dim(network.chainId)}`);
    console.log(`RPC URL:    ${chalk.dim(network.rpcUrl)}`);
    console.log(`\nContracts:`);
    console.log(`  Token:    ${chalk.green(config.contracts.token)}`);
    console.log(`  Router:   ${chalk.green(config.contracts.router)}`);
    console.log(`  Staking:  ${chalk.green(config.contracts.staking)}`);
  });

// ============================================
// Wallet Commands
// ============================================

const wallet = program.command('wallet').description('Wallet management');

wallet
  .command('create')
  .description('Create a new wallet')
  .action(async () => {
    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'password',
        message: 'Enter password to encrypt wallet:',
        validate: (v) => v.length >= 8 || 'Password must be at least 8 characters'
      },
      {
        type: 'password',
        name: 'confirm',
        message: 'Confirm password:',
        validate: (v, a) => v === a.password || 'Passwords do not match'
      }
    ]);

    const spinner = ora('Creating wallet...').start();

    try {
      const newWallet = ethers.Wallet.createRandom();
      const encrypted = await newWallet.encrypt(answers.password);

      fs.writeFileSync(KEYSTORE_FILE, encrypted);

      spinner.succeed('Wallet created!');
      console.log(chalk.bold('\n🔑 Wallet Details\n'));
      console.log(`Address:    ${chalk.green(newWallet.address)}`);
      console.log(`\n${chalk.yellow('⚠️  IMPORTANT: Save your mnemonic phrase!')}`);
      console.log(chalk.dim(newWallet.mnemonic.phrase));
      console.log(chalk.dim(`\nKeystore saved to: ${KEYSTORE_FILE}`));
    } catch (error) {
      spinner.fail('Failed to create wallet');
      console.error(chalk.red(error.message));
    }
  });

wallet
  .command('import')
  .description('Import wallet from private key or mnemonic')
  .action(async () => {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'type',
        message: 'Import from:',
        choices: ['Private Key', 'Mnemonic Phrase']
      },
      {
        type: 'password',
        name: 'secret',
        message: (a) => a.type === 'Private Key' ? 'Enter private key:' : 'Enter mnemonic phrase:'
      },
      {
        type: 'password',
        name: 'password',
        message: 'Enter password to encrypt wallet:',
        validate: (v) => v.length >= 8 || 'Password must be at least 8 characters'
      }
    ]);

    const spinner = ora('Importing wallet...').start();

    try {
      let importedWallet;
      if (answers.type === 'Private Key') {
        importedWallet = new ethers.Wallet(answers.secret);
      } else {
        importedWallet = ethers.Wallet.fromPhrase(answers.secret);
      }

      const encrypted = await importedWallet.encrypt(answers.password);
      fs.writeFileSync(KEYSTORE_FILE, encrypted);

      spinner.succeed('Wallet imported!');
      console.log(`Address: ${chalk.green(importedWallet.address)}`);
    } catch (error) {
      spinner.fail('Failed to import wallet');
      console.error(chalk.red(error.message));
    }
  });

wallet
  .command('address')
  .description('Show wallet address')
  .action(async () => {
    const wallet = await loadWallet();
    if (wallet) {
      console.log(`Address: ${chalk.green(wallet.address)}`);
    }
  });

wallet
  .command('balance')
  .description('Show wallet balances')
  .action(async () => {
    const wallet = await loadWallet();
    if (!wallet) return;

    const config = loadConfig();
    const provider = getProvider(config);
    const connectedWallet = wallet.connect(provider);

    const spinner = ora('Fetching balances...').start();

    try {
      const [ethBalance, tokenBalance] = await Promise.all([
        provider.getBalance(wallet.address),
        getTokenBalance(config.contracts.token, wallet.address, provider)
      ]);

      spinner.stop();

      console.log(chalk.bold('\n💰 Wallet Balances\n'));
      console.log(`ETH:   ${chalk.cyan(ethers.formatEther(ethBalance))} ETH`);
      console.log(`SYNX:  ${chalk.cyan(ethers.formatEther(tokenBalance))} SYNX`);
    } catch (error) {
      spinner.fail('Failed to fetch balances');
      console.error(chalk.red(error.message));
    }
  });

// ============================================
// Token Commands
// ============================================

const token = program.command('token').description('Token operations');

token
  .command('info')
  .description('Show token information')
  .action(async () => {
    const config = loadConfig();
    const provider = getProvider(config);
    const tokenContract = new ethers.Contract(config.contracts.token, TOKEN_ABI, provider);

    const spinner = ora('Fetching token info...').start();

    try {
      const [name, symbol, decimals, totalSupply] = await Promise.all([
        tokenContract.name(),
        tokenContract.symbol(),
        tokenContract.decimals(),
        tokenContract.totalSupply()
      ]);

      spinner.stop();

      console.log(chalk.bold('\n🪙 Token Information\n'));
      console.log(`Name:          ${chalk.cyan(name)}`);
      console.log(`Symbol:        ${chalk.cyan(symbol)}`);
      console.log(`Decimals:      ${decimals}`);
      console.log(`Total Supply:  ${ethers.formatUnits(totalSupply, decimals)} ${symbol}`);
      console.log(`Address:       ${chalk.dim(config.contracts.token)}`);
    } catch (error) {
      spinner.fail('Failed to fetch token info');
      console.error(chalk.red(error.message));
    }
  });

token
  .command('transfer <to> <amount>')
  .description('Transfer tokens')
  .action(async (to, amount) => {
    const wallet = await loadWallet(true);
    if (!wallet) return;

    const config = loadConfig();
    const provider = getProvider(config);
    const connectedWallet = wallet.connect(provider);
    const tokenContract = new ethers.Contract(config.contracts.token, TOKEN_ABI, connectedWallet);

    const spinner = ora('Sending transaction...').start();

    try {
      const tx = await tokenContract.transfer(to, ethers.parseEther(amount));
      spinner.text = 'Waiting for confirmation...';
      const receipt = await tx.wait();

      spinner.succeed('Transfer complete!');
      console.log(`TX Hash: ${chalk.green(receipt.hash)}`);
    } catch (error) {
      spinner.fail('Transfer failed');
      console.error(chalk.red(error.message));
    }
  });

// ============================================
// Payment Commands
// ============================================

const pay = program.command('pay').description('Payment operations');

pay
  .command('send <to> <amount>')
  .description('Send payment')
  .option('-m, --metadata <text>', 'Payment metadata')
  .action(async (to, amount, options) => {
    const wallet = await loadWallet(true);
    if (!wallet) return;

    const config = loadConfig();
    const provider = getProvider(config);
    const connectedWallet = wallet.connect(provider);
    
    const tokenContract = new ethers.Contract(config.contracts.token, TOKEN_ABI, connectedWallet);
    const routerContract = new ethers.Contract(config.contracts.router, ROUTER_ABI, connectedWallet);

    const spinner = ora('Processing payment...').start();

    try {
      // Approve
      spinner.text = 'Approving tokens...';
      const approveTx = await tokenContract.approve(config.contracts.router, ethers.parseEther(amount));
      await approveTx.wait();

      // Send payment
      spinner.text = 'Sending payment...';
      const tx = await routerContract.pay(to, ethers.parseEther(amount), options.metadata || '');
      const receipt = await tx.wait();

      spinner.succeed('Payment sent!');
      console.log(`Amount:  ${chalk.cyan(amount)} SYNX`);
      console.log(`To:      ${chalk.dim(to)}`);
      console.log(`TX Hash: ${chalk.green(receipt.hash)}`);
    } catch (error) {
      spinner.fail('Payment failed');
      console.error(chalk.red(error.message));
    }
  });

// ============================================
// Staking Commands
// ============================================

const staking = program.command('staking').description('Staking operations');

staking
  .command('info')
  .description('Show staking information')
  .action(async () => {
    const wallet = await loadWallet();
    const config = loadConfig();
    const provider = getProvider(config);
    const stakingContract = new ethers.Contract(config.contracts.staking, STAKING_ABI, provider);

    const spinner = ora('Fetching staking info...').start();

    try {
      const totalStaked = await stakingContract.totalStaked();

      spinner.stop();

      console.log(chalk.bold('\n📊 Staking Information\n'));
      console.log(`Total Staked:  ${chalk.cyan(ethers.formatEther(totalStaked))} SYNX`);

      if (wallet) {
        const [stakeInfo, earned] = await Promise.all([
          stakingContract.getStakeInfo(wallet.address),
          stakingContract.earned(wallet.address)
        ]);

        console.log(`\n${chalk.bold('Your Position:')}`);
        console.log(`  Staked:   ${chalk.cyan(ethers.formatEther(stakeInfo.amount))} SYNX`);
        console.log(`  Earned:   ${chalk.green(ethers.formatEther(earned))} SYNX`);
        console.log(`  Lock Tier: ${stakeInfo.lockTierId}`);
        
        if (stakeInfo.lockUntil > 0) {
          const lockDate = new Date(Number(stakeInfo.lockUntil) * 1000);
          console.log(`  Lock Until: ${lockDate.toLocaleDateString()}`);
        }
      }
    } catch (error) {
      spinner.fail('Failed to fetch staking info');
      console.error(chalk.red(error.message));
    }
  });

staking
  .command('stake <amount>')
  .description('Stake tokens')
  .option('-t, --tier <tier>', 'Lock tier (0-4)', '0')
  .action(async (amount, options) => {
    const wallet = await loadWallet(true);
    if (!wallet) return;

    const config = loadConfig();
    const provider = getProvider(config);
    const connectedWallet = wallet.connect(provider);
    
    const tokenContract = new ethers.Contract(config.contracts.token, TOKEN_ABI, connectedWallet);
    const stakingContract = new ethers.Contract(config.contracts.staking, STAKING_ABI, connectedWallet);

    const spinner = ora('Processing stake...').start();

    try {
      // Approve
      spinner.text = 'Approving tokens...';
      const approveTx = await tokenContract.approve(config.contracts.staking, ethers.parseEther(amount));
      await approveTx.wait();

      // Stake
      spinner.text = 'Staking tokens...';
      const tx = await stakingContract.stake(ethers.parseEther(amount), parseInt(options.tier));
      const receipt = await tx.wait();

      spinner.succeed('Tokens staked!');
      console.log(`Amount:  ${chalk.cyan(amount)} SYNX`);
      console.log(`Tier:    ${options.tier}`);
      console.log(`TX Hash: ${chalk.green(receipt.hash)}`);
    } catch (error) {
      spinner.fail('Staking failed');
      console.error(chalk.red(error.message));
    }
  });

staking
  .command('claim')
  .description('Claim staking rewards')
  .action(async () => {
    const wallet = await loadWallet(true);
    if (!wallet) return;

    const config = loadConfig();
    const provider = getProvider(config);
    const connectedWallet = wallet.connect(provider);
    const stakingContract = new ethers.Contract(config.contracts.staking, STAKING_ABI, connectedWallet);

    const spinner = ora('Claiming rewards...').start();

    try {
      const tx = await stakingContract.claimRewards();
      const receipt = await tx.wait();

      spinner.succeed('Rewards claimed!');
      console.log(`TX Hash: ${chalk.green(receipt.hash)}`);
    } catch (error) {
      spinner.fail('Claim failed');
      console.error(chalk.red(error.message));
    }
  });

// ============================================
// Helper Functions
// ============================================

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.log(chalk.yellow('No configuration found. Run: synapse init'));
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE));
}

function getProvider(config) {
  const network = NETWORKS[config.network];
  return new ethers.JsonRpcProvider(network.rpcUrl);
}

async function loadWallet(requirePassword = false) {
  if (!fs.existsSync(KEYSTORE_FILE)) {
    console.log(chalk.yellow('No wallet found. Run: synapse wallet create'));
    return null;
  }

  const keystore = fs.readFileSync(KEYSTORE_FILE, 'utf8');

  if (requirePassword) {
    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'password',
        message: 'Enter wallet password:'
      }
    ]);

    try {
      return await ethers.Wallet.fromEncryptedJson(keystore, answers.password);
    } catch (error) {
      console.log(chalk.red('Invalid password'));
      return null;
    }
  }

  // Return address only
  const parsed = JSON.parse(keystore);
  return { address: ethers.getAddress('0x' + parsed.address) };
}

async function getTokenBalance(tokenAddress, userAddress, provider) {
  const contract = new ethers.Contract(tokenAddress, TOKEN_ABI, provider);
  return await contract.balanceOf(userAddress);
}

// ============================================
// Run CLI
// ============================================

program.parse(process.argv);

// Show help if no command
if (!process.argv.slice(2).length) {
  console.log(chalk.bold('\n🔗 SYNAPSE Protocol CLI\n'));
  program.outputHelp();
}
