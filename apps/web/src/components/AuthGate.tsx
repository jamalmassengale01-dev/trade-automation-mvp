'use client';

import { useState } from 'react';
import { useAuth } from './AuthProvider';
import { Navigation } from './Navigation';

/**
 * Shows the sign-in form when there is no session, and the dashboard when
 * there is. Purely presentational gating — the API enforces every route
 * independently, so a tampered client gains nothing but a broken-looking page.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-terminal-bg">
        <div className="text-sm text-terminal-muted">Loading…</div>
      </div>
    );
  }

  if (!user) return <LoginForm />;

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden">
      <Navigation />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}

function LoginForm() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-terminal-bg p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-terminal-text">EdgePilot</h1>
          <p className="text-sm text-terminal-muted mt-1">Sign in to your dashboard</p>
        </div>

        <form
          onSubmit={submit}
          className="bg-terminal-surface border border-terminal-border rounded-lg p-6 space-y-4"
        >
          <div className="space-y-1">
            <label htmlFor="email" className="text-xs font-medium text-terminal-muted">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-terminal-panel border border-terminal-border rounded text-terminal-text focus:outline-none focus:border-terminal-buy"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="password" className="text-xs font-medium text-terminal-muted">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-terminal-panel border border-terminal-border rounded text-terminal-text focus:outline-none focus:border-terminal-buy"
            />
          </div>

          {error && (
            <div className="text-xs text-terminal-sell bg-terminal-sell/10 border border-terminal-sell/30 rounded px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 rounded-lg text-sm font-semibold bg-terminal-buy text-black hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-[11px] text-terminal-muted text-center mt-4">
          No account yet? Run{' '}
          <code className="text-terminal-text">npm run create-admin</code> in the API workspace.
        </p>
      </div>
    </div>
  );
}
