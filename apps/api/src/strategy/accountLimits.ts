/**
 * Prop-firm account limits.
 *
 * Firms cap how many funded accounts one person may hold, and the cap is not
 * a single number. Apex allows 20 Performance Accounts and that is the whole
 * rule. Phidias allows 5 CASH Fundamental PLUS 5 CASH Premium PLUS 5 Express
 * to Live, with 150K accounts counting DOUBLE against their category and
 * evaluation accounts not counted at all.
 *
 * Getting this wrong is not a soft failure. Phidias: "Any CASH account beyond
 * this threshold will be considered lost." The account is not refused at
 * purchase, it is forfeited afterwards — so the check has to happen before
 * money is spent, which is why this is a pure function that a UI can call
 * speculatively rather than a constraint discovered at insert time.
 *
 * ONE IMPORTANT THING THIS CANNOT SEE
 *
 * Phidias counts its limits "across all of the user's login credentials, any
 * user account or person residing at the same address, same IP address, etc."
 * A shared server routing many customers' accounts presents as one IP. This
 * module counts what one EdgePilot customer holds; it cannot see what a firm
 * would attribute to a shared connection. `sharedConnectionWarning` exists to
 * keep that visible rather than implied.
 */

export interface AccountCategoryLimit {
  /** Category key as the firm names it, e.g. 'cash_fundamental', 'pa'. */
  category: string;
  /** Human label for messages. */
  label: string;
  /** Maximum weighted count in this category. null = no limit (evaluations). */
  max: number | null;
}

export interface FirmAccountLimits {
  firm: string;
  categories: AccountCategoryLimit[];
  /**
   * Account sizes that consume more than one slot, keyed by size.
   * Phidias: a 150K CASH account counts as two.
   */
  weightBySize?: Record<number, number>;
  /**
   * Extra ceilings that cut ACROSS categories, e.g. Phidias' "max 4 accounts
   * at 150K, of which at most 2 Fundamental and 2 Premium".
   */
  crossLimits?: Array<{
    label: string;
    /** Categories this ceiling spans. */
    categories: string[];
    /** Only accounts of these sizes count toward it. */
    sizes: number[];
    max: number;
    /** Counted in accounts, not weighted slots — the doubling is category-only. */
    weighted?: boolean;
  }>;
  /** True when the firm attributes accounts by address / IP as well as login. */
  countsByConnection?: boolean;
}

export interface HeldAccount {
  category: string;
  /** Account size in dollars, e.g. 50000. */
  size: number;
}

/** Apex: 20 Performance Accounts, no size weighting. */
export const APEX_LIMITS: FirmAccountLimits = {
  firm: 'apex',
  categories: [
    { category: 'pa', label: 'Performance Account', max: 20 },
    { category: 'eval', label: 'Evaluation', max: null },
  ],
};

/** Phidias: 5 + 5 + 5 by category, 150K counts double, evaluations unlimited. */
export const PHIDIAS_LIMITS: FirmAccountLimits = {
  firm: 'phidias',
  categories: [
    { category: 'cash_fundamental', label: 'CASH Fundamental', max: 5 },
    { category: 'cash_premium', label: 'CASH Premium', max: 5 },
    { category: 'e2l', label: 'Express to Live', max: 5 },
    { category: 'eval', label: 'Evaluation', max: null },
  ],
  // A 150K CASH account counts as two standard accounts in its category.
  // E2L is explicitly exempt from the doubling, which the cross-limit below
  // and the category weighting together have to respect.
  weightBySize: { 150_000: 2 },
  crossLimits: [
    {
      label: '150K CASH accounts',
      categories: ['cash_fundamental', 'cash_premium'],
      sizes: [150_000],
      max: 4,
    },
  ],
  countsByConnection: true,
};

const LIMITS_BY_FIRM: Record<string, FirmAccountLimits> = {
  apex: APEX_LIMITS,
  phidias: PHIDIAS_LIMITS,
};

export function limitsForFirm(firm: string): FirmAccountLimits | null {
  return LIMITS_BY_FIRM[firm.toLowerCase()] ?? null;
}

/** Slots one account consumes in its category. */
export function slotWeight(limits: FirmAccountLimits, account: HeldAccount): number {
  // The doubling is a property of CASH accounts; E2L 150K counts as one.
  if (account.category === 'e2l') return 1;
  return limits.weightBySize?.[account.size] ?? 1;
}

export interface CategoryUsage {
  category: string;
  label: string;
  used: number;
  max: number | null;
  remaining: number | null;
}

export interface LimitCheck {
  allowed: boolean;
  usage: CategoryUsage[];
  /** Populated when `allowed` is false. */
  reason?: string;
  /** Always present when the firm counts by shared connection. */
  sharedConnectionWarning?: string;
}

/** Weighted usage per category. */
export function accountUsage(limits: FirmAccountLimits, held: HeldAccount[]): CategoryUsage[] {
  return limits.categories.map((c) => {
    const used = held
      .filter((a) => a.category === c.category)
      .reduce((n, a) => n + slotWeight(limits, a), 0);
    return {
      category: c.category,
      label: c.label,
      used,
      max: c.max,
      remaining: c.max === null ? null : c.max - used,
    };
  });
}

/**
 * Could `adding` be held alongside `held` without breaching the firm's caps?
 *
 * Checked BEFORE purchase. An account bought past the cap is not refunded —
 * at Phidias it is "considered lost".
 */
export function canAddAccount(
  limits: FirmAccountLimits,
  held: HeldAccount[],
  adding: HeldAccount
): LimitCheck {
  const after = [...held, adding];
  const usage = accountUsage(limits, after);

  const sharedConnectionWarning = limits.countsByConnection
    ? `${limits.firm} counts these limits across all logins, and across people at the same ` +
      'address or IP address. Accounts routed through one shared server may be attributed ' +
      'to a single connection regardless of who owns them.'
    : undefined;

  const breached = usage.find((u) => u.max !== null && u.used > u.max);
  if (breached) {
    const weight = slotWeight(limits, adding);
    return {
      allowed: false,
      usage,
      reason:
        `Adding this account would put ${breached.label} at ${breached.used} of ` +
        `${breached.max} allowed` +
        (weight > 1 ? ` (a $${adding.size.toLocaleString()} account counts as ${weight})` : '') +
        '. Buy it and it is over the cap.',
      sharedConnectionWarning,
    };
  }

  for (const cross of limits.crossLimits ?? []) {
    const matching = after.filter(
      (a) => cross.categories.includes(a.category) && cross.sizes.includes(a.size)
    );
    const count = cross.weighted
      ? matching.reduce((n, a) => n + slotWeight(limits, a), 0)
      : matching.length;
    if (count > cross.max) {
      return {
        allowed: false,
        usage,
        reason: `Adding this account would put ${cross.label} at ${count} of ${cross.max} allowed.`,
        sharedConnectionWarning,
      };
    }
  }

  return { allowed: true, usage, sharedConnectionWarning };
}
