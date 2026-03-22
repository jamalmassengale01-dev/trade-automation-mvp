# Trade Automation MVP - Architecture

## System Components

### 1. Webhook Handler (`/apps/api/src/webhook/`)
- Receives TradingView alerts via HTTP POST
- Validates shared secret (HMAC or simple header)
- Validates JSON schema
- Checks idempotency (prevents duplicate processing)
- Persists raw alert to database
- Enqueues to BullMQ for async processing

### 2. Alert Processor (`/apps/api/src/processor/`)
- Worker that consumes from alert queue
- Parses strategy signals (buy/sell/close/reverse)
- Applies risk rules
- Creates trade requests
- Fans out to copier engine

### 3. Risk Engine (`/apps/api/src/risk/`)
- Stateless rule evaluator
- Checks all configured risk rules
- Rejects with specific reason if any rule violated
- Supports: max contracts, max positions, cooldown, session times, daily loss, whitelist, kill switches

### 4. Copier Engine (`/apps/api/src/copier/`)
- Takes one trade signal
- Looks up follower accounts
- Applies per-account sizing (fixed/multiplier)
- Applies filters (long-only, short-only, symbol restrictions)
- Creates individual order requests per account
- Isolated failure handling

### 5. Broker Adapters (`/apps/api/src/brokers/`)
- Interface: `IBrokerAdapter`
- Implementations: MockBroker, SimulatedBroker
- Methods: connect, disconnect, healthCheck, getAccountInfo, getPositions, placeOrder, cancelOrder, flattenAll
- Factory pattern for instantiation

### 6. Dashboard (`/apps/web/`)
- Next.js 14+ with App Router
- Real-time updates via polling (no WebSocket for simplicity)
- Pages: Accounts, Alerts, Orders, Risk Events, Settings
- Actions: Flatten, Disable, Kill Switch

## Data Flow

```
1. TV Alert → Webhook → Validation → Alert DB + Queue
2. Worker picks up alert
3. Strategy parser extracts signal
4. Risk engine validates
5. Copier fans out to accounts
6. Each account order queued
7. Broker adapter executes
8. Execution logged
```

## Key Design Decisions

1. **BullMQ for all async work** - Reliable, retryable, observable
2. **Adapter pattern for brokers** - Easy to add real brokers later
3. **Risk engine is reject-only** - No auto-adjustments, explicit rejections
4. **Copier isolation** - One account failure doesn't affect others
5. **Deterministic IDs** - UUID v5 from alert ID + account ID for idempotency

## Environment Strategy

- `development`: Mock broker, verbose logging
- `staging`: Simulated broker, production-like data
- `production`: Real broker credentials

## Security Considerations

- Webhook secret in header
- No PII in logs
- Kill switches for emergency stops
- All actions audited
