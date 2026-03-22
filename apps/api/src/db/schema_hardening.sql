-- ============================================
-- TRADE AUTOMATION MVP - DATABASE HARDENING
-- Safety and Reliability Enhancements
-- ============================================

-- ============================================
-- 1. UNIQUE CONSTRAINTS TO PREVENT DUPLICATES
-- ============================================

-- Prevent duplicate alerts with same alert_id per strategy
ALTER TABLE alerts_received 
ADD CONSTRAINT uk_alerts_strategy_alert_id 
UNIQUE (strategy_id, alert_id);

-- Prevent duplicate orders for same trade request and account
-- This is the "deterministic order ID" enforcement at DB level
ALTER TABLE orders_submitted 
ADD CONSTRAINT uk_orders_trade_account 
UNIQUE (trade_request_id, account_id);

-- ============================================
-- 2. IDEMPOTENCY KEY TABLE
-- ============================================
CREATE TABLE idempotency_keys (
    key_hash VARCHAR(64) PRIMARY KEY, -- SHA-256 hash of the idempotency key
    entity_type VARCHAR(50) NOT NULL, -- 'alert', 'order', 'trade'
    entity_id UUID,                   -- Reference to the created entity
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

-- ============================================
-- 3. EXECUTION LOG FOR DETAILED AUDIT
-- ============================================
CREATE TABLE execution_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trace_id VARCHAR(64) NOT NULL,     -- End-to-end correlation ID
    span_id VARCHAR(64) NOT NULL,      -- Individual operation ID
    parent_span_id VARCHAR(64),        -- Parent operation ID
    operation VARCHAR(100) NOT NULL,   -- 'webhook_received', 'risk_check', 'order_submit', etc.
    entity_type VARCHAR(50),           -- 'alert', 'trade_request', 'order'
    entity_id UUID,
    account_id UUID REFERENCES broker_accounts(id) ON DELETE SET NULL,
    status VARCHAR(30) NOT NULL,       -- 'started', 'succeeded', 'failed', 'skipped'
    input_payload JSONB,               -- Input data (sanitized)
    output_payload JSONB,              -- Output data
    error_message TEXT,                -- Error if failed
    duration_ms INTEGER,               -- Operation duration
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_execution_logs_trace ON execution_logs(trace_id);
CREATE INDEX idx_execution_logs_entity ON execution_logs(entity_type, entity_id);
CREATE INDEX idx_execution_logs_created ON execution_logs(created_at DESC);
CREATE INDEX idx_execution_logs_account ON execution_logs(account_id, created_at DESC);

-- ============================================
-- 4. ACCOUNT CIRCUIT BREAKER STATE
-- ============================================
CREATE TABLE account_circuit_breakers (
    account_id UUID PRIMARY KEY REFERENCES broker_accounts(id) ON DELETE CASCADE,
    failure_count INTEGER DEFAULT 0,
    last_failure_at TIMESTAMP WITH TIME ZONE,
    last_failure_reason TEXT,
    state VARCHAR(20) DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
    opened_at TIMESTAMP WITH TIME ZONE,
    opened_reason TEXT,
    half_open_attempts INTEGER DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_circuit_breaker_state ON account_circuit_breakers(state);

-- ============================================
-- 5. POSITION SNAPSHOTS FOR RECONCILIATION
-- ============================================
CREATE TABLE position_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
    symbol VARCHAR(50) NOT NULL,
    side VARCHAR(10) NOT NULL CHECK (side IN ('long', 'short', 'flat')),
    quantity INTEGER NOT NULL DEFAULT 0,
    avg_entry_price DECIMAL(15,8),
    unrealized_pnl DECIMAL(15,2),
    source VARCHAR(20) NOT NULL CHECK (source IN ('broker', 'system')), -- Who reported this
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_position_snapshots_account ON position_snapshots(account_id);
CREATE INDEX idx_position_snapshots_symbol ON position_snapshots(account_id, symbol);
CREATE INDEX idx_position_snapshots_synced ON position_snapshots(synced_at);

-- ============================================
-- 6. RATE LIMITING TRACKING
-- ============================================
CREATE TABLE rate_limit_windows (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID REFERENCES broker_accounts(id) ON DELETE CASCADE,
    strategy_id UUID REFERENCES strategies(id) ON DELETE CASCADE,
    window_start TIMESTAMP WITH TIME ZONE NOT NULL,
    window_duration_seconds INTEGER NOT NULL DEFAULT 60,
    trade_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(account_id, strategy_id, window_start)
);

CREATE INDEX idx_rate_limit_account ON rate_limit_windows(account_id, window_start);
CREATE INDEX idx_rate_limit_strategy ON rate_limit_windows(strategy_id, window_start);

-- ============================================
-- 7. SIGNAL COOLDOWN TRACKING
-- ============================================
CREATE TABLE signal_cooldowns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    strategy_id UUID NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
    symbol VARCHAR(50) NOT NULL,
    action VARCHAR(20) NOT NULL,
    signal_key VARCHAR(100) NOT NULL, -- Composite key for deduplication
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(strategy_id, symbol, signal_key)
);

CREATE INDEX idx_signal_cooldown_expires ON signal_cooldowns(expires_at);
CREATE INDEX idx_signal_cooldown_strategy ON signal_cooldowns(strategy_id, symbol);

-- ============================================
-- 8. SYSTEM HEALTH HEARTBEAT
-- ============================================
CREATE TABLE system_heartbeats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    component VARCHAR(50) NOT NULL, -- 'webhook', 'alert_processor', 'order_executor', 'reconciler'
    instance_id VARCHAR(100) NOT NULL, -- Hostname or pod name
    status VARCHAR(20) NOT NULL CHECK (status IN ('healthy', 'degraded', 'unhealthy')),
    metrics JSONB DEFAULT '{}', -- Component-specific metrics
    last_beat_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(component, instance_id)
);

CREATE INDEX idx_heartbeats_component ON system_heartbeats(component, last_beat_at);
CREATE INDEX idx_heartbeats_status ON system_heartbeats(status);

-- ============================================
-- 9. DEAD LETTER QUEUE
-- ============================================
CREATE TABLE dead_letter_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    queue_name VARCHAR(50) NOT NULL,
    job_id VARCHAR(100) NOT NULL,
    job_name VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    error_message TEXT NOT NULL,
    error_stack TEXT,
    attempt_count INTEGER DEFAULT 0,
    failed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    retryable BOOLEAN DEFAULT true,
    retried_at TIMESTAMP WITH TIME ZONE,
    retried_successfully BOOLEAN,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_dlq_queue ON dead_letter_queue(queue_name, failed_at);
CREATE INDEX idx_dlq_retryable ON dead_letter_queue(retryable, failed_at);
CREATE INDEX idx_dlq_job ON dead_letter_queue(job_id);

-- ============================================
-- 10. OPTIMISTIC LOCKING FOR ORDERS
-- ============================================
ALTER TABLE orders_submitted ADD COLUMN version INTEGER DEFAULT 1;

-- ============================================
-- 11. ADDITIONAL INDEXES FOR PERFORMANCE
-- ============================================

-- For fast duplicate checking in webhook
CREATE INDEX idx_alerts_alert_id_created ON alerts_received(alert_id, created_at DESC);

-- For order lifecycle queries
CREATE INDEX idx_orders_lifecycle ON orders_submitted(account_id, symbol, status, created_at DESC);

-- For position reconciliation
CREATE INDEX idx_orders_for_positions ON orders_submitted(account_id, symbol, status) 
WHERE status IN ('filled', 'partially_filled');

-- For risk event analysis
CREATE INDEX idx_risk_events_account ON risk_events(account_id, created_at DESC);

-- For trade request tracking
CREATE INDEX idx_trades_complete ON trade_requests(strategy_id, status, created_at DESC);

-- ============================================
-- 12. PARTITIONING FOR LARGE TABLES (optional, for high volume)
-- ============================================
-- For production, consider partitioning alerts_received and execution_logs by time

-- ============================================
-- 13. TRIGGER FOR ORDER VERSION INCREMENT
-- ============================================
CREATE OR REPLACE FUNCTION increment_order_version()
RETURNS TRIGGER AS $$
BEGIN
    NEW.version = OLD.version + 1;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER trg_orders_version BEFORE UPDATE ON orders_submitted
    FOR EACH ROW EXECUTE FUNCTION increment_order_version();

-- ============================================
-- 14. CLEANUP FUNCTION FOR EXPIRED DATA
-- ============================================
CREATE OR REPLACE FUNCTION cleanup_expired_data()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER := 0;
BEGIN
    -- Clean expired idempotency keys
    DELETE FROM idempotency_keys WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    -- Clean expired signal cooldowns
    DELETE FROM signal_cooldowns WHERE expires_at < NOW();
    
    -- Clean old rate limit windows (keep 24 hours)
    DELETE FROM rate_limit_windows WHERE window_start < NOW() - INTERVAL '24 hours';
    
    RETURN deleted_count;
END;
$$ language 'plpgsql';

-- ============================================
-- 15. RECONCILIATION STATUS TABLE
-- ============================================
CREATE TABLE reconciliation_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    account_id UUID REFERENCES broker_accounts(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
    discrepancies_found INTEGER DEFAULT 0,
    discrepancies_resolved INTEGER DEFAULT 0,
    errors JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_reconciliation_status ON reconciliation_runs(status, started_at);
CREATE INDEX idx_reconciliation_account ON reconciliation_runs(account_id, started_at);
