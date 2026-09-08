/**
 * Password hashing.
 *
 * Uses scrypt from node's own crypto module rather than pulling in bcrypt.
 * scrypt is memory-hard (OWASP-recommended alongside argon2), needs no native
 * compilation, and adds no dependency to audit. Parameters below are the OWASP
 * minimum for scrypt: N=2^17, r=8, p=1.
 *
 * Hash format is versioned so parameters can be raised later and old hashes
 * upgraded transparently on next successful login:
 *
 *   scrypt$<N>$<r>$<p>$<salt-b64>$<key-b64>
 */

import { randomBytes, scrypt, timingSafeEqual, createHash, ScryptOptions } from 'crypto';

// Hand-rolled rather than promisify(scrypt): promisify resolves to the 3-arg
// overload, which drops the options object carrying N/r/p.
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

const N = 1 << 17; // CPU/memory cost
const R = 8;       // block size
const P = 1;       // parallelisation
const KEY_LEN = 64;
const SALT_LEN = 16;

// scrypt needs maxmem above roughly 128 * N * r bytes or it throws.
const MAX_MEM = 256 * N * R;

export interface PasswordPolicyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Minimum viable policy: length does far more work than composition rules,
 * which mostly push people toward predictable substitutions.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (typeof password !== 'string' || password.length < 12) {
    return { ok: false, reason: 'Password must be at least 12 characters' };
  }
  if (password.length > 200) {
    return { ok: false, reason: 'Password must be at most 200 characters' };
  }
  if (/^\s|\s$/.test(password)) {
    return { ok: false, reason: 'Password must not start or end with whitespace' };
  }
  return { ok: true };
}

export async function hashPassword(password: string): Promise<string> {
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) throw new Error(policy.reason);

  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, KEY_LEN, {
    N, r: R, p: P, maxmem: MAX_MEM,
  });

  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false — never throws — for a null, empty, or malformed hash, so an
 * account with no password set (invited but not activated) simply cannot
 * authenticate rather than crashing the login route.
 */
export async function verifyPassword(
  password: string,
  storedHash: string | null | undefined
): Promise<boolean> {
  if (!storedHash || typeof password !== 'string' || password.length === 0) return false;

  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters from a tampered row rather than letting them
  // allocate unbounded memory.
  if (n < 1024 || n > (1 << 20) || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await scryptAsync(password, salt, expected.length, {
      N: n, r, p, maxmem: 256 * n * r,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash used weaker parameters than we now require. */
export function needsRehash(storedHash: string | null | undefined): boolean {
  if (!storedHash) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < N || Number(parts[2]) < R;
}

/** Opaque session token: 32 random bytes, url-safe. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What gets stored for a session token. Hashing at rest means a leaked
 * database does not hand over usable sessions. SHA-256 is correct here (not
 * scrypt) — the token is already 256 bits of entropy, so there is nothing to
 * brute-force and the lookup stays fast enough to run per request.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
