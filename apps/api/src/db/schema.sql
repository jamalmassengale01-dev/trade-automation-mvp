-- ============================================
-- TRADE AUTOMATION MVP - DATABASE SCHEMA
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- USERS
-- ============================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255), -- nullable for MVP (no auth)
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- BROKER ACCOUNTS
-- ============================================
CREATE TABLE broker_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    broker_type VARCHAR(50) NOT NULL CHECK (broker_type IN ('mock', 'simulated', 'tradovate', 'tradier')),
    credentials JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    is_disabled BOOLEAN DEFAULT false,
    settings JSONB DEFAULT '{
        "multiplier": 1,
        "longOnly": false,
        "shortOnly": false,
        "allowedSymbols": [],
        "maxContracts": 100,
        "maxPositions": 10
    }',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- STRATEGIES
-- ============================================
CREATE TABLE strategies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    webhook_secret VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- RISK RULES
-- ============================================
CREATE TABLE risk_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    strategy_id UUID REFERENCES strategies(id) ON DELETE CASCADE,
    rule_type VARCHAR(50) NOT NULL CHECK (rule_type IN (
        'max_contracts', 'max_positions', 'cooldown', 'session_time',
        'daily_loss_limit', 'symbol_whitelist', 'conflicting_position',
        'account_disabled', 'kill_switch'
    )),
    config JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- COPIER MAPPINGS
-- ============================================
CREATE TABLE copier_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    strategy_id UUID REFERENCES strategies(id) ON DELETE CASCADE,
    account_id UUID REFERENCES broker_accounts(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT true,
    fixed_size INTEGER,
    multiplier DECIMAL(10,4) DEFAULT 1.0,
    long_only BOOLEAN DEFAULT false,
    short_only BOOLEAN DEFAULT false,
    allowed_symbols TEXT[] DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(strategy_id, account_id)
);

-- ============================================
-- ALERTS RECEIVED
-- ============================================
CREATE TABLE alerts_received (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    strategy_id UUID REFERENCES strategies(id) ON DELETE SET NULL,
    alert_id VARCHAR(255) NOT NULL,
    raw_payload JSONB NOT NULL,
    is_valid BOOLEAN DEFAULT true,
    validation_error TEXT,
    is_duplicate BOOLEAN DEFAULT false,
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_alerts_strategy ON alerts_received(strategy_id);
CREATE INDEX idx_alerts_alert_id ON alerts_received(alert_id);
CREATE INDEX idx_alerts_created ON alerts_received(created_at DESC);

-- ============================================
-- TRADE REQUESTS
-- ============================================
CREATE TABLE trade_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_id UUID REFERENCES alerts_received(id) ON DELETE CASCADE,
    strategy_id UUID REFERENCES strategies(id) ON DELETE SET NULL,
    symbol VARCHAR(50) NOT NULL,
    action VARCHAR(20) NOT NULL CHECK (action IN ('buy', 'sell', 'close', 'reverse')),
    contracts INTEGER NOT NULL,
    stop_loss DECIMAL(15,8),
    take_profit DECIMAL(15,8),
    status VARCHAR(30) DEFAULT 'pending' CHECK (status IN (
        'pending', 'risk_checking', 'risk_rejected', 'copying', 'completed', 'failed'
    )),
    rejection_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_trades_alert ON trade_requests(alert_id);
CREATE INDEX idx_trades_strategy ON trade_requests(strategy_id);
CREATE INDEX idx_trades_status ON trade_requests(status);
CREATE INDEX idx_trades_created ON trade_requests(created_at DESC);

-- ============================================
-- ORDERS SUBMITTED
-- ============================================
CREATE TABLE orders_submitted (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trade_request_id UUID REFERENCES trade_requests(id) ON DELETE CASCADE,
    account_id UUID REFERENCES broker_accounts(id) ON DELETE SET NULL,
    broker_order_id VARCHAR(255),
    symbol VARCHAR(50) NOT NULL,
    side VARCHAR(10) NOT NULL CHECK (side IN ('buy', 'sell')),
    quantity INTEGER NOT NULL,
    order_type VARCHAR(20) NOT NULL,
    stop_loss DECIMAL(15,8),
    take_profit DECIMAL(15,8),
    status VARCHAR(30) DEFAULT 'pending' CHECK (status IN (
        'pending', 'submitted', 'accepted', 'partially_filled', 'filled', 'canceled', 'rejected', 'expired'
    )),
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_orders_trade ON orders_submitted(trade_request_id);
CREATE INDEX idx_orders_account ON orders_submitted(account_id);
CREATE INDEX idx_orders_status ON orders_submitted(status);
CREATE INDEX idx_orders_created ON orders_submitted(created_at DESC);

-- ============================================
-- EXECUTIONS
-- ============================================
CREATE TABLE executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID REFERENCES orders_submitted(id) ON DELETE CASCADE,
    account_id UUID REFERENCES broker_accounts(id) ON DELETE SET NULL,
    symbol VARCHAR(50) NOT NULL,
    side VARCHAR(10) NOT NULL,
    quantity INTEGER NOT NULL,
    price DECIMAL(15,8) NOT NULL,
    commission DECIMAL(15,8) DEFAULT 0,
    executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_executions_order ON executions(order_id);
CREATE INDEX idx_executions_account ON executions(account_id);
CREATE INDEX idx_executions_executed ON executions(executed_at DESC);

-- ============================================
-- RISK EVENTS
-- ============================================
CREATE TABLE risk_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type VARCHAR(30) NOT NULL CHECK (type IN ('rejection', 'kill_switch', 'warning')),
    rule_type VARCHAR(50) NOT NULL,
    trade_request_id UUID REFERENCES trade_requests(id) ON DELETE SET NULL,
    account_id UUID REFERENCES broker_accounts(id) ON DELETE SET NULL,
    strategy_id UUID REFERENCES strategies(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_risk_events_type ON risk_events(type);
CREATE INDEX idx_risk_events_created ON risk_events(created_at DESC);

-- ============================================
-- AUDIT LOGS
-- ============================================
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    old_value JSONB,
    new_value JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);

-- ============================================
-- SYSTEM SETTINGS
-- ============================================
CREATE TABLE system_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================
-- UPDATE TRIGGERS
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_broker_accounts_updated_at BEFORE UPDATE ON broker_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_strategies_updated_at BEFORE UPDATE ON strategies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_risk_rules_updated_at BEFORE UPDATE ON risk_rules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_copier_mappings_updated_at BEFORE UPDATE ON copier_mappings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_trade_requests_updated_at BEFORE UPDATE ON trade_requests
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_orders_submitted_updated_at BEFORE UPDATE ON orders_submitted
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
