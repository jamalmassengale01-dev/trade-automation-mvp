# Cloudflare Tunnel Setup

Expose your local Trade Automation MVP to the internet with a permanent public URL.

## What is this?

**Cloudflare Tunnel** creates a secure outbound connection from your machine to Cloudflare's edge network. This gives you:

- ✅ **Permanent URL**: `https://trading.yourdomain.com` (no changing IPs)
- ✅ **HTTPS automatically**: SSL certificate handled by Cloudflare
- ✅ **No port forwarding**: Works behind any router/firewall
- ✅ **Password protection**: Optional Zero Trust access controls
- ✅ **Free**: Cloudflare's free tier includes tunnels

## Use Cases

1. **TradingView webhook testing** without deploying
2. **Share dashboard** with team members
3. **Mobile testing** of the web app
4. **Demo** to clients without production deploy

---

## Setup Instructions

### Step 1: Install cloudflared CLI

**macOS:**
```bash
brew install cloudflare/cloudflare/cloudflared
```

**Windows:**
```powershell
# Download from: https://github.com/cloudflare/cloudflared/releases
# Or use chocolatey
choco install cloudflared
```

**Linux:**
```bash
# Debian/Ubuntu
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb
```

### Step 2: Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

This will:
1. Open browser to Cloudflare login
2. Select your domain (e.g., `yourdomain.com`)
3. Authorize the tunnel
4. Download certificate to `~/.cloudflared/cert.pem`

### Step 3: Create a Tunnel

```bash
# Create tunnel (save the Tunnel ID!)
cloudflared tunnel create trade-automation

# Example output:
# Tunnel credentials written to ~/.cloudflared/<TUNNEL_ID>.json
# cloudflared tunnel route-dns trade-automation trading.yourdomain.com
```

### Step 4: Configure the Tunnel

Create config file at `~/.cloudflared/config.yml`:

```yaml
tunnel: <YOUR_TUNNEL_ID>
credentials-file: /root/.cloudflared/<YOUR_TUNNEL_ID>.json

ingress:
  # Web dashboard
  - hostname: trading.yourdomain.com
    service: http://localhost:3000
  
  # API (including webhook endpoint)
  - hostname: trading-api.yourdomain.com
    service: http://localhost:3001
  
  # Default fallback
  - service: http_status:404
```

### Step 5: Add DNS Records

```bash
# Route your subdomain to the tunnel
cloudflared tunnel route dns trade-automation trading.yourdomain.com
cloudflared tunnel route dns trade-automation trading-api.yourdomain.com
```

### Step 6: Start the Tunnel

**Option A: Run directly**
```bash
cloudflared tunnel run trade-automation
```

**Option B: Run as a service**
```bash
# Install as system service
sudo cloudflared service install

# Start service
sudo systemctl start cloudflared
```

**Option C: Use Docker (recommended)**
```bash
# Get your tunnel token
cloudflared tunnel token <TUNNEL_ID>

# Set environment variable
export CLOUDFLARE_TUNNEL_TOKEN=<token-from-above>

# Start tunnel with your app
docker-compose -f tunnel/docker-compose.tunnel.yml up
```

---

## TradingView Webhook Configuration

Once tunnel is running, use these URLs:

```
Webhook URL: https://trading-api.yourdomain.com/webhook/tradingview
Secret Header: X-Webhook-Secret: your-secret
```

Test with curl:
```bash
curl -X POST https://trading-api.yourdomain.com/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: dev-secret-change-me" \
  -d '{
    "id": "test-123",
    "timestamp": '$(date +%s%3N)',
    "strategy": "TestStrategy",
    "symbol": "ES",
    "action": "buy",
    "contracts": 1,
    "price": 4500.00
  }'
```

---

## Password Protection (Optional)

Add Zero Trust authentication:

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com)
2. **Access** → **Applications** → **Add an application**
3. Select **Self-hosted**
4. Configure:
   - **Application Name**: Trading Dashboard
   - **Session Duration**: 24 hours
   - **Domain**: `trading.yourdomain.com`
5. **Identity providers**: Select (Email OTP is easiest)
6. **Policies** → Add rule:
   - **Rule name**: Allow Team
   - **Action**: Allow
   - **Include**: Emails ending in `@yourdomain.com` (or specific emails)

Now visiting `https://trading.yourdomain.com` requires login!

---

## ngrok Alternative (Quick & Easy)

Don't want to set up Cloudflare? Use ngrok for temporary URLs:

```bash
# Install ngrok
# https://ngrok.com/download

# Start tunnel to API
ngrok http 3001

# Output shows public URL:
# Forwarding: https://abc123.ngrok.io -> http://localhost:3001

# Use in TradingView:
# Webhook URL: https://abc123.ngrok.io/webhook/tradingview
```

**Pros:**
- Instant setup (no account needed for basic use)
- Temporary URLs (good for quick testing)

**Cons:**
- URL changes every restart (unless you pay)
- Rate limits on free tier
- Less control than Cloudflare

---

## Troubleshooting

### Tunnel won't connect
```bash
# Check logs
cloudflared tunnel run trade-automation --log-level debug

# Verify token
cloudflared tunnel list
```

### Webhook not receiving
```bash
# Test local API first
curl http://localhost:3001/health

# Then test through tunnel
curl https://trading-api.yourdomain.com/health
```

### Docker networking issues
```bash
# If using Docker, make sure api container is accessible
docker network inspect trade-automation-network
```

---

## Quick Start Script

```bash
# 1. Install cloudflared
brew install cloudflare/cloudflare/cloudflared  # macOS

# 2. Login
cloudflared tunnel login

# 3. Create tunnel
cloudflared tunnel create trade-automation

# 4. Get token and save it
cloudflared tunnel token <TUNNEL_ID> > tunnel-token.txt

# 5. Start everything
docker-compose -f tunnel/docker-compose.tunnel.yml up
```

---

## URLs After Setup

| Service | Local URL | Public URL |
|---------|-----------|------------|
| Dashboard | http://localhost:3000 | https://trading.yourdomain.com |
| API | http://localhost:3001 | https://trading-api.yourdomain.com |
| Webhook | - | https://trading-api.yourdomain.com/webhook/tradingview |
| Health | http://localhost:3001/health | https://trading-api.yourdomain.com/health |

---

## Security Notes

- 🔒 Tunnel creates **outbound-only** connection (no open ports on your machine)
- 🔒 All traffic encrypted end-to-end
- 🔒 Optional: Enable Cloudflare Access for authentication
- ⚠️ Use strong webhook secrets in production
- ⚠️ Don't share your tunnel credentials

---

## Stopping the Tunnel

```bash
# If running directly
Ctrl+C

# If running as service
sudo systemctl stop cloudflared

# If using Docker
docker-compose -f tunnel/docker-compose.tunnel.yml down
```
