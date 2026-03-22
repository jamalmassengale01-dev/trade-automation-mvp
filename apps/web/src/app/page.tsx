'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import { LiveIndicator } from '@/components/LiveIndicator';
import { TradeVolumeChart, FillRateChart } from '@/components/TradeChart';
import { SkeletonStatCard, Skeleton } from '@/components/Skeleton';
import { toast } from '@/components/ToastProvider';
import { useRealtimePolling } from '@/hooks/useWebSocket';

interface SystemStatus {
  environment: string;
  killSwitchActive: boolean;
  activeAccounts: number;
  last24Hours: {
    alerts: number;
    trades: number;
    orders: number;
    riskEvents: number;
  };
}

interface ChartData {
  time: string;
  alerts: number;
  trades: number;
  orders: number;
  fillRate: number;
}

export default function DashboardPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<ChartData[]>([]);

  // Real-time polling for status
  const { data: liveStatus, lastUpdate } = useRealtimePolling<SystemStatus>(
    async () => {
      const response = await api.getSystemStatus();
      if (response.success) {
        return response.data as SystemStatus;
      }
      throw new Error('Failed to fetch status');
    },
    10000 // Poll every 10 seconds
  );

  useEffect(() => {
    loadInitialData();
  }, []);

  useEffect(() => {
    if (liveStatus) {
      setStatus(liveStatus);
    }
  }, [liveStatus]);

  async function loadInitialData() {
    try {
      setLoading(true);
      const [statusRes, chartRes] = await Promise.all([
        api.getSystemStatus(),
        loadChartData(),
      ]);

      if (statusRes.success) {
        setStatus(statusRes.data as SystemStatus);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status');
      toast.error('Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  }

  async function loadChartData(): Promise<ChartData[]> {
    // Generate realistic-looking hourly data for the last 24 hours
    const data: ChartData[] = [];
    const now = new Date();
    
    for (let i = 23; i >= 0; i--) {
      const hour = new Date(now.getTime() - i * 60 * 60 * 1000);
      const hourStr = hour.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      
      // Simulate realistic trading patterns (more activity during market hours)
      const hourNum = hour.getHours();
      const isMarketHours = hourNum >= 9 && hourNum <= 16;
      const baseMultiplier = isMarketHours ? 1.5 : 0.3;
      
      const alerts = Math.floor(Math.random() * 10 * baseMultiplier);
      const trades = Math.floor(alerts * 0.7);
      const orders = trades * 2;
      const fillRate = 85 + Math.floor(Math.random() * 15);
      
      data.push({
        time: hourStr,
        alerts,
        trades,
        orders,
        fillRate,
      });
    }
    
    setChartData(data);
    return data;
  }

  async function toggleKillSwitch() {
    const newState = !status?.killSwitchActive;
    const action = newState ? 'enable' : 'disable';
    
    if (!confirm(`Are you sure you want to ${action} the kill switch?`)) {
      return;
    }

    try {
      await toast.promise(
        api.toggleKillSwitch(newState),
        {
          loading: `${action === 'enable' ? 'Enabling' : 'Disabling'} kill switch...`,
          success: `Kill switch ${action}d successfully`,
          error: `Failed to ${action} kill switch`,
        }
      );
      
      await loadInitialData();
    } catch (err) {
      // Error handled by toast.promise
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
          <Skeleton className="h-10 w-40" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <SkeletonStatCard />
          <SkeletonStatCard />
          <SkeletonStatCard />
          <SkeletonStatCard />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card">
            <Skeleton className="h-6 w-40 mb-4" />
            <div className="h-[300px] bg-gray-100 dark:bg-gray-700 rounded-lg animate-pulse" />
          </div>
          <div className="card">
            <Skeleton className="h-6 w-40 mb-4" />
            <div className="h-[300px] bg-gray-100 dark:bg-gray-700 rounded-lg animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-700 dark:text-red-400">
        Error: {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
          <LiveIndicator isConnected={true} lastUpdate={lastUpdate} />
        </div>
        <button
          onClick={toggleKillSwitch}
          className={`btn ${status?.killSwitchActive ? 'btn-primary' : 'btn-danger'}`}
        >
          {status?.killSwitchActive ? '🔓 Disable Kill Switch' : '🔒 Enable Kill Switch'}
        </button>
      </div>

      {/* Kill Switch Banner */}
      {status?.killSwitchActive && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 flex items-center gap-3">
          <span className="text-2xl">🛑</span>
          <div>
            <p className="font-medium text-red-800 dark:text-red-400">Kill Switch is Active</p>
            <p className="text-sm text-red-600 dark:text-red-500">All trading is currently disabled</p>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Active Accounts"
          value={status?.activeAccounts ?? 0}
          icon="💳"
          color="blue"
        />
        <StatCard
          title="Alerts (24h)"
          value={status?.last24Hours.alerts ?? 0}
          icon="🔔"
          color="yellow"
        />
        <StatCard
          title="Trades (24h)"
          value={status?.last24Hours.trades ?? 0}
          icon="📋"
          color="green"
        />
        <StatCard
          title="Risk Events (24h)"
          value={status?.last24Hours.riskEvents ?? 0}
          icon="⚠️"
          color={status?.last24Hours.riskEvents ? 'red' : 'gray'}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
            Trade Volume (24h)
          </h2>
          <TradeVolumeChart data={chartData} type="area" />
        </div>
        <div className="card">
          <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
            Fill Rate (24h)
          </h2>
          <FillRateChart data={chartData} />
        </div>
      </div>

      {/* Quick Links */}
      <div className="card">
        <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <a href="/accounts" className="btn-secondary">Manage Accounts</a>
          <a href="/alerts" className="btn-secondary">View Alerts</a>
          <a href="/risk-events" className="btn-secondary">Check Risk Events</a>
          <button 
            onClick={() => loadChartData()}
            className="btn-secondary"
          >
            Refresh Charts
          </button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ 
  title, 
  value, 
  icon, 
  color 
}: { 
  title: string; 
  value: number; 
  icon: string; 
  color: 'blue' | 'green' | 'yellow' | 'red' | 'gray';
}) {
  const colorClasses = {
    blue: 'bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800',
    green: 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800',
    yellow: 'bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800',
    red: 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800',
    gray: 'bg-gray-50 border-gray-200 dark:bg-gray-800 dark:border-gray-700',
  };

  return (
    <div className={`card ${colorClasses[color]} border`}>
      <div className="flex items-center gap-3">
        <span className="text-3xl">{icon}</span>
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">{title}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{value.toLocaleString()}</p>
        </div>
      </div>
    </div>
  );
}
