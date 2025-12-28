/**
 * SYNAPSE Protocol - React Native Hooks
 */

import { useState, useEffect, useCallback, useContext, createContext } from 'react';
import { SynapseSDK, SynapseConfig, PaymentParams, PaymentResult, AgentInfo, ServiceInfo } from './index';

// ============ Context ============

interface SynapseContextValue {
  sdk: SynapseSDK | null;
  isInitialized: boolean;
  isConnected: boolean;
  address: string | null;
  error: Error | null;
}

export const SynapseContext = createContext<SynapseContextValue>({
  sdk: null,
  isInitialized: false,
  isConnected: false,
  address: null,
  error: null
});

// ============ useSynapse Hook ============

export function useSynapse() {
  const context = useContext(SynapseContext);
  
  if (!context) {
    throw new Error('useSynapse must be used within SynapseProvider');
  }
  
  return context;
}

// ============ useBalance Hook ============

interface UseBalanceResult {
  balance: string | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export function useBalance(address?: string): UseBalanceResult {
  const { sdk, isInitialized } = useSynapse();
  const [balance, setBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchBalance = useCallback(async () => {
    if (!sdk || !isInitialized) return;

    setLoading(true);
    setError(null);

    try {
      const bal = await sdk.getBalance(address);
      setBalance(bal);
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to fetch balance'));
    } finally {
      setLoading(false);
    }
  }, [sdk, isInitialized, address]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!isInitialized) return;

    const interval = setInterval(fetchBalance, 30000);
    return () => clearInterval(interval);
  }, [isInitialized, fetchBalance]);

  return {
    balance,
    loading,
    error,
    refresh: fetchBalance
  };
}

// ============ usePayment Hook ============

interface UsePaymentResult {
  pay: (params: PaymentParams) => Promise<PaymentResult | null>;
  loading: boolean;
  error: Error | null;
  lastPayment: PaymentResult | null;
  reset: () => void;
}

export function usePayment(): UsePaymentResult {
  const { sdk, isInitialized } = useSynapse();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastPayment, setLastPayment] = useState<PaymentResult | null>(null);

  const pay = useCallback(async (params: PaymentParams): Promise<PaymentResult | null> => {
    if (!sdk || !isInitialized) {
      setError(new Error('SDK not initialized'));
      return null;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await sdk.pay(params);
      setLastPayment(result);
      return result;
    } catch (e) {
      const err = e instanceof Error ? e : new Error('Payment failed');
      setError(err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [sdk, isInitialized]);

  const reset = useCallback(() => {
    setError(null);
    setLastPayment(null);
  }, []);

  return {
    pay,
    loading,
    error,
    lastPayment,
    reset
  };
}

// ============ useAgent Hook ============

interface UseAgentResult {
  agent: AgentInfo | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  tierName: string;
}

export function useAgent(address: string): UseAgentResult {
  const { sdk, isInitialized } = useSynapse();
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchAgent = useCallback(async () => {
    if (!sdk || !isInitialized || !address) return;

    setLoading(true);
    setError(null);

    try {
      const agentInfo = await sdk.getAgent(address);
      setAgent(agentInfo);
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to fetch agent'));
    } finally {
      setLoading(false);
    }
  }, [sdk, isInitialized, address]);

  useEffect(() => {
    fetchAgent();
  }, [fetchAgent]);

  const tierName = agent ? sdk?.getTierName(agent.tier) || 'Unknown' : 'Unknown';

  return {
    agent,
    loading,
    error,
    refresh: fetchAgent,
    tierName
  };
}

// ============ useServices Hook ============

interface UseServicesResult {
  services: ServiceInfo[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  search: (category: string) => Promise<void>;
}

export function useServices(initialCategory?: string): UseServicesResult {
  const { sdk, isInitialized } = useSynapse();
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [category, setCategory] = useState(initialCategory);

  const fetchServices = useCallback(async () => {
    if (!sdk || !isInitialized || !category) return;

    setLoading(true);
    setError(null);

    try {
      const result = await sdk.findServices(category);
      setServices(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to fetch services'));
    } finally {
      setLoading(false);
    }
  }, [sdk, isInitialized, category]);

  useEffect(() => {
    if (category) {
      fetchServices();
    }
  }, [fetchServices, category]);

  const search = useCallback(async (newCategory: string) => {
    setCategory(newCategory);
  }, []);

  return {
    services,
    loading,
    error,
    refresh: fetchServices,
    search
  };
}

// ============ useTransactionHistory Hook ============

interface UseTransactionHistoryResult {
  transactions: any[];
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useTransactionHistory(): UseTransactionHistoryResult {
  const { sdk, isInitialized } = useSynapse();
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchHistory = useCallback(async () => {
    if (!sdk || !isInitialized) return;

    setLoading(true);
    try {
      const history = await sdk.getTransactionHistory();
      setTransactions(history);
    } finally {
      setLoading(false);
    }
  }, [sdk, isInitialized]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return {
    transactions,
    loading,
    refresh: fetchHistory
  };
}

// ============ useFavorites Hook ============

interface UseFavoritesResult {
  favorites: string[];
  loading: boolean;
  addFavorite: (serviceId: string) => Promise<void>;
  removeFavorite: (serviceId: string) => Promise<void>;
  isFavorite: (serviceId: string) => boolean;
}

export function useFavorites(): UseFavoritesResult {
  const { sdk, isInitialized } = useSynapse();
  const [favorites, setFavorites] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchFavorites = useCallback(async () => {
    if (!sdk || !isInitialized) return;

    setLoading(true);
    try {
      const favs = await sdk.getFavorites();
      setFavorites(favs);
    } finally {
      setLoading(false);
    }
  }, [sdk, isInitialized]);

  useEffect(() => {
    fetchFavorites();
  }, [fetchFavorites]);

  const addFavorite = useCallback(async (serviceId: string) => {
    if (!sdk) return;
    await sdk.addFavorite(serviceId);
    setFavorites(prev => [...prev, serviceId]);
  }, [sdk]);

  const removeFavorite = useCallback(async (serviceId: string) => {
    if (!sdk) return;
    await sdk.removeFavorite(serviceId);
    setFavorites(prev => prev.filter(id => id !== serviceId));
  }, [sdk]);

  const isFavorite = useCallback((serviceId: string) => {
    return favorites.includes(serviceId);
  }, [favorites]);

  return {
    favorites,
    loading,
    addFavorite,
    removeFavorite,
    isFavorite
  };
}

// ============ usePrice Hook ============

interface UsePriceResult {
  price: string | null;
  loading: boolean;
  error: Error | null;
  calculate: (serviceId: string, quantity: number) => Promise<string | null>;
}

export function usePrice(): UsePriceResult {
  const { sdk, isInitialized } = useSynapse();
  const [price, setPrice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const calculate = useCallback(async (serviceId: string, quantity: number): Promise<string | null> => {
    if (!sdk || !isInitialized) return null;

    setLoading(true);
    setError(null);

    try {
      const result = await sdk.calculatePrice(serviceId, quantity);
      setPrice(result);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to calculate price'));
      return null;
    } finally {
      setLoading(false);
    }
  }, [sdk, isInitialized]);

  return {
    price,
    loading,
    error,
    calculate
  };
}

// ============ useWallet Hook ============

interface UseWalletResult {
  address: string | null;
  balance: string | null;
  network: string | null;
  loading: boolean;
  error: Error | null;
  createWallet: () => { address: string; privateKey: string; mnemonic: string };
  importFromPrivateKey: (key: string) => { address: string };
  importFromMnemonic: (mnemonic: string) => { address: string; privateKey: string };
}

export function useWallet(): UseWalletResult {
  const { sdk, isInitialized, address } = useSynapse();
  const [walletInfo, setWalletInfo] = useState<{
    balance: string | null;
    network: string | null;
  }>({ balance: null, network: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const fetchInfo = async () => {
      if (!sdk || !isInitialized) return;

      setLoading(true);
      try {
        const info = await sdk.getWalletInfo();
        if (info) {
          setWalletInfo({
            balance: info.balance,
            network: info.network
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e : new Error('Failed to get wallet info'));
      } finally {
        setLoading(false);
      }
    };

    fetchInfo();
  }, [sdk, isInitialized]);

  return {
    address,
    balance: walletInfo.balance,
    network: walletInfo.network,
    loading,
    error,
    createWallet: SynapseSDK.createWallet,
    importFromPrivateKey: SynapseSDK.importFromPrivateKey,
    importFromMnemonic: SynapseSDK.importFromMnemonic
  };
}
