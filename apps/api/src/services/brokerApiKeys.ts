/**
 * Broker API keys — the credentials that belong to the operator, not to any
 * one account.
 *
 * Tradovate authentication needs seven fields and they have two different
 * owners. A prop firm issues a username and a password per account. The `cid`
 * and `sec` come from an API key created under your own Tradovate login, and
 * are the same for every account you run. `appId`, `appVersion` and `deviceId`
 * identify the client and are not credentials at all.
 *
 * Storing the operator half once and merging it in at account creation means
 * connecting an account asks only for what the firm actually sends you.
 */

import { randomUUID } from 'crypto';
import { query } from '../db';

export const DEFAULT_APP_ID = 'EdgePilot';
export const DEFAULT_APP_VERSION = '1.0';

export interface BrokerApiKey {
  cid: string;
  sec: string;
  appId: string;
  appVersion: string;
}

/** What is safe to send to a browser: everything except the secret itself. */
export interface BrokerApiKeySummary {
  broker: string;
  cid: string;
  appId: string;
  appVersion: string;
  /** The secret is never returned. This says only whether one is stored. */
  secretSet: boolean;
  updatedAt: string;
}

// A `type` rather than an `interface` deliberately: query<T> constrains T to
// Record<string, unknown>, and an interface has no implicit index signature so
// it fails that constraint. This is the cause of most of the repo's standing
// type errors; no need to add three more.
type Row = {
  broker: string;
  cid: string;
  sec: string;
  app_id: string;
  app_version: string;
  updated_at: Date;
};

export async function getApiKey(
  userId: string,
  broker = 'tradovate',
): Promise<BrokerApiKey | null> {
  const r = await query<Row>(
    `SELECT broker, cid, sec, app_id, app_version, updated_at
       FROM broker_api_keys WHERE user_id = $1 AND broker = $2`,
    [userId, broker],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    cid: row.cid,
    sec: row.sec,
    appId: row.app_id || DEFAULT_APP_ID,
    appVersion: row.app_version || DEFAULT_APP_VERSION,
  };
}

export async function getApiKeySummary(
  userId: string,
  broker = 'tradovate',
): Promise<BrokerApiKeySummary | null> {
  const r = await query<Row>(
    `SELECT broker, cid, sec, app_id, app_version, updated_at
       FROM broker_api_keys WHERE user_id = $1 AND broker = $2`,
    [userId, broker],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    broker: row.broker,
    cid: row.cid,
    appId: row.app_id,
    appVersion: row.app_version,
    secretSet: row.sec.length > 0,
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface SaveApiKeyInput {
  cid: string;
  sec: string;
  appId?: string;
  appVersion?: string;
}

/**
 * A Tradovate `cid` is a small positive integer. Anything else is not a client
 * ID, and the most likely thing to be typed in its place is the prop firm's
 * account username — the two fields sit next to each other and both look like
 * "the ID of the thing I am connecting".
 *
 * Rejecting it here rather than at authentication time is the whole point.
 * `credentialsToAuthRequest` does `Number(cid)`, so a username becomes `NaN`,
 * which `JSON.stringify` writes as `cid: null`. Tradovate then returns its
 * generic rejection text, which `classifyAuthResponse` can only read as
 * `'credentials'` — and the operator is told their username and password were
 * refused, which is false and sends them to re-check the one thing that was
 * right. That conversation happens inside a 30-minute session window.
 */
export function validateCid(cid: string): void {
  if (!/^\d+$/.test(cid)) {
    throw new Error(
      `"${cid}" is not a Tradovate client ID. The cid is a number (e.g. 12345) ` +
      'issued with an API key under your own Tradovate account, Application ' +
      'Settings → API Access. It is not your prop firm username, and no prop ' +
      'firm issues one — the account login goes on the account itself, not here.',
    );
  }
}

export async function saveApiKey(
  userId: string,
  input: SaveApiKeyInput,
  broker = 'tradovate',
): Promise<BrokerApiKeySummary> {
  const cid = input.cid.trim();
  const sec = input.sec.trim();
  if (!cid) throw new Error('Client ID (cid) is required');
  if (!sec) throw new Error('Client Secret (sec) is required');
  validateCid(cid);

  const r = await query<Row>(
    `INSERT INTO broker_api_keys (user_id, broker, cid, sec, app_id, app_version)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, broker) DO UPDATE
       SET cid = EXCLUDED.cid, sec = EXCLUDED.sec,
           app_id = EXCLUDED.app_id, app_version = EXCLUDED.app_version,
           updated_at = NOW()
     RETURNING broker, cid, sec, app_id, app_version, updated_at`,
    [
      userId, broker, cid, sec,
      input.appId?.trim() || DEFAULT_APP_ID,
      input.appVersion?.trim() || DEFAULT_APP_VERSION,
    ],
  );
  const row = r.rows[0];
  return {
    broker: row.broker,
    cid: row.cid,
    appId: row.app_id,
    appVersion: row.app_version,
    secretSet: true,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function deleteApiKey(userId: string, broker = 'tradovate'): Promise<boolean> {
  const r = await query(
    'DELETE FROM broker_api_keys WHERE user_id = $1 AND broker = $2',
    [userId, broker],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface CredentialResolution {
  credentials: Record<string, unknown>;
  /** Fields still missing after merging. Empty means ready to authenticate. */
  missing: string[];
  /** True when the stored API key supplied cid/sec. */
  usedStoredKey: boolean;
}

/**
 * Fill in everything the caller did not supply.
 *
 * Explicit values always win, so a per-account override stays possible — it is
 * not settled whether a prop firm's Tradovate login can carry its own API key,
 * and a design that assumes one shared key would be impossible to work around
 * if the answer turns out to be no.
 *
 * `deviceId` is generated rather than requested. Tradovate wants it stable per
 * client; asking a person to paste a UUID achieves nothing they could get
 * right and several things they could get wrong.
 */
export function resolveTradovateCredentials(
  supplied: Record<string, unknown>,
  storedKey: BrokerApiKey | null,
): CredentialResolution {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  const credentials: Record<string, unknown> = {
    username: str(supplied.username),
    password: str(supplied.password),
    cid: str(supplied.cid) || storedKey?.cid || '',
    sec: str(supplied.sec) || storedKey?.sec || '',
    appId: str(supplied.appId) || storedKey?.appId || DEFAULT_APP_ID,
    appVersion: str(supplied.appVersion) || storedKey?.appVersion || DEFAULT_APP_VERSION,
    deviceId: str(supplied.deviceId) || randomUUID(),
    environment: str(supplied.environment) === 'live' ? 'live' : 'demo',
  };

  const usedStoredKey =
    !str(supplied.cid) && !str(supplied.sec) && Boolean(storedKey?.cid && storedKey?.sec);

  const missing: string[] = [];
  if (!credentials.username) missing.push('username');
  if (!credentials.password) missing.push('password');
  if (!credentials.cid) missing.push('cid');
  if (!credentials.sec) missing.push('sec');

  return { credentials, missing, usedStoredKey };
}

/**
 * A sentence naming the fix, not a list of field names.
 *
 * Where a missing field comes from decides what the person has to go and do,
 * and those are two very different errands: one is an email from the prop
 * firm, the other is a paid add-on on Tradovate's own site.
 */
export function describeMissingCredentials(missing: string[]): string {
  const fromFirm = missing.filter((m) => m === 'username' || m === 'password');
  const fromKey = missing.filter((m) => m === 'cid' || m === 'sec');

  const parts: string[] = [];
  if (fromFirm.length > 0) {
    parts.push(
      `${fromFirm.join(' and ')} — the login your prop firm sent you when the account was issued`,
    );
  }
  if (fromKey.length > 0) {
    parts.push(
      'no Tradovate API key is saved — add one under Settings. It comes from ' +
      'Tradovate (Application Settings → API Access), needs the API Access ' +
      'add-on, and is the same key for every account you connect',
    );
  }
  return `Cannot connect this account: ${parts.join('; ')}.`;
}
