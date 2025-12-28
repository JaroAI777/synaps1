/**
 * SYNAPSE Protocol - Admin Scripts
 * 
 * Administrative scripts for protocol management
 * These scripts are meant to be run by protocol administrators
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Load deployment addresses
function loadDeployment(network) {
  const deploymentPath = path.join(__dirname, `../deployments/${network}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`Deployment file not found for network: ${network}`);
  }
  return JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
}

// Get signer
function getSigner(privateKey, rpcUrl) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return new ethers.Wallet(privateKey, provider);
}

// ==================== Token Administration ====================

/**
 * Update transfer fee
 */
async function updateTransferFee(signer, tokenAddress, newFeeBps) {
  const token = new ethers.Contract(tokenAddress, [
    'function setTransferFee(uint256 newFeeBps) external',
    'function transferFeeBps() view returns (uint256)'
  ], signer);
  
  console.log('Current fee:', (await token.transferFeeBps()).toString(), 'bps');
  
  const tx = await token.setTransferFee(newFeeBps);
  await tx.wait();
  
  console.log('New fee:', (await token.transferFeeBps()).toString(), 'bps');
  console.log('Transaction:', tx.hash);
}

/**
 * Add address to fee exemption list
 */
async function exemptFromFee(signer, tokenAddress, address) {
  const token = new ethers.Contract(tokenAddress, [
    'function setFeeExemption(address account, bool exempt) external'
  ], signer);
  
  const tx = await token.setFeeExemption(address, true);
  await tx.wait();
  
  console.log('Address exempted from fees:', address);
  console.log('Transaction:', tx.hash);
}

/**
 * Blocklist an address
 */
async function blockAddress(signer, tokenAddress, address) {
  const token = new ethers.Contract(tokenAddress, [
    'function setBlocklisted(address account, bool blocked) external'
  ], signer);
  
  const tx = await token.setBlocklisted(address, true);
  await tx.wait();
  
  console.log('Address blocked:', address);
  console.log('Transaction:', tx.hash);
}

// ==================== Payment Router Administration ====================

/**
 * Update base fee
 */
async function updateBaseFee(signer, routerAddress, newFeeBps) {
  const router = new ethers.Contract(routerAddress, [
    'function setBaseFee(uint256 newFeeBps) external',
    'function baseFeeBps() view returns (uint256)'
  ], signer);
  
  console.log('Current base fee:', (await router.baseFeeBps()).toString(), 'bps');
  
  const tx = await router.setBaseFee(newFeeBps);
  await tx.wait();
  
  console.log('New base fee:', (await router.baseFeeBps()).toString(), 'bps');
  console.log('Transaction:', tx.hash);
}

/**
 * Update treasury address
 */
async function updateTreasury(signer, routerAddress, newTreasury) {
  const router = new ethers.Contract(routerAddress, [
    'function setTreasury(address newTreasury) external',
    'function treasury() view returns (address)'
  ], signer);
  
  console.log('Current treasury:', await router.treasury());
  
  const tx = await router.setTreasury(newTreasury);
  await tx.wait();
  
  console.log('New treasury:', await router.treasury());
  console.log('Transaction:', tx.hash);
}

/**
 * Collect fees to treasury
 */
async function collectFees(signer, routerAddress) {
  const router = new ethers.Contract(routerAddress, [
    'function collectFees() external returns (uint256)'
  ], signer);
  
  const tx = await router.collectFees();
  const receipt = await tx.wait();
  
  console.log('Fees collected');
  console.log('Transaction:', tx.hash);
}

// ==================== Reputation Administration ====================

/**
 * Update minimum stake
 */
async function updateMinStake(signer, reputationAddress, newMinStake) {
  const reputation = new ethers.Contract(reputationAddress, [
    'function setMinStake(uint256 newMinStake) external',
    'function minStake() view returns (uint256)'
  ], signer);
  
  console.log('Current min stake:', ethers.formatEther(await reputation.minStake()), 'SYNX');
  
  const tx = await reputation.setMinStake(ethers.parseEther(newMinStake.toString()));
  await tx.wait();
  
  console.log('New min stake:', ethers.formatEther(await reputation.minStake()), 'SYNX');
  console.log('Transaction:', tx.hash);
}

/**
 * Update tier requirements
 */
async function updateTierRequirements(signer, reputationAddress, tier, minTx, successRate, minStake) {
  const reputation = new ethers.Contract(reputationAddress, [
    'function setTierRequirements(uint8 tier, uint256 minTransactions, uint256 minSuccessRate, uint256 minStake) external'
  ], signer);
  
  const tx = await reputation.setTierRequirements(
    tier,
    minTx,
    successRate,
    ethers.parseEther(minStake.toString())
  );
  await tx.wait();
  
  console.log(`Tier ${tier} requirements updated`);
  console.log('Transaction:', tx.hash);
}

/**
 * Grant arbiter role
 */
async function grantArbiterRole(signer, reputationAddress, arbiter) {
  const reputation = new ethers.Contract(reputationAddress, [
    'function grantRole(bytes32 role, address account) external',
    'function ARBITER_ROLE() view returns (bytes32)'
  ], signer);
  
  const arbiterRole = await reputation.ARBITER_ROLE();
  const tx = await reputation.grantRole(arbiterRole, arbiter);
  await tx.wait();
  
  console.log('Arbiter role granted to:', arbiter);
  console.log('Transaction:', tx.hash);
}

/**
 * Resolve dispute
 */
async function resolveDispute(signer, reputationAddress, disputeId, inFavorOfComplainant) {
  const reputation = new ethers.Contract(reputationAddress, [
    'function resolveDispute(bytes32 disputeId, bool inFavorOfComplainant) external'
  ], signer);
  
  const tx = await reputation.resolveDispute(disputeId, inFavorOfComplainant);
  await tx.wait();
  
  console.log('Dispute resolved');
  console.log('In favor of complainant:', inFavorOfComplainant);
  console.log('Transaction:', tx.hash);
}

// ==================== Service Registry Administration ====================

/**
 * Add new category
 */
async function addCategory(signer, registryAddress, categoryName, description) {
  const registry = new ethers.Contract(registryAddress, [
    'function addCategory(string name, string description) external'
  ], signer);
  
  const tx = await registry.addCategory(categoryName, description);
  await tx.wait();
  
  console.log('Category added:', categoryName);
  console.log('Transaction:', tx.hash);
}

/**
 * Update registration fee
 */
async function updateRegistrationFee(signer, registryAddress, newFee) {
  const registry = new ethers.Contract(registryAddress, [
    'function setRegistrationFee(uint256 newFee) external',
    'function registrationFee() view returns (uint256)'
  ], signer);
  
  console.log('Current fee:', ethers.formatEther(await registry.registrationFee()), 'SYNX');
  
  const tx = await registry.setRegistrationFee(ethers.parseEther(newFee.toString()));
  await tx.wait();
  
  console.log('New fee:', ethers.formatEther(await registry.registrationFee()), 'SYNX');
  console.log('Transaction:', tx.hash);
}

// ==================== Emergency Functions ====================

/**
 * Pause contract
 */
async function pauseContract(signer, contractAddress) {
  const contract = new ethers.Contract(contractAddress, [
    'function pause() external',
    'function paused() view returns (bool)'
  ], signer);
  
  const tx = await contract.pause();
  await tx.wait();
  
  console.log('Contract paused');
  console.log('Transaction:', tx.hash);
}

/**
 * Unpause contract
 */
async function unpauseContract(signer, contractAddress) {
  const contract = new ethers.Contract(contractAddress, [
    'function unpause() external',
    'function paused() view returns (bool)'
  ], signer);
  
  const tx = await contract.unpause();
  await tx.wait();
  
  console.log('Contract unpaused');
  console.log('Transaction:', tx.hash);
}

/**
 * Emergency withdraw from payment channel
 */
async function emergencyWithdraw(signer, channelAddress) {
  const channel = new ethers.Contract(channelAddress, [
    'function emergencyWithdraw() external'
  ], signer);
  
  const tx = await channel.emergencyWithdraw();
  await tx.wait();
  
  console.log('Emergency withdraw executed');
  console.log('Transaction:', tx.hash);
}

// ==================== Governance Functions ====================

/**
 * Create governance proposal
 */
async function createProposal(signer, governorAddress, targets, values, calldatas, description) {
  const governor = new ethers.Contract(governorAddress, [
    'function propose(address[] targets, uint256[] values, bytes[] calldatas, string description) external returns (uint256)'
  ], signer);
  
  const tx = await governor.propose(targets, values, calldatas, description);
  const receipt = await tx.wait();
  
  // Get proposal ID from event
  const proposalCreatedEvent = receipt.logs.find(log => {
    try {
      return governor.interface.parseLog(log)?.name === 'ProposalCreated';
    } catch { return false; }
  });
  
  console.log('Proposal created');
  console.log('Transaction:', tx.hash);
  if (proposalCreatedEvent) {
    const parsed = governor.interface.parseLog(proposalCreatedEvent);
    console.log('Proposal ID:', parsed.args.proposalId.toString());
  }
}

/**
 * Queue proposal for execution
 */
async function queueProposal(signer, governorAddress, targets, values, calldatas, descriptionHash) {
  const governor = new ethers.Contract(governorAddress, [
    'function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) external returns (uint256)'
  ], signer);
  
  const tx = await governor.queue(targets, values, calldatas, descriptionHash);
  await tx.wait();
  
  console.log('Proposal queued');
  console.log('Transaction:', tx.hash);
}

/**
 * Execute proposal
 */
async function executeProposal(signer, governorAddress, targets, values, calldatas, descriptionHash) {
  const governor = new ethers.Contract(governorAddress, [
    'function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) external payable returns (uint256)'
  ], signer);
  
  const tx = await governor.execute(targets, values, calldatas, descriptionHash);
  await tx.wait();
  
  console.log('Proposal executed');
  console.log('Transaction:', tx.hash);
}

// ==================== Reporting Functions ====================

/**
 * Generate protocol report
 */
async function generateReport(provider, deployment) {
  console.log('\n========================================');
  console.log('SYNAPSE Protocol Report');
  console.log('Generated:', new Date().toISOString());
  console.log('========================================\n');
  
  // Token stats
  const token = new ethers.Contract(deployment.token, [
    'function totalSupply() view returns (uint256)',
    'function totalBurned() view returns (uint256)',
    'function totalFeesCollected() view returns (uint256)'
  ], provider);
  
  console.log('TOKEN STATISTICS');
  console.log('-----------------');
  console.log('Total Supply:', ethers.formatEther(await token.totalSupply()), 'SYNX');
  try {
    console.log('Total Burned:', ethers.formatEther(await token.totalBurned()), 'SYNX');
    console.log('Total Fees:', ethers.formatEther(await token.totalFeesCollected()), 'SYNX');
  } catch (e) {
    console.log('(Extended stats not available)');
  }
  
  console.log('\nCONTRACT ADDRESSES');
  console.log('------------------');
  console.log('Token:', deployment.token);
  console.log('Payment Router:', deployment.paymentRouter);
  console.log('Reputation:', deployment.reputation);
  console.log('Service Registry:', deployment.serviceRegistry);
  console.log('Payment Channel:', deployment.paymentChannel);
  
  console.log('\n========================================\n');
}

// ==================== CLI Interface ====================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command) {
    console.log(`
SYNAPSE Protocol Admin Scripts

Usage: node admin.js <command> [options]

Commands:
  report <network>                    Generate protocol report
  pause <network> <contract>          Pause a contract
  unpause <network> <contract>        Unpause a contract
  update-fee <network> <newFeeBps>    Update transfer fee
  add-category <network> <name>       Add service category
  
Environment Variables:
  ADMIN_PRIVATE_KEY    Admin private key for signing transactions
  RPC_URL              RPC endpoint URL
    `);
    return;
  }
  
  const network = args[1];
  const privateKey = process.env.ADMIN_PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;
  
  if (!network) {
    console.error('Network required');
    return;
  }
  
  try {
    const deployment = loadDeployment(network);
    
    switch (command) {
      case 'report':
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        await generateReport(provider, deployment);
        break;
        
      case 'pause':
        if (!privateKey) throw new Error('ADMIN_PRIVATE_KEY required');
        const contract = args[2];
        const signer = getSigner(privateKey, rpcUrl);
        await pauseContract(signer, deployment[contract]);
        break;
        
      case 'unpause':
        if (!privateKey) throw new Error('ADMIN_PRIVATE_KEY required');
        const contract2 = args[2];
        const signer2 = getSigner(privateKey, rpcUrl);
        await unpauseContract(signer2, deployment[contract2]);
        break;
        
      case 'update-fee':
        if (!privateKey) throw new Error('ADMIN_PRIVATE_KEY required');
        const newFee = parseInt(args[2]);
        const signer3 = getSigner(privateKey, rpcUrl);
        await updateTransferFee(signer3, deployment.token, newFee);
        break;
        
      case 'add-category':
        if (!privateKey) throw new Error('ADMIN_PRIVATE_KEY required');
        const catName = args[2];
        const catDesc = args[3] || '';
        const signer4 = getSigner(privateKey, rpcUrl);
        await addCategory(signer4, deployment.serviceRegistry, catName, catDesc);
        break;
        
      default:
        console.error('Unknown command:', command);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Export functions for use as module
module.exports = {
  updateTransferFee,
  exemptFromFee,
  blockAddress,
  updateBaseFee,
  updateTreasury,
  collectFees,
  updateMinStake,
  updateTierRequirements,
  grantArbiterRole,
  resolveDispute,
  addCategory,
  updateRegistrationFee,
  pauseContract,
  unpauseContract,
  emergencyWithdraw,
  createProposal,
  queueProposal,
  executeProposal,
  generateReport
};

// Run if called directly
if (require.main === module) {
  main();
}
