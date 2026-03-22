'use client';

import { useState } from 'react';
import { toast } from '@/components/ToastProvider';
import { useTheme } from '@/components/ThemeProvider';

export default function SettingsPage() {
  const { theme, toggleTheme } = useTheme();
  const [webhookSecret, setWebhookSecret] = useState('');

  function copyWebhookUrl() {
    const url = `${window.location.origin}/webhook/tradingview`;
    navigator.clipboard.writeText(url);
    toast.success('Webhook URL copied to clipboard');
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
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Webhook URL
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value="http://your-server:3001/webhook/tradingview"
              className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white"
            />
            <button
              onClick={copyWebhookUrl}
              className="btn-secondary"
            >
              Copy
            </button>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
            Use this URL in your TradingView alert configuration
          </p>
        </div>
      </div>

      <div className="card space-y-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">System Information</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-gray-500 dark:text-gray-400">Version</p>
            <p className="font-medium text-gray-900 dark:text-white">1.0.0-hardened</p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">Environment</p>
            <p className="font-medium text-gray-900 dark:text-white">Development</p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">Hardened</p>
            <p className="font-medium text-green-600 dark:text-green-400">✓ Enabled</p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">Last Updated</p>
            <p className="font-medium text-gray-900 dark:text-white">{new Date().toLocaleDateString()}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
