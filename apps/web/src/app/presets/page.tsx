'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, GbPreset } from '@/lib/api';
import { Skeleton } from '@/components/Skeleton';
import { toast } from '@/components/ToastProvider';

/**
 * Every knob the GB LIVE execution engine reads at trade time lives here:
 * account size/target/drawdown, the risk ladder (base risk + per-step
 * multipliers), TP R-multiples, and Sniper Mode. Editing a preset changes
 * behavior for every account assigned to it on their NEXT trade — nothing
 * needs to be redeployed, and nothing needs to change in the TradingView
 * script, which no longer carries any of this.
 */

type FormState = {
  id: string;
  name: string;
  prop_firm: string;
  phase: 'eval' | 'funded';
  start_balance: string;
  target_profit: string;
  max_drawdown: string;
  daily_loss_cap: string;
  dd_mode: string;
  base_risk: string;
  cap_step: string;
  step2_mult: string;
  step3_mult: string;
  step4_mult: string;
  max_contracts: string;
  tp1_r: string;
  tp2_r: string;
  max_trades_day: string;
  profit_split: string;
  pass_zone_buffer: string;
  sniper_risk_pct: string;
  sniper_tp_r: string;
  sniper_max_trades_day: string;
  notes: string;
};

const EMPTY_FORM: FormState = {
  id: '', name: '', prop_firm: '', phase: 'eval',
  start_balance: '50000', target_profit: '3000', max_drawdown: '2000', daily_loss_cap: '1000', dd_mode: 'eod_trailing',
  base_risk: '334', cap_step: '4', step2_mult: '1', step3_mult: '2', step4_mult: '4',
  max_contracts: '60', tp1_r: '0.5', tp2_r: '2.0', max_trades_day: '3', profit_split: '1.0',
  pass_zone_buffer: '200', sniper_risk_pct: '50', sniper_tp_r: '1.0', sniper_max_trades_day: '2',
  notes: '',
};

const DD_MODES = [
  { value: 'eod_trailing', label: 'EOD Trailing' },
  { value: 'intraday_trailing', label: 'Intraday Trailing' },
  { value: 'static_fixed', label: 'Static Fixed' },
];

function presetToForm(p: GbPreset): FormState {
  return {
    id: p.id, name: p.name, prop_firm: p.prop_firm, phase: p.phase,
    start_balance: String(p.start_balance), target_profit: p.target_profit !== null ? String(p.target_profit) : '',
    max_drawdown: String(p.max_drawdown), daily_loss_cap: String(p.daily_loss_cap), dd_mode: p.dd_mode,
    base_risk: String(p.base_risk), cap_step: String(p.cap_step),
    step2_mult: String(p.step2_mult), step3_mult: String(p.step3_mult), step4_mult: String(p.step4_mult),
    max_contracts: String(p.max_contracts), tp1_r: String(p.tp1_r), tp2_r: String(p.tp2_r),
    max_trades_day: String(p.max_trades_day), profit_split: String(p.profit_split),
    pass_zone_buffer: String(p.pass_zone_buffer), sniper_risk_pct: String(p.sniper_risk_pct),
    sniper_tp_r: String(p.sniper_tp_r), sniper_max_trades_day: String(p.sniper_max_trades_day),
    notes: p.notes ?? '',
  };
}

export default function PresetsPage() {
  const [presets, setPresets] = useState<GbPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.getGbPresets();
      if (res.success) setPresets(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load presets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openNew() {
    setForm(EMPTY_FORM);
    setEditing('new');
  }

  function openEdit(p: GbPreset) {
    setForm(presetToForm(p));
    setEditing(p.id);
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toNumberBody(): Partial<GbPreset> {
    const num = (s: string) => (s.trim() === '' ? null : Number(s));
    return {
      name: form.name.trim(),
      prop_firm: form.prop_firm.trim(),
      phase: form.phase,
      start_balance: num(form.start_balance) ?? 0,
      target_profit: num(form.target_profit),
      max_drawdown: num(form.max_drawdown) ?? 0,
      daily_loss_cap: num(form.daily_loss_cap) ?? 0,
      dd_mode: form.dd_mode,
      base_risk: num(form.base_risk) ?? 0,
      cap_step: num(form.cap_step) ?? 4,
      step2_mult: num(form.step2_mult) ?? 1,
      step3_mult: num(form.step3_mult) ?? 2,
      step4_mult: num(form.step4_mult) ?? 4,
      max_contracts: num(form.max_contracts) ?? 0,
      tp1_r: num(form.tp1_r) ?? 0.5,
      tp2_r: num(form.tp2_r) ?? 2.0,
      max_trades_day: num(form.max_trades_day) ?? 3,
      profit_split: num(form.profit_split) ?? 1.0,
      pass_zone_buffer: num(form.pass_zone_buffer) ?? 0,
      sniper_risk_pct: num(form.sniper_risk_pct) ?? 50,
      sniper_tp_r: num(form.sniper_tp_r) ?? 1.0,
      sniper_max_trades_day: num(form.sniper_max_trades_day) ?? 2,
      notes: form.notes.trim() || undefined,
    } as Partial<GbPreset>;
  }

  async function handleSave() {
    if (!form.name.trim() || !form.prop_firm.trim()) { toast.error('Name and prop firm are required'); return; }
    setSaving(true);
    try {
      if (editing === 'new') {
        if (!/^[a-z0-9_]+$/.test(form.id)) { toast.error('ID must be lowercase letters, numbers, underscores only'); setSaving(false); return; }
        await api.createGbPreset({ id: form.id, ...toNumberBody() });
        toast.success(`Preset "${form.name}" created`);
      } else if (editing) {
        await api.updateGbPreset(editing, toNumberBody());
        toast.success(`Preset "${form.name}" updated`);
      }
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save preset');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(p: GbPreset) {
    if (!confirm(`Delete preset "${p.name}"? This only works if no accounts are assigned to it.`)) return;
    try {
      await api.deleteGbPreset(p.id);
      toast.success(`"${p.name}" deleted`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete preset');
    }
  }

  async function handleDuplicate(p: GbPreset) {
    setForm({ ...presetToForm(p), id: '', name: `${p.name} (copy)` });
    setEditing('new');
  }

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold text-terminal-text">Strategy Presets</h1>
        <div className="card"><Skeleton className="h-64 w-full" /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-terminal-sell/10 border border-terminal-sell/30 rounded-lg p-4 text-terminal-sell">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-terminal-text">Strategy Presets</h1>
          <p className="text-sm text-terminal-muted mt-1">
            Every risk, ladder, and Sniper Mode parameter the execution engine uses. Edit here — no code changes, no redeploy, and nothing to change in TradingView.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link href="/calculator" className="btn btn-secondary text-sm">🧮 Calculate from firm rules</Link>
          <button onClick={openNew} className="btn btn-primary text-sm">+ New Preset</button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {presets.map((p) => (
          <div key={p.id} className="card space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-semibold text-terminal-text">{p.name}</h3>
                <p className="text-xs text-terminal-muted capitalize">{p.prop_firm} · {p.phase} · <span className="font-mono">{p.id}</span></p>
              </div>
              <span className="px-2 py-0.5 rounded text-[10px] bg-terminal-panel text-terminal-muted uppercase">{p.dd_mode.replace('_', ' ')}</span>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <Field label="Balance" value={`$${Number(p.start_balance).toLocaleString()}`} />
              <Field label="Target" value={p.target_profit !== null ? `$${Number(p.target_profit).toLocaleString()}` : '—'} />
              <Field label="Max DD" value={`$${Number(p.max_drawdown).toLocaleString()}`} />
              <Field label="Daily Loss Cap" value={`$${Number(p.daily_loss_cap).toLocaleString()}`} />
              <Field label="Base Risk" value={`$${Number(p.base_risk).toLocaleString()}`} />
              <Field label="Max Contracts" value={String(p.max_contracts)} />
              <Field label="Ladder Mults" value={`1 / ${p.step2_mult} / ${p.step3_mult} / ${p.step4_mult}`} />
              <Field label="Cap Step" value={String(p.cap_step)} />
              <Field label="TP1 / TP2 R" value={`${p.tp1_r}R / ${p.tp2_r}R`} />
              <Field label="Max Trades/Day" value={String(p.max_trades_day)} />
              <Field label="Sniper Buffer" value={`$${Number(p.pass_zone_buffer).toLocaleString()}`} />
              <Field label="Sniper Risk/TP" value={`${p.sniper_risk_pct}% @ ${p.sniper_tp_r}R`} />
            </div>

            {p.notes && <p className="text-xs text-terminal-muted italic border-t border-terminal-border pt-2">{p.notes}</p>}

            <div className="flex gap-2 pt-1">
              <button onClick={() => openEdit(p)} className="btn btn-secondary text-xs flex-1">Edit</button>
              <button onClick={() => handleDuplicate(p)} className="btn btn-secondary text-xs flex-1">Duplicate</button>
              <button onClick={() => handleDelete(p)} className="px-2.5 py-1 rounded text-xs bg-terminal-sell/20 text-terminal-sell hover:bg-terminal-sell/30 transition-colors">Delete</button>
            </div>
          </div>
        ))}
      </div>

      {editing !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-terminal-surface border border-terminal-border rounded-xl w-full max-w-2xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-terminal-text">{editing === 'new' ? 'New Preset' : `Edit: ${form.name}`}</h2>
              <button onClick={() => setEditing(null)} className="text-terminal-muted hover:text-terminal-text">✕</button>
            </div>

            <Section title="Identity">
              <div className="grid grid-cols-2 gap-3">
                <Labeled label="Preset ID" hint={editing !== 'new' ? 'Immutable' : 'lowercase_with_underscores'}>
                  <input className="input w-full font-mono" value={form.id} disabled={editing !== 'new'}
                    onChange={(e) => set('id', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} placeholder="apex_50k_eod_eval" />
                </Labeled>
                <Labeled label="Display Name"><input className="input w-full" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Apex 50K EOD Eval" /></Labeled>
                <Labeled label="Prop Firm"><input className="input w-full" value={form.prop_firm} onChange={(e) => set('prop_firm', e.target.value)} placeholder="apex" /></Labeled>
                <Labeled label="Phase">
                  <select className="input w-full" value={form.phase} onChange={(e) => set('phase', e.target.value as 'eval' | 'funded')}>
                    <option value="eval">Eval</option>
                    <option value="funded">Funded</option>
                  </select>
                </Labeled>
              </div>
            </Section>

            <Section title="Account">
              <div className="grid grid-cols-2 gap-3">
                <Labeled label="Start Balance $"><input className="input w-full" type="number" value={form.start_balance} onChange={(e) => set('start_balance', e.target.value)} /></Labeled>
                <Labeled label="Target Profit $" hint="Blank = no target (funded, no Sniper Mode)"><input className="input w-full" type="number" value={form.target_profit} onChange={(e) => set('target_profit', e.target.value)} /></Labeled>
                <Labeled label="Max Drawdown $"><input className="input w-full" type="number" value={form.max_drawdown} onChange={(e) => set('max_drawdown', e.target.value)} /></Labeled>
                <Labeled label="Daily Loss Cap $"><input className="input w-full" type="number" value={form.daily_loss_cap} onChange={(e) => set('daily_loss_cap', e.target.value)} /></Labeled>
                <Labeled label="Drawdown Mode">
                  <select className="input w-full" value={form.dd_mode} onChange={(e) => set('dd_mode', e.target.value)}>
                    {DD_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </Labeled>
                <Labeled label="Max Contracts (micros)"><input className="input w-full" type="number" value={form.max_contracts} onChange={(e) => set('max_contracts', e.target.value)} /></Labeled>
              </div>
            </Section>

            <Section title="Risk Ladder" hint="Each step must fully recover all prior losses in one win — multipliers depend on your TP R and daily loss cap.">
              <div className="grid grid-cols-2 gap-3">
                <Labeled label="Base Risk $ (Step 1)"><input className="input w-full" type="number" value={form.base_risk} onChange={(e) => set('base_risk', e.target.value)} /></Labeled>
                <Labeled label="Cap Step (1-4)"><input className="input w-full" type="number" min={1} max={4} value={form.cap_step} onChange={(e) => set('cap_step', e.target.value)} /></Labeled>
                <Labeled label="Step 2 Multiplier"><input className="input w-full" type="number" step="0.1" value={form.step2_mult} onChange={(e) => set('step2_mult', e.target.value)} /></Labeled>
                <Labeled label="Step 3 Multiplier"><input className="input w-full" type="number" step="0.1" value={form.step3_mult} onChange={(e) => set('step3_mult', e.target.value)} /></Labeled>
                <Labeled label="Step 4 Multiplier"><input className="input w-full" type="number" step="0.1" value={form.step4_mult} onChange={(e) => set('step4_mult', e.target.value)} /></Labeled>
                <Labeled label="Max Trades / Day"><input className="input w-full" type="number" value={form.max_trades_day} onChange={(e) => set('max_trades_day', e.target.value)} /></Labeled>
              </div>
            </Section>

            <Section title="Trade Management">
              <div className="grid grid-cols-2 gap-3">
                <Labeled label="TP1 R-Multiple"><input className="input w-full" type="number" step="0.1" value={form.tp1_r} onChange={(e) => set('tp1_r', e.target.value)} /></Labeled>
                <Labeled label="TP2 R-Multiple"><input className="input w-full" type="number" step="0.1" value={form.tp2_r} onChange={(e) => set('tp2_r', e.target.value)} /></Labeled>
                <Labeled label="Profit Split" hint="0-1, e.g. 0.8 = 80%"><input className="input w-full" type="number" step="0.05" value={form.profit_split} onChange={(e) => set('profit_split', e.target.value)} /></Labeled>
              </div>
            </Section>

            <Section title="Sniper Mode" hint="Triggers per-account when progress toward target is within the buffer. Evaluated server-side, independently per account — never by the signal.">
              <div className="grid grid-cols-2 gap-3">
                <Labeled label="Pass Zone Buffer $" hint="0 disables Sniper Mode"><input className="input w-full" type="number" value={form.pass_zone_buffer} onChange={(e) => set('pass_zone_buffer', e.target.value)} /></Labeled>
                <Labeled label="Sniper Risk % of Remaining"><input className="input w-full" type="number" value={form.sniper_risk_pct} onChange={(e) => set('sniper_risk_pct', e.target.value)} /></Labeled>
                <Labeled label="Sniper TP R-Multiple"><input className="input w-full" type="number" step="0.1" value={form.sniper_tp_r} onChange={(e) => set('sniper_tp_r', e.target.value)} /></Labeled>
                <Labeled label="Sniper Max Trades / Day"><input className="input w-full" type="number" value={form.sniper_max_trades_day} onChange={(e) => set('sniper_max_trades_day', e.target.value)} /></Labeled>
              </div>
            </Section>

            <Section title="Notes">
              <textarea className="input w-full h-20" value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Verify PA daily loss limit with Apex before use..." />
            </Section>

            <div className="flex gap-3 pt-2">
              <button onClick={() => setEditing(null)} className="btn btn-secondary flex-1">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="btn btn-primary flex-1">{saving ? 'Saving…' : 'Save Preset'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-terminal-muted">{label}: </span>
      <span className="text-terminal-text font-mono">{value}</span>
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

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-terminal-muted">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-terminal-muted">{hint}</p>}
    </div>
  );
}
