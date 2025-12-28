<?php
/**
 * SYNAPSE Protocol PHP SDK
 * 
 * For Laravel, Symfony, and other PHP applications
 * 
 * Installation: composer require synapse/sdk
 */

declare(strict_types=1);

namespace Synapse\SDK;

use Web3\Web3;
use Web3\Contract;
use Web3\Utils;
use kornrunner\Keccak;
use kornrunner\Ethereum\Transaction;

/**
 * Main SDK Client
 */
class SynapseClient
{
    private Web3 $web3;
    private array $contracts = [];
    private array $config;
    private ?string $privateKey = null;
    private ?string $address = null;

    /**
     * Constructor
     * 
     * @param array $config Configuration options
     */
    public function __construct(array $config)
    {
        $this->config = array_merge([
            'rpcUrl' => 'https://arb1.arbitrum.io/rpc',
            'chainId' => 42161,
            'tokenAddress' => '',
            'routerAddress' => '',
            'stakingAddress' => '',
        ], $config);

        $this->web3 = new Web3($this->config['rpcUrl']);
    }

    /**
     * Set signer
     */
    public function setSigner(string $privateKey): self
    {
        $this->privateKey = $privateKey;
        $this->address = $this->privateKeyToAddress($privateKey);
        return $this;
    }

    /**
     * Get connected address
     */
    public function getAddress(): ?string
    {
        return $this->address;
    }

    // ============ Token Operations ============

    /**
     * Get token balance
     */
    public function getBalance(string $address = null): string
    {
        $address = $address ?? $this->address;
        if (!$address) {
            throw new \Exception('No address provided');
        }

        $contract = $this->getTokenContract();
        $balance = '0';

        $contract->call('balanceOf', $address, function ($err, $result) use (&$balance) {
            if ($err) throw new \Exception($err->getMessage());
            $balance = $result[0]->toString();
        });

        return $balance;
    }

    /**
     * Get formatted balance
     */
    public function getFormattedBalance(string $address = null): string
    {
        $balance = $this->getBalance($address);
        return Utils::fromWei($balance, 'ether');
    }

    /**
     * Transfer tokens
     */
    public function transfer(string $to, string $amount): TransactionResult
    {
        $this->requireSigner();
        
        $contract = $this->getTokenContract();
        $data = $contract->getData('transfer', $to, Utils::toWei($amount, 'ether'));
        
        return $this->sendTransaction($this->config['tokenAddress'], '0', $data);
    }

    /**
     * Approve spending
     */
    public function approve(string $spender, string $amount): TransactionResult
    {
        $this->requireSigner();

        $contract = $this->getTokenContract();
        $data = $contract->getData('approve', $spender, Utils::toWei($amount, 'ether'));

        return $this->sendTransaction($this->config['tokenAddress'], '0', $data);
    }

    /**
     * Get allowance
     */
    public function getAllowance(string $owner, string $spender): string
    {
        $contract = $this->getTokenContract();
        $allowance = '0';

        $contract->call('allowance', $owner, $spender, function ($err, $result) use (&$allowance) {
            if ($err) throw new \Exception($err->getMessage());
            $allowance = $result[0]->toString();
        });

        return $allowance;
    }

    // ============ Payment Operations ============

    /**
     * Send payment
     */
    public function sendPayment(string $recipient, string $amount, string $metadata = ''): TransactionResult
    {
        $this->requireSigner();

        // Ensure approval
        $this->ensureApproval($this->config['routerAddress'], $amount);

        $contract = $this->getRouterContract();
        $data = $contract->getData('pay', $recipient, Utils::toWei($amount, 'ether'), $metadata);

        return $this->sendTransaction($this->config['routerAddress'], '0', $data);
    }

    /**
     * Create escrow
     */
    public function createEscrow(
        string $recipient,
        string $amount,
        int $deadline,
        string $arbiter = null
    ): TransactionResult {
        $this->requireSigner();
        
        $this->ensureApproval($this->config['routerAddress'], $amount);

        $contract = $this->getRouterContract();
        $data = $contract->getData(
            'createEscrow',
            $recipient,
            $arbiter ?? '0x0000000000000000000000000000000000000000',
            Utils::toWei($amount, 'ether'),
            $deadline
        );

        return $this->sendTransaction($this->config['routerAddress'], '0', $data);
    }

    /**
     * Release escrow
     */
    public function releaseEscrow(string $escrowId): TransactionResult
    {
        $this->requireSigner();

        $contract = $this->getRouterContract();
        $data = $contract->getData('releaseEscrow', $escrowId);

        return $this->sendTransaction($this->config['routerAddress'], '0', $data);
    }

    // ============ Staking Operations ============

    /**
     * Stake tokens
     */
    public function stake(string $amount, int $lockTier = 0): TransactionResult
    {
        $this->requireSigner();

        $this->ensureApproval($this->config['stakingAddress'], $amount);

        $contract = $this->getStakingContract();
        $data = $contract->getData('stake', Utils::toWei($amount, 'ether'), $lockTier);

        return $this->sendTransaction($this->config['stakingAddress'], '0', $data);
    }

    /**
     * Unstake tokens
     */
    public function unstake(string $amount): TransactionResult
    {
        $this->requireSigner();

        $contract = $this->getStakingContract();
        $data = $contract->getData('unstake', Utils::toWei($amount, 'ether'));

        return $this->sendTransaction($this->config['stakingAddress'], '0', $data);
    }

    /**
     * Claim rewards
     */
    public function claimRewards(): TransactionResult
    {
        $this->requireSigner();

        $contract = $this->getStakingContract();
        $data = $contract->getData('claimRewards');

        return $this->sendTransaction($this->config['stakingAddress'], '0', $data);
    }

    /**
     * Get stake info
     */
    public function getStakeInfo(string $address = null): StakeInfo
    {
        $address = $address ?? $this->address;
        if (!$address) {
            throw new \Exception('No address provided');
        }

        $contract = $this->getStakingContract();
        $info = null;

        $contract->call('getStakeInfo', $address, function ($err, $result) use (&$info) {
            if ($err) throw new \Exception($err->getMessage());
            $info = $result;
        });

        return new StakeInfo([
            'amount' => $info['amount']->toString(),
            'lockTier' => (int)$info['lockTier']->toString(),
            'lockEnd' => (int)$info['lockEnd']->toString(),
            'pendingRewards' => $info['pendingRewards']->toString(),
        ]);
    }

    /**
     * Get pending rewards
     */
    public function getPendingRewards(string $address = null): string
    {
        $address = $address ?? $this->address;
        
        $contract = $this->getStakingContract();
        $rewards = '0';

        $contract->call('earned', $address, function ($err, $result) use (&$rewards) {
            if ($err) throw new \Exception($err->getMessage());
            $rewards = $result[0]->toString();
        });

        return $rewards;
    }

    // ============ Internal Methods ============

    private function requireSigner(): void
    {
        if (!$this->privateKey || !$this->address) {
            throw new \Exception('No signer set. Call setSigner() first.');
        }
    }

    private function ensureApproval(string $spender, string $amount): void
    {
        $amountWei = Utils::toWei($amount, 'ether');
        $currentAllowance = $this->getAllowance($this->address, $spender);

        if (gmp_cmp($currentAllowance, $amountWei) < 0) {
            $maxApproval = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
            $this->approve($spender, Utils::fromWei($maxApproval, 'ether'));
        }
    }

    private function sendTransaction(string $to, string $value, string $data): TransactionResult
    {
        $nonce = $this->getNonce();
        $gasPrice = $this->getGasPrice();
        $gasLimit = $this->estimateGas($to, $value, $data);

        $tx = new Transaction(
            $nonce,
            $gasPrice,
            $gasLimit,
            $to,
            $value,
            $data
        );

        $signedTx = $tx->sign($this->privateKey, $this->config['chainId']);

        $txHash = null;
        $this->web3->eth->sendRawTransaction('0x' . $signedTx, function ($err, $hash) use (&$txHash) {
            if ($err) throw new \Exception($err->getMessage());
            $txHash = $hash;
        });

        return new TransactionResult([
            'hash' => $txHash,
            'from' => $this->address,
            'to' => $to,
            'value' => $value,
        ]);
    }

    private function getNonce(): string
    {
        $nonce = '0';
        $this->web3->eth->getTransactionCount($this->address, 'pending', function ($err, $count) use (&$nonce) {
            if ($err) throw new \Exception($err->getMessage());
            $nonce = '0x' . dechex((int)$count->toString());
        });
        return $nonce;
    }

    private function getGasPrice(): string
    {
        $gasPrice = '0';
        $this->web3->eth->gasPrice(function ($err, $price) use (&$gasPrice) {
            if ($err) throw new \Exception($err->getMessage());
            $gasPrice = '0x' . dechex((int)$price->toString());
        });
        return $gasPrice;
    }

    private function estimateGas(string $to, string $value, string $data): string
    {
        $gas = '0x55f0'; // Default 22000
        $this->web3->eth->estimateGas([
            'from' => $this->address,
            'to' => $to,
            'value' => $value,
            'data' => $data,
        ], function ($err, $estimated) use (&$gas) {
            if (!$err) {
                $gas = '0x' . dechex((int)((int)$estimated->toString() * 1.2)); // Add 20% buffer
            }
        });
        return $gas;
    }

    private function privateKeyToAddress(string $privateKey): string
    {
        $privateKey = ltrim($privateKey, '0x');
        $publicKey = secp256k1_ec_pubkey_create($privateKey);
        $hash = Keccak::hash(hex2bin($publicKey), 256);
        return '0x' . substr($hash, -40);
    }

    private function getTokenContract(): Contract
    {
        if (!isset($this->contracts['token'])) {
            $this->contracts['token'] = new Contract($this->web3->provider, ABIs::TOKEN);
            $this->contracts['token']->at($this->config['tokenAddress']);
        }
        return $this->contracts['token'];
    }

    private function getRouterContract(): Contract
    {
        if (!isset($this->contracts['router'])) {
            $this->contracts['router'] = new Contract($this->web3->provider, ABIs::PAYMENT_ROUTER);
            $this->contracts['router']->at($this->config['routerAddress']);
        }
        return $this->contracts['router'];
    }

    private function getStakingContract(): Contract
    {
        if (!isset($this->contracts['staking'])) {
            $this->contracts['staking'] = new Contract($this->web3->provider, ABIs::STAKING);
            $this->contracts['staking']->at($this->config['stakingAddress']);
        }
        return $this->contracts['staking'];
    }
}

/**
 * Transaction Result
 */
class TransactionResult
{
    public string $hash;
    public string $from;
    public string $to;
    public string $value;
    public ?array $receipt = null;

    public function __construct(array $data)
    {
        $this->hash = $data['hash'];
        $this->from = $data['from'];
        $this->to = $data['to'];
        $this->value = $data['value'];
    }

    public function toArray(): array
    {
        return [
            'hash' => $this->hash,
            'from' => $this->from,
            'to' => $this->to,
            'value' => $this->value,
            'receipt' => $this->receipt,
        ];
    }
}

/**
 * Stake Info
 */
class StakeInfo
{
    public string $amount;
    public int $lockTier;
    public int $lockEnd;
    public string $pendingRewards;

    public function __construct(array $data)
    {
        $this->amount = $data['amount'];
        $this->lockTier = $data['lockTier'];
        $this->lockEnd = $data['lockEnd'];
        $this->pendingRewards = $data['pendingRewards'];
    }

    public function getFormattedAmount(): string
    {
        return Utils::fromWei($this->amount, 'ether');
    }

    public function getFormattedRewards(): string
    {
        return Utils::fromWei($this->pendingRewards, 'ether');
    }

    public function isLocked(): bool
    {
        return $this->lockEnd > time();
    }

    public function toArray(): array
    {
        return [
            'amount' => $this->amount,
            'formattedAmount' => $this->getFormattedAmount(),
            'lockTier' => $this->lockTier,
            'lockEnd' => $this->lockEnd,
            'pendingRewards' => $this->pendingRewards,
            'formattedRewards' => $this->getFormattedRewards(),
            'isLocked' => $this->isLocked(),
        ];
    }
}

/**
 * ABIs
 */
class ABIs
{
    public const TOKEN = '[
        {"constant":true,"inputs":[{"name":"account","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"},
        {"constant":false,"inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"name":"","type":"bool"}],"type":"function"},
        {"constant":false,"inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"name":"approve","outputs":[{"name":"","type":"bool"}],"type":"function"},
        {"constant":true,"inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],"name":"allowance","outputs":[{"name":"","type":"uint256"}],"type":"function"}
    ]';

    public const PAYMENT_ROUTER = '[
        {"inputs":[{"name":"recipient","type":"address"},{"name":"amount","type":"uint256"},{"name":"metadata","type":"string"}],"name":"pay","outputs":[{"name":"","type":"bytes32"}],"type":"function"},
        {"inputs":[{"name":"recipient","type":"address"},{"name":"arbiter","type":"address"},{"name":"amount","type":"uint256"},{"name":"deadline","type":"uint256"}],"name":"createEscrow","outputs":[{"name":"","type":"bytes32"}],"type":"function"},
        {"inputs":[{"name":"escrowId","type":"bytes32"}],"name":"releaseEscrow","outputs":[],"type":"function"}
    ]';

    public const STAKING = '[
        {"inputs":[{"name":"amount","type":"uint256"},{"name":"lockTier","type":"uint8"}],"name":"stake","outputs":[],"type":"function"},
        {"inputs":[{"name":"amount","type":"uint256"}],"name":"unstake","outputs":[],"type":"function"},
        {"inputs":[],"name":"claimRewards","outputs":[],"type":"function"},
        {"inputs":[{"name":"user","type":"address"}],"name":"getStakeInfo","outputs":[{"components":[{"name":"amount","type":"uint256"},{"name":"lockTier","type":"uint8"},{"name":"lockEnd","type":"uint256"},{"name":"pendingRewards","type":"uint256"},{"name":"lastClaim","type":"uint256"}],"name":"","type":"tuple"}],"type":"function"},
        {"inputs":[{"name":"user","type":"address"}],"name":"earned","outputs":[{"name":"","type":"uint256"}],"type":"function"}
    ]';
}
