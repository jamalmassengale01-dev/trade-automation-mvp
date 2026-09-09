import { describe, it, expect, vi } from 'vitest';
import {
  classifyAuthResponse,
  requestAccessToken,
  credentialsToAuthRequest,
  TradovateAuthError,
} from './auth';

const CREDS = {
  username: 'trader', password: 'api-pass', appId: 'EdgePilot',
  appVersion: '1.0', cid: '9999', sec: 'secret', deviceId: 'device-uuid',
};

const TOKEN_RES = {
  accessToken: 'tok', expirationTime: '2026-09-10T00:00:00Z', userId: 42,
};

describe('classifyAuthResponse', () => {
  it('accepts a complete token response', () => {
    const v = classifyAuthResponse(TOKEN_RES);
    expect(v).toEqual({ ok: true, token: TOKEN_RES });
  });

  it('treats a token response missing userId as malformed, not success', () => {
    // Bearer-with-no-user would authenticate and then fail on every /account call.
    const v = classifyAuthResponse({ accessToken: 'tok', expirationTime: 'x' });
    expect(v).toMatchObject({ ok: false });
    expect((v as { error: TradovateAuthError }).error.kind).toBe('malformed');
  });

  it('recognises a time penalty as a retry, not a failure', () => {
    const v = classifyAuthResponse({ 'p-ticket': 'tick', 'p-time': 30, 'p-captcha': false });
    expect(v).toEqual({ penaltySeconds: 30, ticket: 'tick' });
  });

  it('treats a captcha as terminal even when a ticket is present', () => {
    // A ticket alongside p-captcha must NOT be retried — retrying deepens the penalty.
    const v = classifyAuthResponse({ 'p-ticket': 'tick', 'p-time': 30, 'p-captcha': true });
    expect((v as { error: TradovateAuthError }).error.kind).toBe('captcha');
  });

  it('separates an entitlement rejection from a bad password', () => {
    expect(
      (classifyAuthResponse({ errorText: 'Not authorized for API access' }) as { error: TradovateAuthError }).error.kind
    ).toBe('no_api_access');
    expect(
      (classifyAuthResponse({ errorText: 'Invalid username or password' }) as { error: TradovateAuthError }).error.kind
    ).toBe('credentials');
  });

  it('does not silently succeed on an empty 200', () => {
    const v = classifyAuthResponse({});
    expect((v as { error: TradovateAuthError }).error.kind).toBe('malformed');
  });
});

describe('requestAccessToken', () => {
  const sleep = vi.fn(async () => undefined);

  it('returns the token on the happy path without sleeping', async () => {
    const post = vi.fn().mockResolvedValue(TOKEN_RES);
    const token = await requestAccessToken(post, credentialsToAuthRequest(CREDS), { sleep });
    expect(token.accessToken).toBe('tok');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('waits out a penalty and retries with the ticket attached', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ 'p-ticket': 'tick', 'p-time': 10, 'p-captcha': false })
      .mockResolvedValueOnce(TOKEN_RES);
    const onPenalty = vi.fn();

    const token = await requestAccessToken(post, credentialsToAuthRequest(CREDS), { sleep, onPenalty });

    expect(token.accessToken).toBe('tok');
    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(onPenalty).toHaveBeenCalledWith(10, 1);
    // The retry must carry the ticket, otherwise Tradovate issues a fresh penalty.
    expect(post.mock.calls[1][1]).toMatchObject({ 'p-ticket': 'tick', 'p-time': 10, 'p-captcha': false });
    // ...and must still carry the original credentials.
    expect(post.mock.calls[1][1]).toMatchObject({ name: 'trader', cid: 9999 });
  });

  it('refuses a penalty longer than the auth budget rather than blocking a session window', async () => {
    const post = vi.fn().mockResolvedValue({ 'p-ticket': 'tick', 'p-time': 600, 'p-captcha': false });
    await expect(
      requestAccessToken(post, credentialsToAuthRequest(CREDS), { sleep, maxWaitSeconds: 90 })
    ).rejects.toMatchObject({ kind: 'penalty_timeout', retryAfterSeconds: 600 });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('stops once cumulative waiting would exceed the budget', async () => {
    // 50 + 50 > 90: the second penalty must be refused, not slept through.
    const post = vi.fn().mockResolvedValue({ 'p-ticket': 'tick', 'p-time': 50, 'p-captcha': false });
    await expect(
      requestAccessToken(post, credentialsToAuthRequest(CREDS), { sleep, maxWaitSeconds: 90 })
    ).rejects.toMatchObject({ kind: 'penalty_timeout' });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('surfaces a captcha immediately without retrying', async () => {
    const post = vi.fn().mockResolvedValue({ 'p-captcha': true });
    await expect(
      requestAccessToken(post, credentialsToAuthRequest(CREDS), { sleep })
    ).rejects.toMatchObject({ kind: 'captcha' });
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('credentialsToAuthRequest', () => {
  it('sends cid as a number — Tradovate rejects the string form', () => {
    expect(credentialsToAuthRequest(CREDS).cid).toBe(9999);
  });
});
