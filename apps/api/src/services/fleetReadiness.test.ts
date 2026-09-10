import { describe, it, expect } from 'vitest';
import { checkAccounts, formatReadiness, AccountRow, ReadinessReport } from './fleetReadiness';

const acct = (over: Partial<AccountRow> = {}): AccountRow => ({
  id: 'a1', name: 'Apex 1', broker_type: 'tradovate',
  is_active: true, is_disabled: false,
  preset_id: 'apex_50k_eod_eval',
  credentials: { username: 'u', password: 'p' },
  account_category: 'eval', account_size: 50_000,
  p_verified_at: new Date('2026-09-01'), p_name: 'Apex 50K EOD Eval',
  ...over,
});

const byArea = (checks: ReturnType<typeof checkAccounts>, area: string) =>
  checks.find((c) => c.area === area);

describe('checkAccounts', () => {
  it('passes a fully configured account', () => {
    const checks = checkAccounts([acct()]);
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('fails with no accounts at all', () => {
    const checks = checkAccounts([]);
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('fail');
    expect(checks[0].remedy).toContain('Add one');
  });

  it('fails an account with no preset, and says why it matters', () => {
    const c = byArea(checkAccounts([acct({ preset_id: null, p_verified_at: null })]), 'accounts.preset');
    expect(c?.status).toBe('fail');
    // The consequence, not just the fact: a preset-less account is silently skipped.
    expect(c?.remedy).toContain('skips the account');
  });

  it('fails an account with no credentials', () => {
    const c = byArea(checkAccounts([acct({ credentials: {} })]), 'accounts.credentials');
    expect(c?.status).toBe('fail');
  });

  it('does not demand credentials from a mock broker', () => {
    const c = byArea(checkAccounts([acct({ broker_type: 'mock', credentials: null })]), 'accounts.credentials');
    expect(c?.status).toBe('pass');
  });

  it('fails an unverified preset — nobody has checked those numbers', () => {
    const c = byArea(checkAccounts([acct({ p_verified_at: null })]), 'presets.verified');
    expect(c?.status).toBe('fail');
    expect(c?.detail).toContain('Apex 1');
    expect(c?.remedy).toContain('never been checked');
  });

  it('warns rather than fails on a missing category', () => {
    // An uncounted account cannot wrongly block a purchase, so it is a warning:
    // the cap check is degraded, not the trade path.
    const c = byArea(checkAccounts([acct({ account_category: null })]), 'accounts.category');
    expect(c?.status).toBe('warn');
  });

  it('warns about a disabled account, and stays silent when there are none', () => {
    expect(byArea(checkAccounts([acct({ is_disabled: true })]), 'accounts.disabled')?.status).toBe('warn');
    expect(byArea(checkAccounts([acct()]), 'accounts.disabled')).toBeUndefined();
  });

  it('names every offending account, not just the first', () => {
    const checks = checkAccounts([
      acct({ id: 'a', name: 'One', preset_id: null, p_verified_at: null }),
      acct({ id: 'b', name: 'Two', preset_id: null, p_verified_at: null }),
    ]);
    const detail = byArea(checks, 'accounts.preset')?.detail ?? '';
    expect(detail).toContain('One');
    expect(detail).toContain('Two');
  });

  it('reports each problem independently on one account', () => {
    const checks = checkAccounts([acct({ preset_id: null, credentials: {}, account_category: null, p_verified_at: null })]);
    expect(byArea(checks, 'accounts.preset')?.status).toBe('fail');
    expect(byArea(checks, 'accounts.credentials')?.status).toBe('fail');
    expect(byArea(checks, 'accounts.category')?.status).toBe('warn');
  });
});

describe('formatReadiness', () => {
  it('leads with the verdict and includes remedies', () => {
    const report: ReadinessReport = {
      ready: false,
      checks: [{ area: 'strategy', status: 'fail', detail: 'None configured', remedy: 'Create one' }],
    };
    const out = formatReadiness(report);
    expect(out).toContain('NOT READY');
    expect(out).toContain('→ Create one');
  });

  it('says ready but surfaces the warning count rather than hiding it', () => {
    const report: ReadinessReport = {
      ready: true,
      checks: [
        { area: 'schema', status: 'pass', detail: 'ok' },
        { area: 'env.notifications', status: 'warn', detail: 'none', remedy: 'set it' },
      ],
    };
    const out = formatReadiness(report);
    expect(out).toContain('READY');
    expect(out).toContain('1 warning(s)');
  });
});
