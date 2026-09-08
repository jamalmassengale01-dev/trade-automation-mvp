/**
 * Authentication and authorisation middleware.
 *
 * Two roles:
 *   admin    — manages presets, the firm-rule catalog, and every account.
 *   customer — sees and controls only their own broker accounts.
 *
 * The webhook path is deliberately NOT covered by any of this: TradingView
 * cannot hold a session, so it authenticates with a per-strategy secret in the
 * URL instead. Do not mount requireAuth on /webhook.
 */

import { Request, Response, NextFunction } from 'express';
import { resolveSession, SESSION_COOKIE, SessionUser, UserRole } from '../services/session';
import logger from '../utils/logger';

const log = logger.child({ context: 'AuthMiddleware' });

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

/**
 * Read the session cookie without pulling in cookie-parser.
 * Cookie values are percent-encoded by the browser; decode defensively.
 */
export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== SESSION_COOKIE) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** Attach req.user when a valid session exists. Never rejects. */
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await resolveSession(readSessionCookie(req));
    if (user) req.user = user;
  } catch (error) {
    log.error('Failed to resolve session', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  next();
}

/** Reject anyone without a valid session. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }
  next();
}

/** Reject anyone who is not an admin. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      log.warn('Forbidden: insufficient role', {
        userId: req.user.id, role: req.user.role, required: roles, path: req.path,
      });
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

export const requireAdmin = requireRole('admin');

/**
 * Per-IP rate limit for unauthenticated endpoints.
 *
 * In-memory and per-process on purpose: the resource being protected is THIS
 * process's memory, and a database round-trip on the login path would add the
 * latency the limiter exists to avoid. Behind multiple replicas this bounds
 * each replica rather than the cluster, which is the right first defence but
 * not the last one.
 *
 * Must run BEFORE the password verification, not after — the whole point is to
 * refuse the request before it reserves ~128 MB of scrypt working memory.
 */
interface Bucket { hits: number[]; }
const loginBuckets = new Map<string, Bucket>();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_PER_WINDOW = 10;
/** Stop the map growing without bound under a rotating-IP flood. */
const MAX_TRACKED_IPS = 10_000;

export function rateLimitLogin(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const cutoff = now - LOGIN_WINDOW_MS;

  let bucket = loginBuckets.get(ip);
  if (!bucket) {
    if (loginBuckets.size >= MAX_TRACKED_IPS) {
      // Drop the coldest entries rather than refusing service outright.
      for (const [key, b] of loginBuckets) {
        if (b.hits.every((t) => t < cutoff)) loginBuckets.delete(key);
        if (loginBuckets.size < MAX_TRACKED_IPS) break;
      }
    }
    bucket = { hits: [] };
    loginBuckets.set(ip, bucket);
  }

  bucket.hits = bucket.hits.filter((t) => t >= cutoff);

  if (bucket.hits.length >= LOGIN_MAX_PER_WINDOW) {
    const retryAfter = Math.ceil((bucket.hits[0] + LOGIN_WINDOW_MS - now) / 1000);
    log.warn('Login rate limit hit', { ip, attempts: bucket.hits.length });
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      success: false,
      error: `Too many sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
    });
    return;
  }

  bucket.hits.push(now);
  next();
}

/** Testing hook — clears accumulated login buckets. */
export function __resetLoginRateLimit(): void {
  loginBuckets.clear();
}

/**
 * Ownership scope for list queries.
 *
 * Returns a SQL fragment and parameter for filtering to the caller's own rows.
 * Admins get an always-true predicate so the same query text serves both roles
 * — the alternative, branching the SQL, is where scoping bugs breed.
 *
 * Usage:
 *   const scope = accountScope(req, 'ba', 1);
 *   query(`SELECT * FROM broker_accounts ba WHERE ${scope.clause}`, scope.params);
 */
export function accountScope(
  req: Request,
  alias: string,
  startIndex = 1
): { clause: string; params: string[] } {
  if (req.user?.role === 'admin') return { clause: 'TRUE', params: [] };
  return {
    clause: `${alias}.user_id = $${startIndex}`,
    params: [req.user?.id ?? '00000000-0000-0000-0000-000000000000'],
  };
}

/**
 * Assert the caller may act on a specific account.
 * Throws a 403-shaped error the route can surface; admins always pass.
 */
export async function assertAccountAccess(
  req: Request,
  accountId: string,
  lookup: (id: string) => Promise<{ user_id: string | null } | undefined>
): Promise<boolean> {
  if (req.user?.role === 'admin') return true;
  const row = await lookup(accountId);
  if (!row) return false;
  return row.user_id === req.user?.id;
}
