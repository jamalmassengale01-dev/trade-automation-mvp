import type { Metadata } from 'next';
import './globals.css';
import { Navigation } from '@/components/Navigation';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastProvider } from '@/components/ToastProvider';

export const metadata: Metadata = {
  title: 'Trade Automation Dashboard',
  description: 'Trading automation platform dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-slate-50 dark:bg-gray-900">
        <ThemeProvider>
          <ToastProvider />
          <div className="flex h-screen">
            <Navigation />
            <main className="flex-1 overflow-auto p-8">
              {children}
            </main>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
