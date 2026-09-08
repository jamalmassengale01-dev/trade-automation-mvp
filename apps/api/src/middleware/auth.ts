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
