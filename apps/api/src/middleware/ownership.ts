/**
 * Row-level ownership guards.
 *
 * Authentication without authorisation is worse than none — it creates
 * confidence that a boundary exists when it does not. These guards are the
 * boundary.
 *
 * They mount via `router.param`, so every route in a router that takes the
 * named parameter is covered automatically. That matters more than it sounds:
 * the alternative is remembering to add a WHERE clause to each of a dozen
 * handlers, and the one that gets forgotten is the vulnerability.
 */

import { Request, Response, NextFunction } from 'express';
import { query } from '../db';
import logger from '../utils/logger';

const log = logger.child({ context: 'OwnershipMiddleware' });

/**
 * Build a router.param guard that checks the caller owns the referenced row.
 *
 * Admins bypass. A missing row and a row owned by someone else both return
 * 404 — telling a customer "403 Forbidden" would confirm that an id they do
 * not own exists.
 */
export function ownsRow(table: 'broker_accounts' | 'strategies') {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
    value: string
  ): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    if (req.user.role === 'admin') {
      next();
      return;
    }

    // Reject malformed ids before they reach Postgres, which errors on a bad
    // uuid cast and would surface as a 500 rather than a clean 404.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }

    try {
      const r = await query<{ user_id: string | null }>(
        `SELECT user_id FROM ${table} WHERE id = $1`,
        [value]
      );
      const row = r.rows[0];
      if (!row || row.user_id !== req.user.id) {
        log.warn('Ownership check failed', {
          userId: req.user.id, table, rowId: value, exists: !!row,
        });
        res.status(404).json({ success: false, error: 'Not found' });
        return;
      }
      next();
    } catch (error) {
      log.error('Ownership check errored', {
        table, rowId: value, error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, error: 'Authorization check failed' });
    }
  };
}

/**
 * WHERE fragment scoping a list query to the caller's rows.
 * Admins get TRUE so one query text serves both roles.
 */
export function scopeClause(
  req: Request,
  alias: string,
  paramIndex: number
): { clause: string; params: string[] } {
  if (req.user?.role === 'admin') return { clause: 'TRUE', params: [] };
  return { clause: `${alias}.user_id = $${paramIndex}`, params: [req.user!.id] };
}
