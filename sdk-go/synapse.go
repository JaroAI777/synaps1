// Package synapse provides a Go SDK for interacting with SYNAPSE Protocol
// AI-to-AI Payment Infrastructure
package synapse

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

// Tier represents reputation tier levels
type Tier uint8

const (
	TierUnverified Tier = iota
	TierBronze
	TierSilver
	TierGold
	TierPlatinum
	TierDiamond
)

// PricingModel represents service pricing models
type PricingModel uint8

const (
	PricingPerRequest PricingModel = iota
	PricingPerToken
	PricingPerSecond
	PricingPerByte
	PricingSubscription
	PricingCustom
)

// ChannelStatus represents payment channel status
type ChannelStatus uint8

const (
	ChannelNone ChannelStatus = iota
	ChannelOpen
	ChannelClosing
	ChannelClosed
)

// Config holds SDK configuration
type Config struct {
	RPCURL     string
	PrivateKey string
	Contracts  ContractAddresses
}

// ContractAddresses holds all contract addresses
type ContractAddresses struct {
	Token          common.Address
	PaymentRouter  common.Address
	Reputation     common.Address
	ServiceRegistry common.Address
	PaymentChannel common.Address
}

// Client is the main SYNAPSE SDK client
type Client struct {
	config     Config
	client     *ethclient.Client
	privateKey *ecdsa.PrivateKey
	address    common.Address
	chainID    *big.Int
}

// AgentInfo represents an AI agent's information
type AgentInfo struct {
	Registered            bool
	Name                  string
	Stake                 *big.Int
	ReputationScore       uint64
	TotalTransactions     uint64
	SuccessfulTransactions uint64
	RegisteredAt          uint64
	Tier                  Tier
	SuccessRate           float64
}

// ServiceInfo represents a registered service
type ServiceInfo struct {
	Provider     common.Address
	Name         string
	Category     string
	Description  string
	Endpoint     string
	BasePrice    *big.Int
	PricingModel PricingModel
	Active       bool
	CreatedAt    uint64
}

// ChannelInfo represents a payment channel
type ChannelInfo struct {
	ChannelID    [32]byte
	Participant1 common.Address
	Participant2 common.Address
	Balance1     *big.Int
	Balance2     *big.Int
	Nonce        uint64
	Status       ChannelStatus
	ChallengeEnd uint64
}

// PaymentResult represents the result of a payment
type PaymentResult struct {
	TxHash    common.Hash
	PaymentID [32]byte
	Amount    *big.Int
	Fee       *big.Int
}

// NewClient creates a new SYNAPSE SDK client
func NewClient(config Config) (*Client, error) {
	// Connect to RPC
	client, err := ethclient.Dial(config.RPCURL)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to RPC: %w", err)
	}

	// Parse private key
	privateKey, err := crypto.HexToECDSA(config.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("invalid private key: %w", err)
	}

	// Get address from private key
	publicKey := privateKey.Public()
	publicKeyECDSA, ok := publicKey.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("error casting public key")
	}
	address := crypto.PubkeyToAddress(*publicKeyECDSA)

	// Get chain ID
	chainID, err := client.ChainID(context.Background())
	if err != nil {
		return nil, fmt.Errorf("failed to get chain ID: %w", err)
	}

	return &Client{
		config:     config,
		client:     client,
		privateKey: privateKey,
		address:    address,
		chainID:    chainID,
	}, nil
}

// Address returns the client's address
func (c *Client) Address() common.Address {
	return c.address
}

// ChainID returns the chain ID
func (c *Client) ChainID() *big.Int {
	return c.chainID
}

// Close closes the client connection
func (c *Client) Close() {
	c.client.Close()
}

// getTransactOpts returns transaction options for signing
func (c *Client) getTransactOpts(ctx context.Context) (*bind.TransactOpts, error) {
	nonce, err := c.client.PendingNonceAt(ctx, c.address)
	if err != nil {
		return nil, fmt.Errorf("failed to get nonce: %w", err)
	}

	gasPrice, err := c.client.SuggestGasPrice(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get gas price: %w", err)
	}

	auth, err := bind.NewKeyedTransactorWithChainID(c.privateKey, c.chainID)
	if err != nil {
		return nil, fmt.Errorf("failed to create transactor: %w", err)
	}

	auth.Nonce = big.NewInt(int64(nonce))
	auth.Value = big.NewInt(0)
	auth.GasLimit = uint64(500000)
	auth.GasPrice = gasPrice
	auth.Context = ctx

	return auth, nil
}

// waitForTx waits for a transaction to be mined
func (c *Client) waitForTx(ctx context.Context, tx *types.Transaction) (*types.Receipt, error) {
	receipt, err := bind.WaitMined(ctx, c.client, tx)
	if err != nil {
		return nil, fmt.Errorf("failed to wait for transaction: %w", err)
	}

	if receipt.Status != types.ReceiptStatusSuccessful {
		return nil, fmt.Errorf("transaction failed")
	}

	return receipt, nil
}

// ==================== Token Functions ====================

// GetBalance returns the SYNX balance for an address
func (c *Client) GetBalance(ctx context.Context, address common.Address) (*big.Int, error) {
	// This would use the generated contract bindings
	// For demonstration, returning placeholder
	return big.NewInt(0), nil
}

// Transfer transfers SYNX tokens
func (c *Client) Transfer(ctx context.Context, to common.Address, amount *big.Int) (common.Hash, error) {
	// Implementation would use contract bindings
	return common.Hash{}, nil
}

// Approve approves token spending
func (c *Client) Approve(ctx context.Context, spender common.Address, amount *big.Int) (common.Hash, error) {
	// Implementation would use contract bindings
	return common.Hash{}, nil
}

// ApproveAll approves all protocol contracts
func (c *Client) ApproveAll(ctx context.Context) ([]common.Hash, error) {
	maxUint256 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	var hashes []common.Hash

	contracts := []common.Address{
		c.config.Contracts.PaymentRouter,
		c.config.Contracts.Reputation,
		c.config.Contracts.ServiceRegistry,
		c.config.Contracts.PaymentChannel,
	}

	for _, contract := range contracts {
		if contract != (common.Address{}) {
			hash, err := c.Approve(ctx, contract, maxUint256)
			if err != nil {
				return hashes, err
			}
			hashes = append(hashes, hash)
		}
	}

	return hashes, nil
}

// ==================== Payment Functions ====================

// Pay sends a direct payment
func (c *Client) Pay(ctx context.Context, recipient common.Address, amount *big.Int, metadata []byte) (*PaymentResult, error) {
	// Generate payment ID
	paymentID := crypto.Keccak256Hash(
		[]byte(fmt.Sprintf("pay-%d-%s", time.Now().UnixNano(), recipient.Hex())),
	)

	// Implementation would call the PaymentRouter contract
	// For demonstration:
	return &PaymentResult{
		TxHash:    common.Hash{},
		PaymentID: paymentID,
		Amount:    amount,
		Fee:       big.NewInt(0),
	}, nil
}

// BatchPayment represents a single payment in a batch
type BatchPayment struct {
	Recipient common.Address
	Amount    *big.Int
}

// BatchPay sends multiple payments in one transaction
func (c *Client) BatchPay(ctx context.Context, payments []BatchPayment) (common.Hash, error) {
	// Implementation would call batchPay on PaymentRouter
	return common.Hash{}, nil
}

// CreateEscrow creates an escrow payment
func (c *Client) CreateEscrow(ctx context.Context, recipient, arbiter common.Address, amount *big.Int, deadline uint64) ([32]byte, error) {
	// Implementation
	return [32]byte{}, nil
}

// ReleaseEscrow releases an escrow payment
func (c *Client) ReleaseEscrow(ctx context.Context, escrowID [32]byte) (common.Hash, error) {
	return common.Hash{}, nil
}

// CreateStream creates a payment stream
func (c *Client) CreateStream(ctx context.Context, recipient common.Address, totalAmount *big.Int, startTime, endTime uint64) ([32]byte, error) {
	return [32]byte{}, nil
}

// ==================== Agent Functions ====================

// RegisterAgentParams holds parameters for agent registration
type RegisterAgentParams struct {
	Name        string
	MetadataURI string
	Stake       *big.Int
}

// RegisterAgent registers as an AI agent
func (c *Client) RegisterAgent(ctx context.Context, params RegisterAgentParams) (common.Hash, error) {
	// Implementation
	return common.Hash{}, nil
}

// GetAgent returns agent information
func (c *Client) GetAgent(ctx context.Context, address common.Address) (*AgentInfo, error) {
	// Implementation
	return &AgentInfo{}, nil
}

// IncreaseStake increases agent stake
func (c *Client) IncreaseStake(ctx context.Context, amount *big.Int) (common.Hash, error) {
	return common.Hash{}, nil
}

// CreateDispute creates a dispute against another agent
func (c *Client) CreateDispute(ctx context.Context, defendant common.Address, reason string, txID [32]byte) ([32]byte, error) {
	return [32]byte{}, nil
}

// RateService rates a service provider
func (c *Client) RateService(ctx context.Context, provider common.Address, category string, rating uint8) (common.Hash, error) {
	if rating < 1 || rating > 5 {
		return common.Hash{}, fmt.Errorf("rating must be between 1 and 5")
	}
	return common.Hash{}, nil
}

// ==================== Service Functions ====================

// RegisterServiceParams holds parameters for service registration
type RegisterServiceParams struct {
	Name         string
	Category     string
	Description  string
	Endpoint     string
	BasePrice    *big.Int
	PricingModel PricingModel
}

// RegisterService registers a new service
func (c *Client) RegisterService(ctx context.Context, params RegisterServiceParams) ([32]byte, error) {
	return [32]byte{}, nil
}

// GetService returns service information
func (c *Client) GetService(ctx context.Context, serviceID [32]byte) (*ServiceInfo, error) {
	return &ServiceInfo{}, nil
}

// FindServicesByCategory finds services by category
func (c *Client) FindServicesByCategory(ctx context.Context, category string) ([][32]byte, error) {
	return nil, nil
}

// CalculatePrice calculates price for a service
func (c *Client) CalculatePrice(ctx context.Context, serviceID [32]byte, quantity uint64) (*big.Int, error) {
	return big.NewInt(0), nil
}

// RequestQuote requests a quote for a service
func (c *Client) RequestQuote(ctx context.Context, serviceID [32]byte, quantity uint64, specs []byte) ([32]byte, error) {
	return [32]byte{}, nil
}

// AcceptQuote accepts a quote and makes payment
func (c *Client) AcceptQuote(ctx context.Context, quoteID [32]byte) (common.Hash, error) {
	return common.Hash{}, nil
}

// ==================== Channel Functions ====================

// OpenChannel opens a payment channel
func (c *Client) OpenChannel(ctx context.Context, counterparty common.Address, myDeposit, theirDeposit *big.Int) ([32]byte, error) {
	return [32]byte{}, nil
}

// GetChannel returns channel information
func (c *Client) GetChannel(ctx context.Context, party1, party2 common.Address) (*ChannelInfo, error) {
	return &ChannelInfo{}, nil
}

// SignChannelState signs a channel state update
func (c *Client) SignChannelState(channelID [32]byte, balance1, balance2 *big.Int, nonce uint64) ([]byte, error) {
	// Create message hash
	message := crypto.Keccak256(
		channelID[:],
		common.LeftPadBytes(balance1.Bytes(), 32),
		common.LeftPadBytes(balance2.Bytes(), 32),
		common.LeftPadBytes(big.NewInt(int64(nonce)).Bytes(), 32),
	)

	// Sign the message
	signature, err := crypto.Sign(message, c.privateKey)
	if err != nil {
		return nil, fmt.Errorf("failed to sign message: %w", err)
	}

	return signature, nil
}

// CooperativeClose cooperatively closes a channel
func (c *Client) CooperativeClose(ctx context.Context, counterparty common.Address, balance1, balance2 *big.Int, nonce uint64, sig1, sig2 []byte) (common.Hash, error) {
	return common.Hash{}, nil
}

// InitiateClose initiates unilateral channel close
func (c *Client) InitiateClose(ctx context.Context, counterparty common.Address, balance1, balance2 *big.Int, nonce uint64, sig1, sig2 []byte) (common.Hash, error) {
	return common.Hash{}, nil
}

// ChallengeClose challenges a channel close with newer state
func (c *Client) ChallengeClose(ctx context.Context, counterparty common.Address, balance1, balance2 *big.Int, nonce uint64, sig1, sig2 []byte) (common.Hash, error) {
	return common.Hash{}, nil
}

// FinalizeClose finalizes channel close after challenge period
func (c *Client) FinalizeClose(ctx context.Context, counterparty common.Address) (common.Hash, error) {
	return common.Hash{}, nil
}

// ==================== Utility Functions ====================

// NetworkInfo contains network information
type NetworkInfo struct {
	ChainID     *big.Int
	BlockNumber uint64
	GasPrice    *big.Int
}

// GetNetworkInfo returns network information
func (c *Client) GetNetworkInfo(ctx context.Context) (*NetworkInfo, error) {
	blockNumber, err := c.client.BlockNumber(ctx)
	if err != nil {
		return nil, err
	}

	gasPrice, err := c.client.SuggestGasPrice(ctx)
	if err != nil {
		return nil, err
	}

	return &NetworkInfo{
		ChainID:     c.chainID,
		BlockNumber: blockNumber,
		GasPrice:    gasPrice,
	}, nil
}

// WaitForTransaction waits for a transaction to be confirmed
func (c *Client) WaitForTransaction(ctx context.Context, txHash common.Hash) (*types.Receipt, error) {
	for {
		receipt, err := c.client.TransactionReceipt(ctx, txHash)
		if err == nil {
			return receipt, nil
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
			continue
		}
	}
}

// ParseSYNX parses a SYNX amount string to wei
func ParseSYNX(amount string) (*big.Int, error) {
	// Parse decimal string to big.Int with 18 decimals
	f, ok := new(big.Float).SetString(amount)
	if !ok {
		return nil, fmt.Errorf("invalid amount: %s", amount)
	}

	// Multiply by 10^18
	multiplier := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
	f.Mul(f, multiplier)

	// Convert to big.Int
	result, _ := f.Int(nil)
	return result, nil
}

// FormatSYNX formats wei amount to SYNX string
func FormatSYNX(amount *big.Int) string {
	if amount == nil {
		return "0"
	}

	// Divide by 10^18
	f := new(big.Float).SetInt(amount)
	divisor := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
	f.Quo(f, divisor)

	return f.Text('f', 6)
}
