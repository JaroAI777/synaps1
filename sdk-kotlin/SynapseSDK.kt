/**
 * SYNAPSE Protocol Kotlin SDK
 * 
 * For Android applications and Kotlin backend services
 * 
 * Implementation:
 *   implementation("ai.synapse:synapse-sdk:1.0.0")
 */

package ai.synapse.sdk

import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.web3j.abi.FunctionEncoder
import org.web3j.abi.FunctionReturnDecoder
import org.web3j.abi.TypeReference
import org.web3j.abi.datatypes.*
import org.web3j.abi.datatypes.generated.Uint256
import org.web3j.crypto.Credentials
import org.web3j.crypto.RawTransaction
import org.web3j.crypto.TransactionEncoder
import org.web3j.protocol.Web3j
import org.web3j.protocol.core.DefaultBlockParameterName
import org.web3j.protocol.http.HttpService
import org.web3j.tx.gas.DefaultGasProvider
import org.web3j.utils.Convert
import org.web3j.utils.Numeric
import java.math.BigDecimal
import java.math.BigInteger

/**
 * Configuration for the SDK
 */
data class SynapseConfig(
    val rpcUrl: String = "https://arb1.arbitrum.io/rpc",
    val chainId: Long = 42161,
    val tokenAddress: String = "",
    val routerAddress: String = "",
    val stakingAddress: String = "",
    val apiBaseUrl: String = "https://api.synapse.ai"
)

/**
 * Transaction result
 */
data class TransactionResult(
    val hash: String,
    val from: String,
    val to: String,
    val value: BigInteger,
    val success: Boolean,
    val blockNumber: Long? = null,
    val gasUsed: BigInteger? = null
)

/**
 * Stake information
 */
data class StakeInfo(
    val amount: BigDecimal,
    val lockTier: Int,
    val lockEnd: Long,
    val pendingRewards: BigDecimal
) {
    val isLocked: Boolean get() = lockEnd > System.currentTimeMillis() / 1000
    
    fun getFormattedAmount(): String = "$amount SYNX"
    fun getFormattedRewards(): String = "$pendingRewards SYNX"
}

/**
 * Payment details
 */
data class PaymentInfo(
    val paymentId: String,
    val sender: String,
    val recipient: String,
    val amount: BigDecimal,
    val timestamp: Long,
    val status: PaymentStatus,
    val metadata: String? = null
)

enum class PaymentStatus {
    PENDING, COMPLETED, FAILED, REFUNDED
}

/**
 * Escrow details
 */
data class EscrowInfo(
    val escrowId: String,
    val sender: String,
    val recipient: String,
    val arbiter: String?,
    val amount: BigDecimal,
    val deadline: Long,
    val status: EscrowStatus
)

enum class EscrowStatus {
    ACTIVE, RELEASED, REFUNDED, DISPUTED, EXPIRED
}

/**
 * Main SDK Client
 */
class SynapseClient(
    private val config: SynapseConfig
) {
    private val web3j: Web3j = Web3j.build(HttpService(config.rpcUrl))
    private val httpClient = OkHttpClient.Builder().build()
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
    
    private var credentials: Credentials? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /**
     * Set signer with private key
     */
    fun setSigner(privateKey: String): SynapseClient {
        credentials = Credentials.create(privateKey)
        return this
    }

    /**
     * Get connected address
     */
    fun getAddress(): String? = credentials?.address

    // ============ Token Operations ============

    /**
     * Get token balance
     */
    suspend fun getBalance(address: String? = null): BigDecimal = withContext(Dispatchers.IO) {
        val targetAddress = address ?: credentials?.address 
            ?: throw IllegalStateException("No address provided")

        val function = Function(
            "balanceOf",
            listOf(Address(targetAddress)),
            listOf(object : TypeReference<Uint256>() {})
        )

        val encodedFunction = FunctionEncoder.encode(function)
        val response = web3j.ethCall(
            org.web3j.protocol.core.methods.request.Transaction.createEthCallTransaction(
                targetAddress, config.tokenAddress, encodedFunction
            ),
            DefaultBlockParameterName.LATEST
        ).send()

        val results = FunctionReturnDecoder.decode(response.value, function.outputParameters)
        val balance = results[0] as Uint256

        Convert.fromWei(BigDecimal(balance.value), Convert.Unit.ETHER)
    }

    /**
     * Transfer tokens
     */
    suspend fun transfer(to: String, amount: BigDecimal): TransactionResult = withContext(Dispatchers.IO) {
        requireSigner()

        val amountWei = Convert.toWei(amount, Convert.Unit.ETHER).toBigInteger()

        val function = Function(
            "transfer",
            listOf(Address(to), Uint256(amountWei)),
            listOf(object : TypeReference<Bool>() {})
        )

        sendTransaction(config.tokenAddress, BigInteger.ZERO, FunctionEncoder.encode(function))
    }

    /**
     * Approve token spending
     */
    suspend fun approve(spender: String, amount: BigDecimal): TransactionResult = withContext(Dispatchers.IO) {
        requireSigner()

        val amountWei = Convert.toWei(amount, Convert.Unit.ETHER).toBigInteger()

        val function = Function(
            "approve",
            listOf(Address(spender), Uint256(amountWei)),
            emptyList()
        )

        sendTransaction(config.tokenAddress, BigInteger.ZERO, FunctionEncoder.encode(function))
    }

    /**
     * Get allowance
     */
    suspend fun getAllowance(owner: String, spender: String): BigDecimal = withContext(Dispatchers.IO) {
        val function = Function(
            "allowance",
            listOf(Address(owner), Address(spender)),
            listOf(object : TypeReference<Uint256>() {})
        )

        val encodedFunction = FunctionEncoder.encode(function)
        val response = web3j.ethCall(
            org.web3j.protocol.core.methods.request.Transaction.createEthCallTransaction(
                owner, config.tokenAddress, encodedFunction
            ),
            DefaultBlockParameterName.LATEST
        ).send()

        val results = FunctionReturnDecoder.decode(response.value, function.outputParameters)
        val allowance = results[0] as Uint256

        Convert.fromWei(BigDecimal(allowance.value), Convert.Unit.ETHER)
    }

    // ============ Payment Operations ============

    /**
     * Send payment
     */
    suspend fun sendPayment(
        recipient: String,
        amount: BigDecimal,
        metadata: String = ""
    ): TransactionResult = withContext(Dispatchers.IO) {
        requireSigner()

        // Ensure approval
        ensureApproval(config.routerAddress, amount)

        val amountWei = Convert.toWei(amount, Convert.Unit.ETHER).toBigInteger()

        val function = Function(
            "pay",
            listOf(
                Address(recipient),
                Uint256(amountWei),
                Utf8String(metadata)
            ),
            emptyList()
        )

        sendTransaction(config.routerAddress, BigInteger.ZERO, FunctionEncoder.encode(function))
    }

    /**
     * Create escrow payment
     */
    suspend fun createEscrow(
        recipient: String,
        amount: BigDecimal,
        deadline: Long,
        arbiter: String? = null
    ): TransactionResult = withContext(Dispatchers.IO) {
        requireSigner()

        ensureApproval(config.routerAddress, amount)

        val amountWei = Convert.toWei(amount, Convert.Unit.ETHER).toBigInteger()
        val arbiterAddress = arbiter ?: "0x0000000000000000000000000000000000000000"

        val function = Function(
            "createEscrow",
            listOf(
                Address(recipient),
                Address(arbiterAddress),
                Uint256(amountWei),
                Uint256(BigInteger.valueOf(deadline))
            ),
            emptyList()
        )

        sendTransaction(config.routerAddress, BigInteger.ZERO, FunctionEncoder.encode(function))
    }

    /**
     * Release escrow
     */
    suspend fun releaseEscrow(escrowId: String): TransactionResult = withContext(Dispatchers.IO) {
        requireSigner()

        val function = Function(
            "releaseEscrow",
            listOf(Bytes32(Numeric.hexStringToByteArray(escrowId))),
            emptyList()
        )

        sendTransaction(config.routerAddress, BigInteger.ZERO, FunctionEncoder.encode(function))
    }

    // ============ Staking Operations ============

    /**
     * Stake tokens
     */
    suspend fun stake(amount: BigDecimal, lockTier: Int = 0): TransactionResult = withContext(Dispatchers.IO) {
        requireSigner()

        ensureApproval(config.stakingAddress, amount)

        val amountWei = Convert.toWei(amount, Convert.Unit.ETHER).toBigInteger()

        val function = Function(
            "stake",
            listOf(Uint256(amountWei), Uint256(BigInteger.valueOf(lockTier.toLong()))),
            emptyList()
        )

        sendTransaction(config.stakingAddress, BigInteger.ZERO, FunctionEncoder.encode(function))
    }

    /**
     * Unstake tokens
     */
    suspend fun unstake(amount: BigDecimal): TransactionResult = withContext(Dispatchers.IO) {
        requireSigner()

        val amountWei = Convert.toWei(amount, Convert.Unit.ETHER).toBigInteger()

        val function = Function(
            "unstake",
            listOf(Uint256(amountWei)),
            emptyList()
        )

        sendTransaction(config.stakingAddress, BigInteger.ZERO, FunctionEncoder.encode(function))
    }

    /**
     * Claim staking rewards
     */
    suspend fun claimRewards(): TransactionResult = withContext(Dispatchers.IO) {
        requireSigner()

        val function = Function(
            "claimRewards",
            emptyList(),
            emptyList()
        )

        sendTransaction(config.stakingAddress, BigInteger.ZERO, FunctionEncoder.encode(function))
    }

    /**
     * Get stake info
     */
    suspend fun getStakeInfo(address: String? = null): StakeInfo = withContext(Dispatchers.IO) {
        val targetAddress = address ?: credentials?.address
            ?: throw IllegalStateException("No address provided")

        val function = Function(
            "getStakeInfo",
            listOf(Address(targetAddress)),
            listOf(
                object : TypeReference<Uint256>() {},
                object : TypeReference<Uint256>() {},
                object : TypeReference<Uint256>() {},
                object : TypeReference<Uint256>() {}
            )
        )

        val encodedFunction = FunctionEncoder.encode(function)
        val response = web3j.ethCall(
            org.web3j.protocol.core.methods.request.Transaction.createEthCallTransaction(
                targetAddress, config.stakingAddress, encodedFunction
            ),
            DefaultBlockParameterName.LATEST
        ).send()

        val results = FunctionReturnDecoder.decode(response.value, function.outputParameters)

        StakeInfo(
            amount = Convert.fromWei(BigDecimal((results[0] as Uint256).value), Convert.Unit.ETHER),
            lockTier = (results[1] as Uint256).value.toInt(),
            lockEnd = (results[2] as Uint256).value.toLong(),
            pendingRewards = Convert.fromWei(BigDecimal((results[3] as Uint256).value), Convert.Unit.ETHER)
        )
    }

    /**
     * Get pending rewards
     */
    suspend fun getPendingRewards(address: String? = null): BigDecimal = withContext(Dispatchers.IO) {
        val targetAddress = address ?: credentials?.address
            ?: throw IllegalStateException("No address provided")

        val function = Function(
            "earned",
            listOf(Address(targetAddress)),
            listOf(object : TypeReference<Uint256>() {})
        )

        val encodedFunction = FunctionEncoder.encode(function)
        val response = web3j.ethCall(
            org.web3j.protocol.core.methods.request.Transaction.createEthCallTransaction(
                targetAddress, config.stakingAddress, encodedFunction
            ),
            DefaultBlockParameterName.LATEST
        ).send()

        val results = FunctionReturnDecoder.decode(response.value, function.outputParameters)
        Convert.fromWei(BigDecimal((results[0] as Uint256).value), Convert.Unit.ETHER)
    }

    // ============ API Calls ============

    /**
     * Get payment history from API
     */
    suspend fun getPaymentHistory(address: String? = null, limit: Int = 50): List<PaymentInfo> = 
        withContext(Dispatchers.IO) {
            val targetAddress = address ?: credentials?.address
                ?: throw IllegalStateException("No address provided")

            val request = Request.Builder()
                .url("${config.apiBaseUrl}/api/payments/$targetAddress?limit=$limit")
                .get()
                .build()

            val response = httpClient.newCall(request).execute()
            val body = response.body?.string() ?: return@withContext emptyList()

            val json = JSONObject(body)
            val payments = json.getJSONArray("payments")

            (0 until payments.length()).map { i ->
                val p = payments.getJSONObject(i)
                PaymentInfo(
                    paymentId = p.getString("paymentId"),
                    sender = p.getString("sender"),
                    recipient = p.getString("recipient"),
                    amount = BigDecimal(p.getString("amount")),
                    timestamp = p.getLong("timestamp"),
                    status = PaymentStatus.valueOf(p.getString("status").uppercase()),
                    metadata = p.optString("metadata")
                )
            }
        }

    /**
     * Get price from oracle
     */
    suspend fun getTokenPrice(): BigDecimal = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${config.apiBaseUrl}/api/price/synx")
            .get()
            .build()

        val response = httpClient.newCall(request).execute()
        val body = response.body?.string() ?: throw Exception("Empty response")

        val json = JSONObject(body)
        BigDecimal(json.getString("price"))
    }

    // ============ Internal Functions ============

    private fun requireSigner() {
        if (credentials == null) {
            throw IllegalStateException("No signer set. Call setSigner() first.")
        }
    }

    private suspend fun ensureApproval(spender: String, amount: BigDecimal) {
        val currentAllowance = getAllowance(credentials!!.address, spender)
        if (currentAllowance < amount) {
            // Approve max
            approve(spender, BigDecimal("115792089237316195423570985008687907853269984665640564039457584007913129639935"))
        }
    }

    private suspend fun sendTransaction(
        to: String,
        value: BigInteger,
        data: String
    ): TransactionResult = withContext(Dispatchers.IO) {
        val nonce = web3j.ethGetTransactionCount(
            credentials!!.address,
            DefaultBlockParameterName.PENDING
        ).send().transactionCount

        val gasPrice = web3j.ethGasPrice().send().gasPrice
        val gasLimit = estimateGas(to, value, data)

        val rawTransaction = RawTransaction.createTransaction(
            nonce,
            gasPrice,
            gasLimit,
            to,
            value,
            data
        )

        val signedMessage = TransactionEncoder.signMessage(rawTransaction, config.chainId, credentials)
        val hexValue = Numeric.toHexString(signedMessage)

        val transactionHash = web3j.ethSendRawTransaction(hexValue).send().transactionHash

        TransactionResult(
            hash = transactionHash,
            from = credentials!!.address,
            to = to,
            value = value,
            success = true
        )
    }

    private suspend fun estimateGas(to: String, value: BigInteger, data: String): BigInteger {
        return try {
            val estimate = web3j.ethEstimateGas(
                org.web3j.protocol.core.methods.request.Transaction.createFunctionCallTransaction(
                    credentials!!.address,
                    null,
                    null,
                    null,
                    to,
                    value,
                    data
                )
            ).send()

            // Add 20% buffer
            estimate.amountUsed.multiply(BigInteger.valueOf(120)).divide(BigInteger.valueOf(100))
        } catch (e: Exception) {
            DefaultGasProvider.GAS_LIMIT
        }
    }

    /**
     * Cleanup resources
     */
    fun shutdown() {
        scope.cancel()
        web3j.shutdown()
    }
}

/**
 * Builder for SynapseClient
 */
class SynapseClientBuilder {
    private var config = SynapseConfig()
    private var privateKey: String? = null

    fun rpcUrl(url: String) = apply { config = config.copy(rpcUrl = url) }
    fun chainId(id: Long) = apply { config = config.copy(chainId = id) }
    fun tokenAddress(address: String) = apply { config = config.copy(tokenAddress = address) }
    fun routerAddress(address: String) = apply { config = config.copy(routerAddress = address) }
    fun stakingAddress(address: String) = apply { config = config.copy(stakingAddress = address) }
    fun apiBaseUrl(url: String) = apply { config = config.copy(apiBaseUrl = url) }
    fun privateKey(key: String) = apply { privateKey = key }

    fun build(): SynapseClient {
        val client = SynapseClient(config)
        privateKey?.let { client.setSigner(it) }
        return client
    }
}

// Extension functions for easy usage
fun synapseClient(block: SynapseClientBuilder.() -> Unit): SynapseClient {
    return SynapseClientBuilder().apply(block).build()
}
