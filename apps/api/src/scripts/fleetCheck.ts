/**
 * Fleet readiness CLI.
 *
 *   npm run fleet:check                  # everything, including broker preflight
 *   npm run fleet:check -- --no-broker   # config and state only, no network
 *
 * Read-only. Places no orders and changes no state, so it is safe against live
 * funded accounts at any time — including during a session window.
 *
 * Exits non-zero on any failure, so it works as a deploy gate as well as
 * something to read.
 */
import { fleetReadiness, formatReadiness } from '../services/fleetReadiness';
import { closePool } from '../db';

async function main(): Promise<void> {
  const report = await fleetReadiness({ skipBroker: process.argv.includes('--no-broker') });
  console.log('\n' + formatReadiness(report) + '\n');
  if (!report.ready) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('Readiness check crashed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => undefined));
