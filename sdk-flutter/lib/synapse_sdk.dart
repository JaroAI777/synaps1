/// SYNAPSE Protocol Flutter SDK
///
/// Complete SDK for Flutter applications (iOS, Android, Web)
/// Features:
/// - Wallet management
/// - Token operations
/// - Payment processing
/// - Agent & service discovery
/// - Real-time events

library synapse_sdk;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web3dart/web3dart.dart';

// ============ Configuration ============

class SynapseConfig {
  final String rpcUrl;
  final String apiUrl;
  final String wsUrl;
  final ContractAddresses contracts;
  final int chainId;

  const SynapseConfig({
    required this.rpcUrl,
    required this.apiUrl,
    required this.wsUrl,
    required this.contracts,
    this.chainId = 42161, // Arbitrum One
  });

  factory SynapseConfig.arbitrum() {
    return SynapseConfig(
      rpcUrl: 'https://arb1.arbitrum.io/rpc',
      apiUrl: 'https://api.synapse-protocol.ai',
      wsUrl: 'wss://ws.synapse-protocol.ai',
      contracts: ContractAddresses.arbitrum(),
    );
  }

  factory SynapseConfig.testnet() {
    return SynapseConfig(
      rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
      apiUrl: 'https://api-testnet.synapse-protocol.ai',
      wsUrl: 'wss://ws-testnet.synapse-protocol.ai',
      contracts: ContractAddresses.testnet(),
      chainId: 421614,
    );
  }
}

class ContractAddresses {
  final String token;
  final String paymentRouter;
  final String reputation;
  final String serviceRegistry;
  final String paymentChannel;
  final String? subscriptionManager;
  final String? staking;

  const ContractAddresses({
    required this.token,
    required this.paymentRouter,
    required this.reputation,
    required this.serviceRegistry,
    required this.paymentChannel,
    this.subscriptionManager,
    this.staking,
  });

  factory ContractAddresses.arbitrum() {
    return const ContractAddresses(
      token: '0x...', // Replace with actual addresses
      paymentRouter: '0x...',
      reputation: '0x...',
      serviceRegistry: '0x...',
      paymentChannel: '0x...',
    );
  }

  factory ContractAddresses.testnet() {
    return const ContractAddresses(
      token: '0x...',
      paymentRouter: '0x...',
      reputation: '0x...',
      serviceRegistry: '0x...',
      paymentChannel: '0x...',
    );
  }
}

// ============ Models ============

class Wallet {
  final String address;
  final String? privateKey;
  final String? mnemonic;

  Wallet({
    required this.address,
    this.privateKey,
    this.mnemonic,
  });

  factory Wallet.create() {
    final credentials = EthPrivateKey.createRandom(Random.secure());
    return Wallet(
      address: credentials.address.hex,
      privateKey: bytesToHex(credentials.privateKey),
    );
  }

  factory Wallet.fromPrivateKey(String privateKey) {
    final credentials = EthPrivateKey.fromHex(privateKey);
    return Wallet(
      address: credentials.address.hex,
      privateKey: privateKey,
    );
  }
}

class TokenBalance {
  final BigInt balance;
  final BigInt allowance;
  final String formatted;

  TokenBalance({
    required this.balance,
    required this.allowance,
    required this.formatted,
  });

  factory TokenBalance.fromJson(Map<String, dynamic> json) {
    return TokenBalance(
      balance: BigInt.parse(json['balance']),
      allowance: BigInt.parse(json['allowance']),
      formatted: json['formatted'],
    );
  }
}

class AgentInfo {
  final String address;
  final String name;
  final int reputation;
  final int tier;
  final BigInt stake;
  final double successRate;
  final int totalTransactions;

  AgentInfo({
    required this.address,
    required this.name,
    required this.reputation,
    required this.tier,
    required this.stake,
    required this.successRate,
    required this.totalTransactions,
  });

  factory AgentInfo.fromJson(Map<String, dynamic> json) {
    return AgentInfo(
      address: json['address'],
      name: json['name'],
      reputation: json['reputation'],
      tier: json['tier'],
      stake: BigInt.parse(json['stake']),
      successRate: json['successRate'].toDouble(),
      totalTransactions: json['totalTransactions'],
    );
  }

  String get tierName {
    const tiers = ['Unverified', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
    return tier >= 0 && tier < tiers.length ? tiers[tier] : 'Unknown';
  }
}

class ServiceInfo {
  final String serviceId;
  final String name;
  final String provider;
  final String category;
  final String description;
  final String endpoint;
  final BigInt basePrice;
  final int pricingModel;
  final bool active;

  ServiceInfo({
    required this.serviceId,
    required this.name,
    required this.provider,
    required this.category,
    required this.description,
    required this.endpoint,
    required this.basePrice,
    required this.pricingModel,
    required this.active,
  });

  factory ServiceInfo.fromJson(Map<String, dynamic> json) {
    return ServiceInfo(
      serviceId: json['serviceId'],
      name: json['name'],
      provider: json['provider'],
      category: json['category'],
      description: json['description'],
      endpoint: json['endpoint'],
      basePrice: BigInt.parse(json['basePrice']),
      pricingModel: json['pricingModel'],
      active: json['active'],
    );
  }

  String get formattedPrice {
    final eth = basePrice / BigInt.from(10).pow(18);
    return '${eth.toStringAsFixed(4)} SYNX';
  }
}

class PaymentResult {
  final String transactionHash;
  final String paymentId;
  final BigInt amount;
  final BigInt fee;
  final DateTime timestamp;

  PaymentResult({
    required this.transactionHash,
    required this.paymentId,
    required this.amount,
    required this.fee,
    required this.timestamp,
  });

  factory PaymentResult.fromJson(Map<String, dynamic> json) {
    return PaymentResult(
      transactionHash: json['transactionHash'],
      paymentId: json['paymentId'],
      amount: BigInt.parse(json['amount']),
      fee: BigInt.parse(json['fee']),
      timestamp: DateTime.parse(json['timestamp']),
    );
  }
}

class TransactionRecord {
  final String hash;
  final String type;
  final String? to;
  final BigInt amount;
  final DateTime timestamp;
  final String status;

  TransactionRecord({
    required this.hash,
    required this.type,
    this.to,
    required this.amount,
    required this.timestamp,
    required this.status,
  });

  Map<String, dynamic> toJson() => {
    'hash': hash,
    'type': type,
    'to': to,
    'amount': amount.toString(),
    'timestamp': timestamp.toIso8601String(),
    'status': status,
  };

  factory TransactionRecord.fromJson(Map<String, dynamic> json) {
    return TransactionRecord(
      hash: json['hash'],
      type: json['type'],
      to: json['to'],
      amount: BigInt.parse(json['amount']),
      timestamp: DateTime.parse(json['timestamp']),
      status: json['status'],
    );
  }
}

// ============ Exceptions ============

class SynapseException implements Exception {
  final String message;
  final String? code;

  SynapseException(this.message, {this.code});

  @override
  String toString() => 'SynapseException: $message (code: $code)';
}

class InsufficientBalanceException extends SynapseException {
  final BigInt required;
  final BigInt available;

  InsufficientBalanceException({
    required this.required,
    required this.available,
  }) : super('Insufficient balance: need $required, have $available');
}

// ============ Main SDK ============

class SynapseSDK {
  final SynapseConfig config;
  late Web3Client _web3Client;
  late http.Client _httpClient;
  WebSocketChannel? _wsChannel;
  
  Wallet? _wallet;
  String? _jwtToken;
  
  final _eventController = StreamController<Map<String, dynamic>>.broadcast();

  SynapseSDK(this.config) {
    _httpClient = http.Client();
    _web3Client = Web3Client(config.rpcUrl, _httpClient);
  }

  // ============ Initialization ============

  /// Initialize SDK with wallet
  Future<void> initialize({String? privateKey, String? mnemonic}) async {
    if (privateKey != null) {
      _wallet = Wallet.fromPrivateKey(privateKey);
    } else if (mnemonic != null) {
      // Implement mnemonic derivation
      throw UnimplementedError('Mnemonic not yet implemented');
    }
  }

  /// Create a new wallet
  static Wallet createWallet() {
    return Wallet.create();
  }

  /// Get current wallet address
  String? get address => _wallet?.address;

  /// Check if wallet is connected
  bool get isConnected => _wallet != null;

  // ============ API Methods ============

  Future<Map<String, dynamic>> _apiGet(String endpoint) async {
    final response = await _httpClient.get(
      Uri.parse('${config.apiUrl}$endpoint'),
      headers: _getHeaders(),
    );

    if (response.statusCode != 200) {
      throw SynapseException('API error: ${response.statusCode}');
    }

    return jsonDecode(response.body);
  }

  Future<Map<String, dynamic>> _apiPost(String endpoint, Map<String, dynamic> body) async {
    final response = await _httpClient.post(
      Uri.parse('${config.apiUrl}$endpoint'),
      headers: _getHeaders(),
      body: jsonEncode(body),
    );

    if (response.statusCode != 200 && response.statusCode != 201) {
      throw SynapseException('API error: ${response.statusCode}');
    }

    return jsonDecode(response.body);
  }

  Map<String, String> _getHeaders() {
    final headers = {
      'Content-Type': 'application/json',
    };

    if (_jwtToken != null) {
      headers['Authorization'] = 'Bearer $_jwtToken';
    }

    return headers;
  }

  // ============ Token Operations ============

  /// Get token balance
  Future<TokenBalance> getBalance([String? address]) async {
    final addr = address ?? _wallet?.address;
    if (addr == null) throw SynapseException('No address provided');

    final result = await _apiGet('/api/v1/token/balance/$addr');
    return TokenBalance.fromJson(result);
  }

  /// Transfer tokens
  Future<String> transfer(String to, BigInt amount) async {
    if (_wallet == null) throw SynapseException('Wallet not initialized');

    // Check balance first
    final balance = await getBalance();
    if (balance.balance < amount) {
      throw InsufficientBalanceException(required: amount, available: balance.balance);
    }

    final result = await _apiPost('/api/v1/token/transfer', {
      'to': to,
      'amount': amount.toString(),
    });

    await _saveTransaction(TransactionRecord(
      hash: result['transactionHash'],
      type: 'transfer',
      to: to,
      amount: amount,
      timestamp: DateTime.now(),
      status: 'pending',
    ));

    return result['transactionHash'];
  }

  /// Approve token spending
  Future<String> approve(String spender, BigInt amount) async {
    if (_wallet == null) throw SynapseException('Wallet not initialized');

    final result = await _apiPost('/api/v1/token/approve', {
      'spender': spender,
      'amount': amount.toString(),
    });

    return result['transactionHash'];
  }

  // ============ Payment Operations ============

  /// Send payment
  Future<PaymentResult> pay({
    required String recipient,
    required BigInt amount,
    String? metadata,
  }) async {
    if (_wallet == null) throw SynapseException('Wallet not initialized');

    final result = await _apiPost('/api/v1/payments/pay', {
      'recipient': recipient,
      'amount': amount.toString(),
      'metadata': metadata,
    });

    final payment = PaymentResult.fromJson(result);

    await _saveTransaction(TransactionRecord(
      hash: payment.transactionHash,
      type: 'payment',
      to: recipient,
      amount: amount,
      timestamp: payment.timestamp,
      status: 'completed',
    ));

    return payment;
  }

  /// Send batch payment
  Future<List<PaymentResult>> batchPay(List<Map<String, dynamic>> payments) async {
    if (_wallet == null) throw SynapseException('Wallet not initialized');

    final result = await _apiPost('/api/v1/payments/batch', {
      'payments': payments,
    });

    return (result['results'] as List)
        .map((r) => PaymentResult.fromJson(r))
        .toList();
  }

  // ============ Agent Operations ============

  /// Get agent info
  Future<AgentInfo?> getAgent(String address) async {
    try {
      final result = await _apiGet('/api/v1/agents/$address');
      return AgentInfo.fromJson(result);
    } catch (e) {
      return null;
    }
  }

  /// Register as agent
  Future<String> registerAgent({
    required String name,
    required String metadataUri,
    required BigInt stake,
  }) async {
    if (_wallet == null) throw SynapseException('Wallet not initialized');

    final result = await _apiPost('/api/v1/agents/register', {
      'name': name,
      'metadataUri': metadataUri,
      'stake': stake.toString(),
    });

    return result['transactionHash'];
  }

  // ============ Service Operations ============

  /// Find services by category
  Future<List<ServiceInfo>> findServices(String category) async {
    final result = await _apiGet('/api/v1/services/category/$category');
    return (result['services'] as List)
        .map((s) => ServiceInfo.fromJson(s))
        .toList();
  }

  /// Get service details
  Future<ServiceInfo?> getService(String serviceId) async {
    try {
      final result = await _apiGet('/api/v1/services/$serviceId');
      return ServiceInfo.fromJson(result);
    } catch (e) {
      return null;
    }
  }

  /// Calculate service price
  Future<BigInt> calculatePrice(String serviceId, int quantity) async {
    final result = await _apiGet('/api/v1/services/$serviceId/price/$quantity');
    return BigInt.parse(result['price']);
  }

  // ============ WebSocket Events ============

  /// Connect to real-time events
  Future<void> connectWebSocket() async {
    if (_wsChannel != null) return;

    final uri = Uri.parse('${config.wsUrl}?token=$_jwtToken');
    _wsChannel = WebSocketChannel.connect(uri);

    _wsChannel!.stream.listen(
      (message) {
        final event = jsonDecode(message);
        _eventController.add(event);
      },
      onError: (error) {
        _eventController.addError(error);
      },
      onDone: () {
        _wsChannel = null;
        // Auto-reconnect
        Future.delayed(const Duration(seconds: 5), connectWebSocket);
      },
    );
  }

  /// Disconnect WebSocket
  void disconnectWebSocket() {
    _wsChannel?.sink.close();
    _wsChannel = null;
  }

  /// Subscribe to event type
  Stream<Map<String, dynamic>> subscribeToEvent(String eventType) {
    return _eventController.stream.where((event) => event['type'] == eventType);
  }

  /// Get all events stream
  Stream<Map<String, dynamic>> get events => _eventController.stream;

  // ============ Local Storage ============

  Future<void> _saveTransaction(TransactionRecord tx) async {
    final prefs = await SharedPreferences.getInstance();
    final history = prefs.getStringList('tx_history') ?? [];
    history.insert(0, jsonEncode(tx.toJson()));
    if (history.length > 100) history.removeLast();
    await prefs.setStringList('tx_history', history);
  }

  Future<List<TransactionRecord>> getTransactionHistory() async {
    final prefs = await SharedPreferences.getInstance();
    final history = prefs.getStringList('tx_history') ?? [];
    return history.map((s) => TransactionRecord.fromJson(jsonDecode(s))).toList();
  }

  Future<void> clearHistory() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('tx_history');
  }

  // ============ Utility Methods ============

  /// Format amount to human-readable string
  static String formatAmount(BigInt amount, {int decimals = 4}) {
    final value = amount / BigInt.from(10).pow(18);
    return value.toStringAsFixed(decimals);
  }

  /// Parse amount from string
  static BigInt parseAmount(String amount) {
    final value = double.parse(amount);
    return BigInt.from(value * 1e18);
  }

  /// Validate Ethereum address
  static bool isValidAddress(String address) {
    return RegExp(r'^0x[a-fA-F0-9]{40}$').hasMatch(address);
  }

  /// Shorten address for display
  static String shortenAddress(String address, {int chars = 4}) {
    if (address.length < chars * 2 + 2) return address;
    return '${address.substring(0, chars + 2)}...${address.substring(address.length - chars)}';
  }

  // ============ Cleanup ============

  void dispose() {
    disconnectWebSocket();
    _eventController.close();
    _httpClient.close();
  }
}

// ============ Utility Functions ============

String bytesToHex(Uint8List bytes) {
  return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}
