'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, Strategy, RiskRule, CopierMapping } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import { toast } from '@/components/ToastProvider';

const RULE_TYPES = [
  { value: 'max_contracts', label: 'Max Contracts', hint: '{"maxContracts": 10}' },
  { value: 'max_positions', label: 'Max Positions', hint: '{"maxPositions": 5}' },
  { value: 'cooldown', label: 'Cooldown', hint: '{"seconds": 30}' },
  { value: 'session_time', label: 'Session Time', hint: '{"startHour":9,"startMinute":30,"endHour":16,"endMinute":0,"timezone":"America/New_York"}' },
  { value: 'daily_loss_limit', label: 'Daily Loss Limit', hint: '{"maxLoss": 500}' },
  { value: 'symbol_whitelist', label: 'Symbol Whitelist', hint: '{"symbols":["NQ","ES"]}' },
  { value: 'conflicting_position', label: 'No Conflicting Positions', hint: '{}' },
  { value: 'kill_switch', label: 'Kill Switch', hint: '{}' },
];

export default function StrategyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [rules, setRules] = useState<RiskRule[]>([]);
  const [mappings, setMappings] = useState<CopierMapping[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; name: string; broker_type: string }[]>([]);
  const [loading, setLoading] = useState(true);

  // Inline edit state
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editingField, setEditingField] = useState<'name' | 'desc' | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // Add rule modal
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [newRuleType, setNewRuleType] = useState(RULE_TYPES[0].value);
  const [newRuleConfig, setNewRuleConfig] = useState(RULE_TYPES[0].hint);
  const [addingRule, setAddingRule] = useState(false);

  // Add mapping modal
  const [showMappingModal, setShowMappingModal] = useState(false);
  const [mappingAccountId, setMappingAccountId] = useState('');
  const [mappingMultiplier, setMappingMultiplier] = useState('1.0');
  const [mappingFixedSize, setMappingFixedSize] = useState('');
  const [mappingLongOnly, setMappingLongOnly] = useState(false);
  const [mappingShortOnly, setMappingShortOnly] = useState(false);
  const [addingMapping, setAddingMapping] = useState(false);

  useEffect(() => { loadAll(); }, [id]);

  async function loadAll() {
    setLoading(true);
    try {
      const [stratRes, rulesRes, mappingsRes, accountsRes] = await Promise.all([
        api.getStrategy(id),
        api.getStrategyRules(id),
        api.getStrategyMappings(id),
        api.getAccounts(),
      ]);
      if (stratRes.success) {
        setStrategy(stratRes.data);
        setEditName(stratRes.data.name);
        setEditDesc(stratRes.data.description || '');
      }
      if (rulesRes.success) setRules(rulesRes.data);
      if (mappingsRes.success) setMappings(mappingsRes.data);
      if (accountsRes.success) setAccounts(accountsRes.data as { id: string; name: string; broker_type: string }[]);
    } catch {
      toast.error('Failed to load strategy');
    } finally {
      setLoading(false);
    }
  }

  async function saveField(field: 'name' | 'desc') {
    if (!strategy) return;
    setSaving(true);
    try {
      const body = field === 'name' ? { name: editName } : { description: editDesc };
      const res = await api.updateStrategy(strategy.id, body);
      if (res.success) {
        setStrategy(res.data);
        setEditingField(null);
        toast.success('Saved');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive() {
    if (!strategy) return;
    try {
      const res = await api.updateStrategy(strategy.id, { is_active: !strategy.is_active });
      if (res.success) {
        setStrategy(res.data);
        toast.success(res.data.is_active ? 'Strategy enabled' : 'Strategy disabled');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle');
    }
  }

  function copyWebhookUrl() {
    if (!strategy) return;
    navigator.clipboard.writeText(strategy.webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleAddRule() {
    let parsedConfig: Record<string, unknown> = {};
    try {
      parsedConfig = JSON.parse(newRuleConfig);
    } catch {
      toast.error('Config must be valid JSON');
      return;
    }
    setAddingRule(true);
    try {
      const res = await api.addStrategyRule(id, { rule_type: newRuleType, config: parsedConfig });
      if (res.success) {
        setRules((prev) => [...prev, res.data]);
        setShowRuleModal(false);
        toast.success('Risk rule added');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add rule');
    } finally {
      setAddingRule(false);
    }
  }

  async function handleDeleteRule(ruleId: string) {
    if (!window.confirm('Delete this risk rule?')) return;
    try {
      await api.deleteStrategyRule(id, ruleId);
      setRules((prev) => prev.filter((r) => r.id !== ruleId));
      toast.success('Risk rule deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete rule');
    }
  }

  async function handleAddMapping() {
    if (!mappingAccountId) { toast.error('Select an account'); return; }
    setAddingMapping(true);
    try {
      const res = await api.addStrategyMapping(id, {
        account_id: mappingAccountId,
        multiplier: parseFloat(mappingMultiplier) || 1.0,
        fixed_size: mappingFixedSize ? parseInt(mappingFixedSize) : undefined,
        long_only: mappingLongOnly,
        short_only: mappingShortOnly,
      });
      if (res.success) {
        setMappings((prev) => [...prev, res.data]);
        setShowMappingModal(false);
        setMappingAccountId('');
        setMappingMultiplier('1.0');
        setMappingFixedSize('');
        setMappingLongOnly(false);
        setMappingShortOnly(false);
        toast.success('Account linked');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to link account');
    } finally {
      setAddingMapping(false);
    }
  }

  async function handleDeleteMapping(mappingId: string) {
    if (!window.confirm('Remove this account from the strategy?')) return;
    try {
      await api.deleteStrategyMapping(id, mappingId);
      setMappings((prev) => prev.filter((m) => m.id !== mappingId));
      toast.success('Account removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove account');
    }
  }

  async function handleToggleMapping(mapping: CopierMapping) {
    try {
      const res = await api.updateStrategyMapping(id, mapping.id, { is_active: !mapping.is_active });
      if (res.success) setMappings((prev) => prev.map((m) => m.id === mapping.id ? res.data : m));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update');
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-terminal-panel rounded w-1/3" />
          <div className="h-4 bg-terminal-panel rounded w-1/2" />
          <div className="h-32 bg-terminal-panel rounded" />
        </div>
      </div>
    );
  }

  if (!strategy) {
    return (
      <div className="p-6 text-center text-terminal-muted">
        <p>Strategy not found.</p>
        <button onClick={() => router.push('/strategies')} className="btn btn-secondary mt-4">
          Back to Strategies
        </button>
      </div>
    );
  }

  const linkedAccountIds = new Set(mappings.map((m) => m.account_id));
  const availableAccounts = accounts.filter((a) => !linkedAccountIds.has(a.id));

  return (
    <div className="p-6 space-y-6">
      {/* Back + header */}
      <div>
        <button
          onClick={() => router.push('/strategies')}
          className="text-xs text-terminal-muted hover:text-terminal-text transition-colors mb-3 flex items-center gap-1"
        >
          ← Strategies
        </button>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            {editingField === 'name' ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveField('name'); if (e.key === 'Escape') setEditingField(null); }}
                  className="text-2xl font-bold bg-terminal-panel border border-terminal-buy rounded px-2 py-1 text-terminal-text focus:outline-none"
                />
                <button onClick={() => saveField('name')} disabled={saving} className="text-xs text-terminal-buy hover:opacity-80">
                  {saving ? '…' : 'Save'}
                </button>
                <button onClick={() => setEditingField(null)} className="text-xs text-terminal-muted hover:text-terminal-text">Cancel</button>
              </div>
            ) : (
              <h1
                className="text-2xl font-bold text-terminal-text cursor-pointer hover:text-terminal-buy transition-colors group"
                onClick={() => setEditingField('name')}
                title="Click to edit"
              >
                {strategy.name}
                <span className="text-xs text-terminal-muted ml-2 opacity-0 group-hover:opacity-100 transition-opacity">✎</span>
              </h1>
            )}
            {editingField === 'desc' ? (
              <div className="flex items-center gap-2 mt-1">
                <input
                  autoFocus
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveField('desc'); if (e.key === 'Escape') setEditingField(null); }}
                  className="text-sm bg-terminal-panel border border-terminal-buy rounded px-2 py-1 text-terminal-text focus:outline-none w-full max-w-md"
                />
                <button onClick={() => saveField('desc')} disabled={saving} className="text-xs text-terminal-buy shrink-0">
                  {saving ? '…' : 'Save'}
                </button>
                <button onClick={() => setEditingField(null)} className="text-xs text-terminal-muted shrink-0">Cancel</button>
              </div>
            ) : (
              <p
                className="text-sm text-terminal-muted mt-1 cursor-pointer hover:text-terminal-text transition-colors"
                onClick={() => setEditingField('desc')}
                title="Click to edit description"
              >
                {strategy.description || <span className="italic">No description — click to add</span>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={strategy.is_active ? 'active' : 'inactive'} />
            <button
              onClick={handleToggleActive}
              className={`text-sm px-3 py-1.5 rounded border transition-colors ${
                strategy.is_active
                  ? 'border-terminal-sell text-terminal-sell hover:bg-terminal-sell/10'
                  : 'border-terminal-buy text-terminal-buy hover:bg-terminal-buy/10'
              }`}
            >
              {strategy.is_active ? 'Disable' : 'Enable'}
            </button>
          </div>
        </div>
      </div>

      {/* Webhook URL */}
      <div className="card space-y-2">
        <h2 className="text-sm font-semibold text-terminal-muted uppercase tracking-wider">Webhook URL</h2>
        <div className="flex items-center gap-2 bg-terminal-panel rounded p-3">
          <code className="text-xs text-terminal-buy flex-1 break-all select-all">{strategy.webhookUrl}</code>
          <button
            onClick={copyWebhookUrl}
            className="btn btn-secondary text-xs shrink-0"
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <p className="text-xs text-terminal-muted">
          Use header <code className="bg-terminal-panel px-1 rounded">x-webhook-secret: {strategy.webhook_secret.slice(0, 8)}…</code> in TradingView alerts.
        </p>
      </div>

      {/* Risk Rules */}
      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-terminal-muted uppercase tracking-wider">Risk Rules</h2>
          <button onClick={() => setShowRuleModal(true)} className="btn btn-secondary text-xs">+ Add Rule</button>
        </div>
        {rules.length === 0 ? (
          <p className="text-sm text-terminal-muted text-center py-4">No risk rules. All trades will pass unchecked.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-terminal-muted text-xs border-b border-terminal-border">
                <th className="pb-2 font-medium">Rule Type</th>
                <th className="pb-2 font-medium">Config</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-terminal-border last:border-0">
                  <td className="py-2 font-medium text-terminal-text">
                    {RULE_TYPES.find((r) => r.value === rule.rule_type)?.label ?? rule.rule_type}
                  </td>
                  <td className="py-2">
                    <code className="text-xs text-terminal-muted bg-terminal-panel px-2 py-0.5 rounded">
                      {JSON.stringify(rule.config)}
                    </code>
                  </td>
                  <td className="py-2">
                    <StatusBadge status={rule.is_active ? 'active' : 'inactive'} />
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => handleDeleteRule(rule.id)}
                      className="text-xs text-terminal-sell/60 hover:text-terminal-sell transition-colors"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Copier Mappings */}
      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-terminal-muted uppercase tracking-wider">Linked Accounts</h2>
          <button
            onClick={() => setShowMappingModal(true)}
            disabled={availableAccounts.length === 0}
            className="btn btn-secondary text-xs disabled:opacity-40"
          >
            + Link Account
          </button>
        </div>
        {mappings.length === 0 ? (
          <p className="text-sm text-terminal-muted text-center py-4">No accounts linked. Alerts will not be traded.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-terminal-muted text-xs border-b border-terminal-border">
                <th className="pb-2 font-medium">Account</th>
                <th className="pb-2 font-medium">Size</th>
                <th className="pb-2 font-medium hidden md:table-cell">Filters</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.id} className="border-b border-terminal-border last:border-0">
                  <td className="py-2">
                    <p className="font-medium text-terminal-text">{m.account_name}</p>
                    <p className="text-xs text-terminal-muted">{m.broker_type}</p>
                  </td>
                  <td className="py-2 text-terminal-muted">
                    {m.fixed_size ? `Fixed: ${m.fixed_size}` : `×${m.multiplier}`}
                  </td>
                  <td className="py-2 hidden md:table-cell text-xs text-terminal-muted">
                    {[m.long_only && 'Long only', m.short_only && 'Short only'].filter(Boolean).join(', ') || 'None'}
                  </td>
                  <td className="py-2">
                    <StatusBadge status={m.is_active ? 'active' : 'inactive'} />
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleToggleMapping(m)}
                        className="text-xs text-terminal-muted hover:text-terminal-text transition-colors"
                      >
                        {m.is_active ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        onClick={() => handleDeleteMapping(m.id)}
                        className="text-xs text-terminal-sell/60 hover:text-terminal-sell transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Rule Modal */}
      {showRuleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-md mx-4 space-y-4">
            <h2 className="text-lg font-bold text-terminal-text">Add Risk Rule</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-terminal-muted mb-1">Rule Type</label>
                <select
                  value={newRuleType}
                  onChange={(e) => {
                    setNewRuleType(e.target.value);
                    setNewRuleConfig(RULE_TYPES.find((r) => r.value === e.target.value)?.hint ?? '{}');
                  }}
                  className="w-full bg-terminal-panel border border-terminal-border rounded px-3 py-2 text-sm text-terminal-text focus:outline-none focus:border-terminal-buy"
                >
                  {RULE_TYPES.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-terminal-muted mb-1">Config (JSON)</label>
                <textarea
                  value={newRuleConfig}
                  onChange={(e) => setNewRuleConfig(e.target.value)}
                  rows={3}
                  className="w-full bg-terminal-panel border border-terminal-border rounded px-3 py-2 text-sm font-mono text-terminal-text focus:outline-none focus:border-terminal-buy resize-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowRuleModal(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={handleAddRule} disabled={addingRule} className="btn btn-primary">
                {addingRule ? 'Adding…' : 'Add Rule'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Mapping Modal */}
      {showMappingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-md mx-4 space-y-4">
            <h2 className="text-lg font-bold text-terminal-text">Link Account</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-terminal-muted mb-1">Account *</label>
                <select
                  value={mappingAccountId}
                  onChange={(e) => setMappingAccountId(e.target.value)}
                  className="w-full bg-terminal-panel border border-terminal-border rounded px-3 py-2 text-sm text-terminal-text focus:outline-none focus:border-terminal-buy"
                >
                  <option value="">Select account…</option>
                  {availableAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({a.broker_type})</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-terminal-muted mb-1">Multiplier</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    value={mappingMultiplier}
                    onChange={(e) => setMappingMultiplier(e.target.value)}
                    className="w-full bg-terminal-panel border border-terminal-border rounded px-3 py-2 text-sm text-terminal-text focus:outline-none focus:border-terminal-buy"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-terminal-muted mb-1">Fixed Size (overrides multiplier)</label>
                  <input
                    type="number"
                    min="1"
                    value={mappingFixedSize}
                    onChange={(e) => setMappingFixedSize(e.target.value)}
                    placeholder="Optional"
                    className="w-full bg-terminal-panel border border-terminal-border rounded px-3 py-2 text-sm text-terminal-text placeholder:text-terminal-muted focus:outline-none focus:border-terminal-buy"
                  />
                </div>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-terminal-text cursor-pointer">
                  <input type="checkbox" checked={mappingLongOnly} onChange={(e) => setMappingLongOnly(e.target.checked)} className="accent-terminal-buy" />
                  Long Only
                </label>
                <label className="flex items-center gap-2 text-sm text-terminal-text cursor-pointer">
                  <input type="checkbox" checked={mappingShortOnly} onChange={(e) => setMappingShortOnly(e.target.checked)} className="accent-terminal-sell" />
                  Short Only
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowMappingModal(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={handleAddMapping} disabled={addingMapping} className="btn btn-primary">
                {addingMapping ? 'Linking…' : 'Link Account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
