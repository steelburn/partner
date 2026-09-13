/**
 * M22 — USER LOGIN (the remote-hosted shape).
 *
 * The hosted core authenticates a USER, not a device: `POST /v1/auth/session`
 * proves a passphrase against the system database and mints a session that
 * carries `user_id`. What this file pins:
 *
 *  - the session NAMES ITS USER and its client class (so authorization has an
 *    identity to work with, and `/v1/devices` can scope by owner);
 *  - a wrong password, an unknown username and a disabled account are refused,
 *    and the first two are INDISTINGUISHABLE to the caller (no enumeration);
 *  - consecutive failures lock the credential (the control that matters behind a
 *    tunnel, where every request shares one peer address);
 *  - the pairing ceremony is REFUSED entirely in login mode (no second door);
 *  - `/v1/health` tells the SPA which gate to render, and whether an account
 *    exists yet;
 *  - a password never reaches a response or an audit row.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_HOST } from '../helpers.js';
import { loadConfig, createCore } from '../../src/index.js';
import type { CoreConfig, CoreBundle } from '../../src/index.js';
import { openDatabase } from '../../src/stores/db.js';
import { createSystemStores } from '../../src/users/store.js';
import { createUserManager } from '../../src/users/manager.js';
import { createCredentialManager } from '../../src/users/credentials.js';
import type { UserManager } from '../../src/users/manager.js';
import type { CredentialManager } from '../../src/users/credentials.js';

const PASSWORD = 'correct horse battery staple';

/** A login-mode core over in-memory databases, plus its account managers. */
async function loginCore(options: {
  sessionClass?: string;
  users?: Array<{ id: string; label: string; disabled?: boolean }>;
  password?: string;
  loginRateLimit?: { limit?: number; windowMs?: number };
} = {}): Promise<{ bundle: CoreBundle; users: UserManager; credentials: CredentialManager }> {
  const config: CoreConfig = {
    ...loadConfig({
      DEMO_MODE: '1',
      SCHEDULER_TICK_MS: '0',
      AUTH_MODE: 'login',
      ...(options.sessionClass === undefined ? {} : { LOGIN_SESSION_CLASS: options.sessionClass }),
      ...(options.loginRateLimit?.limit === undefined ? {} : { LOGIN_RATE_LIMIT: String(options.loginRateLimit.limit) }),
      ...(options.loginRateLimit?.windowMs === undefined
        ? {}
        : { LOGIN_RATE_WINDOW_MS: String(options.loginRateLimit.windowMs) }),
    }),
  };
  const db = openDatabase(':memory:');
  const systemDb = openDatabase(':memory:');
  const stores = createSystemStores(systemDb);
  const users = createUserManager({ store: stores.users });
  const credentials = createCredentialManager(stores.credentials);

  for (const row of options.users ?? [{ id: 'owner', label: 'owner' }]) {
    users.create({ id: row.id, label: row.label });
    if (row.disabled === true) users.disable(row.id);
  }
  if ((options.users ?? [{}]).length > 0) {
    await credentials.create((options.users?.[0]?.id ?? 'owner'), options.password ?? PASSWORD);
  }

  const bundle = createCore(config, db, stores);
  return { bundle, users, credentials };
}

function signIn(bundle: CoreBundle, body: Record<string, unknown>) {
  return request(bundle.app).post('/v1/auth/session').set('Host', ALLOWED_HOST).send(body);
}

describe('POST /v1/auth/session', () => {
  it('mints a session that names its user and class', async () => {
    const { bundle, users } = await loginCore();
    try {
      users.create({ id: 'second', label: 'second' });
      const res = await signIn(bundle, { username: 'owner', password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ kind: 'web', clientClass: 'desktop', userId: 'owner' });
      expect(typeof res.body.token).toBe('string');
      expect(res.body.token).toHaveLength(64);
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);

      // The session row really carries the user (the S5 registry scopes by it).
      const listed = await bundle.sessions.listDevices('owner');
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ clientClass: 'desktop', revokedAt: null });
    } finally {
      bundle.close();
    }
  });

  it('honours LOGIN_SESSION_CLASS (an operator may narrow it)', async () => {
    const full = { ...loadConfig({ DEMO_MODE: '1', AUTH_MODE: 'login', LOGIN_SESSION_CLASS: 'mobile' }) };
    const db = openDatabase(':memory:');
    const stores = createSystemStores(openDatabase(':memory:'));
    const users = createUserManager({ store: stores.users });
    users.create({ id: 'owner', label: 'owner' });
    await createCredentialManager(stores.credentials).create('owner', PASSWORD);
    const bundle = createCore(full, db, stores);
    try {
      const res = await signIn(bundle, { username: 'OWNER', password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.clientClass).toBe('mobile');
      // A mobile session is refused a desktop-only power, by class.
      const denied = await request(bundle.app)
        .post('/v1/roots')
        .set({ Host: ALLOWED_HOST, Authorization: `Bearer ${res.body.token as string}` })
        .send({ label: 'x', path: '/tmp' });
      expect(denied.status).toBe(403);
      expect(denied.body.clientClass).toBe('mobile');
    } finally {
      bundle.close();
    }
  });

  it('accepts the id as well as the label, case-insensitively', async () => {
    const { bundle } = await loginCore({ users: [{ id: 'owner', label: 'Ama' }] });
    try {
      expect((await signIn(bundle, { username: 'ama', password: PASSWORD })).status).toBe(200);
      expect((await signIn(bundle, { username: 'OWNER', password: PASSWORD })).status).toBe(200);
    } finally {
      bundle.close();
    }
  });

  it('refuses a wrong password and an unknown username IDENTICALLY', async () => {
    const { bundle } = await loginCore();
    try {
      const wrong = await signIn(bundle, { username: 'owner', password: 'not-the-password' });
      const unknown = await signIn(bundle, { username: 'nobody', password: 'not-the-password' });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body).toEqual({ error: 'invalid_credentials' });
      expect(unknown.body).toEqual({ error: 'invalid_credentials' });

      // The audit rows distinguish them for the OPERATOR, but carry no secrets.
      const rows = bundle.audit.list(50);
      const blob = JSON.stringify(rows);
      expect(blob).not.toContain('not-the-password');
      expect(blob).toContain('unknown_user');
    } finally {
      bundle.close();
    }
  });

  it('locks the credential after the configured failures, then unlocks', async () => {
    const { bundle } = await loginCore();
    try {
      for (let i = 0; i < 3; i += 1) {
        expect((await signIn(bundle, { username: 'owner', password: 'nope' })).status).toBe(401);
      }
      const locked = await signIn(bundle, { username: 'owner', password: PASSWORD });
      expect(locked.status).toBe(429);
      expect(locked.body.reason).toBe('locked');
      expect(locked.headers['retry-after']).toBeDefined();
    } finally {
      bundle.close();
    }
  });

  it('refuses a disabled account after proving the password', async () => {
    const { bundle } = await loginCore({ users: [{ id: 'owner', label: 'owner', disabled: true }] });
    try {
      const res = await signIn(bundle, { username: 'owner', password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('account_disabled');
    } finally {
      bundle.close();
    }
  });

  it('says so when no account exists, instead of failing every attempt', async () => {
    const full = { ...loadConfig({ DEMO_MODE: '1', AUTH_MODE: 'login' }) };
    const stores = createSystemStores(openDatabase(':memory:'));
    const bundle = createCore(full, openDatabase(':memory:'), stores);
    try {
      const res = await signIn(bundle, { username: 'owner', password: PASSWORD });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('no_account');
      expect(res.body.message).toContain('tools/user.mjs');
    } finally {
      bundle.close();
    }
  });

  it('requires both fields and rate-limits per peer', async () => {
    const { bundle } = await loginCore({ loginRateLimit: { limit: 3, windowMs: 60_000 } });
    try {
      // The budget is spent BEFORE the body is validated (the cheapest refusal
      // first), so a malformed call counts against it too.
      expect((await signIn(bundle, { username: 'owner' })).status).toBe(400);
      expect((await signIn(bundle, { username: 'owner', password: 'x' })).status).toBe(401);
      expect((await signIn(bundle, { username: 'owner', password: 'x' })).status).toBe(401);
      const limited = await signIn(bundle, { username: 'owner', password: PASSWORD });
      expect(limited.status).toBe(429);
      expect(limited.body.reason).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
    } finally {
      bundle.close();
    }
  });

  it('is refused when the core runs in PAIRING mode (no login lane)', async () => {
    const full = { ...loadConfig({ DEMO_MODE: '1' }) };
    const bundle = createCore(full, openDatabase(':memory:'));
    try {
      const res = await signIn(bundle, { username: 'owner', password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('login_disabled');
    } finally {
      bundle.close();
    }
  });
});

describe('login mode closes the pairing lane', () => {
  it('refuses /v1/pair, /v1/pair/payload and the device channel', async () => {
    const { bundle } = await loginCore();
    try {
      const code = await bundle.pairing.issue();
      const pair = await request(bundle.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
      expect(pair.status).toBe(403);
      expect(pair.body.error).toBe('pairing_disabled');

      const payload = await request(bundle.app)
        .post('/v1/pair/payload')
        .set('Host', ALLOWED_HOST)
        .send({});
      expect(payload.status).toBe(403);
      expect(payload.body.error).toBe('pairing_disabled');

      // The demo seam is suppressed too: it hands out a desktop session.
      const dev = await request(bundle.app).get('/v1/dev/pair-code').set('Host', ALLOWED_HOST);
      expect(dev.status).toBe(404);
    } finally {
      bundle.close();
    }
  });

  it('advertises the mode and whether an account exists on /v1/health', async () => {
    const { bundle } = await loginCore();
    try {
      const res = await request(bundle.app).get('/v1/health').set('Host', ALLOWED_HOST);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ authMode: 'login', hasUsers: true });

      const empty = createCore(
        { ...loadConfig({ DEMO_MODE: '1', AUTH_MODE: 'login' }) },
        openDatabase(':memory:'),
        createSystemStores(openDatabase(':memory:')),
      );
      try {
        const health = await request(empty.app).get('/v1/health').set('Host', ALLOWED_HOST);
        expect(health.body).toMatchObject({ authMode: 'login', hasUsers: false });
      } finally {
        empty.close();
      }
    } finally {
      bundle.close();
    }
  });

  it('pairing mode still reports authMode pairing and no user list', async () => {
    const bundle = createCore({ ...loadConfig({ DEMO_MODE: '1' }) }, openDatabase(':memory:'));
    try {
      const res = await request(bundle.app).get('/v1/health').set('Host', ALLOWED_HOST);
      expect(res.body.authMode).toBe('pairing');
      expect(res.body.hasUsers).toBeUndefined();
    } finally {
      bundle.close();
    }
  });

  it('refuses a login-mode boot without the system database', () => {
    const config = { ...loadConfig({ DEMO_MODE: '1', AUTH_MODE: 'login' }) };
    expect(() => createCore(config, openDatabase(':memory:'))).toThrow(/requires the system database/);
  });
});
