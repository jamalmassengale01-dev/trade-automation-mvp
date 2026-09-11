import { describe, it, expect } from 'vitest';
import {
  resolveTradovateCredentials,
  describeMissingCredentials,
  DEFAULT_APP_ID,
  DEFAULT_APP_VERSION,
  BrokerApiKey,
} from './brokerApiKeys';

const KEY: BrokerApiKey = {
  cid: '12345',
  sec: 'super-secret',
  appId: 'EdgePilot',
  appVersion: '1.0',
};

/** What a prop firm actually sends you, and nothing else. */
const FROM_PROP_FIRM = { username: 'APEX123456', password: 'firm-issued-pw' };

describe('resolveTradovateCredentials', () => {
  it('completes a connection from only the username and password a firm issues', () => {
    const r = resolveTradovateCredentials(FROM_PROP_FIRM, KEY);
    expect(r.missing).toEqual([]);
    expect(r.usedStoredKey).toBe(true);
    expect(r.credentials.cid).toBe('12345');
    expect(r.credentials.sec).toBe('super-secret');
  });

  it('generates a deviceId rather than asking for one', () => {
    const r = resolveTradovateCredentials(FROM_PROP_FIRM, KEY);
    expect(r.credentials.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('gives each account its own deviceId', () => {
    const a = resolveTradovateCredentials(FROM_PROP_FIRM, KEY);
    const b = resolveTradovateCredentials(FROM_PROP_FIRM, KEY);
    expect(a.credentials.deviceId).not.toBe(b.credentials.deviceId);
  });

  it('defaults appId and appVersion when no key is stored', () => {
    const r = resolveTradovateCredentials({ ...FROM_PROP_FIRM, cid: '9', sec: 's' }, null);
    expect(r.credentials.appId).toBe(DEFAULT_APP_ID);
    expect(r.credentials.appVersion).toBe(DEFAULT_APP_VERSION);
    expect(r.missing).toEqual([]);
  });

  it('lets an explicit cid/sec override the stored key', () => {
    // Whether a prop firm's own Tradovate login can carry its own API key is
    // unresolved. A design that assumes one shared key would have no way out
    // if the answer is no, so the override has to keep working.
    const r = resolveTradovateCredentials(
      { ...FROM_PROP_FIRM, cid: '999', sec: 'per-account' },
      KEY,
    );
    expect(r.credentials.cid).toBe('999');
    expect(r.credentials.sec).toBe('per-account');
    expect(r.usedStoredKey).toBe(false);
  });

  it('reports cid and sec missing when no key is stored', () => {
    const r = resolveTradovateCredentials(FROM_PROP_FIRM, null);
    expect(r.missing).toEqual(['cid', 'sec']);
  });

  it('reports the firm-issued fields missing when they are blank', () => {
    const r = resolveTradovateCredentials({ username: '  ', password: '' }, KEY);
    expect(r.missing).toEqual(['username', 'password']);
  });

  it('trims whitespace, which is what pasting from an email produces', () => {
    const r = resolveTradovateCredentials(
      { username: '  APEX123456 ', password: ' pw-with-spaces ' },
      KEY,
    );
    expect(r.credentials.username).toBe('APEX123456');
    expect(r.credentials.password).toBe('pw-with-spaces');
  });

  it('defaults the environment to demo, never live', () => {
    // An account that silently defaults to live places real orders. The safe
    // value has to be the one you get by omission.
    expect(resolveTradovateCredentials(FROM_PROP_FIRM, KEY).credentials.environment).toBe('demo');
    expect(
      resolveTradovateCredentials({ ...FROM_PROP_FIRM, environment: 'nonsense' }, KEY)
        .credentials.environment,
    ).toBe('demo');
    expect(
      resolveTradovateCredentials({ ...FROM_PROP_FIRM, environment: 'live' }, KEY)
        .credentials.environment,
    ).toBe('live');
  });

  it('ignores non-string input instead of storing it', () => {
    const r = resolveTradovateCredentials(
      { username: 42, password: null, cid: {}, sec: [] } as Record<string, unknown>,
      null,
    );
    expect(r.credentials.username).toBe('');
    expect(r.missing).toContain('username');
    expect(r.missing).toContain('password');
  });
});

describe('describeMissingCredentials', () => {
  it('sends you to the prop firm for the login half', () => {
    const msg = describeMissingCredentials(['username', 'password']);
    expect(msg).toContain('prop firm');
    expect(msg).not.toContain('API Access');
  });

  it('sends you to Tradovate for the API key half', () => {
    const msg = describeMissingCredentials(['cid', 'sec']);
    expect(msg).toContain('Settings');
    expect(msg).toContain('API Access');
  });

  it('names both errands when both halves are missing', () => {
    const msg = describeMissingCredentials(['username', 'password', 'cid', 'sec']);
    expect(msg).toContain('prop firm');
    expect(msg).toContain('API Access');
  });

  it('never echoes a raw field name as the whole explanation', () => {
    // "Missing: sec" tells someone nothing about where to get a sec.
    for (const missing of [['cid'], ['sec'], ['username'], ['password']]) {
      const msg = describeMissingCredentials(missing);
      expect(msg.length).toBeGreaterThan(40);
    }
  });
});
