'use client';

import { ReactNode } from 'react';

interface Column<T> {
  key: string;
  header: string;
  width?: string;
  render?: (item: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (item: T) => string;
  emptyMessage?: string;
}

export function DataTable<T>({ 
  columns, 
  data, 
  keyExtractor,
  emptyMessage = 'No data available' 
}: DataTableProps<T>) {
  if (data.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-900">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                style={{ width: column.width }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
          {data.map((item) => (
            <tr key={keyExtractor(item)} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
              {columns.map((column) => (
                <td key={`${keyExtractor(item)}-${column.key}`} className="px-6 py-4 whitespace-nowrap text-sm">
                  {column.render 
                    ? column.render(item)
                    : <span className="text-gray-900 dark:text-white">{String((item as Record<string, unknown>)[column.key] ?? '-')}</span>
                  }
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
