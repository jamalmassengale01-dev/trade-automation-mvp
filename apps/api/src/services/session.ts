/**
 * Server-side session management.
 *
 * The cookie carries an opaque random token; only its SHA-256 is stored. Every
 * request looks the session up, which costs one indexed query and buys real
 * revocation — logging out or disabling a user takes effect immediately rather
 * than whenever a JWT happens to expire.
 */

import { query } from '../db';
import { generateSessionToken, hashSessionToken } from './password';
import logger from '../utils/logger';

const log = logger.child({ context: 'SessionService' });

export const SESSION_COOKIE = 'edgepilot_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Refresh last_seen_at at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type UserRole = 'admin' | 'customer';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface CreateSessionOptions {
  userAgent?: string;
  ipAddress?: string;
}

/** Create a session. Returns the raw token — the only time it exists in plaintext. */
export async function createSession(
  userId: string,
  opts: CreateSessionOptions = {}
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      hashSessionToken(token),
      expiresAt,
      opts.userAgent?.slice(0, 500) ?? null,
      opts.ipAddress?.slice(0, 100) ?? null,
    ]
  );

  return { token, expiresAt };
}

/**
 * Resolve a cookie token to a user, or null.
 *
 * Rejects expired sessions and inactive users. Deliberately does not
 * distinguish between "no session", "expired", and "user disabled" to the
 * caller — all three mean "not authenticated".
 */
export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;

  const r = await query<{
    session_id: string;
    last_seen_at: Date;
    id: string;
    email: string;
    name: string;
    role: UserRole;
    is_active: boolean;
  }>(
    `SELECT s.id AS session_id, s.last_seen_at,
            u.id, u.email, u.name, u.role, u.is_active
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [hashSessionToken(token)]
  );

  const row = r.rows[0];
  if (!row || !row.is_active) return null;

  // Throttled activity stamp — one write per 5 minutes per session, not per request.
  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_INTERVAL_MS) {
    void query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [row.session_id]).catch(
      (err) => log.warn('Failed to touch session', { error: String(err) })
    );
  }

  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

/** Revoke one session (logout). */
export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token)]);
}

/** Revoke every session for a user (password change, forced logout). */
export async function revokeAllUserSessions(userId: string): Promise<number> {
  const r = await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  return r.rowCount ?? 0;
}

/** Housekeeping: drop expired rows. */
export async function cleanupExpiredSessions(): Promise<number> {
  const r = await query('DELETE FROM sessions WHERE expires_at < NOW()');
  return r.rowCount ?? 0;
}
