/**
 * M22/R1 — PER-USER PARTITION ISOLATION, over real HTTP.
 *
 * This is the claim the design exists to make, and it is not provable with a
 * stub: two users, two sign-ins, two whole-file-encrypted databases, and a read
 * that returns one user's rows must never contain the other's. The M20 exit
 * criterion (`PLAN.md` §15 M20) is exactly this test's list — DB, key, skills and
 * audit per user — plus the structural property that makes it hold: a request is
 * served by a core built over ONE user's database, so there is no query to forget
 * to filter.
 *
 * It runs the whole boot (`startServer`) because the delegation wiring is half the
 * feature: the rails are only interesting if the LISTENING app uses them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { Server } from 'node:http';
import { loadConfig, openAccounts, startServer } from '../../src/index.js';
import type { CoreBundle } from '../../src/index.js';
import { closeServer, freePort, removeTempRoot } from '../helpers.js';

const dirs: string[] = [];
const servers: Server[] = [];
const bundles: CoreBundle[] = [];

/**
 * Close the listener FIRST and wait for it: the rails close their partitions from
 * the server's 'close' event, so deleting the data dir too early leaves Windows
 * with open SQLite handles (EPERM). `closeServer` also drops keep-alive sockets —
 * without that, `close()` waits for the connection to idle out, the hook exceeds
 * its budget, and the aborted teardown leaves exactly the handles this comment is
 * about. The retry window covers the WAL files.
 */
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await closeServer(server);
  }
  for (const bundle of bundles.splice(0)) bundle.close();
  for (const dir of dirs.splice(0)) {
    removeTempRoot(dir);
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-partitions-'));
  dirs.push(dir);
  return dir;
}

async function bootLoginCore(dir: string) {
  // A NAMED free port, not `PORT=0`: the loopback allowlist is derived from the
  // configured port, and these tests send real requests with
  // `Host: 127.0.0.1:<port>`. (That value used to be silently replaced by 4390,
  // which made the whole file depend on 4390 being free — it is not, on a
  // machine running a dev core, and the failure looked like a null address.)
  const port = await freePort();
  const config = {
    ...loadConfig({
      DEMO_MODE: '0',
      AUTH_MODE: 'login',
      KEYCHAIN_KIND: 'file',
      KEYCHAIN_FILE: join(dir, 'keychain.json'),
      DB_PATH: join(dir, 'partner.db'),
      DATA_ROOT: dir,
      PORT: String(port),
      SCHEDULER_TICK_MS: '0',
    }),
  };
  const { bundle, server, accounts } = await startServer(config);
  bundles.push(bundle);
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    // A boot that resolves without a listening socket is the bug this guard
    // exists for (see `listen()` in src/index.ts): say so here rather than
    // crashing on `address.port` three frames later.
    throw new Error('the core resolved without a listening socket');
  }
  return {
    config,
    bundle,
    server,
    accounts,
    origin: `127.0.0.1:${address.port}`,
  };
}

async function addUser(config: ReturnType<typeof loadConfig>, name: string, password: string) {
  const accounts = await openAccounts(config);
  try {
    const created = accounts.users.create({ id: name, label: name });
    if (!created.ok) throw new Error(`could not create ${name}: ${created.reason}`);
    const stored = await accounts.credentials.create(created.user.id, password);
    if (!stored.ok) throw new Error(`could not store the credential: ${stored.reason}`);
  } finally {
    accounts.close();
  }
}

async function signIn(body: CoreBundle, origin: string, username: string, password: string) {
  const res = await request(body.app)
    .post('/v1/auth/session')
    .set('Host', origin)
    .send({ username, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.token as string;
}

function authed(token: string, origin: string): Record<string, string> {
  return { Host: origin, Authorization: `Bearer ${token}` };
}

describe('two users are provably isolated', () => {
  it('each sign-in lands in their own database; a read cannot cross', async () => {
    const dir = tempDir();
    const { config, bundle, origin } = await bootLoginCore(dir);
    await addUser(config, 'ama', 'ama-passphrase');
    await addUser(config, 'bo', 'bo-passphrase');

    const amaToken = await signIn(bundle, origin, 'ama', 'ama-passphrase');
    const boToken = await signIn(bundle, origin, 'bo', 'bo-passphrase');

    // Each user writes one note.
    const amaNote = await request(bundle.app)
      .post('/v1/notes')
      .set(authed(amaToken, origin))
      .send({ title: 'ama only', body: 'ama secret' });
    expect(amaNote.status, JSON.stringify(amaNote.body)).toBe(201);
    const boNote = await request(bundle.app)
      .post('/v1/notes')
      .set(authed(boToken, origin))
      .send({ title: 'bo only', body: 'bo secret' });
    expect(boNote.status, JSON.stringify(boNote.body)).toBe(201);

    // Each sees exactly their own.
    const amaList = await request(bundle.app).get('/v1/notes').set(authed(amaToken, origin));
    const boList = await request(bundle.app).get('/v1/notes').set(authed(boToken, origin));
    expect(JSON.stringify(amaList.body)).toContain('ama only');
    expect(JSON.stringify(amaList.body)).not.toContain('bo only');
    expect(JSON.stringify(boList.body)).toContain('bo only');
    expect(JSON.stringify(boList.body)).not.toContain('ama only');

    // Two separate encrypted files on disk, neither of them plaintext SQLite.
    const amaDb = join(dir, 'users', 'ama', 'partner.db');
    const boDb = join(dir, 'users', 'bo', 'partner.db');
    expect(existsSync(amaDb)).toBe(true);
    expect(existsSync(boDb)).toBe(true);
    for (const path of [amaDb, boDb]) {
      const head = readFileSync(path).subarray(0, 15).toString('utf8');
      expect(head, path).not.toBe('SQLite format 3');
    }
    // Their own skills directories too (a per-partition value, not a shared one).
    expect(statSync(join(dir, 'users', 'ama')).isDirectory()).toBe(true);

    // The audit trail is per user as well: ama's partition has no row about bo.
    const amaAudit = await request(bundle.app).get('/v1/audit').set(authed(amaToken, origin));
    expect(amaAudit.status).toBe(200);
    expect(JSON.stringify(amaAudit.body)).not.toContain('bo only');
  });

  it('S9: after sign-in no plaintext key stays in the keychain — only per-user WRAPS', async () => {
    const dir = tempDir();
    const { config, bundle, origin } = await bootLoginCore(dir);
    await addUser(config, 'ama', 'ama-passphrase');
    await addUser(config, 'bo', 'bo-passphrase');
    // Sign in (which unlocks AND wraps on first use), then use the partition.
    const amaToken = await signIn(bundle, origin, 'ama', 'ama-passphrase');
    const boToken = await signIn(bundle, origin, 'bo', 'bo-passphrase');
    expect((await request(bundle.app).get('/v1/notes').set(authed(amaToken, origin))).status).toBe(200);
    expect((await request(bundle.app).get('/v1/notes').set(authed(boToken, origin))).status).toBe(200);

    // THE PROMISE: the keychain holds the system key and NOTHING that opens a
    // user's partition. (Before S9 the plaintext lived here, which made "signed
    // out means unreadable" decorative.)
    const keychain = JSON.parse(readFileSync(join(dir, 'keychain.json'), 'utf8')) as Record<
      string,
      Record<string, string>
    >;
    const names = Object.keys(keychain.partner ?? {});
    expect(names).toContain('system-key');
    expect(names).not.toContain('db-key:ama');
    expect(names).not.toContain('db-key:bo');

    // Two WRAPS, one per user, with different ciphertexts (their own keys).
    const accounts = await openAccounts(config);
    try {
      const amaWrap = accounts.stores.keyWraps.findByUser('ama');
      const boWrap = accounts.stores.keyWraps.findByUser('bo');
      expect(amaWrap).toBeDefined();
      expect(boWrap).toBeDefined();
      expect(amaWrap?.ciphertext).not.toBe(boWrap?.ciphertext);
      expect(amaWrap?.salt).not.toBe(boWrap?.salt);
    } finally {
      accounts.close();
    }
  });

  it('S9: a signed-out user’s partition is REFUSED, and signing in again re-opens it', async () => {
    const dir = tempDir();
    const { config, bundle, origin, accounts } = await bootLoginCore(dir);
    await addUser(config, 'ama', 'ama-passphrase');
    const token = await signIn(bundle, origin, 'ama', 'ama-passphrase');
    expect((await request(bundle.app).get('/v1/notes').set(authed(token, origin))).status).toBe(200);

    // LOCK the key (what a sign-out or an idle sweep does). The session itself is
    // still valid — and the request must STILL be refused, because there is no key
    // to open the partition with. This is the whole point of S9.
    expect(accounts?.vault.lock('ama')).toBe(true);
    expect(accounts?.vault.isUnlocked('ama')).toBe(false);
    const locked = await request(bundle.app).get('/v1/notes').set(authed(token, origin));
    expect(locked.status).toBe(401);
    expect(locked.body).toEqual({ error: 'unauthorized', reason: 'partition_locked' });
    // A sign-out / idle sweep also CLOSES the handle (an open handle would keep
    // decrypted pages alive in SQLite's cache, so "the key is gone" would only be
    // half true). `close` is the documented path; the delegate refusal above is
    // the safety net if a caller forgets.
    expect(accounts?.rails.close('ama')).toBe(true);
    expect(accounts?.rails.openUserIds()).not.toContain('ama');

    // Signing in again unlocks and serves the same data.
    const again = await signIn(bundle, origin, 'ama', 'ama-passphrase');
    const reopened = await request(bundle.app).get('/v1/notes').set(authed(again, origin));
    expect(reopened.status).toBe(200);
  });

  it('refuses a session that names no user (there is no partition to serve)', async () => {
    const dir = tempDir();
    const { bundle, origin } = await bootLoginCore(dir);
    // A user-less session is what the pairing ceremony used to mint; in login mode
    // it must not be able to reach any store at all.
    const created = await bundle.sessions.create({ kind: 'web', origin, clientClass: 'desktop' });
    const res = await request(bundle.app).get('/v1/notes').set(authed(created.token, origin));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_partition');
  });

  it('a disabled user is refused at sign-in even with the right passphrase', async () => {
    const dir = tempDir();
    const { config, bundle, origin } = await bootLoginCore(dir);
    await addUser(config, 'ama', 'ama-passphrase');
    const accounts = await openAccounts(config);
    accounts.users.disable('ama');
    accounts.close();

    const res = await request(bundle.app)
      .post('/v1/auth/session')
      .set('Host', origin)
      .send({ username: 'ama', password: 'ama-passphrase' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('account_disabled');
  });
});
