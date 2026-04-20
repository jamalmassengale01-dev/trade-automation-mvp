'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, Strategy } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import { SkeletonStatCard } from '@/components/Skeleton';
import { toast } from '@/components/ToastProvider';

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => { loadStrategies(); }, []);

  async function loadStrategies() {
    try {
      setLoading(true);
      const res = await api.getStrategies();
      if (res.success) setStrategies(res.data);
    } catch {
      toast.error('Failed to load strategies');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await api.createStrategy({ name: newName.trim(), description: newDesc.trim() || undefined });
      if (res.success) {
        setStrategies((prev) => [res.data, ...prev]);
        setShowModal(false);
        setNewName('');
        setNewDesc('');
        toast.success(`Strategy "${res.data.name}" created`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create strategy');
    } finally {
      setCreating(false);
    }
  }

  async function handleToggle(strategy: Strategy) {
    setToggling(strategy.id);
    try {
      const res = await api.updateStrategy(strategy.id, { is_active: !strategy.is_active });
      if (res.success) {
        setStrategies((prev) => prev.map((s) => s.id === strategy.id ? res.data : s));
        toast.success(`Strategy ${res.data.is_active ? 'enabled' : 'disabled'}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle strategy');
    } finally {
      setToggling(null);
    }
  }

  async function handleDelete(strategy: Strategy) {
    if (!window.confirm(`Delete strategy "${strategy.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteStrategy(strategy.id);
      setStrategies((prev) => prev.filter((s) => s.id !== strategy.id));
      toast.success('Strategy deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete strategy');
    }
  }

  function copyUrl(strategyId: string, url: string) {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(strategyId);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-terminal-text">Strategies</h1>
          <p className="text-sm text-terminal-muted mt-1">
            Each strategy has its own webhook URL, risk rules, and account mappings.
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="btn btn-primary"
        >
          + New Strategy
        </button>
      </div>

      {/* Strategy list */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4">
          {[1, 2, 3].map((i) => <SkeletonStatCard key={i} />)}
        </div>
      ) : strategies.length === 0 ? (
        <div className="card text-center py-16 text-terminal-muted">
          <p className="text-4xl mb-4">⚡</p>
          <p className="font-medium text-terminal-text">No strategies yet</p>
          <p className="text-sm mt-1">Create your first strategy to get a unique webhook URL.</p>
          <button onClick={() => setShowModal(true)} className="btn btn-primary mt-4">
            Create Strategy
          </button>
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-terminal-border text-left text-terminal-muted">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Rules</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Accounts</th>
                <th className="px-4 py-3 font-medium">Webhook URL</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((strategy) => (
                <tr
                  key={strategy.id}
                  className="border-b border-terminal-border last:border-0 hover:bg-terminal-panel transition-colors"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/strategies/${strategy.id}`}
                      className="font-medium text-terminal-text hover:text-terminal-buy transition-colors"
                    >
                      {strategy.name}
                    </Link>
                    {strategy.description && (
                      <p className="text-xs text-terminal-muted mt-0.5 truncate max-w-[200px]">
                        {strategy.description}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={strategy.is_active ? 'active' : 'inactive'} />
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-terminal-muted">
                    {strategy.risk_rules_count ?? 0}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-terminal-muted">
                    {strategy.copier_mappings_count ?? 0}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <code className="text-xs text-terminal-muted bg-terminal-panel px-2 py-1 rounded truncate max-w-[180px]">
                        …/tradingview/{strategy.id.slice(0, 8)}…
                      </code>
                      <button
                        onClick={() => copyUrl(strategy.id, strategy.webhookUrl)}
                        className="text-xs text-terminal-muted hover:text-terminal-buy transition-colors shrink-0"
                        title="Copy webhook URL"
                      >
                        {copied === strategy.id ? '✓' : '⎘'}
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleToggle(strategy)}
                        disabled={toggling === strategy.id}
                        className={`text-xs px-2 py-1 rounded border transition-colors ${
                          strategy.is_active
                            ? 'border-terminal-sell text-terminal-sell hover:bg-terminal-sell/10'
                            : 'border-terminal-buy text-terminal-buy hover:bg-terminal-buy/10'
                        }`}
                      >
                        {toggling === strategy.id ? '…' : strategy.is_active ? 'Disable' : 'Enable'}
                      </button>
                      <Link
                        href={`/strategies/${strategy.id}`}
                        className="text-xs px-2 py-1 rounded border border-terminal-border text-terminal-muted hover:text-terminal-text hover:border-terminal-text transition-colors"
                      >
                        Edit
                      </Link>
                      <button
                        onClick={() => handleDelete(strategy)}
                        className="text-xs px-2 py-1 rounded border border-transparent text-terminal-sell/60 hover:text-terminal-sell hover:border-terminal-sell/40 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Strategy Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-md mx-4 space-y-4">
            <h2 className="text-lg font-bold text-terminal-text">New Strategy</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-terminal-muted mb-1">Name *</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  placeholder="e.g. Momentum Scalper"
                  className="w-full bg-terminal-panel border border-terminal-border rounded px-3 py-2 text-sm text-terminal-text placeholder:text-terminal-muted focus:outline-none focus:border-terminal-buy"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-terminal-muted mb-1">Description</label>
                <textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Optional description…"
                  rows={2}
                  className="w-full bg-terminal-panel border border-terminal-border rounded px-3 py-2 text-sm text-terminal-text placeholder:text-terminal-muted focus:outline-none focus:border-terminal-buy resize-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => { setShowModal(false); setNewName(''); setNewDesc(''); }}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="btn btn-primary"
              >
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
