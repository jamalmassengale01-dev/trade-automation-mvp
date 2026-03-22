// Re-export all types from shared package
export * from '@trade-automation/shared-types';

// API-specific types
export interface QueueJob<T = unknown> {
  id: string;
  name: string;
  data: T;
  opts?: {
    delay?: number;
    attempts?: number;
    backoff?: {
      type: 'fixed' | 'exponential';
      delay: number;
    };
  };
}

export interface WebhookConfig {
  secret: string;
  maxRetries: number;
  timeoutMs: number;
}

export interface RiskCheckResult {
  passed: boolean;
  ruleType?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface CopierResult {
  accountId: string;
  success: boolean;
  orderId?: string;
  error?: string;
}

export interface TradeSignal {
  symbol: string;
  action: 'buy' | 'sell' | 'close' | 'reverse';
  contracts: number;
  stopLoss?: number;
  takeProfit?: number;
}
