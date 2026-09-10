/**
 * Fleet readiness.
 *
 * Answers one question before a session window rather than during one: if a
 * signal arrived right now, would it become a trade?
 *
 * `docs/DEPLOY.md` ends with a checklist a human reads. This is that checklist
 * as code, because the failure mode it guards against is specific and
 * expensive: the alert fires, nothing happens, and the reason is three layers
 * down in a log while a 30-minute window closes.
 *
 * Every check names its own fix. A readiness report that says "not ready"
 * without saying what to do is a slower way of discovering the same problem.
 *
 * Broker connectivity is delegated to `runPreflight` rather than reimplemented,
 * and the check shape matches its `PreflightCheck` so both read identically.
 */

import { query } from '../db';
import config from '../config';
import { runPreflight, PreflightCredentials } from './tradovatePreflight';
import { externalChannelConfigured } from './notifications';
import { testSessionOverride } from '../strategy/sessions';
import logger from '../utils/logger';

const log = logger.child({ context: 'FleetReadiness' });

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped';

export interface ReadinessCheck {
  /** Machine key. Stable, compact, used by the CLI column. */
  area: string;
  /**
   * Human name for the same thing.
   *
   * These checks now surface in the dashboard as well as the terminal, and
   * "presets.verified" is a code path rather than a sentence. The CLI keeps
   * the key; the UI shows this.
   */
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it. Absent when the check passed. */
  remedy?: string;
}

/** Human names, keyed by the machine area. */
const LABELS: Record<string, string> = {
  schema: 'Database',
  strategy: 'Signal source',
  accounts: 'Broker accounts',
  'accounts.preset': 'Account plans',
  'accounts.credentials': 'Broker credentials',
  'accounts.category': 'Account type',
  'accounts.disabled': 'Disabled accounts',
  'presets.verified': 'Plan verification',
  'env.session': 'Session override',
  'env.webhook_secret': 'Webhook secret',
  'env.system_key': 'System key',
  'env.notifications': 'Notifications',
  open_trades: 'Open trades',
  broker: 'Broker connection',
};

const labelFor = (area: string): string =>
  LABELS[area] ?? (area.startsWith('broker.') ? `Broker — ${area.slice(7)}` : area);

export interface ReadinessReport {
  ready: boolean;
  checks: ReadinessCheck[];
}

const pass = (area: string, detail: string): ReadinessCheck =>
  ({ area, label: labelFor(area), status: 'pass', detail });
const fail = (area: string, detail: string, remedy: string): ReadinessCheck =>
  ({ area, label: labelFor(area), status: 'fail', detail, remedy });
const warn = (area: string, detail: string, remedy: string): ReadinessCheck =>
  ({ area, label: labelFor(area), status: 'warn', detail, remedy });

/** Does a table exist? Proxy for "migrations have been run to this version". */
async function tableExists(name: string): Promise<boolean> {
  const r = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [name]
  );
  return r.rows[0]?.exists === true;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column]
  );
  return r.rows[0]?.exists === true;
}

/**
 * Schema is current.
 *
 * There is no migrations ledger — `migrate.ts` re-runs every file and each is
 * idempotent — so this checks for the artefacts the most recent migrations
 * create. That is a better signal than a bookkeeping row anyway: it verifies
 * the schema the code actually needs, not that a script claimed to run.
 */
async function checkSchema(): Promise<ReadinessCheck> {
  const required: Array<[string, string | null]> = [
    ['notifications', null],                       // v16
    ['subscriptions', null],                       // v17
    ['broker_accounts', 'account_category'],       // v15
    ['presets', 'split_schedule'],                 // v14
    ['presets', 'consistency_pct'],                // v13
    ['presets', 'broker_day_tz'],                  // v11
    ['presets', 'daily_loss_cap_source'],          // v10
  ];

  const missing: string[] = [];
  for (const [table, column] of required) {
    const ok = column ? await columnExists(table, column) : await tableExists(table);
    if (!ok) missing.push(column ? `${table}.${column}` : table);
  }

  return missing.length === 0
    ? pass('schema', 'All expected tables and columns present')
    : fail('schema', `Missing: ${missing.join(', ')}`, 'Run: npm run db:migrate');
}

/** A strategy exists and carries the secret TradingView authenticates with. */
async function checkStrategy(): Promise<ReadinessCheck> {
  const r = await query<{ id: string; name: string; is_active: boolean; webhook_secret: string | null }>(
    `SELECT id, name, is_active, webhook_secret FROM strategies ORDER BY created_at`
  );
  if (r.rows.length === 0) {
    return fail(
      'strategy', 'No strategies configured',
      'Create one on the Signal Sources page. Its webhook URL, secret included, is what goes into the TradingView alert.'
    );
  }
  const active = r.rows.filter((s) => s.is_active && s.webhook_secret);
  if (active.length === 0) {
    return fail(
      'strategy', `${r.rows.length} strategy(ies), none active with a webhook secret`,
      'Activate one and confirm it has a webhook_secret — without it the webhook rejects every alert.'
    );
  }
  return pass('strategy', `${active.length} active: ${active.map((s) => s.name).join(', ')}`);
}

export interface AccountRow extends Record<string, unknown> {
  id: string;
  name: string;
  broker_type: string;
  is_active: boolean;
  is_disabled: boolean;
  preset_id: string | null;
  credentials: Record<string, unknown> | null;
  account_category: string | null;
  account_size: number | null;
  p_verified_at: Date | null;
  p_name: string | null;
}

async function loadAccounts(): Promise<AccountRow[]> {
  const r = await query<AccountRow>(
    `SELECT ba.id, ba.name, ba.broker_type, ba.is_active, ba.is_disabled,
            ba.preset_id, ba.credentials, ba.account_category, ba.account_size,
            p.verified_at AS p_verified_at, p.name AS p_name
     FROM broker_accounts ba
     LEFT JOIN presets p ON p.id = ba.preset_id
     WHERE ba.is_active = true
     ORDER BY ba.name`
  );
  return r.rows;
}

/** Accounts are configured well enough to size a trade. Exported for testing. */
export function checkAccounts(accounts: AccountRow[]): ReadinessCheck[] {
  if (accounts.length === 0) {
    return [fail(
      'accounts', 'No active broker accounts',
      'Add one on the Broker Accounts page, then assign it a plan on Firm Plans.'
    )];
  }

  const checks: ReadinessCheck[] = [];
  const noPreset = accounts.filter((a) => !a.preset_id);
  const noCreds = accounts.filter(
    (a) => a.broker_type !== 'mock' && (!a.credentials || Object.keys(a.credentials).length === 0)
  );
  const unpublished = accounts.filter((a) => a.preset_id && !a.p_verified_at);
  const noCategory = accounts.filter((a) => !a.account_category);
  const disabled = accounts.filter((a) => a.is_disabled);

  checks.push(
    noPreset.length === 0
      ? pass('accounts.preset', `${accounts.length} account(s), all with a plan`)
      : fail(
          'accounts.preset',
          `No plan assigned: ${noPreset.map((a) => a.name).join(', ')}`,
          'Without a plan the account is skipped entirely — no risk limits are applied to it and it will never trade.'
        )
  );

  checks.push(
    noCreds.length === 0
      ? pass('accounts.credentials', 'All non-mock accounts have credentials')
      : fail(
          'accounts.credentials',
          `No credentials: ${noCreds.map((a) => a.name).join(', ')}`,
          'Add the broker login on the Broker Accounts page, then confirm it works with: npm run tradovate:preflight'
        )
  );

  // Publishing is the act of a human confirming a preset against the firm's
  // rules page. Trading numbers nobody has checked is how a wrong drawdown or
  // daily cap reaches a live account.
  checks.push(
    unpublished.length === 0
      ? pass('presets.verified', 'All assigned plans are verified')
      : fail(
          'presets.verified',
          `Plan not yet verified on: ${unpublished.map((a) => `${a.name} (${a.p_name})`).join(', ')}`,
          'Publish the plan from Firm Plans, or mark it verified in the Rule Editor. An unverified plan means nobody has checked those numbers against the firm\'s own rules page — and every trade is sized from them.'
        )
  );

  checks.push(
    noCategory.length === 0
      ? pass('accounts.category', 'All accounts have a category and size')
      : warn(
          'accounts.category',
          `No category/size: ${noCategory.map((a) => a.name).join(', ')}`,
          'Set the account type and size so this account counts toward the firm\'s limit on how many you may hold. Uncounted accounts mean an over-limit purchase would not be caught.'
        )
  );

  if (disabled.length > 0) {
    checks.push(warn(
      'accounts.disabled',
      `Disabled: ${disabled.map((a) => a.name).join(', ')}`,
      'A disabled account is rejected by the executor. Re-enable it if it should be trading.'
    ));
  }

  return checks;
}

/** Environment: secrets set, and no development override left on. */
function checkEnvironment(): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];

  const override = testSessionOverride();
  checks.push(
    override === null
      ? pass('env.session', 'No session override — real windows only')
      : fail(
          'env.session',
          `GB_TEST_SESSION='${override}' widens that session to the whole day`,
          'Unset GB_TEST_SESSION. It is ignored when NODE_ENV=production, but leaving it set is a landmine for the day this runs otherwise.'
        )
  );

  checks.push(
    config.webhook.secret && config.webhook.secret !== 'dev-secret-change-me'
      ? pass('env.webhook_secret', 'WEBHOOK_SECRET is set')
      : fail(
          'env.webhook_secret',
          'WEBHOOK_SECRET is unset or still the dev default',
          'Generate one: openssl rand -hex 32'
        )
  );

  checks.push(
    process.env.SYSTEM_API_KEY
      ? pass('env.system_key', 'SYSTEM_API_KEY is set')
      : warn(
          'env.system_key',
          'SYSTEM_API_KEY is not set',
          'Set it so the kill-switch endpoint requires a second factor beyond an admin session.'
        )
  );

  checks.push(
    externalChannelConfigured()
      ? pass('env.notifications', 'Notification channel configured')
      : warn(
          'env.notifications',
          'No external notification channel',
          'Set NOTIFY_WEBHOOK_URL (Slack, Discord, ntfy, any JSON POST endpoint). Without it a blown account reaches a database table and nothing else.'
        )
  );

  return checks;
}

/** Anything left open from a previous run. */
async function checkOpenState(): Promise<ReadinessCheck> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM gb_trades WHERE state NOT IN ('closed', 'failed')`
  );
  const open = parseInt(r.rows[0]?.n ?? '0', 10);
  return open === 0
    ? pass('open_trades', 'No open trades')
    : warn(
        'open_trades', `${open} trade(s) still open`,
        'Expected if a position is genuinely live. If not, they are stale — the bracket manager rehydrates on boot, so check the fleet page before assuming.'
      );
}

/** Broker reachability, per account, via the existing read-only preflight. */
async function checkBrokers(accounts: AccountRow[]): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  for (const a of accounts) {
    if (a.broker_type === 'mock' || a.broker_type === 'simulated') {
      checks.push(warn(
        `broker.${a.name}`, `${a.broker_type} broker — not a real connection`,
        'Fine for testing. A mock account will never place a real order.'
      ));
      continue;
    }
    if (a.broker_type !== 'tradovate') {
      checks.push(warn(`broker.${a.name}`, `No preflight for broker type '${a.broker_type}'`, 'Verify connectivity manually.'));
      continue;
    }
    try {
      const result = await runPreflight(a.credentials as unknown as PreflightCredentials);
      const failed = result.checks.filter((c) => c.status === 'fail');
      checks.push(
        result.ok
          ? pass(`broker.${a.name}`, `Preflight passed (${result.environment})`)
          : fail(
              `broker.${a.name}`,
              failed.map((c) => `${c.step}: ${c.detail}`).join(' | ') || 'preflight failed',
              failed[0]?.remedy ?? 'Run: npm run tradovate:preflight -- --account ' + a.id
            )
      );
    } catch (error) {
      checks.push(fail(
        `broker.${a.name}`,
        error instanceof Error ? error.message : String(error),
        'Run: npm run tradovate:preflight -- --account ' + a.id
      ));
    }
  }
  return checks;
}

/**
 * Full readiness report.
 *
 * Read-only throughout — it places no orders and changes no state, so it is
 * safe to run at any time, including against live funded accounts.
 */
export async function fleetReadiness(options: { skipBroker?: boolean } = {}): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];

  checks.push(await checkSchema());
  checks.push(await checkStrategy());

  const accounts = await loadAccounts();
  checks.push(...checkAccounts(accounts));
  checks.push(...checkEnvironment());
  checks.push(await checkOpenState());

  if (options.skipBroker) {
    checks.push({ area: 'broker', label: labelFor('broker'), status: 'skipped', detail: 'Skipped (--no-broker)' });
  } else {
    checks.push(...await checkBrokers(accounts));
  }

  const ready = !checks.some((c) => c.status === 'fail');
  log.info('Fleet readiness evaluated', {
    ready,
    failed: checks.filter((c) => c.status === 'fail').length,
    warned: checks.filter((c) => c.status === 'warn').length,
  });
  return { ready, checks };
}

/** Human-readable report, matching the preflight's layout. */
export function formatReadiness(report: ReadinessReport): string {
  const icon = { pass: '  OK  ', fail: ' FAIL ', warn: ' WARN ', skipped: ' SKIP ' } as const;
  const lines = [`Fleet readiness — ${report.ready ? 'READY' : 'NOT READY'}`, ''];
  for (const c of report.checks) {
    lines.push(`[${icon[c.status]}] ${c.area.padEnd(22)} ${c.detail}`);
    if (c.remedy) lines.push(`${' '.repeat(10)}→ ${c.remedy}`);
  }
  const warns = report.checks.filter((c) => c.status === 'warn').length;
  if (report.ready && warns > 0) {
    lines.push('', `Ready, with ${warns} warning(s) above. None blocks a trade; read them anyway.`);
  }
  return lines.join('\n');
}
