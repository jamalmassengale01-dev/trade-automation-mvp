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
        // Trading Terminal palette.
        //
        // Defined as CSS variables in globals.css so it flips with the theme —
        // hardcoding hex here made light mode paint near-white text on a
        // near-white page. `<alpha-value>` keeps the /10, /15, /40 opacity
        // modifiers used across the pages working.
        terminal: {
          bg:         'rgb(var(--term-bg) / <alpha-value>)',      // outer shell
          surface:    'rgb(var(--term-surface) / <alpha-value>)', // sidebar / cards
          panel:      'rgb(var(--term-panel) / <alpha-value>)',   // inputs / inner panels
          border:     'rgb(var(--term-border) / <alpha-value>)',
          text:       'rgb(var(--term-text) / <alpha-value>)',
          muted:      'rgb(var(--term-muted) / <alpha-value>)',
          buy:        'rgb(var(--term-buy) / <alpha-value>)',     // profit / positive
          sell:       'rgb(var(--term-sell) / <alpha-value>)',    // loss / negative
          killswitch: 'rgb(var(--term-kill) / <alpha-value>)',
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
