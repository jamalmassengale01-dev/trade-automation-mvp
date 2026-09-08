'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, RuleCheck } from '@/lib/api';
import { Skeleton } from '@/components/Skeleton';
import { toast } from '@/components/ToastProvider';

/**
 * Rule reconciliation health.
 *
 * Every preset is a set of assumptions the executor sizes trades from. This
 * page shows where those assumptions disagree with what the broker actually
 * reports — a wrong preset on an account, a day-P&L counter that has drifted
 * from the broker's, drawdown room running out.
 *
 * A halt verdict blocks new trades on that account until it clears.
 */

const VERDICT: Record<
  RuleCheck['verdict'],
  { label: string; cls: string; blurb: string }
> = {
  ok:    { label: 'OK',     cls: 'bg-terminal-buy/15 text-terminal-buy border-terminal-buy/30',    blurb: 'Assumptions match the broker.' },
  warn:  { label: 'Warn',   cls: 'bg-yellow-500/15 text-yellow-500 border-yellow-500/30',          blurb: 'Trading continues — worth a look.' },
  halt:  { label: 'Halt',   cls: 'bg-terminal-sell/15 text-terminal-sell border-terminal-sell/30', blurb: 'New trades blocked on this account.' },
  error: { label: 'Error',  cls: 'bg-terminal-panel text-terminal-muted border-terminal-border',   blurb: 'Check could not run.' },
};

const money = (v: string | number | null) =>
  v === null || v === undefined ? '—' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function HealthPage() {
  const [checks, setChecks] = useState<RuleCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.getReconciliation();
      setChecks(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reconciliation');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function runNow() {
    setRunning(true);
    try {
      const res = await api.reconcileAll();
      const { checked, halts, warns } = res.data;
      if (halts > 0) toast.error(`${halts} account(s) halted, ${warns} warning(s) across ${checked} checked`);
      else if (warns > 0) toast.success(`${checked} checked — ${warns} warning(s), no halts`);
      else toast.success(`${checked} account(s) checked, all clear`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reconciliation failed');
    } finally {
      setRunning(false);
    }
  }

  const halts = checks.filter((c) => c.verdict === 'halt');
  const warns = checks.filter((c) => c.verdict === 'warn');

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-terminal-text">Account Health</h1>
          <p className="text-sm text-terminal-muted mt-1">
            Preset assumptions checked against what the broker actually reports. Runs automatically
            every 15 minutes.
          </p>
        </div>
        <button onClick={runNow} disabled={running} className="btn btn-primary text-sm shrink-0">
          {running ? 'Checking…' : 'Run check now'}
        </button>
      </div>

      {halts.length > 0 && (
        <div className="border border-terminal-sell/40 bg-terminal-sell/10 rounded-lg px-4 py-3">
          <p className="text-sm text-terminal-text">
            <span className="font-semibold text-terminal-sell">
              {halts.length} account{halts.length > 1 ? 's' : ''} halted.
            </span>{' '}
            New trades are blocked on {halts.length > 1 ? 'these' : 'this'} account until the
            mismatch is resolved.
          </p>
        </div>
      )}

      {error && (
        <div className="border border-terminal-sell/40 bg-terminal-sell/10 rounded-lg px-4 py-3">
          <p className="text-sm text-terminal-text">{error}</p>
        </div>
      )}

      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : checks.length === 0 ? (
        <div className="bg-terminal-surface border border-terminal-border rounded-lg p-10 text-center">
          <p className="text-sm text-terminal-muted">
            No checks have run yet. Hit <span className="text-terminal-text">Run check now</span> —
            accounts need a preset assigned before they can be reconciled.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {[...halts, ...warns, ...checks.filter((c) => c.verdict === 'ok' || c.verdict === 'error')].map((c) => {
            const v = VERDICT[c.verdict];
            return (
              <div
                key={c.broker_account_id}
                className="bg-terminal-surface border border-terminal-border rounded-lg p-4"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-terminal-text">{c.account_name}</h3>
                      <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${v.cls}`}>
                        {v.label}
                      </span>
                    </div>
                    <p className="text-xs text-terminal-muted mt-0.5">
                      {c.preset_id ?? 'no preset'} · checked {ago(c.checked_at)} · {v.blurb}
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-x-5 gap-y-1 text-xs font-mono">
                    <Cell label="Balance" value={money(c.broker_balance)} />
                    <Cell label="Day P&L (broker)" value={money(c.broker_realized_pnl)} />
                    <Cell label="Day P&L (tracked)" value={money(c.tracked_day_pnl)} />
                    <Cell label="Equity" value={money(c.broker_equity)} />
                    <Cell label="Cum P&L" value={money(c.tracked_cum_pnl)} />
                    <Cell label="Implied start" value={money(c.implied_start)} />
                  </div>
                </div>

                {c.error_message && (
                  <p className="text-xs text-terminal-sell mt-3 font-mono">{c.error_message}</p>
                )}

                {c.findings?.length > 0 && (
                  <ul className="mt-3 space-y-1.5 border-t border-terminal-border pt-3">
                    {c.findings.map((f, i) => (
                      <li key={i} className="text-xs flex gap-2">
                        <span
                          className={
                            f.severity === 'halt'
                              ? 'text-terminal-sell'
                              : f.severity === 'warn'
                              ? 'text-yellow-500'
                              : 'text-terminal-muted'
                          }
                        >
                          ●
                        </span>
                        <span className="text-terminal-text">{f.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-terminal-muted">
        The prop firm&apos;s daily loss limit and trailing drawdown are enforced firm-side and are
        not readable from the Tradovate API, so they cannot be verified automatically. Those numbers
        carry a manual verification date instead — see the Presets page.
      </p>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-terminal-muted text-[10px]">{label}</div>
      <div className="text-terminal-text">{value}</div>
    </div>
  );
}
