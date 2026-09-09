/**
 * Firm rule catalog.
 *
 * Publishing a version does two things that must not come apart: it rewrites
 * the live preset the executor reads, and it appends the immutable history row
 * describing that change. Both happen in one transaction — a preset carrying
 * numbers no version row explains is unauditable, and a version row describing
 * numbers no account is actually trading is a lie.
 */

import { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import logger from '../utils/logger';

const log = logger.child({ context: 'CatalogService' });

/** Preset columns a catalog version controls. Identity/ownership stays put. */
export const VERSIONED_PRESET_FIELDS = [
  'name', 'prop_firm', 'phase', 'start_balance', 'target_profit', 'max_drawdown',
  'daily_loss_cap', 'base_risk', 'max_contracts', 'dd_mode', 'tp1_r', 'tp2_r',
  'cap_step', 'max_trades_day', 'profit_split', 'step2_mult', 'step3_mult',
  'step4_mult', 'pass_zone_buffer', 'sniper_risk_pct', 'sniper_tp_r',
  'sniper_max_trades_day', 'notes',
  // Rules that vary by firm rather than by how you choose to trade. Anything
  // taken from a firm's rules page belongs here: the catalog is the versioned
  // record of what the firm said, so a field missing from this list is a rule
  // that silently survives a publish unchanged while the page it came from has
  // moved on.
  'daily_loss_cap_source', 'safety_net_buffer', 'consistency_pct',
  'min_trading_days', 'qualifying_day_threshold', 'required_qualifying_days',
  'min_payout', 'payout_schedule', 'scaling_tiers', 'inactivity_alert_days',
  'broker_day_tz', 'broker_day_hour', 'flatten_minute',
] as const;

export type VersionedPresetField = (typeof VERSIONED_PRESET_FIELDS)[number];
export type PresetValues = Partial<Record<VersionedPresetField, unknown>>;

export interface CatalogEntry {
  id: string;
  preset_id: string;
  display_name: string;
  prop_firm: string;
  account_size: number;
  phase: 'eval' | 'funded';
  description: string | null;
  is_published: boolean;
  sort_order: number;
  current_version: number;
}

export interface PublishInput {
  entryId: string;
  presetValues: PresetValues;
  derivedFrom?: Record<string, unknown> | null;
  findings?: unknown[];
  changelog?: string;
  effectiveFrom?: string | null;
  publishedBy?: string | null;
}

export interface PublishResult {
  entryId: string;
  version: number;
  presetId: string;
  changedFields: string[];
}

/** Fields that differ between the live preset and the incoming values. */
function diffFields(current: Record<string, unknown>, next: PresetValues): string[] {
  const changed: string[] = [];
  for (const f of VERSIONED_PRESET_FIELDS) {
    if (next[f] === undefined) continue;
    const a = current[f];
    const b = next[f];
    // Numerics come back from pg as strings; compare by value, not identity,
    // or every publish would report every numeric field as changed.
    const same =
      a === null && b === null
        ? true
        : a === null || b === null
        ? false
        : !isNaN(Number(a)) && !isNaN(Number(b)) && a !== '' && b !== ''
        ? Number(a) === Number(b)
        : String(a) === String(b);
    if (!same) changed.push(f);
  }
  return changed;
}

/**
 * Publish a new version of a catalog entry.
 *
 * Returns the new version number and which fields actually changed. Publishing
 * with no changes still creates a version — re-confirming that a firm's rules
 * are unchanged is itself a fact worth recording with a date on it.
 */
export async function publishVersion(input: PublishInput): Promise<PublishResult> {
  return withTransaction(async (client: PoolClient) => {
    const entryRes = await client.query<CatalogEntry>(
      'SELECT * FROM catalog_entries WHERE id = $1 FOR UPDATE',
      [input.entryId]
    );
    const entry = entryRes.rows[0];
    if (!entry) throw new Error(`Catalog entry '${input.entryId}' not found`);

    const presetRes = await client.query<Record<string, unknown>>(
      'SELECT * FROM presets WHERE id = $1 FOR UPDATE',
      [entry.preset_id]
    );
    const currentPreset = presetRes.rows[0];
    if (!currentPreset) {
      throw new Error(`Preset '${entry.preset_id}' backing entry '${entry.id}' is missing`);
    }

    const changedFields = diffFields(currentPreset, input.presetValues);

    // 1. Rewrite the live preset.
    const cols = VERSIONED_PRESET_FIELDS.filter((f) => input.presetValues[f] !== undefined);
    if (cols.length > 0) {
      const sets = cols.map((f, i) => `${f} = $${i + 1}`);
      const values = cols.map((f) => input.presetValues[f]);
      values.push(entry.preset_id);
      await client.query(
        `UPDATE presets SET ${sets.join(', ')} WHERE id = $${values.length}`,
        values
      );
    }
    if (input.derivedFrom !== undefined) {
      await client.query('UPDATE presets SET derived_from = $2 WHERE id = $1', [
        entry.preset_id,
        input.derivedFrom === null ? null : JSON.stringify(input.derivedFrom),
      ]);
    }

    // 2. Append the history row. The snapshot is what the preset looks like
    //    AFTER the write, so a version always describes a real state.
    const afterRes = await client.query<Record<string, unknown>>(
      'SELECT * FROM presets WHERE id = $1',
      [entry.preset_id]
    );
    const after = afterRes.rows[0];
    const snapshot: Record<string, unknown> = {};
    for (const f of VERSIONED_PRESET_FIELDS) snapshot[f] = after[f];

    const version = entry.current_version + 1;
    await client.query(
      `INSERT INTO catalog_versions
         (entry_id, version, preset_values, derived_from, findings, changelog,
          published_by, effective_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.id, version,
        JSON.stringify(snapshot),
        input.derivedFrom ? JSON.stringify(input.derivedFrom) : null,
        JSON.stringify(input.findings ?? []),
        input.changelog ?? null,
        input.publishedBy ?? null,
        input.effectiveFrom ?? null,
      ]
    );

    await client.query(
      'UPDATE catalog_entries SET current_version = $2, updated_at = NOW() WHERE id = $1',
      [entry.id, version]
    );

    log.info('Catalog version published', {
      entryId: entry.id, version, changedFields,
    });

    return { entryId: entry.id, version, presetId: entry.preset_id, changedFields };
  });
}

/**
 * Assign a catalog entry to a broker account.
 *
 * Sets the account's preset to the entry's live preset and records which
 * version it was assigned at. Resets that account's ladder and broker-day
 * counters — carrying a step earned under different risk numbers forward would
 * size the next trade from a rule set that no longer applies. Touches no other
 * account.
 */
export async function assignCatalogEntry(
  accountId: string,
  entryId: string
): Promise<{ presetId: string; version: number; entryName: string }> {
  return withTransaction(async (client: PoolClient) => {
    const entryRes = await client.query<CatalogEntry>(
      'SELECT * FROM catalog_entries WHERE id = $1',
      [entryId]
    );
    const entry = entryRes.rows[0];
    if (!entry) throw new Error(`Catalog entry '${entryId}' not found`);
    if (!entry.is_published) {
      throw new Error(`Catalog entry '${entryId}' is not published`);
    }

    const open = await client.query<{ id: string }>(
      `SELECT id FROM gb_trades
       WHERE broker_account_id = $1 AND state NOT IN ('closed', 'failed') LIMIT 1`,
      [accountId]
    );
    if (open.rowCount! > 0) {
      throw new Error('Account has an open trade — close it before changing plan');
    }

    const upd = await client.query(
      `UPDATE broker_accounts
       SET preset_id = $2,
           catalog_entry_id = $3,
           catalog_version_at_assign = $4,
           ladder_step = 1,
           day_realized_pnl = 0,
           trades_today = 0,
           london_used = false,
           nyam_used = false,
           nypm_used = false,
           day_locked_out = false,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [accountId, entry.preset_id, entry.id, entry.current_version]
    );
    if (upd.rowCount === 0) throw new Error('Account not found');

    log.info('Catalog entry assigned', { accountId, entryId, version: entry.current_version });
    return {
      presetId: entry.preset_id,
      version: entry.current_version,
      entryName: entry.display_name,
    };
  });
}

/** Entries a customer may choose from. Admins additionally see drafts. */
export async function listCatalog(includeUnpublished: boolean) {
  const result = await query(
    `SELECT ce.*,
            p.start_balance, p.target_profit, p.max_drawdown, p.daily_loss_cap,
            p.base_risk, p.max_contracts, p.dd_mode, p.cap_step, p.max_trades_day,
            p.tp1_r, p.tp2_r, p.profit_split,
            p.verified_at, p.stale_after_days,
            (SELECT COUNT(*) FROM broker_accounts ba WHERE ba.catalog_entry_id = ce.id)::int
              AS accounts_using
     FROM catalog_entries ce
     JOIN presets p ON p.id = ce.preset_id
     ${includeUnpublished ? '' : 'WHERE ce.is_published = true'}
     ORDER BY ce.sort_order, ce.prop_firm, ce.account_size`
  );
  return result.rows;
}

export interface OpenTradeOnEntry extends Record<string, unknown> {
  trade_id: string;
  account_id: string;
  account_name: string;
  symbol: string;
  direction: string;
  state: string;
  step_at_entry: number;
  entry_time: string | null;
}

export interface PublishImpact {
  entryId: string;
  accountsUsing: number;
  openTrades: OpenTradeOnEntry[];
}

/**
 * Who a publish would affect.
 *
 * Open trades keep the tp1_r/tp2_r captured onto their gb_trades row at entry,
 * so a mid-flight trade is not re-priced by a publish. What does change is the
 * account's NEXT trade — and its ladder step was earned under the old risk
 * numbers. That is survivable but it is a judgement call, so the caller has to
 * make it explicitly rather than discover it afterwards.
 */
export async function getPublishImpact(entryId: string): Promise<PublishImpact> {
  const [accounts, trades] = await Promise.all([
    query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM broker_accounts WHERE catalog_entry_id = $1',
      [entryId]
    ),
    query<OpenTradeOnEntry>(
      `SELECT gt.id AS trade_id, ba.id AS account_id, ba.name AS account_name,
              gt.symbol, gt.direction, gt.state, gt.step_at_entry, gt.entry_time
       FROM gb_trades gt
       JOIN broker_accounts ba ON ba.id = gt.broker_account_id
       WHERE ba.catalog_entry_id = $1
         AND gt.state NOT IN ('closed', 'failed')
       ORDER BY ba.name, gt.created_at DESC`,
      [entryId]
    ),
  ]);

  return {
    entryId,
    accountsUsing: parseInt(accounts.rows[0]?.count ?? '0', 10),
    openTrades: trades.rows,
  };
}

/** Version history for one entry, newest first. */
export async function listVersions(entryId: string) {
  const result = await query(
    `SELECT cv.*, u.name AS published_by_name
     FROM catalog_versions cv
     LEFT JOIN users u ON u.id = cv.published_by
     WHERE cv.entry_id = $1
     ORDER BY cv.version DESC`,
    [entryId]
  );
  return result.rows;
}

/**
 * Accounts whose assigned version is behind the entry's current version.
 * They are already trading the new numbers — this reports which accounts had
 * their rules changed under them, which is what an operator needs to know.
 */
export async function listDriftedAccounts() {
  const result = await query(
    `SELECT ba.id, ba.name, ba.catalog_entry_id, ba.catalog_version_at_assign,
            ce.current_version, ce.display_name
     FROM broker_accounts ba
     JOIN catalog_entries ce ON ce.id = ba.catalog_entry_id
     WHERE ba.catalog_version_at_assign IS DISTINCT FROM ce.current_version
     ORDER BY ba.name`
  );
  return result.rows;
}
