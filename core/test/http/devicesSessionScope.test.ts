/**
 * M20-B S3 (first half) — per-user session scoping and the v18 migration.
 *
 * One row per DEVICE, now carrying which user it acts as, which client class
 * it is and which platform it runs on. Two rules this suite pins:
 *
 *  - a per-user read or revoke is scoped BY USER: an id belonging to someone
 *    else matches nothing and is refused, so the S5 route can answer 404 and
 *    a session id can never be used to enumerate other users' devices (403
 *    would confirm the id exists);
 *  - a session that predates the authentication lane has user_id NULL, which
 *    means "no user", never "any user" — it appears in nobody's device list.
 *
 * The route surface itself is S5; these are the store/manager semantics it
 * will be built on, plus the migration an existing file DB goes through.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '@partner/shared';
import { createSessionManager, tokenHash } from '../../src/http/session.js';
import { applySchema, createSessionStore, openDatabase } from '../../src/stores/db.js';

const ORIGIN = '127.0.0.1:4390';

function makeFixture(): {
  db: Database.Database;
  store: ReturnType<typeof createSessionStore>;
  manager: ReturnType<typeof createSessionManager>;
} {
  const db = openDatabase(':memory:');
  const store = createSessionStore(db);
  const manager = createSessionManager(store, { ttlMs: 60_000, now: () => 1_000_000 });
  return { db, store, manager };
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

const WIDENED_COLUMNS = ['user_id', 'client_class', 'device_label', 'platform', 'rotated_at'];

describe('session identity round-trip', () => {
  it('carries class, label, platform and user from create to validate', async () => {
    const { db, store, manager } = makeFixture();
    try {
      const created = await manager.create({
        kind: 'web',
        origin: ORIGIN,
        clientClass: 'mobile',
        deviceLabel: "Sam's phone",
        platform: 'ios',
        userId: 'alice',
      });

      const result = await manager.validate(created.token, ORIGIN);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.session.userId).toBe('alice');
        expect(result.session.clientClass).toBe('mobile');
        expect(result.session.deviceLabel).toBe("Sam's phone");
        expect(result.session.platform).toBe('ios');
        expect(result.session.kind).toBe('web');
        expect(result.session.origin).toBe(ORIGIN);
      }

      // The row carries the same identity the validated session reports.
      const row = store.findByTokenHash(tokenHash(created.token));
      expect(row).toMatchObject({
        userId: 'alice',
        clientClass: 'mobile',
        deviceLabel: "Sam's phone",
        platform: 'ios',
        rotatedAt: null,
      });
    } finally {
      db.close();
    }
  });

  it('keeps the class and label when the session is revoked', async () => {
    const { db, store, manager } = makeFixture();
    try {
      const created = await manager.create({
        kind: 'web',
        origin: ORIGIN,
        clientClass: 'extension',
        deviceLabel: 'side panel',
        userId: 'alice',
      });
      expect(await manager.revoke(created.token)).toBe(true);
      expect(await manager.validate(created.token, ORIGIN)).toEqual({
        ok: false,
        reason: 'revoked',
      });
      // The device record survives a sign-out with its identity intact.
      expect(store.listByUser('alice')).toMatchObject([
        { clientClass: 'extension', deviceLabel: 'side panel', revokedAt: 1_000_000 },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('per-user session scope', () => {
  it("listByUser returns only that user's sessions, never the pre-auth ones", async () => {
    const { db, store, manager } = makeFixture();
    try {
      const alice1 = await manager.create({ kind: 'web', origin: ORIGIN, userId: 'alice' });
      const alice2 = await manager.create({
        kind: 'web',
        origin: ORIGIN,
        clientClass: 'mobile',
        userId: 'alice',
      });
      const bob = await manager.create({ kind: 'web', origin: ORIGIN, userId: 'bob' });
      // A session that predates the auth lane: no user at all.
      const preAuth = await manager.create({ kind: 'web', origin: ORIGIN });

      const aliceRows = store.listByUser('alice');
      expect(aliceRows.map((row) => row.tokenHash)).toEqual([
        tokenHash(alice1.token),
        tokenHash(alice2.token), // oldest first
      ]);
      expect(aliceRows.every((row) => row.userId === 'alice')).toBe(true);
      expect(store.listByUser('bob').map((row) => row.tokenHash)).toEqual([tokenHash(bob.token)]);
      expect(store.listByUser('carol')).toEqual([]);
      expect(store.listByUser('')).toEqual([]);
      // The NULL-user session belongs to nobody's device list.
      const listed = [...aliceRows, ...store.listByUser('bob')].map((row) => row.tokenHash);
      expect(listed).not.toContain(tokenHash(preAuth.token));
    } finally {
      db.close();
    }
  });

  it("refuses revokeById on another user's session: not-found, never forbidden", async () => {
    const { db, store, manager } = makeFixture();
    try {
      const alice = await manager.create({ kind: 'web', origin: ORIGIN, userId: 'alice' });
      const bob = await manager.create({ kind: 'web', origin: ORIGIN, userId: 'bob' });
      const bobRow = store.findByTokenHash(tokenHash(bob.token));
      const aliceRow = store.findByTokenHash(tokenHash(alice.token));
      expect(bobRow).toBeDefined();
      expect(aliceRow).toBeDefined();

      const bobId = (bobRow as NonNullable<typeof bobRow>).id;
      const aliceId = (aliceRow as NonNullable<typeof aliceRow>).id;

      // Alice naming Bob's device id gets nothing — no 403, no enumeration.
      expect(store.revokeById(bobId, 'alice', 9_000)).toBe(false);
      expect(store.findByTokenHash(tokenHash(bob.token))).toMatchObject({ revokedAt: null });
      expect(await manager.validate(bob.token, ORIGIN)).toMatchObject({ ok: true });

      // An unknown id in her own scope is the same answer.
      expect(store.revokeById(999_999, 'alice', 9_000)).toBe(false);

      // Her own device revokes, and a double revoke is idempotent.
      expect(store.revokeById(aliceId, 'alice', 9_000)).toBe(true);
      expect(await manager.validate(alice.token, ORIGIN)).toEqual({ ok: false, reason: 'revoked' });
      expect(store.revokeById(aliceId, 'alice', 9_100)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('revokeAllForUser kills every session of one user and none of another', async () => {
    const { db, store, manager } = makeFixture();
    try {
      const alice1 = await manager.create({ kind: 'web', origin: ORIGIN, userId: 'alice' });
      const alice2 = await manager.create({ kind: 'web', origin: ORIGIN, userId: 'alice' });
      const bob = await manager.create({ kind: 'web', origin: ORIGIN, userId: 'bob' });

      expect(store.revokeAllForUser('alice', 9_000)).toBe(2);
      for (const token of [alice1.token, alice2.token]) {
        expect(await manager.validate(token, ORIGIN)).toEqual({ ok: false, reason: 'revoked' });
      }
      expect(await manager.validate(bob.token, ORIGIN)).toMatchObject({ ok: true });

      expect(store.revokeAllForUser('carol', 9_000)).toBe(0);
      expect(store.revokeAllForUser('alice', 9_100)).toBe(0); // nothing left to kill
    } finally {
      db.close();
    }
  });
});

describe('M20-B S3 schema v18', () => {
  it('opens a fresh DB at v18 with the widened session columns', () => {
    const db = openDatabase(':memory:');
    try {
      const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
        | { value: string }
        | undefined;
      // The DB records the schema it was opened at; assert against the constant
      // so a bump does not leave a literal behind (v18 → v19 in M20-B S9).
      expect(meta?.value).toBe(String(SCHEMA_VERSION));
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(19);
      expect(columnNames(db, 'sessions')).toEqual(expect.arrayContaining(WIDENED_COLUMNS));
      // kind is untouched: it is the audit actor on the file/root/grant routes.
      expect(columnNames(db, 'sessions')).toContain('kind');
    } finally {
      db.close();
    }
  });

  it('opens a pre-v18 sessions table with the new columns and reads back desktop', () => {
    const db = openDatabase(':memory:');
    try {
      // The shape an older core wrote: drop the v18 table and recreate it
      // exactly as v17 had it, then seed a row the old way.
      db.exec('DROP TABLE sessions');
      db.exec(`CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
      )`);
      db.prepare(
        `INSERT INTO sessions (token_hash, kind, origin, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('legacy-hash', 'web', ORIGIN, 1_000, 1_000_000, 1_000);
      expect(columnNames(db, 'sessions')).not.toContain('client_class');

      // The next start migrates in place — the same call openDatabase makes.
      applySchema(db);
      expect(columnNames(db, 'sessions')).toEqual(expect.arrayContaining(WIDENED_COLUMNS));

      const store = createSessionStore(db);
      expect(store.findByTokenHash('legacy-hash')).toMatchObject({
        kind: 'web',
        origin: ORIGIN,
        userId: null,
        clientClass: 'desktop',
        deviceLabel: null,
        platform: null,
        rotatedAt: null,
      });
      // A legacy row is no user's device, and it can still be rotated.
      expect(store.listByUser('alice')).toEqual([]);
      const legacy = store.findByTokenHash('legacy-hash');
      const legacyId = (legacy as NonNullable<typeof legacy>).id;
      expect(store.rotate(legacyId, 'fresh-hash', 9_000, 9_000)).toBe(true);
      expect(store.findByTokenHash('fresh-hash')).toMatchObject({
        clientClass: 'desktop',
        rotatedAt: 9_000,
      });
    } finally {
      db.close();
    }
  });

  it('defaults a legacy-shaped write to desktop without a store call', () => {
    const db = openDatabase(':memory:');
    try {
      // A writer that does not know the new columns (the column DEFAULT is
      // what keeps an old client from creating a class-less session).
      db.prepare(
        `INSERT INTO sessions (token_hash, kind, origin, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('raw-hash', 'web', ORIGIN, 1_000, 2_000, 1_000);
      const store = createSessionStore(db);
      expect(store.findByTokenHash('raw-hash')).toMatchObject({
        clientClass: 'desktop',
        userId: null,
      });
    } finally {
      db.close();
    }
  });
});
