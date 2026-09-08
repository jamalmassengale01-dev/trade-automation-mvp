import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  checkPasswordPolicy,
  generateSessionToken,
  hashSessionToken,
} from './password';

const GOOD = 'correct horse battery staple';

describe('checkPasswordPolicy', () => {
  it('accepts a reasonable passphrase', () => {
    expect(checkPasswordPolicy(GOOD).ok).toBe(true);
  });

  it.each([
    ['too short', 'short'],
    ['empty', ''],
    ['leading whitespace', ' padded password here'],
    ['trailing whitespace', 'padded password here '],
  ])('rejects %s', (_label, pw) => {
    expect(checkPasswordPolicy(pw).ok).toBe(false);
  });

  it('rejects absurdly long input rather than hashing it', () => {
    expect(checkPasswordPolicy('a'.repeat(500)).ok).toBe(false);
  });
});

describe('hashPassword / verifyPassword', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword(GOOD);
    expect(await verifyPassword(GOOD, hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword(GOOD);
    expect(await verifyPassword('wrong password entirely', hash)).toBe(false);
  });

  it('is salted — the same password hashes differently every time', async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword(GOOD, b)).toBe(true);
  });

  it('emits the documented versioned format', async () => {
    const hash = await hashPassword(GOOD);
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBe(1 << 17);
  });

  it('refuses to hash a password that fails policy', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 12/);
  });

  describe('never throws on bad stored hashes', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty', ''],
      ['not our format', 'plaintextpassword'],
      ['wrong algorithm', 'bcrypt$10$abc$def$ghi$jkl'],
      ['too few fields', 'scrypt$131072$8$1$salt'],
      ['non-numeric params', 'scrypt$abc$8$1$c2FsdA==$a2V5'],
      ['empty salt', 'scrypt$131072$8$1$$a2V5'],
    ])('returns false for %s', async (_label, stored) => {
      await expect(verifyPassword(GOOD, stored as string | null)).resolves.toBe(false);
    });

    it('refuses tampered parameters that would allocate unbounded memory', async () => {
      const absurd = `scrypt$${2 ** 30}$99$99$c2FsdA==$a2V5`;
      await expect(verifyPassword(GOOD, absurd)).resolves.toBe(false);
    });
  });

  it('rejects an empty password even against a valid hash', async () => {
    const hash = await hashPassword(GOOD);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('an account with no password set can never authenticate', async () => {
    // Invited-but-not-activated users have password_hash NULL.
    expect(await verifyPassword('anything at all', null)).toBe(false);
    expect(await verifyPassword('', null)).toBe(false);
  });
});

describe('needsRehash', () => {
  it('is false for a current-parameter hash', async () => {
    expect(needsRehash(await hashPassword(GOOD))).toBe(false);
  });

  it('is true for weaker parameters', () => {
    expect(needsRehash('scrypt$16384$8$1$c2FsdA==$a2V5')).toBe(true);
  });

  it('is true for a foreign format that should be migrated', () => {
    expect(needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
  });

  it('is false for no hash — there is nothing to upgrade', () => {
    expect(needsRehash(null)).toBe(false);
  });
});

describe('session tokens', () => {
  it('generates distinct high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
    expect(tokens.size).toBe(200);
    expect(generateSessionToken().length).toBeGreaterThanOrEqual(42);
  });

  it('is url-safe, so it survives a cookie round-trip unencoded', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSessionToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('hashes deterministically and never stores the raw token', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toBe(hashSessionToken(token));
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maps different tokens to different hashes', () => {
    expect(hashSessionToken(generateSessionToken()))
      .not.toBe(hashSessionToken(generateSessionToken()));
  });
});
