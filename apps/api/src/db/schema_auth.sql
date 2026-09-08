-- ============================================
-- EDGEPILOT — AUTH SCHEMA (v5)
-- Users, roles, sessions.
-- Idempotent: safe to run repeatedly.
-- ============================================

-- ---- Users -------------------------------------------------------------
-- password_hash was nullable with a "no auth for MVP" note. It is now the
-- credential of record. Left nullable at the column level so an operator can
-- pre-create a customer row before they set a password (invite flow), but a
-- NULL hash can never authenticate — verifyPassword rejects it outright.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'customer',
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'customer'));
    END IF;
END $$;

COMMENT ON COLUMN users.role IS
    'admin: manages presets, the firm-rule catalog, and every account. customer: own accounts only.';

-- ---- Sessions ----------------------------------------------------------
-- Opaque random tokens rather than JWTs: revocation is a DELETE, there is no
-- signing secret to rotate or leak, and a stolen token dies the moment the row
-- is removed. Only the SHA-256 of the token is stored, so a database dump does
-- not hand over live sessions.
CREATE TABLE IF NOT EXISTS sessions (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_agent   TEXT,
    ip_address   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user        ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires     ON sessions (expires_at);

COMMENT ON TABLE sessions IS
    'Server-side sessions. token_hash is SHA-256 of the opaque cookie value.';

-- ---- Ownership backfill ------------------------------------------------
-- Rows created before auth existed have user_id NULL and would be invisible to
-- every customer and orphaned for admins. Assign them to the oldest admin if
-- one exists; otherwise leave them for the create-admin CLI to adopt.
DO $$
DECLARE
    first_admin UUID;
BEGIN
    SELECT id INTO first_admin FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1;
    IF first_admin IS NOT NULL THEN
        UPDATE broker_accounts SET user_id = first_admin WHERE user_id IS NULL;
        UPDATE strategies      SET user_id = first_admin WHERE user_id IS NULL;
    END IF;
END $$;
