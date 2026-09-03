import { describe, expect, it } from 'vitest';
import { createSessionManager, tokenHash } from '../src/http/session.js';
import type { SessionManager } from '../src/http/session.js';
import { openDatabase } from '../src/stores/db.js';
import { createSessionStore } from '../src/stores/db.js';
import type { SessionStore } from '../src/stores/types.js';

const ORIGIN = '127.0.0.1:4390';
const OTHER_ORIGIN = 'localhost:4390';

function makeManager(ttlMs = 60_000, now = () => 1_000_000): { manager: SessionManager; store: SessionStore; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase(':memory:');
  const store = createSessionStore(db);
  return { manager: createSessionManager(store, { ttlMs, now }), store, db };
}

describe('session manager', () => {
  it('create returns a 256-bit token and stores only its hash', async () => {
    const { manager, store } = makeManager();
    const { token, expiresAt } = await manager.create('web', ORIGIN);
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 256 bits of hex

    const row = store.findByTokenHash(tokenHash(token));
    expect(row).toBeDefined();
    const stored = row as NonNullable<typeof row>;
    expect(stored.tokenHash).not.toBe(token);
    expect(stored.tokenHash).toBe(tokenHash(token));
    expect(stored.origin).toBe(ORIGIN);
    expect(stored.kind).toBe('web');
    expect(expiresAt).toBe(1_000_000 + 60_000);

    // The raw token appears nowhere in the stored row.
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(token);
  });

  it('validate accepts the right origin and refuses a different one', async () => {
    const { manager } = makeManager();
    const { token } = await manager.create('web', ORIGIN);

    const ok = await manager.validate(token, ORIGIN);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.session.kind).toBe('web');
      expect(ok.session.origin).toBe(ORIGIN);
    }

    const wrong = await manager.validate(token, OTHER_ORIGIN);
    expect(wrong).toEqual({ ok: false, reason: 'origin_mismatch' });
  });

  it('an expired session is rejected', async () => {
    let now = 1_000_000;
    const { manager } = makeManager(60_000, () => now);
    const { token } = await manager.create('web', ORIGIN);
    now = 1_000_000 + 60_001;
    const result = await manager.validate(token, ORIGIN);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('revoke kills the session immediately; unknown revoke is false', async () => {
    const { manager } = makeManager();
    const { token } = await manager.create('web', ORIGIN);

    expect(await manager.revoke(token)).toBe(true);
    expect(await manager.validate(token, ORIGIN)).toEqual({ ok: false, reason: 'revoked' });
    expect(await manager.revoke('deadbeef'.repeat(8))).toBe(false);
  });

  it('validate of an unknown token reports not_found', async () => {
    const { manager } = makeManager();
    const result = await manager.validate('a'.repeat(64), ORIGIN);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('touch bumps last_seen_at for a live session only', async () => {
    let now = 1_000_000;
    const { manager, store } = makeManager(60_000, () => now);
    const { token } = await manager.create('web', ORIGIN);

    now = 1_000_000 + 5_000;
    expect(await manager.touch(token)).toBe(true);
    const row = store.findByTokenHash(tokenHash(token));
    expect((row as NonNullable<typeof row>).lastSeenAt).toBe(1_000_000 + 5_000);

    await manager.revoke(token);
    expect(await manager.touch(token)).toBe(false);
  });

  it('tokens from different creations never collide', async () => {
    const { manager } = makeManager();
    const a = await manager.create('web', ORIGIN);
    const b = await manager.create('web', ORIGIN);
    const c = await manager.create('native', ORIGIN);
    expect(new Set([a.token, b.token, c.token]).size).toBe(3);
    expect(await manager.validate(a.token, ORIGIN)).toMatchObject({ ok: true });
  });
});
