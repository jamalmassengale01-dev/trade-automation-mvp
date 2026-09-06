const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export async function apiClient<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const url = `${API_BASE}${path}`;

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// Type-safe API helpers
export const api = {
  // Accounts
  getAccounts: () => apiClient<{ success: boolean; data: unknown[] }>('/api/accounts'),
  getAccount: (id: string) => apiClient<{ success: boolean; data: unknown }>(`/api/accounts/${id}`),
  createAccount: (body: { name: string; broker_type: string; credentials?: Record<string, string>; settings?: Record<string, unknown> }) =>
    apiClient<{ success: boolean; data: unknown }>('/api/accounts', { method: 'POST', body }),
  deleteAccount: (id: string) => apiClient<{ success: boolean; message: string }>(`/api/accounts/${id}`, { method: 'DELETE' }),
  flattenAccount: (id: string) => apiClient<{ success: boolean; message: string }>(`/api/accounts/${id}/flatten`, { method: 'POST' }),
  disableAccount: (id: string) => apiClient<{ success: boolean; message: string }>(`/api/accounts/${id}/disable`, { method: 'POST' }),
  enableAccount: (id: string) => apiClient<{ success: boolean; message: string }>(`/api/accounts/${id}/enable`, { method: 'POST' }),

  // Alerts
  getAlerts: (page = 1, pageSize = 20) =>
    apiClient<{ success: boolean; data: { items: unknown[]; total: number; page: number; pageSize: number; totalPages: number } }>(`/api/alerts?page=${page}&pageSize=${pageSize}`),
  getAlertStats: () => apiClient<{ success: boolean; data: unknown }>('/api/alerts/stats/overview'),

  // Orders
  getTradeRequests: (page = 1, pageSize = 20) =>
    apiClient<{ success: boolean; data: { items: unknown[]; total: number; page: number; pageSize: number; totalPages: number } }>(`/api/orders/requests?page=${page}&pageSize=${pageSize}`),
  getOrders: (page = 1, pageSize = 20) =>
    apiClient<{ success: boolean; data: { items: unknown[]; total: number; page: number; pageSize: number; totalPages: number } }>(`/api/orders?page=${page}&pageSize=${pageSize}`),
  getExecutions: (page = 1, pageSize = 20) =>
    apiClient<{ success: boolean; data: { items: unknown[]; total: number; page: number; pageSize: number; totalPages: number } }>(`/api/orders/executions?page=${page}&pageSize=${pageSize}`),

  // Risk Events
  getRiskEvents: (page = 1, pageSize = 20) =>
    apiClient<{ success: boolean; data: { items: unknown[]; total: number; page: number; pageSize: number; totalPages: number } }>(`/api/risk-events?page=${page}&pageSize=${pageSize}`),
  getRiskStats: () => apiClient<{ success: boolean; data: unknown }>('/api/risk-events/stats/overview'),

  // System
  getSystemStatus: () => apiClient<{ success: boolean; data: unknown }>('/api/system/status'),
  getSystemHealth: () => apiClient<{ success: boolean; data: unknown }>('/api/system/health'),
  getSystemSettings: () => apiClient<{ success: boolean; data: unknown[] }>('/api/system/settings'),
  toggleKillSwitch: (enabled: boolean) =>
    apiClient<{ success: boolean; message: string }>('/api/system/kill-switch', { method: 'POST', body: { enabled } }),

  // Strategies
  getStrategies: () =>
    apiClient<{ success: boolean; data: Strategy[] }>('/api/strategies'),
  createStrategy: (body: { name: string; description?: string }) =>
    apiClient<{ success: boolean; data: Strategy }>('/api/strategies', { method: 'POST', body }),
  getStrategy: (id: string) =>
    apiClient<{ success: boolean; data: Strategy }>(`/api/strategies/${id}`),
  updateStrategy: (id: string, body: { name?: string; description?: string; is_active?: boolean }) =>
    apiClient<{ success: boolean; data: Strategy }>(`/api/strategies/${id}`, { method: 'PATCH', body }),
  deleteStrategy: (id: string) =>
    apiClient<{ success: boolean; message: string }>(`/api/strategies/${id}`, { method: 'DELETE' }),

  // Risk Rules
  getStrategyRules: (strategyId: string) =>
    apiClient<{ success: boolean; data: RiskRule[] }>(`/api/strategies/${strategyId}/risk-rules`),
  addStrategyRule: (strategyId: string, body: { rule_type: string; config: Record<string, unknown> }) =>
    apiClient<{ success: boolean; data: RiskRule }>(`/api/strategies/${strategyId}/risk-rules`, { method: 'POST', body }),
  deleteStrategyRule: (strategyId: string, ruleId: string) =>
    apiClient<{ success: boolean; message: string }>(`/api/strategies/${strategyId}/risk-rules/${ruleId}`, { method: 'DELETE' }),

  // Copier Mappings
  getStrategyMappings: (strategyId: string) =>
    apiClient<{ success: boolean; data: CopierMapping[] }>(`/api/strategies/${strategyId}/copier-mappings`),
  addStrategyMapping: (strategyId: string, body: Partial<CopierMapping> & { account_id: string }) =>
    apiClient<{ success: boolean; data: CopierMapping }>(`/api/strategies/${strategyId}/copier-mappings`, { method: 'POST', body }),
  updateStrategyMapping: (strategyId: string, mappingId: string, body: Partial<CopierMapping>) =>
    apiClient<{ success: boolean; data: CopierMapping }>(`/api/strategies/${strategyId}/copier-mappings/${mappingId}`, { method: 'PATCH', body }),
  deleteStrategyMapping: (strategyId: string, mappingId: string) =>
    apiClient<{ success: boolean; message: string }>(`/api/strategies/${strategyId}/copier-mappings/${mappingId}`, { method: 'DELETE' }),

  // GB LIVE / LaunchPad
  getGbAccounts: () => apiClient<{ success: boolean; data: GbAccount[] }>('/api/gb/accounts'),
  getGbPresets: () => apiClient<{ success: boolean; data: GbPreset[] }>('/api/gb/presets'),
  getGbPreset: (id: string) => apiClient<{ success: boolean; data: GbPreset }>(`/api/gb/presets/${id}`),
  createGbPreset: (body: Partial<GbPreset>) =>
    apiClient<{ success: boolean; data: GbPreset }>('/api/gb/presets', { method: 'POST', body }),
  updateGbPreset: (id: string, body: Partial<GbPreset>) =>
    apiClient<{ success: boolean; data: GbPreset }>(`/api/gb/presets/${id}`, { method: 'PATCH', body }),
  deleteGbPreset: (id: string) =>
    apiClient<{ success: boolean; message: string }>(`/api/gb/presets/${id}`, { method: 'DELETE' }),
  getGbTrades: (page = 1, pageSize = 20) =>
    apiClient<{ success: boolean; data: { items: GbTrade[]; total: number; page: number; pageSize: number; totalPages: number } }>(`/api/gb/trades?page=${page}&pageSize=${pageSize}`),
  getGbAccountTrades: (accountId: string, page = 1, pageSize = 20) =>
    apiClient<{ success: boolean; data: { items: GbTrade[]; total: number; page: number; pageSize: number; totalPages: number } }>(`/api/gb/accounts/${accountId}/trades?page=${page}&pageSize=${pageSize}`),
  assignPreset: (accountId: string, presetId: string | null) =>
    apiClient<{ success: boolean; data: unknown }>(`/api/accounts/${accountId}`, { method: 'PATCH', body: { preset_id: presetId } }),
  simulateGbExit: (tradeId: string, outcome: 'W' | 'W~' | 'L' | 'BE') =>
    apiClient<{ success: boolean; data: GbTrade }>(`/api/gb/trades/${tradeId}/simulate-exit`, { method: 'POST', body: { outcome } }),
};

// ============================================
// SHARED TYPES
// ============================================

export interface Strategy {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  is_active: boolean;
  webhook_secret: string;
  webhookUrl: string;
  risk_rules_count?: number;
  copier_mappings_count?: number;
  created_at: string;
  updated_at: string;
}

export interface RiskRule {
  id: string;
  strategy_id: string;
  rule_type: string;
  config: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CopierMapping {
  id: string;
  strategy_id: string;
  account_id: string;
  account_name?: string;
  broker_type?: string;
  is_active: boolean;
  fixed_size?: number;
  multiplier: number;
  long_only: boolean;
  short_only: boolean;
  allowed_symbols: string[];
  created_at: string;
  updated_at: string;
}

// ============================================
// GB LIVE / LAUNCHPAD TYPES
// ============================================

export interface GbPreset {
  id: string;
  name: string;
  prop_firm: string;
  phase: 'eval' | 'funded';
  start_balance: string | number;
  target_profit: string | number | null;
  max_drawdown: string | number;
  daily_loss_cap: string | number;
  base_risk: string | number;
  max_contracts: number;
  dd_mode: string;
  tp1_r: string | number;
  tp2_r: string | number;
  cap_step: number;
  max_trades_day: number;
  profit_split: string | number;
  step2_mult: string | number;
  step3_mult: string | number;
  step4_mult: string | number;
  pass_zone_buffer: string | number;
  sniper_risk_pct: string | number;
  sniper_tp_r: string | number;
  sniper_max_trades_day: number;
  notes?: string;
}

export interface GbAccountPreset {
  id: string | null;
  name: string | null;
  propFirm: string | null;
  phase: string | null;
  startBalance: number;
  targetProfit: number | null;
  maxDrawdown: number;
  dailyLossCap: number;
  baseRisk: number;
  maxContracts: number;
  capStep: number;
  maxTradesDay: number;
}

export interface GbLastTrade {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  outcome: string | null;
  pnl: number | null;
  exitTime: string | null;
  createdAt: string;
}

export interface GbAccount {
  id: string;
  name: string;
  brokerType: string;
  isActive: boolean;
  isDisabled: boolean;
  phase: string;
  preset: GbAccountPreset;
  ladderStep: number;
  dayRealizedPnl: number;
  cumulativePnl: number;
  remainingTarget: number | null;
  inSniperMode: boolean;
  dayLockedOut: boolean;
  dllRoom: number;
  lastDayKey: string | null;
  tradesToday: number;
  maxTradesDay: number;
  sessions: { london: boolean; nyam: boolean; nypm: boolean };
  lastTrade: GbLastTrade | null;
}

export interface GbTrade {
  id: string;
  broker_account_id: string;
  account_name?: string;
  day_key: string;
  session: 'london' | 'nyam' | 'nypm' | null;
  direction: 'long' | 'short';
  symbol: string;
  root_symbol: string;
  ref_price: string | number | null;
  entry_price: string | number | null;
  stop_pts: string | number;
  sl_price: string | number | null;
  tp1_price: string | number | null;
  tp2_price: string | number | null;
  be_price: string | number | null;
  contracts: number;
  g1_qty: number;
  g2_qty: number;
  step_at_entry: number;
  step_risk: string | number;
  is_sniper: boolean;
  state: 'entry_pending' | 'open' | 'tp1_hit' | 'closing' | 'closed' | 'failed';
  outcome: 'W' | 'W~' | 'L' | 'BE' | 'L!' | null;
  pnl: string | number | null;
  error_message: string | null;
  entry_time: string | null;
  exit_time: string | null;
  created_at: string;
  updated_at: string;
}
