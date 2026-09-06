'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { api, GbAccount, GbTrade } from '@/lib/api';
import { Skeleton } from '@/components/Skeleton';
import { Pagination } from '@/components/Pagination';
import { toast } from '@/components/ToastProvider';

const OUTCOME_STYLES: Record<string, string> = {
  W: 'text-terminal-buy',
  'W~': 'text-terminal-buy',
  BE: 'text-terminal-muted',
  L: 'text-terminal-sell',
  'L!': 'text-terminal-sell',
};

const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

export default function FleetAccountDetailPage() {
  const params = useParams();
  const accountId = String(params.id);

  const [account, setAccount] = useState<GbAccount | null>(null);
  const [trades, setTrades] = useState<GbTrade[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: number) => {
    try {
      setLoading(true);
      const [accRes, tradesRes] = await Promise.all([
        api.getGbAccounts(),
        api.getGbAccountTrades(accountId, p, 20),
      ]);
      if (accRes.success) {
        const found = accRes.data.find((a) => a.id === accountId) ?? null;
        setAccount(found);
      }
      if (tradesRes.success) {
        setTrades(tradesRes.data.items);
        setTotalPages(tradesRes.data.totalPages || 1);
        setTotal(tradesRes.data.total);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load account');
      toast.error('Failed to load account history');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { load(page); }, [load, page]);

  if (loading && !account) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="card"><Skeleton className="h-96 w-full" /></div>
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

  const wins = trades.filter((t) => t.outcome === 'W' || t.outcome === 'W~').length;
  const losses = trades.filter((t) => t.outcome === 'L' || t.outcome === 'L!').length;
  const closedPnl = trades.reduce((s, t) => s + (num(t.pnl) ?? 0), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <a href="/fleet" className="text-terminal-muted hover:text-terminal-text text-sm">← Fleet</a>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-terminal-text">{account?.name ?? 'Account'}</h1>
          {account?.preset.name && (
            <p className="text-sm text-terminal-muted">{account.preset.name} · {account.preset.propFirm}</p>
          )}
        </div>
        <button onClick={() => load(page)} className="btn btn-secondary text-xs">Refresh</button>
      </div>

      {account && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Ladder Step" value={`${account.ladderStep} / ${account.preset.capStep}`} />
          <Stat
            label="Day P&L"
            value={`${account.dayRealizedPnl >= 0 ? '+' : ''}$${account.dayRealizedPnl.toFixed(2)}`}
            accent={account.dayRealizedPnl >= 0 ? 'buy' : 'sell'}
          />
          <Stat label="Trades Today" value={`${account.tradesToday} / ${account.maxTradesDay}`} />
          <Stat label="This Page W/L" value={`${wins}W / ${losses}L`} />
        </div>
      )}

      <div className="card overflow-x-auto">
        <h2 className="text-sm font-semibold text-terminal-muted uppercase tracking-wider mb-4">
          Trade History {closedPnl !== 0 && <span className="normal-case font-normal">(page total: {closedPnl >= 0 ? '+' : ''}${closedPnl.toFixed(2)})</span>}
        </h2>
        {trades.length === 0 ? (
          <p className="text-terminal-muted text-sm py-8 text-center">No trades yet for this account.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-terminal-border">
                {['Date', 'Session', 'Symbol', 'Dir', 'Entry', 'SL', 'TP1', 'TP2', 'Contracts', 'Step', 'State', 'Outcome', 'P&L'].map((h) => (
                  <th key={h} className="text-left py-2 px-3 text-terminal-muted font-medium uppercase tracking-wider text-xs whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-b border-terminal-border/50 hover:bg-terminal-panel/50">
                  <td className="py-2 px-3 text-terminal-muted text-xs whitespace-nowrap">
                    {new Date(t.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="py-2 px-3 text-terminal-muted uppercase text-xs">{t.session ?? '—'}</td>
                  <td className="py-2 px-3 font-mono text-terminal-text">{t.symbol}</td>
                  <td className={`py-2 px-3 font-medium ${t.direction === 'long' ? 'text-terminal-buy' : 'text-terminal-sell'}`}>
                    {t.direction === 'long' ? 'LONG' : 'SHORT'}
                  </td>
                  <td className="py-2 px-3 font-mono text-terminal-text">{num(t.entry_price)?.toFixed(2) ?? '—'}</td>
                  <td className="py-2 px-3 font-mono text-terminal-sell/80">{num(t.sl_price)?.toFixed(2) ?? '—'}</td>
                  <td className="py-2 px-3 font-mono text-terminal-buy/80">{num(t.tp1_price)?.toFixed(2) ?? '—'}</td>
                  <td className="py-2 px-3 font-mono text-terminal-buy/80">{num(t.tp2_price)?.toFixed(2) ?? '—'}</td>
                  <td className="py-2 px-3 text-terminal-text">{t.contracts} <span className="text-terminal-muted text-xs">({t.g1_qty}/{t.g2_qty})</span></td>
                  <td className="py-2 px-3 text-terminal-text">{t.step_at_entry}</td>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {totalPages > 1 && (
          <Pagination page={page} pageSize={20} total={total} totalPages={totalPages} onPageChange={setPage} />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'buy' | 'sell' }) {
  const color = accent === 'buy' ? 'text-terminal-buy' : accent === 'sell' ? 'text-terminal-sell' : 'text-terminal-text';
  return (
    <div className="card">
      <p className="text-xs text-terminal-muted uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
    </div>
  );
}
