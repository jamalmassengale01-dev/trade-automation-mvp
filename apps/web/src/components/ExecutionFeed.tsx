'use client';

import { useState, useEffect, useRef } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';

const WS_URL =
  (typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').replace(/^http/, 'ws')
    : 'ws://localhost:3001');

type EventType =
  | 'alert_received'
  | 'trade_created'
  | 'order_submitted'
  | 'execution_filled'
  | 'risk_event'
  | 'kill_switch';

interface FeedEvent {
  id: string;
  type: EventType;
  data: Record<string, unknown>;
  timestamp: string;
}

const EVENT_LABELS: Record<EventType, string> = {
  alert_received:  'ALERT',
  trade_created:   'TRADE',
  order_submitted: 'ORDER',
  execution_filled:'FILL',
  risk_event:      'RISK',
  kill_switch:     'KILL',
};

const isBuyish = (event: FeedEvent) => {
  const action = (event.data.action as string | undefined)?.toLowerCase();
  const type = event.type;
  if (type === 'risk_event' || type === 'kill_switch') return false;
  return action === 'buy' || action === 'close' || type === 'execution_filled';
};

const isSellish = (event: FeedEvent) => {
  const type = event.type;
  if (type === 'risk_event' || type === 'kill_switch') return true;
  const action = (event.data.action as string | undefined)?.toLowerCase();
  return action === 'sell' || action === 'reverse';
};

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return '';
  }
}

const MAX_EVENTS = 50;

export function ExecutionFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const listRef = useRef<HTMLUListElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const { status } = useWebSocket({
    url: WS_URL,
    reconnect: true,
    maxReconnects: 10,
    onMessage: (msg) => {
      const raw = msg as unknown as { type: string; data: Record<string, unknown>; timestamp: string };
      const feedEvent: FeedEvent = {
        id: `${Date.now()}-${Math.random()}`,
        type: raw.type as EventType,
        data: raw.data ?? {},
        timestamp: raw.timestamp ?? new Date().toISOString(),
      };
      setEvents((prev) => {
        const next = [feedEvent, ...prev];
        return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
      });
    },
  });

  // Auto-scroll to top (newest) when new events arrive
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [events, autoScroll]);

  const isConnected = status === 'connected';

  return (
    <div className="card p-0 overflow-hidden flex flex-col" style={{ maxHeight: '320px' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-terminal-text">Live Execution Feed</span>
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              isConnected ? 'bg-terminal-buy animate-pulse' : 'bg-terminal-muted'
            }`}
          />
          <span className="text-xs text-terminal-muted">{isConnected ? 'Live' : status}</span>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-xs text-terminal-muted cursor-pointer">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-terminal-buy"
            />
            Auto-scroll
          </label>
          {events.length > 0 && (
            <button
              onClick={() => setEvents([])}
              className="text-xs text-terminal-muted hover:text-terminal-sell transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Event list */}
      <ul
        ref={listRef}
        className="flex-1 overflow-y-auto font-mono text-xs divide-y divide-terminal-border/40"
      >
        {events.length === 0 ? (
          <li className="flex items-center justify-center h-full py-10 text-terminal-muted gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-terminal-muted animate-pulse" />
            Waiting for live data…
          </li>
        ) : (
          events.map((event) => {
            const buy = isBuyish(event);
            const sell = isSellish(event);
            return (
              <li
                key={event.id}
                className={`px-4 py-2 flex items-start gap-3 hover:bg-terminal-panel/60 transition-colors ${
                  buy ? 'border-l-2 border-terminal-buy' : sell ? 'border-l-2 border-terminal-sell' : 'border-l-2 border-transparent'
                }`}
              >
                {/* Time */}
                <span className="text-terminal-muted shrink-0 w-20">{formatTime(event.timestamp)}</span>

                {/* Type chip */}
                <span
                  className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide ${
                    buy
                      ? 'bg-terminal-buy/20 text-terminal-buy'
                      : sell
                      ? 'bg-terminal-sell/20 text-terminal-sell'
                      : 'bg-terminal-muted/20 text-terminal-muted'
                  }`}
                >
                  {EVENT_LABELS[event.type] ?? event.type.toUpperCase()}
                </span>

                {/* Details */}
                <span className="text-terminal-muted flex-1 truncate">
                  {event.data.symbol && (
                    <span className="text-terminal-text font-semibold mr-1">{String(event.data.symbol)}</span>
                  )}
                  {event.data.action && (
                    <span className={`mr-1 ${buy ? 'text-terminal-buy' : sell ? 'text-terminal-sell' : ''}`}>
                      {String(event.data.action).toUpperCase()}
                    </span>
                  )}
                  {event.data.contracts && <span className="mr-1">{String(event.data.contracts)}ct</span>}
                  {event.data.message && <span className="italic">{String(event.data.message)}</span>}
                  {event.data.status && <span className="ml-1 text-terminal-muted">[{String(event.data.status)}]</span>}
                </span>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
