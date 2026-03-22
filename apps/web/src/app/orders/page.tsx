'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { SkeletonTable, Skeleton } from '@/components/Skeleton';
import { toast } from '@/components/ToastProvider';

interface Order {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  status: string;
  filled_quantity: number;
  avg_fill_price?: number;
  account_name: string;
  created_at: string;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadOrders();
  }, []);

  async function loadOrders() {
    try {
      setLoading(true);
      const response = await api.getOrders();
      if (response.success) {
        setOrders(response.data as Order[]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders');
      toast.error('Failed to load orders');
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Orders</h1>
          <Skeleton className="h-10 w-24" />
        </div>
        <SkeletonTable rows={8} columns={7} />
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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Orders</h1>
        <button onClick={loadOrders} className="btn-secondary">Refresh</button>
      </div>

      <DataTable
        columns={[
          { 
            key: 'time', 
            header: 'Time',
            render: (order) => (
              <span className="text-gray-900 dark:text-white">
                {new Date(order.created_at).toLocaleString()}
              </span>
            )
          },
          { 
            key: 'symbol', 
            header: 'Symbol',
            render: (order) => (
              <span className="font-medium text-gray-900 dark:text-white">{order.symbol}</span>
            )
          },
          { 
            key: 'side', 
            header: 'Side',
            render: (order) => (
              <span className={`font-medium ${
                order.side === 'buy' 
                  ? 'text-green-600 dark:text-green-400' 
                  : 'text-red-600 dark:text-red-400'
              }`}>
                {order.side.toUpperCase()}
              </span>
            )
          },
          { 
            key: 'quantity', 
            header: 'Qty',
            render: (order) => (
              <span className="text-gray-900 dark:text-white">
                {order.filled_quantity}/{order.quantity}
              </span>
            )
          },
          { 
            key: 'status', 
            header: 'Status',
            render: (order) => <StatusBadge status={order.status} />
          },
          { 
            key: 'price', 
            header: 'Avg Price',
            render: (order) => (
              <span className="text-gray-900 dark:text-white">
                {order.avg_fill_price ? `$${order.avg_fill_price.toFixed(2)}` : '-'}
              </span>
            )
          },
          { 
            key: 'account', 
            header: 'Account',
            render: (order) => (
              <span className="text-gray-900 dark:text-white">{order.account_name}</span>
            )
          },
        ]}
        data={orders}
        keyExtractor={(order) => order.id}
        emptyMessage="No orders yet"
      />
    </div>
  );
}
