-- ============================================
-- v18 — Tradovate API keys, stored once per user
-- ============================================
--
-- Tradovate's /auth/accesstokenrequest needs seven fields, and they come from
-- two completely different places:
--
--   name, password        the prop firm issues these, one pair per account
--   cid, sec              YOUR Tradovate API key, one for everything you run
--   appId, appVersion     arbitrary strings identifying the client
--   deviceId              a stable per-account identifier
--
-- The connect-account form asked for all seven, which reads as though the prop
-- firm supplies all seven. It does not — it supplies two. Everything else was
-- being retyped per account, including a secret that is identical every time.
--
-- Kept in its own table rather than system_settings because that one is global
-- and GET /api/system/settings returns every row verbatim, which would publish
-- the secret to anyone who can load the settings page.

CREATE TABLE IF NOT EXISTS broker_api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker       TEXT NOT NULL DEFAULT 'tradovate',
  cid          TEXT NOT NULL,
  sec          TEXT NOT NULL,
  app_id       TEXT NOT NULL DEFAULT 'EdgePilot',
  app_version  TEXT NOT NULL DEFAULT '1.0',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, broker)
);

CREATE INDEX IF NOT EXISTS idx_broker_api_keys_user ON broker_api_keys(user_id);

COMMENT ON TABLE broker_api_keys IS
  'Broker API credentials that belong to the operator rather than to any one '
  'account. Filled into broker_accounts.credentials at account creation.';
