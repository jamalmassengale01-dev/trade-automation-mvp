'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from './ThemeProvider';
import { LiveIndicator } from './LiveIndicator';
import { useAuth } from './AuthProvider';

/**
 * Grouped by WHEN you use it, not by what the code calls it.
 *
 * Fourteen flat entries with overlapping names — Plans beside Presets, Fleet
 * beside Accounts, three separate logs — meant reading the whole list every
 * time to find one page. The groups below answer "am I trading, setting up,
 * looking something up, or fixing something", which is the question someone
 * actually has before they click.
 *
 * A few renames for the same reason: "Risk Events" is what the table is called,
 * "Blocked & Warnings" is what it contains. "Alerts" was ambiguous between
 * notifications and inbound TradingView signals, so it says which.
 *
 * adminOnly is also enforced server-side; hiding here just avoids clicking
 * into a guaranteed 403.
 */
const navGroups: Array<{
  title: string;
  items: Array<{ href: string; label: string; icon: string; adminOnly?: boolean; hint?: string }>;
}> = [
  {
    title: 'Trading',
    items: [
      { href: '/ops', label: 'Operations', icon: '🎯', hint: 'Would a signal trade right now?' },
      { href: '/fleet', label: 'Fleet', icon: '🚀', hint: 'Each account in detail' },
      { href: '/launchpad', label: 'Payouts', icon: '💰', hint: 'What is ready to withdraw' },
    ],
  },
  {
    title: 'Setup',
    items: [
      { href: '/accounts', label: 'Broker Accounts', icon: '💳', hint: 'Connect a prop firm account' },
      { href: '/catalog', label: 'Firm Plans', icon: '📚', hint: 'Rules to trade an account under' },
      { href: '/strategies', label: 'Signal Sources', icon: '⚡', hint: 'TradingView webhook URLs' },
    ],
  },
  {
    title: 'History',
    items: [
      { href: '/alerts', label: 'Signals In', icon: '🔔', hint: 'Alerts TradingView sent' },
      { href: '/orders', label: 'Orders', icon: '📋', hint: 'What reached the broker' },
      { href: '/risk-events', label: 'Blocked & Warnings', icon: '⚠️', hint: 'Why a signal did not trade' },
    ],
  },
  {
    title: 'Tools',
    items: [
      { href: '/health', label: 'Account Health', icon: '🩺', adminOnly: true, hint: 'Our numbers vs the broker' },
      { href: '/calculator', label: 'Rule Calculator', icon: '🧮', adminOnly: true, hint: 'Firm rules to risk settings' },
      { href: '/presets', label: 'Rule Editor', icon: '🎛️', adminOnly: true, hint: 'Edit the raw numbers' },
    ],
  },
  {
    title: 'System',
    items: [
      { href: '/system', label: 'Status', icon: '📊', hint: 'Throughput and emergency stop' },
      { href: '/settings', label: 'Settings', icon: '⚙️' },
    ],
  },
];

export function Navigation() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const { user, isAdmin, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const groups = navGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.adminOnly || isAdmin) }))
    .filter((g) => g.items.length > 0);

  const navContent = (
    <>
      <div className="p-6 border-b border-terminal-border">
        <h1 className="text-xl font-bold text-terminal-text">EdgePilot</h1>
        <p className="text-sm text-terminal-muted mt-1">Prop firm automation</p>
        <div className="mt-3">
          <LiveIndicator isConnected={true} showTime={false} />
        </div>
      </div>

      <div className="flex-1 py-3 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.title} className="mb-1">
            <p className="px-6 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-terminal-muted/60">
              {group.title}
            </p>
            {group.items.map((item) => {
              const isActive =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  title={item.hint}
                  className={`flex items-center px-6 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-terminal-buy/10 text-terminal-buy border-r-2 border-terminal-buy'
                      : 'text-terminal-muted hover:bg-terminal-panel hover:text-terminal-text'
                  }`}
                >
                  <span className="mr-3">{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div className="p-4 border-t border-terminal-border space-y-3">
        <button
          onClick={toggleTheme}
          className="flex items-center justify-center w-full px-4 py-2 text-sm font-medium text-terminal-muted bg-terminal-panel rounded-lg hover:text-terminal-text transition-colors"
        >
          {theme === 'light' ? (
            <><span className="mr-2">🌙</span> Dark Mode</>
          ) : (
            <><span className="mr-2">☀️</span> Light Mode</>
          )}
        </button>
        {user && (
          <div className="text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-terminal-text font-medium truncate">{user.name}</p>
                <p className="text-terminal-muted truncate">
                  {user.email}
                  {isAdmin && <span className="ml-1 text-terminal-buy">· admin</span>}
                </p>
              </div>
              <button
                onClick={() => logout()}
                className="shrink-0 px-2 py-1 rounded text-terminal-muted hover:text-terminal-text transition-colors"
                title="Sign out"
              >
                Sign out
              </button>
            </div>
          </div>
        )}
        <div className="text-xs text-terminal-muted">
          <p className="mt-1">v1.0</p>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <nav className="hidden md:flex w-64 bg-terminal-surface border-r border-terminal-border flex-col shrink-0">
        {navContent}
      </nav>

      {/* Mobile top bar */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 bg-terminal-surface border-b border-terminal-border">
        <h1 className="text-lg font-bold text-terminal-text">EdgePilot</h1>
        <button
          onClick={() => setMobileOpen(true)}
          className="text-terminal-muted hover:text-terminal-text transition-colors p-1"
          aria-label="Open menu"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <nav className="absolute left-0 top-0 bottom-0 w-72 bg-terminal-surface border-r border-terminal-border flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-terminal-border">
              <h1 className="text-lg font-bold text-terminal-text">Menu</h1>
              <button
                onClick={() => setMobileOpen(false)}
                className="text-terminal-muted hover:text-terminal-text transition-colors p-1"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {navContent}
          </nav>
        </div>
      )}
    </>
  );
}
