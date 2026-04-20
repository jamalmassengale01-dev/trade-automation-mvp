'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { LiveIndicator } from '@/components/LiveIndicator';
import { TradeVolumeChart, FillRateChart } from '@/components/TradeChart';
import { SkeletonStatCard, Skeleton } from '@/components/Skeleton';
import { ExecutionFeed } from '@/components/ExecutionFeed';
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
  const [togglingKill, setTogglingKill] = useState(false);

  const { data: liveStatus, lastUpdate } = useRealtimePolling<SystemStatus>(
    async () => {
      const response = await api.getSystemStatus();
      if (response.success) return response.data as SystemStatus;
      throw new Error('Failed to fetch status');
    },
    10000
  );

  useEffect(() => { loadInitialData(); }, []);

  useEffect(() => {
    if (liveStatus) setStatus(liveStatus);
  }, [liveStatus]);

  const loadChartData = useCallback(async () => {
    try {
      // Fetch real alert stats from the API
      const [alertStatsRes, ordersRes] = await Promise.all([
        api.getAlertStats().catch(() => null),
        api.getOrders(1, 100).catch(() => null),
      ]);

      const alertStats = (alertStatsRes as any)?.data;
      const orders = (ordersRes as any)?.data?.items ?? [];

      // Build hourly buckets for the last 24 hours
      const buckets: Record<string, { alerts: number; trades: number; orders: number; fills: number }> = {};
      const now = new Date();

      for (let i = 23; i >= 0; i--) {
        const h = new Date(now.getTime() - i * 3_600_000);
        const key = h.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        buckets[key] = { alerts: 0, trades: 0, orders: 0, fills: 0 };
      }

      // Populate from real orders data
      for (const order of orders) {
        const created = order.created_at ? new Date(order.created_at) : null;
        if (!created) continue;
        const age = now.getTime() - created.getTime();
        if (age > 86_400_000) continue;
        const key = created.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        if (buckets[key]) {
          buckets[key].orders += 1;
          if (order.status === 'filled') buckets[key].fills += 1;
        }
      }

      // Use alert overview stats if available, otherwise fall back to order-derived counts
      const data: ChartData[] = Object.entries(buckets).map(([time, b]) => ({
        time,
        alerts: b.alerts,
        trades: b.orders > 0 ? Math.ceil(b.orders / 2) : 0,
        orders: b.orders,
        fillRate: b.orders > 0 ? Math.round((b.fills / b.orders) * 100) : 0,
      }));

      // If we have real alert stats with hourly breakdown, merge them in
      if (alertStats?.hourly) {
        for (const entry of alertStats.hourly as { hour: string; count: number }[]) {
          const key = new Date(entry.hour).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          const slot = data.find((d) => d.time === key);
          if (slot) slot.alerts = entry.count;
        }
      }

      setChartData(data);
    } catch {
      // Silently fall back to empty chart — non-critical
      setChartData([]);
    }
  }, []);

  async function loadInitialData() {
    try {
      setLoading(true);
      const [statusRes] = await Promise.all([
        api.getSystemStatus(),
        loadChartData(),
      ]);
      if (statusRes.success) setStatus(statusRes.data as SystemStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      toast.error('Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  }

  async function handleKillSwitch() {
    if (!status) return;
    const enabling = !status.killSwitchActive;
    const verb = enabling ? 'ACTIVATE' : 'deactivate';
    if (!window.confirm(`${enabling ? '⚠️ EMERGENCY STOP — ' : ''}Are you sure you want to ${verb} the kill switch?`)) return;

    setTogglingKill(true);
    try {
      await api.toggleKillSwitch(enabling);
      toast.success(enabling ? 'Kill switch activated — all trading stopped' : 'Kill switch deactivated — trading resumed');
      await loadInitialData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle kill switch');
    } finally {
      setTogglingKill(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-terminal-text">Dashboard</h1>
          <Skeleton className="h-10 w-44" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card"><Skeleton className="h-6 w-40 mb-4" /><div className="h-72 bg-terminal-panel rounded animate-pulse" /></div>
          <div className="card"><Skeleton className="h-6 w-40 mb-4" /><div className="h-72 bg-terminal-panel rounded animate-pulse" /></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-terminal-sell/10 border border-terminal-sell/30 rounded-lg p-4 text-terminal-sell">
          Error: {error}
        </div>
      </div>
    );
  }

  const killActive = status?.killSwitchActive ?? false;

  return (
    <div className="p-6 space-y-5">
      {/* ================================================
          GLOBAL KILL SWITCH BANNER — always visible at top
          ================================================ */}
      <div
        className={`rounded-lg border px-5 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 transition-all ${
          killActive
            ? 'bg-terminal-killswitch/10 border-terminal-killswitch kill-switch-active'
            : 'bg-terminal-surface border-terminal-border'
        }`}
      >
        <div className="flex items-center gap-3">
          {killActive ? (
            <>
              <span className="text-3xl">🛑</span>
              <div>
                <p className="font-bold text-terminal-killswitch text-lg">KILL SWITCH ACTIVE</p>
                <p className="text-sm text-terminal-sell/80">All incoming alerts are blocked. Trading is halted.</p>
              </div>
            </>
          ) : (
            <>
              <span className="text-3xl">✅</span>
              <div>
                <p className="font-semibold text-terminal-text">System Armed &amp; Trading</p>
                <p className="text-sm text-terminal-muted">All strategies are processing alerts normally.</p>
              </div>
            </>
          )}
        </div>

        <button
          onClick={handleKillSwitch}
          disabled={togglingKill}
          className={`shrink-0 px-5 py-2.5 rounded-lg font-bold text-sm transition-all focus:outline-none ${
            killActive
              ? 'bg-terminal-buy/20 border border-terminal-buy text-terminal-buy hover:bg-terminal-buy/30'
              : 'bg-terminal-killswitch text-white hover:opacity-90 shadow-[0_0_20px_rgba(220,38,38,0.5)] hover:shadow-[0_0_32px_rgba(220,38,38,0.7)]'
          }`}
        >
          {togglingKill
            ? '…'
            : killActive
            ? '▶ Resume Trading'
            : '⏹ Emergency Stop'}
        </button>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-terminal-text">Dashboard</h1>
          <LiveIndicator isConnected={true} lastUpdate={lastUpdate} />
        </div>
        <button
          onClick={() => loadChartData()}
          className="btn btn-secondary text-xs"
        >
          Refresh Charts
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Active Accounts"
          value={status?.activeAccounts ?? 0}
          icon="💳"
          accent="blue"
        />
        <StatCard
          title="Alerts (24h)"
          value={status?.last24Hours.alerts ?? 0}
          icon="🔔"
          accent="yellow"
        />
        <StatCard
          title="Trades (24h)"
          value={status?.last24Hours.trades ?? 0}
          icon="📋"
          accent="buy"
        />
        <StatCard
          title="Risk Events (24h)"
          value={status?.last24Hours.riskEvents ?? 0}
          icon="⚠️"
          accent={status?.last24Hours.riskEvents ? 'sell' : 'muted'}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <h2 className="text-sm font-semibold text-terminal-muted uppercase tracking-wider mb-4">
            Trade Volume (24h)
          </h2>
          <TradeVolumeChart data={chartData} type="area" />
        </div>
        <div className="card">
          <h2 className="text-sm font-semibold text-terminal-muted uppercase tracking-wider mb-4">
            Fill Rate (24h)
          </h2>
          <FillRateChart data={chartData} />
        </div>
      </div>

      {/* Live Execution Feed */}
      <ExecutionFeed />

      {/* Quick Actions */}
      <div className="card">
        <h2 className="text-sm font-semibold text-terminal-muted uppercase tracking-wider mb-4">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <a href="/strategies" className="btn btn-secondary text-sm">Manage Strategies</a>
          <a href="/accounts" className="btn btn-secondary text-sm">Manage Accounts</a>
          <a href="/alerts" className="btn btn-secondary text-sm">View Alerts</a>
          <a href="/risk-events" className="btn btn-secondary text-sm">Risk Events</a>
        </div>
      </div>
    </div>
  );
}

type AccentColor = 'buy' | 'sell' | 'blue' | 'yellow' | 'muted';

function StatCard({ title, value, icon, accent }: { title: string; value: number; icon: string; accent: AccentColor }) {
  const borderClasses: Record<AccentColor, string> = {
    buy:    'border-terminal-buy/30 bg-terminal-buy/5',
    sell:   'border-terminal-sell/30 bg-terminal-sell/5',
    blue:   'border-blue-500/30 bg-blue-500/5',
    yellow: 'border-yellow-500/30 bg-yellow-500/5',
    muted:  'border-terminal-border bg-terminal-panel',
  };
  const valueClasses: Record<AccentColor, string> = {
    buy:    'text-terminal-buy',
    sell:   'text-terminal-sell',
    blue:   'text-blue-400',
    yellow: 'text-yellow-400',
    muted:  'text-terminal-muted',
  };

  return (
    <div className={`card border ${borderClasses[accent]}`}>
      <div className="flex items-center gap-3">
        <span className="text-3xl">{icon}</span>
        <div>
          <p className="text-xs text-terminal-muted uppercase tracking-wide">{title}</p>
          <p className={`text-2xl font-bold ${valueClasses[accent]}`}>{value.toLocaleString()}</p>
        </div>
      </div>
    </div>
  );
}
