'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from './ThemeProvider';
import { LiveIndicator } from './LiveIndicator';
import { useAuth } from './AuthProvider';

// adminOnly links are also enforced server-side; hiding them here just keeps
// customers from clicking into a guaranteed 403.
const navItems = [
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/fleet', label: 'Fleet', icon: '🚀' },
  { href: '/launchpad', label: 'LaunchPad', icon: '💰' },
  { href: '/catalog', label: 'Plans', icon: '📚' },
  { href: '/presets', label: 'Presets', icon: '🎛️', adminOnly: true },
  { href: '/calculator', label: 'Calculator', icon: '🧮', adminOnly: true },
  { href: '/strategies', label: 'Strategies', icon: '⚡' },
  { href: '/accounts', label: 'Accounts', icon: '💳' },
  { href: '/alerts', label: 'Alerts', icon: '🔔' },
  { href: '/orders', label: 'Orders', icon: '📋' },
  { href: '/health', label: 'Account Health', icon: '🩺', adminOnly: true },
  { href: '/risk-events', label: 'Risk Events', icon: '⚠️' },
  { href: '/settings', label: 'Settings', icon: '⚙️' },
];

export function Navigation() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const { user, isAdmin, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const visibleItems = navItems.filter((i) => !i.adminOnly || isAdmin);

  const navContent = (
    <>
      <div className="p-6 border-b border-terminal-border">
        <h1 className="text-xl font-bold text-terminal-text">Trade Automation</h1>
        <p className="text-sm text-terminal-muted mt-1">MVP Dashboard</p>
        <div className="mt-3">
          <LiveIndicator isConnected={true} showTime={false} />
        </div>
      </div>

      <div className="flex-1 py-4 overflow-y-auto">
        {visibleItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center px-6 py-3 text-sm font-medium transition-colors ${
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
          <p className="mt-1">Version: 1.0.0-hardened</p>
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
        <h1 className="text-lg font-bold text-terminal-text">Trade Automation</h1>
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
