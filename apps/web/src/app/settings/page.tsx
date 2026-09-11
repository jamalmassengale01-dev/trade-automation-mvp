'use client';

import { useEffect, useState } from 'react';
import { toast } from '@/components/ToastProvider';
import { useTheme } from '@/components/ThemeProvider';
import { api, Strategy, ApiKeySummary } from '@/lib/api';

export default function SettingsPage() {
  const { theme, toggleTheme } = useTheme();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api
      .getStrategies()
      .then((r) => setStrategies(r.data ?? []))
      .catch(() => toast.error('Could not load strategies'))
      .finally(() => setLoading(false));
  }, []);

  // Copies the real per-strategy URL, secret included — the string TradingView
  // needs. The page previously displayed one URL and copied a different one,
  // and neither carried the strategy id or the secret, so an alert configured
  // from it was rejected silently.
  function copyWebhookUrl(url: string) {
    navigator.clipboard.writeText(url);
    toast.success('Webhook URL copied — paste it into the TradingView alert');
  }

  /** The secret authenticates TradingView; treat it like a password on screen. */
  function mask(url: string): string {
    return url.replace(/secret=[^&]+/, 'secret=••••••••');
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>

      <div className="card space-y-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Appearance</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium text-gray-900 dark:text-white">Theme</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Current: {theme === 'light' ? 'Light' : 'Dark'} mode
            </p>
          </div>
          <button
            onClick={toggleTheme}
            className="btn-secondary"
          >
            {theme === 'light' ? '🌙 Switch to Dark' : '☀️ Switch to Light'}
          </button>
        </div>
      </div>

      <TradovateApiKeyCard />

      <div className="card space-y-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">TradingView Webhook</h2>

        {loading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>}

        {!loading && strategies.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No strategies yet. Create one on the Strategies page — each gets its own webhook URL.
          </p>
        )}

        {strategies.map((s) => (
          <div key={s.id}>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {s.name}
              {!s.is_active && (
                <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">inactive — alerts will be rejected</span>
              )}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={revealed[s.id] ? s.webhookUrl : mask(s.webhookUrl)}
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white font-mono text-xs"
              />
              <button
                onClick={() => setRevealed((r) => ({ ...r, [s.id]: !r[s.id] }))}
                className="btn-secondary"
              >
                {revealed[s.id] ? 'Hide' : 'Reveal'}
              </button>
              <button onClick={() => copyWebhookUrl(s.webhookUrl)} className="btn-secondary">
                Copy
              </button>
            </div>
          </div>
        ))}

        <div className="text-sm text-gray-500 dark:text-gray-400 space-y-1 border-t border-gray-200 dark:border-gray-700 pt-4">
          <p>
            Paste into the TradingView alert&apos;s webhook URL field. The <code>secret</code> query
            parameter authenticates the alert — TradingView cannot send custom headers, so it has to
            travel in the URL. Treat it like a password.
          </p>
          <p>
            Set the alert frequency to <strong>Once Per Bar Close</strong>. Any other setting fires
            intrabar, and the strategy is defined on bar close only.
          </p>
        </div>
      </div>

    </div>
  );
}

/**
 * The Tradovate API key — entered once, used by every account.
 *
 * Separate from the per-account login on purpose. A prop firm issues a username
 * and password per account; the API key is yours, identical everywhere, and the
 * connect-account form used to demand it every single time alongside fields
 * nobody is given (appId, deviceId), which made connecting look like it needed
 * information the firm had failed to send.
 */
function TradovateApiKeyCard() {
  const [summary, setSummary] = useState<ApiKeySummary | null | undefined>(undefined);
  const [cid, setCid] = useState('');
  const [sec, setSec] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getBrokerKey('tradovate')
      .then((r) => setSummary(r.data ?? null))
      .catch(() => setSummary(null));
  }, []);

  async function save() {
    if (!cid.trim() || !sec.trim()) {
      toast.error('Both the client ID and the secret are required');
      return;
    }
    setSaving(true);
    try {
      const r = await api.saveBrokerKey('tradovate', { cid: cid.trim(), sec: sec.trim() });
      setSummary(r.data);
      setCid('');
      setSec('');
      toast.success('API key saved — new accounts will use it automatically');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the API key');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      await api.deleteBrokerKey('tradovate');
      setSummary(null);
      toast.success('API key removed. Accounts already connected are unaffected.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the API key');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card space-y-4">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Tradovate API Key</h2>

      <p className="text-sm text-terminal-muted">
        Tradovate will not authenticate any login without an API key. It is{' '}
        <strong className="text-terminal-text">not</strong> something your prop firm sends
        you — you create it on your own Tradovate account under Application Settings → API
        Access, and the same key then works for every account you connect here.
      </p>

      {summary === undefined ? (
        <p className="text-sm text-terminal-muted">Loading…</p>
      ) : summary ? (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-terminal-border bg-terminal-panel px-4 py-3">
          <div className="text-sm">
            <p className="text-terminal-text font-medium">Key saved</p>
            <p className="text-terminal-muted text-xs">
              Client ID {summary.cid} · secret stored · updated{' '}
              {new Date(summary.updatedAt).toLocaleDateString()}
            </p>
          </div>
          <button onClick={remove} disabled={saving} className="btn-secondary shrink-0">
            Remove
          </button>
        </div>
      ) : (
        <p className="text-sm text-amber-500">
          No key saved. Connecting a Tradovate account will fail until one is.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-terminal-muted">Client ID (cid)</label>
          <input
            className="input w-full"
            placeholder="12345"
            value={cid}
            onChange={(e) => setCid(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-terminal-muted">Client Secret (sec)</label>
          <input
            className="input w-full"
            type="password"
            placeholder="••••••••"
            value={sec}
            onChange={(e) => setSec(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="btn-primary">
          {summary ? 'Replace key' : 'Save key'}
        </button>
        {/* The secret is never sent back to the browser, so there is nothing to
            edit in place — replacing it is the only operation that exists. */}
        <p className="text-xs text-terminal-muted">
          The secret is write-only. It is never displayed again after saving.
        </p>
      </div>

      <p className="text-xs text-terminal-muted border-t border-terminal-border pt-3">
        API Access is a paid Tradovate add-on and requires a funded balance. If you have no
        key yet, that is the prerequisite — not anything missing in EdgePilot.
      </p>
    </div>
  );
}
