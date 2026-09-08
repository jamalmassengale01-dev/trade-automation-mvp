'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, AccountPayoutStatus, PayoutBlocker } from '@/lib/api';
import { Skeleton } from '@/components/Skeleton';
import { toast } from '@/components/ToastProvider';

/**
 * LaunchPad — the payout side of the fleet.
 *
 * The Fleet page answers "is this account trading correctly?". This answers
 * "when does it pay, and what is holding it up?" — which is the question that
 * actually decides whether an account is worth keeping open.
 *
 * Every blocker is shown, not just the first. They are independent conditions,
 * and being told about qualifying days this week and consistency the next is
 * how a payout slips a fortnight.
 */

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const BLOCKER_LABEL: Record<PayoutBlocker['reason'], string> = {
  insufficient_qualifying_days: 'Qualifying days',
  below_safety_net: 'Balance',
  consistency: 'Consistency',
  all_payouts_taken: 'Cycle complete',
};

export default function LaunchpadPage() {
  const [rows, setRows] = useState<AccountPayoutStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.getLaunchpad();
      setRows(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load LaunchPad');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function request(row: AccountPayoutStatus) {
    setBusy(row.accountId);
    try {
      const res = await api.requestPayout(row.accountId);
      toast.success(`Payout #${res.data.payoutNumber} requested for ${money(res.data.amount)}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Payout request failed');
    } finally {
      setBusy(null);
    }
  }

  const funded = rows.filter((r) => r.phase === 'funded' && r.eligibility);
  const others = rows.filter((r) => !(r.phase === 'funded' && r.eligibility));

  const totalExtracted = funded.reduce((s, r) => s + r.totalExtracted, 0);
  const readyNow = funded.filter((r) => r.eligibility!.eligible);
  const readyAmount = readyNow.reduce((s, r) => s + r.eligibility!.requestableAmount, 0);

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold text-terminal-text">LaunchPad</h1>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-terminal-sell/10 border border-terminal-sell/30 rounded-lg p-4 text-terminal-sell">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-terminal-text">LaunchPad</h1>
        <p className="text-sm text-terminal-muted mt-1">
          Payout progress across the fleet. A funded account needs qualifying days, balance above
          the safety net, and consistency — independently, all at once.
        </p>
      </div>

      {/* ---- fleet summary ---- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Funded accounts" value={String(funded.length)} />
        <Stat label="Ready to request" value={String(readyNow.length)} accent={readyNow.length > 0} />
        <Stat label="Available now" value={money(readyAmount)} accent={readyAmount > 0} />
        <Stat label="Extracted all-time" value={money(totalExtracted)} />
      </div>

      {funded.length === 0 && (
        <div className="bg-terminal-surface border border-terminal-border rounded-lg p-10 text-center">
          <p className="text-sm text-terminal-muted">
            No funded accounts yet. Payout tracking starts once an evaluation passes and a
            Performance Account is activated.
          </p>
        </div>
      )}

      {funded.map((r) => {
        const e = r.eligibility!;
        const pct = Math.min(100, (e.qualifyingDayCount / Math.max(1, e.qualifyingDayCount + e.daysStillNeeded)) * 100);
        return (
          <div key={r.accountId} className="bg-terminal-surface border border-terminal-border rounded-lg p-5 space-y-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold text-terminal-text">{r.accountName}</h3>
                  {e.payoutNumber && (
                    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-terminal-panel text-terminal-muted">
                      Payout {e.payoutNumber} of {e.payoutNumber + (6 - e.payoutNumber)}
                    </span>
                  )}
                  {e.isFinalPayout && (
                    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-yellow-500/30 bg-yellow-500/10 text-yellow-500">
                      Final — account closes after this
                    </span>
                  )}
                </div>
                <p className="text-xs text-terminal-muted mt-0.5">
                  {r.presetId} · {r.payoutsTaken} taken · {money(r.totalExtracted)} extracted
                </p>
              </div>

              {e.eligible ? (
                <button
                  onClick={() => request(r)}
                  disabled={busy === r.accountId}
                  className="btn btn-primary text-sm"
                >
                  {busy === r.accountId ? 'Requesting…' : `Request ${money(e.requestableAmount)}`}
                </button>
              ) : (
                <span className="text-xs text-terminal-muted self-center">
                  {e.blockers.length} requirement{e.blockers.length > 1 ? 's' : ''} outstanding
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
              <Field label="Balance" value={money(r.currentBalance)} />
              <Field label="Profit this cycle" value={money(r.profitSinceLastPayout)} />
              <Field label="Payout cap" value={money(e.scheduledAmount)} />
              <Field
                label="Consistency"
                value={
                  e.consistency.ratio === null
                    ? '—'
                    : `${Math.round(e.consistency.ratio * 100)}% / ${100 - 50}%`
                }
                warn={!e.consistency.ok}
              />
            </div>

            {/* qualifying days progress */}
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-terminal-muted">Qualifying days</span>
                <span className="font-mono text-terminal-text">
                  {e.qualifyingDayCount} / {e.qualifyingDayCount + e.daysStillNeeded}
                </span>
              </div>
              <div className="h-2 rounded bg-terminal-panel overflow-hidden">
                <div
                  className={`h-full ${e.daysStillNeeded === 0 ? 'bg-terminal-buy' : 'bg-terminal-muted'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>

            {e.blockers.length > 0 && (
              <ul className="space-y-1.5 border-t border-terminal-border pt-3">
                {e.blockers.map((b) => (
                  <li key={b.reason} className="text-xs flex gap-2">
                    <span className="text-yellow-500 shrink-0 w-24">{BLOCKER_LABEL[b.reason]}</span>
                    <span className="text-terminal-text">{b.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {others.length > 0 && (
        <div className="bg-terminal-surface border border-terminal-border rounded-lg p-5">
          <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider mb-2">
            Not yet paying out
          </h3>
          <ul className="space-y-1">
            {others.map((r) => (
              <li key={r.accountId} className="text-xs">
                <span className="text-terminal-text">{r.accountName}</span>
                <span className="text-terminal-muted"> — {r.unavailableReason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-terminal-muted">
        Requesting here records the request in EdgePilot. Submitting it to the firm is still a
        manual step on their dashboard — mark it approved once they rule on it, which starts the
        next cycle and resets the qualifying-day count.
      </p>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg p-4">
      <div className="text-xs text-terminal-muted">{label}</div>
      <div className={`text-xl font-mono mt-0.5 ${accent ? 'text-terminal-buy' : 'text-terminal-text'}`}>
        {value}
      </div>
    </div>
  );
}

function Field({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="text-terminal-muted text-[10px]">{label}</div>
      <div className={`font-mono ${warn ? 'text-yellow-500' : 'text-terminal-text'}`}>{value}</div>
    </div>
  );
}
