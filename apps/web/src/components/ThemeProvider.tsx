'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/**
 * Applies the theme as a class on <html>.
 *
 * BOTH classes are set explicitly. Toggling only `dark` was the original bug:
 * globals.css defines its light palette on `.light`, so removing `dark` left
 * the root with no theme class at all and the dark variables still in force.
 * The toggle appeared to do nothing, then appeared to do something worse once
 * the body background alone started changing.
 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Default to dark (terminal aesthetic); respect saved preference if set
    let savedTheme: Theme | null = null;
    try {
      savedTheme = localStorage.getItem('theme') as Theme | null;
    } catch {
      // Private windows and blocked site data throw on access. A remembered
      // theme is a convenience; losing it must not blank the page.
    }
    const initialTheme: Theme = savedTheme === 'light' ? 'light' : 'dark';
    setTheme(initialTheme);
    applyTheme(initialTheme);
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    try {
      localStorage.setItem('theme', newTheme);
    } catch {
      // Not remembered across reloads; still applied for this session.
    }
    applyTheme(newTheme);
  };

  if (!mounted) {
    // Still wrap with provider so useTheme() doesn't throw before hydration
    return (
      <ThemeContext.Provider value={{ theme, toggleTheme }}>
        {children}
      </ThemeContext.Provider>
    );
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}
