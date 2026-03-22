'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface WebSocketMessage {
  type: string;
  data: unknown;
  timestamp: number;
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface UseWebSocketOptions {
  url: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnects?: number;
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
}

export function useWebSocket({
  url,
  reconnect = true,
  reconnectInterval = 5000,
  maxReconnects = 5,
  onMessage,
  onConnect,
  onDisconnect,
  onError,
}: UseWebSocketOptions) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectCountRef = useRef(0);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isManualCloseRef = useRef(false);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    setStatus('connecting');
    
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus('connected');
        reconnectCountRef.current = 0;
        setLastUpdate(new Date());
        onConnect?.();
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WebSocketMessage;
          setLastMessage(message);
          setLastUpdate(new Date());
          onMessage?.(message);
        } catch {
          const message: WebSocketMessage = {
            type: 'raw',
            data: event.data,
            timestamp: Date.now(),
          };
          setLastMessage(message);
          setLastUpdate(new Date());
          onMessage?.(message);
        }
      };

      ws.onclose = () => {
        setStatus('disconnected');
        onDisconnect?.();

        if (!isManualCloseRef.current && reconnect && reconnectCountRef.current < maxReconnects) {
          reconnectCountRef.current++;
          reconnectTimerRef.current = setTimeout(() => {
            connect();
          }, reconnectInterval);
        }
      };

      ws.onerror = (error) => {
        setStatus('error');
        onError?.(error);
      };
    } catch (error) {
      setStatus('error');
      console.error('WebSocket connection error:', error);
    }
  }, [url, reconnect, reconnectInterval, maxReconnects, onMessage, onConnect, onDisconnect, onError]);

  const disconnect = useCallback(() => {
    isManualCloseRef.current = true;
    
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setStatus('disconnected');
  }, []);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(typeof data === 'string' ? data : JSON.stringify(data));
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && status === 'disconnected') {
        reconnectCountRef.current = 0;
        isManualCloseRef.current = false;
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [status, connect]);

  return {
    status,
    lastMessage,
    lastUpdate,
    connect,
    disconnect,
    send,
    isConnected: status === 'connected',
  };
}

// Hook for simulated real-time updates (polling fallback)
export function useRealtimePolling<T>(
  fetcher: () => Promise<T>,
  interval = 5000
) {
  const [data, setData] = useState<T | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const fetch = async () => {
      if (isLoading) return;
      
      setIsLoading(true);
      try {
        const result = await fetcher();
        if (isMounted) {
          setData(result);
          setLastUpdate(new Date());
        }
      } catch (error) {
        console.error('Polling error:', error);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    fetch();

    const timer = setInterval(fetch, interval);

    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [fetcher, interval]);

  return { data, lastUpdate, isLoading };
}
