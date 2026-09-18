/**
 * M22 — SIGN-UP (invite-gated account creation, the hosted shape).
 *
 * The problem this lane solves: `tools/user.mjs add` means the OPERATOR types
 * the passphrase, so every account on a hosted core has a credential someone
 * else has seen at least once. Sign-up lets the person choose their own, while
 * the decision "may this person have an account here?" stays the operator's —
 * the same split the product already makes for device enrollment (pairing).
 *
 * What this file pins, in the order the lane fails if any of it drifts:
 *
 *  - the MINT (`POST /v1/signup/code`) is loopback-only and refuses unless
 *    `SIGNUP_MODE=invite` + `AUTH_MODE=login`, so no internet caller can mint;
 *  - the REDEEM (`POST /v1/auth/signup`) needs a live single-use code, and the
 *    account it creates is exactly what the CLI creates: a users row whose id
 *    slugs from the name (`0` for the first account) plus a scrypt credential
 *    that `/v1/auth/session` then accepts;
 *  - an invite is SINGLE USE, expires, and locks after wrong guesses;
 *  - shape errors (short passphrase, empty name) are refused BEFORE the invite is
 *    spent — a typo must not burn a one-time code — and the same refusal
 *    sentences come from `@partner/shared/accounts`, which is what the browser
 *    shows;
 *  - a taken name is a 409, because sign-in matches the label case-insensitively
 *    against the first match and two accounts differing only in case would make
 *    one of them unreachable;
 *  - NO session is minted by sign-up (one authority path), and neither the
 *    username nor the passphrase reaches a response, an audit row, or a log —
 *    the audit row names the new ID and nothing else.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_HOST } from '../helpers.js';
import { loadConfig, createCore } from '../../src/index.js';
import type { CoreBundle, CoreConfig } from '../../src/index.js';
import { openDatabase } from '../../src/stores/db.js';
import { createSystemStores } from '../../src/users/store.js';
import { createUserManager } from '../../src/users/manager.js';
import { createCredentialManager } from '../../src/users/credentials.js';
import type { UserManager } from '../../src/users/manager.js';
import type { CredentialManager } from '../../src/users/credentials.js';
import { createInviteManager } from '../../src/users/invites.js';
import { MIN_PASSPHRASE_LENGTH } from '@partner/shared';

const PASSWORD = 'a long enough passphrase';
const LOOPBACK = '127.0.0.1';
const REMOTE = '198.51.100.7';

/** A login-mode core with the invite lane, plus its account managers. */
async function signupCore(
  options: {
    mode?: 'off' | 'invite';
    ttlMs?: number;
    now?: () => number;
    peer?: string;
    rateLimit?: { limit?: number; windowMs?: number };
    accounts?: Array<{ id: string; label: string }>;
  } = {},
): Promise<{
  bundle: CoreBundle;
  users: UserManager;
  credentials: CredentialManager;
  code: () => Promise<string>;
}> {
  const config: CoreConfig = {
    ...loadConfig({
      DEMO_MODE: '1',
      SCHEDULER_TICK_MS: '0',
      AUTH_MODE: 'login',
      ...(options.mode === 'off' ? {} : { SIGNUP_MODE: 'invite' }),
    }),
    ...(options.ttlMs === undefined ? {} : { signupTtlMs: options.ttlMs }),
  };
  const db = openDatabase(':memory:');
  const systemDb = openDatabase(':memory:');
  const stores = createSystemStores(systemDb);
  const users = createUserManager({ store: stores.users });
  const credentials = createCredentialManager(stores.credentials);

  for (const row of options.accounts ?? []) {
    users.create({ id: row.id, label: row.label });
    await credentials.create(row.id, PASSWORD);
  }

  // The manager is injected whenever a test needs its own clock; otherwise the
  // app builds its own over `config.signupTtlMs`.
  const invites =
    options.now === undefined && options.ttlMs === undefined
      ? undefined
      : createInviteManager({
          store: stores.invites,
          now: options.now ?? Date.now,
          ttlMs: options.ttlMs ?? 60_000,
        });

  const bundle = createCore(config, db, stores, {
    ...(invites === undefined ? {} : { invitesOverride: invites }),
    ...(options.peer === undefined ? {} : { peerAddress: () => options.peer }),
    ...(options.rateLimit === undefined ? {} : { signupRateLimit: options.rateLimit }),
  });

  const mint = async (): Promise<string> => {
    const res = await request(bundle.app)
      .post('/v1/signup/code')
      .set('Host', ALLOWED_HOST)
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return String(res.body.code);
  };

  return { bundle, users, credentials, code: mint };
}

function mintInvite(bundle: CoreBundle) {
  return request(bundle.app).post('/v1/signup/code').set('Host', ALLOWED_HOST).send({});
}

function signUp(bundle: CoreBundle, body: Record<string, unknown>) {
  return request(bundle.app).post('/v1/auth/signup').set('Host', ALLOWED_HOST).send(body);
}

function signIn(bundle: CoreBundle, body: Record<string, unknown>) {
  return request(bundle.app).post('/v1/auth/session').set('Host', ALLOWED_HOST).send(body);
}

describe('POST /v1/signup/code — the mint is an operator act', () => {
  it('is refused in pairing mode: there is no credential to create', async () => {
    const config = loadConfig({ DEMO_MODE: '1', SCHEDULER_TICK_MS: '0', AUTH_MODE: 'pairing' });
    const bundle = createCore(config, openDatabase(':memory:'));
    const res = await mintInvite(bundle);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('signup_disabled');
  });

  it('is refused when SIGNUP_MODE is off (the default)', async () => {
    const { bundle } = await signupCore({ mode: 'off' });
    const res = await mintInvite(bundle);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('signup_disabled');
  });

  it('is refused from a non-loopback peer, before anything is minted', async () => {
    // The load-bearing control: an invite is what lets an account be created, so
    // an internet caller must not be able to ask for one. Shell access to the
    // machine (`compose exec tools/signup-link.mjs`) is the proof.
    const { bundle } = await signupCore({ peer: REMOTE });
    const res = await mintInvite(bundle);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('loopback_required');

    // …and no code exists to redeem afterwards.
    const signed = await signUp(bundle, {
      code: 'x'.repeat(43),
      username: 'anyone',
      password: PASSWORD,
    });
    expect(signed.status).toBe(401);

    // The refusal is audited by NAME, with no code in the row.
    const rows = bundle.audit
      .query({ action: 'auth.signup_code', limit: 10 })
      .filter((row) => row.action === 'auth.signup_code');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain('loopback_required');
    expect(JSON.stringify(rows)).not.toContain('x'.repeat(43));
  });

  it('issues a canonical 256-bit code that cannot be guessed or replayed', async () => {
    const { bundle, code } = await signupCore();
    const issued = await code();
    // 32 random bytes, hex — 64 characters, and not predictable from a second
    // mint (M29 invitations are store-backed and may coexist).
    expect(issued).toMatch(/^[0-9a-f]{64}$/);
    const second = await code();
    expect(second).not.toBe(issued);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports the mode on /v1/health, and never the code', async () => {
    const { bundle, code } = await signupCore();
    const issued = await code();
    const res = await request(bundle.app).get('/v1/health').set('Host', ALLOWED_HOST);
    expect(res.status).toBe(200);
    expect(res.body.signupMode).toBe('invite');
    expect(JSON.stringify(res.body)).not.toContain(issued);
  });
});

describe('POST /v1/auth/signup — the account it creates', () => {
  it('creates a REAL account: the credential then signs in', async () => {
    // A core that already has an account: the new one slugs its own id (the
    // first-account/legacy-id rule has its own case below).
    const { bundle, users } = await signupCore({ accounts: [{ id: 'owner', label: 'Owner' }] });
    const code = await (async () => {
      const res = await mintInvite(bundle);
      return String(res.body.code);
    })();

    const res = await signUp(bundle, { code, username: 'Ama', password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ ok: true, id: 'ama', role: 'member' });

    // The row is what the CLI would have made: the name slugged into the id.
    expect(users.findById('ama')).toMatchObject({ label: 'Ama', disabledAt: null });

    // …and the passphrase the PERSON chose is the one that authenticates.
    const session = await signIn(bundle, { username: 'Ama', password: PASSWORD });
    expect(session.status).toBe(200);
    expect(session.body.userId).toBe('ama');
    // Case-insensitive sign-in works against the label, as for CLI accounts.
    const again = await signIn(bundle, { username: 'ama', password: PASSWORD });
    expect(again.status).toBe(200);
  });

  it('gives the FIRST account the legacy id, so a pre-partition database keeps its owner', async () => {
    const { bundle } = await signupCore();
    const minted = await mintInvite(bundle);
    const res = await signUp(bundle, {
      code: String(minted.body.code),
      username: 'Owner',
      password: PASSWORD,
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('0');
  });

  it('never mints a session — authority has exactly one path', async () => {
    const { bundle } = await signupCore();
    const minted = await mintInvite(bundle);
    const res = await signUp(bundle, {
      code: String(minted.body.code),
      username: 'Ama',
      password: PASSWORD,
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeUndefined();
    // No device is registered for the new user until they sign in.
    expect(await bundle.sessions.listDevices('ama')).toHaveLength(0);
  });

  it('refuses a taken name with 409, case-insensitively', async () => {
    const { bundle, users } = await signupCore({ accounts: [{ id: 'ama', label: 'Ama' }] });
    const minted = await mintInvite(bundle);
    const res = await signUp(bundle, {
      code: String(minted.body.code),
      username: 'AMA',
      password: PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('username_taken');
    expect(users.list()).toHaveLength(1);
  });

  it('refuses a disabled-then-recycled name rather than resurrecting it', async () => {
    const { bundle, users } = await signupCore({ accounts: [{ id: 'ama', label: 'Ama' }] });
    users.disable('ama');
    const minted = await mintInvite(bundle);
    const res = await signUp(bundle, {
      code: String(minted.body.code),
      username: 'ama',
      password: PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(users.findById('ama')?.disabledAt).not.toBeNull();
  });
});

describe('the invite is single use, expiring, and lockable', () => {
  it('consumes the code on success: a replay cannot create a second account', async () => {
    const { bundle, users } = await signupCore();
    const minted = await mintInvite(bundle);
    const code = String(minted.body.code);

    expect((await signUp(bundle, { code, username: 'Ama', password: PASSWORD })).status).toBe(201);
    const replay = await signUp(bundle, { code, username: 'Other', password: PASSWORD });
    expect(replay.status).toBe(401);
    expect(replay.body.reason).toBe('used');
    expect(replay.body.message).toMatch(/single use/i);
    expect(users.list()).toHaveLength(1);
  });

  it('expires', async () => {
    let now = 1_000_000;
    const { bundle } = await signupCore({ ttlMs: 60_000, now: () => now });
    const minted = await mintInvite(bundle);
    const code = String(minted.body.code);

    now += 60_001;
    const res = await signUp(bundle, { code, username: 'Ama', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe('expired');
  });

  it('refuses an unknown code without locking the live one', async () => {
    const { bundle } = await signupCore();
    const minted = await mintInvite(bundle);
    const good = String(minted.body.code);
    const wrong = `${'A'.repeat(63)}B`;

    // A wrong code is `unknown` — there is no guess bucket, because a 256-bit
    // code cannot be guessed and the per-peer budget (tested below) is what
    // bounds flooding. Crucially the LIVE invite is untouched.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await signUp(bundle, { code: wrong, username: 'Ama', password: PASSWORD });
      expect(res.status, `attempt ${attempt + 1}`).toBe(401);
      expect(res.body.reason, `attempt ${attempt + 1}`).toBe('unknown');
    }
    const withRealCode = await signUp(bundle, { code: good, username: 'Ama', password: PASSWORD });
    expect(withRealCode.status).toBe(201);
  });

  it('rate-limits per peer, separately from sign-in', async () => {
    const { bundle } = await signupCore({ rateLimit: { limit: 2, windowMs: 60_000 } });
    const wrong = 'A'.repeat(43);
    expect((await signUp(bundle, { code: wrong, username: 'Ama', password: PASSWORD })).status).toBe(401);
    expect((await signUp(bundle, { code: wrong, username: 'Ama', password: PASSWORD })).status).toBe(401);
    const third = await signUp(bundle, { code: wrong, username: 'Ama', password: PASSWORD });
    expect(third.status).toBe(429);
    expect(third.body.reason).toBe('rate_limited');
    expect(third.headers['retry-after']).toBeDefined();

    // The sign-in budget is a different bucket: it still answers 401/409, not 429.
    expect((await signIn(bundle, { username: 'Ama', password: PASSWORD })).status).toBe(409);
  });
});

describe('shape errors are refused before the invite is spent', () => {
  it('a short passphrase is refused with the SHARED sentence, and the code survives', async () => {
    const { bundle } = await signupCore();
    const minted = await mintInvite(bundle);
    const code = String(minted.body.code);

    const short = await signUp(bundle, { code, username: 'Ama', password: 'short' });
    expect(short.status).toBe(400);
    expect(short.body.reason).toBe('invalid_passphrase');
    expect(short.body.message).toContain(String(MIN_PASSPHRASE_LENGTH));

    // THE POINT: the typo did not burn the one-time code.
    const retry = await signUp(bundle, { code, username: 'Ama', password: PASSWORD });
    expect(retry.status).toBe(201);
  });

  it('an unusable name is refused the same way', async () => {
    const { bundle } = await signupCore();
    const minted = await mintInvite(bundle);
    const code = String(minted.body.code);

    for (const username of ['', ' ', 'a', '!!!', 'x'.repeat(41)]) {
      const res = await signUp(bundle, { code, username, password: PASSWORD });
      expect(res.status, username).toBe(400);
      expect(res.body.reason, username).toBe('invalid_username');
      expect(typeof res.body.message, username).toBe('string');
    }
    // Still usable afterwards.
    expect((await signUp(bundle, { code, username: 'Ama', password: PASSWORD })).status).toBe(201);
  });

  it('a missing invite is its own refusal, not a wrong password', async () => {
    const { bundle } = await signupCore();
    const res = await signUp(bundle, { username: 'Ama', password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('missing_invite');
  });

  it('an owner-minted invite still redeems while SIGNUP_MODE is off, but the operator mint is refused', async () => {
    // M29: SIGNUP_MODE governs only the LOOPBACK operator mint (the way to make
    // the FIRST account). Redeeming an owner's in-app invitation is an explicit
    // admission decision and needs no deployment switch.
    const { bundle, users } = await signupCore({
      mode: 'off',
      accounts: [{ id: 'owner', label: 'Owner' }],
    });
    expect((await mintInvite(bundle)).status).toBe(403);

    // The owner signs in and mints from the APP.
    const ownerSession = await signIn(bundle, { username: 'owner', password: PASSWORD });
    expect(ownerSession.status).toBe(200);
    const minted = await request(bundle.app)
      .post('/v1/invites')
      .set('Host', ALLOWED_HOST)
      .set('Authorization', `Bearer ${ownerSession.body.token}`)
      .send({ role: 'member', keyAccess: 'shared' });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    expect(minted.body.url).toContain('#signup=');

    const redeemed = await signUp(bundle, {
      code: String(minted.body.code),
      username: 'Ama',
      password: PASSWORD,
    });
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(201);
    expect(redeemed.body).toEqual({ ok: true, id: 'ama', role: 'member' });
    // The role and key access came from the INVITE ROW, not the request.
    expect(users.findById('ama')).toMatchObject({ role: 'member', keyAccess: 'shared' });
  });
});

describe('the audit trail carries ids, never credentials', () => {
  it('records the created id and nothing of what was typed', async () => {
    const { bundle } = await signupCore();
    const minted = await mintInvite(bundle);
    const code = String(minted.body.code);
    const res = await signUp(bundle, { code, username: 'Ama', password: PASSWORD });
    expect(res.status).toBe(201);

    // The store's `action` filter is a SUBSTRING match (the audit view relies on
    // that for two-word searches), so `auth.signup` also returns
    // `auth.signup_code` — narrow to the exact action here.
    const rows = bundle.audit
      .query({ action: 'auth.signup', limit: 10 })
      .filter((row) => row.action === 'auth.signup');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'auth', action: 'auth.signup', target: '0' });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('Ama');
    expect(text).not.toContain(code);
    // The mint row is counts-only too.
    const mintRows = bundle.audit
      .query({ action: 'auth.signup_code', limit: 10 })
      .filter((row) => row.action === 'auth.signup_code');
    expect(mintRows).toHaveLength(1);
    expect(JSON.stringify(mintRows)).not.toContain(code);
  });
});
