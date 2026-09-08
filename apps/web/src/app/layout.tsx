import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastProvider } from '@/components/ToastProvider';
import { AuthProvider } from '@/components/AuthProvider';
import { AuthGate } from '@/components/AuthGate';

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
          <AuthProvider>
            {/* Renders the sign-in form until there is a session; the nav and
                page content only mount for an authenticated user. */}
            <AuthGate>{children}</AuthGate>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
