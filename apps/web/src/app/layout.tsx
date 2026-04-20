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
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-terminal-bg text-terminal-text">
        <ThemeProvider>
          <ToastProvider />
          {/* Mobile: stacked layout (top bar + content). Desktop: sidebar + content side-by-side */}
          <div className="flex flex-col md:flex-row h-screen overflow-hidden">
            <Navigation />
            <main className="flex-1 overflow-auto">
              {children}
            </main>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
