#!/usr/bin/env node

/**
 * SYNAPSE Protocol CLI
 * Command-line interface for interacting with SYNAPSE Protocol
 * 
 * Usage:
 *   synapse --help
 *   synapse balance 0x...
 *   synapse pay 0x... 10.5
 *   synapse agent register "MyAgent" 100
 */

const { Command } = require('commander');
const { ethers } = require('ethers');
const chalk = require('chalk');
const ora = require('ora');
const Table = require('cli-table3');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Package info
const pkg = require('./package.json');

// Config file path
const CONFIG_PATH = path.join(os.homedir(), '.synapse', 'config.json');

// Contract ABIs (simplified)
const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
  "function approve(address, uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

const PAYMENT_ROUTER_ABI = [
  "function pay(address, uint256, bytes32, bytes) returns (bool)",
  "function createEscrow(address, address, uint256, uint256, bytes32, bytes) returns (bytes32)",
  "function releaseEscrow(bytes32) returns (bool)",
  "function baseFeeBps() view returns (uint256)"
];

const REPUTATION_ABI = [
  "function registerAgent(string, string, uint256) returns (bool)",
  "function agents(address) view returns (bool, string, uint256, uint256, uint256, uint256, uint256)",
  "function getTier(address) view returns (uint8)",
  "function getSuccessRate(address) view returns (uint256)"
];

const SERVICE_REGISTRY_ABI = [
  "function registerService(string, string, string, string, uint256, uint8) returns (bytes32)",
  "function services(bytes32) view returns (address, string, string, string, string, uint256, uint8, bool, uint256)",
  "function getServicesByCategory(string) view returns (bytes32[])"
];

// Tier names
const TIER_NAMES = ['Unverified', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];

// Network configs
const NETWORKS = {
  mainnet: {
    name: 'Ethereum Mainnet',
    rpc: 'https://eth.llamarpc.com',
    chainId: 1
  },
  arbitrum: {
    name: 'Arbitrum One',
    rpc: 'https://arb1.arbitrum.io/rpc',
    chainId: 42161
  },
  sepolia: {
    name: 'Sepolia Testnet',
    rpc: 'https://rpc.sepolia.org',
    chainId: 11155111
  },
  'arbitrum-sepolia': {
    name: 'Arbitrum Sepolia',
    rpc: 'https://sepolia-rollup.arbitrum.io/rpc',
    chainId: 421614
  },
  localhost: {
    name: 'Localhost',
    rpc: 'http://127.0.0.1:8545',
    chainId: 31337
  }
};

// Helper functions
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getProvider(network) {
  const net = NETWORKS[network];
  if (!net) {
    throw new Error(`Unknown network: ${network}`);
  }
  return new ethers.JsonRpcProvider(net.rpc);
}

function getSigner(network, privateKey) {
  const provider = getProvider(network);
  return new ethers.Wallet(privateKey, provider);
}

function formatSYNX(wei) {
  return ethers.formatEther(wei);
}

function parseSYNX(amount) {
  return ethers.parseEther(amount);
}

function success(message) {
  console.log(chalk.green('✓ ') + message);
}

function error(message) {
  console.log(chalk.red('✗ ') + message);
}

function info(message) {
  console.log(chalk.blue('ℹ ') + message);
}

function warning(message) {
  console.log(chalk.yellow('⚠ ') + message);
}

// Create CLI program
const program = new Command();

program
  .name('synapse')
  .description('SYNAPSE Protocol CLI - AI-to-AI Payment Infrastructure')
  .version(pkg.version);

// Global options
program
  .option('-n, --network <network>', 'Network to use', 'arbitrum-sepolia')
  .option('-k, --key <privateKey>', 'Private key (or set SYNAPSE_PRIVATE_KEY env)')
  .option('-v, --verbose', 'Verbose output');

// ==================== Config Commands ====================

program
  .command('config')
  .description('Manage CLI configuration')
  .option('--set-key <key>', 'Set default private key')
  .option('--set-network <network>', 'Set default network')
  .option('--set-contracts <json>', 'Set contract addresses (JSON)')
  .option('--show', 'Show current configuration')
  .action((options) => {
    const config = loadConfig();
    
    if (options.setKey) {
      config.privateKey = options.setKey;
      saveConfig(config);
      success('Private key saved');
    }
    
    if (options.setNetwork) {
      if (!NETWORKS[options.setNetwork]) {
        error(`Unknown network: ${options.setNetwork}`);
        console.log('Available networks:', Object.keys(NETWORKS).join(', '));
        return;
      }
      config.network = options.setNetwork;
      saveConfig(config);
      success(`Default network set to ${options.setNetwork}`);
    }
    
    if (options.setContracts) {
      try {
        config.contracts = JSON.parse(options.setContracts);
        saveConfig(config);
        success('Contract addresses saved');
      } catch (e) {
        error('Invalid JSON for contracts');
      }
    }
    
    if (options.show) {
      console.log('\n' + chalk.bold('SYNAPSE CLI Configuration'));
      console.log('─'.repeat(40));
      console.log(`Config file: ${CONFIG_PATH}`);
      console.log(`Network: ${config.network || 'not set'}`);
      console.log(`Private key: ${config.privateKey ? '****' + config.privateKey.slice(-4) : 'not set'}`);
      if (config.contracts) {
        console.log('Contracts:');
        Object.entries(config.contracts).forEach(([name, addr]) => {
          console.log(`  ${name}: ${addr}`);
        });
      }
      console.log();
    }
  });

// ==================== Balance Commands ====================

program
  .command('balance [address]')
  .description('Check SYNX token balance')
  .action(async (address, options, command) => {
    const opts = command.parent.opts();
    const config = loadConfig();
    const network = opts.network || config.network || 'arbitrum-sepolia';
    
    const spinner = ora('Fetching balance...').start();
    
    try {
      const provider = getProvider(network);
      
      // Get address
      let checkAddress = address;
      if (!checkAddress) {
        const privateKey = opts.key || config.privateKey || process.env.SYNAPSE_PRIVATE_KEY;
        if (privateKey) {
          const wallet = new ethers.Wallet(privateKey);
          checkAddress = wallet.address;
        } else {
          spinner.fail('No address provided');
          return;
        }
      }
      
      // Get contract address
      const tokenAddress = config.contracts?.token;
      if (!tokenAddress) {
        spinner.fail('Token contract address not configured. Run: synapse config --set-contracts \'{"token":"0x..."}\'');
        return;
      }
      
      const token = new ethers.Contract(tokenAddress, TOKEN_ABI, provider);
      const balance = await token.balanceOf(checkAddress);
      const symbol = await token.symbol();
      
      // Also get ETH balance
      const ethBalance = await provider.getBalance(checkAddress);
      
      spinner.stop();
      
      console.log();
      console.log(chalk.bold('Account Balance'));
      console.log('─'.repeat(40));
      console.log(`Address: ${checkAddress}`);
      console.log(`Network: ${NETWORKS[network].name}`);
      console.log();
      console.log(`${symbol}: ${chalk.green(formatSYNX(balance))}`);
      console.log(`ETH:  ${chalk.blue(formatSYNX(ethBalance))}`);
      console.log();
      
    } catch (e) {
      spinner.fail(`Error: ${e.message}`);
    }
  });

// ==================== Payment Commands ====================

program
  .command('pay <recipient> <amount>')
  .description('Send SYNX payment to an address')
  .option('-m, --metadata <data>', 'Payment metadata (hex)')
  .action(async (recipient, amount, options, command) => {
    const opts = command.parent.opts();
    const config = loadConfig();
    const network = opts.network || config.network || 'arbitrum-sepolia';
    const privateKey = opts.key || config.privateKey || process.env.SYNAPSE_PRIVATE_KEY;
    
    if (!privateKey) {
      error('Private key required. Use --key or set SYNAPSE_PRIVATE_KEY');
      return;
    }
    
    const routerAddress = config.contracts?.paymentRouter;
    if (!routerAddress) {
      error('PaymentRouter contract address not configured');
      return;
    }
    
    // Confirm payment
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Send ${amount} SYNX to ${recipient}?`,
      default: false
    }]);
    
    if (!confirm) {
      info('Payment cancelled');
      return;
    }
    
    const spinner = ora('Sending payment...').start();
    
    try {
      const signer = getSigner(network, privateKey);
      const router = new ethers.Contract(routerAddress, PAYMENT_ROUTER_ABI, signer);
      
      // Generate payment ID
      const paymentId = ethers.keccak256(ethers.toUtf8Bytes(`pay-${Date.now()}`));
      const metadata = options.metadata || '0x';
      
      // Send payment
      const tx = await router.pay(recipient, parseSYNX(amount), paymentId, metadata);
      spinner.text = 'Waiting for confirmation...';
      const receipt = await tx.wait();
      
      spinner.succeed('Payment sent!');
      console.log();
      console.log(`Transaction: ${chalk.cyan(receipt.hash)}`);
      console.log(`Payment ID:  ${chalk.cyan(paymentId)}`);
      console.log(`Gas used:    ${receipt.gasUsed.toString()}`);
      console.log();
      
    } catch (e) {
      spinner.fail(`Error: ${e.message}`);
    }
  });

program
  .command('batch-pay <file>')
  .description('Send batch payments from JSON file')
  .action(async (file, options, command) => {
    const opts = command.parent.opts();
    const config = loadConfig();
    
    try {
      const payments = JSON.parse(fs.readFileSync(file, 'utf8'));
      
      console.log(`\nLoaded ${payments.length} payments:`);
      const table = new Table({
        head: ['Recipient', 'Amount (SYNX)']
      });
      
      let total = 0n;
      payments.forEach(p => {
        table.push([p.recipient, p.amount]);
        total += parseSYNX(p.amount);
      });
      
      console.log(table.toString());
      console.log(`Total: ${formatSYNX(total)} SYNX\n`);
      
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: 'Send batch payment?',
        default: false
      }]);
      
      if (!confirm) {
        info('Batch payment cancelled');
        return;
      }
      
      // TODO: Implement batch payment
      warning('Batch payment not yet implemented in CLI');
      
    } catch (e) {
      error(`Error: ${e.message}`);
    }
  });

// ==================== Agent Commands ====================

const agentCmd = program
  .command('agent')
  .description('Agent management commands');

agentCmd
  .command('info [address]')
  .description('Get agent information')
  .action(async (address, options, command) => {
    const opts = command.parent.parent.opts();
    const config = loadConfig();
    const network = opts.network || config.network || 'arbitrum-sepolia';
    
    const spinner = ora('Fetching agent info...').start();
    
    try {
      const provider = getProvider(network);
      
      // Get address
      let checkAddress = address;
      if (!checkAddress) {
        const privateKey = opts.key || config.privateKey || process.env.SYNAPSE_PRIVATE_KEY;
        if (privateKey) {
          checkAddress = new ethers.Wallet(privateKey).address;
        } else {
          spinner.fail('No address provided');
          return;
        }
      }
      
      const reputationAddress = config.contracts?.reputation;
      if (!reputationAddress) {
        spinner.fail('Reputation contract not configured');
        return;
      }
      
      const reputation = new ethers.Contract(reputationAddress, REPUTATION_ABI, provider);
      const agent = await reputation.agents(checkAddress);
      const tier = await reputation.getTier(checkAddress);
      const successRate = await reputation.getSuccessRate(checkAddress);
      
      spinner.stop();
      
      if (!agent[0]) {
        warning(`Address ${checkAddress} is not a registered agent`);
        return;
      }
      
      console.log();
      console.log(chalk.bold('Agent Information'));
      console.log('─'.repeat(50));
      console.log(`Address:      ${checkAddress}`);
      console.log(`Name:         ${agent[1]}`);
      console.log(`Stake:        ${formatSYNX(agent[2])} SYNX`);
      console.log(`Reputation:   ${agent[3].toString()}/1000`);
      console.log(`Tier:         ${chalk.cyan(TIER_NAMES[tier])} (${tier})`);
      console.log(`Transactions: ${agent[4].toString()}`);
      console.log(`Successful:   ${agent[5].toString()}`);
      console.log(`Success Rate: ${(Number(successRate) / 100).toFixed(2)}%`);
      console.log(`Registered:   ${new Date(Number(agent[6]) * 1000).toISOString()}`);
      console.log();
      
    } catch (e) {
      spinner.fail(`Error: ${e.message}`);
    }
  });

agentCmd
  .command('register <name> <stake>')
  .description('Register as an AI agent')
  .option('-u, --uri <metadataUri>', 'IPFS metadata URI')
  .action(async (name, stake, options, command) => {
    const opts = command.parent.parent.opts();
    const config = loadConfig();
    const network = opts.network || config.network || 'arbitrum-sepolia';
    const privateKey = opts.key || config.privateKey || process.env.SYNAPSE_PRIVATE_KEY;
    
    if (!privateKey) {
      error('Private key required');
      return;
    }
    
    const reputationAddress = config.contracts?.reputation;
    if (!reputationAddress) {
      error('Reputation contract not configured');
      return;
    }
    
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Register agent "${name}" with ${stake} SYNX stake?`,
      default: false
    }]);
    
    if (!confirm) {
      info('Registration cancelled');
      return;
    }
    
    const spinner = ora('Registering agent...').start();
    
    try {
      const signer = getSigner(network, privateKey);
      const reputation = new ethers.Contract(reputationAddress, REPUTATION_ABI, signer);
      
      const tx = await reputation.registerAgent(name, options.uri || '', parseSYNX(stake));
      spinner.text = 'Waiting for confirmation...';
      await tx.wait();
      
      spinner.succeed('Agent registered!');
      console.log(`\nWelcome to SYNAPSE Protocol, ${chalk.cyan(name)}!`);
      
    } catch (e) {
      spinner.fail(`Error: ${e.message}`);
    }
  });

// ==================== Service Commands ====================

const serviceCmd = program
  .command('service')
  .description('Service registry commands');

serviceCmd
  .command('list [category]')
  .description('List services')
  .action(async (category, options, command) => {
    const opts = command.parent.parent.opts();
    const config = loadConfig();
    const network = opts.network || config.network || 'arbitrum-sepolia';
    
    const spinner = ora('Fetching services...').start();
    
    try {
      const provider = getProvider(network);
      const registryAddress = config.contracts?.serviceRegistry;
      
      if (!registryAddress) {
        spinner.fail('ServiceRegistry contract not configured');
        return;
      }
      
      const registry = new ethers.Contract(registryAddress, SERVICE_REGISTRY_ABI, provider);
      
      const cat = category || 'language_model';
      const serviceIds = await registry.getServicesByCategory(cat);
      
      spinner.stop();
      
      if (serviceIds.length === 0) {
        info(`No services found in category: ${cat}`);
        return;
      }
      
      console.log();
      console.log(chalk.bold(`Services in "${cat}"`));
      console.log('─'.repeat(60));
      
      for (const id of serviceIds.slice(0, 10)) {
        const service = await registry.services(id);
        if (service[7]) { // active
          console.log(`\n${chalk.cyan(service[1])}`);
          console.log(`  Provider: ${service[0]}`);
          console.log(`  Price:    ${formatSYNX(service[5])} SYNX`);
          console.log(`  Endpoint: ${service[4]}`);
        }
      }
      
      console.log();
      
    } catch (e) {
      spinner.fail(`Error: ${e.message}`);
    }
  });

serviceCmd
  .command('register')
  .description('Register a new service (interactive)')
  .action(async (options, command) => {
    const opts = command.parent.parent.opts();
    const config = loadConfig();
    const network = opts.network || config.network || 'arbitrum-sepolia';
    const privateKey = opts.key || config.privateKey || process.env.SYNAPSE_PRIVATE_KEY;
    
    if (!privateKey) {
      error('Private key required');
      return;
    }
    
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Service name:',
        validate: v => v.length > 0
      },
      {
        type: 'list',
        name: 'category',
        message: 'Category:',
        choices: [
          'language_model',
          'image_generation',
          'code_generation',
          'translation',
          'data_analysis',
          'reasoning',
          'embedding',
          'speech',
          'vision',
          'multimodal',
          'agent',
          'tool'
        ]
      },
      {
        type: 'input',
        name: 'description',
        message: 'Description:'
      },
      {
        type: 'input',
        name: 'endpoint',
        message: 'API endpoint URL:',
        validate: v => v.startsWith('http')
      },
      {
        type: 'input',
        name: 'price',
        message: 'Base price (SYNX):',
        default: '0.001'
      },
      {
        type: 'list',
        name: 'pricingModel',
        message: 'Pricing model:',
        choices: [
          { name: 'Per Request', value: 0 },
          { name: 'Per Token', value: 1 },
          { name: 'Per Second', value: 2 },
          { name: 'Per Byte', value: 3 },
          { name: 'Subscription', value: 4 }
        ]
      }
    ]);
    
    const spinner = ora('Registering service...').start();
    
    try {
      const signer = getSigner(network, privateKey);
      const registryAddress = config.contracts?.serviceRegistry;
      const registry = new ethers.Contract(registryAddress, SERVICE_REGISTRY_ABI, signer);
      
      const tx = await registry.registerService(
        answers.name,
        answers.category,
        answers.description,
        answers.endpoint,
        parseSYNX(answers.price),
        answers.pricingModel
      );
      
      spinner.text = 'Waiting for confirmation...';
      const receipt = await tx.wait();
      
      spinner.succeed('Service registered!');
      console.log(`\nTransaction: ${receipt.hash}`);
      
    } catch (e) {
      spinner.fail(`Error: ${e.message}`);
    }
  });

// ==================== Network Commands ====================

program
  .command('networks')
  .description('List available networks')
  .action(() => {
    console.log('\n' + chalk.bold('Available Networks'));
    console.log('─'.repeat(50));
    
    const table = new Table({
      head: ['Name', 'Chain ID', 'RPC URL']
    });
    
    Object.entries(NETWORKS).forEach(([key, net]) => {
      table.push([key, net.chainId, net.rpc]);
    });
    
    console.log(table.toString());
    console.log();
  });

program
  .command('status')
  .description('Check network and contract status')
  .action(async (options, command) => {
    const opts = command.parent.opts();
    const config = loadConfig();
    const network = opts.network || config.network || 'arbitrum-sepolia';
    
    const spinner = ora('Checking status...').start();
    
    try {
      const provider = getProvider(network);
      const blockNumber = await provider.getBlockNumber();
      const gasPrice = await provider.getFeeData();
      
      spinner.stop();
      
      console.log();
      console.log(chalk.bold('Network Status'));
      console.log('─'.repeat(40));
      console.log(`Network:     ${NETWORKS[network].name}`);
      console.log(`Chain ID:    ${NETWORKS[network].chainId}`);
      console.log(`Block:       ${blockNumber}`);
      console.log(`Gas Price:   ${ethers.formatUnits(gasPrice.gasPrice || 0, 'gwei')} gwei`);
      
      if (config.contracts) {
        console.log();
        console.log(chalk.bold('Contracts'));
        console.log('─'.repeat(40));
        
        for (const [name, addr] of Object.entries(config.contracts)) {
          const code = await provider.getCode(addr);
          const status = code !== '0x' ? chalk.green('✓') : chalk.red('✗');
          console.log(`${status} ${name}: ${addr}`);
        }
      }
      
      console.log();
      
    } catch (e) {
      spinner.fail(`Error: ${e.message}`);
    }
  });

// ==================== Utility Commands ====================

program
  .command('generate-wallet')
  .description('Generate a new wallet')
  .action(() => {
    const wallet = ethers.Wallet.createRandom();
    
    console.log();
    console.log(chalk.bold('New Wallet Generated'));
    console.log('─'.repeat(50));
    console.log(`Address:     ${wallet.address}`);
    console.log(`Private Key: ${wallet.privateKey}`);
    console.log(`Mnemonic:    ${wallet.mnemonic.phrase}`);
    console.log();
    warning('Save this information securely! It cannot be recovered.');
    console.log();
  });

program
  .command('encode-calldata <function> [args...]')
  .description('Encode function call data')
  .option('-a, --abi <abi>', 'Function ABI signature')
  .action((func, args, options) => {
    try {
      const iface = new ethers.Interface([`function ${func}`]);
      const calldata = iface.encodeFunctionData(func.split('(')[0], args);
      
      console.log();
      console.log(chalk.bold('Encoded Calldata'));
      console.log('─'.repeat(50));
      console.log(calldata);
      console.log();
      
    } catch (e) {
      error(`Error: ${e.message}`);
    }
  });

// Parse and execute
program.parse();
