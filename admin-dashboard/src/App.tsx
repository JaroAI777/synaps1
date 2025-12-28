/**
 * SYNAPSE Protocol - Admin Dashboard
 * 
 * Web-based administration panel for protocol management
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, ResponsiveContainer,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend
} from 'recharts';
import {
  Users, DollarSign, Activity, Settings, Shield, AlertTriangle,
  Pause, Play, RefreshCw, Search, ChevronDown, ExternalLink,
  TrendingUp, TrendingDown, Clock, Server, Database, Zap
} from 'lucide-react';

// ============ Configuration ============

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3000/api/v1';

const COLORS = {
  primary: '#00d4aa',
  secondary: '#6366f1',
  warning: '#f59e0b',
  danger: '#ef4444',
  success: '#10b981',
  muted: '#6b7280'
};

// ============ API Functions ============

async function fetchApi(endpoint: string) {
  const response = await fetch(`${API_BASE}${endpoint}`);
  if (!response.ok) throw new Error('API request failed');
  return response.json();
}

async function postApi(endpoint: string, data: any) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!response.ok) throw new Error('API request failed');
  return response.json();
}

// ============ Components ============

// Sidebar Navigation
const Sidebar = ({ activeSection, setActiveSection }: any) => {
  const menuItems = [
    { id: 'overview', label: 'Overview', icon: Activity },
    { id: 'agents', label: 'Agents', icon: Users },
    { id: 'services', label: 'Services', icon: Server },
    { id: 'payments', label: 'Payments', icon: DollarSign },
    { id: 'staking', label: 'Staking', icon: TrendingUp },
    { id: 'bridge', label: 'Bridge', icon: Zap },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'settings', label: 'Settings', icon: Settings }
  ];

  return (
    <div className="w-64 bg-gray-900 min-h-screen p-4">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-primary">SYNAPSE</h1>
        <p className="text-gray-500 text-sm">Admin Dashboard</p>
      </div>

      <nav className="space-y-2">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeSection === item.id;
          
          return (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                isActive 
                  ? 'bg-primary/10 text-primary' 
                  : 'text-gray-400 hover:bg-gray-800'
              }`}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};

// Stats Card
const StatsCard = ({ title, value, change, changeType, icon: Icon, loading }: any) => (
  <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-gray-400 text-sm mb-1">{title}</p>
        {loading ? (
          <div className="h-8 w-24 bg-gray-700 animate-pulse rounded" />
        ) : (
          <p className="text-2xl font-bold text-white">{value}</p>
        )}
        {change && (
          <div className={`flex items-center mt-2 text-sm ${
            changeType === 'positive' ? 'text-green-500' : 'text-red-500'
          }`}>
            {changeType === 'positive' ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
            <span className="ml-1">{change}</span>
          </div>
        )}
      </div>
      <div className="p-3 bg-primary/10 rounded-lg">
        <Icon className="text-primary" size={24} />
      </div>
    </div>
  </div>
);

// Data Table
const DataTable = ({ columns, data, loading, onRowClick }: any) => {
  if (loading) {
    return (
      <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
        <div className="animate-pulse space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-12 bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-900">
          <tr>
            {columns.map((col: any) => (
              <th
                key={col.key}
                className="px-6 py-4 text-left text-sm font-medium text-gray-400"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-700">
          {data.map((row: any, index: number) => (
            <tr
              key={index}
              onClick={() => onRowClick?.(row)}
              className="hover:bg-gray-750 cursor-pointer transition-colors"
            >
              {columns.map((col: any) => (
                <td key={col.key} className="px-6 py-4 text-sm text-gray-300">
                  {col.render ? col.render(row[col.key], row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// Alert Banner
const AlertBanner = ({ type, message, onDismiss }: any) => {
  const colors = {
    warning: 'bg-yellow-500/10 border-yellow-500 text-yellow-500',
    danger: 'bg-red-500/10 border-red-500 text-red-500',
    success: 'bg-green-500/10 border-green-500 text-green-500',
    info: 'bg-blue-500/10 border-blue-500 text-blue-500'
  };

  return (
    <div className={`flex items-center justify-between p-4 rounded-lg border ${colors[type as keyof typeof colors]}`}>
      <div className="flex items-center gap-3">
        <AlertTriangle size={20} />
        <span>{message}</span>
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className="hover:opacity-70">
          ×
        </button>
      )}
    </div>
  );
};

// Contract Control Panel
const ContractControl = ({ contract, address, isPaused, onTogglePause }: any) => (
  <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
    <div className="flex items-center justify-between mb-4">
      <div>
        <h3 className="text-lg font-semibold text-white">{contract}</h3>
        <p className="text-sm text-gray-500 font-mono">
          {address?.slice(0, 10)}...{address?.slice(-8)}
        </p>
      </div>
      <div className={`px-3 py-1 rounded-full text-sm ${
        isPaused ? 'bg-red-500/10 text-red-500' : 'bg-green-500/10 text-green-500'
      }`}>
        {isPaused ? 'Paused' : 'Active'}
      </div>
    </div>

    <div className="flex gap-2">
      <button
        onClick={() => onTogglePause(!isPaused)}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
          isPaused 
            ? 'bg-green-500/10 text-green-500 hover:bg-green-500/20' 
            : 'bg-red-500/10 text-red-500 hover:bg-red-500/20'
        }`}
      >
        {isPaused ? <Play size={16} /> : <Pause size={16} />}
        {isPaused ? 'Resume' : 'Pause'}
      </button>
      <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-700 text-gray-300 hover:bg-gray-600">
        <ExternalLink size={16} />
        Etherscan
      </button>
    </div>
  </div>
);

// ============ Section Components ============

// Overview Section
const OverviewSection = () => {
  const [stats, setStats] = useState<any>({});
  const [chartData, setChartData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      try {
        // Simulated data
        setStats({
          totalVolume: '$12.4M',
          totalPayments: '847,392',
          activeAgents: '2,847',
          totalStaked: '$8.2M'
        });

        setChartData(
          Array.from({ length: 24 }, (_, i) => ({
            hour: `${i}:00`,
            volume: Math.floor(Math.random() * 500000) + 100000,
            transactions: Math.floor(Math.random() * 5000) + 1000
          }))
        );
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">Overview</h2>
        <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700">
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatsCard
          title="Total Volume (24h)"
          value={stats.totalVolume}
          change="+12.5%"
          changeType="positive"
          icon={DollarSign}
          loading={loading}
        />
        <StatsCard
          title="Total Payments"
          value={stats.totalPayments}
          change="+8.3%"
          changeType="positive"
          icon={Activity}
          loading={loading}
        />
        <StatsCard
          title="Active Agents"
          value={stats.activeAgents}
          change="+124"
          changeType="positive"
          icon={Users}
          loading={loading}
        />
        <StatsCard
          title="Total Staked"
          value={stats.totalStaked}
          change="-2.1%"
          changeType="negative"
          icon={TrendingUp}
          loading={loading}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
          <h3 className="text-lg font-semibold text-white mb-4">Volume (24h)</h3>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="volumeGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="hour" stroke="#6b7280" />
              <YAxis stroke="#6b7280" />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1f2937',
                  border: '1px solid #374151',
                  borderRadius: '8px'
                }}
              />
              <Area
                type="monotone"
                dataKey="volume"
                stroke={COLORS.primary}
                fill="url(#volumeGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
          <h3 className="text-lg font-semibold text-white mb-4">Transactions (24h)</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="hour" stroke="#6b7280" />
              <YAxis stroke="#6b7280" />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1f2937',
                  border: '1px solid #374151',
                  borderRadius: '8px'
                }}
              />
              <Bar dataKey="transactions" fill={COLORS.secondary} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};

// Agents Section
const AgentsSection = () => {
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    // Simulated data
    setAgents([
      { address: '0x1234...5678', name: 'GPT-4-Enterprise', tier: 'Diamond', stake: '10,000 SYNX', reputation: 98, transactions: 12543 },
      { address: '0xabcd...efgh', name: 'Claude-3-Agent', tier: 'Platinum', stake: '8,500 SYNX', reputation: 96, transactions: 9876 },
      { address: '0x9876...4321', name: 'Stable-Diffusion-XL', tier: 'Gold', stake: '5,000 SYNX', reputation: 94, transactions: 7654 }
    ]);
    setLoading(false);
  }, []);

  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'address', label: 'Address' },
    { 
      key: 'tier', 
      label: 'Tier',
      render: (value: string) => (
        <span className={`px-2 py-1 rounded-full text-xs ${
          value === 'Diamond' ? 'bg-purple-500/20 text-purple-400' :
          value === 'Platinum' ? 'bg-blue-500/20 text-blue-400' :
          value === 'Gold' ? 'bg-yellow-500/20 text-yellow-400' :
          'bg-gray-500/20 text-gray-400'
        }`}>
          {value}
        </span>
      )
    },
    { key: 'stake', label: 'Stake' },
    { key: 'reputation', label: 'Reputation', render: (v: number) => `${v}%` },
    { key: 'transactions', label: 'Transactions', render: (v: number) => v.toLocaleString() }
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">Agents</h2>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
            <input
              type="text"
              placeholder="Search agents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-primary"
            />
          </div>
        </div>
      </div>

      <DataTable columns={columns} data={agents} loading={loading} />
    </div>
  );
};

// Security Section
const SecuritySection = () => {
  const [contracts, setContracts] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);

  useEffect(() => {
    setContracts([
      { name: 'Token', address: '0x1234...5678', paused: false },
      { name: 'Payment Router', address: '0xabcd...efgh', paused: false },
      { name: 'Reputation', address: '0x9876...4321', paused: false },
      { name: 'Service Registry', address: '0xfedc...ba98', paused: false },
      { name: 'Staking', address: '0x5555...6666', paused: false },
      { name: 'Bridge', address: '0x7777...8888', paused: false }
    ]);

    setAlerts([
      { type: 'warning', message: 'High gas prices detected on mainnet' },
      { type: 'info', message: 'Scheduled maintenance in 24 hours' }
    ]);
  }, []);

  const handleTogglePause = async (contractName: string, pause: boolean) => {
    setContracts(prev => prev.map(c =>
      c.name === contractName ? { ...c, paused: pause } : c
    ));
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">Security</h2>

      {/* Alerts */}
      <div className="space-y-4">
        {alerts.map((alert, i) => (
          <AlertBanner
            key={i}
            type={alert.type}
            message={alert.message}
            onDismiss={() => setAlerts(prev => prev.filter((_, idx) => idx !== i))}
          />
        ))}
      </div>

      {/* Contract Controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {contracts.map((contract) => (
          <ContractControl
            key={contract.name}
            contract={contract.name}
            address={contract.address}
            isPaused={contract.paused}
            onTogglePause={(pause: boolean) => handleTogglePause(contract.name, pause)}
          />
        ))}
      </div>

      {/* Emergency Actions */}
      <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-6">
        <h3 className="text-lg font-semibold text-red-400 mb-4">Emergency Actions</h3>
        <div className="flex gap-4">
          <button className="px-6 py-3 bg-red-500 text-white rounded-lg hover:bg-red-600 font-medium">
            Pause All Contracts
          </button>
          <button className="px-6 py-3 bg-gray-700 text-white rounded-lg hover:bg-gray-600 font-medium">
            Emergency Withdraw
          </button>
        </div>
      </div>
    </div>
  );
};

// ============ Main Dashboard ============

export default function AdminDashboard() {
  const [activeSection, setActiveSection] = useState('overview');

  const renderSection = () => {
    switch (activeSection) {
      case 'overview':
        return <OverviewSection />;
      case 'agents':
        return <AgentsSection />;
      case 'security':
        return <SecuritySection />;
      default:
        return (
          <div className="text-center py-20">
            <h3 className="text-xl text-gray-400">Section under development</h3>
          </div>
        );
    }
  };

  return (
    <div className="flex min-h-screen bg-gray-950 text-white">
      <Sidebar activeSection={activeSection} setActiveSection={setActiveSection} />
      
      <main className="flex-1 p-8">
        {renderSection()}
      </main>
    </div>
  );
}
