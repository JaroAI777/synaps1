/**
 * SYNAPSE Protocol - React Native Components
 */

import React, { useState, useEffect, createContext, useContext, ReactNode } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  FlatList,
  TextInput,
  Alert
} from 'react-native';
import { SynapseSDK, SynapseConfig, ServiceInfo, PaymentResult } from './index';
import { useBalance, usePayment, useAgent, useServices, useTransactionHistory } from './hooks';

// ============ Context & Provider ============

interface SynapseProviderProps {
  config: SynapseConfig;
  children: ReactNode;
}

interface SynapseContextValue {
  sdk: SynapseSDK | null;
  isInitialized: boolean;
  isConnected: boolean;
  address: string | null;
  error: Error | null;
}

const SynapseContext = createContext<SynapseContextValue>({
  sdk: null,
  isInitialized: false,
  isConnected: false,
  address: null,
  error: null
});

export function SynapseProvider({ config, children }: SynapseProviderProps) {
  const [sdk, setSdk] = useState<SynapseSDK | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const initSDK = async () => {
      try {
        const instance = new SynapseSDK(config);
        await instance.initialize();
        setSdk(instance);
        setIsInitialized(true);
      } catch (e) {
        setError(e instanceof Error ? e : new Error('SDK initialization failed'));
      }
    };

    initSDK();
  }, [config]);

  const value: SynapseContextValue = {
    sdk,
    isInitialized,
    isConnected: !!sdk?.getAddress(),
    address: sdk?.getAddress() || null,
    error
  };

  return (
    <SynapseContext.Provider value={value}>
      {children}
    </SynapseContext.Provider>
  );
}

export const useSynapseContext = () => useContext(SynapseContext);

// ============ Balance Display ============

interface BalanceDisplayProps {
  address?: string;
  showRefresh?: boolean;
  style?: object;
}

export function BalanceDisplay({ address, showRefresh = true, style }: BalanceDisplayProps) {
  const { balance, loading, error, refresh } = useBalance(address);

  return (
    <View style={[styles.balanceContainer, style]}>
      <Text style={styles.balanceLabel}>SYNX Balance</Text>
      {loading ? (
        <ActivityIndicator color="#00d4aa" />
      ) : error ? (
        <Text style={styles.errorText}>Error loading balance</Text>
      ) : (
        <Text style={styles.balanceAmount}>
          {balance ? parseFloat(balance).toFixed(4) : '0.0000'} SYNX
        </Text>
      )}
      {showRefresh && (
        <TouchableOpacity onPress={refresh} style={styles.refreshButton}>
          <Text style={styles.refreshText}>Refresh</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ============ Payment Button ============

interface PaymentButtonProps {
  recipient: string;
  amount: string;
  metadata?: string;
  onSuccess?: (result: PaymentResult) => void;
  onError?: (error: Error) => void;
  label?: string;
  style?: object;
  disabled?: boolean;
}

export function PaymentButton({
  recipient,
  amount,
  metadata,
  onSuccess,
  onError,
  label = 'Pay',
  style,
  disabled = false
}: PaymentButtonProps) {
  const { pay, loading, error, lastPayment } = usePayment();

  useEffect(() => {
    if (lastPayment && onSuccess) {
      onSuccess(lastPayment);
    }
  }, [lastPayment, onSuccess]);

  useEffect(() => {
    if (error && onError) {
      onError(error);
    }
  }, [error, onError]);

  const handlePress = async () => {
    if (disabled || loading) return;

    Alert.alert(
      'Confirm Payment',
      `Send ${amount} SYNX to ${SynapseSDK.shortenAddress(recipient)}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: async () => {
            await pay({ recipient, amount, metadata });
          }
        }
      ]
    );
  };

  return (
    <TouchableOpacity
      style={[
        styles.paymentButton,
        disabled && styles.paymentButtonDisabled,
        style
      ]}
      onPress={handlePress}
      disabled={disabled || loading}
    >
      {loading ? (
        <ActivityIndicator color="#000" />
      ) : (
        <Text style={styles.paymentButtonText}>
          {label} {amount} SYNX
        </Text>
      )}
    </TouchableOpacity>
  );
}

// ============ Service Card ============

interface ServiceCardProps {
  service: ServiceInfo;
  onPress?: (service: ServiceInfo) => void;
  onPayPress?: (service: ServiceInfo) => void;
  style?: object;
}

export function ServiceCard({ service, onPress, onPayPress, style }: ServiceCardProps) {
  const { agent } = useAgent(service.provider);

  return (
    <TouchableOpacity
      style={[styles.serviceCard, style]}
      onPress={() => onPress?.(service)}
      activeOpacity={0.8}
    >
      <View style={styles.serviceHeader}>
        <Text style={styles.serviceName}>{service.name}</Text>
        <Text style={styles.serviceCategory}>{service.category}</Text>
      </View>
      
      <View style={styles.serviceBody}>
        <Text style={styles.serviceProvider}>
          Provider: {SynapseSDK.shortenAddress(service.provider)}
        </Text>
        {agent && (
          <View style={styles.agentBadge}>
            <Text style={styles.agentTier}>{agent.name}</Text>
          </View>
        )}
      </View>
      
      <View style={styles.serviceFooter}>
        <Text style={styles.servicePrice}>{service.price} SYNX</Text>
        {onPayPress && (
          <TouchableOpacity
            style={styles.servicePayButton}
            onPress={() => onPayPress(service)}
          >
            <Text style={styles.servicePayButtonText}>Use Service</Text>
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ============ Service List ============

interface ServiceListProps {
  category: string;
  onServicePress?: (service: ServiceInfo) => void;
  onPayPress?: (service: ServiceInfo) => void;
  style?: object;
}

export function ServiceList({ category, onServicePress, onPayPress, style }: ServiceListProps) {
  const { services, loading, error, refresh } = useServices(category);

  if (loading) {
    return (
      <View style={[styles.centeredContainer, style]}>
        <ActivityIndicator size="large" color="#00d4aa" />
        <Text style={styles.loadingText}>Loading services...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.centeredContainer, style]}>
        <Text style={styles.errorText}>Failed to load services</Text>
        <TouchableOpacity onPress={refresh} style={styles.retryButton}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (services.length === 0) {
    return (
      <View style={[styles.centeredContainer, style]}>
        <Text style={styles.emptyText}>No services found in this category</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={services}
      keyExtractor={(item) => item.serviceId}
      renderItem={({ item }) => (
        <ServiceCard
          service={item}
          onPress={onServicePress}
          onPayPress={onPayPress}
        />
      )}
      contentContainerStyle={style}
      showsVerticalScrollIndicator={false}
    />
  );
}

// ============ Transaction History ============

interface TransactionHistoryProps {
  limit?: number;
  style?: object;
}

export function TransactionHistory({ limit = 10, style }: TransactionHistoryProps) {
  const { transactions, loading, refresh } = useTransactionHistory();

  const displayTransactions = transactions.slice(0, limit);

  if (loading && transactions.length === 0) {
    return (
      <View style={[styles.centeredContainer, style]}>
        <ActivityIndicator color="#00d4aa" />
      </View>
    );
  }

  if (transactions.length === 0) {
    return (
      <View style={[styles.centeredContainer, style]}>
        <Text style={styles.emptyText}>No transactions yet</Text>
      </View>
    );
  }

  return (
    <View style={style}>
      <View style={styles.historyHeader}>
        <Text style={styles.historyTitle}>Recent Transactions</Text>
        <TouchableOpacity onPress={refresh}>
          <Text style={styles.refreshText}>Refresh</Text>
        </TouchableOpacity>
      </View>
      
      {displayTransactions.map((tx, index) => (
        <View key={tx.hash || index} style={styles.transactionItem}>
          <View style={styles.transactionLeft}>
            <Text style={styles.transactionType}>{tx.type}</Text>
            <Text style={styles.transactionHash}>
              {SynapseSDK.shortenAddress(tx.hash || tx.transactionHash)}
            </Text>
          </View>
          <View style={styles.transactionRight}>
            <Text style={styles.transactionAmount}>
              {tx.amount} SYNX
            </Text>
            <Text style={styles.transactionTime}>
              {new Date(tx.timestamp).toLocaleDateString()}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

// ============ Address Input ============

interface AddressInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: object;
}

export function AddressInput({
  value,
  onChange,
  placeholder = 'Enter address (0x...)',
  style
}: AddressInputProps) {
  const [isValid, setIsValid] = useState(true);

  const handleChange = (text: string) => {
    onChange(text);
    if (text.length > 0) {
      setIsValid(SynapseSDK.isValidAddress(text));
    } else {
      setIsValid(true);
    }
  };

  return (
    <View style={style}>
      <TextInput
        style={[
          styles.addressInput,
          !isValid && styles.addressInputInvalid
        ]}
        value={value}
        onChangeText={handleChange}
        placeholder={placeholder}
        placeholderTextColor="#666"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {!isValid && (
        <Text style={styles.validationError}>Invalid address format</Text>
      )}
    </View>
  );
}

// ============ Amount Input ============

interface AmountInputProps {
  value: string;
  onChange: (value: string) => void;
  maxAmount?: string;
  style?: object;
}

export function AmountInput({
  value,
  onChange,
  maxAmount,
  style
}: AmountInputProps) {
  const handleMax = () => {
    if (maxAmount) {
      onChange(maxAmount);
    }
  };

  return (
    <View style={[styles.amountContainer, style]}>
      <TextInput
        style={styles.amountInput}
        value={value}
        onChangeText={onChange}
        placeholder="0.00"
        placeholderTextColor="#666"
        keyboardType="decimal-pad"
      />
      <Text style={styles.amountLabel}>SYNX</Text>
      {maxAmount && (
        <TouchableOpacity onPress={handleMax} style={styles.maxButton}>
          <Text style={styles.maxButtonText}>MAX</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ============ Styles ============

const styles = StyleSheet.create({
  // Balance
  balanceContainer: {
    backgroundColor: '#111118',
    padding: 20,
    borderRadius: 12,
    alignItems: 'center'
  },
  balanceLabel: {
    color: '#888',
    fontSize: 14,
    marginBottom: 8
  },
  balanceAmount: {
    color: '#00d4aa',
    fontSize: 28,
    fontWeight: 'bold'
  },
  refreshButton: {
    marginTop: 12,
    padding: 8
  },
  refreshText: {
    color: '#00d4aa',
    fontSize: 14
  },

  // Payment Button
  paymentButton: {
    backgroundColor: '#00d4aa',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center'
  },
  paymentButtonDisabled: {
    backgroundColor: '#333',
    opacity: 0.6
  },
  paymentButtonText: {
    color: '#000',
    fontSize: 16,
    fontWeight: 'bold'
  },

  // Service Card
  serviceCard: {
    backgroundColor: '#111118',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1f1f2e'
  },
  serviceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12
  },
  serviceName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    flex: 1
  },
  serviceCategory: {
    color: '#00d4aa',
    fontSize: 12,
    backgroundColor: 'rgba(0, 212, 170, 0.1)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4
  },
  serviceBody: {
    marginBottom: 12
  },
  serviceProvider: {
    color: '#888',
    fontSize: 12
  },
  agentBadge: {
    marginTop: 8
  },
  agentTier: {
    color: '#6366f1',
    fontSize: 12
  },
  serviceFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#1f1f2e',
    paddingTop: 12
  },
  servicePrice: {
    color: '#00d4aa',
    fontSize: 18,
    fontWeight: 'bold'
  },
  servicePayButton: {
    backgroundColor: '#00d4aa',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8
  },
  servicePayButtonText: {
    color: '#000',
    fontWeight: 'bold',
    fontSize: 14
  },

  // Common
  centeredContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20
  },
  loadingText: {
    color: '#888',
    marginTop: 12
  },
  errorText: {
    color: '#ef4444',
    textAlign: 'center'
  },
  emptyText: {
    color: '#666',
    textAlign: 'center'
  },
  retryButton: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#00d4aa',
    borderRadius: 8
  },
  retryText: {
    color: '#000',
    fontWeight: 'bold'
  },

  // Transaction History
  historyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16
  },
  historyTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold'
  },
  transactionItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1f1f2e'
  },
  transactionLeft: {},
  transactionRight: {
    alignItems: 'flex-end'
  },
  transactionType: {
    color: '#fff',
    fontSize: 14,
    textTransform: 'capitalize'
  },
  transactionHash: {
    color: '#666',
    fontSize: 12,
    marginTop: 4
  },
  transactionAmount: {
    color: '#00d4aa',
    fontSize: 14,
    fontWeight: 'bold'
  },
  transactionTime: {
    color: '#666',
    fontSize: 12,
    marginTop: 4
  },

  // Inputs
  addressInput: {
    backgroundColor: '#111118',
    borderWidth: 1,
    borderColor: '#1f1f2e',
    borderRadius: 8,
    padding: 16,
    color: '#fff',
    fontSize: 14
  },
  addressInputInvalid: {
    borderColor: '#ef4444'
  },
  validationError: {
    color: '#ef4444',
    fontSize: 12,
    marginTop: 4
  },
  amountContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111118',
    borderWidth: 1,
    borderColor: '#1f1f2e',
    borderRadius: 8,
    paddingHorizontal: 16
  },
  amountInput: {
    flex: 1,
    paddingVertical: 16,
    color: '#fff',
    fontSize: 18
  },
  amountLabel: {
    color: '#00d4aa',
    fontSize: 16,
    fontWeight: 'bold',
    marginLeft: 8
  },
  maxButton: {
    backgroundColor: 'rgba(0, 212, 170, 0.1)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    marginLeft: 8
  },
  maxButtonText: {
    color: '#00d4aa',
    fontSize: 12,
    fontWeight: 'bold'
  }
});

export { SynapseContext };
