# Logging in to EdgePilot

There is no sign-up page. Accounts are created from the command line on the
server — deliberately, since anyone who can reach the dashboard can move money.

---

## First time: create your login

The stack runs in Docker, so the command goes through the api container. From
the `docker/` directory:

```bash
docker compose run --rm api npm run create-admin -- --email you@example.com --name "Jamal"
```

You'll be prompted for a password and it won't echo as you type. To pass it
directly instead (it will land in your shell history):

```bash
docker compose run --rm api npm run create-admin -- --email you@example.com --name "Jamal" --password 'your-password-here'
```

`run --rm`, not `exec`: it starts a throwaway container, so it works whether or
not the API is currently up — including on a fresh stack, where it is not.

Running outside Docker — a laptop with `npm run dev` — the same command works
from the repository root, without the `docker compose run --rm api` prefix.

**Password rule: at least 12 characters.** There are no "one capital, one
number, one symbol" rules — length does far more work than composition, and
those rules mostly produce `Password1!`. A passphrase of four or five ordinary
words is both stronger and easier to type on a phone at 3 AM.

Running it again for an email that already exists **updates that account's
password**, which is how you reset your own.

### Admin vs customer

```bash
docker compose run --rm api npm run create-admin   # full access
docker compose run --rm api npm run create-user    # customer role
```

Admin additionally sees Account Health, Rule Calculator and Rule Editor, and is
the only role that can publish plans, trip the emergency stop, or correct
recorded P&L. On a personal fleet you want admin.

---

## Signing in

Open the dashboard — `https://app.yourdomain.com`, or `http://localhost:3000`
in development — and the login form appears over whatever page you asked for.
There is no separate `/login` URL, and after signing in you land where you were
headed.

You'll arrive on **Operations**, which answers the only question that matters
before a session window: *would a signal trade right now, and if not, why?*

**Sessions last 7 days.** Signing out ends it immediately. Closing the browser
does not.

---

## "Container is restarting"

If any of the commands above answer `Error response from daemon: Container … is
restarting, wait until the container is running`, the API is in a crash loop —
almost always an un-migrated database on a fresh stack. `exec` cannot help,
because it needs a container that stays up. Use `run` instead, which starts a
fresh one:

```bash
docker compose run --rm api npm run db:migrate
docker compose restart api
```

`docker compose logs --tail=40 api` will say `DATABASE NOT MIGRATED` if that was
the cause. If it says something else, that message is the real problem.

---

## When it won't let you in

**"Invalid email or password"** — the same message whether the email exists or
the password is wrong. That is on purpose: a different message for each would
tell anyone probing the login which emails are real.

**Locked out.** Eight failed attempts locks the account for 15 minutes. The
message tells you how many minutes remain. Waiting clears it; so does resetting
the password with `create-admin` on the server.

**"Too many attempts."** Separate from the lockout — more than 10 login
attempts from one IP in 5 minutes, whatever email was used. Wait a few minutes.

**The form never appears, just "Loading…".** The dashboard cannot reach the API.
Check the API is running and that `NEXT_PUBLIC_API_URL` points at it, then that
the API's `CORS_ORIGINS` includes the exact dashboard origin — scheme and port
included. A browser will silently drop the response if it does not.

**Signed in, then immediately signed out again.** Almost always the session
cookie being rejected: it is `SameSite=Lax` and, in production, `Secure`, so it
needs HTTPS. Over plain `http://` on a public host the browser discards it and
every request looks logged out. See `docs/DEPLOY.md` for the HTTPS setup.

---

## Changing your password

Signed in, the API takes it directly:

```bash
curl -X POST https://api.yourdomain.com/api/auth/change-password \
  -H 'Content-Type: application/json' \
  -b 'edgepilot_session=<your cookie>' \
  -d '{"currentPassword":"old","newPassword":"your new long passphrase"}'
```

Simpler in practice: re-run `create-admin` with the same email and a new
password on the server. There is no self-serve reset by email — no mail is
configured, and a password reset flow is a way in for anyone who can receive
your mail.

---

## If you're locked out entirely

You need shell access to the server. That is the only recovery path, and it is
the intended one: whoever controls the box controls the accounts.

```bash
cd ~/trade-automation-mvp/docker
docker compose run --rm api npm run create-admin -- --email you@example.com --name "Jamal"
```

Enter a new password when prompted and sign in again.
