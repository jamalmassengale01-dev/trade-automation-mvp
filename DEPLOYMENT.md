# Deployment Guide

Complete guide to deploy Trade Automation MVP to Railway + Supabase + Upstash.

---

## Quick Overview

| Service | Provider | Purpose | Cost |
|---------|----------|---------|------|
| Database | Supabase | PostgreSQL | Free tier |
| Redis | Upstash | BullMQ queue | Free tier |
| API + Workers | Railway | Node.js backend | Free tier |
| Frontend | Vercel | Next.js app | Free tier |

---

## Step 1: Push Code to GitHub

```bash
# Initialize git (if not done)
git init
git add .
git commit -m "Initial commit"

# Create repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/trade-automation-mvp.git
git push -u origin main
```

---

## Step 2: Set Up Supabase (Database)

### 2.1 Create Project
1. Go to [supabase.com](https://supabase.com) → Sign up
2. Click "New Project"
3. Choose organization → Name: `trade-automation`
4. Database Password: **Save this somewhere secure!**
5. Region: Choose closest to you (affects latency)
6. Click "Create new project"

### 2.2 Get Connection String
1. Wait for project to be created (2-3 minutes)
2. Go to **Project Settings** (gear icon) → **Database**
3. Scroll to **"Connection string"** section
4. Select **URI** tab
5. Copy the connection string:
   ```
   postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
   ```
6. Replace `[PASSWORD]` with your database password

### 2.3 Run Database Migrations

Option A: **Using Supabase SQL Editor (Easiest)**
1. Go to **SQL Editor** → **New query**
2. Copy contents of `apps/api/src/db/schema.sql`
3. Paste and click **Run**

Option B: **Using psql CLI**
```bash
# Set environment variable
export DATABASE_URL="postgresql://postgres:..."

# Run migration
cd apps/api
npm run db:migrate
```

### 2.4 (Optional) Seed Demo Data
```bash
npm run db:seed
```

---

## Step 3: Set Up Upstash (Redis)

### 3.1 Create Redis Database
1. Go to [upstash.com](https://upstash.com) → Sign up
2. Click **"Create Database"**
3. Name: `trade-automation-redis`
4. Region: Same as Supabase (for lowest latency)
5. Click **Create**

### 3.2 Get Redis URL
1. Click on your database
2. Go to **Details** tab
3. Copy the **REDIS_URL** (looks like):
   ```
   redis://default:[PASSWORD]@[HOST]:6379
   ```

---

## Step 4: Deploy to Railway

### 4.1 Create Railway Account
1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Click **"New Project"**

### 4.2 Deploy from GitHub
1. Select **"Deploy from GitHub repo"**
2. Choose your `trade-automation-mvp` repository
3. Railway will auto-detect the `railway.json` config

### 4.3 Add Environment Variables

Go to **Variables** tab → **Add Variables**:

```env
# Required
DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres
REDIS_URL=redis://default:[PASSWORD]@[HOST]:6379
WEBHOOK_SECRET=your-random-secret-min-32-characters

# Optional
NODE_ENV=production
PORT=3001
LOG_LEVEL=info
ENABLE_MOCK_BROKER=true
ENABLE_SIMULATED_BROKER=true
```

### 4.4 Generate Webhook Secret
```bash
# Run this in terminal to generate secure secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4.5 Deploy
1. Railway will auto-deploy when you add variables
2. Wait for build to complete (2-3 minutes)
3. Go to **Deployments** tab to see status

### 4.6 Verify Deployment
1. Go to **Settings** tab → copy **Domain** (e.g., `https://trade-automation-api.up.railway.app`)
2. Visit: `https://YOUR-URL/health`
3. Should return: `{"status":"ok"}`

---

## Step 5: Deploy Frontend to Vercel

### 5.1 Create Vercel Account
1. Go to [vercel.com](https://vercel.com)
2. Sign up with GitHub

### 5.2 Import Project
1. Click **"Add New Project"**
2. Import from GitHub → Select `trade-automation-mvp`
3. **Root Directory**: `apps/web`
4. Click **Import**

### 5.3 Configure Build Settings
Vercel should auto-detect Next.js, but verify:
- **Framework Preset**: Next.js
- **Build Command**: `npm run build` (or `cd ../.. && npm run build:web`)

### 5.4 Add Environment Variable
Add this in Vercel's Environment Variables:
```env
NEXT_PUBLIC_API_URL=https://YOUR-RAILWAY-URL.up.railway.app
```

### 5.5 Deploy
Click **Deploy** → Wait for build (2-3 minutes)

---

## Step 6: Configure TradingView Webhook

### 6.1 Get Your Webhook URL
```
https://YOUR-RAILWAY-URL.up.railway.app/webhook/tradingview
```

### 6.2 In TradingView
1. Create Alert
2. **Webhook URL**: Paste your URL
3. **Message** (JSON format):
```json
{
  "id": "{{strategy.order.id}}",
  "timestamp": {{time}},
  "strategy": "MyStrategy",
  "symbol": "{{ticker}}",
  "action": "{{strategy.order.action}}",
  "contracts": {{strategy.position_size}},
  "price": {{close}},
  "message": "Alert from TradingView"
}
```

### 6.3 Add Webhook Secret Header
In TradingView Pro, add header:
```
X-Webhook-Secret: your-webhook-secret-from-step-4-3
```

---

## Step 7: Verify Everything Works

### Test API
```bash
# Health check
curl https://YOUR-RAILWAY-URL.up.railway.app/health

# Test webhook (dry run)
curl -X POST https://YOUR-RAILWAY-URL.up.railway.app/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-secret" \
  -d '{
    "id": "test-123",
    "timestamp": 1234567890,
    "strategy": "Test",
    "symbol": "ES",
    "action": "buy",
    "contracts": 1
  }'
```

### Check Dashboard
1. Visit your Vercel frontend URL
2. You should see the dashboard
3. Check **Alerts** page for received alerts

---

## Troubleshooting

### Build Fails on Railway
```
# Check logs in Railway dashboard
# Common issues:
1. DATABASE_URL not set → Set the variable
2. Redis connection refused → Check REDIS_URL
3. TypeScript errors → Run `npm run build` locally first
```

### Database Connection Issues
```bash
# Test Supabase connection locally
psql "YOUR_SUPABASE_URL" -c "SELECT 1;"
```

### Redis Connection Issues
```bash
# Test Upstash connection
redis-cli -u "YOUR_REDIS_URL" ping
```

### Webhook Not Receiving
1. Check Railway logs for `/webhook/tradingview` requests
2. Verify `WEBHOOK_SECRET` matches between Railway and TradingView
3. Check if alert is being queued (check BullMQ dashboard)

---

## Updating Your Deployment

### Automatic Updates
Every push to `main` branch will:
1. Run tests (GitHub Actions)
2. Auto-deploy to Railway (if tests pass)
3. Auto-deploy to Vercel

### Manual Update
```bash
git add .
git commit -m "Your changes"
git push origin main
```

---

## Costs

| Tier | Monthly Cost | Limits |
|------|--------------|--------|
| **Free (Starter)** | $0 | Railway: $5 credit, Supabase: 500MB, Upstash: 10,000 cmds/day |
| **Production** | ~$25-50 | Higher limits, better performance |

---

## Security Checklist

- [ ] Changed default `WEBHOOK_SECRET` to random 32+ char string
- [ ] Enabled Row Level Security (RLS) in Supabase
- [ ] Restricted Supabase database access to Railway IP
- [ ] Used environment variables (never committed secrets)
- [ ] Enabled HTTPS only (Railway/Vercel provide this)

---

## Next Steps

1. **Add real broker** → Create adapter in `apps/api/src/brokers/`
2. **Set up monitoring** → Add Sentry or LogRocket
3. **Add alerts** → Configure Railway/UptimeRobot for downtime alerts
4. **Backup database** → Enable Supabase automated backups
