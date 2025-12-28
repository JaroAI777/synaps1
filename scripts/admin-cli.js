#!/usr/bin/env node

/**
 * SYNAPSE Protocol - Admin CLI Tool
 * 
 * Command-line interface for protocol administration
 * Usage: synapse-admin <command> [options]
 */

const { Command } = require('commander');
const { ethers } = require('ethers');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const Table = require('cli-table3');
const fs = require('fs');
const path = require('path');

// Load deployment addresses
const loadDeployment = (network) => {
  const deploymentPath = path.join(__dirname, `../deployments/${network}.json`);
  if (fs.existsSync(deploymentPath)) {
    return JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
  }
  throw new Error(`Deployment not found for network: ${network}`);
};

// Contract ABIs (simplified)
const ABIS = {
  token: [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address, uint256) returns (bool)',
    'function mint(address, uint256)',
    'function burn(uint256)',
    'function pause()',
    'function unpause()',
    'function paused() view returns (bool)'
  ],
  paymentRouter: [
    'function protocolFee() view returns (uint256)',
    'function setProtocolFee(uint256)',
    'function pause()',
    'function unpause()',
    'function paused() view returns (bool)',
    'function collectFees(address)'
  ],
  staking: [
    'function totalStaked() view returns (uint256)',
    'function rewardRate() view returns (uint256)',
    'function notifyRewardAmount(uint256, uint256)',
    'function setRewardRate(uint256)',
    'function pause()',
    'function unpause()'
  ],
  governance: [
    'function proposalCount() view returns (uint256)',
    'function quorum() view returns (uint256)',
    'function setQuorum(uint256)',
    'function votingPeriod() view returns (uint256)'
  ],
  bridge: [
    'function pause()',
    'function unpause()',
    'function paused() view returns (bool)',
    'function dailyLimit() view returns (uint256)',
    'function setDailyLimit(uint256)',
    'function addValidator(address)',
    'function removeValidator(address)'
  ]
};

const program = new Command();

program
  .name('synapse-admin')
  .description('SYNAPSE Protocol Admin CLI')
  .version('1.0.0')
  .option('-n, --network <network>', 'Network to use', 'arbitrumSepolia')
  .option('-k, --key <privateKey>', 'Private key (or set PRIVATE_KEY env var)');

// ============ Token Commands ============

const tokenCmd = program.command('token').description('Token management');

tokenCmd
  .command('info')
  .description('Get token information')
  .action(async () => {
    const spinner = ora('Fetching token info...').start();
    try {
      const { provider, contracts } = await setup(program.opts());
      const token = contracts.token;

      const [name, symbol, totalSupply, paused] = await Promise.all([
        token.name(),
        token.symbol(),
        token.totalSupply(),
        token.paused().catch(() => false)
      ]);

      spinner.succeed('Token Information');
      
      const table = new Table();
      table.push(
        { 'Name': name },
        { 'Symbol': symbol },
        { 'Total Supply': ethers.formatEther(totalSupply) + ' ' + symbol },
        { 'Status': paused ? chalk.red('PAUSED') : chalk.green('ACTIVE') }
      );
      console.log(table.toString());
    } catch (error) {
      spinner.fail(error.message);
    }
  });

tokenCmd
  .command('balance <address>')
  .description('Check token balance')
  .action(async (address) => {
    const spinner = ora('Checking balance...').start();
    try {
      const { contracts } = await setup(program.opts());
      const balance = await contracts.token.balanceOf(address);
      spinner.succeed(`Balance: ${chalk.green(ethers.formatEther(balance))} SYNX`);
    } catch (error) {
      spinner.fail(error.message);
    }
  });

tokenCmd
  .command('transfer <to> <amount>')
  .description('Transfer tokens')
  .action(async (to, amount) => {
    const opts = program.opts();
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Transfer ${amount} SYNX to ${to}?`,
      default: false
    }]);

    if (!confirm) return console.log('Cancelled');

    const spinner = ora('Sending transaction...').start();
    try {
      const { contracts } = await setup(opts);
      const tx = await contracts.token.transfer(to, ethers.parseEther(amount));
      spinner.text = 'Waiting for confirmation...';
      const receipt = await tx.wait();
      spinner.succeed(`Transfer complete! TX: ${receipt.hash}`);
    } catch (error) {
      spinner.fail(error.message);
    }
  });

tokenCmd
  .command('pause')
  .description('Pause token transfers')
  .action(async () => {
    const opts = program.opts();
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: chalk.red('⚠️  Are you sure you want to PAUSE the token?'),
      default: false
    }]);

    if (!confirm) return console.log('Cancelled');

    const spinner = ora('Pausing token...').start();
    try {
      const { contracts } = await setup(opts);
      const tx = await contracts.token.pause();
      await tx.wait();
      spinner.succeed('Token paused!');
    } catch (error) {
      spinner.fail(error.message);
    }
  });

tokenCmd
  .command('unpause')
  .description('Unpause token transfers')
  .action(async () => {
    const spinner = ora('Unpausing token...').start();
    try {
      const { contracts } = await setup(program.opts());
      const tx = await contracts.token.unpause();
      await tx.wait();
      spinner.succeed('Token unpaused!');
    } catch (error) {
      spinner.fail(error.message);
    }
  });

// ============ Protocol Commands ============

const protocolCmd = program.command('protocol').description('Protocol management');

protocolCmd
  .command('status')
  .description('Get protocol status')
  .action(async () => {
    const spinner = ora('Fetching protocol status...').start();
    try {
      const { provider, contracts, deployment } = await setup(program.opts());

      const [
        tokenPaused,
        routerPaused,
        totalStaked,
        rewardRate,
        fee
      ] = await Promise.all([
        contracts.token.paused().catch(() => false),
        contracts.paymentRouter.paused().catch(() => false),
        contracts.staking.totalStaked(),
        contracts.staking.rewardRate(),
        contracts.paymentRouter.protocolFee()
      ]);

      spinner.succeed('Protocol Status');

      const table = new Table({
        head: [chalk.cyan('Component'), chalk.cyan('Status'), chalk.cyan('Details')]
      });

      table.push(
        ['Token', tokenPaused ? chalk.red('PAUSED') : chalk.green('ACTIVE'), deployment.token?.slice(0, 10) + '...'],
        ['Payment Router', routerPaused ? chalk.red('PAUSED') : chalk.green('ACTIVE'), `Fee: ${fee / 100}%`],
        ['Staking', chalk.green('ACTIVE'), `TVL: ${ethers.formatEther(totalStaked)} SYNX`],
        ['Reward Rate', '-', `${ethers.formatEther(rewardRate)}/sec`]
      );

      console.log(table.toString());
    } catch (error) {
      spinner.fail(error.message);
    }
  });

protocolCmd
  .command('set-fee <fee>')
  .description('Set protocol fee (in basis points, e.g., 30 = 0.3%)')
  .action(async (fee) => {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Set protocol fee to ${fee / 100}%?`,
      default: false
    }]);

    if (!confirm) return console.log('Cancelled');

    const spinner = ora('Setting fee...').start();
    try {
      const { contracts } = await setup(program.opts());
      const tx = await contracts.paymentRouter.setProtocolFee(fee);
      await tx.wait();
      spinner.succeed(`Protocol fee set to ${fee / 100}%`);
    } catch (error) {
      spinner.fail(error.message);
    }
  });

protocolCmd
  .command('collect-fees <recipient>')
  .description('Collect accumulated protocol fees')
  .action(async (recipient) => {
    const spinner = ora('Collecting fees...').start();
    try {
      const { contracts } = await setup(program.opts());
      const tx = await contracts.paymentRouter.collectFees(recipient);
      await tx.wait();
      spinner.succeed(`Fees collected to ${recipient}`);
    } catch (error) {
      spinner.fail(error.message);
    }
  });

// ============ Staking Commands ============

const stakingCmd = program.command('staking').description('Staking management');

stakingCmd
  .command('info')
  .description('Get staking information')
  .action(async () => {
    const spinner = ora('Fetching staking info...').start();
    try {
      const { contracts } = await setup(program.opts());

      const [totalStaked, rewardRate] = await Promise.all([
        contracts.staking.totalStaked(),
        contracts.staking.rewardRate()
      ]);

      spinner.succeed('Staking Information');

      const table = new Table();
      table.push(
        { 'Total Staked': ethers.formatEther(totalStaked) + ' SYNX' },
        { 'Reward Rate': ethers.formatEther(rewardRate) + ' SYNX/sec' },
        { 'Daily Rewards': ethers.formatEther(rewardRate * 86400n) + ' SYNX' },
        { 'Yearly Rewards': ethers.formatEther(rewardRate * 31536000n) + ' SYNX' }
      );
      console.log(table.toString());
    } catch (error) {
      spinner.fail(error.message);
    }
  });

stakingCmd
  .command('add-rewards <amount> <duration>')
  .description('Add staking rewards (amount in SYNX, duration in days)')
  .action(async (amount, duration) => {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Add ${amount} SYNX rewards over ${duration} days?`,
      default: false
    }]);

    if (!confirm) return console.log('Cancelled');

    const spinner = ora('Adding rewards...').start();
    try {
      const { contracts } = await setup(program.opts());
      const durationSeconds = parseInt(duration) * 86400;
      const tx = await contracts.staking.notifyRewardAmount(
        ethers.parseEther(amount),
        durationSeconds
      );
      await tx.wait();
      spinner.succeed('Rewards added!');
    } catch (error) {
      spinner.fail(error.message);
    }
  });

// ============ Bridge Commands ============

const bridgeCmd = program.command('bridge').description('Bridge management');

bridgeCmd
  .command('add-validator <address>')
  .description('Add bridge validator')
  .action(async (address) => {
    const spinner = ora('Adding validator...').start();
    try {
      const { contracts } = await setup(program.opts());
      const tx = await contracts.bridge.addValidator(address);
      await tx.wait();
      spinner.succeed(`Validator ${address} added!`);
    } catch (error) {
      spinner.fail(error.message);
    }
  });

bridgeCmd
  .command('remove-validator <address>')
  .description('Remove bridge validator')
  .action(async (address) => {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Remove validator ${address}?`,
      default: false
    }]);

    if (!confirm) return console.log('Cancelled');

    const spinner = ora('Removing validator...').start();
    try {
      const { contracts } = await setup(program.opts());
      const tx = await contracts.bridge.removeValidator(address);
      await tx.wait();
      spinner.succeed(`Validator ${address} removed!`);
    } catch (error) {
      spinner.fail(error.message);
    }
  });

bridgeCmd
  .command('set-limit <amount>')
  .description('Set daily bridge limit (in SYNX)')
  .action(async (amount) => {
    const spinner = ora('Setting limit...').start();
    try {
      const { contracts } = await setup(program.opts());
      const tx = await contracts.bridge.setDailyLimit(ethers.parseEther(amount));
      await tx.wait();
      spinner.succeed(`Daily limit set to ${amount} SYNX`);
    } catch (error) {
      spinner.fail(error.message);
    }
  });

// ============ Emergency Commands ============

const emergencyCmd = program.command('emergency').description('Emergency actions');

emergencyCmd
  .command('pause-all')
  .description('Pause all contracts')
  .action(async () => {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: chalk.red('⚠️  EMERGENCY: Pause ALL contracts?'),
      default: false
    }]);

    if (!confirm) return console.log('Cancelled');

    const spinner = ora('Pausing all contracts...').start();
    try {
      const { contracts } = await setup(program.opts());
      
      const txs = await Promise.all([
        contracts.token.pause().catch(e => ({ error: e.message })),
        contracts.paymentRouter.pause().catch(e => ({ error: e.message })),
        contracts.staking.pause().catch(e => ({ error: e.message })),
        contracts.bridge.pause().catch(e => ({ error: e.message }))
      ]);

      spinner.succeed('All contracts paused!');
    } catch (error) {
      spinner.fail(error.message);
    }
  });

emergencyCmd
  .command('unpause-all')
  .description('Unpause all contracts')
  .action(async () => {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: 'Unpause ALL contracts?',
      default: false
    }]);

    if (!confirm) return console.log('Cancelled');

    const spinner = ora('Unpausing all contracts...').start();
    try {
      const { contracts } = await setup(program.opts());
      
      await Promise.all([
        contracts.token.unpause().catch(() => {}),
        contracts.paymentRouter.unpause().catch(() => {}),
        contracts.staking.unpause().catch(() => {}),
        contracts.bridge.unpause().catch(() => {})
      ]);

      spinner.succeed('All contracts unpaused!');
    } catch (error) {
      spinner.fail(error.message);
    }
  });

// ============ Setup Function ============

async function setup(opts) {
  const network = opts.network;
  const privateKey = opts.key || process.env.PRIVATE_KEY;
  
  if (!privateKey) {
    throw new Error('Private key required. Use -k option or set PRIVATE_KEY env var.');
  }

  const deployment = loadDeployment(network);
  
  const rpcUrl = {
    arbitrumOne: 'https://arb1.arbitrum.io/rpc',
    arbitrumSepolia: 'https://sepolia-rollup.arbitrum.io/rpc',
    localhost: 'http://127.0.0.1:8545'
  }[network] || `https://${network}.infura.io/v3/${process.env.INFURA_KEY}`;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const contracts = {
    token: new ethers.Contract(deployment.token, ABIS.token, wallet),
    paymentRouter: new ethers.Contract(deployment.paymentRouter, ABIS.paymentRouter, wallet),
    staking: new ethers.Contract(deployment.staking, ABIS.staking, wallet),
    governance: new ethers.Contract(deployment.governance, ABIS.governance, wallet),
    bridge: new ethers.Contract(deployment.bridge, ABIS.bridge, wallet)
  };

  return { provider, wallet, contracts, deployment };
}

// Run
program.parse();
