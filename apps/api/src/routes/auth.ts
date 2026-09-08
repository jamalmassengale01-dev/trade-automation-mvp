/**
 * Authentication routes.
 *
 * Session cookie is httpOnly (JavaScript cannot read it, so XSS cannot steal
 * it), SameSite=Lax, and Secure in production.
 */

import { Router, Request, Response } from 'express';
import { query } from '../db';
import {
  hashPassword, verifyPassword, needsRehash, checkPasswordPolicy,
} from '../services/password';
import {
  createSession, revokeSession, revokeAllUserSessions,
  SESSION_COOKIE, SESSION_TTL_MS,
} from '../services/session';
import { requireAuth, readSessionCookie, rateLimitLogin } from '../middleware/auth';
import config from '../config';
import logger from '../utils/logger';

const router = Router();
const log = logger.child({ context: 'AuthRoute' });

/** Lock an account after this many consecutive failures. */
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

function setSessionCookie(res: Response, token: string): void {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (config.isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res: Response): void {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (config.isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

interface UserRow extends Record<string, unknown> {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'customer';
  password_hash: string | null;
  is_active: boolean;
  failed_login_count: number;
  locked_until: Date | null;
}

/**
 * POST /api/auth/login
 *
 * Returns an identical error for unknown email, wrong password, and inactive
 * account. Distinguishing them would let anyone enumerate which addresses have
 * accounts.
 */
router.post('/login', rateLimitLogin, async (req: Request, res: Response) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!email || !password) {
    res.status(400).json({ success: false, error: 'Email and password are required' });
    return;
  }

  const GENERIC = 'Invalid email or password';

  try {
    const r = await query<UserRow>(
      `SELECT id, email, name, role, password_hash, is_active, failed_login_count, locked_until
       FROM users WHERE LOWER(email) = $1`,
      [email]
    );
    const user = r.rows[0];

    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
      res.status(429).json({
        success: false,
        error: `Too many failed attempts. Try again in ${mins} minute(s).`,
      });
      return;
    }

    // Always run a verification, even with no user row, so a missing account
    // does not return measurably faster than a wrong password.
    const ok = await verifyPassword(password, user?.password_hash ?? null);

    if (!user || !ok || !user.is_active) {
      if (user) {
        const failures = user.failed_login_count + 1;
        const lock = failures >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MS) : null;
        await query(
          `UPDATE users SET failed_login_count = $2, locked_until = COALESCE($3, locked_until)
           WHERE id = $1`,
          [user.id, failures, lock]
        );
        if (lock) log.warn('Account locked after repeated failures', { userId: user.id, failures });
      }
      log.warn('Failed login', { email, reason: !user ? 'no_user' : !ok ? 'bad_password' : 'inactive' });
      res.status(401).json({ success: false, error: GENERIC });
      return;
    }

    // Opportunistically upgrade a hash made with weaker parameters.
    if (needsRehash(user.password_hash)) {
      try {
        await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
          user.id, await hashPassword(password),
        ]);
      } catch (err) {
        log.warn('Password rehash failed', { userId: user.id, error: String(err) });
      }
    }

    await query(
      `UPDATE users SET last_login_at = NOW(), failed_login_count = 0, locked_until = NULL
       WHERE id = $1`,
      [user.id]
    );

    const { token } = await createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    setSessionCookie(res, token);

    log.info('Login succeeded', { userId: user.id, role: user.role });
    res.json({
      success: true,
      data: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (error) {
    log.error('Login failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

/** POST /api/auth/logout */
router.post('/logout', async (req: Request, res: Response) => {
  try {
    await revokeSession(readSessionCookie(req));
  } catch (error) {
    log.warn('Logout revoke failed', { error: String(error) });
  }
  clearSessionCookie(res);
  res.json({ success: true, message: 'Logged out' });
});

/** GET /api/auth/me — who the caller is, or 401. */
router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({ success: true, data: req.user });
});

/**
 * POST /api/auth/change-password
 * Requires the current password, and revokes every other session on success —
 * a password change should evict anyone already holding a stolen cookie.
 */
router.post('/change-password', requireAuth, async (req: Request, res: Response) => {
  const current = typeof req.body?.current_password === 'string' ? req.body.current_password : '';
  const next = typeof req.body?.new_password === 'string' ? req.body.new_password : '';

  const policy = checkPasswordPolicy(next);
  if (!policy.ok) {
    res.status(400).json({ success: false, error: policy.reason });
    return;
  }

  try {
    const r = await query<{ password_hash: string | null }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user!.id]
    );
    if (!(await verifyPassword(current, r.rows[0]?.password_hash ?? null))) {
      res.status(401).json({ success: false, error: 'Current password is incorrect' });
      return;
    }

    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      req.user!.id, await hashPassword(next),
    ]);
    await revokeAllUserSessions(req.user!.id);

    const { token } = await createSession(req.user!.id, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    setSessionCookie(res, token);

    log.info('Password changed', { userId: req.user!.id });
    res.json({ success: true, message: 'Password updated. Other sessions were signed out.' });
  } catch (error) {
    log.error('Password change failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to change password' });
  }
});

export default router;
