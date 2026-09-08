/**
 * Rule reconciliation service.
 *
 * Pulls the broker's view of an account, compares it against the preset's
 * assumptions via the pure reconciler, persists the verdict, and raises risk
 * events on anything that halts trading.
 *
 * Runs on a schedule and on demand — never inline on the signal path. The
 * executor reads the newest persisted verdict instead, so a signal is never
 * delayed by a broker round-trip and a broker outage cannot stall execution.
 */

import { query } from '../db';
import { getBrokerAdapter } from '../brokers';
import { BrokerAccount, BrokerType } from '../types';
import {
  reconcileRules,
  ReconcileFinding,
  Verdict,
  PresetAssumptions,
} from '../strategy/ruleReconciler';
import logger from '../utils/logger';

const log = logger.child({ context: 'RuleReconciliation' });

export interface RuleCheckResult {
  accountId: string;
  accountName: string;
  presetId: string | null;
  verdict: Verdict | 'error';
  findings: ReconcileFinding[];
  error?: string;
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  name: string;
  broker_type: string;
  account_id: string;
  credentials: unknown;
  is_active: boolean;
  is_disabled: boolean;
  preset_id: string | null;
  day_realized_pnl: string | number;
  cumulative_pnl: string | number;
  ladder_step: number;
  p_start_balance: string | number | null;
  p_max_drawdown: string | number | null;
  p_daily_loss_cap: string | number | null;
  p_phase: string | null;
  p_verified_at: Date | null;
  p_stale_after_days: number | null;
  p_inactivity_alert_days: number | null;
  created_at: Date | null;
}

const num = (v: string | number | null | undefined): number => Number(v ?? 0);

/**
 * Reconcile one account. Never throws — a broker failure is recorded as an
 * 'error' check so the operator sees the gap rather than it vanishing.
 */
export async function reconcileAccountRules(accountId: string): Promise<RuleCheckResult> {
  const r = await query<AccountRow>(
    `SELECT ba.*,
            p.start_balance    AS p_start_balance,
            p.max_drawdown     AS p_max_drawdown,
            p.daily_loss_cap   AS p_daily_loss_cap,
            p.phase            AS p_phase,
            p.verified_at      AS p_verified_at,
            p.stale_after_days AS p_stale_after_days,
            p.inactivity_alert_days AS p_inactivity_alert_days
     FROM broker_accounts ba
     LEFT JOIN presets p ON p.id = ba.preset_id
     WHERE ba.id = $1`,
    [accountId]
  );
  const acct = r.rows[0];
  if (!acct) {
    return {
      accountId, accountName: 'unknown', presetId: null,
      verdict: 'error', findings: [], error: 'Account not found',
    };
  }

  const base = { accountId: acct.id, accountName: acct.name, presetId: acct.preset_id };

  // No preset means the generic copier path, which does not size from prop-firm
  // assumptions — there is nothing to reconcile.
  if (!acct.preset_id || acct.p_start_balance === null) {
    return { ...base, verdict: 'ok', findings: [] };
  }

  try {
    const adapter = getBrokerAdapter(acct.broker_type as BrokerType);
    const info = await adapter.getAccountInfo(acct as unknown as BrokerAccount);

    const preset: PresetAssumptions = {
      id: acct.preset_id,
      startBalance: num(acct.p_start_balance),
      maxDrawdown: num(acct.p_max_drawdown),
      dailyLossCap: num(acct.p_daily_loss_cap),
      phase: (acct.p_phase as 'eval' | 'funded') ?? 'eval',
      verifiedAt: acct.p_verified_at ? new Date(acct.p_verified_at) : null,
      staleAfterDays: acct.p_stale_after_days ?? 90,
      inactivityAlertDays: acct.p_inactivity_alert_days ?? 0,
    };

    // Idle time is measured from the last trade, or from account creation when
    // there has never been one.
    const lastTrade = await query<{ last_at: Date | null }>(
      `SELECT MAX(created_at) AS last_at FROM gb_trades WHERE broker_account_id = $1`,
      [acct.id]
    );
    const DAY_MS = 86_400_000;
    const lastAt = lastTrade.rows[0]?.last_at ?? null;
    const daysSinceLastTrade = lastAt
      ? Math.floor((Date.now() - new Date(lastAt).getTime()) / DAY_MS)
      : null;
    const accountAgeDays = acct.created_at
      ? Math.floor((Date.now() - new Date(acct.created_at).getTime()) / DAY_MS)
      : null;

    const result = reconcileRules({
      snapshot: {
        cashBalance: info.cashBalance,
        realizedPnl: info.realizedPnL ?? 0,
        equity: info.equity,
      },
      tracked: {
        dayRealizedPnl: num(acct.day_realized_pnl),
        cumulativePnl: num(acct.cumulative_pnl),
        ladderStep: acct.ladder_step ?? 1,
      },
      preset,
      now: new Date(),
      daysSinceLastTrade,
      accountAgeDays,
    });

    await query(
      `INSERT INTO account_rule_checks
         (broker_account_id, preset_id, verdict, broker_balance, broker_realized_pnl,
          broker_equity, tracked_day_pnl, tracked_cum_pnl, implied_start, findings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        acct.id, acct.preset_id, result.verdict,
        info.cashBalance, info.realizedPnL ?? 0, info.equity,
        num(acct.day_realized_pnl), num(acct.cumulative_pnl), result.impliedStart,
        JSON.stringify(result.findings),
      ]
    );

    // Anything that halts trading is a risk event — it needs to reach the
    // operator, not just sit in a check row nobody reads.
    for (const f of result.findings.filter((x) => x.severity === 'halt')) {
      await query(
        `INSERT INTO risk_events (type, rule_type, account_id, message, details, created_at)
         VALUES ('kill_switch', $1, $2, $3, $4, NOW())`,
        [`rule_${f.id}`, acct.id, f.message, JSON.stringify(f.detail ?? {})]
      );
    }

    if (result.verdict === 'halt') {
      log.error('Rule reconciliation HALT', {
        accountId: acct.id, accountName: acct.name,
        findings: result.findings.filter((f) => f.severity === 'halt').map((f) => f.id),
      });
    } else if (result.verdict === 'warn') {
      log.warn('Rule reconciliation warnings', {
        accountId: acct.id, findings: result.findings.map((f) => f.id),
      });
    }

    return { ...base, verdict: result.verdict, findings: result.findings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Rule reconciliation failed', { accountId: acct.id, error: message });
    await query(
      `INSERT INTO account_rule_checks (broker_account_id, preset_id, verdict, error_message)
       VALUES ($1, $2, 'error', $3)`,
      [acct.id, acct.preset_id, message]
    );
    return { ...base, verdict: 'error', findings: [], error: message };
  }
}

/** Reconcile every active account that has a preset assigned. */
export async function reconcileAllAccounts(): Promise<RuleCheckResult[]> {
  const r = await query<{ id: string }>(
    `SELECT id FROM broker_accounts
     WHERE is_active = true AND is_disabled = false AND preset_id IS NOT NULL`
  );
  const results: RuleCheckResult[] = [];
  for (const row of r.rows) {
    results.push(await reconcileAccountRules(row.id));
  }
  const halts = results.filter((x) => x.verdict === 'halt').length;
  log.info('Rule reconciliation sweep complete', { accounts: results.length, halts });
  return results;
}

/** Newest persisted check for an account, or null if none has ever run. */
export async function getLatestRuleCheck(
  accountId: string
): Promise<{ verdict: Verdict | null; checkedAt: Date | null; findings: ReconcileFinding[] } | null> {
  const r = await query<{ verdict: string; checked_at: Date; findings: ReconcileFinding[] }>(
    `SELECT verdict, checked_at, findings
     FROM account_rule_checks
     WHERE broker_account_id = $1 AND verdict <> 'error'
     ORDER BY checked_at DESC
     LIMIT 1`,
    [accountId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    verdict: row.verdict as Verdict,
    checkedAt: row.checked_at,
    findings: row.findings ?? [],
  };
}
