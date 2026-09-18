/**
 * M20-B S2a — per-user passphrase credentials (PLAN-M20-B.md §2a).
 *
 * Pins the properties the authentication primitive must have: only salt +
 * scrypt key + params ever reach the row (never the passphrase), a wrong
 * passphrase is a TYPED refusal rather than a throw, rotation invalidates the
 * old passphrase, and consecutive failures lock the credential for a window.
 *
 * Hermetic: ':memory:' system DB, an injected clock. The derivation cost is
 * lowered where the test is about lockout/bucket arithmetic rather than the
 * key itself, so the suite stays fast without weakening what is asserted.
 */
import { describe, expect, it } from 'vitest';
import { createUserCredentialStore, openDatabase } from '../../src/stores/db.js';
import type { UserCredentialStore } from '../../src/stores/types.js';
import {
  DEFAULT_LOCK_MS,
  DEFAULT_MAX_ATTEMPTS,
  SCRYPT_PARAMS,
  createCredentialManager,
} from '../../src/users/credentials.js';
import type { ScryptParams } from '../../src/users/credentials.js';

/** Cheap-but-shaped params: same fields, ~1000× less work than the default. */
const FAST = { N: 1024, r: 8, p: 1, keylen: 32 } as const;

// The option is typed as the real params SHAPE, not as `typeof FAST`: pinning it
// to one literal object made the harness reject any other cost, which is exactly
// what a timing test needs to pass in.
function harness(options: { now?: () => number; params?: ScryptParams } = {}) {
  const handle = openDatabase(':memory:');
  const store: UserCredentialStore = createUserCredentialStore(handle);
  const credentials = createCredentialManager(store, {
    now: options.now,
    params: options.params,
  });
  return { handle, store, credentials };
}

function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

describe('M20-B S2a credentials (scrypt, timing-safe verify)', () => {
  it('stores salt + derived key + params, and never the passphrase', async () => {
    const { store, credentials } = harness({ now: () => 4_200 });
    const passphrase = 'correct horse battery staple';
    expectOk(await credentials.create('alice', passphrase));

    const row = store.findByUserId('alice');
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.salt).toMatch(/^[0-9a-f]{32}$/); // 16 random bytes
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/); // 32-byte derived key
    expect(JSON.parse(row.params)).toEqual(SCRYPT_PARAMS);
    expect(row.createdAt).toBe(4_200);
    expect(row.updatedAt).toBe(4_200);
    expect(row.failedAttempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
    // The stored row is the whole at-rest surface: no passphrase, no plaintext,
    // no reversible digest of the passphrase.
    expect(JSON.stringify(row)).not.toContain('horse');
    expect(row.hash).not.toBe(row.salt);

    // The default parameters are documented and OWASP-aligned: N = 2^17.
    expect(SCRYPT_PARAMS.N).toBe(131_072);
    expect(SCRYPT_PARAMS.keylen).toBe(32);
    // The lockout policy mirrors the pairing spine.
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
    expect(DEFAULT_LOCK_MS).toBe(5 * 60_000);
  });

  it('accepts the right passphrase and refuses a wrong one as a typed result', async () => {
    const { credentials } = harness({ params: FAST });
    expectOk(await credentials.create('alice', 'open sesame'));

    expect(await credentials.verify('alice', 'open sesame')).toEqual({ ok: true });
    expect(await credentials.verify('alice', 'open sesamf')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    // A user with no credential is a refusal, never an exception.
    expect(await credentials.verify('bob', 'open sesame')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    // Creating twice is refused; an empty passphrase is refused.
    expect(await credentials.create('alice', 'another')).toEqual({
      ok: false,
      reason: 'already_exists',
    });
    expect(await credentials.create('carol', '')).toEqual({
      ok: false,
      reason: 'empty_passphrase',
    });
  });

  it('a malformed or missing passphrase input still yields a refusal, not a throw', async () => {
    const { credentials } = harness({ params: FAST });
    expectOk(await credentials.create('alice', 'open sesame'));
    await expect(
      credentials.verify('alice', undefined as unknown as string),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(credentials.verify('alice', null as unknown as string)).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('gives two users with the same passphrase different salts and keys', async () => {
    const { store, credentials } = harness({ params: FAST });
    expectOk(await credentials.create('alice', 'shared secret'));
    expectOk(await credentials.create('bob', 'shared secret'));

    const alice = store.findByUserId('alice');
    const bob = store.findByUserId('bob');
    expect(alice?.salt).not.toBe(bob?.salt);
    expect(alice?.hash).not.toBe(bob?.hash);
  });

  it('locks after N consecutive failures and unlocks when the window ends', async () => {
    let clock = 10_000;
    const { store, credentials } = harness({
      now: () => clock,
      params: FAST,
    });
    expectOk(await credentials.create('alice', 'open sesame'));

    for (let attempt = 0; attempt < DEFAULT_MAX_ATTEMPTS - 1; attempt += 1) {
      expect(await credentials.verify('alice', 'nope')).toEqual({
        ok: false,
        reason: 'invalid',
      });
      expect(store.findByUserId('alice')?.lockedUntil).toBeNull();
    }

    // The Nth consecutive failure locks: the bucket resets and a window opens.
    expect(await credentials.verify('alice', 'nope')).toEqual({ ok: false, reason: 'invalid' });
    expect(store.findByUserId('alice')?.lockedUntil).toBe(10_000 + DEFAULT_LOCK_MS);

    // While locked, even the CORRECT passphrase is refused, with the unlock instant.
    expect(await credentials.verify('alice', 'open sesame')).toEqual({
      ok: false,
      reason: 'locked',
      lockedUntil: 10_000 + DEFAULT_LOCK_MS,
    });

    // The window passing unlocks, and the failure bucket starts fresh.
    clock = 10_000 + DEFAULT_LOCK_MS;
    expect(await credentials.verify('alice', 'open sesame')).toEqual({ ok: true });
    expect(store.findByUserId('alice')?.lockedUntil).toBeNull();
    expect(store.findByUserId('alice')?.failedAttempts).toBe(0);
  });

  it('a success clears the failure bucket before it can lock', async () => {
    const { store, credentials } = harness({ params: FAST });
    expectOk(await credentials.create('alice', 'open sesame'));

    expect((await credentials.verify('alice', 'nope')).ok).toBe(false);
    expect((await credentials.verify('alice', 'nope')).ok).toBe(false);
    expect(store.findByUserId('alice')?.failedAttempts).toBe(2);

    expect(await credentials.verify('alice', 'open sesame')).toEqual({ ok: true });
    // Back to zero, so the next wrong passphrase is not the third consecutive one.
    expect(await credentials.verify('alice', 'nope')).toEqual({ ok: false, reason: 'invalid' });
    expect(store.findByUserId('alice')?.lockedUntil).toBeNull();
  });

  it('rotation re-salts the credential and invalidates the old passphrase', async () => {
    let clock = 1_000;
    const { store, credentials } = harness({ now: () => clock, params: FAST });
    expectOk(await credentials.create('alice', 'old one'));
    const before = store.findByUserId('alice');

    clock = 2_000;
    expectOk(await credentials.rotate('alice', 'new one'));
    const after = store.findByUserId('alice');

    expect(after?.salt).not.toBe(before?.salt);
    expect(after?.hash).not.toBe(before?.hash);
    // Rotation is not a new credential: the creation instant survives.
    expect(after?.createdAt).toBe(1_000);
    expect(after?.updatedAt).toBe(2_000);

    expect(await credentials.verify('alice', 'old one')).toEqual({ ok: false, reason: 'invalid' });
    expect(await credentials.verify('alice', 'new one')).toEqual({ ok: true });
  });

  it('refuses to rotate what does not exist, or to an empty passphrase', async () => {
    const { credentials } = harness({ params: FAST });
    expect(await credentials.rotate('ghost', 'anything')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expectOk(await credentials.create('alice', 'open sesame'));
    expect(await credentials.rotate('alice', '')).toEqual({
      ok: false,
      reason: 'empty_passphrase',
    });
    expect(await credentials.verify('alice', 'open sesame')).toEqual({ ok: true });
  });

  it('a tampered credential row refuses instead of throwing (or allocating)', async () => {
    const { store, credentials } = harness({ params: FAST });
    const base = {
      userId: 'alice',
      salt: 'ab'.repeat(16),
      hash: 'cd'.repeat(32),
      params: JSON.stringify(FAST),
      failedAttempts: 0,
      lockedUntil: null,
      createdAt: 1,
      updatedAt: 1,
    };

    for (const tampered of [
      { ...base, params: 'not json' },
      { ...base, params: JSON.stringify({ ...FAST, N: 1_000 }) }, // not a power of two
      { ...base, params: JSON.stringify({ ...FAST, N: 1 << 30 }) }, // absurd memory cost
      { ...base, params: JSON.stringify({ keylen: 32 }) }, // missing fields
      { ...base, hash: 'cd' }, // key of the wrong length
      { ...base, salt: 'ab' }, // salt of the wrong length
    ]) {
      store.upsert(tampered);
      await expect(credentials.verify('alice', 'open sesame')).resolves.toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
  });
});

describe('an absent user costs the same as a wrong passphrase (timing parity)', () => {
  // Coarse by design, and deliberately so: what it catches is the branch
  // returning in MICROseconds while a real verification pays a full derivation,
  // which is a ratio of ~0 and well clear of scheduler noise. N=2^15 keeps each
  // derivation ~tens of ms so two of them stay cheap for the suite.
  const COSTLY = { N: 32768, r: 8, p: 1, keylen: 32 } as const;

  it('spends a derivation on an absent user rather than returning immediately', async () => {
    const { credentials } = harness({ params: COSTLY });
    await credentials.create('alice', 'correct horse battery staple');

    // WARM the derivation path first. The FIRST scrypt call in a worker pays
    // extra (module init, allocator growth, CPU frequency ramp), so measuring
    // the wrong-passphrase call cold against the absent-user call warm compares
    // the scheduler rather than the code — this test failed on a loaded CI
    // runner with absent 102ms vs a cold wrong 211ms, which is noise, not a
    // parity break. Both measured calls are now warm and equal in cost.
    await credentials.verify('nobody', 'warmup');

    const t0 = process.hrtime.bigint();
    const wrong = await credentials.verify('alice', 'wrong passphrase');
    const t1 = process.hrtime.bigint();
    const absent = await credentials.verify('nobody', 'wrong passphrase');
    const t2 = process.hrtime.bigint();

    // The reasons stay distinguishable in the RESULT (the route maps them to one
    // uniform 401 body) — it is only the TIME that must not differ.
    expect(wrong).toEqual({ ok: false, reason: 'invalid' });
    expect(absent).toEqual({ ok: false, reason: 'not_found' });

    const ms = (a: bigint, b: bigint): number => Number(b - a) / 1e6;
    const wrongMs = ms(t0, t1);
    const absentMs = ms(t1, t2);
    // The regression this catches is the branch returning in MICROseconds. An
    // absolute floor states exactly that, and survives a noisy runner; the
    // ratio keeps the two paths tied to each other without demanding equality.
    expect(absentMs).toBeGreaterThan(1);
    expect(absentMs).toBeGreaterThan(wrongMs * 0.25);
  });
});
