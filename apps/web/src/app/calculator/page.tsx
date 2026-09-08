'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, PropFirmInputs, PropFirmCalcResult, PropFirmFinding } from '@/lib/api';
import { toast } from '@/components/ToastProvider';

/**
 * Prop firm math calculator.
 *
 * Plug in the numbers off a firm's rulebook page and see what they actually
 * imply before an account trades a dollar. Firms change these rules; this is
 * how you re-derive a preset in a minute instead of reconstructing which
 * numbers produced base risk, cap step, and the ladder multipliers.
 *
 * The output is split deliberately: RULES are exact arithmetic on the firm's
 * own figures, PROJECTIONS depend on an assumed win rate that is not validated
 * from live data. They are never mixed in one panel.
 */

type Form = Record<string, string>;

const DEFAULTS: Form = {
  name: '', id: '', propFirm: 'apex', phase: 'eval',
  startBalance: '50000', targetProfit: '3000', maxDrawdown: '2000', dailyLossCap: '1000',
  ddMode: 'eod_trailing', maxContracts: '60',
  minTradingDays: '1', evalExpiryDays: '30', consistencyPct: '50', minPayout: '500', safetyNetBuffer: '100',
  profitSplit: '1.0',
  riskDivisor: '3', riskRounding: 'ceil', baseRiskOverride: '',
  capStep: '4', step2: '1', step3: '2', step4: '4',
  maxTradesDay: '3', tp1R: '0.5', tp2R: '2.0',
  symbol: 'MNQ', typicalStopPts: '15',
  assumedWinRate: '60', tradesPerDay: '1.5',
};

const DD_MODES = [
  { value: 'eod_trailing', label: 'EOD Trailing' },
  { value: 'intraday_trailing', label: 'Intraday Trailing' },
  { value: 'static_fixed', label: 'Static Fixed' },
];

const money = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export default function CalculatorPage() {
  const router = useRouter();
  const [form, setForm] = useState<Form>(DEFAULTS);
  const [result, setResult] = useState<PropFirmCalcResult | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [saving, setSaving] = useState(false);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setResult(null); // inputs changed — old output is stale
  };

  const num = (v: string): number | undefined => {
    if (v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  function toInputs(): PropFirmInputs {
    return {
      startBalance: num(form.startBalance) ?? 0,
      targetProfit: num(form.targetProfit) ?? 0,
      maxDrawdown: num(form.maxDrawdown) ?? 0,
      dailyLossCap: num(form.dailyLossCap) ?? 0,
      ddMode: form.ddMode,
      phase: form.phase as 'eval' | 'funded',
      maxContracts: num(form.maxContracts) ?? 0,
      minTradingDays: num(form.minTradingDays),
      evalExpiryDays: num(form.evalExpiryDays),
      consistencyPct: num(form.consistencyPct),
      minPayout: num(form.minPayout),
      safetyNetBuffer: num(form.safetyNetBuffer),
      profitSplit: num(form.profitSplit),
      riskDivisor: num(form.riskDivisor),
      riskRounding: form.riskRounding as 'ceil' | 'floor' | 'nearest',
      baseRiskOverride: num(form.baseRiskOverride),
      stepMultipliers: {
        step2: num(form.step2) ?? 1,
        step3: num(form.step3) ?? 2,
        step4: num(form.step4) ?? 4,
      },
      capStep: num(form.capStep),
      maxTradesDay: num(form.maxTradesDay),
      tp1R: num(form.tp1R),
      tp2R: num(form.tp2R),
      symbol: form.symbol,
      typicalStopPts: num(form.typicalStopPts),
      // UI collects a percentage; the API takes a 0..1 fraction.
      assumedWinRate: (num(form.assumedWinRate) ?? 60) / 100,
      tradesPerDay: num(form.tradesPerDay),
    };
  }

  async function handleCalculate() {
    setCalculating(true);
    try {
      const res = await api.calculatePropFirm(toInputs());
      setResult(res.data);
    } catch (err) {
      setResult(null);
      toast.error(err instanceof Error ? err.message : 'Calculation failed');
    } finally {
      setCalculating(false);
    }
  }

  async function handleSaveAsPreset() {
    if (!result) return;
    if (!form.name.trim()) { toast.error('Give the preset a name'); return; }
    if (!/^[a-z0-9_]+$/.test(form.id)) {
      toast.error('ID must be lowercase letters, numbers, and underscores only');
      return;
    }
    const blocking = result.findings.filter((f) => f.severity === 'error');
    if (blocking.length > 0) {
      toast.error(`Fix the ${blocking.length} blocking issue(s) before saving`);
      return;
    }
    setSaving(true);
    try {
      await api.createGbPreset({
        id: form.id,
        name: form.name.trim(),
        prop_firm: form.propFirm.trim() || 'custom',
        ...result.preset,
        derived_from: result.derived_from,
      } as never);
      toast.success(`Preset "${form.name}" saved — assign it on the Accounts page`);
      router.push('/presets');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save preset');
    } finally {
      setSaving(false);
    }
  }

  const hasBlocking = result?.findings.some((f) => f.severity === 'error') ?? false;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-terminal-text">Prop Firm Calculator</h1>
        <p className="text-sm text-terminal-muted mt-1">
          Enter a firm&apos;s published rules, see what they actually imply, then save the result as a
          preset you can assign to an account. Re-run this whenever a firm changes its terms.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] gap-6 items-start">
        {/* ---------------- Inputs ---------------- */}
        <div className="bg-terminal-surface border border-terminal-border rounded-lg p-5 space-y-5">
          <Section title="Firm rules" hint="Copy these straight off the firm's account page.">
            <div className="grid grid-cols-2 gap-3">
              <L label="Account size"><I value={form.startBalance} onChange={set('startBalance')} /></L>
              <L label="Profit target"><I value={form.targetProfit} onChange={set('targetProfit')} /></L>
              <L label="Max drawdown"><I value={form.maxDrawdown} onChange={set('maxDrawdown')} /></L>
              <L label="Daily loss limit"><I value={form.dailyLossCap} onChange={set('dailyLossCap')} /></L>
              <L label="Min trading days"><I value={form.minTradingDays} onChange={set('minTradingDays')} /></L>
              <L label="Eval expires (days)" hint="0 if no expiry">
                <I value={form.evalExpiryDays} onChange={set('evalExpiryDays')} />
              </L>
              <L label="Consistency %" hint="0 to disable">
                <I value={form.consistencyPct} onChange={set('consistencyPct')} />
              </L>
              <L label="Max contracts"><I value={form.maxContracts} onChange={set('maxContracts')} /></L>
              <L label="Profit split" hint="1.0 = 100%">
                <I value={form.profitSplit} onChange={set('profitSplit')} />
              </L>
              <L label="Drawdown mode">
                <S value={form.ddMode} onChange={set('ddMode')} options={DD_MODES} />
              </L>
              <L label="Phase">
                <S
                  value={form.phase}
                  onChange={set('phase')}
                  options={[{ value: 'eval', label: 'Eval' }, { value: 'funded', label: 'Funded PA' }]}
                />
              </L>
            </div>
            {form.phase === 'funded' && (
              <div className="grid grid-cols-2 gap-3 pt-1">
                <L label="Min payout"><I value={form.minPayout} onChange={set('minPayout')} /></L>
                <L label="Safety net buffer" hint="Cushion above the DD floor">
                  <I value={form.safetyNetBuffer} onChange={set('safetyNetBuffer')} />
                </L>
              </div>
            )}
          </Section>

          <Section title="How you'll trade it" hint="Base risk = daily loss limit ÷ divisor.">
            <div className="grid grid-cols-2 gap-3">
              <L label="Risk divisor"><I value={form.riskDivisor} onChange={set('riskDivisor')} /></L>
              <L label="Rounding">
                <S
                  value={form.riskRounding}
                  onChange={set('riskRounding')}
                  options={[
                    { value: 'ceil', label: 'Up' },
                    { value: 'nearest', label: 'Nearest' },
                    { value: 'floor', label: 'Down' },
                  ]}
                />
              </L>
              <L label="Base risk override" hint="Blank = use divisor">
                <I value={form.baseRiskOverride} onChange={set('baseRiskOverride')} placeholder="auto" />
              </L>
              <L label="Cap step"><I value={form.capStep} onChange={set('capStep')} /></L>
              <L label="Step 2 ×"><I value={form.step2} onChange={set('step2')} /></L>
              <L label="Step 3 ×"><I value={form.step3} onChange={set('step3')} /></L>
              <L label="Step 4 ×"><I value={form.step4} onChange={set('step4')} /></L>
              <L label="Max trades/day"><I value={form.maxTradesDay} onChange={set('maxTradesDay')} /></L>
              <L label="TP1 (R)"><I value={form.tp1R} onChange={set('tp1R')} /></L>
              <L label="TP2 (R)"><I value={form.tp2R} onChange={set('tp2R')} /></L>
              <L label="Instrument"><I value={form.symbol} onChange={set('symbol')} /></L>
              <L label="Typical stop (pts)"><I value={form.typicalStopPts} onChange={set('typicalStopPts')} /></L>
            </div>
          </Section>

          <Section
            title="Projection assumptions"
            hint="These drive the Projections panel only — never the Rules panel."
          >
            <div className="grid grid-cols-2 gap-3">
              <L label="Assumed win rate %"><I value={form.assumedWinRate} onChange={set('assumedWinRate')} /></L>
              <L label="Trades per day"><I value={form.tradesPerDay} onChange={set('tradesPerDay')} /></L>
            </div>
          </Section>

          <button
            onClick={handleCalculate}
            disabled={calculating}
            className="w-full py-2.5 rounded-lg text-sm font-semibold bg-terminal-buy text-black hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {calculating ? 'Calculating…' : 'Calculate'}
          </button>
        </div>

        {/* ---------------- Output ---------------- */}
        <div className="space-y-4">
          {!result && (
            <div className="bg-terminal-surface border border-terminal-border rounded-lg p-10 text-center">
              <p className="text-sm text-terminal-muted">
                Enter the firm&apos;s rules and hit Calculate.
              </p>
            </div>
          )}

          {result && (
            <>
              {result.findings.length > 0 && (
                <div className="space-y-2">
                  {result.findings.map((f) => <FindingCard key={f.id} finding={f} />)}
                </div>
              )}

              {/* ---- RULES: exact ---- */}
              <Panel
                title="Rules"
                badge="Exact"
                badgeClass="bg-terminal-buy/15 text-terminal-buy border-terminal-buy/30"
                subtitle="Arithmetic on the firm's own numbers. Verifiable."
              >
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
                  <Stat label="Base risk" value={money(result.rules.baseRisk)} />
                  <Stat label="Target balance" value={money(result.rules.targetBalance)} />
                  <Stat
                    label="Worst-case day"
                    value={money(result.rules.worstCaseDayLoss)}
                    hint="Ladder run until the DLL gate stops it"
                  />
                  <Stat
                    label="Bad days survivable"
                    value={
                      Number.isFinite(result.rules.survivableMaxLossDays)
                        ? `${result.rules.survivableMaxLossDays}`
                        : '∞'
                    }
                    hint="Max drawdown ÷ worst-case day"
                  />
                  {result.rules.safetyNetBalance !== null && (
                    <Stat label="Safety net" value={money(result.rules.safetyNetBalance)} />
                  )}
                  {result.rules.minBalanceForPayout !== null && (
                    <Stat
                      label="Payout floor"
                      value={money(result.rules.minBalanceForPayout)}
                      hint="Min balance to request"
                    />
                  )}
                  <Stat
                    label="Breakeven win rate"
                    value={`${(result.rules.breakevenWinRate * 100).toFixed(1)}%`}
                    hint={`Avg win ${result.rules.avgWinR}R`}
                  />
                  {result.rules.maxCompliantDayAtTarget !== null && (
                    <Stat
                      label="Max compliant day"
                      value={money(result.rules.maxCompliantDayAtTarget)}
                      hint="At target, under consistency rule"
                    />
                  )}
                </div>

                <h4 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider mb-2">
                  Risk ladder — {result.rules.instrument.root}, {result.rules.typicalStopPts}pt stop
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-terminal-muted border-b border-terminal-border">
                        <th className="py-2 pr-3 font-medium">Step</th>
                        <th className="py-2 pr-3 font-medium">Risk</th>
                        <th className="py-2 pr-3 font-medium">Contracts</th>
                        <th className="py-2 pr-3 font-medium">Actual risk</th>
                        <th className="py-2 pr-3 font-medium">DLL room</th>
                        <th className="py-2 font-medium">Same day?</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {result.rules.ladder.map((r) => (
                        <tr key={r.step} className="border-b border-terminal-border/50 last:border-0">
                          <td className="py-2 pr-3 text-terminal-text">
                            {r.step} <span className="text-terminal-muted">({r.multiplier}×)</span>
                          </td>
                          <td className="py-2 pr-3 text-terminal-text">{money(r.nominalRisk)}</td>
                          <td className="py-2 pr-3 text-terminal-text">
                            {r.contracts}
                            {r.contractCapBinds && (
                              <span className="text-terminal-sell ml-1" title={`Wanted ${r.uncappedContracts}, capped`}>
                                ▲{r.uncappedContracts}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-terminal-text">{money(r.actualRisk)}</td>
                          <td className="py-2 pr-3 text-terminal-muted">{money(r.dllRoomBefore)}</td>
                          <td className="py-2">
                            {r.reachableSameDay ? (
                              <span className="text-terminal-buy">yes</span>
                            ) : (
                              <span className="text-terminal-muted">blocked by DLL</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-terminal-muted mt-2">
                  Steps marked blocked can still be reached — the ladder step carries across the 6&nbsp;PM ET
                  reset, so they fire on a later day once daily loss room is restored.
                </p>

                {result.rules.consistencyCurve && (
                  <>
                    <h4 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider mt-5 mb-2">
                      Consistency rule
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {result.rules.consistencyCurve.map((c) => (
                        <div
                          key={c.dayPnl}
                          className="text-xs font-mono px-2.5 py-1.5 rounded bg-terminal-panel border border-terminal-border"
                        >
                          <span className="text-terminal-muted">day </span>
                          <span className="text-terminal-text">{money(c.dayPnl)}</span>
                          <span className="text-terminal-muted"> needs </span>
                          <span className="text-terminal-text">{money(c.minTotalProfit)}</span>
                          <span className="text-terminal-muted"> total</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </Panel>

              {/* ---- PROJECTIONS: assumption-driven ---- */}
              <Panel
                title="Projections"
                badge="Estimate"
                badgeClass="bg-terminal-sell/15 text-terminal-sell border-terminal-sell/30"
                subtitle={result.projections.caveat}
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-terminal-muted border-b border-terminal-border">
                        <th className="py-2 pr-3 font-medium">Win rate</th>
                        <th className="py-2 pr-3 font-medium">Expectancy</th>
                        <th className="py-2 pr-3 font-medium">Per trade</th>
                        <th className="py-2 pr-3 font-medium">Per day</th>
                        <th className="py-2 font-medium">Days to target</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {result.projections.sensitivity.map((s) => {
                        const isBase =
                          Math.abs(s.winRate - result.projections.assumedWinRate) < 0.005;
                        return (
                          <tr
                            key={s.winRate}
                            className={`border-b border-terminal-border/50 last:border-0 ${
                              isBase ? 'bg-terminal-panel' : ''
                            }`}
                          >
                            <td className="py-2 pr-3 text-terminal-text">
                              {(s.winRate * 100).toFixed(0)}%
                              {isBase && <span className="text-terminal-muted ml-1">(assumed)</span>}
                            </td>
                            <td
                              className={`py-2 pr-3 ${
                                s.expectancyR > 0 ? 'text-terminal-buy' : 'text-terminal-sell'
                              }`}
                            >
                              {s.expectancyR > 0 ? '+' : ''}
                              {s.expectancyR}R
                            </td>
                            <td className="py-2 pr-3 text-terminal-text">{money(s.expectedPerTrade)}</td>
                            <td className="py-2 pr-3 text-terminal-text">{money(s.expectedPerDay)}</td>
                            <td className="py-2 text-terminal-text">{s.daysToTarget ?? '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {result.projections.bindingDaysToPass !== null && (
                  <p className="text-xs text-terminal-muted mt-3">
                    At the assumed win rate, the binding constraint is{' '}
                    <span className="text-terminal-text font-mono">
                      {result.projections.bindingDaysToPass} trading days
                    </span>{' '}
                    (the later of the firm&apos;s minimum and the projected time to target).
                  </p>
                )}
              </Panel>

              {/* ---- Save ---- */}
              <div className="bg-terminal-surface border border-terminal-border rounded-lg p-5 space-y-3">
                <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
                  Save as preset
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <L label="Preset name">
                    <I value={form.name} onChange={set('name')} placeholder="Apex 50K EOD Eval" />
                  </L>
                  <L label="Preset ID" hint="lowercase_with_underscores">
                    <I value={form.id} onChange={set('id')} placeholder="apex_50k_eod_eval" />
                  </L>
                  <L label="Prop firm">
                    <I value={form.propFirm} onChange={set('propFirm')} placeholder="apex" />
                  </L>
                </div>
                <button
                  onClick={handleSaveAsPreset}
                  disabled={saving || hasBlocking}
                  className="w-full py-2.5 rounded-lg text-sm font-semibold bg-terminal-buy text-black hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                  {saving ? 'Saving…' : hasBlocking ? 'Fix blocking issues first' : 'Save preset'}
                </button>
                <p className="text-[11px] text-terminal-muted">
                  The raw inputs above are stored with the preset, so you can reopen and re-derive it
                  when the firm changes its rules.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- small presentational pieces ---------------- */

const SEVERITY: Record<PropFirmFinding['severity'], { ring: string; label: string; icon: string }> = {
  error:   { ring: 'border-terminal-sell/40 bg-terminal-sell/10', label: 'Blocking', icon: '✕' },
  warning: { ring: 'border-yellow-500/40 bg-yellow-500/10',       label: 'Warning',  icon: '!' },
  info:    { ring: 'border-terminal-border bg-terminal-panel',    label: 'Note',     icon: 'i' },
};

function FindingCard({ finding }: { finding: PropFirmFinding }) {
  const s = SEVERITY[finding.severity];
  return (
    <div className={`border rounded-lg px-4 py-3 flex gap-3 ${s.ring}`}>
      <span className="text-xs font-bold text-terminal-text mt-0.5 w-4 text-center shrink-0">{s.icon}</span>
      <div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-terminal-muted">
          {s.label}
        </span>
        <p className="text-sm text-terminal-text mt-0.5">{finding.message}</p>
      </div>
    </div>
  );
}

function Panel({
  title, badge, badgeClass, subtitle, children,
}: {
  title: string; badge: string; badgeClass: string; subtitle: string; children: React.ReactNode;
}) {
  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg p-5">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-lg font-bold text-terminal-text">{title}</h2>
        <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${badgeClass}`}>
          {badge}
        </span>
      </div>
      <p className="text-xs text-terminal-muted mb-4">{subtitle}</p>
      {children}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xs text-terminal-muted">{label}</div>
      <div className="text-lg font-mono text-terminal-text mt-0.5">{value}</div>
      {hint && <div className="text-[10px] text-terminal-muted mt-0.5">{hint}</div>}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 border-t border-terminal-border pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">{title}</h3>
      {hint && <p className="text-xs text-terminal-muted -mt-1">{hint}</p>}
      {children}
    </div>
  );
}

function L({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-terminal-muted">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-terminal-muted">{hint}</p>}
    </div>
  );
}

function I(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full px-2.5 py-1.5 text-sm font-mono bg-terminal-panel border border-terminal-border rounded text-terminal-text focus:outline-none focus:border-terminal-buy"
    />
  );
}

function S({
  value, onChange, options,
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={onChange}
      className="w-full px-2.5 py-1.5 text-sm bg-terminal-panel border border-terminal-border rounded text-terminal-text focus:outline-none focus:border-terminal-buy"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
