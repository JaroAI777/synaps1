/**
 * SYNAPSE Protocol - Analytics Dashboard
 * React component for visualizing protocol metrics
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, ResponsiveContainer,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend
} from 'recharts';
import { 
  Activity, Users, DollarSign, Zap, 
  TrendingUp, Clock, Server, Shield,
  ArrowUpRight, ArrowDownRight, RefreshCw
} from 'lucide-react';

// Colors
const COLORS = {
  primary: '#00d4aa',
  secondary: '#6366f1',
  accent: '#f59e0b',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  muted: '#6b7280',
  background: '#0a0a0f',
  card: '#111118',
  border: '#1f1f2e'
};

const CHART_COLORS = ['#00d4aa', '#6366f1', '#f59e0b', '#ef4444', '#10b981', '#8b5cf6'];

// Stat Card Component
const StatCard = ({ title, value, change, changeType, icon: Icon, loading }) => (
  <div className="bg-card border border-border rounded-xl p-6 hover:border-primary/50 transition-colors">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-muted text-sm mb-1">{title}</p>
        {loading ? (
          <div className="h-8 w-24 bg-border animate-pulse rounded" />
        ) : (
          <p className="text-2xl font-bold text-white">{value}</p>
        )}
        {change !== undefined && (
          <div className={`flex items-center mt-2 text-sm ${
            changeType === 'positive' ? 'text-success' : 
            changeType === 'negative' ? 'text-danger' : 'text-muted'
          }`}>
            {changeType === 'positive' ? <ArrowUpRight size={16} /> : 
             changeType === 'negative' ? <ArrowDownRight size={16} /> : null}
            <span>{change}</span>
          </div>
        )}
      </div>
      <div className="p-3 bg-primary/10 rounded-lg">
        <Icon className="text-primary" size={24} />
      </div>
    </div>
  </div>
);

// Mini Chart Component
const MiniChart = ({ data, dataKey, color }) => (
  <ResponsiveContainer width="100%" height={60}>
    <AreaChart data={data}>
      <defs>
        <linearGradient id={`gradient-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stopColor={color} stopOpacity={0.3} />
          <stop offset="95%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <Area
        type="monotone"
        dataKey={dataKey}
        stroke={color}
        fill={`url(#gradient-${dataKey})`}
        strokeWidth={2}
      />
    </AreaChart>
  </ResponsiveContainer>
);

// Activity Item Component
const ActivityItem = ({ type, description, time, amount, status }) => {
  const typeIcons = {
    payment: DollarSign,
    agent: Users,
    channel: Zap,
    service: Server
  };
  const Icon = typeIcons[type] || Activity;
  
  return (
    <div className="flex items-center gap-4 p-4 hover:bg-border/50 rounded-lg transition-colors">
      <div className={`p-2 rounded-lg ${
        status === 'success' ? 'bg-success/10 text-success' :
        status === 'pending' ? 'bg-warning/10 text-warning' :
        'bg-muted/10 text-muted'
      }`}>
        <Icon size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium truncate">{description}</p>
        <p className="text-muted text-xs">{time}</p>
      </div>
      {amount && (
        <p className="text-primary font-medium">{amount}</p>
      )}
    </div>
  );
};

// Main Dashboard Component
const SynapseDashboard = () => {
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState('24h');
  const [stats, setStats] = useState({
    totalVolume: '$0',
    totalPayments: '0',
    activeAgents: '0',
    activeChannels: '0',
    tvl: '$0',
    avgTxSize: '$0'
  });
  const [chartData, setChartData] = useState([]);
  const [pieData, setPieData] = useState([]);
  const [activities, setActivities] = useState([]);
  const [topAgents, setTopAgents] = useState([]);

  // Fetch data
  const fetchData = useCallback(async () => {
    setLoading(true);
    
    try {
      // Simulated data - replace with actual API calls
      await new Promise(r => setTimeout(r, 1000));
      
      // Stats
      setStats({
        totalVolume: '$12.4M',
        totalPayments: '847,392',
        activeAgents: '2,847',
        activeChannels: '1,234',
        tvl: '$8.2M',
        avgTxSize: '$14.63'
      });
      
      // Chart data
      const hours = Array.from({ length: 24 }, (_, i) => {
        const time = new Date();
        time.setHours(time.getHours() - (23 - i));
        return {
          time: time.toLocaleTimeString('en-US', { hour: '2-digit' }),
          volume: Math.floor(Math.random() * 500000) + 100000,
          payments: Math.floor(Math.random() * 5000) + 1000,
          fees: Math.floor(Math.random() * 5000) + 500
        };
      });
      setChartData(hours);
      
      // Pie data
      setPieData([
        { name: 'Language Models', value: 45 },
        { name: 'Image Generation', value: 25 },
        { name: 'Code Generation', value: 15 },
        { name: 'Data Analysis', value: 10 },
        { name: 'Other', value: 5 }
      ]);
      
      // Activities
      setActivities([
        { type: 'payment', description: 'Payment from 0x1234...5678', time: '2 min ago', amount: '125 SYNX', status: 'success' },
        { type: 'agent', description: 'New agent registered: GPT-4-Agent', time: '5 min ago', status: 'success' },
        { type: 'channel', description: 'Channel opened: 0xabcd...efgh', time: '12 min ago', amount: '5,000 SYNX', status: 'success' },
        { type: 'payment', description: 'Batch payment (15 recipients)', time: '18 min ago', amount: '2,340 SYNX', status: 'success' },
        { type: 'service', description: 'Service updated: Translation-API', time: '25 min ago', status: 'pending' }
      ]);
      
      // Top agents
      setTopAgents([
        { name: 'GPT-4-Enterprise', volume: '$1.2M', tier: 'Diamond', rating: 4.9 },
        { name: 'Claude-3-Agent', volume: '$980K', tier: 'Platinum', rating: 4.8 },
        { name: 'Stable-Diffusion-XL', volume: '$750K', tier: 'Gold', rating: 4.7 },
        { name: 'Code-Assistant-Pro', volume: '$520K', tier: 'Gold', rating: 4.6 },
        { name: 'Data-Analyzer-AI', volume: '$340K', tier: 'Silver', rating: 4.5 }
      ]);
      
    } catch (error) {
      console.error('Failed to fetch data:', error);
    }
    
    setLoading(false);
  }, [timeRange]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <div className="min-h-screen bg-background text-white p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">
            <span className="text-primary">SYNAPSE</span> Analytics
          </h1>
          <p className="text-muted mt-1">Real-time protocol metrics</p>
        </div>
        <div className="flex items-center gap-4">
          {/* Time Range Selector */}
          <div className="flex bg-card border border-border rounded-lg p-1">
            {['1h', '24h', '7d', '30d'].map(range => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  timeRange === range 
                    ? 'bg-primary text-black' 
                    : 'text-muted hover:text-white'
                }`}
              >
                {range}
              </button>
            ))}
          </div>
          {/* Refresh Button */}
          <button
            onClick={fetchData}
            className="p-2 bg-card border border-border rounded-lg hover:border-primary/50 transition-colors"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatCard
          title="Total Volume"
          value={stats.totalVolume}
          change="+12.5% from yesterday"
          changeType="positive"
          icon={DollarSign}
          loading={loading}
        />
        <StatCard
          title="Total Payments"
          value={stats.totalPayments}
          change="+8.3% from yesterday"
          changeType="positive"
          icon={Activity}
          loading={loading}
        />
        <StatCard
          title="Active Agents"
          value={stats.activeAgents}
          change="+124 new today"
          changeType="positive"
          icon={Users}
          loading={loading}
        />
        <StatCard
          title="Active Channels"
          value={stats.activeChannels}
          change="-2.1% from yesterday"
          changeType="negative"
          icon={Zap}
          loading={loading}
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Volume Chart */}
        <div className="lg:col-span-2 bg-card border border-border rounded-xl p-6">
          <h3 className="text-lg font-semibold mb-4">Payment Volume</h3>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="volumeGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="time" stroke={COLORS.muted} fontSize={12} />
              <YAxis stroke={COLORS.muted} fontSize={12} />
              <Tooltip
                contentStyle={{
                  backgroundColor: COLORS.card,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: '8px'
                }}
              />
              <Area
                type="monotone"
                dataKey="volume"
                stroke={COLORS.primary}
                fill="url(#volumeGradient)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Service Distribution */}
        <div className="bg-card border border-border rounded-xl p-6">
          <h3 className="text-lg font-semibold mb-4">Service Distribution</h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={80}
                paddingAngle={5}
                dataKey="value"
              >
                {pieData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: COLORS.card,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: '8px'
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-2 mt-4">
            {pieData.map((entry, index) => (
              <div key={entry.name} className="flex items-center gap-2 text-xs">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }}
                />
                <span className="text-muted">{entry.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Activity */}
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Recent Activity</h3>
            <button className="text-primary text-sm hover:underline">View All</button>
          </div>
          <div className="space-y-2">
            {activities.map((activity, index) => (
              <ActivityItem key={index} {...activity} />
            ))}
          </div>
        </div>

        {/* Top Agents */}
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Top Agents</h3>
            <button className="text-primary text-sm hover:underline">View All</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-muted text-sm border-b border-border">
                  <th className="text-left py-3 px-2">Agent</th>
                  <th className="text-left py-3 px-2">Volume</th>
                  <th className="text-left py-3 px-2">Tier</th>
                  <th className="text-left py-3 px-2">Rating</th>
                </tr>
              </thead>
              <tbody>
                {topAgents.map((agent, index) => (
                  <tr key={index} className="border-b border-border/50 hover:bg-border/30 transition-colors">
                    <td className="py-3 px-2">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-primary/10 rounded-full flex items-center justify-center">
                          <Users size={16} className="text-primary" />
                        </div>
                        <span className="font-medium">{agent.name}</span>
                      </div>
                    </td>
                    <td className="py-3 px-2 text-primary font-medium">{agent.volume}</td>
                    <td className="py-3 px-2">
                      <span className={`px-2 py-1 rounded-full text-xs ${
                        agent.tier === 'Diamond' ? 'bg-purple-500/20 text-purple-400' :
                        agent.tier === 'Platinum' ? 'bg-blue-500/20 text-blue-400' :
                        agent.tier === 'Gold' ? 'bg-yellow-500/20 text-yellow-400' :
                        'bg-gray-500/20 text-gray-400'
                      }`}>
                        {agent.tier}
                      </span>
                    </td>
                    <td className="py-3 px-2">
                      <div className="flex items-center gap-1">
                        <span className="text-yellow-500">★</span>
                        <span>{agent.rating}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Protocol Health */}
      <div className="mt-8 bg-card border border-border rounded-xl p-6">
        <h3 className="text-lg font-semibold mb-6">Protocol Health</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          <div className="text-center">
            <div className="w-16 h-16 mx-auto mb-3 bg-success/10 rounded-full flex items-center justify-center">
              <Shield className="text-success" size={28} />
            </div>
            <p className="text-2xl font-bold text-success">99.9%</p>
            <p className="text-muted text-sm">Uptime</p>
          </div>
          <div className="text-center">
            <div className="w-16 h-16 mx-auto mb-3 bg-primary/10 rounded-full flex items-center justify-center">
              <Clock className="text-primary" size={28} />
            </div>
            <p className="text-2xl font-bold text-primary">0.8s</p>
            <p className="text-muted text-sm">Avg. Latency</p>
          </div>
          <div className="text-center">
            <div className="w-16 h-16 mx-auto mb-3 bg-secondary/10 rounded-full flex items-center justify-center">
              <TrendingUp className="text-secondary" size={28} />
            </div>
            <p className="text-2xl font-bold text-secondary">98.5%</p>
            <p className="text-muted text-sm">Success Rate</p>
          </div>
          <div className="text-center">
            <div className="w-16 h-16 mx-auto mb-3 bg-accent/10 rounded-full flex items-center justify-center">
              <Zap className="text-accent" size={28} />
            </div>
            <p className="text-2xl font-bold text-accent">1,247</p>
            <p className="text-muted text-sm">TPS</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SynapseDashboard;
