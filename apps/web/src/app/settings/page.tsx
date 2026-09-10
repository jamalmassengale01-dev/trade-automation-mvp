'use client';

import { useEffect, useState } from 'react';
import { toast } from '@/components/ToastProvider';
import { useTheme } from '@/components/ThemeProvider';
import { api, Strategy } from '@/lib/api';

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
