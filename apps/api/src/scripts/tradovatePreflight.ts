/**
 * Tradovate preflight CLI.
 *
 *   npm run tradovate:preflight                       # every tradovate broker_account
 *   npm run tradovate:preflight -- --account <uuid>   # one saved account
 *   npm run tradovate:preflight -- --env               # credentials from TRADOVATE_* env vars
 *
 * The --env mode exists so credentials can be validated BEFORE they are written
 * to the database. Getting a working set of Tradovate credentials is fiddly
 * enough that "save it and hope" is the wrong order of operations.
 *
 * Every import here is dynamic and happens inside main(). That is not style:
 * the app's config module throws on a missing DATABASE_URL at import time, and
 * it sits behind the logger that everything else imports. A static import
 * would make a database a prerequisite for the one mode whose entire purpose
 * is to run before any of the app exists.
 *
 * Read-only. It never places an order.
 */

import type { PreflightCredentials } from '../services/tradovatePreflight';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function credsFromEnv(): PreflightCredentials {
  const e = process.env;
  return {
    username: e.TRADOVATE_USERNAME ?? '',
    password: e.TRADOVATE_PASSWORD ?? '',
    appId: e.TRADOVATE_APP_ID ?? 'EdgePilot',
    appVersion: e.TRADOVATE_APP_VERSION ?? '1.0',
    cid: e.TRADOVATE_CID ?? '',
    sec: e.TRADOVATE_SEC ?? '',
    deviceId: e.TRADOVATE_DEVICE_ID ?? '',
    environment: e.TRADOVATE_ENV === 'live' ? 'live' : 'demo',
    tradovateAccountId: e.TRADOVATE_ACCOUNT_ID,
  };
}

async function main(): Promise<void> {
  const symbol = arg('symbol') ?? 'MNQ1!';
  const envMode = flag('env');

  // config throws on a missing DATABASE_URL, and --env must not need one.
  if (envMode && !process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgres://preflight@unused/unused';
  }

  const { runPreflight, formatPreflight } = await import('../services/tradovatePreflight');
  let failures = 0;

  if (envMode) {
    const result = await runPreflight(credsFromEnv(), { symbol });
    console.log(formatPreflight(result));
    if (!result.ok) failures++;
  } else {
    const accountId = arg('account');
    const { query, closePool } = await import('../db');
    try {
      const rows = await query<{ id: string; name: string; credentials: unknown }>(
        `SELECT id, name, credentials FROM broker_accounts
         WHERE broker_type = 'tradovate' ${accountId ? 'AND id = $1' : ''}
         ORDER BY name`,
        accountId ? [accountId] : []
      );

      if (rows.rows.length === 0) {
        console.log(
          accountId
            ? `No tradovate broker_account with id ${accountId}.`
            : 'No tradovate broker_accounts configured. Use --env to test credentials before saving them.'
        );
        return;
      }

      for (const row of rows.rows) {
        console.log(`\n=== ${row.name} (${row.id}) ===`);
        const result = await runPreflight(row.credentials as PreflightCredentials, { symbol });
        console.log(formatPreflight(result));
        if (!result.ok) failures++;
      }
    } finally {
      await closePool().catch(() => undefined);
    }
  }

  // Non-zero exit so this is usable as a deploy gate, not just something to read.
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Preflight crashed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
