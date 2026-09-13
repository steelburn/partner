/**
 * M22 — the login lane on the CLIENT side.
 *
 * Two things a review can falsify here, both of which would break the hosted
 * shape silently: the sign-in request's shape/error mapping (a 409 "no account
 * yet" is NOT a wrong password), and the gate itself (a form with no password
 * field, or an enabled submit while a request is in flight). The second is
 * render-tested — SSR needs no DOM, the same way the M20.A grouped-answer cards
 * are covered.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import { ApiRequestError, fetchCoreHealth, signIn } from '../src/lib/api.js';
import { LoginGate } from '../src/LoginGate.js';

type Call = { input: string; init?: RequestInit };

function fetchReturning(status: number, body: unknown): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('signIn', () => {
  it('POSTs username + password and returns the session', async () => {
    const { fetchImpl, calls } = fetchReturning(200, {
      token: 'a'.repeat(64),
      kind: 'web',
      clientClass: 'desktop',
      userId: 'owner',
      expiresAt: 123,
    });
    const result = await signIn('owner', 'hunter2', { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/auth/session');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      username: 'owner',
      password: 'hunter2',
    });
    expect(result).toEqual({ token: 'a'.repeat(64), userId: 'owner', clientClass: 'desktop', expiresAt: 123 });
  });

  it('maps a wrong password to 401 and a locked/limited account to 429', async () => {
    await expect(
      signIn('owner', 'nope', { fetchImpl: fetchReturning(401, { error: 'invalid_credentials' }).fetchImpl }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      signIn('owner', 'nope', {
        fetchImpl: fetchReturning(429, { error: 'too_many_attempts', retryAfterMs: 1000 }).fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('keeps the server wording for "no account yet" (it is not a wrong password)', async () => {
    const { fetchImpl } = fetchReturning(409, {
      error: 'no_account',
      message: 'No account exists yet — create one on the machine running Partner (tools/user.mjs)',
    });
    await expect(signIn('owner', 'hunter2', { fetchImpl })).rejects.toSatisfy?.(
      (cause: unknown) => cause instanceof ApiRequestError && cause.status === 409,
    );
    const error = await signIn('owner', 'hunter2', { fetchImpl }).catch((cause) => cause);
    expect((error as Error).message).toContain('tools/user.mjs');
  });
});

describe('fetchCoreHealth reports the gate', () => {
  it('reads authMode + hasUsers (and defaults to pairing for an older core)', async () => {
    const login = await fetchCoreHealth({
      fetchImpl: fetchReturning(200, { demo: false, version: '0.1.7', schemaVersion: 18, authMode: 'login', hasUsers: false }).fetchImpl,
    });
    expect(login).toMatchObject({ authMode: 'login', hasUsers: false });

    const legacy = await fetchCoreHealth({
      fetchImpl: fetchReturning(200, { demo: true, version: '0.1.7', schemaVersion: 18 }).fetchImpl,
    });
    expect(legacy?.authMode).toBe('pairing');
    expect(legacy?.hasUsers).toBeUndefined();
  });
});

function loginGate(overrides: Partial<Parameters<typeof LoginGate>[0]> = {}): string {
  return renderToStaticMarkup(
    h(LoginGate, {
      username: 'owner',
      password: 'hunter2',
      busy: false,
      error: null,
      noAccountYet: false,
      host: 'partner.teliti.app',
      onUsername: () => {},
      onPassword: () => {},
      onSubmit: () => {},
      onSessionOnly: () => {},
      ...overrides,
    }),
  );
}

describe('LoginGate', () => {
  it('renders a username field, a PASSWORD field and one submit', () => {
    const html = loginGate();
    expect(html).toContain('id="login-username"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="current-password"'.replace('autocomplete', 'autoComplete'));
    expect(html).toContain('Sign in');
    expect(html).toContain('partner.teliti.app');
  });

  it('blocks submission while a request is in flight, or with an empty field', () => {
    expect(loginGate({ busy: true })).toMatch(/Signing in…[\s\S]*?disabled/);
    expect(loginGate({ password: '' })).toMatch(/disabled/);
    expect(loginGate({ username: '   ' })).toMatch(/disabled/);
    // Ready state: NOT disabled.
    expect(loginGate()).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it('turns "no account yet" into the operator command, with no form to fail', () => {
    const html = loginGate({ noAccountYet: true, username: '', password: '' });
    expect(html).toContain('no account yet');
    expect(html).toContain('tools/user.mjs add');
    expect(html).not.toContain('id="login-password"');
  });

  it('shows the refusal text it is given, as an alert', () => {
    const html = loginGate({ error: 'That username and password do not match an account on this Partner.' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('do not match an account');
  });
});
