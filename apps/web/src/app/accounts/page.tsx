'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { SkeletonTable, Skeleton } from '@/components/Skeleton';
import { toast } from '@/components/ToastProvider';

interface Account {
  id: string;
  name: string;
  broker_type: string;
  is_active: boolean;
  is_disabled: boolean;
  settings: {
    multiplier: number;
    fixedSize?: number;
    maxContracts: number;
    longOnly: boolean;
    shortOnly: boolean;
  };
  created_at: string;
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    try {
      setLoading(true);
      const response = await api.getAccounts();
      if (response.success) {
        setAccounts(response.data as Account[]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounts');
      toast.error('Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }

  async function handleFlatten(id: string, name: string) {
    if (!confirm(`Are you sure you want to flatten all positions in "${name}"?`)) {
      return;
    }
    
    try {
      await toast.promise(
        api.flattenAccount(id),
        {
          loading: `Flattening ${name}...`,
          success: `${name} flattened successfully`,
          error: `Failed to flatten ${name}`,
        }
      );
    } catch {
      // Error handled by toast
    }
  }

  async function handleToggleDisable(account: Account) {
    const action = account.is_disabled ? 'enable' : 'disable';
    const newState = !account.is_disabled;
    
    if (!confirm(`Are you sure you want to ${action} "${account.name}"?`)) {
      return;
    }
    
    try {
      await toast.promise(
        newState ? api.disableAccount(account.id) : api.enableAccount(account.id),
        {
          loading: `${action === 'disable' ? 'Disabling' : 'Enabling'} ${account.name}...`,
          success: `${account.name} ${action}d successfully`,
          error: `Failed to ${action} ${account.name}`,
        }
      );
      
      await loadAccounts();
    } catch {
      // Error handled by toast
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Broker Accounts</h1>
          <Skeleton className="h-10 w-24" />
        </div>
        <SkeletonTable rows={5} columns={6} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-700 dark:text-red-400">
        Error: {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Broker Accounts</h1>
        <button onClick={loadAccounts} className="btn-secondary">Refresh</button>
      </div>

      <DataTable
        columns={[
          { key: 'name', header: 'Name' },
          { 
            key: 'broker_type', 
            header: 'Broker',
            render: (account) => (
              <span className="capitalize text-gray-900 dark:text-white">{account.broker_type}</span>
            )
          },
          { 
            key: 'status', 
            header: 'Status',
            render: (account) => (
              <div className="space-y-1">
                <StatusBadge status={account.is_active ? 'active' : 'inactive'} />
                {account.is_disabled && <StatusBadge status="disabled" />}
              </div>
            )
          },
          { 
            key: 'sizing', 
            header: 'Sizing',
            render: (account) => (
              <div className="text-sm text-gray-900 dark:text-white">
                {account.settings.fixedSize ? (
                  <span>Fixed: {account.settings.fixedSize}</span>
                ) : (
                  <span>Multiplier: {account.settings.multiplier}x</span>
                )}
                <span className="text-gray-500 dark:text-gray-400 ml-2">(Max: {account.settings.maxContracts})</span>
              </div>
            )
          },
          { 
            key: 'restrictions', 
            header: 'Restrictions',
            render: (account) => (
              <div className="text-sm">
                {account.settings.longOnly && <span className="badge badge-info mr-1">Long Only</span>}
                {account.settings.shortOnly && <span className="badge badge-info">Short Only</span>}
                {!account.settings.longOnly && !account.settings.shortOnly && <span className="text-gray-400">None</span>}
              </div>
            )
          },
          {
            key: 'actions',
            header: 'Actions',
            width: '250px',
            render: (account) => (
              <div className="flex gap-2">
                <button
                  onClick={() => handleFlatten(account.id, account.name)}
                  className="text-sm px-3 py-1 bg-orange-100 text-orange-700 rounded hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:hover:bg-orange-900/50 transition-colors"
                >
                  Flatten
                </button>
                <button
                  onClick={() => handleToggleDisable(account)}
                  className={`text-sm px-3 py-1 rounded transition-colors ${
                    account.is_disabled 
                      ? 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50' 
                      : 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                  }`}
                >
                  {account.is_disabled ? 'Enable' : 'Disable'}
                </button>
              </div>
            )
          },
        ]}
        data={accounts}
        keyExtractor={(account) => account.id}
        emptyMessage="No accounts found"
      />
    </div>
  );
}
