import { describe, expect, it } from 'vitest';
import { codeHash, createPairingManager } from '../src/http/pairing.js';
import { openDatabase } from '../src/stores/db.js';
import { createPairingStore } from '../src/stores/db.js';
import type { PairingStore } from '../src/stores/types.js';

/** Codes guaranteed distinct from the issued one, for wrong-guess tests. */
function wrongCodes(issued: string, n: number): string[] {
  const base = Number.parseInt(issued, 10);
  return Array.from({ length: n }, (_, i) => String((base + i + 1) % 1_000_000).padStart(6, '0'));
}

function makeStore(): PairingStore {
  return createPairingStore(openDatabase(':memory:'));
}

describe('pairing manager', () => {
  it('issue returns exactly 6 digits and stores only a keyed hash', async () => {
    const store = makeStore();
    const pairing = createPairingManager(store, { now: () => 1_000 });
    const code = await pairing.issue();
    expect(code).toMatch(/^\d{6}$/);

    const row = store.getLatest();
    expect(row).toBeDefined();
    const stored = row as NonNullable<typeof row>;
    expect(stored.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.codeHash).not.toBe(code); // plaintext never persisted
    // Keyed HMAC-SHA256, NOT the offline-reversible SHA-256 of the 10^6
    // code space (per-process key; codes die with the process).
    expect(stored.codeHash).not.toBe(codeHash(code));
    expect(stored.expiresAt).toBe(1_000 + 120_000);
    expect(stored.attempts).toBe(0);
    expect(stored.lockedUntil).toBeNull();
  });

  it('verify succeeds once, then the code is consumed (single use)', async () => {
    const store = makeStore();
    const pairing = createPairingManager(store, { now: () => 1_000 });
    const code = await pairing.issue();

    const first = await pairing.verify(code);
    expect(first).toEqual({ ok: true, code });

    const second = await pairing.verify(code);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('not_found');

    // Row is gone after consumption.
    expect(store.getLatest()).toBeUndefined();
  });

  it('an expired code fails with reason expired', async () => {
    const store = makeStore();
    let now = 1_000;
    const pairing = createPairingManager(store, { now: () => now });
    const code = await pairing.issue();

    now = 1_000 + 120_001; // past the 2 min TTL
    const result = await pairing.verify(code);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('three wrong codes lock the pairing, then it unlocks after lockMs', async () => {
    const store = makeStore();
    let now = 10_000;
    // TTL much longer than lockMs so the code is still fresh after unlock.
    const pairing = createPairingManager(store, {
      now: () => now,
      codeTtlMs: 3_600_000,
      maxAttempts: 3,
      lockMs: 300_000,
    });
    const code = await pairing.issue();

    for (const wrong of wrongCodes(code, 3)) {
      const result = await pairing.verify(wrong);
      expect(result).toEqual({ ok: false, reason: 'invalid' });
    }

    // Locked while lockMs is active — even the correct code is refused.
    const locked = await pairing.verify(code);
    expect(locked).toEqual({ ok: false, reason: 'locked' });

    const rowDuringLock = store.getLatest() as NonNullable<ReturnType<PairingStore['getLatest']>>;
    expect(rowDuringLock.lockedUntil).toBe(now + 300_000);
    expect(rowDuringLock.attempts).toBe(0); // bucket resets after a lock

    // After lockMs the code verifies again (still inside its TTL).
    now = 10_000 + 300_001;
    const after = await pairing.verify(code);
    expect(after).toEqual({ ok: true, code });
  });

  it('a wrong code on a non-existent pairing reports not_found', async () => {
    const store = makeStore();
    const pairing = createPairingManager(store, { now: () => 1_000 });
    const result = await pairing.verify('123456');
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('issue replaces any previous pairing (single active code)', async () => {
    const store = makeStore();
    const pairing = createPairingManager(store, { now: () => 1_000 });
    const first = await pairing.issue();
    const second = await pairing.issue();
    expect(first).not.toBe(second);
    const latest = store.getLatest();
    expect(latest?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(latest?.codeHash).not.toBe(codeHash(second)); // keyed, not plain SHA-256
    // The superseded code is now a wrong guess against the active pairing.
    expect(await pairing.verify(first)).toEqual({ ok: false, reason: 'invalid' });
    expect(await pairing.verify(second)).toEqual({ ok: true, code: second });
  });
});

describe('pairing devCode (demo seam)', () => {
  it('returns the active code only in demo mode', async () => {
    const store = makeStore();
    const demo = createPairingManager(store, { demo: true, now: () => 1_000 });
    const live = createPairingManager(store, { demo: false, now: () => 1_000 });

    const code = await demo.issue();
    expect(await demo.devCode()).toBe(code);
    // Live mode never reveals the code, even though one is active.
    expect(await live.devCode()).toBeNull();
  });

  it('devCode returns null after the code is consumed or expired', async () => {
    const store = makeStore();
    let now = 1_000;
    const pairing = createPairingManager(store, { demo: true, now: () => now });
    const code = await pairing.issue();
    expect(await pairing.devCode()).toBe(code);

    await pairing.verify(code);
    expect(await pairing.devCode()).toBeNull();

    const code2 = await pairing.issue();
    now = 1_000 + 120_001;
    expect(await pairing.devCode()).toBeNull(); // expired
    expect(code2).toMatch(/^\d{6}$/);
  });
});
