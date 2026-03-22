# Trade Automation MVP

A minimal viable product for a trade automation platform that receives TradingView alerts, applies risk controls, and copies trades to multiple broker accounts.

## Architecture Overview

```
TradingView → Webhook → Validation → Queue → Risk Engine → Copier → Broker Adapters
```

## Features

- **TradingView Webhook Integration**: Secure endpoint with HMAC validation
- **Two Broker Adapters**: Mock (dev/testing) and Simulated (paper trading)
- **Risk Engine**: Configurable rules for trade validation
- **Multi-Account Copier**: Fan out trades to multiple accounts with custom sizing
- **Dashboard**: Monitor accounts, alerts, orders, and risk events
- **Kill Switch**: Emergency stop for all trading

## Tech Stack

- **Frontend**: Next.js 14 + TypeScript + Tailwind CSS
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL
- **Queue**: BullMQ + Redis
- **Docker**: Container orchestration

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm (v10+)

### 1. Clone and Install

```bash
git clone <repository>
cd trade-automation-mvp
npm install
```

### 2. Environment Setup

```bash
# Copy example env files
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.local.example apps/web/.env.local

# Edit as needed
```

### 3. Start Infrastructure (Docker)

```bash
# Start PostgreSQL and Redis
npm run docker:up
```

### 4. Database Setup

```bash
# Run migrations
npm run db:migrate

# Seed sample data
npm run db:seed
```

### 5. Start Development Servers

```bash
# Start both API and Web
npm run dev
```

Or individually:

```bash
# API only
npm run dev:api

# Web only
npm run dev:web
```

### 6. Access the Dashboard

- Dashboard: http://localhost:3000
- API: http://localhost:3001
- Health Check: http://localhost:3001/health

### 7. Expose to Internet (Optional)

For TradingView webhooks to reach your local machine:

**Quick (ngrok):**
```bash
ngrok http 3001
# Use the HTTPS URL in TradingView
```

**Permanent (Cloudflare Tunnel):**
```bash
# Windows PowerShell (as Admin)
.\tunnel\setup-windows.ps1

# Or Docker (with token)
docker-compose -f tunnel/docker-compose.tunnel.yml up
```

See [TUNNEL-QUICKSTART.md](TUNNEL-QUICKSTART.md) for detailed setup.

## TradingView Webhook Setup

1. Create a TradingView alert
2. Set webhook URL to: `http://your-server:3001/webhook/tradingview`
3. Set webhook secret in header: `X-Webhook-Secret: your-secret`
4. Use this JSON template:

```json
{
  "id": "{{strategy.order.id}}",
  "timestamp": {{time}},
  "strategy": "{{strategy.title}}",
  "symbol": "{{ticker}}",
  "action": "{{strategy.order.action}}",
  "contracts": {{strategy.position_size}},
  "price": {{close}},
  "stopLoss": {{strategy.order.stop}},
  "takeProfit": {{strategy.order.take}}
}
```

### Sample TradingView Alert JSON

```json
{
  "id": "alert-123456",
  "timestamp": 1700409600000,
  "strategy": "BreakoutStrategy",
  "symbol": "ES",
  "action": "buy",
  "contracts": 2,
  "price": 4500.50,
  "stopLoss": 4490.00,
  "takeProfit": 4520.00,
  "message": "Breakout detected"
}
```

## Deploy to Production

Deploy to production using the free tier stack:

| Service | Provider | Purpose |
|---------|----------|---------|
| Database | [Supabase](https://supabase.com) | PostgreSQL |
| Queue | [Upstash](https://upstash.com) | Redis for BullMQ |
| API + Workers | [Railway](https://railway.app) | Node.js backend |
| Frontend | [Vercel](https://vercel.com) | Next.js app |

**Quick Deploy:**

```bash
# 1. Push to GitHub
git push origin main

# 2. Run setup script (generates secrets)
bash scripts/setup-railway.sh

# 3. Follow the printed instructions
```

**Detailed Guides:**
- [DEPLOYMENT.md](DEPLOYMENT.md) - Complete step-by-step guide
- [DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md) - Quick checklist

**Time:** 15-20 minutes | **Cost:** Free tiers available

## Project Structure

```
trade-automation-mvp/
├── apps/
│   ├── api/              # Backend API
│   │   src/
│   │   ├── brokers/      # Broker adapter implementations
│   │   ├── copier/       # Trade copying engine
│   │   ├── db/           # Database migrations and connection
│   │   ├── jobs/         # BullMQ queues and workers
│   │   ├── processor/    # Alert and order processors
│   │   ├── risk/         # Risk engine
│   │   ├── routes/       # API routes
│   │   ├── webhook/      # TradingView webhook handler
│   │   └── types/        # TypeScript types
│   └── web/              # Next.js frontend
│       src/
│       ├── app/          # App router pages
│       ├── components/   # React components
│       └── lib/          # Utilities and API client
├── packages/
│   └── shared-types/     # Shared TypeScript types
├── docker/               # Docker configuration
└── README.md
```

## Risk Rules

The risk engine supports the following rule types:

| Rule | Description |
|------|-------------|
| `max_contracts` | Maximum contracts per trade |
| `max_positions` | Maximum open positions per account |
| `cooldown` | Minimum time between trades on same symbol |
| `session_time` | Allowed trading hours |
| `daily_loss_limit` | Maximum daily loss per account |
| `symbol_whitelist` | Allowed symbols for trading |
| `conflicting_position` | Prevent conflicting positions |
| `account_disabled` | Block trades on disabled accounts |
| `kill_switch` | Global emergency stop |

## Broker Adapters

### Mock Broker
- In-memory state
- Instant fills
- For development/testing

### Simulated Broker
- Simulates slippage and partial fills
- Market hours checking
- Buying power validation

### Adding a Real Broker

1. Create adapter in `apps/api/src/brokers/yourBroker.ts`
2. Implement `IBrokerAdapter` interface
3. Register in `apps/api/src/brokers/factory.ts`

```typescript
export class YourBrokerAdapter extends BaseBrokerAdapter {
  readonly name = 'YourBroker';
  readonly brokerType = 'yourbroker';
  
  async connect(): Promise<void> { /* ... */ }
  async disconnect(): Promise<void> { /* ... */ }
  async healthCheck(): Promise<boolean> { /* ... */ }
  async getAccountInfo(account: BrokerAccount): Promise<AccountInfo> { /* ... */ }
  async getPositions(account: BrokerAccount): Promise<Position[]> { /* ... */ }
  async placeOrder(account: BrokerAccount, request: PlaceOrderRequest): Promise<Order> { /* ... */ }
  async cancelOrder(account: BrokerAccount, orderId: string): Promise<boolean> { /* ... */ }
  async flattenAll(account: BrokerAccount): Promise<void> { /* ... */ }
}
```

## API Endpoints

### Webhook
- `POST /webhook/tradingview` - TradingView alert endpoint

### Accounts
- `GET /api/accounts` - List accounts
- `GET /api/accounts/:id` - Get account details
- `GET /api/accounts/:id/positions` - Get positions
- `POST /api/accounts/:id/flatten` - Close all positions
- `POST /api/accounts/:id/disable` - Disable account
- `POST /api/accounts/:id/enable` - Enable account

### Alerts
- `GET /api/alerts` - List alerts
- `GET /api/alerts/stats/overview` - Alert statistics

### Orders
- `GET /api/orders/requests` - List trade requests
- `GET /api/orders` - List orders
- `GET /api/orders/executions` - List executions

### Risk Events
- `GET /api/risk-events` - List risk events
- `GET /api/risk-events/stats/overview` - Risk statistics

### System
- `GET /api/system/health` - Health check
- `GET /api/system/status` - System status
- `GET /api/system/settings` - System settings
- `POST /api/system/kill-switch` - Toggle kill switch

## Testing

```bash
# Run unit tests
npm run test

# Run with coverage
npm run test -- --coverage
```

### Test Coverage

- Webhook schema validation
- Idempotency logic
- Copier sizing calculations
- Risk engine rejection logic

## Docker Deployment

```bash
# Build and start all services
npm run docker:build
npm run docker:up

# View logs
npm run docker:logs

# Stop all services
npm run docker:down
```

## Environment Variables

### API (`apps/api/.env`)

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment | development |
| `PORT` | API port | 3001 |
| `DATABASE_URL` | PostgreSQL connection | required |
| `REDIS_URL` | Redis connection | redis://localhost:6379 |
| `WEBHOOK_SECRET` | Webhook validation secret | dev-secret-change-me |
| `LOG_LEVEL` | Log level | debug |
| `GLOBAL_KILL_SWITCH` | Emergency stop | false |

### Web (`apps/web/.env.local`)

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | API base URL | http://localhost:3001 |

## Security Considerations

1. **Webhook Secret**: Always use a strong, random secret in production
2. **Kill Switch**: Enable for emergency stops
3. **Account Disabling**: Disable accounts without deleting history
4. **Audit Logs**: All actions are logged
5. **IP Restrictions**: Consider restricting webhook endpoint by IP

## Development Tips

1. **View Queue Status**: Check BullMQ dashboard or use `/api/system/health`
2. **Reset Mock State**: Restart API to clear mock broker state
3. **Database**: Use `npm run db:seed` to reset sample data
4. **Logs**: Check `apps/api/logs/app.log`

## License

Private - For internal use only
