import logger from '../utils/logger';

const resolverLogger = logger.child({ context: 'SymbolResolver' });

// Standard futures month codes
const MONTH_CODES: Record<string, number> = {
  F: 1, G: 2, H: 3, J: 4, K: 5, M: 6,
  N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12,
};

interface CacheEntry {
  resolvedSymbol: string;
  expiresAt: Date;
}

// Cache keyed by "baseUrl:root" — survives the process lifetime, refreshes every 6h
const cache = new Map<string, CacheEntry>();

/**
 * Resolve a TradingView-style continuous symbol (MNQ1!, ES1!, NQ1!) to the
 * current front-month Tradovate contract (MNQM6, ESM6, NQM6).
 *
 * If the symbol does not end in `1!` it is returned unchanged.
 */
export async function resolveSymbol(
  tradingViewSymbol: string,
  baseUrl: string,
  accessToken: string
): Promise<string> {
  if (!tradingViewSymbol.endsWith('1!')) {
    return tradingViewSymbol;
  }

  const root = tradingViewSymbol.slice(0, -2); // strip "1!"
  const cacheKey = `${baseUrl}:${root}`;
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > new Date()) {
    return cached.resolvedSymbol;
  }

  try {
    const contracts = await fetchSuggestedContracts(baseUrl, accessToken, root);
    const frontMonth = pickFrontMonth(contracts);

    if (!frontMonth) {
      resolverLogger.warn('Could not resolve front-month contract, using root as-is', { root });
      return root;
    }

    cache.set(cacheKey, {
      resolvedSymbol: frontMonth,
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000), // 6 hours
    });

    resolverLogger.info('Resolved symbol', { from: tradingViewSymbol, to: frontMonth });
    return frontMonth;
  } catch (err) {
    resolverLogger.error('Symbol resolution failed, falling back to root', {
      root,
      error: String(err),
    });
    return root;
  }
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

interface TradovateContractSuggestion {
  id: number;
  name: string;
}

async function fetchSuggestedContracts(
  baseUrl: string,
  accessToken: string,
  root: string
): Promise<TradovateContractSuggestion[]> {
  const res = await fetch(`${baseUrl}/contract/suggest?t=${encodeURIComponent(root)}&l=10`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`contract/suggest ${res.status}`);
  }

  return res.json() as Promise<TradovateContractSuggestion[]>;
}

function pickFrontMonth(contracts: TradovateContractSuggestion[]): string | null {
  const now = new Date();

  const withExpiry: { name: string; expiry: Date }[] = [];

  for (const c of contracts) {
    const expiry = parseContractExpiry(c.name);
    if (expiry) withExpiry.push({ name: c.name, expiry });
  }

  // Keep contracts that haven't expired yet (allow up to 7 days past mid-month
  // to handle expiry week where front-month is still tradeable)
  const active = withExpiry.filter(
    (c) => c.expiry > new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  );

  if (active.length === 0) return null;

  // Sort by nearest expiry — that's the front month
  active.sort((a, b) => a.expiry.getTime() - b.expiry.getTime());
  return active[0].name;
}

function parseContractExpiry(contractName: string): Date | null {
  if (contractName.length < 2) return null;

  // Contract names end with MonthCode + YearDigit e.g. "MNQM6"
  // year digit is single: 5 = 2025, 6 = 2026, 7 = 2027 etc.
  const yearChar = contractName[contractName.length - 1];
  const monthChar = contractName[contractName.length - 2];

  const yearDigit = parseInt(yearChar, 10);
  if (isNaN(yearDigit)) return null;

  const month = MONTH_CODES[monthChar.toUpperCase()];
  if (!month) return null;

  // Determine century: assume 2020s for now; revisit in 2030
  const year = 2020 + yearDigit;

  // Use the 15th as a proxy for mid-month expiry (third Friday approximation)
  return new Date(year, month - 1, 15);
}
