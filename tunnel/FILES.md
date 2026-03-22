# Tunnel Setup Files

## Created Files

| File | Purpose |
|------|---------|
| `docker-compose.tunnel.yml` | Docker setup for API + Web + Tunnel |
| `docker-compose.full.yml` | Complete stack: Postgres + Redis + API + Web + Tunnel |
| `.env.tunnel.example` | Environment variables template |
| `README.md` | Complete tunnel documentation |
| `TUNNEL-QUICKSTART.md` | 5-minute quick start guide |
| `ngrok-quick.yml` | ngrok configuration file |
| `Caddyfile` | Caddy local HTTPS alternative |
| `start-tunnel.sh` | Bash script to start tunnel (macOS/Linux) |
| `start-tunnel.ps1` | PowerShell script to start tunnel (Windows) |
| `setup-windows.ps1` | Windows automated setup script |
| `validate-env.js` | Environment validation script |

## Quick Usage

### Option 1: ngrok (30 seconds)
```bash
ngrok http 3001
# Copy HTTPS URL to TradingView
```

### Option 2: Cloudflare Tunnel (5 minutes)
```bash
# Windows (as Administrator)
.\tunnel\setup-windows.ps1

# macOS/Linux
./tunnel/start-tunnel.sh --setup

# Then start
docker-compose -f tunnel/docker-compose.tunnel.yml up
```

### Option 3: Full Stack with Tunnel
```bash
# Copy and edit env file
cp tunnel/.env.tunnel.example tunnel/.env.tunnel
# Add your CLOUDFLARE_TUNNEL_TOKEN

# Start everything
docker-compose -f tunnel/docker-compose.full.yml up
```

## URLs After Setup

| Service | Local | Public (with tunnel) |
|---------|-------|---------------------|
| Dashboard | http://localhost:3000 | https://trading.yourdomain.com |
| API | http://localhost:3001 | https://trading-api.yourdomain.com |
| Webhook | - | https://trading-api.yourdomain.com/webhook/tradingview |
