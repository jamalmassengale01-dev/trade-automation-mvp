/**
 * Per-customer prop-firm account limits, against real holdings.
 *
 * The pure rules live in strategy/accountLimits.ts. This reads what a customer
 * actually holds and asks whether one more would breach the firm's cap.
 *
 * Counted per USER, not globally, because the cap is a property of the person
 * holding the accounts. That is also why it is not enough on its own: Phidias
 * counts "per person, company OR Internet connection … same address, same IP",
 * so a shared EdgePilot host could be attributed the accounts of every customer
 * routed through it. Nothing here can see that, and canAddAccount returns
 * sharedConnectionWarning rather than letting the check imply it has.
 *
 * Accounts with no category — mock brokers, the generic copier path — are not
 * counted. Being uncounted is the safe direction: it can never wrongly block a
 * purchase the firm would have allowed.
 */

import { query } from '../db';
import {
  canAddAccount, accountUsage, limitsForFirm,
  HeldAccount, LimitCheck, CategoryUsage,
} from '../strategy/accountLimits';

export interface AddAccountRequest {
  userId: string;
  propFirm: string;
  category: string;
  size: number;
}

/** Every counted account this user holds at one firm. */
export async function heldAccounts(userId: string, propFirm: string): Promise<HeldAccount[]> {
  const r = await query<{ account_category: string; account_size: number | null }>(
    `SELECT ba.account_category, ba.account_size
     FROM broker_accounts ba
     LEFT JOIN presets p ON p.id = ba.preset_id
     WHERE ba.user_id = $1
       AND ba.account_category IS NOT NULL
       AND ba.is_active = true
       AND LOWER(COALESCE(p.prop_firm, '')) = LOWER($2)`,
    [userId, propFirm]
  );
  return r.rows.map((row) => ({
    category: row.account_category,
    // A missing size cannot weight correctly, so it counts as one slot rather
    // than zero — undercounting would let a cap be exceeded silently.
    size: row.account_size ?? 0,
  }));
}

export interface AddAccountVerdict extends LimitCheck {
  /** Null when the firm has no modelled limits — the check is then advisory. */
  firmKnown: boolean;
}

/**
 * May this user add one more account at this firm?
 *
 * An unknown firm is allowed rather than refused. Blocking a purchase because
 * EdgePilot has not modelled a firm's rules yet would be the software asserting
 * a limit that does not exist.
 */
export async function checkCanAddAccount(req: AddAccountRequest): Promise<AddAccountVerdict> {
  const limits = limitsForFirm(req.propFirm);
  if (!limits) {
    return { allowed: true, usage: [], firmKnown: false };
  }
  const held = await heldAccounts(req.userId, req.propFirm);
  const check = canAddAccount(limits, held, { category: req.category, size: req.size });
  return { ...check, firmKnown: true };
}

/** Current usage per category, for the dashboard. */
export async function usageForFirm(userId: string, propFirm: string): Promise<CategoryUsage[]> {
  const limits = limitsForFirm(propFirm);
  if (!limits) return [];
  return accountUsage(limits, await heldAccounts(userId, propFirm));
}
