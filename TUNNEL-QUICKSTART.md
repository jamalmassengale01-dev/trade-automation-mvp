# Quick Tunnel Setup (5 Minutes)

Get a public URL for your local Trade Automation MVP in under 5 minutes.

---

## Option 1: ngrok (Fastest - 30 seconds)

```bash
# 1. Install ngrok
# https://ngrok.com/download

# 2. Sign up (free) and get authtoken
# https://dashboard.ngrok.com/signup

# 3. Configure
ngrok config add-authtoken YOUR_AUTHTOKEN

# 4. Start tunnel
ngrok http 3001

# 5. Copy the HTTPS URL (looks like https://abc123.ngrok.io)
# 6. Use in TradingView: https://abc123.ngrok.io/webhook/tradingview
```

**Pros:** Instant, no domain needed  
**Cons:** URL changes every restart

---

## Option 2: Cloudflare Tunnel (Recommended - 5 minutes)

### Step 1: Install

```bash
# macOS
brew install cloudflare/cloudflare/cloudflared

# Windows (PowerShell)
# Download from: https://github.com/cloudflare/cloudflared/releases
# Or: winget install cloudflare.cloudflared

# Linux
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

### Step 2: Authenticate

```bash
cloudflared tunnel login
# Opens browser → Login to Cloudflare → Select domain → Authorize
```

### Step 3: Create Tunnel

```bash
cloudflared tunnel create trade-automation

# Output shows tunnel ID:
# Tunnel credentials written to ~/.cloudflared/<TUNNEL_ID>.json
# Export as environment variable:
export TUNNEL_ID=<YOUR_TUNNEL_ID>
```

### Step 4: Add DNS

```bash
# Replace YOURDOMAIN with your actual domain
cloudflared tunnel route dns trade-automation trading.YOURDOMAIN.com
cloudflared tunnel route dns trade-automation trading-api.YOURDOMAIN.com
```

### Step 5: Get Token

```bash
# Get the tunnel token for Docker
cloudflared tunnel token $TUNNEL_ID

# Copy this token - you'll need it for the next step
```

### Step 6: Start Everything

```bash
# Copy environment file
cp tunnel/.env.tunnel.example tunnel/.env.tunnel

# Edit and add your token
# CLOUDFLARE_TUNNEL_TOKEN=your-token-here

# Start tunnel + your app
docker-compose -f tunnel/docker-compose.tunnel.yml up
```

Or use the helper script:
```bash
# macOS/Linux
./tunnel/start-tunnel.sh --docker

# Windows PowerShell
.\tunnel\start-tunnel.ps1 -UseDocker
```

---

## TradingView Configuration

### With Cloudflare Tunnel:
```
Webhook URL: https://trading-api.YOURDOMAIN.com/webhook/tradingview
Header: X-Webhook-Secret: your-secret
```

### With ngrok:
```
Webhook URL: https://abc123.ngrok.io/webhook/tradingview
Header: X-Webhook-Secret: your-secret
```

---

## Test Your Setup

```bash
# Test health endpoint
curl https://trading-api.YOURDOMAIN.com/health

# Test webhook
curl -X POST https://trading-api.YOURDOMAIN.com/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-secret" \
  -d '{
    "id": "test-123",
    "timestamp": 1234567890000,
    "strategy": "Test",
    "symbol": "ES",
    "action": "buy",
    "contracts": 1
  }'
```

---

## Stop Everything

```bash
# If using Docker
docker-compose -f tunnel/docker-compose.tunnel.yml down

# If running cloudflared directly
Ctrl+C
```

---

## Which Option Should I Use?

| Use Case | Recommendation |
|----------|---------------|
| Quick 5-min test | **ngrok** |
| Demo to client | **Cloudflare** (permanent URL) |
| Regular development | **Cloudflare** |
| Production | **Deploy to Railway** (see DEPLOYMENT.md) |

---

## Troubleshooting

### "cloudflared: command not found"
- Make sure cloudflared is in your PATH
- Try: `~/.cloudflared/cloudflared --version`

### "Tunnel not found"
- Check: `cloudflared tunnel list`
- Make sure you're using the correct tunnel ID

### "Cannot connect to local API"
- Verify API is running: `curl http://localhost:3001/health`
- Check Docker logs: `docker logs trade-automation-api-tunnel`

### "Webhook returns 403 Forbidden"
- Check WEBHOOK_SECRET matches between .env.tunnel and TradingView header

---

## Next Steps

Once you confirm everything works:

1. **Use ngrok for quick tests** (< 1 hour)
2. **Use Cloudflare for regular dev** (permanent URL)
3. **Deploy to Railway for production** (see DEPLOYMENT.md)
