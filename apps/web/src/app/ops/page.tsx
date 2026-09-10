'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, OperationsView, OpsAccount } from '@/lib/api';
import { Skeleton } from '@/components/Skeleton';

/**
 * The operational view — the screen to leave open during a session window.
 *
 * It answers one question: if a signal arrived right now, what would happen,
 * and if the answer is "nothing", why?
 *
 * Everything here existed already, spread across five pages: fleet state on
 * /fleet, payout blockers on /launchpad, halt verdicts on /health, refusals in
 * /risk-events, readiness only in a CLI. Nobody clicks through five pages
 * inside a thirty-minute window, so in practice none of it was available at the
 * moment it mattered.
 *
 * The design rule throughout: a number nobody can act on is decoration.
 * Everything below is either a limit that decides whether a trade fires, or
 * the reason one did not.
 */

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const SESSION_LABEL: Record<string, string> = { london: 'London', nyam: 'NY AM', nypm: 'NY PM' };

export default function OpsPage() {
  const [view, setView] = useState<OperationsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.getOperations();
      setView(r.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) {
    return <div className="card border-red-500/40"><p className="text-sm text-red-400">{error}</p></div>;
  }
  if (!view) return <Skeleton />;

  const clear = view.accounts.filter((a) => a.blockers.length === 0);

  return (
    <div className="space-y-5">
      <SessionBar view={view} />

      {!view.readiness.ready && <ReadinessBanner view={view} />}

      {/* The headline: how many accounts would actually take a signal. */}
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-terminal-text">Accounts</h2>
        <span className="text-xs text-terminal-muted">
          {clear.length === view.accounts.length
            ? 'all would trade a signal right now'
            : clear.length === 0
            ? 'none would trade a signal right now'
            : `${clear.map((a) => a.name).join(', ')} would trade right now`}
        </span>
      </div>

      {view.accounts.length === 0 && (
        <div className="card">
          <p className="text-sm text-terminal-muted">
            No active accounts with a preset. An account without one is skipped entirely by the
            executor — no ladder, no gate.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {view.accounts.map((a) => <AccountRow key={a.id} a={a} />)}
      </div>

      {view.refusals.length > 0 && <Refusals view={view} />}

      <p className="text-[11px] text-terminal-muted">
        Refreshes every 15s · generated {new Date(view.generatedAt).toLocaleTimeString()} ·
        broker connectivity is not checked here, run <code>npm run fleet:check</code> for that
      </p>
    </div>
  );
}

/** Where we are in the trading day. The clock everything else hangs off. */
function SessionBar({ view }: { view: OperationsView }) {
  const { current, next } = view.session;
  const open = current !== null;

  return (
    <div
      className={`rounded-lg border px-5 py-4 flex items-center justify-between ${
        open ? 'border-terminal-buy/50 bg-terminal-buy/10' : 'border-terminal-border'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${open ? 'bg-terminal-buy animate-pulse' : 'bg-terminal-muted'}`} />
        <div>
          <p className="font-semibold text-terminal-text">
            {open ? `${SESSION_LABEL[current]} window OPEN` : 'No session window open'}
          </p>
          <p className="text-xs text-terminal-muted">
            {open
              ? 'Signals inside this window are eligible. One trade per session.'
              : next
              ? `${next.label} opens in ${Math.floor(next.minutesAway / 60)}h ${next.minutesAway % 60}m`
              : 'No further windows today. Next is London at 3:00 AM ET.'}
          </p>
        </div>
      </div>
      {view.blockedCount > 0 && (
        <div className="text-right">
          <p className="text-xl font-bold text-amber-400">{view.blockedCount}</p>
          <p className="text-[11px] uppercase tracking-wider text-terminal-muted">
            account{view.blockedCount === 1 ? '' : 's'} blocked
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Readiness failures, shown only when there are any.
 *
 * A green "all systems go" banner earns nothing and trains the eye to skip the
 * region. Silence is the healthy state.
 */
function ReadinessBanner({ view }: { view: OperationsView }) {
  return (
    <div className="rounded-lg border border-red-500/50 bg-red-500/10 px-5 py-4 space-y-2">
      <p className="font-semibold text-red-400">
        Not ready — {view.readiness.failing.length} blocking issue
        {view.readiness.failing.length === 1 ? '' : 's'}
      </p>
      {view.readiness.failing.map((c) => (
        <div key={c.area} className="text-sm">
          <span className="text-terminal-text font-medium">{c.label ?? c.area}</span>
          <span className="text-terminal-muted"> — {c.detail}</span>
          {c.remedy && <p className="text-xs text-terminal-muted mt-0.5">→ {c.remedy}</p>}
        </div>
      ))}
    </div>
  );
}

/** One account: the four limits that decide a trade, and what is blocking it. */
function AccountRow({ a }: { a: OpsAccount }) {
  const blocked = a.blockers.length > 0;

  return (
    <div className={`card space-y-3 ${blocked ? 'border-amber-500/40' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-semibold text-terminal-text">{a.name}</p>
          <p className="text-xs text-terminal-muted">
            {a.presetName ?? 'no preset'}
            {a.propFirm && ` · ${a.propFirm}`}
            {a.phase && ` · ${a.phase}`}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-terminal-muted">Step {a.ladderStep}</p>
          <p className="text-sm font-medium text-terminal-text">
            next risk {money(a.nextStepRisk)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Limit
          label="Daily room"
          value={money(a.dllRoom)}
          sub={`day ${money(a.dayPnl)} of ${money(-a.dailyLossCap)}`}
          danger={a.nextStepRisk !== null && a.dllRoom < a.nextStepRisk}
        />
        <Limit
          label="Drawdown room"
          value={money(a.drawdownRoom)}
          sub={
            a.drawdownFloor === null
              ? 'no floor set'
              : a.drawdownUnderstated
              ? `floor ${money(a.drawdownFloor)} · may be low`
              : `floor ${money(a.drawdownFloor)}`
          }
          danger={a.nextStepRisk !== null && a.drawdownRoom !== null && a.drawdownRoom < a.nextStepRisk}
          warn={a.drawdownUnderstated}
        />
        <Limit
          label="Trades today"
          value={`${a.tradesToday} / ${a.maxTradesPerDay}`}
          sub={a.dayLockedOut ? 'locked out' : 'per broker day'}
          danger={a.tradesToday >= a.maxTradesPerDay || a.dayLockedOut}
        />
        <div>
          <p className="text-[11px] uppercase tracking-wider text-terminal-muted mb-1">Sessions</p>
          <div className="flex gap-1.5">
            {(['london', 'nyam', 'nypm'] as const).map((s) => (
              <span
                key={s}
                title={`${SESSION_LABEL[s]} ${a.sessionsUsed[s] ? 'used' : 'available'}`}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  a.sessionsUsed[s]
                    ? 'bg-terminal-border text-terminal-muted line-through'
                    : 'bg-terminal-buy/20 text-terminal-buy'
                }`}
              >
                {s === 'london' ? 'LON' : s === 'nyam' ? 'AM' : 'PM'}
              </span>
            ))}
          </div>
        </div>
      </div>

      {a.openTrade && (
        <div className="text-xs text-terminal-text border-t border-terminal-border pt-2">
          Open: {a.openTrade.direction} {a.openTrade.contracts} {a.openTrade.symbol}
          <span className="text-terminal-muted"> · {a.openTrade.state}</span>
        </div>
      )}

      {blocked && (
        <div className="border-t border-terminal-border pt-2 space-y-1">
          {a.blockers.map((b, i) => (
            <p key={i} className="text-xs">
              <span className="text-amber-400 font-medium uppercase tracking-wider">{b.kind}</span>
              <span className="text-terminal-muted"> — {b.message}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function Limit({ label, value, sub, danger, warn }: {
  label: string; value: string; sub: string; danger?: boolean; warn?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-terminal-muted mb-1">{label}</p>
      <p className={`text-sm font-semibold ${danger ? 'text-red-400' : warn ? 'text-amber-400' : 'text-terminal-text'}`}>
        {value}
      </p>
      <p className="text-[11px] text-terminal-muted">{sub}</p>
    </div>
  );
}

/**
 * Recent refusals.
 *
 * "Nothing happened" is the failure mode that actually occurs, and it looks
 * identical to a quiet market until you can see the refusal that caused it.
 */
function Refusals({ view }: { view: OperationsView }) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-terminal-text">
        Recent refusals
        <span className="ml-2 font-normal normal-case tracking-normal text-xs text-terminal-muted">
          last 24h — why a signal did not become a trade
        </span>
      </h2>
      <div className="card divide-y divide-terminal-border p-0">
        {view.refusals.map((r, i) => (
          <div key={i} className="px-4 py-2 flex gap-3 text-xs">
            <span className="text-terminal-muted shrink-0 w-16">
              {new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className="text-terminal-text shrink-0 w-28 truncate">{r.accountName ?? '—'}</span>
            <span className="text-amber-400 shrink-0 w-40 truncate font-mono">
              {r.ruleType.replace(/^gb_/, '')}
            </span>
            <span className="text-terminal-muted truncate">{r.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
