'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
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

  const [form, setForm] = useState({
    name: '',
    username: '',
    password: '',
    appId: 'Sample App',
    appVersion: '1.0',
    cid: '',
    sec: '',
    deviceId: crypto.randomUUID(),
    environment: 'demo' as 'demo' | 'live',
  });

  useEffect(() => { loadAccounts(); }, []);

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
    setForm({ name: '', username: '', password: '', appId: 'Sample App', appVersion: '1.0', cid: '', sec: '', deviceId: crypto.randomUUID(), environment: 'demo' });
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
      const required = ['username', 'password', 'cid', 'sec'] as const;
      for (const f of required) {
        if (!form[f].trim()) { toast.error(`${f} is required`); return; }
      }
      credentials.username = form.username.trim();
      credentials.password = form.password.trim();
      credentials.appId = form.appId.trim();
      credentials.appVersion = form.appVersion.trim();
      credentials.cid = form.cid.trim();
      credentials.sec = form.sec.trim();
      credentials.deviceId = form.deviceId.trim() || crypto.randomUUID();
      credentials.environment = form.environment;
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

                  <Field label="Tradovate Username (email)" required>
                    <input className="input w-full" placeholder="you@example.com" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
                  </Field>

                  <Field label="API Password" hint="Set a dedicated API password in Tradovate → App Settings → API Access" required>
                    <input className="input w-full" type="password" placeholder="Your API-dedicated password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
                  </Field>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Client ID (cid)" required>
                      <input className="input w-full" placeholder="12345" value={form.cid} onChange={(e) => setForm((f) => ({ ...f, cid: e.target.value }))} />
                    </Field>
                    <Field label="Client Secret (sec)" required>
                      <input className="input w-full" type="password" placeholder="••••••••" value={form.sec} onChange={(e) => setForm((f) => ({ ...f, sec: e.target.value }))} />
                    </Field>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="App ID">
                      <input className="input w-full" value={form.appId} onChange={(e) => setForm((f) => ({ ...f, appId: e.target.value }))} />
                    </Field>
                    <Field label="App Version">
                      <input className="input w-full" value={form.appVersion} onChange={(e) => setForm((f) => ({ ...f, appVersion: e.target.value }))} />
                    </Field>
                  </div>

                  <Field label="Device ID" hint="Auto-generated — leave as-is unless you have an existing device ID">
                    <input className="input w-full font-mono text-xs" value={form.deviceId} onChange={(e) => setForm((f) => ({ ...f, deviceId: e.target.value }))} />
                  </Field>
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
