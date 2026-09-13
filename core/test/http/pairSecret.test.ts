import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createMemoryPairSecretStore,
  createPairSecretManager,
  isPairSecret,
} from '../../src/http/pairSecret.js';
import type { PairSecretManager, PairSecretStore } from '../../src/http/pairSecret.js';

const TTL = 120_000;
const NOW = 1_700_000_000_000;

/** Wrong guesses that can never collide with a 32-byte random secret. */
const wrong = (i: number): string => `${String(i).padStart(2, '0')}${'A'.repeat(41)}`;

function make(
  options: {
    maxAttempts?: number;
    lockMs?: number;
    ttlMs?: number;
    now?: () => number;
    store?: PairSecretStore;
  } = {},
): { secrets: PairSecretManager; store: PairSecretStore; setNow: (value: number) => void } {
  const store = options.store ?? createMemoryPairSecretStore();
  let now = NOW;
  const secrets = createPairSecretManager({
    store,
    now: options.now ?? (() => now),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.lockMs === undefined ? {} : { lockMs: options.lockMs }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
  return { secrets, store, setNow: (value: number) => (now = value) };
}

describe('pair secret manager', () => {
  it('issues a 256-bit base64url secret and stores only a keyed HMAC', async () => {
    const { secrets, store } = make();
    const secret = await secrets.issue();

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url').byteLength).toBe(32);
    expect(isPairSecret(secret)).toBe(true);

    const row = store.getLatest();
    expect(row).toBeDefined();
    const stored = row as NonNullable<typeof row>;
    expect(stored.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.secretHash).not.toBe(secret); // plaintext never stored
    // KEYED HMAC-SHA256 with a per-process key, NOT the offline-reversible
    // unkeyed digest of a captured secret.
    expect(stored.secretHash).not.toBe(
      createHash('sha256').update(secret, 'utf8').digest('hex'),
    );
    expect(stored.expiresAt).toBe(NOW + TTL);
    expect(stored.attempts).toBe(0);
    expect(stored.lockedUntil).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it('works with its default in-memory store when none is injected', async () => {
    const secrets = createPairSecretManager({ now: () => NOW });
    const secret = await secrets.issue();
    expect(await secrets.verify(secret)).toEqual({ ok: true });
  });

  it('issues a different secret every time and keeps only the newest active', async () => {
    const { secrets } = make();
    const first = await secrets.issue();
    const second = await secrets.issue();
    expect(first).not.toBe(second);

    // Single active: the replaced secret is unknown, and its rejection does
    // not disturb the active one.
    expect(await secrets.verify(first)).toEqual({ ok: false, reason: 'invalid' });
    expect(await secrets.verify(second)).toEqual({ ok: true });
  });

  it('accepts the secret once, then consumes it (single use)', async () => {
    const { secrets, store } = make();
    const secret = await secrets.issue();

    expect(await secrets.verify(secret)).toEqual({ ok: true });
    expect(await secrets.verify(secret)).toEqual({ ok: false, reason: 'not_found' });
    expect(store.getLatest()).toBeUndefined();
  });

  it('refuses an expired secret and drops the row', async () => {
    const { secrets, store, setNow } = make();
    const secret = await secrets.issue();

    setNow(NOW + TTL + 1);
    expect(await secrets.verify(secret)).toEqual({ ok: false, reason: 'expired' });
    expect(store.getLatest()).toBeUndefined();
    // Expiry is not a wrong guess, and the secret is gone for good.
    expect(await secrets.verify(secret)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports not_found when nothing was ever issued', async () => {
    const { secrets } = make();
    expect(await secrets.verify(wrong(1))).toEqual({ ok: false, reason: 'not_found' });
  });

  it('locks after N wrong attempts and refuses even the correct secret while locked', async () => {
    const { secrets } = make({ maxAttempts: 3, lockMs: 300_000 });
    const secret = await secrets.issue();

    expect(await secrets.verify(wrong(1))).toEqual({ ok: false, reason: 'invalid' });
    expect(await secrets.verify(wrong(2))).toEqual({ ok: false, reason: 'invalid' });
    expect(await secrets.verify(wrong(3))).toEqual({ ok: false, reason: 'invalid' });

    expect(await secrets.verify(wrong(4))).toEqual({ ok: false, reason: 'locked' });
    expect(await secrets.verify(secret)).toEqual({ ok: false, reason: 'locked' });
  });

  it('clears the lock after lockMs so a fresh scan can still pair', async () => {
    const { secrets, setNow } = make({ maxAttempts: 2, lockMs: 300_000, ttlMs: 900_000 });
    const secret = await secrets.issue();

    await secrets.verify(wrong(1));
    await secrets.verify(wrong(2));
    expect(await secrets.verify(secret)).toEqual({ ok: false, reason: 'locked' });

    setNow(NOW + 300_000 + 1);
    expect(await secrets.verify(secret)).toEqual({ ok: true });
  });

  it('buckets unusable input as a wrong guess instead of accepting or throwing', async () => {
    const { secrets } = make({ maxAttempts: 3 });
    const secret = await secrets.issue();

    expect(await secrets.verify('')).toEqual({ ok: false, reason: 'invalid' });
    expect(await secrets.verify(null as unknown as string)).toEqual({ ok: false, reason: 'invalid' });
    expect(await secrets.verify('not base64url at all! '.repeat(3))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    // The three bad presentations consumed the attempt budget — fail closed,
    // and the real secret is refused until the lock expires.
    expect(await secrets.verify('')).toEqual({ ok: false, reason: 'locked' });
    expect(await secrets.verify(secret)).toEqual({ ok: false, reason: 'locked' });
  });

  it('never hands out the same secret twice', async () => {
    const { secrets } = make();
    const issued = new Set<string>();
    for (let i = 0; i < 16; i += 1) issued.add(await secrets.issue());
    expect(issued.size).toBe(16);
  });
});

describe('isPairSecret', () => {
  it('accepts a canonical 32-byte base64url secret', async () => {
    const { secrets } = make();
    expect(isPairSecret(await secrets.issue())).toBe(true);
  });

  it('rejects anything else', () => {
    const valid = `${'A'.repeat(42)}E`; // 43 chars, canonical
    expect(isPairSecret(valid)).toBe(true);
    for (const value of [
      '',
      'abc',
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}E=`,
      `${'A'.repeat(42)}B`, // padding bits set: decodes to 32 bytes, not canonical
      undefined,
      null,
      7,
      {},
    ]) {
      expect(isPairSecret(value)).toBe(false);
    }
  });
});
