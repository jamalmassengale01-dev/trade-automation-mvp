'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { SkeletonTable, Skeleton } from '@/components/Skeleton';
import { toast } from '@/components/ToastProvider';

interface RiskEvent {
  id: string;
  type: string;
  rule_type: string;
  message: string;
  symbol?: string;
  account_name?: string;
  created_at: string;
}

export default function RiskEventsPage() {
  const [events, setEvents] = useState<RiskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadEvents();
  }, []);

  async function loadEvents() {
    try {
      setLoading(true);
      const response = await api.getRiskEvents();
      if (response.success) {
        setEvents(response.data as RiskEvent[]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load risk events');
      toast.error('Failed to load risk events');
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Risk Events</h1>
          <Skeleton className="h-10 w-24" />
        </div>
        <SkeletonTable rows={6} columns={5} />
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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Risk Events</h1>
        <button onClick={loadEvents} className="btn-secondary">Refresh</button>
      </div>

      {events.length > 0 && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
          <p className="text-yellow-800 dark:text-yellow-400">
            ⚠️ {events.length} risk event{events.length !== 1 ? 's' : ''} detected in the last 24 hours
          </p>
        </div>
      )}

      <DataTable
        columns={[
          { 
            key: 'time', 
            header: 'Time',
            render: (event) => (
              <span className="text-gray-900 dark:text-white">
                {new Date(event.created_at).toLocaleString()}
              </span>
            )
          },
          { 
            key: 'type', 
            header: 'Type',
            render: (event) => {
              const statusMap: Record<string, string> = {
                'kill_switch': 'kill_switch',
                'rejection': 'rejected',
                'warning': 'pending',
              };
              return <StatusBadge status={statusMap[event.type] || event.type} />;
            }
          },
          { 
            key: 'rule', 
            header: 'Rule',
            render: (event) => (
              <span className="text-gray-900 dark:text-white capitalize">
                {event.rule_type.replace(/_/g, ' ')}
              </span>
            )
          },
          { 
            key: 'symbol', 
            header: 'Symbol',
            render: (event) => (
              <span className="font-medium text-gray-900 dark:text-white">
                {event.symbol || '-'}
              </span>
            )
          },
          { 
            key: 'message', 
            header: 'Message',
            render: (event) => (
              <span className="text-gray-900 dark:text-white">{event.message}</span>
            )
          },
        ]}
        data={events}
        keyExtractor={(event) => event.id}
        emptyMessage="No risk events - all clear!"
      />
    </div>
  );
}
