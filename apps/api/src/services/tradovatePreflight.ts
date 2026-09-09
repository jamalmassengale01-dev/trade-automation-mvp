/**
 * Tradovate preflight.
 *
 * Answers one question: if a GB LIVE signal fired right now, would it reach
 * the broker? It walks the same path an order takes — authenticate, list
 * accounts, read the balance, resolve the front-month contract — and stops at
 * the first step that fails, naming the step and the fix.
 *
 * This exists because every one of these failures otherwise surfaces as the
 * same thing: a signal that produced no trade. Distinguishing "the API Access
 * add-on lapsed" from "the front month rolled" from "the password expired"
 * after the fact, from logs, during a 30-minute session window, is not a
 * position worth being in.
 *
 * It is deliberately READ-ONLY. It never places an order, so it is safe to run
 * against a live funded account at any time.
 */

import { TradovateAuthError, requestAccessToken, credentialsToAuthRequest } from '../brokers/tradovate/auth';
import { resolveSymbol } from './symbolResolver';
import logger from '../utils/logger';

const log = logger.child({ context: 'TradovatePreflight' });

const BASE_URLS = {
  demo: 'https://demo.tradovateapi.com/v1',
  live: 'https://live.tradovateapi.com/v1',
} as const;

export type PreflightStep =
  | 'credentials_present'
  | 'authenticate'
  | 'list_accounts'
  | 'account_selected'
  | 'read_balance'
  | 'resolve_contract'
  | 'trading_permission';

export interface PreflightCheck {
  step: PreflightStep;
  status: 'pass' | 'fail' | 'warn' | 'skipped';
  detail: string;
  /** What to actually do about it. Absent when the check passed. */
  remedy?: string;
}

export interface PreflightResult {
  environment: 'demo' | 'live';
  ok: boolean;
  checks: PreflightCheck[];
  /** Populated once authentication succeeds. */
  accounts?: { id: number; name: string; active: boolean }[];
  balance?: number;
  contract?: { requested: string; resolved: string };
}

export interface PreflightCredentials {
  username: string;
  password: string;
  appId: string;
  appVersion: string;
  cid: string;
  sec: string;
  deviceId: string;
  environment?: 'demo' | 'live';
  tradovateAccountId?: string;
  tradovateAccountSpec?: string;
}

const REQUIRED_FIELDS: (keyof PreflightCredentials)[] = [
  'username', 'password', 'appId', 'appVersion', 'cid', 'sec', 'deviceId',
];

/** Map an auth failure to the thing the operator has to change. */
function authRemedy(err: TradovateAuthError): string {
  switch (err.kind) {
    case 'captcha':
      return 'Log into trader.tradovate.com with these credentials and clear the captcha, then retry.';
    case 'penalty_timeout':
      return 'Too many authentications from this login. Tokens are cached for ~24h and shared ' +
             'across accounts on the same login — if you are seeing this outside a restart storm, ' +
             'something is authenticating per-signal instead of per-day.';
    case 'no_api_access':
      return 'The API Access add-on is not active on this Tradovate user. Subscribe under ' +
             'Settings → API Access, then generate a key under Settings → App Permissions.';
    case 'credentials':
      return 'Check username and the API-dedicated password (NOT your web login password), and ' +
             'that cid/sec match the key shown under Settings → App Permissions.';
    default:
      return 'Unexpected auth response — capture the payload and check the Tradovate status page.';
  }
}

async function tvGet<T>(baseUrl: string, path: string, token: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${path} → ${res.status} ${text}`.trim());
  }
  return res.json() as Promise<T>;
}

/**
 * Run every check, stopping at the first hard failure.
 *
 * Steps after a failure are reported as `skipped` rather than omitted, so the
 * output always shows the full path and how far down it got.
 */
export async function runPreflight(
  creds: PreflightCredentials,
  opts: { symbol?: string } = {}
): Promise<PreflightResult> {
  const environment = creds.environment ?? 'demo';
  const baseUrl = BASE_URLS[environment];
  const checks: PreflightCheck[] = [];
  const symbol = opts.symbol ?? 'MNQ1!';

  const remainingSteps: PreflightStep[] = [
    'authenticate', 'list_accounts', 'account_selected',
    'read_balance', 'resolve_contract', 'trading_permission',
  ];
  const skipRest = (from: PreflightStep, why: string): PreflightResult => {
    for (const step of remainingSteps.slice(remainingSteps.indexOf(from))) {
      checks.push({ step, status: 'skipped', detail: why });
    }
    return { environment, ok: false, checks };
  };

  // 1. Credentials present -------------------------------------------------
  const missing = REQUIRED_FIELDS.filter((f) => !creds[f]);
  if (missing.length > 0) {
    checks.push({
      step: 'credentials_present',
      status: 'fail',
      detail: `Missing: ${missing.join(', ')}`,
      remedy: 'Fill these into broker_accounts.credentials (JSONB). deviceId is any stable UUID ' +
              'you generate once and keep — Tradovate treats a changing deviceId as a new device.',
    });
    return skipRest('authenticate', 'credentials incomplete');
  }
  checks.push({ step: 'credentials_present', status: 'pass', detail: 'All seven fields present' });

  // 2. Authenticate --------------------------------------------------------
  let token: string;
  let userId: number;
  try {
    const t = await requestAccessToken(
      async (path, body) => {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`POST ${path} → ${res.status} ${text}`.trim());
        }
        return res.json();
      },
      credentialsToAuthRequest(creds),
      { onPenalty: (s, a) => log.warn('Auth time penalty', { waitSeconds: s, attempt: a }) }
    );
    token = t.accessToken;
    userId = t.userId;
    checks.push({
      step: 'authenticate',
      status: 'pass',
      detail: `Authenticated as userId=${userId} against ${environment}`,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    checks.push({
      step: 'authenticate',
      status: 'fail',
      detail,
      remedy: err instanceof TradovateAuthError
        ? authRemedy(err)
        : 'Network or endpoint error — confirm the environment (demo vs live) matches the credentials.',
    });
    return skipRest('list_accounts', 'not authenticated');
  }

  // 3. List accounts -------------------------------------------------------
  let accounts: { id: number; name: string; active: boolean }[];
  try {
    accounts = await tvGet<{ id: number; name: string; active: boolean }[]>(baseUrl, '/account/list', token);
  } catch (err) {
    checks.push({
      step: 'list_accounts',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      remedy: 'Authentication succeeded but the account list was refused — this is the signature ' +
              'of a login without the API Access add-on.',
    });
    return skipRest('account_selected', 'account list unavailable');
  }

  if (accounts.length === 0) {
    checks.push({
      step: 'list_accounts',
      status: 'fail',
      detail: 'Authenticated, but this login has zero accounts',
      remedy: 'This login owns no tradable accounts. A personal Tradovate login does NOT see ' +
              'prop-firm accounts — those are provisioned under the credentials the prop firm ' +
              'issues, and must be configured as their own broker_accounts row.',
    });
    return skipRest('account_selected', 'no accounts');
  }
  checks.push({
    step: 'list_accounts',
    status: 'pass',
    detail: `${accounts.length} account(s): ${accounts.map((a) => `${a.name}#${a.id}${a.active ? '' : ' (inactive)'}`).join(', ')}`,
  });

  // 4. The specific account this row will trade ----------------------------
  const pinned = creds.tradovateAccountId ? Number(creds.tradovateAccountId) : null;
  const selected = pinned
    ? accounts.find((a) => a.id === pinned)
    : accounts.find((a) => a.active) ?? accounts[0];

  if (!selected) {
    checks.push({
      step: 'account_selected',
      status: 'fail',
      detail: `Pinned tradovateAccountId=${pinned} is not in this login's account list`,
      remedy: 'Repin to one of the ids above, or clear tradovateAccountId to auto-discover.',
    });
    return skipRest('read_balance', 'no account selected');
  }
  checks.push({
    step: 'account_selected',
    status: pinned ? 'pass' : 'warn',
    detail: `Will trade ${selected.name} (id=${selected.id})`,
    remedy: pinned
      ? undefined
      : 'Not pinned — the account is auto-discovered each time. With more than one account on a ' +
        `login this can silently move. Pin it: tradovateAccountId="${selected.id}", ` +
        `tradovateAccountSpec="${selected.name}".`,
  });

  // 5. Balance -------------------------------------------------------------
  let balance: number | undefined;
  try {
    const raw = await tvGet<{ amount: number }[] | { amount: number }>(
      baseUrl, `/cashBalance/getCashBalanceSnapshot?accountId=${selected.id}`, token
    );
    balance = (Array.isArray(raw) ? raw[0] : raw)?.amount;
    checks.push({
      step: 'read_balance',
      status: balance === undefined ? 'warn' : 'pass',
      detail: balance === undefined ? 'Balance snapshot returned no amount' : `Cash balance ${balance}`,
    });
  } catch (err) {
    checks.push({
      step: 'read_balance',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      remedy: 'The DLL gate and the rule reconciler both read this. Without it every signal is ' +
              'either blocked or sized against stale state.',
    });
  }

  // 6. Front-month contract ------------------------------------------------
  // A rolled contract is the classic silent killer: everything authenticates,
  // every gate passes, and the order is rejected on an expired symbol.
  let contract: { requested: string; resolved: string } | undefined;
  try {
    const resolved = await resolveSymbol(symbol, baseUrl, token);
    const found = await tvGet<{ id: number; name: string } | null>(
      baseUrl, `/contract/find?name=${encodeURIComponent(resolved)}`, token
    );
    if (found?.id) {
      contract = { requested: symbol, resolved };
      checks.push({
        step: 'resolve_contract',
        status: 'pass',
        detail: `${symbol} → ${resolved} (contractId=${found.id})`,
      });
    } else {
      checks.push({
        step: 'resolve_contract',
        status: 'fail',
        detail: `${symbol} resolved to ${resolved}, which Tradovate does not recognise`,
        remedy: 'The front month has almost certainly rolled. Check the quarterly mapping in ' +
                'services/symbolResolver.ts (H/M/U/Z) against the current date.',
      });
    }
  } catch (err) {
    checks.push({
      step: 'resolve_contract',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      remedy: 'Contract lookup failed — orders will be rejected at placement.',
    });
  }

  // 7. Trading permission --------------------------------------------------
  // Reported, never asserted: an account can be readable and still refuse
  // orders. Only a real order proves this, and preflight does not place one.
  checks.push({
    step: 'trading_permission',
    status: 'warn',
    detail: 'Not verified — preflight is read-only and never places an order',
    remedy: 'Confirm with one 1-contract manual order on this account before relying on it.',
  });

  const ok = !checks.some((c) => c.status === 'fail' || c.status === 'skipped');
  return { environment, ok, checks, accounts, balance, contract };
}

/** Human-readable report. */
export function formatPreflight(result: PreflightResult): string {
  const icon = { pass: '  OK  ', fail: ' FAIL ', warn: ' WARN ', skipped: ' SKIP ' } as const;
  const lines = [
    `Tradovate preflight — ${result.environment.toUpperCase()} — ${result.ok ? 'READY' : 'NOT READY'}`,
    '',
  ];
  for (const c of result.checks) {
    lines.push(`[${icon[c.status]}] ${c.step.padEnd(20)} ${c.detail}`);
    if (c.remedy) lines.push(`${' '.repeat(10)}→ ${c.remedy}`);
  }
  return lines.join('\n');
}
