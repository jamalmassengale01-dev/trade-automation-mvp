'use client';

import { useEffect, useState } from 'react';
import { api, ApiKeySummary } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import { SkeletonTable, Skeleton } from '@/components/Skeleton';
import { toast } from '@/components/ToastProvider';

interface Account {
  id: string;
  name: string;
  broker_type: string;
  is_active: boolean;
  is_disabled: boolean;
  settings: {
    multiplier: number;
    fixedSize?: number;
    maxContracts: number;
    longOnly: boolean;
    shortOnly: boolean;
  };
  created_at: string;
}

type Step = 'idle' | 'select-broker' | 'disclaimer' | 'credentials';

const BROKER_LABELS: Record<string, string> = {
  tradovate: 'Tradovate',
  mock: 'Mock (dev)',
  simulated: 'Simulated (paper)',
};

const REAL_BROKERS = ['tradovate', 'tradier'];

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [selectedBroker, setSelectedBroker] = useState('tradovate');
  const [saving, setSaving] = useState(false);

  // appId, appVersion and deviceId are gone from here entirely: they are not
  // credentials, nobody has a correct value to type, and the server fills them.
  const [form, setForm] = useState({
    name: '',
    username: '',
    password: '',
    cid: '',
    sec: '',
    environment: 'demo' as 'demo' | 'live',
  });

  const [apiKey, setApiKey] = useState<ApiKeySummary | null | undefined>(undefined);

  useEffect(() => { loadAccounts(); loadApiKey(); }, []);

  async function loadApiKey() {
    try {
      const r = await api.getBrokerKey('tradovate');
      setApiKey((r.data as ApiKeySummary | null) ?? null);
    } catch {
      // Not fatal — the form still works with a per-account key, and the
      // server gives the real error if neither is present.
      setApiKey(null);
    }
  }

  async function loadAccounts() {
    try {
      setLoading(true);
      const response = await api.getAccounts();
      if (response.success) setAccounts(response.data as Account[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounts');
      toast.error('Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }

  function openAddFlow() {
    setSelectedBroker('tradovate');
    setForm({ name: '', username: '', password: '', cid: '', sec: '', environment: 'demo' });
    setStep('select-broker');
  }

  function onBrokerNext() {
    if (REAL_BROKERS.includes(selectedBroker)) {
      setStep('disclaimer');
    } else {
      setStep('credentials');
    }
  }

  async function handleCreate() {
    if (!form.name.trim()) { toast.error('Account name is required'); return; }

    const credentials: Record<string, string> = {};
    if (selectedBroker === 'tradovate') {
      // Only the firm-issued pair is required here. cid/sec come from the
      // saved API key unless this account overrides them, and the server says
      // so properly — naming where to get the missing half — if neither is set.
      if (!form.username.trim()) { toast.error('Username is required'); return; }
      if (!form.password.trim()) { toast.error('Password is required'); return; }
      credentials.username = form.username.trim();
      credentials.password = form.password.trim();
      credentials.environment = form.environment;
      if (form.cid.trim()) credentials.cid = form.cid.trim();
      if (form.sec.trim()) credentials.sec = form.sec.trim();
    }

    setSaving(true);
    try {
      await api.createAccount({ name: form.name.trim(), broker_type: selectedBroker, credentials });
      toast.success(`${form.name} connected`);
      setStep('idle');
      await loadAccounts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setSaving(false);
    }
  }

  async function handleFlatten(id: string, name: string) {
    if (!confirm(`Flatten ALL positions in "${name}"? This cannot be undone.`)) return;
    try {
      await api.flattenAccount(id);
      toast.success(`${name} flattened`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to flatten');
    }
  }

  async function handleToggleDisable(account: Account) {
    const action = account.is_disabled ? 'enable' : 'disable';
    if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} "${account.name}"?`)) return;
    try {
      if (account.is_disabled) await api.enableAccount(account.id);
      else await api.disableAccount(account.id);
      toast.success(`${account.name} ${action}d`);
      await loadAccounts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${action}`);
    }
  }

  async function handleDelete(account: Account) {
    if (!confirm(`Delete "${account.name}"? This will remove all copier mappings for this account.`)) return;
    try {
      await api.deleteAccount(account.id);
      toast.success(`${account.name} deleted`);
      await loadAccounts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-terminal-text">Broker Accounts</h1>
          <Skeleton className="h-10 w-36" />
        </div>
        <SkeletonTable rows={3} columns={5} />
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

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-terminal-text">Broker Accounts</h1>
        <button onClick={openAddFlow} className="btn btn-primary text-sm">+ Connect Account</button>
      </div>

      {accounts.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-4xl mb-3">🔌</p>
          <p className="text-terminal-muted mb-4">No broker accounts connected yet.</p>
          <button onClick={openAddFlow} className="btn btn-primary text-sm">Connect Your First Account</button>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-terminal-border">
                {['Account', 'Broker', 'Status', 'Sizing', 'Restrictions', 'Actions'].map((h) => (
                  <th key={h} className="text-left py-3 px-4 text-terminal-muted font-medium uppercase tracking-wider text-xs">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id} className="border-b border-terminal-border/50 hover:bg-terminal-panel/50">
                  <td className="py-3 px-4 font-medium text-terminal-text">{account.name}</td>
                  <td className="py-3 px-4">
                    <span className="text-terminal-muted capitalize">
                      {BROKER_LABELS[account.broker_type] ?? account.broker_type}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex flex-col gap-1">
                      <StatusBadge status={account.is_active ? 'active' : 'inactive'} />
                      {account.is_disabled && <StatusBadge status="disabled" />}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-terminal-text">
                    {account.settings.fixedSize
                      ? <span>Fixed: <b>{account.settings.fixedSize}</b></span>
                      : <span>×<b>{account.settings.multiplier}</b></span>}
                    <span className="text-terminal-muted ml-2">(max {account.settings.maxContracts})</span>
                  </td>
                  <td className="py-3 px-4">
                    {account.settings.longOnly && <span className="inline-block px-2 py-0.5 rounded text-xs bg-blue-500/20 text-blue-400 mr-1">Long Only</span>}
                    {account.settings.shortOnly && <span className="inline-block px-2 py-0.5 rounded text-xs bg-blue-500/20 text-blue-400">Short Only</span>}
                    {!account.settings.longOnly && !account.settings.shortOnly && <span className="text-terminal-muted">—</span>}
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={() => handleFlatten(account.id, account.name)}
                        className="px-2.5 py-1 rounded text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors"
                      >
                        Flatten
                      </button>
                      <button
                        onClick={() => handleToggleDisable(account)}
                        className={`px-2.5 py-1 rounded text-xs transition-colors ${
                          account.is_disabled
                            ? 'bg-terminal-buy/20 text-terminal-buy hover:bg-terminal-buy/30'
                            : 'bg-terminal-sell/20 text-terminal-sell hover:bg-terminal-sell/30'
                        }`}
                      >
                        {account.is_disabled ? 'Enable' : 'Disable'}
                      </button>
                      <button
                        onClick={() => handleDelete(account)}
                        className="px-2.5 py-1 rounded text-xs bg-terminal-panel text-terminal-muted hover:text-terminal-sell hover:bg-terminal-sell/10 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ============================================================
          MODAL OVERLAY
          ============================================================ */}
      {step !== 'idle' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">

          {/* Step 1 — Select broker */}
          {step === 'select-broker' && (
            <div className="bg-terminal-surface border border-terminal-border rounded-xl w-full max-w-sm p-6 space-y-5">
              <h2 className="text-lg font-bold text-terminal-text">Select Broker</h2>
              <div className="space-y-2">
                {Object.entries(BROKER_LABELS).map(([value, label]) => (
                  <label key={value} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedBroker === value ? 'border-terminal-buy bg-terminal-buy/10' : 'border-terminal-border hover:border-terminal-muted'
                  }`}>
                    <input type="radio" name="broker" value={value} checked={selectedBroker === value} onChange={() => setSelectedBroker(value)} className="accent-terminal-buy" />
                    <span className="text-terminal-text font-medium">{label}</span>
                    {value === 'tradovate' && <span className="ml-auto text-xs text-terminal-muted">Live / Demo</span>}
                  </label>
                ))}
              </div>
              <div className="flex gap-3">
                <button onClick={() => setStep('idle')} className="btn btn-secondary flex-1">Cancel</button>
                <button onClick={onBrokerNext} className="btn btn-primary flex-1">Continue</button>
              </div>
            </div>
          )}

          {/* Step 2 — Disclaimer (real brokers only) */}
          {step === 'disclaimer' && (
            <div className="bg-terminal-surface border border-terminal-border rounded-xl w-full max-w-lg p-6 space-y-5">
              <h2 className="text-xl font-bold text-terminal-text text-center">Risk Acknowledgment</h2>
              <div className="text-sm text-terminal-muted space-y-3 max-h-72 overflow-y-auto pr-1">
                <p>
                  This platform provides fully automated trade execution through webhooks linked directly to your broker account.
                  Automation carries inherent risks. You are solely responsible for monitoring your trades and ensuring your signals execute as intended.
                </p>
                <p className="font-semibold text-terminal-text">
                  BY CONNECTING YOUR BROKER ACCOUNT, YOU ACKNOWLEDGE THE RISKS ASSOCIATED WITH AUTOMATED TRADING AND ACCEPT FULL RESPONSIBILITY.
                </p>
                <p>
                  This software is not a financial advisor. Past performance does not guarantee future results. You are responsible for ensuring
                  that automated trading complies with your broker's terms of service and, if applicable, your prop firm's evaluation rules.
                </p>
                <p>
                  Prop firm accounts often prohibit fully automated ("bot") trading. Always verify your firm's Terms of Service before connecting a funded evaluation account.
                </p>
                <p>
                  The developers of this software accept no liability for trading losses, missed executions, or account violations resulting from use of this platform.
                </p>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setStep('select-broker')} className="btn btn-secondary flex-1">Back</button>
                <button
                  onClick={() => setStep('credentials')}
                  className="flex-1 px-5 py-2.5 rounded-lg font-bold text-sm bg-terminal-buy text-terminal-bg hover:opacity-90 transition-opacity"
                >
                  I Agree — Continue
                </button>
              </div>
            </div>
          )}

          {/* Step 3 — Credentials form */}
          {step === 'credentials' && (
            <div className="bg-terminal-surface border border-terminal-border rounded-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-terminal-text">
                  Connect {BROKER_LABELS[selectedBroker]}
                </h2>
                <button onClick={() => setStep('idle')} className="text-terminal-muted hover:text-terminal-text">✕</button>
              </div>

              <Field label="Account Label" required>
                <input
                  className="input w-full"
                  placeholder="e.g. Apex Eval #1"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </Field>

              {selectedBroker === 'tradovate' && (
                <>
                  {/* Environment toggle */}
                  <div className="flex gap-2">
                    {(['demo', 'live'] as const).map((env) => (
                      <button
                        key={env}
                        onClick={() => setForm((f) => ({ ...f, environment: env }))}
                        className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                          form.environment === env
                            ? env === 'live'
                              ? 'bg-terminal-buy/20 border-terminal-buy text-terminal-buy'
                              : 'bg-blue-500/20 border-blue-500 text-blue-400'
                            : 'border-terminal-border text-terminal-muted hover:border-terminal-muted'
                        }`}
                      >
                        {env === 'live' ? '🔴 Live Trading' : '🔵 Demo / Paper'}
                      </button>
                    ))}
                  </div>

                  {form.environment === 'live' && (
                    <div className="flex items-start gap-2 bg-terminal-killswitch/10 border border-terminal-killswitch/40 rounded-lg p-3 text-xs text-terminal-sell">
                      <span className="text-base">⚠️</span>
                      <span>Live mode will place real orders with real money. Double-check all settings before enabling strategies.</span>
                    </div>
                  )}

                  {/*
                    Only the two fields a prop firm actually sends you.

                    Tradovate authentication needs seven values, but five of
                    them are not per-account: cid/sec come from your own API
                    key and are the same everywhere, and appId/appVersion/
                    deviceId are not credentials at all. Asking for all seven
                    implied the firm supplies all seven, so every connection
                    stalled looking for values that were never in the email.
                  */}
                  <p className="text-xs text-terminal-muted">
                    Enter the login your prop firm sent you when they issued the account.
                  </p>

                  <Field label="Username" hint="From your prop firm — often an email or an account number" required>
                    <input className="input w-full" placeholder="you@example.com or APEX123456" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
                  </Field>

                  <Field label="Password" hint="The password for that login. If you set a separate API password in Tradovate, use that one." required>
                    <input className="input w-full" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
                  </Field>

                  <ApiKeyStatus status={apiKey} />

                  <details className="text-xs">
                    <summary className="cursor-pointer text-terminal-muted hover:text-terminal-text">
                      Use a different API key for this account
                    </summary>
                    <div className="mt-3 space-y-3">
                      <p className="text-terminal-muted">
                        Leave these blank to use your saved key. Fill them in only if this
                        account authenticates with its own Tradovate API key.
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Client ID (cid)">
                          <input className="input w-full" placeholder="12345" value={form.cid} onChange={(e) => setForm((f) => ({ ...f, cid: e.target.value }))} />
                        </Field>
                        <Field label="Client Secret (sec)">
                          <input className="input w-full" type="password" placeholder="••••••••" value={form.sec} onChange={(e) => setForm((f) => ({ ...f, sec: e.target.value }))} />
                        </Field>
                      </div>
                    </div>
                  </details>
                </>
              )}

              <div className="flex gap-3 pt-2">
                <button onClick={() => setStep(REAL_BROKERS.includes(selectedBroker) ? 'disclaimer' : 'select-broker')} className="btn btn-secondary flex-1">
                  Back
                </button>
                <button onClick={handleCreate} disabled={saving} className="btn btn-primary flex-1">
                  {saving ? 'Connecting…' : 'Connect Account'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Whether the shared Tradovate API key is in place.
 *
 * Shown inside the connect form because that is where its absence stops you.
 * A key is not something a prop firm sends — it is a paid add-on on your own
 * Tradovate account — so finding out at the moment of connecting, with no
 * explanation, is a dead end.
 */
function ApiKeyStatus({ status }: { status: ApiKeySummary | null | undefined }) {
  if (status === undefined) return null; // still loading; say nothing rather than guess

  if (status) {
    return (
      <p className="text-xs text-terminal-muted">
        Using your saved Tradovate API key (client ID {status.cid}). Change it in Settings.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
      <p className="text-xs font-medium text-amber-400">No Tradovate API key saved</p>
      <p className="text-xs text-terminal-muted">
        Tradovate will not accept a login without one. It is separate from the account your
        prop firm issued: you create it on your own Tradovate account under Application
        Settings → API Access, and the same key works for every account you connect.
        Add it once in <a href="/settings" className="text-terminal-buy hover:underline">Settings</a>.
      </p>
      <p className="text-xs text-terminal-muted">
        API Access is a paid add-on and requires a funded balance, so this is usually the
        step that takes the longest.
      </p>
    </div>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-terminal-muted uppercase tracking-wider">
        {label}{required && <span className="text-terminal-sell ml-1">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-terminal-muted">{hint}</p>}
    </div>
  );
}
