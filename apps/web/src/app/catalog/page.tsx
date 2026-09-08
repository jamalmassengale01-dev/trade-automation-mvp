'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, CatalogEntry, CatalogVersion, GbAccount } from '@/lib/api';
import { useAuth } from '@/components/AuthProvider';
import { Skeleton } from '@/components/Skeleton';
import { toast } from '@/components/ToastProvider';

/**
 * The plan catalog.
 *
 * For a customer this is the whole configuration story: pick your firm and
 * account size, apply it to an account, done. They never type a drawdown or a
 * loss limit — knowing those is the product's job, and a mistyped one sizes
 * every future trade from a number that doesn't exist.
 *
 * For an admin it is also the authoring surface: publish new numbers when a
 * firm changes its terms, and every account on that plan picks them up on its
 * next trade.
 */

const money = (v: string | number | null | undefined) =>
  v === null || v === undefined ? '—' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

function verificationLabel(entry: CatalogEntry): { text: string; stale: boolean } {
  if (!entry.verified_at) return { text: 'Rules never verified', stale: true };
  const days = Math.floor((Date.now() - new Date(entry.verified_at).getTime()) / 86_400_000);
  return {
    text: `Rules verified ${days}d ago`,
    stale: days > (entry.stale_after_days ?? 90),
  };
}

export default function CatalogPage() {
  const { isAdmin } = useAuth();
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [accounts, setAccounts] = useState<GbAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [versions, setVersions] = useState<CatalogVersion[]>([]);

  const load = useCallback(async () => {
    try {
      const [cat, accts] = await Promise.all([api.getCatalog(), api.getGbAccounts()]);
      setEntries(cat.data);
      setAccounts(accts.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load catalog');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function openHistory(id: string) {
    setHistoryFor(id);
    try {
      const res = await api.getCatalogVersions(id);
      setVersions(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load history');
    }
  }

  async function togglePublish(entry: CatalogEntry) {
    try {
      await api.updateCatalogEntry(entry.id, { is_published: !entry.is_published });
      toast.success(`"${entry.display_name}" ${entry.is_published ? 'unpublished' : 'published'}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update');
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold text-terminal-text">Plans</h1>
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
        <h1 className="text-2xl font-bold text-terminal-text">Plans</h1>
        <p className="text-sm text-terminal-muted mt-1">
          {isAdmin
            ? 'The plans customers choose from. Publishing new numbers here updates every account on that plan at its next trade.'
            : 'Pick the plan matching your prop firm account. Everything else — risk sizing, daily loss limits, session rules — is handled for you.'}
        </p>
      </div>

      {isAdmin && entries.some((e) => !e.is_published) && (
        <div className="border border-terminal-border bg-terminal-panel rounded-lg px-4 py-3">
          <p className="text-sm text-terminal-text">
            Draft plans are hidden from customers. A plan can only be published once its rules have
            been verified against the firm&apos;s published terms — check them on the{' '}
            <span className="text-terminal-buy">Presets</span> page, then publish here.
          </p>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="bg-terminal-surface border border-terminal-border rounded-lg p-10 text-center">
          <p className="text-sm text-terminal-muted">
            No plans available yet.{isAdmin && ' Create one from the Calculator.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {entries.map((e) => {
            const v = verificationLabel(e);
            return (
              <div key={e.id} className="bg-terminal-surface border border-terminal-border rounded-lg p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-terminal-text">{e.display_name}</h3>
                      <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-terminal-panel text-terminal-muted">
                        {e.phase}
                      </span>
                      {!e.is_published && (
                        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-yellow-500/30 bg-yellow-500/10 text-yellow-500">
                          Draft
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-terminal-muted mt-0.5 capitalize">
                      {e.prop_firm} · v{e.current_version}
                      {isAdmin && ` · ${e.accounts_using} account(s)`}
                    </p>
                  </div>
                </div>

                {e.description && <p className="text-xs text-terminal-muted">{e.description}</p>}

                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <Field label="Account size" value={money(e.start_balance)} />
                  <Field label="Profit target" value={money(e.target_profit)} />
                  <Field label="Max drawdown" value={money(e.max_drawdown)} />
                  <Field label="Daily loss limit" value={money(e.daily_loss_cap)} />
                  <Field label="Risk per trade" value={money(e.base_risk)} />
                  <Field label="Max contracts" value={String(e.max_contracts)} />
                </div>

                {isAdmin && (
                  <p className={`text-xs ${v.stale ? 'text-yellow-500' : 'text-terminal-muted'}`}>
                    {v.text}
                  </p>
                )}

                <div className="flex gap-2 pt-1 flex-wrap">
                  {e.is_published && (
                    <button
                      onClick={() => setAssigning(e.id)}
                      className="btn btn-primary text-xs flex-1 min-w-[8rem]"
                    >
                      Apply to account
                    </button>
                  )}
                  {isAdmin && (
                    <>
                      <button onClick={() => openHistory(e.id)} className="btn btn-secondary text-xs">
                        History
                      </button>
                      <button onClick={() => togglePublish(e)} className="btn btn-secondary text-xs">
                        {e.is_published ? 'Unpublish' : 'Publish'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {assigning && (
        <AssignModal
          entry={entries.find((e) => e.id === assigning)!}
          accounts={accounts}
          onClose={() => setAssigning(null)}
          onDone={async () => { setAssigning(null); await load(); }}
        />
      )}

      {historyFor && (
        <HistoryModal
          entryName={entries.find((e) => e.id === historyFor)?.display_name ?? historyFor}
          versions={versions}
          onClose={() => { setHistoryFor(null); setVersions([]); }}
        />
      )}
    </div>
  );
}

function AssignModal({
  entry, accounts, onClose, onDone,
}: {
  entry: CatalogEntry;
  accounts: GbAccount[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);

  async function assign() {
    if (!accountId) { toast.error('Choose an account'); return; }
    setBusy(true);
    try {
      const res = await api.assignCatalogEntry(accountId, entry.id);
      toast.success(`Applied "${res.data.entryName}" — ladder and daily counters reset`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply plan');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-terminal-surface border border-terminal-border rounded-xl w-full max-w-md p-6 space-y-4">
        <div>
          <h2 className="text-lg font-bold text-terminal-text">Apply {entry.display_name}</h2>
          <p className="text-xs text-terminal-muted mt-1">
            Choose which broker account runs this plan.
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-terminal-muted">Account</label>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-terminal-panel border border-terminal-border rounded text-terminal-text focus:outline-none focus:border-terminal-buy"
          >
            <option value="">Select an account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        <p className="text-[11px] text-terminal-muted">
          Applying a plan resets that account&apos;s ladder step and daily counters — a step earned
          under different risk numbers shouldn&apos;t size the next trade. No other account is
          affected. Accounts with an open trade must close it first.
        </p>

        <div className="flex gap-2">
          <button onClick={onClose} className="btn btn-secondary text-sm flex-1">Cancel</button>
          <button onClick={assign} disabled={busy} className="btn btn-primary text-sm flex-1">
            {busy ? 'Applying…' : 'Apply plan'}
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryModal({
  entryName, versions, onClose,
}: {
  entryName: string;
  versions: CatalogVersion[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-terminal-surface border border-terminal-border rounded-xl w-full max-w-2xl p-6 space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-terminal-text">{entryName}</h2>
            <p className="text-xs text-terminal-muted mt-1">
              Every published change, newest first. Append-only.
            </p>
          </div>
          <button onClick={onClose} className="text-terminal-muted hover:text-terminal-text text-sm">✕</button>
        </div>

        {versions.length === 0 ? (
          <p className="text-sm text-terminal-muted">No versions recorded.</p>
        ) : (
          <div className="space-y-3">
            {versions.map((v) => (
              <div key={v.id} className="border border-terminal-border rounded-lg p-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-terminal-text">v{v.version}</span>
                  <span className="text-xs text-terminal-muted">
                    {new Date(v.published_at).toLocaleDateString()}
                    {v.published_by_name && ` · ${v.published_by_name}`}
                    {v.effective_from && ` · effective ${v.effective_from}`}
                  </span>
                </div>
                {v.changelog && <p className="text-xs text-terminal-text mt-2">{v.changelog}</p>}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 mt-3 text-xs font-mono">
                  <Field label="Target" value={money(v.preset_values.target_profit as number)} />
                  <Field label="Max DD" value={money(v.preset_values.max_drawdown as number)} />
                  <Field label="Daily cap" value={money(v.preset_values.daily_loss_cap as number)} />
                  <Field label="Base risk" value={money(v.preset_values.base_risk as number)} />
                </div>
                {v.findings?.length > 0 && (
                  <ul className="mt-3 space-y-1 border-t border-terminal-border pt-2">
                    {v.findings.map((f, i) => (
                      <li key={i} className="text-[11px] text-terminal-muted">• {f.message}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-terminal-muted">{label}: </span>
      <span className="text-terminal-text font-mono">{value}</span>
    </div>
  );
}
