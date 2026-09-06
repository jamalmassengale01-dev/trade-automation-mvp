'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, GbAccount, GbPreset, GbTrade } from '@/lib/api';
import { SkeletonStatCard, Skeleton } from '@/components/Skeleton';
import { toast } from '@/components/ToastProvider';
import { useRealtimePolling } from '@/hooks/useWebSocket';

const SIM_OUTCOMES: Array<{ value: 'W' | 'W~' | 'L' | 'BE'; label: string; className: string }> = [
  { value: 'W', label: 'Win', className: 'bg-terminal-buy/20 text-terminal-buy hover:bg-terminal-buy/30' },
  { value: 'W~', label: 'Partial', className: 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30' },
  { value: 'BE', label: 'Breakeven', className: 'bg-terminal-panel text-terminal-muted hover:text-terminal-text' },
  { value: 'L', label: 'Loss', className: 'bg-terminal-sell/20 text-terminal-sell hover:bg-terminal-sell/30' },
];

const OUTCOME_STYLES: Record<string, string> = {
  W: 'text-terminal-buy',
  'W~': 'text-terminal-buy',
  BE: 'text-terminal-muted',
  L: 'text-terminal-sell',
  'L!': 'text-terminal-sell',
};

export default function FleetPage() {
  const [accounts, setAccounts] = useState<GbAccount[]>([]);
  const [presets, setPresets] = useState<GbPreset[]>([]);
  const [trades, setTrades] = useState<GbTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);

  const { data: liveAccounts } = useRealtimePolling<GbAccount[]>(
    async () => {
      const res = await api.getGbAccounts();
      if (res.success) return res.data;
      throw new Error('Failed to fetch fleet accounts');
    },
    10000
  );

  useEffect(() => { loadAll(); }, []);
  useEffect(() => { if (liveAccounts) setAccounts(liveAccounts); }, [liveAccounts]);

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      const [accRes, presetRes, tradeRes] = await Promise.all([
        api.getGbAccounts(),
        api.getGbPresets(),
        api.getGbTrades(1, 25),
      ]);
      if (accRes.success) setAccounts(accRes.data);
      if (presetRes.success) setPresets(presetRes.data);
      if (tradeRes.success) setTrades(tradeRes.data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load fleet data');
    } finally {
      setLoading(false);
    }
  }, []);

  async function handleAssignPreset(accountId: string, presetId: string) {
    setAssigningId(accountId);
    try {
      await api.assignPreset(accountId, presetId || null);
      toast.success(presetId ? 'Preset assigned — ladder reset to Step 1' : 'Preset removed');
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to assign preset');
    } finally {
      setAssigningId(null);
    }
  }

  async function handleSimulate(tradeId: string, outcome: 'W' | 'W~' | 'L' | 'BE') {
    try {
      await api.simulateGbExit(tradeId, outcome);
      toast.success(`Trade closed as ${outcome}`);
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Simulation failed');
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold text-terminal-text">LaunchPad Fleet</h1>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard />
        </div>
        <div className="card"><Skeleton className="h-64 w-full" /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-terminal-sell/10 border border-terminal-sell/30 rounded-lg p-4 text-terminal-sell">Error: {error}</div>
      </div>
    );
  }

  const gbAccounts = accounts.filter((a) => a.preset.id);
  const unassigned = accounts.filter((a) => !a.preset.id);
  const totalDayPnl = gbAccounts.reduce((s, a) => s + a.dayRealizedPnl, 0);
  const evalCount = gbAccounts.filter((a) => a.preset.phase === 'eval').length;
  const fundedCount = gbAccounts.filter((a) => a.preset.phase === 'funded').length;
  const totalTradesToday = gbAccounts.reduce((s, a) => s + a.tradesToday, 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-terminal-text">LaunchPad Fleet</h1>
        <button onClick={loadAll} className="btn btn-secondary text-xs">Refresh</button>
      </div>

      {/* Fleet Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="GB Accounts" value={gbAccounts.length} icon="🚀" accent="blue" />
        <StatCard title="Eval / Funded" value={`${evalCount} / ${fundedCount}`} icon="🎯" accent="yellow" isText />
        <StatCard
          title="Fleet Day P&L"
          value={`${totalDayPnl >= 0 ? '+' : ''}$${totalDayPnl.toFixed(2)}`}
          icon={totalDayPnl >= 0 ? '📈' : '📉'}
          accent={totalDayPnl >= 0 ? 'buy' : 'sell'}
          isText
        />
        <StatCard title="Trades Today" value={totalTradesToday} icon="⚡" accent="muted" />
      </div>

      {/* Accounts table */}
      <div className="card overflow-x-auto">
        <h2 className="text-sm font-semibold text-terminal-muted uppercase tracking-wider mb-4">Fleet Accounts</h2>
        {accounts.length === 0 ? (
          <p className="text-terminal-muted text-sm py-8 text-center">No broker accounts yet. Connect one from the Accounts page.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-terminal-border">
                {['Account', 'Preset', 'Ladder', 'Day P&L / DLL Room', 'Trades', 'Sessions', 'Last Trade', 'Action'].map((h) => (
                  <th key={h} className="text-left py-3 px-3 text-terminal-muted font-medium uppercase tracking-wider text-xs">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...gbAccounts, ...unassigned].map((a) => (
                <tr key={a.id} className="border-b border-terminal-border/50 hover:bg-terminal-panel/50">
                  <td className="py-3 px-3">
                    <div className="font-medium text-terminal-text">{a.name}</div>
                    <div className="text-xs text-terminal-muted capitalize">{a.brokerType}{a.isDisabled ? ' · disabled' : ''}</div>
                  </td>
                  <td className="py-3 px-3">
                    <select
                      className="input text-xs py-1"
                      value={a.preset.id ?? ''}
                      disabled={assigningId === a.id}
                      onChange={(e) => handleAssignPreset(a.id, e.target.value)}
                    >
                      <option value="">— none —</option>
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 px-3">
                    {a.preset.id ? (
                      <div>
                        <span className="font-mono text-terminal-text">Step {a.ladderStep}<span className="text-terminal-muted">/{a.preset.capStep}</span></span>
                        {a.dayLockedOut && (
                          <div className="text-[10px] font-semibold text-terminal-sell mt-0.5">🔒 DAY LOCKED</div>
                        )}
                        {a.inSniperMode && !a.dayLockedOut && (
                          <div className="text-[10px] font-semibold text-blue-400 mt-0.5">◆ SNIPER MODE (${a.remainingTarget?.toFixed(0)} left)</div>
                        )}
                      </div>
                    ) : <span className="text-terminal-muted">—</span>}
                  </td>
                  <td className="py-3 px-3">
                    {a.preset.id ? (
                      <div className="min-w-[140px]">
                        <div className={`font-mono ${a.dayRealizedPnl >= 0 ? 'text-terminal-buy' : 'text-terminal-sell'}`}>
                          {a.dayRealizedPnl >= 0 ? '+' : ''}${a.dayRealizedPnl.toFixed(2)}
                        </div>
                        <div className="h-1.5 rounded-full bg-terminal-panel mt-1 overflow-hidden">
                          <div
                            className={`h-full ${a.dllRoom / a.preset.dailyLossCap < 0.3 ? 'bg-terminal-sell' : 'bg-terminal-buy'}`}
                            style={{ width: `${Math.max(0, Math.min(100, (a.dllRoom / a.preset.dailyLossCap) * 100))}%` }}
                          />
                        </div>
                        <div className="text-[10px] text-terminal-muted mt-0.5">${a.dllRoom.toFixed(0)} room of ${a.preset.dailyLossCap}</div>
                      </div>
                    ) : <span className="text-terminal-muted">—</span>}
                  </td>
                  <td className="py-3 px-3 text-terminal-text">
                    {a.preset.id ? `${a.tradesToday}/${a.maxTradesDay}` : <span className="text-terminal-muted">—</span>}
                  </td>
                  <td className="py-3 px-3">
                    {a.preset.id ? (
                      <div className="flex gap-1">
                        <SessionChip label="LON" used={a.sessions.london} />
                        <SessionChip label="AM" used={a.sessions.nyam} />
                        <SessionChip label="PM" used={a.sessions.nypm} />
                      </div>
                    ) : <span className="text-terminal-muted">—</span>}
                  </td>
                  <td className="py-3 px-3">
                    {a.lastTrade ? (
                      <div>
                        <span className={`font-semibold ${OUTCOME_STYLES[a.lastTrade.outcome ?? ''] ?? 'text-terminal-muted'}`}>
                          {a.lastTrade.outcome ?? '…'}
                        </span>
                        {a.lastTrade.pnl !== null && (
                          <span className="text-terminal-muted ml-2 font-mono text-xs">
                            {a.lastTrade.pnl >= 0 ? '+' : ''}${a.lastTrade.pnl.toFixed(2)}
                          </span>
                        )}
                        <div className="text-[10px] text-terminal-muted">{a.lastTrade.symbol} {a.lastTrade.direction}</div>
                      </div>
                    ) : <span className="text-terminal-muted">No trades</span>}
                  </td>
                  <td className="py-3 px-3">
                    <a href={`/fleet/${a.id}`} className="text-xs text-terminal-buy hover:underline">History →</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent trades feed */}
      <div className="card overflow-x-auto">
        <h2 className="text-sm font-semibold text-terminal-muted uppercase tracking-wider mb-4">Recent GB Trades</h2>
        {trades.length === 0 ? (
          <p className="text-terminal-muted text-sm py-8 text-center">No GB LIVE trades yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-terminal-border">
                {['Time', 'Account', 'Symbol', 'Dir', 'Session', 'Step', 'Contracts', 'State', 'Outcome', 'P&L', 'Dev Sim'].map((h) => (
                  <th key={h} className="text-left py-2 px-3 text-terminal-muted font-medium uppercase tracking-wider text-xs">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const isOpen = t.state === 'open' || t.state === 'tp1_hit';
                return (
                  <tr key={t.id} className="border-b border-terminal-border/50 hover:bg-terminal-panel/50">
                    <td className="py-2 px-3 text-terminal-muted text-xs whitespace-nowrap">
                      {new Date(t.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="py-2 px-3 text-terminal-text">{t.account_name ?? t.broker_account_id.slice(0, 8)}</td>
                    <td className="py-2 px-3 font-mono text-terminal-text">{t.symbol}</td>
                    <td className={`py-2 px-3 font-medium ${t.direction === 'long' ? 'text-terminal-buy' : 'text-terminal-sell'}`}>
                      {t.direction === 'long' ? 'LONG' : 'SHORT'}
                    </td>
                    <td className="py-2 px-3 text-terminal-muted uppercase text-xs">{t.session ?? '—'}</td>
                    <td className="py-2 px-3 text-terminal-text">{t.step_at_entry}</td>
                    <td className="py-2 px-3 text-terminal-text">{t.contracts} <span className="text-terminal-muted text-xs">({t.g1_qty}/{t.g2_qty})</span></td>
                    <td className="py-2 px-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        t.state === 'closed' ? 'bg-terminal-panel text-terminal-muted' :
                        t.state === 'failed' ? 'bg-terminal-sell/20 text-terminal-sell' :
                        'bg-blue-500/20 text-blue-400'
                      }`}>{t.state.replace('_', ' ')}</span>
                    </td>
                    <td className={`py-2 px-3 font-semibold ${OUTCOME_STYLES[t.outcome ?? ''] ?? 'text-terminal-muted'}`}>{t.outcome ?? '—'}</td>
                    <td className="py-2 px-3 font-mono">
                      {t.pnl !== null ? (
                        <span className={Number(t.pnl) >= 0 ? 'text-terminal-buy' : 'text-terminal-sell'}>
                          {Number(t.pnl) >= 0 ? '+' : ''}${Number(t.pnl).toFixed(2)}
                        </span>
                      ) : <span className="text-terminal-muted">—</span>}
                    </td>
                    <td className="py-2 px-3">
                      {isOpen ? (
                        <div className="flex gap-1 flex-wrap">
                          {SIM_OUTCOMES.map((o) => (
                            <button
                              key={o.value}
                              onClick={() => handleSimulate(t.id, o.value)}
                              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${o.className}`}
                              title={`Simulate ${o.label} (mock/simulated accounts only)`}
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                      ) : <span className="text-terminal-muted text-xs">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SessionChip({ label, used }: { label: string; used: boolean }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
      used ? 'bg-terminal-muted/20 text-terminal-muted line-through' : 'bg-terminal-buy/20 text-terminal-buy'
    }`}>
      {label}
    </span>
  );
}

type AccentColor = 'buy' | 'sell' | 'blue' | 'yellow' | 'muted';

function StatCard({ title, value, icon, accent, isText }: { title: string; value: number | string; icon: string; accent: AccentColor; isText?: boolean }) {
  const borderClasses: Record<AccentColor, string> = {
    buy: 'border-terminal-buy/30 bg-terminal-buy/5',
    sell: 'border-terminal-sell/30 bg-terminal-sell/5',
    blue: 'border-blue-500/30 bg-blue-500/5',
    yellow: 'border-yellow-500/30 bg-yellow-500/5',
    muted: 'border-terminal-border bg-terminal-panel',
  };
  const valueClasses: Record<AccentColor, string> = {
    buy: 'text-terminal-buy',
    sell: 'text-terminal-sell',
    blue: 'text-blue-400',
    yellow: 'text-yellow-400',
    muted: 'text-terminal-muted',
  };
  return (
    <div className={`card border ${borderClasses[accent]}`}>
      <div className="flex items-center gap-3">
        <span className="text-3xl">{icon}</span>
        <div>
          <p className="text-xs text-terminal-muted uppercase tracking-wide">{title}</p>
          <p className={`text-2xl font-bold ${valueClasses[accent]}`}>{isText ? value : Number(value).toLocaleString()}</p>
        </div>
      </div>
    </div>
  );
}
