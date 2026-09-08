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
    // The session lives in an httpOnly cookie, which the browser only attaches
    // cross-origin when credentials are explicitly included.
    credentials: 'include',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    const err = new Error(error.error || `HTTP ${response.status}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  return response.json();
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'customer';
}

// Type-safe API helpers
export const api = {
  // Auth
  login: (email: string, password: string) =>
    apiClient<{ success: boolean; data: AuthUser }>('/api/auth/login', {
      method: 'POST', body: { email, password },
    }),
  logout: () => apiClient<{ success: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => apiClient<{ success: boolean; data: AuthUser }>('/api/auth/me'),
  changePassword: (current_password: string, new_password: string) =>
    apiClient<{ success: boolean; message: string }>('/api/auth/change-password', {
      method: 'POST', body: { current_password, new_password },
    }),

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
  // Catalog
  getCatalog: () => apiClient<{ success: boolean; data: CatalogEntry[] }>('/api/catalog'),
  getCatalogVersions: (id: string) =>
    apiClient<{ success: boolean; data: CatalogVersion[] }>(`/api/catalog/${id}/versions`),
  getCatalogImpact: (id: string) =>
    apiClient<{ success: boolean; data: PublishImpact }>(`/api/catalog/${id}/impact`),
  getCatalogDrift: () =>
    apiClient<{ success: boolean; data: CatalogDrift[] }>('/api/catalog/drift'),
  createCatalogEntry: (body: Record<string, unknown>) =>
    apiClient<{ success: boolean; data: { entry: CatalogEntry; findings: PropFirmFinding[] } }>(
      '/api/catalog', { method: 'POST', body }),
  updateCatalogEntry: (id: string, body: Record<string, unknown>) =>
    apiClient<{ success: boolean; data: CatalogEntry }>(`/api/catalog/${id}`, { method: 'PATCH', body }),
  publishCatalogVersion: (id: string, body: Record<string, unknown>) =>
    apiClient<{ success: boolean; data: { version: number; changedFields: string[]; findings: PropFirmFinding[] } }>(
      `/api/catalog/${id}/versions`, { method: 'POST', body }),
  assignCatalogEntry: (accountId: string, entryId: string) =>
    apiClient<{ success: boolean; data: { presetId: string; version: number; entryName: string } }>(
      `/api/catalog/assign/${accountId}`, { method: 'POST', body: { entry_id: entryId } }),

  calculatePropFirm: (body: PropFirmInputs) =>
    apiClient<{ success: boolean; data: PropFirmCalcResult }>('/api/gb/presets/calculate', { method: 'POST', body }),
  verifyGbPreset: (id: string, body: { verified_by?: string; source_url?: string; stale_after_days?: number }) =>
    apiClient<{ success: boolean; data: GbPreset }>(`/api/gb/presets/${id}/verify`, { method: 'POST', body }),
  getReconciliation: () =>
    apiClient<{ success: boolean; data: RuleCheck[] }>('/api/gb/reconciliation'),
  reconcileAll: () =>
    apiClient<{ success: boolean; data: { checked: number; halts: number; warns: number; errors: number } }>('/api/gb/reconcile', { method: 'POST' }),
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

export interface CatalogEntry {
  id: string;
  preset_id: string;
  display_name: string;
  prop_firm: string;
  account_size: number;
  phase: 'eval' | 'funded';
  description: string | null;
  is_published: boolean;
  sort_order: number;
  current_version: number;
  accounts_using: number;
  start_balance: string | number;
  target_profit: string | number | null;
  max_drawdown: string | number;
  daily_loss_cap: string | number;
  base_risk: string | number;
  max_contracts: number;
  dd_mode: string;
  cap_step: number;
  max_trades_day: number;
  tp1_r: string | number;
  tp2_r: string | number;
  profit_split: string | number;
  verified_at: string | null;
  stale_after_days: number;
}

export interface CatalogVersion {
  id: string;
  entry_id: string;
  version: number;
  preset_values: Record<string, unknown>;
  derived_from: Record<string, unknown> | null;
  findings: PropFirmFinding[];
  changelog: string | null;
  published_by_name: string | null;
  published_at: string;
  effective_from: string | null;
}

export interface OpenTradeOnEntry {
  trade_id: string;
  account_id: string;
  account_name: string;
  symbol: string;
  direction: string;
  state: string;
  step_at_entry: number;
  entry_time: string | null;
}

export interface PublishImpact {
  entryId: string;
  accountsUsing: number;
  openTrades: OpenTradeOnEntry[];
}

export interface CatalogDrift {
  id: string;
  name: string;
  catalog_entry_id: string;
  catalog_version_at_assign: number;
  current_version: number;
  display_name: string;
}

// ---- Prop firm calculator ----

export interface PropFirmInputs {
  startBalance: number;
  targetProfit: number;
  maxDrawdown: number;
  dailyLossCap: number;
  ddMode: string;
  phase: 'eval' | 'funded';
  maxContracts: number;
  minTradingDays?: number;
  evalExpiryDays?: number;
  consistencyPct?: number;
  minPayout?: number;
  safetyNetBuffer?: number;
  profitSplit?: number;
  riskDivisor?: number;
  riskRounding?: 'ceil' | 'floor' | 'nearest';
  baseRiskOverride?: number;
  stepMultipliers?: { step2: number; step3: number; step4: number };
  capStep?: number;
  maxTradesDay?: number;
  tp1R?: number;
  tp2R?: number;
  symbol?: string;
  typicalStopPts?: number;
  assumedWinRate?: number;
  tradesPerDay?: number;
}

export interface LadderRung {
  step: number;
  multiplier: number;
  nominalRisk: number;
  contracts: number;
  uncappedContracts: number;
  actualRisk: number;
  reachableSameDay: boolean;
  dllRoomBefore: number;
  contractCapBinds: boolean;
}

export interface ProjectionRow {
  winRate: number;
  expectancyR: number;
  expectedPerTrade: number;
  expectedPerDay: number;
  daysToTarget: number | null;
}

export interface PropFirmFinding {
  id: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface PropFirmCalcResult {
  rules: {
    baseRisk: number;
    fullLadderNominalRisk: number;
    maxReachableStep: number;
    worstCaseDayLoss: number;
    survivableMaxLossDays: number;
    ladder: LadderRung[];
    safetyNetBalance: number | null;
    minBalanceForPayout: number | null;
    targetBalance: number;
    maxCompliantDayAtTarget: number | null;
    consistencyCurve: Array<{ dayPnl: number; minTotalProfit: number }> | null;
    avgWinR: number;
    partialWinR: number;
    breakevenWinRate: number;
    instrument: { root: string; name: string; tickSize: number; pointValue: number };
    typicalStopPts: number;
  };
  projections: {
    assumedWinRate: number;
    tradesPerDay: number;
    base: ProjectionRow;
    sensitivity: ProjectionRow[];
    bindingDaysToPass: number | null;
    tradingDaysBeforeExpiry: number | null;
    caveat: string;
  };
  findings: PropFirmFinding[];
  preset: Record<string, string | number>;
  derived_from: Record<string, unknown>;
}

export interface RuleCheck {
  broker_account_id: string;
  account_name: string;
  preset_id: string | null;
  checked_at: string;
  verdict: 'ok' | 'warn' | 'halt' | 'error';
  broker_balance: string | number | null;
  broker_realized_pnl: string | number | null;
  broker_equity: string | number | null;
  tracked_day_pnl: string | number | null;
  tracked_cum_pnl: string | number | null;
  implied_start: string | number | null;
  findings: Array<{ id: string; severity: 'halt' | 'warn' | 'info'; message: string }>;
  error_message: string | null;
}

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
  verified_at?: string | null;
  verified_by?: string | null;
  source_url?: string | null;
  stale_after_days?: number;
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
