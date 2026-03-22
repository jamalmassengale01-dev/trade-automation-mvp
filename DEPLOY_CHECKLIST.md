# Quick Deployment Checklist

## Pre-Flight

- [ ] Code pushed to GitHub
- [ ] Tests passing (`npm test`)
- [ ] `.env` file NOT committed (check `.gitignore`)

## Infrastructure Setup

### Supabase (Database)
- [ ] Create project at supabase.com
- [ ] Copy `DATABASE_URL`
- [ ] Run schema.sql in SQL Editor
- [ ] (Optional) Run seed data

### Upstash (Redis)
- [ ] Create database at upstash.com
- [ ] Copy `REDIS_URL`

### Railway (API + Workers)
- [ ] Connect GitHub repo
- [ ] Add environment variables:
  - [ ] `DATABASE_URL`
  - [ ] `REDIS_URL`
  - [ ] `WEBHOOK_SECRET` (use `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
  - [ ] `NODE_ENV=production`
- [ ] Verify `/health` endpoint returns `{"status":"ok"}`

### Vercel (Frontend)
- [ ] Connect GitHub repo
- [ ] Set root directory: `apps/web`
- [ ] Add `NEXT_PUBLIC_API_URL=https://YOUR-RAILWAY-URL.up.railway.app`
- [ ] Deploy

## TradingView Integration

- [ ] Get Railway domain: `https://XXXX.up.railway.app`
- [ ] Webhook URL: `https://XXXX.up.railway.app/webhook/tradingview`
- [ ] Add header: `X-Webhook-Secret: YOUR_SECRET`
- [ ] Test with sample alert

## Verification

- [ ] Dashboard loads (Vercel URL)
- [ ] Health check passes
- [ ] Test alert appears in dashboard
- [ ] Mock/simulated orders working

## Security

- [ ] Webhook secret is random (32+ chars)
- [ ] Supabase RLS enabled (if using auth)
- [ ] No secrets in code

---

**Estimated time**: 15-20 minutes
**Estimated cost**: $0 (free tiers)
