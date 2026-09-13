/**
 * M20-B S5 — the device registry routes: `GET /v1/devices`,
 * `POST /v1/devices/:id/revoke`, `POST /v1/devices/revoke-all`.
 *
 * These three routes are the user-visible half of "the 30-day bearer is the
 * weakest link" (PLAN-M20 §8.1 item 3): rotation bounds how long a leaked
 * token lives, and this surface is how its owner SEES the device and kills it.
 * What this suite pins:
 *
 *  - a caller sees its own user's devices only, and the pre-auth transitional
 *    rule (`user_id` NULL ⇒ the whole single-user core) is asserted explicitly
 *    — together with the rule that a session naming a user can never reach it;
 *  - another user's device id answers 404 with the SAME body as an unknown id,
 *    never 403: 403 confirms the row exists, which is cross-user enumeration;
 *  - revoke is idempotent, a revoked token 401s `reason: 'revoked'` at the
 *    NEXT request, and the row survives so the owner can still see it;
 *  - revoke-all INCLUDES the caller's own session and the body says so;
 *  - no response body carries a token hash — asserted over the RAW JSON text,
 *    not over a typed field, so a future field addition cannot leak one.
 *
 * The real clock is frozen BEFORE the harness is built (see
 * `clockedHarness`), so createdAt / lastSeenAt / revokedAt are compared to
 * exact instants instead of to "roughly now".
 */
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ALLOWED_HOST, demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { tokenHash } from '../../src/http/session.js';

const ORIGIN = ALLOWED_HOST;
/** The frozen "now" every session in this suite is minted at. */
const T0 = 1_700_000_000_000;

interface Clocked {
  h: Harness;
  /** Move the frozen clock (the harness reads it through `Date.now`). */
  at(ms: number): void;
  close(): void;
}

/**
 * demoHarness wires its session manager over the real clock and exposes no
 * option to inject one, so the process clock is frozen BEFORE the harness is
 * built: `createSessionManager` captures `Date.now` at construction (as do the
 * pairing manager and the audit service), which is what makes every timestamp
 * in these tests exact. The spy is restored when the harness is closed.
 */
function clockedHarness(): Clocked {
  let clock = T0;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const h = demoHarness();
  return {
    h,
    at(ms: number): void {
      clock = ms;
    },
    close(): void {
      h.close();
      spy.mockRestore();
    },
  };
}

function authed(token: string): Record<string, string> {
  return { Host: ORIGIN, Authorization: `Bearer ${token}` };
}

interface SeedTokens {
  aliceDesktop: string;
  alicePhone: string;
  bobPhone: string;
  preAuth: string;
}

/** Four sessions on one core: two of Alice's, one of Bob's, one with no user. */
async function seedDevices(h: Harness): Promise<SeedTokens> {
  const aliceDesktop = await h.sessions.create({
    kind: 'web',
    origin: ORIGIN,
    userId: 'alice',
    clientClass: 'desktop',
    deviceLabel: 'Kitchen desktop',
    platform: 'win32',
  });
  const alicePhone = await h.sessions.create({
    kind: 'web',
    origin: ORIGIN,
    userId: 'alice',
    clientClass: 'mobile',
    deviceLabel: "Alice's phone",
    platform: 'ios',
  });
  const bobPhone = await h.sessions.create({
    kind: 'web',
    origin: ORIGIN,
    userId: 'bob',
    clientClass: 'mobile',
    deviceLabel: "Bob's phone",
    platform: 'android',
  });
  // The shape every session has in the field TODAY: the sign-in route does not
  // exist yet, so nothing sets user_id (PLAN-M20-B §2a).
  const preAuth = await h.sessions.create({ kind: 'web', origin: ORIGIN });
  return {
    aliceDesktop: aliceDesktop.token,
    alicePhone: alicePhone.token,
    bobPhone: bobPhone.token,
    preAuth: preAuth.token,
  };
}

/** The row id behind a token — the id the routes address devices by. */
function rowId(h: Harness, token: string): number {
  const row = h.sessionStore.findByTokenHash(tokenHash(token));
  expect(row).toBeDefined();
  return (row as NonNullable<typeof row>).id;
}

/** Every token hash this suite minted, for "no hash anywhere" assertions. */
function allHashes(tokens: SeedTokens): string[] {
  return Object.values(tokens).map((token) => tokenHash(token));
}

interface AuditEntry {
  actor: string;
  action: string;
  target: string;
  details: string;
}

/** The device-revoke audit rows, read back with a token the test still holds. */
async function deviceAuditRows(h: Harness, token: string): Promise<AuditEntry[]> {
  const res = await request(h.app).get('/v1/audit?limit=200').set(authed(token));
  expect(res.status).toBe(200);
  return (res.body.entries as AuditEntry[]).filter(
    (entry) => entry.target === 'device' && entry.action.startsWith('session.revoke'),
  );
}

describe('GET /v1/devices', () => {
  it("lists the caller's own devices with the registry fields and nothing else", async () => {
    const clock = clockedHarness();
    try {
      const { h } = clock;
      const tokens = await seedDevices(h);
      const desktopId = rowId(h, tokens.aliceDesktop);
      const phoneId = rowId(h, tokens.alicePhone);

      const res = await request(h.app).get('/v1/devices').set(authed(tokens.aliceDesktop));
      expect(res.status).toBe(200);
      // Exact object equality: the registry has these seven fields and no
      // eighth. A `tokenHash` (or anything else) added to the projection fails
      // here rather than in review.
      expect(res.body.devices).toEqual([
        {
          id: desktopId,
          clientClass: 'desktop',
          deviceLabel: 'Kitchen desktop',
          platform: 'win32',
          createdAt: T0,
          lastSeenAt: T0,
          revokedAt: null,
        },
        {
          id: phoneId,
          clientClass: 'mobile',
          deviceLabel: "Alice's phone",
          platform: 'ios',
          createdAt: T0,
          lastSeenAt: T0,
          revokedAt: null,
        },
      ]);
    } finally {
      clock.close();
    }
  });

  it("never lists another user's devices, and a named user never falls back to every row", async () => {
    const clock = clockedHarness();
    try {
      const { h } = clock;
      const tokens = await seedDevices(h);
      const bobId = rowId(h, tokens.bobPhone);
      const preAuthId = rowId(h, tokens.preAuth);

      const bobList = await request(h.app).get('/v1/devices').set(authed(tokens.bobPhone));
      expect(bobList.status).toBe(200);
      expect(bobList.body.devices.map((d: { id: number }) => d.id)).toEqual([bobId]);

      // A NULL-user row is ALIVE in the table (it would be returned by the
      // whole-table read), so this pins the branch rather than an empty table.
      const aliceIds = (await h.sessions.listDevices('alice')).map((device) => device.id);
      expect(aliceIds).toEqual([rowId(h, tokens.aliceDesktop), rowId(h, tokens.alicePhone)]);
      expect(aliceIds).not.toContain(bobId);
      expect(aliceIds).not.toContain(preAuthId);

      expect(await h.sessions.listDevices('carol')).toEqual([]);
    } finally {
      clock.close();
    }
  });

  it('the transitional pre-auth rule: a NULL-user session sees only OTHER user-less rows', async () => {
    const clock = clockedHarness();
    try {
      const { h } = clock;
      const tokens = await seedDevices(h);
      const preAuthId = rowId(h, tokens.preAuth);
      const namedIds = [
        rowId(h, tokens.aliceDesktop),
        rowId(h, tokens.alicePhone),
        rowId(h, tokens.bobPhone),
      ];

      // Why the rule exists at all: the sign-in route does not exist yet, so a
      // strictly user-scoped read would be EMPTY on every install that exists
      // today — the feature would ship broken.
      //
      // Why it is SCOPED to user-less rows rather than the whole table: once
      // users exist, an unscoped read would let a legacy pre-auth device READ
      // and REVOKE a named user's sessions. Since every session in the field is
      // user-less today, that wide branch would have been the default, not an
      // edge case. (This test previously pinned the wide behaviour.)
      const res = await request(h.app).get('/v1/devices').set(authed(tokens.preAuth));
      expect(res.status).toBe(200);
      const visible = res.body.devices.map((d: { id: number }) => d.id);
      expect(visible).toContain(preAuthId);
      for (const named of namedIds) expect(visible).not.toContain(named);

      // The manager agrees, and `null` means "no user", never "any user".
      expect((await h.sessions.listDevices(null)).map((d) => d.id)).not.toContain(
        namedIds[0],
      );
      expect((await h.sessions.listDevices('alice')).map((d) => d.id)).not.toContain(preAuthId);

      // …and the WRITE side is scoped too: a user-less session cannot revoke a
      // named user's device, which is the half that would have been a hole.
      const revoked = await request(h.app)
        .post(`/v1/devices/${namedIds[0]}/revoke`)
        .set(authed(tokens.preAuth));
      expect(revoked.status).toBe(404);
      expect((await h.sessions.listDevices('alice')).map((d) => d.id)).toContain(namedIds[0]);
    } finally {
      clock.close();
    }
  });
});

describe('POST /v1/devices/:id/revoke', () => {
  it("revokes one device: the revoked token 401s 'revoked' next, and the row survives for the list", async () => {
    const clock = clockedHarness();
    try {
      const { h } = clock;
      const tokens = await seedDevices(h);
      const phoneId = rowId(h, tokens.alicePhone);

      clock.at(T0 + 60_000);
      const revoked = await request(h.app)
        .post(`/v1/devices/${phoneId}/revoke`)
        .set(authed(tokens.aliceDesktop));
      expect(revoked.status).toBe(200);
      expect(revoked.body).toEqual({ id: phoneId, revoked: true, alreadyRevoked: false });

      // The NEXT request from that device is refused, and says why: the row is
      // kept and marked, unlike a rotated-out token (which is simply gone).
      const next = await request(h.app).get('/v1/audit').set(authed(tokens.alicePhone));
      expect(next.status).toBe(401);
      expect(next.body).toEqual({ error: 'unauthorized', reason: 'revoked' });

      // The row survives — that is what lets the owner see what was signed out
      // — but it is NOT reported as live.
      const row = h.sessionStore.findByTokenHash(tokenHash(tokens.alicePhone));
      expect(row).toMatchObject({ userId: 'alice', revokedAt: T0 + 60_000 });

      const list = await request(h.app).get('/v1/devices').set(authed(tokens.aliceDesktop));
      expect(list.status).toBe(200);
      expect(list.body.devices).toEqual([
        expect.objectContaining({ id: rowId(h, tokens.aliceDesktop), revokedAt: null }),
        expect.objectContaining({
          id: phoneId,
          deviceLabel: "Alice's phone",
          revokedAt: T0 + 60_000,
        }),
      ]);
      // The other user's device is untouched by Alice's revoke.
      expect(await h.sessions.validate(tokens.bobPhone, ORIGIN)).toMatchObject({ ok: true });
    } finally {
      clock.close();
    }
  });

  it('is idempotent: a second revoke answers 200 without restamping or re-auditing', async () => {
    const clock = clockedHarness();
    try {
      const { h } = clock;
      const tokens = await seedDevices(h);
      const phoneId = rowId(h, tokens.alicePhone);

      clock.at(T0 + 1_000);
      const first = await request(h.app)
        .post(`/v1/devices/${phoneId}/revoke`)
        .set(authed(tokens.aliceDesktop));
      expect(first.status).toBe(200);
      expect(first.body.alreadyRevoked).toBe(false);

      clock.at(T0 + 5_000);
      const second = await request(h.app)
        .post(`/v1/devices/${phoneId}/revoke`)
        .set(authed(tokens.aliceDesktop));
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ id: phoneId, revoked: true, alreadyRevoked: true });

      // Nothing changed the second time: not the stamp, not the audit trail.
      expect(h.sessionStore.findByTokenHash(tokenHash(tokens.alicePhone))).toMatchObject({
        revokedAt: T0 + 1_000,
      });
      const rows = await deviceAuditRows(h, tokens.aliceDesktop);
      expect(rows).toHaveLength(1);
      const auditRow = rows[0] as AuditEntry;
      expect(auditRow).toMatchObject({ actor: 'session', action: 'session.revoke' });
      // The audit row carries the id and nothing else — no label, no hash.
      expect(JSON.parse(auditRow.details)).toEqual({ sessionId: phoneId });
      expect(auditRow.details).not.toContain("Alice's phone");
      expect(auditRow.details).not.toContain(tokenHash(tokens.alicePhone));
    } finally {
      clock.close();
    }
  });

  it("answers 404 — not 403 — for another user's device id, and leaves that row untouched", async () => {
    const clock = clockedHarness();
    try {
      const { h } = clock;
      const tokens = await seedDevices(h);
      const bobId = rowId(h, tokens.bobPhone);
      const unknownId = bobId + 1_000;

      const forbiddenLookalike = await request(h.app)
        .post(`/v1/devices/${bobId}/revoke`)
        .set(authed(tokens.aliceDesktop));
      const unknown = await request(h.app)
        .post(`/v1/devices/${unknownId}/revoke`)
        .set(authed(tokens.aliceDesktop));
      const malformed = await request(h.app)
        .post('/v1/devices/not-a-number/revoke')
        .set(authed(tokens.aliceDesktop));

      // Byte-identical bodies: nothing distinguishes "exists but not yours"
      // from "does not exist", so an id cannot be used to enumerate.
      expect(forbiddenLookalike.status).toBe(404);
      expect(forbiddenLookalike.body).toEqual({ error: 'not_found', message: 'device not found' });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual(forbiddenLookalike.body);
      expect(malformed.status).toBe(404);
      expect(malformed.body).toEqual(forbiddenLookalike.body);

      // Bob's device is untouched, and no refusal wrote an audit row.
      expect(h.sessionStore.findByTokenHash(tokenHash(tokens.bobPhone))).toMatchObject({
        revokedAt: null,
      });
      expect(await h.sessions.validate(tokens.bobPhone, ORIGIN)).toMatchObject({ ok: true });
      expect(await deviceAuditRows(h, tokens.bobPhone)).toEqual([]);
    } finally {
      clock.close();
    }
  });
});

describe('POST /v1/devices/revoke-all', () => {
  it("kills every device of the caller — its own session included — and none of another user's", async () => {
    const clock = clockedHarness();
    try {
      const { h } = clock;
      const tokens = await seedDevices(h);

      clock.at(T0 + 90_000);
      // A MOBILE caller on purpose: device lifecycle is not a capability, so
      // the phone that most likely holds a leaked token can still sign out.
      const res = await request(h.app)
        .post('/v1/devices/revoke-all')
        .set(authed(tokens.alicePhone));
      expect(res.status).toBe(200);
      // The body STATES the consequence: the calling session was included, so
      // the client must show "pair again" instead of letting the user find out.
      expect(res.body).toEqual({ revoked: 2, currentSessionRevoked: true });

      for (const token of [tokens.aliceDesktop, tokens.alicePhone]) {
        const next = await request(h.app).get('/v1/devices').set(authed(token));
        expect(next.status).toBe(401);
        expect(next.body).toEqual({ error: 'unauthorized', reason: 'revoked' });
      }

      // Bob's device is untouched, and both alice rows survive for the record.
      expect(await h.sessions.validate(tokens.bobPhone, ORIGIN)).toMatchObject({ ok: true });
      expect((await h.sessions.listDevices('alice')).map((d) => d.revokedAt)).toEqual([
        T0 + 90_000,
        T0 + 90_000,
      ]);

      const rows = await deviceAuditRows(h, tokens.bobPhone);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'session.revoke_all' });
      expect(JSON.parse((rows[0] as AuditEntry).details)).toEqual({
        count: 2,
        sessionId: rowId(h, tokens.alicePhone),
        currentSessionRevoked: true,
      });
    } finally {
      clock.close();
    }
  });

  it('leaves already-revoked rows alone when the caller signs out everything again', async () => {
    const clock = clockedHarness();
    try {
      const { h } = clock;
      const tokens = await seedDevices(h);

      clock.at(T0 + 10_000);
      const first = await request(h.app)
        .post('/v1/devices/revoke-all')
        .set(authed(tokens.aliceDesktop));
      expect(first.body).toEqual({ revoked: 2, currentSessionRevoked: true });

      // A device that pairs again after the sweep gets its own row; signing out
      // everything a second time kills only that new session and leaves the two
      // earlier rows stamped exactly as they were.
      const repaired = await h.sessions.create({
        kind: 'web',
        origin: ORIGIN,
        userId: 'alice',
        clientClass: 'mobile',
      });
      clock.at(T0 + 20_000);
      const again = await request(h.app)
        .post('/v1/devices/revoke-all')
        .set(authed(repaired.token));
      expect(again.body).toEqual({ revoked: 1, currentSessionRevoked: true });

      expect((await h.sessions.listDevices('alice')).map((d) => d.revokedAt)).toEqual([
        T0 + 10_000,
        T0 + 10_000,
        T0 + 20_000,
      ]);
      // Bob is untouched throughout.
      expect(await h.sessions.validate(tokens.bobPhone, ORIGIN)).toMatchObject({ ok: true });
    } finally {
      clock.close();
    }
  });
});

describe('device registry — body and auth discipline', () => {
  it('never puts a token hash in any response body, all three routes included', async () => {
    const clock = clockedHarness();
    try {
      const { h } = clock;
      const tokens = await seedDevices(h);
      const hashes = allHashes(tokens);

      const list = await request(h.app).get('/v1/devices').set(authed(tokens.aliceDesktop));
      const revoke = await request(h.app)
        .post(`/v1/devices/${rowId(h, tokens.alicePhone)}/revoke`)
        .set(authed(tokens.aliceDesktop));
      const audit = await request(h.app).get('/v1/audit?limit=200').set(authed(tokens.aliceDesktop));
      // Last: this one revokes the session that fetched the audit above.
      const revokeAll = await request(h.app)
        .post('/v1/devices/revoke-all')
        .set(authed(tokens.preAuth));

      for (const res of [list, revoke, audit, revokeAll]) {
        expect(res.status).toBeLessThan(300);
        // RAW JSON text, not a typed field: an added field cannot slip past.
        for (const hash of hashes) expect(res.text).not.toContain(hash);
      }
      // Not even the shape of one can appear in the registry projection.
      expect(list.text).not.toContain('tokenHash');
      expect(list.text).not.toContain('token_hash');
    } finally {
      clock.close();
    }
  });

  it('refuses every device route without a token, and after revoke-all with reason revoked', async () => {
    const clock = clockedHarness();
    try {
      const { h } = clock;
      const tokens = await seedDevices(h);
      const anonymous = [
        await request(h.app).get('/v1/devices').set('Host', ORIGIN),
        await request(h.app).post('/v1/devices/1/revoke').set('Host', ORIGIN),
        await request(h.app).post('/v1/devices/revoke-all').set('Host', ORIGIN),
      ];
      for (const res of anonymous) {
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'unauthorized', reason: 'missing_token' });
      }

      const signedOut = await request(h.app)
        .post('/v1/devices/revoke-all')
        .set(authed(tokens.aliceDesktop));
      expect(signedOut.body.currentSessionRevoked).toBe(true);
      const refused = await request(h.app).get('/v1/devices').set(authed(tokens.aliceDesktop));
      expect(refused.status).toBe(401);
      expect(refused.body).toEqual({ error: 'unauthorized', reason: 'revoked' });
    } finally {
      clock.close();
    }
  });
});
