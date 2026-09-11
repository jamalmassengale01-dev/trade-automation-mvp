import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastProvider } from '@/components/ToastProvider';
import { AuthProvider } from '@/components/AuthProvider';
import { AuthGate } from '@/components/AuthGate';

export const metadata: Metadata = {
  title: 'EdgePilot',
  description: 'Prop firm trading automation and fleet management',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/*
          Applies the saved theme before first paint.
          ThemeProvider reads localStorage in an effect, which runs after the
          browser has already painted — so a light-mode user gets a full dark
          screen first, then a flash. Inline and synchronous is the only way to
          beat the first paint; it is a handful of lines and no dependency.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme')==='light'?'light':'dark';var r=document.documentElement;r.classList.toggle('dark',t==='dark');r.classList.toggle('light',t==='light');}catch(e){}})();`,
          }}
        />
      </head>
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
