'use client';

import { useEffect, useState } from 'react';

interface LiveIndicatorProps {
  isConnected?: boolean;
  lastUpdate?: Date;
  showTime?: boolean;
}

export function LiveIndicator({ 
  isConnected = true, 
  lastUpdate,
  showTime = true 
}: LiveIndicatorProps) {
  const [pulse, setPulse] = useState(true);
  const [timeAgo, setTimeAgo] = useState('');

  useEffect(() => {
    const interval = setInterval(() => {
      setPulse(p => !p);
      
      if (lastUpdate) {
        const seconds = Math.floor((Date.now() - lastUpdate.getTime()) / 1000);
        if (seconds < 60) {
          setTimeAgo(`${seconds}s ago`);
        } else if (seconds < 3600) {
          setTimeAgo(`${Math.floor(seconds / 60)}m ago`);
        } else {
          setTimeAgo(`${Math.floor(seconds / 3600)}h ago`);
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [lastUpdate]);

  return (
    <div className="flex items-center gap-2">
      <span 
        className={`relative flex h-3 w-3 ${isConnected ? '' : 'opacity-50'}`}
      >
        {isConnected && (
          <span 
            className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 transition-colors ${
              pulse ? 'bg-green-400' : 'bg-green-500'
            }`}
          />
        )}
        <span 
          className={`relative inline-flex rounded-full h-3 w-3 transition-colors ${
            isConnected ? 'bg-green-500' : 'bg-red-500'
          }`}
        />
      </span>
      <span className="text-sm text-gray-500 dark:text-gray-400">
        {isConnected ? (
          showTime && timeAgo ? `Live • ${timeAgo}` : 'Live'
        ) : (
          'Disconnected'
        )}
      </span>
    </div>
  );
}

export function ConnectionStatus({ 
  status,
  message 
}: { 
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  message?: string;
}) {
  const statusConfig = {
    connected: { color: 'bg-green-500', text: 'text-green-700 dark:text-green-400', label: 'Connected' },
    disconnected: { color: 'bg-red-500', text: 'text-red-700 dark:text-red-400', label: 'Disconnected' },
    connecting: { color: 'bg-yellow-500 animate-pulse', text: 'text-yellow-700 dark:text-yellow-400', label: 'Connecting...' },
    error: { color: 'bg-red-500', text: 'text-red-700 dark:text-red-400', label: 'Error' },
  };

  const config = statusConfig[status];

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-100 dark:bg-gray-800">
      <span className={`w-2 h-2 rounded-full ${config.color}`} />
      <span className={`text-sm font-medium ${config.text}`}>
        {config.label}
      </span>
      {message && (
        <span className="text-sm text-gray-500 dark:text-gray-400 ml-1">
          • {message}
        </span>
      )}
    </div>
  );
}
