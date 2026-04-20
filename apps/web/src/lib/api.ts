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
