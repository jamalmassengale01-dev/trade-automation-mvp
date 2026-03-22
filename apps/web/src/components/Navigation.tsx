'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from './ThemeProvider';
import { LiveIndicator } from './LiveIndicator';

const navItems = [
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/accounts', label: 'Accounts', icon: '💳' },
  { href: '/alerts', label: 'Alerts', icon: '🔔' },
  { href: '/orders', label: 'Orders', icon: '📋' },
  { href: '/risk-events', label: 'Risk Events', icon: '⚠️' },
  { href: '/settings', label: 'Settings', icon: '⚙️' },
];

export function Navigation() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();

  return (
    <nav className="w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col">
      <div className="p-6 border-b border-gray-200 dark:border-gray-700">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Trade Automation</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">MVP Dashboard</p>
        <div className="mt-3">
          <LiveIndicator isConnected={true} showTime={false} />
        </div>
      </div>
      
      <div className="flex-1 py-4">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center px-6 py-3 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-50 text-blue-700 border-r-2 border-blue-700 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-500'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white'
              }`}
            >
              <span className="mr-3">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </div>
      
      <div className="p-4 border-t border-gray-200 dark:border-gray-700 space-y-3">
        {/* Dark Mode Toggle */}
        <button
          onClick={toggleTheme}
          className="flex items-center justify-center w-full px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 transition-colors"
        >
          {theme === 'light' ? (
            <>
              <span className="mr-2">🌙</span> Dark Mode
            </>
          ) : (
            <>
              <span className="mr-2">☀️</span> Light Mode
            </>
          )}
        </button>
        
        <div className="text-xs text-gray-500 dark:text-gray-400">
          <p>Environment: <span className="font-medium">Development</span></p>
          <p className="mt-1">Version: 1.0.0-hardened</p>
        </div>
      </div>
    </nav>
  );
}
