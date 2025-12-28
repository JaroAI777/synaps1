/**
 * SYNAPSE Protocol - Swift SDK for iOS
 * 
 * Native iOS SDK for SYNAPSE Protocol integration
 */

import Foundation
import Combine
import CryptoKit

// MARK: - Configuration

public struct SynapseConfig {
    public let rpcUrl: String
    public let contracts: ContractAddresses
    public var privateKey: String?
    
    public init(rpcUrl: String, contracts: ContractAddresses, privateKey: String? = nil) {
        self.rpcUrl = rpcUrl
        self.contracts = contracts
        self.privateKey = privateKey
    }
}

public struct ContractAddresses {
    public let token: String
    public let paymentRouter: String
    public let reputation: String
    public let serviceRegistry: String
    public let paymentChannel: String
    
    public init(
        token: String,
        paymentRouter: String,
        reputation: String,
        serviceRegistry: String,
        paymentChannel: String
    ) {
        self.token = token
        self.paymentRouter = paymentRouter
        self.reputation = reputation
        self.serviceRegistry = serviceRegistry
        self.paymentChannel = paymentChannel
    }
}

// MARK: - Enums

public enum AgentTier: Int, Codable {
    case unverified = 0
    case bronze = 1
    case silver = 2
    case gold = 3
    case platinum = 4
    case diamond = 5
    
    public var name: String {
        switch self {
        case .unverified: return "Unverified"
        case .bronze: return "Bronze"
        case .silver: return "Silver"
        case .gold: return "Gold"
        case .platinum: return "Platinum"
        case .diamond: return "Diamond"
        }
    }
}

public enum PricingModel: Int, Codable {
    case perRequest = 0
    case perToken = 1
    case perSecond = 2
    case perByte = 3
    case subscription = 4
    case custom = 5
}

public enum SynapseError: Error, LocalizedError {
    case networkError(String)
    case contractError(String)
    case insufficientBalance
    case invalidAddress
    case transactionFailed(String)
    case unauthorized
    case notInitialized
    
    public var errorDescription: String? {
        switch self {
        case .networkError(let msg): return "Network error: \(msg)"
        case .contractError(let msg): return "Contract error: \(msg)"
        case .insufficientBalance: return "Insufficient balance"
        case .invalidAddress: return "Invalid address format"
        case .transactionFailed(let msg): return "Transaction failed: \(msg)"
        case .unauthorized: return "Unauthorized"
        case .notInitialized: return "SDK not initialized"
        }
    }
}

// MARK: - Models

public struct WalletInfo: Codable {
    public let address: String
    public let balance: String
    public let network: String
}

public struct AgentInfo: Codable {
    public let address: String
    public let name: String
    public let metadataUri: String
    public let stake: String
    public let reputationScore: Int
    public let tier: AgentTier
    public let totalTransactions: Int
    public let successfulTransactions: Int
    public let registeredAt: Date
    
    public var successRate: Double {
        guard totalTransactions > 0 else { return 0 }
        return Double(successfulTransactions) / Double(totalTransactions) * 100
    }
}

public struct ServiceInfo: Codable {
    public let serviceId: String
    public let provider: String
    public let name: String
    public let category: String
    public let description: String
    public let endpoint: String
    public let basePrice: String
    public let pricingModel: PricingModel
    public let active: Bool
    public let createdAt: Date
}

public struct PaymentResult: Codable {
    public let transactionHash: String
    public let paymentId: String
    public let sender: String
    public let recipient: String
    public let amount: String
    public let fee: String
    public let timestamp: Date
}

public struct TransactionHistory: Codable {
    public let transactions: [PaymentResult]
    public let totalCount: Int
    public let page: Int
}

// MARK: - Network Layer

class NetworkManager {
    private let session: URLSession
    private let baseUrl: String
    
    init(rpcUrl: String) {
        self.baseUrl = rpcUrl
        
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)
    }
    
    func jsonRpcCall<T: Decodable>(
        method: String,
        params: [Any]
    ) async throws -> T {
        var request = URLRequest(url: URL(string: baseUrl)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body: [String: Any] = [
            "jsonrpc": "2.0",
            "id": Int.random(in: 1...999999),
            "method": method,
            "params": params
        ]
        
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        let (data, response) = try await session.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw SynapseError.networkError("Invalid response")
        }
        
        let decoder = JSONDecoder()
        let rpcResponse = try decoder.decode(JsonRpcResponse<T>.self, from: data)
        
        if let error = rpcResponse.error {
            throw SynapseError.contractError(error.message)
        }
        
        guard let result = rpcResponse.result else {
            throw SynapseError.networkError("Empty response")
        }
        
        return result
    }
}

struct JsonRpcResponse<T: Decodable>: Decodable {
    let jsonrpc: String
    let id: Int
    let result: T?
    let error: JsonRpcError?
}

struct JsonRpcError: Decodable {
    let code: Int
    let message: String
}

// MARK: - Keychain Manager

class KeychainManager {
    static let shared = KeychainManager()
    
    private let service = "com.synapse.protocol"
    
    func savePrivateKey(_ key: String, for account: String) throws {
        let data = key.data(using: .utf8)!
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data
        ]
        
        SecItemDelete(query as CFDictionary)
        
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw SynapseError.unauthorized
        }
    }
    
    func loadPrivateKey(for account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]
        
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        
        guard status == errSecSuccess,
              let data = result as? Data,
              let key = String(data: data, encoding: .utf8) else {
            return nil
        }
        
        return key
    }
    
    func deletePrivateKey(for account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - Local Storage

class LocalStorage {
    static let shared = LocalStorage()
    
    private let defaults = UserDefaults.standard
    private let transactionsKey = "synapse.transactions"
    private let favoritesKey = "synapse.favorites"
    
    func saveTransaction(_ tx: PaymentResult) {
        var transactions = getTransactions()
        transactions.insert(tx, at: 0)
        
        // Keep last 100
        if transactions.count > 100 {
            transactions = Array(transactions.prefix(100))
        }
        
        if let data = try? JSONEncoder().encode(transactions) {
            defaults.set(data, forKey: transactionsKey)
        }
    }
    
    func getTransactions() -> [PaymentResult] {
        guard let data = defaults.data(forKey: transactionsKey),
              let transactions = try? JSONDecoder().decode([PaymentResult].self, from: data) else {
            return []
        }
        return transactions
    }
    
    func addFavorite(_ serviceId: String) {
        var favorites = getFavorites()
        if !favorites.contains(serviceId) {
            favorites.append(serviceId)
            defaults.set(favorites, forKey: favoritesKey)
        }
    }
    
    func removeFavorite(_ serviceId: String) {
        var favorites = getFavorites()
        favorites.removeAll { $0 == serviceId }
        defaults.set(favorites, forKey: favoritesKey)
    }
    
    func getFavorites() -> [String] {
        return defaults.stringArray(forKey: favoritesKey) ?? []
    }
    
    func isFavorite(_ serviceId: String) -> Bool {
        return getFavorites().contains(serviceId)
    }
}

// MARK: - Main SDK

@MainActor
public class SynapseSDK: ObservableObject {
    
    // Published properties for SwiftUI
    @Published public private(set) var isInitialized = false
    @Published public private(set) var walletAddress: String?
    @Published public private(set) var balance: String = "0"
    @Published public private(set) var isLoading = false
    
    private var config: SynapseConfig
    private var network: NetworkManager?
    private var refreshTask: Task<Void, Never>?
    
    public init(config: SynapseConfig) {
        self.config = config
    }
    
    // MARK: - Initialization
    
    public func initialize() async throws {
        network = NetworkManager(rpcUrl: config.rpcUrl)
        
        // Load wallet from keychain if available
        if let savedKey = KeychainManager.shared.loadPrivateKey(for: "default") {
            config.privateKey = savedKey
            walletAddress = try deriveAddress(from: savedKey)
        }
        
        isInitialized = true
        
        // Start auto-refresh
        startAutoRefresh()
        
        if walletAddress != nil {
            try await refreshBalance()
        }
    }
    
    // MARK: - Wallet Management
    
    public static func createWallet() -> (address: String, privateKey: String, mnemonic: String) {
        // In production, use proper HD wallet generation
        let privateKey = generateRandomPrivateKey()
        let address = deriveAddressFromKey(privateKey)
        let mnemonic = generateMnemonic()
        
        return (address, privateKey, mnemonic)
    }
    
    public func importWallet(privateKey: String) async throws {
        guard isValidPrivateKey(privateKey) else {
            throw SynapseError.invalidAddress
        }
        
        let address = try deriveAddress(from: privateKey)
        
        try KeychainManager.shared.savePrivateKey(privateKey, for: "default")
        config.privateKey = privateKey
        walletAddress = address
        
        try await refreshBalance()
    }
    
    public func deleteWallet() {
        KeychainManager.shared.deletePrivateKey(for: "default")
        config.privateKey = nil
        walletAddress = nil
        balance = "0"
    }
    
    // MARK: - Balance
    
    public func refreshBalance() async throws {
        guard let address = walletAddress else { return }
        
        isLoading = true
        defer { isLoading = false }
        
        // Call balanceOf on token contract
        let params = [
            [
                "to": config.contracts.token,
                "data": encodeBalanceOf(address)
            ],
            "latest"
        ] as [Any]
        
        let result: String = try await network!.jsonRpcCall(
            method: "eth_call",
            params: params
        )
        
        balance = formatBalance(result)
    }
    
    // MARK: - Payments
    
    public func pay(
        recipient: String,
        amount: String,
        metadata: String? = nil
    ) async throws -> PaymentResult {
        guard let _ = config.privateKey else {
            throw SynapseError.unauthorized
        }
        
        isLoading = true
        defer { isLoading = false }
        
        // Build and send transaction
        // In production, use proper transaction signing
        
        let result = PaymentResult(
            transactionHash: "0x" + UUID().uuidString.replacingOccurrences(of: "-", with: ""),
            paymentId: generatePaymentId(),
            sender: walletAddress!,
            recipient: recipient,
            amount: amount,
            fee: calculateFee(amount),
            timestamp: Date()
        )
        
        // Save to local storage
        LocalStorage.shared.saveTransaction(result)
        
        // Refresh balance
        try await refreshBalance()
        
        return result
    }
    
    // MARK: - Agents
    
    public func getAgent(_ address: String) async throws -> AgentInfo? {
        guard isInitialized else {
            throw SynapseError.notInitialized
        }
        
        // Call agents mapping on reputation contract
        // Return mock for now
        return AgentInfo(
            address: address,
            name: "AI Agent",
            metadataUri: "",
            stake: "1000",
            reputationScore: 95,
            tier: .gold,
            totalTransactions: 1234,
            successfulTransactions: 1200,
            registeredAt: Date()
        )
    }
    
    // MARK: - Services
    
    public func findServices(category: String) async throws -> [ServiceInfo] {
        guard isInitialized else {
            throw SynapseError.notInitialized
        }
        
        // Call getServicesByCategory on service registry
        // Return mock for now
        return [
            ServiceInfo(
                serviceId: "0x123",
                provider: "0xabc",
                name: "GPT-4 API",
                category: category,
                description: "Advanced language model API",
                endpoint: "https://api.example.com",
                basePrice: "0.001",
                pricingModel: .perRequest,
                active: true,
                createdAt: Date()
            )
        ]
    }
    
    public func getService(_ serviceId: String) async throws -> ServiceInfo? {
        guard isInitialized else {
            throw SynapseError.notInitialized
        }
        
        // Call services mapping on service registry
        return nil
    }
    
    // MARK: - Transaction History
    
    public func getTransactionHistory() -> [PaymentResult] {
        return LocalStorage.shared.getTransactions()
    }
    
    // MARK: - Favorites
    
    public func addFavorite(_ serviceId: String) {
        LocalStorage.shared.addFavorite(serviceId)
    }
    
    public func removeFavorite(_ serviceId: String) {
        LocalStorage.shared.removeFavorite(serviceId)
    }
    
    public func getFavorites() -> [String] {
        return LocalStorage.shared.getFavorites()
    }
    
    public func isFavorite(_ serviceId: String) -> Bool {
        return LocalStorage.shared.isFavorite(serviceId)
    }
    
    // MARK: - Utilities
    
    public static func formatSYNX(_ amount: String, decimals: Int = 4) -> String {
        guard let value = Double(amount) else { return "0" }
        return String(format: "%.\(decimals)f", value)
    }
    
    public static func shortenAddress(_ address: String, chars: Int = 4) -> String {
        guard address.count > chars * 2 + 2 else { return address }
        let start = address.prefix(chars + 2)
        let end = address.suffix(chars)
        return "\(start)...\(end)"
    }
    
    public static func isValidAddress(_ address: String) -> Bool {
        let pattern = "^0x[a-fA-F0-9]{40}$"
        return address.range(of: pattern, options: .regularExpression) != nil
    }
    
    // MARK: - Private Methods
    
    private func startAutoRefresh() {
        refreshTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000) // 30 seconds
                if walletAddress != nil {
                    try? await refreshBalance()
                }
            }
        }
    }
    
    private func deriveAddress(from privateKey: String) throws -> String {
        // In production, use proper key derivation
        return "0x" + String(privateKey.suffix(40))
    }
    
    private func encodeBalanceOf(_ address: String) -> String {
        // balanceOf(address) function selector
        let selector = "0x70a08231"
        let paddedAddress = String(repeating: "0", count: 24) + address.dropFirst(2)
        return selector + paddedAddress
    }
    
    private func formatBalance(_ hexValue: String) -> String {
        guard let value = UInt64(hexValue.dropFirst(2), radix: 16) else {
            return "0"
        }
        let balance = Double(value) / pow(10, 18)
        return String(format: "%.4f", balance)
    }
    
    private func generatePaymentId() -> String {
        let data = Data(UUID().uuidString.utf8)
        let hash = SHA256.hash(data: data)
        return "0x" + hash.compactMap { String(format: "%02x", $0) }.joined()
    }
    
    private func calculateFee(_ amount: String) -> String {
        guard let value = Double(amount) else { return "0" }
        return String(format: "%.6f", value * 0.005) // 0.5% fee
    }
    
    deinit {
        refreshTask?.cancel()
    }
}

// MARK: - Helper Functions

private func generateRandomPrivateKey() -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    return "0x" + bytes.map { String(format: "%02x", $0) }.joined()
}

private func deriveAddressFromKey(_ key: String) -> String {
    // Simplified - in production use proper ECDSA
    return "0x" + String(key.suffix(40))
}

private func generateMnemonic() -> String {
    // Simplified - in production use BIP39
    let words = ["abandon", "ability", "able", "about", "above", "absent", 
                 "absorb", "abstract", "absurd", "abuse", "access", "accident"]
    return words.shuffled().prefix(12).joined(separator: " ")
}

private func isValidPrivateKey(_ key: String) -> Bool {
    let pattern = "^0x[a-fA-F0-9]{64}$"
    return key.range(of: pattern, options: .regularExpression) != nil
}

// MARK: - SwiftUI Extensions

#if canImport(SwiftUI)
import SwiftUI

public struct SynapseEnvironmentKey: EnvironmentKey {
    public static let defaultValue: SynapseSDK? = nil
}

public extension EnvironmentValues {
    var synapse: SynapseSDK? {
        get { self[SynapseEnvironmentKey.self] }
        set { self[SynapseEnvironmentKey.self] = newValue }
    }
}

public extension View {
    func synapseSDK(_ sdk: SynapseSDK) -> some View {
        environment(\.synapse, sdk)
    }
}
#endif
