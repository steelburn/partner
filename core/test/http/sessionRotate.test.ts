/**
 * M20-B S3 (first half) — session rotation and refresh.
 *
 * PLAN-M20 §8.1 item 3 names the 30-day localStorage bearer as the weakest
 * link in the system; rotation + revoke are the cumulative mitigation. This
 * suite pins the credential lifetime: `POST /v1/session/rotate` replaces the
 * presented session's token IN PLACE (the device row survives with its id,
 * user, class and label) while the presented token stops resolving at the
 * very NEXT request.
 *
 * The outgoing token fails as `not_found`, NOT `revoked` (PLAN-M20-B S3): a
 * rotation REPLACES the hash, so there is no row left that could name the old
 * secret — the old token is gone, not signed out. `revoked` stays reserved for
 * a kept row that is explicitly marked (DELETE /v1/session), which is what
 * lets a client be told "you were signed out" instead of "that credential
 * never existed". The reason vocabulary and its precedence are untouched.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_HOST, demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { createSessionManager, tokenHash } from '../../src/http/session.js';
import { createSessionStore, openDatabase } from '../../src/stores/db.js';

const ORIGIN = ALLOWED_HOST;

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ORIGIN).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ORIGIN, Authorization: `Bearer ${token}` };
}

function makeManager(options: { ttlMs?: number; now?: () => number } = {}): {
  db: ReturnType<typeof openDatabase>;
  store: ReturnType<typeof createSessionStore>;
  manager: ReturnType<typeof createSessionManager>;
} {
  const db = openDatabase(':memory:');
  const store = createSessionStore(db);
  return { db, store, manager: createSessionManager(store, options) };
}

describe('session rotate — the route', () => {
  it('replaces the token in place and kills the old one at the NEXT request', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const before = h.sessionStore.findByTokenHash(tokenHash(token));
      expect(before).toBeDefined();
      const row = before as NonNullable<typeof before>;

      const rotated = await request(h.app).post('/v1/session/rotate').set(authed(token));
      expect(rotated.status).toBe(200);
      const next = rotated.body.token as string;
      expect(next).toMatch(/^[0-9a-f]{64}$/); // 256 bits of fresh hex
      expect(next).not.toBe(token);
      expect(rotated.body.kind).toBe('web');
      expect(rotated.body.clientClass).toBe('desktop');
      expect(rotated.body.expiresAt as number).toBeGreaterThan(row.expiresAt);

      // The old token is gone — not revoked, gone.
      const replayed = await request(h.app).get('/v1/audit').set(authed(token));
      expect(replayed.status).toBe(401);
      expect(replayed.body).toEqual({ error: 'unauthorized', reason: 'not_found' });
      expect(h.sessionStore.findByTokenHash(tokenHash(token))).toBeUndefined();

      // The new token works.
      const after = await request(h.app).get('/v1/audit').set(authed(next));
      expect(after.status).toBe(200);

      // The device row SURVIVES: same row id, same identity, rotated_at set.
      const survivor = h.sessionStore.findByTokenHash(tokenHash(next));
      expect(survivor).toMatchObject({
        id: row.id,
        kind: 'web',
        origin: row.origin,
        clientClass: 'desktop',
        createdAt: row.createdAt,
      });
      expect((survivor as NonNullable<typeof survivor>).rotatedAt).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it('answers 401 without a token, and 401 revoked for a signed-out session', async () => {
    const h = demoHarness();
    try {
      const anonymous = await request(h.app).post('/v1/session/rotate').set('Host', ORIGIN);
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.reason).toBe('missing_token');

      const token = await pairToken(h);
      const signedOut = await request(h.app).delete('/v1/session').set(authed(token));
      expect(signedOut.status).toBe(204);

      const refused = await request(h.app).post('/v1/session/rotate').set(authed(token));
      expect(refused.status).toBe(401);
      expect(refused.body).toEqual({ error: 'unauthorized', reason: 'revoked' });
    } finally {
      h.close();
    }
  });

  it('never returns or stores token material in the rotate response', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const rotated = await request(h.app).post('/v1/session/rotate').set(authed(token));
      expect(rotated.status).toBe(200);
      const next = rotated.body.token as string;

      // The raw token crosses this boundary by design; its HASH never does,
      // and neither token hash is anywhere in the body.
      const body = JSON.stringify(rotated.body);
      expect(body).not.toContain(tokenHash(next));
      expect(body).not.toContain(tokenHash(token));
      expect(body).not.toContain(token);

      // The audit row carries the session id and class only.
      const audit = await request(h.app)
        .get('/v1/audit?action=session.rotate')
        .set(authed(next));
      expect(audit.status).toBe(200);
      const serialized = JSON.stringify(audit.body);
      expect(serialized).toContain('session.rotate');
      expect(serialized).not.toContain(tokenHash(next));
    } finally {
      h.close();
    }
  });
});

describe('session rotate — the manager', () => {
  it('keeps the row (user, class, label) while the old token dies', async () => {
    let now = 1_000_000;
    const { db, store, manager } = makeManager({ ttlMs: 60_000, now: () => now });
    try {
      const first = await manager.create({
        kind: 'web',
        origin: ORIGIN,
        clientClass: 'mobile',
        deviceLabel: "Sam's phone",
        platform: 'ios',
        userId: 'u-1',
      });
      const before = store.findByTokenHash(tokenHash(first.token));
      expect(before).toBeDefined();
      const row = before as NonNullable<typeof before>;

      now = 1_000_000 + 5_000;
      const rotated = await manager.rotate(first.token);
      expect(rotated).not.toBeNull();
      const next = rotated as NonNullable<typeof rotated>;
      expect(next.token).not.toBe(first.token);
      expect(next.expiresAt).toBe(1_005_000 + 60_000);

      expect(await manager.validate(first.token, ORIGIN)).toEqual({
        ok: false,
        reason: 'not_found',
      });

      const after = await manager.validate(next.token, ORIGIN);
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.session.id).toBe(row.id);
        expect(after.session.createdAt).toBe(row.createdAt);
        expect(after.session.userId).toBe('u-1');
        expect(after.session.clientClass).toBe('mobile');
        expect(after.session.deviceLabel).toBe("Sam's phone");
      }

      // One row survives (the device), not two.
      const devices = store.listByUser('u-1');
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({
        id: row.id,
        tokenHash: tokenHash(next.token),
        platform: 'ios',
        rotatedAt: 1_005_000,
      });
    } finally {
      db.close();
    }
  });

  it('refuses to rotate an unknown, revoked or expired token', async () => {
    let now = 1_000_000;
    const { db, manager } = makeManager({ ttlMs: 60_000, now: () => now });
    try {
      expect(await manager.rotate('a'.repeat(64))).toBeNull();
      expect(await manager.refresh('a'.repeat(64))).toBeNull();

      const revoked = await manager.create({ kind: 'web', origin: ORIGIN });
      await manager.revoke(revoked.token);
      expect(await manager.rotate(revoked.token)).toBeNull();

      const expiring = await manager.create({ kind: 'web', origin: ORIGIN });
      now = 1_000_000 + 60_001;
      expect(await manager.validate(expiring.token, ORIGIN)).toEqual({
        ok: false,
        reason: 'expired',
      });
      expect(await manager.rotate(expiring.token)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('refuses an unknown client class at the mint', async () => {
    const { db, manager } = makeManager();
    try {
      for (const clientClass of ['Desktop', 'web', '', 'device']) {
        await expect(manager.create({ kind: 'web', origin: ORIGIN, clientClass })).rejects.toThrow(
          /invalid_client_class/,
        );
      }
      for (const clientClass of ['desktop', 'mobile', 'extension']) {
        const created = await manager.create({ kind: 'web', origin: ORIGIN, clientClass });
        expect(created.token).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      db.close();
    }
  });
});

describe('session refresh', () => {
  it('extends the expiry without changing identity', async () => {
    let now = 1_000_000;
    const { db, store, manager } = makeManager({ ttlMs: 60_000, now: () => now });
    try {
      const created = await manager.create({
        kind: 'web',
        origin: ORIGIN,
        clientClass: 'extension',
        deviceLabel: 'side panel',
        platform: 'chrome-extension',
        userId: 'u-1',
      });
      const before = await manager.validate(created.token, ORIGIN);
      expect(before.ok).toBe(true);
      if (!before.ok) return;

      now = 1_000_000 + 30_000;
      expect(await manager.refresh(created.token)).toEqual({ expiresAt: 1_090_000 });

      const after = await manager.validate(created.token, ORIGIN);
      expect(after.ok).toBe(true);
      if (after.ok) {
        // Same row, token, kind, user, class and label — only the expiry moved.
        expect(after.session).toEqual({ ...before.session, expiresAt: 1_090_000 });
      }
      // A refresh is not a rotation: the token is unchanged and rotated_at
      // stays NULL.
      const row = store.findByTokenHash(tokenHash(created.token));
      expect(row).toMatchObject({ clientClass: 'extension', platform: 'chrome-extension' });
      expect((row as NonNullable<typeof row>).rotatedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it('refuses a revoked or expired token', async () => {
    let now = 1_000_000;
    const { db, manager } = makeManager({ ttlMs: 60_000, now: () => now });
    try {
      const revoked = await manager.create({ kind: 'web', origin: ORIGIN });
      await manager.revoke(revoked.token);
      expect(await manager.refresh(revoked.token)).toBeNull();

      const expiring = await manager.create({ kind: 'web', origin: ORIGIN });
      now = 1_000_000 + 60_001;
      expect(await manager.refresh(expiring.token)).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('session create input', () => {
  it('defaults to the desktop class and no user, keeping legacy pairing intact', async () => {
    const { db, store, manager } = makeManager();
    try {
      const created = await manager.create({ kind: 'web', origin: ORIGIN });
      const row = store.findByTokenHash(tokenHash(created.token));
      expect(row).toMatchObject({
        kind: 'web',
        origin: ORIGIN,
        userId: null,
        clientClass: 'desktop',
        deviceLabel: null,
        platform: null,
        rotatedAt: null,
      });
    } finally {
      db.close();
    }
  });
});
