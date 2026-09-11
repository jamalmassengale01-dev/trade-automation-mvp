# Deploying EdgePilot to a VPS

For a fresh Ubuntu 22.04/24.04 box. Roughly 30 minutes end to end.

## Why not a laptop

Once a bracket is placed, the take-profit and stop live on **Tradovate's**
servers, so a dead laptop does not leave a naked position — the stop still
works. What stops is everything around it:

- the **breakeven move** after TP1 fills, so a winner can round-trip to a loss
- the **end-of-day flatten**, and prop firms disclaim positions held through
  the close
- **new signals** — the London window is 3:00–3:30 AM ET, lid shut
- ladder and broker-day state, until the process restarts

A laptop is fine for connecting credentials, running the preflight and firing
test webhooks at a desk. Move to a server before live signals reach a real
account.

## 1. Pick a box

2 GB RAM is enough for Node, Postgres and Redis together. Hetzner CX22 (~€4/mo)
or DigitalOcean's $6 droplet both work.

Choose a **US East or Chicago** region. Tradovate is US-based. A 2-minute-bar
strategy sending market orders with a 120-second GTD is not latency-sensitive,
but the right region is free.

## 2. Harden it before anything else

```bash
ssh root@YOUR_IP

adduser edgepilot && usermod -aG sudo edgepilot
rsync --archive --chown=edgepilot:edgepilot ~/.ssh /home/edgepilot   # keep your key

# Disable password logins — a public box with password SSH is found within hours.
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/;s/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

Do **not** open 3000, 3001, 5432 or 6379. Postgres and Redis are already bound
to loopback in compose; the app ports are reached through Caddy.

## 3. Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker edgepilot
# log out and back in so the group applies
```

## 4. Clone and configure

```bash
git clone https://github.com/jamalmassengale01-dev/trade-automation-mvp.git
cd trade-automation-mvp/docker
cp .env.example .env
```

Generate real secrets — do not invent them by hand:

```bash
openssl rand -hex 32   # POSTGRES_PASSWORD
openssl rand -hex 32   # WEBHOOK_SECRET
openssl rand -hex 32   # SYSTEM_API_KEY
```

Fill in `.env`. The stack refuses to start without `POSTGRES_PASSWORD`, which
is deliberate: a trading database on a public box with the password `postgres`
is not a hypothetical mistake.

## 5. DNS, then start

Point two A records at the server's IP and wait for them to resolve, or Let's
Encrypt cannot issue:

```
api.yourdomain.com   → YOUR_IP
app.yourdomain.com   → YOUR_IP
```

```bash
docker compose --profile public up -d --build
docker compose exec api npm run db:migrate
docker compose exec api npm run create-admin        # prompts for email + password
#   Password must be 12+ characters. Signing in, lockouts and recovery:
#   see docs/LOGIN.md
```

Check it:

```bash
curl https://api.yourdomain.com/health
docker compose logs -f api
```

The boot log names anything unconfigured — no notification channel, no Stripe,
and a loud warning if `GB_TEST_SESSION` is set. Read it once rather than
assuming.

## 6. External uptime check — do not skip this

**The server cannot report its own death.** The notification channel and the
48-hour inactivity alert both run *inside* the process. If the box goes down,
nothing tells you, and silence looks exactly like a quiet market.

Add a free [UptimeRobot](https://uptimerobot.com) monitor on
`https://api.yourdomain.com/health` every 5 minutes, alerting to the same Slack
channel as `NOTIFY_WEBHOOK_URL`. It is the only thing that catches "the whole
system is off".

## 7. Backups

Ladder step, broker-day state, trade history and payout progress all live in
Postgres. Losing it means losing where every account stands.

```bash
mkdir -p ~/backups
cat > ~/backup.sh <<'SH'
#!/bin/bash
set -euo pipefail
cd /home/edgepilot/trade-automation-mvp/docker
docker compose exec -T postgres pg_dump -U postgres trade_automation \
  | gzip > "/home/edgepilot/backups/db-$(date +%F-%H%M).sql.gz"
find /home/edgepilot/backups -name 'db-*.sql.gz' -mtime +14 -delete
SH
chmod +x ~/backup.sh
(crontab -l 2>/dev/null; echo "30 22 * * * /home/edgepilot/backup.sh") | crontab -
```

22:30 UTC is after the US close and after both firms' broker-day rollovers, so
a dump never lands mid-rollover.

**A backup you have not restored is a guess.** Test it once:

```bash
gunzip -c ~/backups/db-*.sql.gz | head -20   # at minimum, confirm it is real SQL
```

Copy them off the box periodically. A backup on the same disk as the database
does not survive the failure it exists for.

## 8. TradingView

The webhook URL comes from the dashboard's Signal Sources page (or Settings) and
already carries
the per-strategy secret:

```
https://api.yourdomain.com/webhook/tradingview/<strategyId>?secret=<secret>
```

Alert frequency **Once Per Bar Close**. Anything else fires intrabar and the
strategy is defined on bar close only.

## Day to day

```bash
docker compose logs -f api                  # follow
docker compose ps                           # what is up
docker compose restart api                  # restart just the API
docker compose exec api npm run tradovate:preflight   # diagnose broker access
```

Update:

```bash
cd ~/trade-automation-mvp && git pull
cd docker && docker compose --profile public up -d --build
docker compose exec api npm run db:migrate  # migrations are idempotent
```

**Do not update during a session window** (3:00–3:30, 10:00–10:30, 14:00–14:30
ET) or while a position is open. A restart mid-trade is recovered by rehydrate,
but the gap is real. Deploy after the close.

## Before the first live signal

- [ ] `curl https://api.yourdomain.com/health` returns ok over HTTPS
- [ ] `docker compose exec api npm run tradovate:preflight` passes every check
- [ ] A test webhook produces a `gb_trades` row
- [ ] `NOTIFY_WEBHOOK_URL` set — send yourself one alert and confirm it arrives
- [ ] UptimeRobot monitor live, and tested by stopping the API for a minute
- [ ] Backup cron installed and one dump verified
- [ ] `GB_TEST_SESSION` **unset** (it is ignored when `NODE_ENV=production`,
      but leaving it set is a landmine for the day someone runs it otherwise)
- [ ] Plans published on the Firm Plans page — an unverified plan means nobody
      has checked those numbers against the firm's own rules, and every trade is
      sized from them
