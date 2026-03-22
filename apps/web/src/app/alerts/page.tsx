'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { SkeletonTable, Skeleton } from '@/components/Skeleton';
import { toast } from '@/components/ToastProvider';

interface Alert {
  id: string;
  alert_id: string;
  strategy_id: string;
  symbol: string;
  action: string;
  is_valid: boolean;
  is_duplicate: boolean;
  processed_at: string | null;
  created_at: string;
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAlerts();
  }, []);

  async function loadAlerts() {
    try {
      setLoading(true);
      const response = await api.getAlerts();
      if (response.success) {
        setAlerts(response.data as Alert[]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alerts');
      toast.error('Failed to load alerts');
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Alerts</h1>
          <Skeleton className="h-10 w-24" />
        </div>
        <SkeletonTable rows={8} columns={6} />
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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">TradingView Alerts</h1>
        <button onClick={loadAlerts} className="btn-secondary">Refresh</button>
      </div>

      <DataTable
        columns={[
          { 
            key: 'time', 
            header: 'Time',
            render: (alert) => (
              <span className="text-gray-900 dark:text-white">
                {new Date(alert.created_at).toLocaleString()}
              </span>
            )
          },
          { 
            key: 'symbol', 
            header: 'Symbol',
            render: (alert) => (
              <span className="font-medium text-gray-900 dark:text-white">{alert.symbol}</span>
            )
          },
          { 
            key: 'action', 
            header: 'Action',
            render: (alert) => (
              <span className="capitalize font-medium text-gray-900 dark:text-white">
                {alert.action}
              </span>
            )
          },
          { 
            key: 'status', 
            header: 'Status',
            render: (alert) => {
              if (alert.is_duplicate) return <StatusBadge status="duplicate" />;
              if (!alert.is_valid) return <StatusBadge status="invalid" />;
              if (alert.processed_at) return <StatusBadge status="completed" />;
              return <StatusBadge status="pending" />;
            }
          },
          { 
            key: 'processed', 
            header: 'Processed',
            render: (alert) => (
              <span className="text-gray-900 dark:text-white">
                {alert.processed_at 
                  ? new Date(alert.processed_at).toLocaleTimeString() 
                  : '-'}
              </span>
            )
          },
        ]}
        data={alerts}
        keyExtractor={(alert) => alert.id}
        emptyMessage="No alerts received yet"
      />
    </div>
  );
}
