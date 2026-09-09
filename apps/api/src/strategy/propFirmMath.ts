/**
 * Prop firm math calculator.
 *
 * Takes the raw numbers off a prop firm's rulebook page (target, max DD, daily
 * DD, min trading days, consistency %) plus how you intend to trade it, and
 * derives every field the executor needs — plus the feasibility checks that are
 * invisible when you hand-enter a preset.
 *
 * Two classes of output, deliberately kept apart:
 *
 *   RULES       — arithmetic on the firm's own numbers. Exact and verifiable.
 *                 Payout thresholds, DLL headroom, contract counts, which ladder
 *                 steps can physically fire inside one broker day.
 *
 *   PROJECTIONS — downstream of an assumed win rate, which is NOT validated from
 *                 live data. Directional only. Never present these as guarantees;
 *                 the sensitivity band exists so the assumption stays visible.
 *
 * This module is pure: no db, no io, no clock. It is the single source of truth
 * for how a preset is derived, so re-deriving after a firm changes its rules is
 * a one-input edit rather than an archaeology exercise.
 */

import { StepMultipliers, DEFAULT_STEP_MULTIPLIERS, MAX_STEP, clampStep } from './ladder';
import { contractsFor, splitGroups } from './sizing';
import { getInstrument, InstrumentSpec } from './instruments';

export type DdMode = 'eod_trailing' | 'intraday_trailing' | 'static_fixed';
export type Phase = 'eval' | 'funded';
export type RiskRounding = 'ceil' | 'floor' | 'nearest';

/** Who enforces the daily loss cap — see PropFirmInputs.dailyLossCapSource. */
export type DailyLossCapSource = 'firm' | 'internal';

/**
 * Default self-imposed daily cap when a firm imposes none, as a fraction of
 * max drawdown.
 *
 * Half is the Apex ratio ($1,000 of $2,000), so the ladder behaves the way it
 * was designed to: base risk = cap / 3 means two full losses fit inside a day
 * and the third step is refused. That refusal is the ladder's brake. Without a
 * daily cap of some kind there is no brake — 1/1/2/4 on a $2,500 drawdown runs
 * to $2,672 across four losses and ends the account inside one session.
 */
export const DEFAULT_INTERNAL_DLL_FRACTION = 0.5;

/** A self-imposed daily cap for a firm that publishes none. */
export function suggestInternalDailyLossCap(
  maxDrawdown: number,
  fraction = DEFAULT_INTERNAL_DLL_FRACTION
): number {
  return round2(maxDrawdown * fraction);
}

export interface PropFirmInputs {
  // ---- straight off the firm's rulebook ----
  startBalance: number;
  targetProfit: number;
  maxDrawdown: number;
  /**
   * Daily loss cap. Pass 0 when the firm imposes none (Phidias, for one) and
   * set `dailyLossCapSource: 'internal'` with the cap you choose to impose on
   * yourself — see the type below for why that distinction is not cosmetic.
   */
  dailyLossCap: number;
  /**
   * Who enforces the daily loss cap.
   *
   * 'firm'     — the prop firm enforces it. If our accounting drifts, the firm
   *              flattens the account. External enforcement backstops our bugs.
   * 'internal' — WE are the only enforcement. A firm with no daily limit will
   *              happily let the ladder run to account death in one session, so
   *              a drift in day-P&L tracking does not produce a rejected order,
   *              it produces no limit at all.
   *
   * The arithmetic is identical either way. The consequences of being wrong
   * are not, which is why this is recorded rather than inferred.
   */
  dailyLossCapSource?: DailyLossCapSource;
  ddMode: DdMode;
  phase: Phase;
  maxContracts: number;
  /** Firm's minimum trading days before a pass / payout can be claimed. */
  minTradingDays?: number;
  /**
   * Calendar days an evaluation stays active before it expires, if the firm
   * imposes one. Apex EOD evals are 30 days with no resets, which makes a slow
   * pass a total loss of the eval fee rather than merely a slow one.
   * 0 or undefined = no expiry.
   */
  evalExpiryDays?: number;
  /** e.g. 50 => no single day may be >= 50% of profit since last payout. 0 disables. */
  consistencyPct?: number;
  /** Funded only: smallest payout the firm will process. */
  minPayout?: number;
  /** Funded only: cushion above the DD floor the firm requires you to leave. */
  safetyNetBuffer?: number;
  /** 1.0 = 100% to trader. */
  profitSplit?: number;

  // ---- how you choose to trade it ----
  /** base risk = dailyLossCap / riskDivisor. Default 3 (the GB LIVE convention). */
  riskDivisor?: number;
  riskRounding?: RiskRounding;
  /** Skip the divisor and pin base risk directly (e.g. the $500 Eval Rush). */
  baseRiskOverride?: number;
  stepMultipliers?: StepMultipliers;
  capStep?: number;
  maxTradesDay?: number;
  tp1R?: number;
  tp2R?: number;

  // ---- sizing context ----
  symbol?: string;
  /** Representative stop distance in points, for contract-count math. */
  typicalStopPts?: number;

  // ---- projections only ----
  /** 0..1. UNVALIDATED assumption — drives the projections block only. */
  assumedWinRate?: number;
  /** Average signals actually filled per trading day. */
  tradesPerDay?: number;
}

export interface LadderRung {
  step: number;
  multiplier: number;
  /** baseRisk x multiplier, capped at the daily loss cap. What the gate compares. */
  nominalRisk: number;
  /** Contracts after integer floor and the account's contract cap. */
  contracts: number;
  /** Contracts before the cap was applied — reveals when the cap binds. */
  uncappedContracts: number;
  /** contracts x stopPts x pointValue: what you actually lose if it stops out. */
  actualRisk: number;
  /** Could this step fire at all, given DLL already consumed by earlier steps today? */
  reachableSameDay: boolean;
  /** DLL room remaining when this step would be taken. */
  dllRoomBefore: number;
  contractCapBinds: boolean;
}

export interface PropFirmRules {
  baseRisk: number;
  /** Sum of every step's nominal risk, ignoring the DLL gate. */
  fullLadderNominalRisk: number;
  /** Deepest step that can physically fire within a single broker day. */
  maxReachableStep: number;
  /** Actual dollars lost if you run the ladder until the DLL gate stops you. */
  worstCaseDayLoss: number;
  /** Consecutive maximum-loss days before max drawdown is breached. */
  survivableMaxLossDays: number;
  ladder: LadderRung[];

  /** Balance at which the trailing DD floor sits once fully trailed. */
  safetyNetBalance: number | null;
  /** Minimum balance required to request a payout (funded only). */
  minBalanceForPayout: number | null;
  /** Balance that clears the profit target. */
  targetBalance: number;

  /** Largest compliant single day once you've made exactly the target. */
  maxCompliantDayAtTarget: number | null;
  /** Total profit needed before a day of this size stops blocking a payout. */
  minTotalProfitForDay: ((dayPnl: number) => number) | null;

  /** Weighted R gained when both TP legs fill, using the real group split. */
  avgWinR: number;
  /** R when TP1 fills and the runner is stopped at breakeven. */
  partialWinR: number;
  /** Win rate at which a pure win/loss series breaks even. Ignores partials. */
  breakevenWinRate: number;

  instrument: InstrumentSpec;
  typicalStopPts: number;
}

export interface ProjectionRow {
  winRate: number;
  expectancyR: number;
  expectedPerTrade: number;
  expectedPerDay: number;
  /** Trading days to reach the profit target. null when expectancy <= 0. */
  daysToTarget: number | null;
}

export interface PropFirmProjections {
  assumedWinRate: number;
  tradesPerDay: number;
  base: ProjectionRow;
  /** Same math across a band of win rates, so the assumption stays visible. */
  sensitivity: ProjectionRow[];
  /** max(firm's minimum trading days, projected days to target). */
  bindingDaysToPass: number | null;
  /** Trading days available before the eval expires, or null if no expiry. */
  tradingDaysBeforeExpiry: number | null;
  caveat: string;
}

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface Finding {
  id: string;
  severity: FindingSeverity;
  message: string;
}

/** Fields shaped for a direct write to the presets table. */
export interface DerivedPresetFields {
  start_balance: number;
  target_profit: number;
  max_drawdown: number;
  daily_loss_cap: number;
  base_risk: number;
  max_contracts: number;
  dd_mode: DdMode;
  phase: Phase;
  tp1_r: number;
  tp2_r: number;
  cap_step: number;
  max_trades_day: number;
  profit_split: number;
  step2_mult: number;
  step3_mult: number;
  step4_mult: number;
}

export interface PropFirmCalcResult {
  inputs: Required<
    Pick<
      PropFirmInputs,
      | 'startBalance' | 'targetProfit' | 'maxDrawdown' | 'dailyLossCap' | 'ddMode'
      | 'phase' | 'maxContracts' | 'minTradingDays' | 'evalExpiryDays' | 'consistencyPct' | 'minPayout'
      | 'safetyNetBuffer' | 'profitSplit' | 'riskDivisor' | 'riskRounding' | 'capStep'
      | 'maxTradesDay' | 'tp1R' | 'tp2R' | 'symbol' | 'typicalStopPts'
      | 'assumedWinRate' | 'tradesPerDay'
    >
  > & { stepMultipliers: StepMultipliers };
  rules: PropFirmRules;
  projections: PropFirmProjections;
  findings: Finding[];
  preset: DerivedPresetFields;
}

const DEFAULTS = {
  minTradingDays: 0,
  evalExpiryDays: 0,
  consistencyPct: 50,
  minPayout: 0,
  safetyNetBuffer: 0,
  profitSplit: 1,
  riskDivisor: 3,
  riskRounding: 'ceil' as RiskRounding,
  capStep: 3,
  maxTradesDay: 3,
  tp1R: 0.5,
  tp2R: 2.0,
  symbol: 'MNQ',
  typicalStopPts: 15,
  assumedWinRate: 0.6,
  tradesPerDay: 1.5,
};

const EPS = 1e-9;

function round2(v: number): number {
  return Number(v.toFixed(2));
}

function applyRounding(v: number, mode: RiskRounding): number {
  if (mode === 'floor') return Math.floor(v);
  if (mode === 'nearest') return Math.round(v);
  return Math.ceil(v);
}

function multiplierFor(step: number, m: StepMultipliers): number {
  switch (step) {
    case 1: return 1;
    case 2: return m.step2;
    case 3: return m.step3;
    default: return m.step4;
  }
}

/**
 * Derive a full preset plus feasibility findings from a prop firm's raw rules.
 *
 * Throws only on inputs that make the math meaningless (non-positive balance,
 * DLL, or contract cap). Everything else that is merely unwise is reported as a
 * finding so the caller can show it rather than fail.
 */
export function calculatePropFirm(input: PropFirmInputs): PropFirmCalcResult {
  const startBalance = Number(input.startBalance);
  const targetProfit = Number(input.targetProfit ?? 0);
  const maxDrawdown = Number(input.maxDrawdown);
  const dailyLossCap = Number(input.dailyLossCap);
  const dailyLossCapSource: DailyLossCapSource = input.dailyLossCapSource ?? 'firm';
  const maxContracts = Math.floor(Number(input.maxContracts));

  if (!Number.isFinite(startBalance) || startBalance <= 0) {
    throw new Error('startBalance must be a positive number');
  }
  if (!Number.isFinite(maxDrawdown) || maxDrawdown <= 0) {
    throw new Error('maxDrawdown must be a positive number');
  }
  // A cap of zero is not an error when the firm publishes none — it means the
  // preset has not yet chosen the self-imposed one it needs. Say that, rather
  // than "must be a positive number", which sends someone looking for a rule
  // the firm does not have.
  if (!Number.isFinite(dailyLossCap) || dailyLossCap <= 0) {
    throw new Error(
      dailyLossCapSource === 'internal'
        ? 'dailyLossCap must be a positive number. This firm publishes no daily limit, so ' +
          `you must set one: $${suggestInternalDailyLossCap(maxDrawdown)} (half the max ` +
          'drawdown) matches the ratio the ladder was designed against.'
        : 'dailyLossCap must be a positive number'
    );
  }
  if (!Number.isFinite(maxContracts) || maxContracts <= 0) {
    throw new Error('maxContracts must be a positive integer');
  }

  const minTradingDays = Number(input.minTradingDays ?? DEFAULTS.minTradingDays);
  const evalExpiryDays = Number(input.evalExpiryDays ?? DEFAULTS.evalExpiryDays);
  const consistencyPct = Number(input.consistencyPct ?? DEFAULTS.consistencyPct);
  const minPayout = Number(input.minPayout ?? DEFAULTS.minPayout);
  const safetyNetBuffer = Number(input.safetyNetBuffer ?? DEFAULTS.safetyNetBuffer);
  const profitSplit = Number(input.profitSplit ?? DEFAULTS.profitSplit);
  const riskDivisor = Number(input.riskDivisor ?? DEFAULTS.riskDivisor);
  const riskRounding = input.riskRounding ?? DEFAULTS.riskRounding;
  const capStep = clampStep(Number(input.capStep ?? DEFAULTS.capStep), MAX_STEP);
  const maxTradesDay = Math.max(1, Math.floor(Number(input.maxTradesDay ?? DEFAULTS.maxTradesDay)));
  const tp1R = Number(input.tp1R ?? DEFAULTS.tp1R);
  const tp2R = Number(input.tp2R ?? DEFAULTS.tp2R);
  const symbol = input.symbol ?? DEFAULTS.symbol;
  const typicalStopPts = Number(input.typicalStopPts ?? DEFAULTS.typicalStopPts);
  const assumedWinRate = Number(input.assumedWinRate ?? DEFAULTS.assumedWinRate);
  const tradesPerDay = Number(input.tradesPerDay ?? DEFAULTS.tradesPerDay);
  const stepMultipliers = input.stepMultipliers ?? DEFAULT_STEP_MULTIPLIERS;
  const phase = input.phase;
  const ddMode = input.ddMode;

  const instrument = getInstrument(symbol);
  if (!instrument) throw new Error(`Unknown instrument for symbol ${symbol}`);
  if (!Number.isFinite(typicalStopPts) || typicalStopPts <= 0) {
    throw new Error('typicalStopPts must be a positive number');
  }
  if (riskDivisor <= 0) throw new Error('riskDivisor must be greater than zero');

  const findings: Finding[] = [];

  // ---------------------------------------------------------------
  // Base risk
  // ---------------------------------------------------------------
  const rawBaseRisk =
    input.baseRiskOverride !== undefined && input.baseRiskOverride !== null
      ? Number(input.baseRiskOverride)
      : dailyLossCap / riskDivisor;
  if (!Number.isFinite(rawBaseRisk) || rawBaseRisk <= 0) {
    throw new Error('base risk resolved to a non-positive number');
  }
  const baseRisk = applyRounding(rawBaseRisk, riskRounding);

  if (baseRisk * riskDivisor > dailyLossCap + EPS) {
    findings.push({
      id: 'base_risk_overshoots_dll',
      severity: 'info',
      message:
        `Rounding base risk ${riskRounding} puts ${riskDivisor} full losses at ` +
        `$${round2(baseRisk * riskDivisor)}, which is $${round2(baseRisk * riskDivisor - dailyLossCap)} ` +
        `over the $${dailyLossCap} daily loss cap. The DLL gate will block the last one.`,
    });
  }

  // ---------------------------------------------------------------
  // Ladder walk — nominal risk drives the gate, actual risk drives P&L
  // ---------------------------------------------------------------
  const ladder: LadderRung[] = [];
  let consumedDll = 0;
  let maxReachableStep = 0;
  let worstCaseDayLoss = 0;
  let fullLadderNominalRisk = 0;
  let capBindsAtStep: number | null = null;

  for (let step = 1; step <= capStep; step++) {
    const multiplier = multiplierFor(step, stepMultipliers);
    const nominalRisk = round2(Math.min(baseRisk * multiplier, dailyLossCap));
    fullLadderNominalRisk += nominalRisk;

    const uncappedContracts = Math.floor(nominalRisk / (typicalStopPts * instrument.pointValue));
    const contracts = contractsFor(nominalRisk, typicalStopPts, instrument.pointValue, maxContracts);
    const actualRisk = round2(contracts * typicalStopPts * instrument.pointValue);
    const contractCapBinds = uncappedContracts > maxContracts;
    if (contractCapBinds && capBindsAtStep === null) capBindsAtStep = step;

    // The gate compares the step's nominal risk against remaining DLL room.
    const dllRoomBefore = round2(dailyLossCap - consumedDll);
    const reachableSameDay = maxReachableStep === step - 1 && nominalRisk <= dllRoomBefore + EPS;

    if (reachableSameDay) {
      maxReachableStep = step;
      consumedDll += actualRisk;
      worstCaseDayLoss += actualRisk;
    }

    ladder.push({
      step,
      multiplier,
      nominalRisk,
      contracts,
      uncappedContracts,
      actualRisk,
      reachableSameDay,
      dllRoomBefore,
      contractCapBinds,
    });
  }

  fullLadderNominalRisk = round2(fullLadderNominalRisk);
  worstCaseDayLoss = round2(worstCaseDayLoss);

  // ---------------------------------------------------------------
  // Drawdown survivability
  // ---------------------------------------------------------------
  const survivableMaxLossDays =
    worstCaseDayLoss > 0 ? round2(maxDrawdown / worstCaseDayLoss) : Infinity;

  // ---------------------------------------------------------------
  // Payout / target balances
  // ---------------------------------------------------------------
  const targetBalance = round2(startBalance + targetProfit);
  const safetyNetBalance =
    phase === 'funded' ? round2(startBalance + maxDrawdown + safetyNetBuffer) : null;
  const minBalanceForPayout =
    phase === 'funded' && safetyNetBalance !== null ? round2(safetyNetBalance + minPayout) : null;

  // ---------------------------------------------------------------
  // Consistency rule
  // ---------------------------------------------------------------
  const consistencyFrac = consistencyPct > 0 ? consistencyPct / 100 : 0;
  const maxCompliantDayAtTarget =
    consistencyFrac > 0 && targetProfit > 0 ? round2(targetProfit * consistencyFrac) : null;
  const minTotalProfitForDay =
    consistencyFrac > 0 ? (dayPnl: number) => round2(dayPnl / consistencyFrac) : null;

  // ---------------------------------------------------------------
  // Expectancy shape, using the real group split at step 1
  // ---------------------------------------------------------------
  const step1Contracts = ladder[0]?.contracts ?? 0;
  const { g1, g2 } = splitGroups(step1Contracts);
  const totalQty = g1 + g2;
  const avgWinR = totalQty > 0 ? round2((tp1R * g1 + tp2R * g2) / totalQty) : round2((tp1R + tp2R) / 2);
  const partialWinR = totalQty > 0 ? round2((tp1R * g1) / totalQty) : 0;
  const breakevenWinRate = round2(1 / (1 + avgWinR));

  // ---------------------------------------------------------------
  // Findings
  // ---------------------------------------------------------------
  if (step1Contracts === 0) {
    findings.push({
      id: 'size_zero',
      severity: 'error',
      message:
        `A ${typicalStopPts}pt stop on ${instrument.root} costs ` +
        `$${round2(typicalStopPts * instrument.pointValue)} per contract, more than the ` +
        `$${baseRisk} step-1 risk. Every signal would size to zero contracts and be rejected.`,
    });
  }

  if (dailyLossCap >= maxDrawdown - EPS) {
    findings.push({
      id: 'dll_exceeds_maxdd',
      severity: 'error',
      message:
        `Daily loss cap ($${dailyLossCap}) is not below max drawdown ($${maxDrawdown}), so a ` +
        `single full-cap day can blow the account. The daily cap gives no protection here.`,
    });
  }

  // A self-imposed cap is a policy, not a rule. Every number above is computed
  // the same way, so nothing here is a defect — but the failure mode changes
  // completely and that has to be visible on the preset, not buried in a doc.
  if (dailyLossCapSource === 'internal') {
    findings.push({
      id: 'dll_self_enforced',
      severity: 'warning',
      message:
        `The $${dailyLossCap} daily cap is self-imposed — this firm publishes none. It is ` +
        'enforced only by EdgePilot, so a drift in day-P&L tracking does not get an order ' +
        'rejected, it removes the limit entirely. The trailing drawdown floor is the only ' +
        'backstop underneath it and must stay enabled on this account.',
    });

    const suggested = suggestInternalDailyLossCap(maxDrawdown);
    if (dailyLossCap > suggested + EPS) {
      findings.push({
        id: 'internal_dll_above_suggested',
        severity: 'warning',
        message:
          `A self-imposed cap of $${dailyLossCap} is above the $${suggested} suggested for a ` +
          `$${maxDrawdown} drawdown (half). With nothing but our own accounting between the ` +
          'ladder and the floor, a looser cap buys less than it costs.',
      });
    }
  }

  if (maxReachableStep < capStep) {
    const blocked = ladder.find((r) => !r.reachableSameDay);
    findings.push({
      id: 'ladder_unreachable',
      severity: 'warning',
      message:
        `Only steps 1-${maxReachableStep} can fire in one broker day. Step ${blocked?.step} needs ` +
        `$${blocked?.nominalRisk} but only $${blocked?.dllRoomBefore} of daily loss room is left ` +
        `by then, so the DLL gate blocks it. Cap step is set to ${capStep}.`,
    });
  }

  if (capBindsAtStep !== null) {
    const rung = ladder[capBindsAtStep - 1];
    findings.push({
      id: 'contract_cap_binds',
      severity: 'warning',
      message:
        `At step ${capBindsAtStep} the ${typicalStopPts}pt stop wants ${rung.uncappedContracts} ` +
        `contracts but the account caps at ${maxContracts}. Real risk there is $${rung.actualRisk}, ` +
        `not the intended $${rung.nominalRisk} — the ladder silently stops scaling.`,
    });
  }

  if (Number.isFinite(survivableMaxLossDays) && survivableMaxLossDays < 2) {
    findings.push({
      id: 'thin_dd_buffer',
      severity: 'warning',
      message:
        `Max drawdown absorbs only ${survivableMaxLossDays} worst-case day(s) ` +
        `($${worstCaseDayLoss} each). Two bad days end the account.`,
    });
  }

  if (targetProfit > 0 && maxDrawdown > 0 && targetProfit / maxDrawdown > 2) {
    findings.push({
      id: 'target_far_vs_dd',
      severity: 'info',
      message:
        `Target ($${targetProfit}) is ${round2(targetProfit / maxDrawdown)}x the drawdown ` +
        `($${maxDrawdown}). Long grind with little room for variance.`,
    });
  }

  if (phase === 'funded' && minPayout > 0 && targetProfit > 0 && targetProfit < minPayout) {
    findings.push({
      id: 'target_below_min_payout',
      severity: 'warning',
      message:
        `Target profit ($${targetProfit}) is below the firm's minimum payout ($${minPayout}). ` +
        `Hitting target would not yet allow a withdrawal.`,
    });
  }

  if (consistencyFrac > 0 && targetProfit > 0) {
    // Best realistic single day: every allowed trade wins outright at step-1 size.
    const bestCaseDay = round2(maxTradesDay * (ladder[0]?.actualRisk ?? baseRisk) * avgWinR);
    const requiredTotal = round2(bestCaseDay / consistencyFrac);
    if (requiredTotal > targetProfit) {
      findings.push({
        id: 'consistency_may_block',
        severity: 'info',
        message:
          `A best-case day (${maxTradesDay} wins at step 1) makes ~$${bestCaseDay}. The ` +
          `${consistencyPct}% consistency rule then requires $${requiredTotal} total profit before ` +
          `that day stops blocking a payout — more than the $${targetProfit} target.`,
      });
    }
  }

  if (minTradingDays <= 0) {
    findings.push({
      id: 'min_days_unset',
      severity: 'info',
      message:
        'No minimum trading-day requirement set. Confirm against the firm\'s account page — ' +
        'some impose one and some do not (Apex EOD evaluations are 1 day), so this is worth ' +
        'reading rather than assuming.',
    });
  }

  if (ddMode === 'intraday_trailing') {
    findings.push({
      id: 'intraday_trailing_dd',
      severity: 'warning',
      message:
        'Intraday trailing drawdown trails your unrealized peak, so an open runner that gives ' +
        'back profit can breach the floor even on a winning trade. Size more conservatively than ' +
        'the EOD math above suggests.',
    });
  }

  // ---------------------------------------------------------------
  // Projections — assumption-driven, kept separate on purpose
  // ---------------------------------------------------------------
  const projectFor = (winRate: number): ProjectionRow => {
    const expectancyR = round2(winRate * avgWinR - (1 - winRate) * 1);
    const expectedPerTrade = round2(expectancyR * baseRisk * profitSplit);
    const expectedPerDay = round2(expectedPerTrade * tradesPerDay);
    const daysToTarget =
      expectedPerDay > 0 && targetProfit > 0 ? Math.ceil(targetProfit / expectedPerDay) : null;
    return { winRate: round2(winRate), expectancyR, expectedPerTrade, expectedPerDay, daysToTarget };
  };

  const base = projectFor(assumedWinRate);
  const sensitivity = [0.45, 0.5, 0.55, 0.6, 0.65].map(projectFor);
  const bindingDaysToPass =
    base.daysToTarget !== null ? Math.max(minTradingDays, base.daysToTarget) : null;

  if (base.expectancyR <= 0) {
    findings.push({
      id: 'negative_expectancy',
      severity: 'error',
      message:
        `At a ${round2(assumedWinRate * 100)}% win rate this configuration has negative expectancy ` +
        `(${base.expectancyR}R per trade). Breakeven needs ${round2(breakevenWinRate * 100)}%.`,
    });
  }

  // Trading days vs calendar days: an expiry window is calendar, a projection
  // is trading days. Roughly 5 trading days per 7 calendar days.
  const TRADING_DAYS_PER_CALENDAR_DAY = 5 / 7;
  if (evalExpiryDays > 0 && base.daysToTarget !== null) {
    const tradingDaysAvailable = Math.floor(evalExpiryDays * TRADING_DAYS_PER_CALENDAR_DAY);
    const needed = Math.max(minTradingDays, base.daysToTarget);
    if (needed > tradingDaysAvailable) {
      findings.push({
        id: 'eval_expiry_unreachable',
        severity: 'error',
        message:
          `The evaluation expires after ${evalExpiryDays} calendar days — about ` +
          `${tradingDaysAvailable} trading days — but reaching the target projects to ${needed} ` +
          `trading days at a ${round2(assumedWinRate * 100)}% win rate. This configuration is ` +
          `expected to expire before it passes.`,
      });
    } else if (needed > tradingDaysAvailable * 0.7) {
      findings.push({
        id: 'eval_expiry_tight',
        severity: 'warning',
        message:
          `Reaching the target projects to ${needed} trading days against roughly ` +
          `${tradingDaysAvailable} available before the ${evalExpiryDays}-day expiry. Little room ` +
          `for a slow start, and an expired eval is a lost fee, not a delayed pass.`,
      });
    }
  }

  const projections: PropFirmProjections = {
    assumedWinRate,
    tradesPerDay,
    base,
    sensitivity,
    bindingDaysToPass,
    tradingDaysBeforeExpiry:
      evalExpiryDays > 0 ? Math.floor(evalExpiryDays * (5 / 7)) : null,
    caveat:
      'Projections assume a fixed win rate that is NOT validated from live trading data, and ' +
      'ignore ladder step-ups, session fire rates, and slippage. Treat as directional only — ' +
      'the Rules figures above are exact, these are not.',
  };

  const rules: PropFirmRules = {
    baseRisk,
    fullLadderNominalRisk,
    maxReachableStep,
    worstCaseDayLoss,
    survivableMaxLossDays,
    ladder,
    safetyNetBalance,
    minBalanceForPayout,
    targetBalance,
    maxCompliantDayAtTarget,
    minTotalProfitForDay,
    avgWinR,
    partialWinR,
    breakevenWinRate,
    instrument,
    typicalStopPts,
  };

  const preset: DerivedPresetFields = {
    start_balance: startBalance,
    target_profit: targetProfit,
    max_drawdown: maxDrawdown,
    daily_loss_cap: dailyLossCap,
    base_risk: baseRisk,
    max_contracts: maxContracts,
    dd_mode: ddMode,
    phase,
    tp1_r: tp1R,
    tp2_r: tp2R,
    cap_step: capStep,
    max_trades_day: maxTradesDay,
    profit_split: profitSplit,
    step2_mult: stepMultipliers.step2,
    step3_mult: stepMultipliers.step3,
    step4_mult: stepMultipliers.step4,
  };

  return {
    inputs: {
      startBalance, targetProfit, maxDrawdown, dailyLossCap, ddMode, phase, maxContracts,
      minTradingDays, evalExpiryDays, consistencyPct, minPayout, safetyNetBuffer, profitSplit, riskDivisor,
      riskRounding, capStep, maxTradesDay, tp1R, tp2R, symbol, typicalStopPts,
      assumedWinRate, tradesPerDay, stepMultipliers,
    },
    rules,
    projections,
    findings,
    preset,
  };
}

/** JSON-safe form for storing in presets.derived_from (drops the function field). */
export function toDerivedFrom(result: PropFirmCalcResult): Record<string, unknown> {
  return {
    calculator_version: 1,
    derived_at: new Date().toISOString(),
    inputs: result.inputs,
    findings: result.findings,
  };
}
