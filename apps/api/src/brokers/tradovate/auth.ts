/**
 * Tradovate access-token acquisition.
 *
 * Split out of the adapter because the interesting part is not the HTTP call —
 * it is the fact that `/auth/accesstokenrequest` has THREE distinct success-ish
 * responses and only one of them contains a token:
 *
 *   1. `{ accessToken, expirationTime, userId }`  — the happy path.
 *   2. `{ errorText: "..." }`                     — a real rejection.
 *   3. `{ "p-ticket", "p-time", "p-captcha" }`    — a time penalty.
 *
 * Case 3 returns HTTP 200 with no token and no error. Code that reads
 * `res.accessToken` straight off the response gets `undefined`, sends
 * `Authorization: Bearer undefined` on the next call, and surfaces as a
 * mystery 401 several layers away from the cause. Tradovate applies the
 * penalty aggressively when one login authenticates repeatedly — which is
 * exactly the shape of a prop-firm fleet, where many accounts share a login
 * and a restart re-authenticates all of them at once.
 *
 * The documented handling is to wait `p-time` seconds and repeat the request
 * with the ticket attached. If `p-captcha` is true there is no programmatic
 * path at all: a human has to log into the web platform to clear it.
 */

export interface TradovateAuthRequest {
  name: string;
  password: string;
  appId: string;
  appVersion: string;
  cid: number;
  sec: string;
  deviceId: string;
}

export interface TradovateAuthResponse {
  accessToken?: string;
  expirationTime?: string;
  userId?: number;
  errorText?: string;
  'p-ticket'?: string;
  'p-time'?: number;
  'p-captcha'?: boolean;
}

export interface TradovateToken {
  accessToken: string;
  expirationTime: string;
  userId: number;
}

/** Why an auth attempt failed, in terms that map to a specific fix. */
export type AuthFailureKind =
  | 'credentials'      // wrong username/password/API-key pair
  | 'captcha'          // human must log into the web platform
  | 'penalty_timeout'  // time-penalised for longer than we are willing to wait
  | 'no_api_access'    // authenticated, but the API Access add-on is not active
  | 'malformed'        // 200 response we cannot interpret
  | 'network';

export class TradovateAuthError extends Error {
  constructor(
    readonly kind: AuthFailureKind,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'TradovateAuthError';
  }
}

/**
 * Classify an auth response body.
 *
 * Kept pure and exported so the failure taxonomy can be tested against real
 * captured payloads without a broker connection.
 */
export type AuthVerdict =
  | { ok: true; token: TradovateToken }
  | { ok: false; error: TradovateAuthError }
  | { penaltySeconds: number; ticket: string };

export function classifyAuthResponse(res: TradovateAuthResponse): AuthVerdict {
  if (res.accessToken && res.expirationTime && res.userId !== undefined) {
    return {
      ok: true,
      token: { accessToken: res.accessToken, expirationTime: res.expirationTime, userId: res.userId },
    };
  }

  if (res['p-captcha']) {
    return {
      ok: false,
      error: new TradovateAuthError(
        'captcha',
        'Tradovate is requiring a captcha. This cannot be cleared from the API — ' +
        'log into the Tradovate web platform with these credentials, complete the ' +
        'captcha, then retry.'
      ),
    };
  }

  const ticket = res['p-ticket'];
  const penalty = res['p-time'];
  if (ticket && typeof penalty === 'number') {
    return { penaltySeconds: penalty, ticket };
  }

  if (res.errorText) {
    // Tradovate returns the same generic text for a bad password and for an
    // account with no API entitlement, so the wording is deliberately careful
    // not to send someone chasing the wrong one.
    return {
      ok: false,
      error: new TradovateAuthError(
        /api|entitle|permission|not authorized/i.test(res.errorText) ? 'no_api_access' : 'credentials',
        `Tradovate rejected the credentials: ${res.errorText}`
      ),
    };
  }

  return {
    ok: false,
    error: new TradovateAuthError(
      'malformed',
      `Tradovate returned a response with no token, no error and no penalty: ${JSON.stringify(res)}`
    ),
  };
}

export interface RequestTokenOptions {
  /** Give up rather than sleep longer than this in total. */
  maxWaitSeconds?: number;
  onPenalty?: (waitSeconds: number, attempt: number) => void;
  /** Injected so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Acquire an access token, absorbing time penalties.
 *
 * `post` is injected rather than imported so this works against the adapter's
 * HTTP helper in production and a fake in tests.
 */
export async function requestAccessToken(
  post: (path: string, body: unknown) => Promise<TradovateAuthResponse>,
  request: TradovateAuthRequest,
  options: RequestTokenOptions = {}
): Promise<TradovateToken> {
  const maxWaitSeconds = options.maxWaitSeconds ?? 90;
  const sleep = options.sleep ?? defaultSleep;

  let body: Record<string, unknown> = { ...request };
  let waited = 0;

  for (let attempt = 1; ; attempt++) {
    const res = await post('/auth/accesstokenrequest', body);
    const verdict = classifyAuthResponse(res);

    if ('ok' in verdict) {
      if (verdict.ok === true) return verdict.token;
      throw (verdict as { ok: false; error: TradovateAuthError }).error;
    }

    // Time penalty. Waiting past the budget is worse than failing loudly: a
    // signal that arrives during a session window is worthless by the time a
    // multi-minute penalty clears, and the GTD is 120 seconds.
    if (waited + verdict.penaltySeconds > maxWaitSeconds) {
      throw new TradovateAuthError(
        'penalty_timeout',
        `Tradovate time penalty of ${verdict.penaltySeconds}s would exceed the ` +
        `${maxWaitSeconds}s auth budget (already waited ${waited}s). This usually means ` +
        'too many authentications from one login — cache tokens and share them across ' +
        'accounts on the same login rather than authenticating per account.',
        verdict.penaltySeconds
      );
    }

    options.onPenalty?.(verdict.penaltySeconds, attempt);
    await sleep(verdict.penaltySeconds * 1000);
    waited += verdict.penaltySeconds;

    body = { ...request, 'p-ticket': verdict.ticket, 'p-time': verdict.penaltySeconds, 'p-captcha': false };
  }
}

/** Shape adapter credentials into the auth request body. */
export function credentialsToAuthRequest(creds: {
  username: string; password: string; appId: string;
  appVersion: string; cid: string | number; sec: string; deviceId: string;
}): TradovateAuthRequest {
  return {
    name: creds.username,
    password: creds.password,
    appId: creds.appId,
    appVersion: creds.appVersion,
    cid: Number(creds.cid),
    sec: creds.sec,
    deviceId: creds.deviceId,
  };
}
