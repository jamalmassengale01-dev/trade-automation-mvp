/**
 * Firm rule catalog routes.
 *
 * Customers: browse published entries, assign one to an account they own.
 * They never send a rule value — only an entry id.
 *
 * Admins: create entries, publish versions, read history.
 */

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { requireAdmin } from '../middleware/auth';
import { ownsRow } from '../middleware/ownership';
import {
  listCatalog, listVersions, listDriftedAccounts, getPublishImpact,
  publishVersion, assignCatalogEntry, VERSIONED_PRESET_FIELDS, PresetValues,
} from '../services/catalog';
import { calculatePropFirm, toDerivedFrom, PropFirmInputs } from '../strategy/propFirmMath';
import logger from '../utils/logger';

const router = Router();
const log = logger.child({ context: 'CatalogRoute' });

// Only the account-scoped route takes an account id; guard just that one.
router.param('accountId', ownsRow('broker_accounts'));

/**
 * GET /api/catalog
 * What a customer picks from. Drafts are admin-only — publishing an unverified
 * rule set is the failure this layer exists to prevent.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await listCatalog(req.user?.role === 'admin');
    res.json({ success: true, data: rows });
  } catch (error) {
    log.error('Failed to list catalog', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to list catalog' });
  }
});

/** GET /api/catalog/drift — accounts whose rules changed after assignment. */
router.get('/drift', requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listDriftedAccounts() });
  } catch (error) {
    log.error('Failed to list drift', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to list drift' });
  }
});

/**
 * POST /api/catalog
 * Create an entry. Creates the backing preset too, so an entry can never
 * reference a preset that does not exist.
 */
router.post('/', requireAdmin, async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const id = String(b.id ?? '').trim();
  const displayName = String(b.display_name ?? '').trim();
  const propFirm = String(b.prop_firm ?? '').trim();

  if (!/^[a-z0-9_]+$/.test(id)) {
    res.status(400).json({ success: false, error: 'id must be lowercase letters, numbers, and underscores' });
    return;
  }
  if (!displayName || !propFirm) {
    res.status(400).json({ success: false, error: 'display_name and prop_firm are required' });
    return;
  }
  if (b.phase !== 'eval' && b.phase !== 'funded') {
    res.status(400).json({ success: false, error: "phase must be 'eval' or 'funded'" });
    return;
  }

  let inputs: PropFirmInputs;
  try {
    inputs = { ...(b.inputs ?? {}), phase: b.phase } as PropFirmInputs;
  } catch {
    res.status(400).json({ success: false, error: 'inputs is required' });
    return;
  }

  try {
    const calc = calculatePropFirm(inputs);

    const exists = await query('SELECT id FROM catalog_entries WHERE id = $1', [id]);
    if (exists.rowCount! > 0) {
      res.status(409).json({ success: false, error: `Catalog entry '${id}' already exists` });
      return;
    }
    const presetExists = await query('SELECT id FROM presets WHERE id = $1', [id]);
    if (presetExists.rowCount! > 0) {
      res.status(409).json({ success: false, error: `A preset named '${id}' already exists` });
      return;
    }

    await query(
      `INSERT INTO presets
         (id, name, prop_firm, phase, start_balance, target_profit, max_drawdown,
          daily_loss_cap, base_risk, max_contracts, dd_mode, tp1_r, tp2_r, cap_step,
          max_trades_day, profit_split, step2_mult, step3_mult, step4_mult, derived_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        id, displayName, propFirm, calc.preset.phase, calc.preset.start_balance,
        calc.preset.target_profit, calc.preset.max_drawdown, calc.preset.daily_loss_cap,
        calc.preset.base_risk, calc.preset.max_contracts, calc.preset.dd_mode,
        calc.preset.tp1_r, calc.preset.tp2_r, calc.preset.cap_step,
        calc.preset.max_trades_day, calc.preset.profit_split,
        calc.preset.step2_mult, calc.preset.step3_mult, calc.preset.step4_mult,
        JSON.stringify(toDerivedFrom(calc)),
      ]
    );

    const entry = await query(
      `INSERT INTO catalog_entries
         (id, preset_id, display_name, prop_firm, account_size, phase, description,
          is_published, sort_order, current_version)
       VALUES ($1,$1,$2,$3,$4,$5,$6,false,$7,1) RETURNING *`,
      [
        id, displayName, propFirm, Math.round(calc.preset.start_balance),
        calc.preset.phase, b.description ?? null, b.sort_order ?? 100,
      ]
    );

    const snapshot: Record<string, unknown> = {};
    const presetAsRecord = calc.preset as unknown as Record<string, unknown>;
    for (const f of VERSIONED_PRESET_FIELDS) snapshot[f] = presetAsRecord[f];
    snapshot.name = displayName;
    snapshot.prop_firm = propFirm;

    await query(
      `INSERT INTO catalog_versions
         (entry_id, version, preset_values, derived_from, findings, changelog, published_by)
       VALUES ($1, 1, $2, $3, $4, $5, $6)`,
      [
        id, JSON.stringify(snapshot), JSON.stringify(toDerivedFrom(calc)),
        JSON.stringify(calc.findings), b.changelog ?? 'Initial version.', req.user?.id ?? null,
      ]
    );

    log.info('Catalog entry created', { id, by: req.user?.id });
    res.status(201).json({
      success: true,
      data: { entry: entry.rows[0], findings: calc.findings, rules: { baseRisk: calc.rules.baseRisk } },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to create catalog entry', { id, error: message });
    res.status(400).json({ success: false, error: message });
  }
});

/** PATCH /api/catalog/:id — entry metadata and publish state, not rule values. */
router.patch('/:id', requireAdmin, async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (b.display_name !== undefined) { sets.push(`display_name = $${i++}`); params.push(String(b.display_name)); }
  if (b.description !== undefined) { sets.push(`description = $${i++}`); params.push(b.description); }
  if (b.sort_order !== undefined) { sets.push(`sort_order = $${i++}`); params.push(Number(b.sort_order)); }
  if (b.is_published !== undefined) { sets.push(`is_published = $${i++}`); params.push(!!b.is_published); }

  if (sets.length === 0) {
    res.status(400).json({ success: false, error: 'No updatable fields provided' });
    return;
  }

  try {
    // Publishing an entry whose rules were never verified against the firm is
    // exactly the mistake this layer exists to catch.
    if (b.is_published === true) {
      const v = await query<{ verified_at: Date | null }>(
        `SELECT p.verified_at FROM catalog_entries ce
         JOIN presets p ON p.id = ce.preset_id WHERE ce.id = $1`,
        [req.params.id]
      );
      if (v.rowCount === 0) {
        res.status(404).json({ success: false, error: 'Catalog entry not found' });
        return;
      }
      if (!v.rows[0].verified_at) {
        res.status(400).json({
          success: false,
          error: 'Verify this entry\'s rules against the firm\'s published terms before publishing it to customers.',
        });
        return;
      }
    }

    params.push(req.params.id);
    const result = await query(
      `UPDATE catalog_entries SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${i} RETURNING *`,
      params
    );
    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'Catalog entry not found' });
      return;
    }
    log.info('Catalog entry updated', { id: req.params.id, fields: sets.length });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    log.error('Failed to update catalog entry', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to update catalog entry' });
  }
});

/**
 * GET /api/catalog/:id/impact
 * What publishing new numbers for this entry would touch: how many accounts
 * run it, and which have a trade in flight right now. Read-only preflight so
 * the decision is visible before the change is composed, not after it lands.
 */
router.get('/:id/impact', requireAdmin, async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getPublishImpact(req.params.id) });
  } catch (error) {
    log.error('Failed to load publish impact', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to load publish impact' });
  }
});

/**
 * POST /api/catalog/:id/versions
 * Publish new numbers for an entry. Accepts either raw calculator `inputs`
 * (preferred — keeps the derivation on record) or explicit `preset_values`.
 */
router.post('/:id/versions', requireAdmin, async (req: Request, res: Response) => {
  const b = req.body ?? {};
  try {
    let presetValues: PresetValues;
    let derivedFrom: Record<string, unknown> | null = null;
    let findings: unknown[] = [];

    if (b.inputs) {
      const calc = calculatePropFirm(b.inputs as PropFirmInputs);
      presetValues = calc.preset as PresetValues;
      derivedFrom = toDerivedFrom(calc);
      findings = calc.findings;
    } else if (b.preset_values) {
      presetValues = b.preset_values as PresetValues;
    } else {
      res.status(400).json({ success: false, error: 'Provide either inputs or preset_values' });
      return;
    }

    // Trades already in flight keep the tp1_r/tp2_r captured onto their row at
    // entry, so they are not re-priced. What changes is each account's NEXT
    // trade, sized from new risk numbers while carrying a ladder step earned
    // under the old ones. Survivable, but a judgement call — so it is refused
    // until the caller says so explicitly. Enforced here rather than in the UI:
    // a confirmation the API does not require is decoration.
    const impact = await getPublishImpact(req.params.id);
    if (impact.openTrades.length > 0 && b.acknowledge_open_trades !== true) {
      res.status(409).json({
        success: false,
        error:
          `${impact.openTrades.length} trade(s) are open on accounts running this plan. ` +
          `Open trades keep their own exit levels, but each account's next trade will use the ` +
          `new numbers. Re-send with acknowledge_open_trades to proceed.`,
        data: { requiresAcknowledgement: true, impact },
      });
      return;
    }

    const result = await publishVersion({
      entryId: req.params.id,
      presetValues,
      derivedFrom,
      findings,
      changelog: b.changelog,
      effectiveFrom: b.effective_from ?? null,
      publishedBy: req.user?.id ?? null,
    });

    // Publishing a version IS the verification act: the admin is asserting
    // these are the firm's current rules, and the version row records who and
    // when. Clearing verified_at instead would leave the entry published-but-
    // unverified — the exact state the publish interlock refuses to create —
    // and would make every rule update need a redundant second click.
    await query(
      `UPDATE presets SET verified_at = NOW(), verified_by = $2 WHERE id = $1`,
      [result.presetId, req.user?.email ?? 'admin']
    );

    if (impact.openTrades.length > 0) {
      log.warn('Version published while trades were in flight', {
        entryId: req.params.id, version: result.version,
        openTrades: impact.openTrades.length, by: req.user?.id,
      });
    }

    res.status(201).json({
      success: true,
      data: { ...result, findings, publishedWithOpenTrades: impact.openTrades.length },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to publish version', { id: req.params.id, error: message });
    res.status(400).json({ success: false, error: message });
  }
});

/** GET /api/catalog/:id/versions — history. */
router.get('/:id/versions', requireAdmin, async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listVersions(req.params.id) });
  } catch (error) {
    log.error('Failed to list versions', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to list versions' });
  }
});

/**
 * POST /api/catalog/assign/:accountId
 * The whole customer-facing flow: pick an entry, apply it to your account.
 * Ownership of :accountId is enforced by the router.param guard above.
 */
router.post('/assign/:accountId', async (req: Request, res: Response) => {
  const entryId = String(req.body?.entry_id ?? '');
  if (!entryId) {
    res.status(400).json({ success: false, error: 'entry_id is required' });
    return;
  }
  try {
    const result = await assignCatalogEntry(req.params.accountId, entryId);
    res.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Catalog assignment refused', { accountId: req.params.accountId, entryId, error: message });
    res.status(400).json({ success: false, error: message });
  }
});

export default router;
