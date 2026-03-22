# Trade Automation System - Risk Analysis Document

**Version:** 1.0  
**Date:** 2026-03-19  
**Classification:** CRITICAL - INTERNAL USE ONLY  

---

## Executive Summary

This document identifies and ranks the **TOP 15 CRITICAL RISKS** in the trade automation system that could lead to:
- Incorrect orders
- Duplicate orders  
- Missed orders
- Risk rule violations
- Inconsistent account state
- Desynchronization between system and broker

**Risk Severity Scale:**
- **1-3:** Account-blowing risk (immediate financial catastrophe)
- **4-7:** High risk (significant financial loss, regulatory issues)
- **8-11:** Medium risk (operational issues, potential losses)
- **12-15:** Lower but still important (reliability, audit issues)

---

## Risk Register

### Rank 1: Race Condition in Webhook Handler (SELECT then INSERT Pattern)

| Field | Details |
|-------|---------|
| **Risk Category** | Duplicate Orders / Data Integrity |
| **Description** | The webhook handler (`handler.ts` lines 96-101) performs a SELECT query to check for existing `alert_id`, then conditionally performs an INSERT. This is a classic race condition - two concurrent requests with the same alert_id can both pass the duplicate check and both insert, resulting in duplicate orders. |
| **Why It's Dangerous** | In a high-frequency trading scenario, TradingView may retry webhooks quickly. A race condition could result in the same trade being executed multiple times across multiple accounts. With leverage, this could instantly blow an account or rack up massive unintended positions. This is a silent failure mode - the system thinks it's being safe but isn't. |
| **Current Mitigation** | Basic idempotency check using SELECT; jobId uses alert ID in queue; logs duplicate detection |
| **Recommended Fix Approach** | 1. **Immediate:** Add database-level UNIQUE constraint on `alert_id` + `strategy_id` combination<br>2. **Short-term:** Use INSERT with ON CONFLICT DO NOTHING pattern instead of SELECT-then-INSERT<br>3. **Long-term:** Implement distributed lock (Redis-based) around the idempotency check for the same alert_id |

---

### Rank 2: No Kill Switch Enforcement at Order Execution Level

| Field | Details |
|-------|---------|
| **Risk Category** | Risk Rule Violation / Safety System Failure |
| **Description** | The kill switch is checked at the strategy level in `riskEngine.checkTrade()` (lines 47-56), but there is NO kill switch check in `orderProcessor.processOrderJob()` before actual execution. Orders already enqueued will execute even if kill switch is activated while they're in the queue. |
| **Why It's Dangerous** | Emergency stop mechanisms are critical safety systems. If an operator activates kill switch due to market volatility, system malfunction, or detected attack, any orders already queued (which could be hundreds in a high-volume scenario) will still execute. This defeats the purpose of an emergency stop and could cause catastrophic losses during volatile events. |
| **Current Mitigation** | Global kill switch checked at strategy level; account-level kill switch checked during risk evaluation |
| **Recommended Fix Approach** | 1. **Immediate:** Add kill switch check at the START of `processOrderJob()` before any broker interaction<br>2. **Short-term:** Implement tiered kill switches (global, strategy, account) with real-time state via Redis<br>3. **Long-term:** Add kill switch verification AFTER order submission to catch orders that should be canceled |

---

### Rank 3: No Broker Reconciliation Loop

| Field | Details |
|-------|---------|
| **Risk Category** | State Desync / Account Integrity |
| **Description** | The system has no periodic reconciliation process that compares internal order/position state with the broker's actual state. Once an order is submitted, the system assumes it knows the truth. The `orders_submitted` table tracks status, but there's no background job to verify and correct drift. |
| **Why It's Dangerous** | Network failures, broker API errors, partial fills, manual broker interventions, or system crashes can leave the system's view of positions completely wrong. This leads to:
- Risk calculations based on wrong position sizes
- Duplicate orders because system thinks no position exists
- Missed closes because system thinks position already closed
- Inability to reconcile P&L |
| **Current Mitigation** | None - complete gap |
| **Recommended Fix Approach** | 1. **Immediate:** Implement scheduled reconciliation job (every 30s) that fetches positions from broker and reconciles with `orders_submitted`<br>2. **Short-term:** Add reconciliation status dashboard showing drift metrics<br>3. **Long-term:** Implement self-healing - auto-correct system state or alert on unresolvable conflicts |

---

### Rank 4: No Circuit Breaker Pattern

| Field | Details |
|-------|---------|
| **Risk Category** | Cascade Failure / Runaway Execution |
| **Description** | The system has no circuit breaker to stop processing when failure rates exceed thresholds. Failed jobs retry with exponential backoff (5 attempts in orderProcessor), but there's no mechanism to halt processing when failures spike. The `is_disabled` flag on accounts exists but is not automatically set. |
| **Why It's Dangerous** | During broker API outages, market closures, or authentication failures, the system will continue hammering the broker with retries. This can:
- Get API keys rate-limited or banned
- Cause duplicate orders if retries succeed after timeout
- Mask underlying issues with endless retries
- Delay detection of serious problems |
| **Current Mitigation** | Basic retry with exponential backoff; manual account disable flag exists |
| **Recommended Fix Approach** | 1. **Immediate:** Implement circuit breaker in `processOrderJob()` that tracks failures per account/broker<br>2. **Short-term:** Auto-set `is_disabled=true` after N consecutive failures; require manual re-enable<br>3. **Long-term:** Implement half-open circuit breaker state with test requests before full recovery |

---

### Rank 5: Alert Processor Lacks Per-Account Locking

| Field | Details |
|-------|---------|
| **Risk Category** | Concurrent Execution / Race Condition |
| **Description** | The `processAlertJob()` function processes alerts without any locking mechanism per account. Multiple alerts for the same account (from different strategies or rapid-fire signals) can execute concurrently. The copier engine processes accounts sequentially within one alert, but different alerts for the same account race. |
| **Why It's Dangerous** | Concurrent processing of trades for the same account can cause:
- Position size miscalculations (both read 0 positions, both add 1 = 2 total)
- Violation of max position limits
- Double exposure to market moves
- Inconsistent risk calculations based on stale position data |
| **Current Mitigation** | Within a single alert, accounts processed sequentially; no cross-alert coordination |
| **Recommended Fix Approach** | 1. **Immediate:** Implement Redis-based distributed lock per account_id in `processAlertJob()`<br>2. **Short-term:** Add lock timeout and deadlock detection<br>3. **Long-term:** Consider account-specific job queues for natural serialization |

---

### Rank 6: Missing Database-Level Uniqueness Constraints

| Field | Details |
|-------|---------|
| **Risk Category** | Data Integrity / Duplicate Prevention |
| **Description** | The database schema (`schema.sql` lines 96-110) defines `alerts_received` table with an index on `alert_id` but NO UNIQUE constraint. The `orders_submitted` table has no unique constraint on the combination of `trade_request_id` + `account_id`. |
| **Why It's Dangerous** | Database constraints are the last line of defense against duplicates. Without them:
- Application bugs can insert duplicates even if code tries to prevent it
- Race conditions at the database level can create duplicates
- Manual data fixes or migrations could inadvertently create duplicates
- Multiple application instances have no coordination |
| **Current Mitigation** | Application-level checks only |
| **Recommended Fix Approach** | 1. **Immediate:** Add `UNIQUE(strategy_id, alert_id)` constraint to `alerts_received`<br>2. **Short-term:** Add `UNIQUE(trade_request_id, account_id)` to prevent duplicate orders for same trade+account<br>3. **Long-term:** Audit all tables for proper constraints; add migration tests |

---

### Rank 7: Incomplete Order Lifecycle Tracking

| Field | Details |
|-------|---------|
| **Risk Category** | State Management / Order Tracking |
| **Description** | The order status enum (`schema.sql` line 151-153) includes 'accepted' but the order processor (`orderProcessor.ts`) never sets this status. It jumps from 'pending' to 'submitted' to final states. There's no timeout handling for orders stuck in 'submitted' state. |
| **Why It's Dangerous** | Incomplete lifecycle tracking leads to:
- Orders stuck in limbo with unknown actual status
- Risk calculations based on assumed order states
- No ability to detect broker acknowledgments vs actual fills
- Missing data for audit and compliance |
| **Current Mitigation** | Status enum defined but not fully utilized |
| **Recommended Fix Approach** | 1. **Immediate:** Add 'accepted' status update when broker acknowledges order<br>2. **Short-term:** Implement order timeout watchdog that queries broker for orders stuck >30s<br>3. **Long-term:** Full state machine with transitions validation; add `status_changed_at` timestamps |

---

### Rank 8: Risk Check Only at Enqueue, Not at Execution

| Field | Details |
|-------|---------|
| **Risk Category** | Risk Rule Violation / Delayed Execution |
| **Description** | Risk checks happen in `alertProcessor.ts` (line 41) before creating trade requests and enqueuing orders. However, `orderProcessor.ts` performs NO risk verification before actual execution. The time gap between risk check and execution can be significant (queue backlog, retries). |
| **Why It's Dangerous** | Market conditions change. An order that passed risk checks 5 minutes ago may now violate:
- Daily loss limits (losses occurred since check)
- Max position limits (other orders filled)
- Session time restrictions (market closing)
- Kill switch activation |
| **Current Mitigation** | Risk checked at alert processing time only |
| **Recommended Fix Approach** | 1. **Immediate:** Re-run critical risk checks (kill switch, account disabled, daily loss) in `processOrderJob()` before execution<br>2. **Short-term:** Implement risk check versioning - fail if risk rules changed since check<br>3. **Long-term:** Implement real-time risk limit reservations during enqueue |

---

### Rank 9: No Transaction Isolation in Copier Engine

| Field | Details |
|-------|---------|
| **Risk Category** | Partial Execution / Inconsistent State |
| **Description** | The `copierEngine.copyTrade()` method (lines 37-97) processes accounts sequentially but each account operation is independent. If the process crashes after processing 3 of 10 accounts, there's no rollback mechanism. The order queue adds provide some durability, but the trade request status doesn't reflect partial completion accurately. |
| **Why It's Dangerous** | Partial trade copying can cause:
- Unintended exposure (some accounts have position, others don't)
- Strategy divergence between accounts
- Inconsistent risk profiles across the portfolio
- Difficult-to-debug states where some orders exist and others don't |
| **Current Mitigation** | Sequential processing within single alert; job-level retries |
| **Recommended Fix Approach** | 1. **Immediate:** Add per-account execution tracking with rollback capability<br>2. **Short-term:** Implement saga pattern for distributed transaction across accounts<br>3. **Long-term:** Two-phase commit with confirmation step before marking trade complete |

---

### Rank 10: No Optimistic Locking on Order Updates

| Field | Details |
|-------|---------|
| **Risk Category** | Concurrent Modification / Data Corruption |
| **Description** | Order status updates in `orderProcessor.ts` (lines 101-104, 114-119) use simple UPDATE statements without any version checking. If two workers/processes try to update the same order simultaneously (e.g., status update from webhook callback and timeout handler), the last write wins without detection of the conflict. |
| **Why It's Dangerous** | Concurrent updates can cause:
- Lost execution records (one update overwrites another)
- Incorrect final status (filled -> rejected overwrite)
- Double counting of executions<br>- State transitions that violate business logic (filled -> pending) |
| **Current Mitigation** | None - no versioning mechanism |
| **Recommended Fix Approach** | 1. **Immediate:** Add `version` column to `orders_submitted`; use optimistic locking in UPDATE WHERE version=$n<br>2. **Short-term:** Add database triggers to prevent invalid status transitions<br>3. **Long-term:** Event-sourcing pattern with immutable state changes |

---

### Rank 11: No Maximum Trades Per Minute Guard

| Field | Details |
|-------|---------|
| **Risk Category** | Rate Limiting / System Overload |
| **Description** | While the workers have per-queue rate limiters (10 alerts/sec, 20 orders/sec), there's no per-account or per-strategy rate limiting. A misconfigured strategy or runaway alert source could generate hundreds of trades for a single account in minutes. |
| **Why It's Dangerous** | Unbounded trading rate can cause:
- Broker API rate limit violations leading to lockouts
- Excessive commission costs from over-trading
- Violation of risk assumptions (max positions calculated per trade, not per minute)
- Detection as suspicious activity by broker<br>- System resource exhaustion |
| **Current Mitigation** | Global queue rate limiting only |
| **Recommended Fix Approach** | 1. **Immediate:** Add per-account rate limit check in `copyToAccount()` method<br>2. **Short-term:** Implement sliding window rate limiter (Redis-based) per account<br>3. **Long-term:** Dynamic rate limiting based on broker feedback and market conditions |

---

### Rank 12: No Dead-Letter Queue for Failed Jobs

| Field | Details |
|-------|---------|
| **Risk Category** | Message Loss / Operational Visibility |
| **Description** | Failed jobs in BullMQ are retried based on configuration, then marked as failed. There's no dead-letter queue (DLQ) implementation for permanently failed orders. After 5 retries, the job is discarded with only a log entry. |
| **Why It's Dangerous** | Without a DLQ:
- Failed orders may be lost without operator awareness
- No systematic way to review, analyze, and reprocess failures
- Compliance/audit requirements may not be met (failed trades must be accounted for)<br>- Pattern analysis of failures is difficult |
| **Current Mitigation** | Failed jobs logged; failure events in logs |
| **Recommended Fix Approach** | 1. **Immediate:** Configure BullMQ to move failed jobs to a DLQ queue<br>2. **Short-term:** Implement DLQ processor that alerts operators and persists failures to database<br>3. **Long-term:** Automated classification of DLQ items with suggested remediation |

---

### Rank 13: No Auto-Disable on Repeated Failures

| Field | Details |
|-------|---------|
| **Risk Category** | Fault Tolerance / Account Protection |
| **Description** | The `broker_accounts` table has an `is_disabled` flag, but it's only set manually. There's no automatic disabling when an account experiences repeated order failures. The copier engine logs errors but continues trying on subsequent alerts. |
| **Why It's Dangerous** | Continued attempts on failing accounts cause:
- Waste of system resources processing doomed orders
- Log spam making real issues harder to detect
- Potential API key lockout affecting other accounts<br>- Delayed response to real problems (credentials expired, account locked, etc.) |
| **Current Mitigation** | Manual disable flag exists; error logging |
| **Recommended Fix Approach** | 1. **Immediate:** Track failure count per account in Redis; auto-disable after threshold<br>2. **Short-term:** Different thresholds for different error types (auth errors = immediate disable, network errors = higher threshold)<br>3. **Long-term:** Self-healing attempts for transient errors before disabling |

---

### Rank 14: No Structured Logging with Correlation IDs

| Field | Details |
|-------|---------|
| **Risk Category** | Observability / Incident Response |
| **Description** | While the system uses winston for logging with child loggers, correlation IDs are not consistently propagated across the entire flow. The `requestId` in webhook handler doesn't flow through to alert processing, copier, and order execution as a single trace ID. |
| **Why It's Dangerous** | Poor observability means:
- Cannot trace a single trade through the entire system
- Incident response is slow and error-prone<br>- Debugging production issues requires manual correlation<br>- Compliance audits are difficult |
| **Current Mitigation** | Context loggers exist; requestId in webhook |
| **Recommended Fix Approach** | 1. **Immediate:** Implement OpenTelemetry or similar tracing with correlation IDs<br>2. **Short-term:** Ensure `requestId` flows through all job data and is logged at each step<br>3. **Long-term:** Centralized log aggregation with trace visualization |

---

### Rank 15: No Duplicate Signal Cooldown Window

| Field | Details |
|-------|---------|
| **Risk Category** | Signal Deduplication / Trading Logic |
| **Description** | While the webhook handler checks for duplicate `alert_id`, there's no protection against semantically duplicate signals with different IDs. TradingView can fire the same signal (same symbol, action, timestamp) with different alert IDs if the alert condition persists across bars. |
| **Why It's Dangerous** | Semantic duplicates can cause:
- Unintended scaling into positions<br>- Duplicate orders that bypass idempotency check<br>- Violation of intended position sizing |
| **Current Mitigation** | alert_id deduplication only |
| **Recommended Fix Approach** | 1. **Immediate:** Add cooldown window per (strategy_id, symbol, action) combination<br>2. **Short-term:** Configurable cooldown per strategy; fingerprint-based deduplication<br>3. **Long-term:** Smart signal merging for rapid-fire alerts |

---

## Additional Risks (Beyond Top 15)

The following risks were identified but ranked below the top 15. They should still be addressed:

| # | Risk | Category | Priority |
|---|------|----------|----------|
| 16 | No startup reconciliation of open positions | State Management | Medium |
| 17 | Workers have no per-account rate limiting | Resource Management | Medium |
| 18 | No audit trail for all actions | Compliance | Medium |
| 19 | Risk engine position counting may be inaccurate | Risk Calculation | Medium |
| 20 | No heartbeat monitoring | System Health | Low |

---

## Risk Matrix

```
Impact
  High │  1   2   3   4   5
       │  6   7   8   9
  Med  │  10  11  12  13
       │  14  15
  Low  │
       └───────────────────────
          High    Med    Low    Likelihood
```

---

## Recommended Implementation Priority

### Phase 1: Critical (Immediate - Week 1)
1. **Risk #1:** Add database unique constraints + fix race condition
2. **Risk #2:** Add kill switch check in order processor
3. **Risk #6:** Add database constraints for duplicate prevention

### Phase 2: High (Week 2-3)
4. **Risk #3:** Implement broker reconciliation loop
5. **Risk #4:** Add circuit breaker pattern
6. **Risk #5:** Implement per-account locking

### Phase 3: Medium (Week 4-6)
7. **Risk #7:** Complete order lifecycle tracking
8. **Risk #8:** Re-verify risk at execution time
9. **Risk #10:** Add optimistic locking
10. **Risk #9:** Transaction isolation improvements

### Phase 4: Operational (Week 7-8)
11. **Risk #11:** Rate limiting per account
12. **Risk #12:** Dead letter queue
13. **Risk #13:** Auto-disable on failures
14. **Risk #14:** Correlation ID propagation
15. **Risk #15:** Signal cooldown window

---

## Testing Recommendations

For each risk fix, implement the following tests:

1. **Unit Tests:** Test individual functions with mocked dependencies
2. **Integration Tests:** Test with real database and Redis
3. **Race Condition Tests:** Use parallel execution to verify thread-safety
4. **Chaos Tests:** Simulate failures (network, broker, database)
5. **Load Tests:** Verify behavior under high concurrency

---

## Monitoring & Alerting

Implement metrics for:
- Duplicate alert detection rate
- Order state reconciliation drift
- Circuit breaker state changes
- Per-account error rates
- Risk rejection vs execution mismatch
- DLQ depth and age

---

**Document Owner:** Risk Management Team  
**Review Cycle:** Monthly or after any production incident  
**Distribution:** Engineering, Risk, Compliance, Operations
