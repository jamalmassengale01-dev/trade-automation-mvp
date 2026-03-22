// ============================================
// TRADINGVIEW WEBHOOK TYPES
// ============================================

export interface TradingViewAlert {
  id: string;
  timestamp: number;
  strategy: string;
  symbol: string;
  action: 'buy' | 'sell' | 'close' | 'reverse';
  contracts?: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  message?: string;
  metadata?: Record<string, unknown>;
}

// ============================================
// BROKER TYPES
// ============================================

export type BrokerType = 'mock' | 'simulated' | 'tradovate' | 'tradier';

export interface BrokerAccount {
  id: string;
  userId: string;
  name: string;
  brokerType: BrokerType;
  credentials: Record<string, string>;
  isActive: boolean;
  isDisabled: boolean;
  settings: AccountSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountSettings {
  fixedSize?: number;
  multiplier: number;
  longOnly: boolean;
  shortOnly: boolean;
  allowedSymbols: string[];
  maxContracts: number;
  maxPositions: number;
}

export interface AccountInfo {
  accountId: string;
  buyingPower: number;
  cashBalance: number;
  equity: number;
  dayTradesRemaining?: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  side: 'long' | 'short';
  avgEntryPrice: number;
  unrealizedPnl: number;
}

export interface Order {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  orderType: 'market' | 'limit' | 'stop' | 'stop_limit';
  limitPrice?: number;
  stopPrice?: number;
  timeInForce: 'day' | 'gtc' | 'ioc';
  status: OrderStatus;
  filledQuantity: number;
  avgFillPrice?: number;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderStatus = 
  | 'pending'
  | 'submitted'
  | 'accepted'
  | 'partially_filled'
  | 'filled'
  | 'canceled'
  | 'rejected'
  | 'expired';

export interface PlaceOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  orderType: 'market' | 'limit' | 'stop' | 'stop_limit';
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: 'day' | 'gtc' | 'ioc';
  stopLoss?: number;
  takeProfit?: number;
}

// ============================================
// STRATEGY TYPES
// ============================================

export interface Strategy {
  id: string;
  userId: string;
  name: string;
  description?: string;
  isActive: boolean;
  webhookSecret: string;
  riskRules: RiskRule[];
  createdAt: Date;
  updatedAt: Date;
}

export interface RiskRule {
  id: string;
  strategyId: string;
  ruleType: RiskRuleType;
  config: Record<string, unknown>;
  isActive: boolean;
}

export type RiskRuleType =
  | 'max_contracts'
  | 'max_positions'
  | 'cooldown'
  | 'session_time'
  | 'daily_loss_limit'
  | 'symbol_whitelist'
  | 'conflicting_position'
  | 'account_disabled'
  | 'kill_switch';

export interface CopierMapping {
  id: string;
  strategyId: string;
  accountId: string;
  isActive: boolean;
  fixedSize?: number;
  multiplier: number;
  longOnly: boolean;
  shortOnly: boolean;
  allowedSymbols: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// TRADE FLOW TYPES
// ============================================

export interface AlertReceived {
  id: string;
  strategyId: string;
  rawPayload: TradingViewAlert;
  isValid: boolean;
  validationError?: string;
  isDuplicate: boolean;
  processedAt?: Date;
  createdAt: Date;
}

export interface TradeRequest {
  id: string;
  alertId: string;
  strategyId: string;
  symbol: string;
  action: 'buy' | 'sell' | 'close' | 'reverse';
  contracts: number;
  stopLoss?: number;
  takeProfit?: number;
  status: TradeRequestStatus;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type TradeRequestStatus = 
  | 'pending'
  | 'risk_checking'
  | 'risk_rejected'
  | 'copying'
  | 'completed'
  | 'failed';

export interface OrderSubmitted {
  id: string;
  tradeRequestId: string;
  accountId: string;
  brokerOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  orderType: string;
  stopLoss?: number;
  takeProfit?: number;
  status: OrderStatus;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Execution {
  id: string;
  orderId: string;
  accountId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  commission?: number;
  executedAt: Date;
}

// ============================================
// RISK EVENT TYPES
// ============================================

export interface RiskEvent {
  id: string;
  type: 'rejection' | 'kill_switch' | 'warning';
  ruleType: RiskRuleType;
  tradeRequestId?: string;
  accountId?: string;
  strategyId?: string;
  message: string;
  details?: Record<string, unknown>;
  createdAt: Date;
}

// ============================================
// AUDIT & SYSTEM TYPES
// ============================================

export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId?: string;
  userId?: string;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

export interface SystemSetting {
  key: string;
  value: string;
  description?: string;
  updatedAt: Date;
  updatedBy?: string;
}

// ============================================
// API RESPONSE TYPES
// ============================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
