import { WebSocket } from 'ws';
import logger from '../utils/logger';

const broadcastLogger = logger.child({ context: 'WSBroadcaster' });

export type WsEventType =
  | 'alert_received'
  | 'trade_created'
  | 'order_submitted'
  | 'execution_filled'
  | 'risk_event'
  | 'kill_switch';

export interface WsEvent {
  type: WsEventType;
  data: Record<string, unknown>;
  timestamp: string;
}

class WsBroadcaster {
  private clients = new Set<WebSocket>();

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    broadcastLogger.debug('WS client connected', { total: this.clients.size });
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
    broadcastLogger.debug('WS client disconnected', { total: this.clients.size });
  }

  broadcast(type: WsEventType, data: Record<string, unknown>): void {
    if (this.clients.size === 0) return;

    const event: WsEvent = { type, data, timestamp: new Date().toISOString() };
    const payload = JSON.stringify(event);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }

    broadcastLogger.debug('Broadcast sent', { type, clients: this.clients.size });
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

export const broadcaster = new WsBroadcaster();
