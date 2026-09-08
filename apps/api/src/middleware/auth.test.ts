import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import {
  readSessionCookie, requireAuth, requireRole, requireAdmin, accountScope,
  rateLimitLogin, __resetLoginRateLimit,
} from './auth';
import { SESSION_COOKIE } from '../services/session';
import { scopeClause } from './ownership';

function req(over: Partial<Request> = {}): Request {
  return { headers: {}, path: '/test', ...over } as Request;
}

function res() {
  const r: Record<string, unknown> = {};
  r.statusCode = 200;
  r.status = vi.fn((code: number) => { r.statusCode = code; return r; });
  r.setHeader = vi.fn();
  r.json = vi.fn((body: unknown) => { r.body = body; return r; });
  return r as unknown as Response & { statusCode: number; body: { error: string } };
}

describe('readSessionCookie', () => {
  it('finds the session cookie among several', () => {
    const r = req({ headers: { cookie: `theme=dark; ${SESSION_COOKIE}=abc123; other=x` } });
    expect(readSessionCookie(r)).toBe('abc123');
  });

  it('handles it being first or last', () => {
    expect(readSessionCookie(req({ headers: { cookie: `${SESSION_COOKIE}=tok; a=b` } }))).toBe('tok');
    expect(readSessionCookie(req({ headers: { cookie: `a=b; ${SESSION_COOKIE}=tok` } }))).toBe('tok');
  });

  it('tolerates surrounding whitespace', () => {
    expect(readSessionCookie(req({ headers: { cookie: `a=b;   ${SESSION_COOKIE}=tok  ` } }))).toBe('tok');
  });

  it('percent-decodes an encoded value', () => {
    const r = req({ headers: { cookie: `${SESSION_COOKIE}=a%2Bb%3Dc` } });
    expect(readSessionCookie(r)).toBe('a+b=c');
  });

  it('returns the raw value when decoding would throw', () => {
    const r = req({ headers: { cookie: `${SESSION_COOKIE}=%E0%A4%A` } });
    expect(readSessionCookie(r)).toBe('%E0%A4%A');
  });

  it('returns undefined with no cookie header or no match', () => {
    expect(readSessionCookie(req())).toBeUndefined();
    expect(readSessionCookie(req({ headers: { cookie: 'a=b; c=d' } }))).toBeUndefined();
  });

  it('does not match a cookie whose name merely contains the session name', () => {
    const r = req({ headers: { cookie: `not_${SESSION_COOKIE}=nope` } });
    expect(readSessionCookie(r)).toBeUndefined();
  });
});

describe('requireAuth', () => {
  it('passes an authenticated request through', () => {
    const next = vi.fn();
    requireAuth(req({ user: { id: 'u1', email: 'a@b.c', name: 'A', role: 'customer' } }), res(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('401s an anonymous request and does not call next', () => {
    const next = vi.fn();
    const r = res();
    requireAuth(req(), r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(401);
  });
});

describe('requireRole / requireAdmin', () => {
  const admin = { id: 'a1', email: 'a@b.c', name: 'Admin', role: 'admin' as const };
  const customer = { id: 'c1', email: 'c@b.c', name: 'Cust', role: 'customer' as const };

  it('admits a matching role', () => {
    const next = vi.fn();
    requireAdmin(req({ user: admin }), res(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('403s a customer hitting an admin route', () => {
    const next = vi.fn();
    const r = res();
    requireAdmin(req({ user: customer }), r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(403);
  });

  it('401s rather than 403s when nobody is signed in', () => {
    const r = res();
    requireAdmin(req(), r, vi.fn());
    expect(r.statusCode).toBe(401);
  });

  it('accepts any of several permitted roles', () => {
    const next = vi.fn();
    requireRole('admin', 'customer')(req({ user: customer }), res(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('rateLimitLogin', () => {
  // Login runs a ~128 MB scrypt even for an unknown email, on purpose, so that
  // a missing account cannot be spotted by timing. That makes an unlimited
  // login endpoint a memory amplifier, and the per-account lockout cannot help
  // when the attacker never names a real account.
  beforeEach(() => __resetLoginRateLimit());

  const attempt = (ip: string) => {
    const r = res();
    const next = vi.fn();
    rateLimitLogin(req({ ip }), r, next);
    return { passed: next.mock.calls.length > 0, status: r.statusCode, res: r };
  };

  it('allows attempts up to the limit', () => {
    for (let i = 0; i < 10; i++) expect(attempt('1.2.3.4').passed).toBe(true);
  });

  it('refuses the eleventh with 429 and does not reach the handler', () => {
    for (let i = 0; i < 10; i++) attempt('1.2.3.4');
    const blocked = attempt('1.2.3.4');
    expect(blocked.passed).toBe(false);
    expect(blocked.status).toBe(429);
  });

  it('sets Retry-After so a client knows when to come back', () => {
    for (let i = 0; i < 11; i++) attempt('1.2.3.4');
    const r = res();
    rateLimitLogin(req({ ip: '1.2.3.4' }), r, vi.fn());
    expect((r.setHeader as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'Retry-After')).toBe(true);
  });

  it('tracks each IP separately — one abuser does not lock everyone out', () => {
    for (let i = 0; i < 11; i++) attempt('1.2.3.4');
    expect(attempt('5.6.7.8').passed).toBe(true);
  });

  it('handles a missing IP without throwing', () => {
    const r = res();
    const next = vi.fn();
    rateLimitLogin(req(), r, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('scope clauses', () => {
  const admin = { id: 'a1', email: 'a@b.c', name: 'Admin', role: 'admin' as const };
  const customer = { id: 'c1', email: 'c@b.c', name: 'Cust', role: 'customer' as const };

  it('gives admins an always-true predicate with no parameters', () => {
    const s = scopeClause(req({ user: admin }), 'ba', 1);
    expect(s.clause).toBe('TRUE');
    expect(s.params).toEqual([]);
  });

  it('restricts a customer to their own rows', () => {
    const s = scopeClause(req({ user: customer }), 'ba', 1);
    expect(s.clause).toBe('ba.user_id = $1');
    expect(s.params).toEqual(['c1']);
  });

  it('honours the placeholder offset so it can follow other parameters', () => {
    expect(scopeClause(req({ user: customer }), 'gt', 3).clause).toBe('gt.user_id = $3');
  });

  it('accountScope never yields an unfiltered query for an anonymous caller', () => {
    // Defence in depth: requireAuth should already have rejected, but if this
    // is ever reached it must not fall back to TRUE.
    const s = accountScope(req(), 'ba', 1);
    expect(s.clause).toBe('ba.user_id = $1');
    expect(s.params[0]).not.toBe('');
  });
});
