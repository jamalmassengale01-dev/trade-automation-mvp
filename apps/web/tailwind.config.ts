import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Trading Terminal palette
        terminal: {
          bg: '#020617',       // slate-950 — outer shell
          surface: '#0f172a',  // slate-900 — sidebar / panels
          panel: '#1e293b',    // slate-800 — inner cards
          border: '#334155',   // slate-700
          text: '#f1f5f9',     // slate-100
          muted: '#94a3b8',    // slate-400
          buy: '#34d399',      // emerald-400 — buy / profit / positive
          sell: '#fb7185',     // rose-400   — sell / loss / negative
          killswitch: '#dc2626', // red-600
        },
        // Legacy status colors (keep for StatusBadge compatibility)
        success: {
          50: '#f0fdf4',
          100: '#dcfce7',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
        },
        danger: {
          50: '#fef2f2',
          100: '#fee2e2',
          500: '#ef4444',
          600: '#dc2626',
          700: '#b91c1c',
        },
        warning: {
          50: '#fffbeb',
          100: '#fef3c7',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
        },
      },
    },
  },
  plugins: [],
};

export default config;
