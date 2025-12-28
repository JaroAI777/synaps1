using System;
using System.Numerics;
using System.Threading.Tasks;
using System.Collections.Generic;
using Nethereum.Web3;
using Nethereum.Contracts;
using Nethereum.Hex.HexTypes;
using Nethereum.Web3.Accounts;
using UnityEngine;

namespace SynapseProtocol.SDK
{
    /// <summary>
    /// SYNAPSE Protocol SDK for Unity
    /// Provides blockchain integration for games
    /// </summary>
    public class SynapseSDK
    {
        private readonly Web3 _web3;
        private readonly SynapseConfig _config;
        private Account _account;
        
        // Contract instances
        private Contract _tokenContract;
        private Contract _paymentRouter;
        private Contract _stakingContract;
        private Contract _achievementsContract;
        private Contract _marketplaceContract;

        public string ConnectedAddress => _account?.Address;
        public bool IsConnected => _account != null;

        #region Initialization

        public SynapseSDK(SynapseConfig config)
        {
            _config = config;
            _web3 = new Web3(config.RpcUrl);
            
            Debug.Log($"[SynapseSDK] Initialized for chain {config.ChainId}");
        }

        /// <summary>
        /// Connect with private key
        /// </summary>
        public void Connect(string privateKey)
        {
            _account = new Account(privateKey, _config.ChainId);
            _web3.TransactionManager.DefaultAccount = _account.Address;
            
            InitializeContracts();
            
            Debug.Log($"[SynapseSDK] Connected as {_account.Address}");
        }

        private void InitializeContracts()
        {
            _tokenContract = _web3.Eth.GetContract(ABIs.Token, _config.TokenAddress);
            _paymentRouter = _web3.Eth.GetContract(ABIs.PaymentRouter, _config.PaymentRouterAddress);
            _stakingContract = _web3.Eth.GetContract(ABIs.Staking, _config.StakingAddress);
            _achievementsContract = _web3.Eth.GetContract(ABIs.Achievements, _config.AchievementsAddress);
            _marketplaceContract = _web3.Eth.GetContract(ABIs.Marketplace, _config.MarketplaceAddress);
        }

        #endregion

        #region Token Operations

        /// <summary>
        /// Get SYNX token balance
        /// </summary>
        public async Task<BigInteger> GetBalance(string address = null)
        {
            address ??= _account.Address;
            var balanceFunc = _tokenContract.GetFunction("balanceOf");
            return await balanceFunc.CallAsync<BigInteger>(address);
        }

        /// <summary>
        /// Get formatted balance in SYNX
        /// </summary>
        public async Task<decimal> GetBalanceFormatted(string address = null)
        {
            var balance = await GetBalance(address);
            return Web3.Convert.FromWei(balance);
        }

        /// <summary>
        /// Transfer tokens
        /// </summary>
        public async Task<TransactionResult> Transfer(string to, BigInteger amount)
        {
            var transferFunc = _tokenContract.GetFunction("transfer");
            
            var gas = await transferFunc.EstimateGasAsync(_account.Address, null, null, to, amount);
            var receipt = await transferFunc.SendTransactionAndWaitForReceiptAsync(
                _account.Address, gas, null, null, to, amount
            );

            return new TransactionResult
            {
                Success = receipt.Status.Value == 1,
                TransactionHash = receipt.TransactionHash,
                GasUsed = receipt.GasUsed.Value
            };
        }

        /// <summary>
        /// Approve spending
        /// </summary>
        public async Task<TransactionResult> Approve(string spender, BigInteger amount)
        {
            var approveFunc = _tokenContract.GetFunction("approve");
            
            var receipt = await approveFunc.SendTransactionAndWaitForReceiptAsync(
                _account.Address, null, null, null, spender, amount
            );

            return new TransactionResult
            {
                Success = receipt.Status.Value == 1,
                TransactionHash = receipt.TransactionHash
            };
        }

        #endregion

        #region Payment Operations

        /// <summary>
        /// Send payment to another address
        /// </summary>
        public async Task<PaymentResult> SendPayment(string recipient, BigInteger amount, string metadata = "")
        {
            // Ensure approval
            await EnsureApproval(_config.PaymentRouterAddress, amount);

            var payFunc = _paymentRouter.GetFunction("pay");
            var receipt = await payFunc.SendTransactionAndWaitForReceiptAsync(
                _account.Address, null, null, null, recipient, amount, metadata
            );

            // Parse payment ID from event
            var paymentEvent = receipt.DecodeAllEvents<PaymentSentEventDTO>();
            var paymentId = paymentEvent.Count > 0 ? paymentEvent[0].Event.PaymentId : null;

            return new PaymentResult
            {
                Success = receipt.Status.Value == 1,
                TransactionHash = receipt.TransactionHash,
                PaymentId = paymentId,
                Amount = amount
            };
        }

        /// <summary>
        /// Create escrow payment
        /// </summary>
        public async Task<EscrowResult> CreateEscrow(
            string recipient, 
            BigInteger amount, 
            uint deadline,
            string arbiter = null)
        {
            await EnsureApproval(_config.PaymentRouterAddress, amount);

            var escrowFunc = _paymentRouter.GetFunction("createEscrow");
            var receipt = await escrowFunc.SendTransactionAndWaitForReceiptAsync(
                _account.Address, null, null, null,
                recipient, arbiter ?? "0x0000000000000000000000000000000000000000", amount, deadline
            );

            var escrowEvent = receipt.DecodeAllEvents<EscrowCreatedEventDTO>();

            return new EscrowResult
            {
                Success = receipt.Status.Value == 1,
                TransactionHash = receipt.TransactionHash,
                EscrowId = escrowEvent.Count > 0 ? escrowEvent[0].Event.EscrowId : null,
                Amount = amount,
                Deadline = deadline
            };
        }

        /// <summary>
        /// Release escrow payment
        /// </summary>
        public async Task<TransactionResult> ReleaseEscrow(byte[] escrowId)
        {
            var releaseFunc = _paymentRouter.GetFunction("releaseEscrow");
            var receipt = await releaseFunc.SendTransactionAndWaitForReceiptAsync(
                _account.Address, null, null, null, escrowId
            );

            return new TransactionResult
            {
                Success = receipt.Status.Value == 1,
                TransactionHash = receipt.TransactionHash
            };
        }

        #endregion

        #region Staking Operations

        /// <summary>
        /// Stake tokens
        /// </summary>
        public async Task<TransactionResult> Stake(BigInteger amount, byte lockTier = 0)
        {
            await EnsureApproval(_config.StakingAddress, amount);

            var stakeFunc = _stakingContract.GetFunction("stake");
            var receipt = await stakeFunc.SendTransactionAndWaitForReceiptAsync(
                _account.Address, null, null, null, amount, lockTier
            );

            return new TransactionResult
            {
                Success = receipt.Status.Value == 1,
                TransactionHash = receipt.TransactionHash
            };
        }

        /// <summary>
        /// Unstake tokens
        /// </summary>
        public async Task<TransactionResult> Unstake(BigInteger amount)
        {
            var unstakeFunc = _stakingContract.GetFunction("unstake");
            var receipt = await unstakeFunc.SendTransactionAndWaitForReceiptAsync(
                _account.Address, null, null, null, amount
            );

            return new TransactionResult
            {
                Success = receipt.Status.Value == 1,
                TransactionHash = receipt.TransactionHash
            };
        }

        /// <summary>
        /// Claim staking rewards
        /// </summary>
        public async Task<TransactionResult> ClaimRewards()
        {
            var claimFunc = _stakingContract.GetFunction("claimRewards");
            var receipt = await claimFunc.SendTransactionAndWaitForReceiptAsync(
                _account.Address, null, null, null
            );

            return new TransactionResult
            {
                Success = receipt.Status.Value == 1,
                TransactionHash = receipt.TransactionHash
            };
        }

        /// <summary>
        /// Get staking info
        /// </summary>
        public async Task<StakeInfo> GetStakeInfo(string address = null)
        {
            address ??= _account.Address;
            var getInfoFunc = _stakingContract.GetFunction("getStakeInfo");
            var result = await getInfoFunc.CallDeserializingToObjectAsync<StakeInfoDTO>(address);

            return new StakeInfo
            {
                Amount = result.Amount,
                LockTier = result.LockTier,
                LockEnd = result.LockEnd,
                PendingRewards = result.PendingRewards
            };
        }

        /// <summary>
        /// Get pending rewards
        /// </summary>
        public async Task<BigInteger> GetPendingRewards(string address = null)
        {
            address ??= _account.Address;
            var earnedFunc = _stakingContract.GetFunction("earned");
            return await earnedFunc.CallAsync<BigInteger>(address);
        }

        #endregion

        #region Achievements (NFT)

        /// <summary>
        /// Get user achievements
        /// </summary>
        public async Task<List<Achievement>> GetAchievements(string address = null)
        {
            address ??= _account.Address;
            var getFunc = _achievementsContract.GetFunction("getUserAchievements");
            var result = await getFunc.CallAsync<List<BigInteger>>(address);

            var achievements = new List<Achievement>();
            foreach (var id in result)
            {
                var achievement = await GetAchievementDetails(id);
                if (achievement != null)
                {
                    achievements.Add(achievement);
                }
            }

            return achievements;
        }

        /// <summary>
        /// Get achievement details
        /// </summary>
        public async Task<Achievement> GetAchievementDetails(BigInteger achievementId)
        {
            var getFunc = _achievementsContract.GetFunction("getAchievement");
            var result = await getFunc.CallDeserializingToObjectAsync<AchievementDTO>(achievementId);

            return new Achievement
            {
                Id = achievementId,
                Name = result.Name,
                Description = result.Description,
                Category = result.Category,
                Points = result.Points,
                Rarity = result.Rarity
            };
        }

        /// <summary>
        /// Check if user has achievement
        /// </summary>
        public async Task<bool> HasAchievement(BigInteger achievementId, string address = null)
        {
            address ??= _account.Address;
            var hasFunc = _achievementsContract.GetFunction("hasAchievement");
            return await hasFunc.CallAsync<bool>(address, achievementId);
        }

        #endregion

        #region NFT Marketplace

        /// <summary>
        /// Get listing details
        /// </summary>
        public async Task<NFTListing> GetListing(BigInteger listingId)
        {
            var getFunc = _marketplaceContract.GetFunction("getListing");
            var result = await getFunc.CallDeserializingToObjectAsync<ListingDTO>(listingId);

            return new NFTListing
            {
                ListingId = listingId,
                Seller = result.Seller,
                NFTContract = result.NFTContract,
                TokenId = result.TokenId,
                Price = result.Price,
                Status = (ListingStatus)result.Status
            };
        }

        /// <summary>
        /// Buy NFT listing
        /// </summary>
        public async Task<TransactionResult> BuyListing(BigInteger listingId)
        {
            var listing = await GetListing(listingId);
            await EnsureApproval(_config.MarketplaceAddress, listing.Price);

            var buyFunc = _marketplaceContract.GetFunction("buyListing");
            var receipt = await buyFunc.SendTransactionAndWaitForReceiptAsync(
                _account.Address, null, null, null, listingId
            );

            return new TransactionResult
            {
                Success = receipt.Status.Value == 1,
                TransactionHash = receipt.TransactionHash
            };
        }

        #endregion

        #region Utilities

        private async Task EnsureApproval(string spender, BigInteger amount)
        {
            var allowanceFunc = _tokenContract.GetFunction("allowance");
            var currentAllowance = await allowanceFunc.CallAsync<BigInteger>(_account.Address, spender);

            if (currentAllowance < amount)
            {
                var maxApproval = BigInteger.Parse("115792089237316195423570985008687907853269984665640564039457584007913129639935");
                await Approve(spender, maxApproval);
            }
        }

        /// <summary>
        /// Format wei to SYNX
        /// </summary>
        public static decimal FromWei(BigInteger wei)
        {
            return Web3.Convert.FromWei(wei);
        }

        /// <summary>
        /// Format SYNX to wei
        /// </summary>
        public static BigInteger ToWei(decimal amount)
        {
            return Web3.Convert.ToWei(amount);
        }

        /// <summary>
        /// Validate address
        /// </summary>
        public static bool IsValidAddress(string address)
        {
            return Nethereum.Util.AddressUtil.Current.IsValidEthereumAddressHexFormat(address);
        }

        #endregion
    }

    #region Configuration

    [Serializable]
    public class SynapseConfig
    {
        public string RpcUrl;
        public int ChainId;
        public string TokenAddress;
        public string PaymentRouterAddress;
        public string StakingAddress;
        public string AchievementsAddress;
        public string MarketplaceAddress;

        public static SynapseConfig ArbitrumMainnet => new SynapseConfig
        {
            RpcUrl = "https://arb1.arbitrum.io/rpc",
            ChainId = 42161
        };

        public static SynapseConfig ArbitrumSepolia => new SynapseConfig
        {
            RpcUrl = "https://sepolia-rollup.arbitrum.io/rpc",
            ChainId = 421614
        };
    }

    #endregion

    #region Data Models

    public class TransactionResult
    {
        public bool Success;
        public string TransactionHash;
        public BigInteger GasUsed;
    }

    public class PaymentResult : TransactionResult
    {
        public byte[] PaymentId;
        public BigInteger Amount;
    }

    public class EscrowResult : TransactionResult
    {
        public byte[] EscrowId;
        public BigInteger Amount;
        public uint Deadline;
    }

    public class StakeInfo
    {
        public BigInteger Amount;
        public byte LockTier;
        public BigInteger LockEnd;
        public BigInteger PendingRewards;

        public decimal FormattedAmount => SynapseSDK.FromWei(Amount);
        public decimal FormattedRewards => SynapseSDK.FromWei(PendingRewards);
    }

    public class Achievement
    {
        public BigInteger Id;
        public string Name;
        public string Description;
        public byte Category;
        public uint Points;
        public byte Rarity;
    }

    public class NFTListing
    {
        public BigInteger ListingId;
        public string Seller;
        public string NFTContract;
        public BigInteger TokenId;
        public BigInteger Price;
        public ListingStatus Status;

        public decimal FormattedPrice => SynapseSDK.FromWei(Price);
    }

    public enum ListingStatus
    {
        Active,
        Sold,
        Cancelled,
        Expired
    }

    #endregion

    #region DTOs (Data Transfer Objects)

    public class StakeInfoDTO
    {
        public BigInteger Amount { get; set; }
        public byte LockTier { get; set; }
        public BigInteger LockEnd { get; set; }
        public BigInteger PendingRewards { get; set; }
        public BigInteger LastClaim { get; set; }
    }

    public class AchievementDTO
    {
        public string Name { get; set; }
        public string Description { get; set; }
        public byte Category { get; set; }
        public uint Points { get; set; }
        public byte Rarity { get; set; }
    }

    public class ListingDTO
    {
        public string Seller { get; set; }
        public string NFTContract { get; set; }
        public BigInteger TokenId { get; set; }
        public BigInteger Price { get; set; }
        public byte Status { get; set; }
    }

    public class PaymentSentEventDTO
    {
        public string Sender { get; set; }
        public string Recipient { get; set; }
        public BigInteger Amount { get; set; }
        public BigInteger Fee { get; set; }
        public byte[] PaymentId { get; set; }
    }

    public class EscrowCreatedEventDTO
    {
        public byte[] EscrowId { get; set; }
        public string Sender { get; set; }
        public string Recipient { get; set; }
        public BigInteger Amount { get; set; }
    }

    #endregion

    #region ABIs

    public static class ABIs
    {
        public const string Token = @"[
            {""constant"":true,""inputs"":[{""name"":""account"",""type"":""address""}],""name"":""balanceOf"",""outputs"":[{""name"":"""",""type"":""uint256""}],""type"":""function""},
            {""constant"":false,""inputs"":[{""name"":""to"",""type"":""address""},{""name"":""amount"",""type"":""uint256""}],""name"":""transfer"",""outputs"":[{""name"":"""",""type"":""bool""}],""type"":""function""},
            {""constant"":false,""inputs"":[{""name"":""spender"",""type"":""address""},{""name"":""amount"",""type"":""uint256""}],""name"":""approve"",""outputs"":[{""name"":"""",""type"":""bool""}],""type"":""function""},
            {""constant"":true,""inputs"":[{""name"":""owner"",""type"":""address""},{""name"":""spender"",""type"":""address""}],""name"":""allowance"",""outputs"":[{""name"":"""",""type"":""uint256""}],""type"":""function""}
        ]";

        public const string PaymentRouter = @"[
            {""inputs"":[{""name"":""recipient"",""type"":""address""},{""name"":""amount"",""type"":""uint256""},{""name"":""metadata"",""type"":""string""}],""name"":""pay"",""outputs"":[{""name"":"""",""type"":""bytes32""}],""type"":""function""},
            {""inputs"":[{""name"":""recipient"",""type"":""address""},{""name"":""arbiter"",""type"":""address""},{""name"":""amount"",""type"":""uint256""},{""name"":""deadline"",""type"":""uint256""}],""name"":""createEscrow"",""outputs"":[{""name"":"""",""type"":""bytes32""}],""type"":""function""},
            {""inputs"":[{""name"":""escrowId"",""type"":""bytes32""}],""name"":""releaseEscrow"",""outputs"":[],""type"":""function""}
        ]";

        public const string Staking = @"[
            {""inputs"":[{""name"":""amount"",""type"":""uint256""},{""name"":""lockTier"",""type"":""uint8""}],""name"":""stake"",""outputs"":[],""type"":""function""},
            {""inputs"":[{""name"":""amount"",""type"":""uint256""}],""name"":""unstake"",""outputs"":[],""type"":""function""},
            {""inputs"":[],""name"":""claimRewards"",""outputs"":[],""type"":""function""},
            {""inputs"":[{""name"":""user"",""type"":""address""}],""name"":""getStakeInfo"",""outputs"":[{""components"":[{""name"":""amount"",""type"":""uint256""},{""name"":""lockTier"",""type"":""uint8""},{""name"":""lockEnd"",""type"":""uint256""},{""name"":""pendingRewards"",""type"":""uint256""},{""name"":""lastClaim"",""type"":""uint256""}],""name"":"""",""type"":""tuple""}],""type"":""function""},
            {""inputs"":[{""name"":""user"",""type"":""address""}],""name"":""earned"",""outputs"":[{""name"":"""",""type"":""uint256""}],""type"":""function""}
        ]";

        public const string Achievements = @"[
            {""inputs"":[{""name"":""user"",""type"":""address""}],""name"":""getUserAchievements"",""outputs"":[{""name"":"""",""type"":""uint256[]""}],""type"":""function""},
            {""inputs"":[{""name"":""achievementId"",""type"":""uint256""}],""name"":""getAchievement"",""outputs"":[{""components"":[{""name"":""name"",""type"":""string""},{""name"":""description"",""type"":""string""},{""name"":""category"",""type"":""uint8""},{""name"":""points"",""type"":""uint32""},{""name"":""rarity"",""type"":""uint8""}],""name"":"""",""type"":""tuple""}],""type"":""function""},
            {""inputs"":[{""name"":""user"",""type"":""address""},{""name"":""achievementId"",""type"":""uint256""}],""name"":""hasAchievement"",""outputs"":[{""name"":"""",""type"":""bool""}],""type"":""function""}
        ]";

        public const string Marketplace = @"[
            {""inputs"":[{""name"":""listingId"",""type"":""uint256""}],""name"":""getListing"",""outputs"":[{""components"":[{""name"":""seller"",""type"":""address""},{""name"":""nftContract"",""type"":""address""},{""name"":""tokenId"",""type"":""uint256""},{""name"":""price"",""type"":""uint256""},{""name"":""status"",""type"":""uint8""}],""name"":"""",""type"":""tuple""}],""type"":""function""},
            {""inputs"":[{""name"":""listingId"",""type"":""uint256""}],""name"":""buyListing"",""outputs"":[],""type"":""function""}
        ]";
    }

    #endregion
}
