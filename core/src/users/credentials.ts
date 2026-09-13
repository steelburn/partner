/**
 * Per-user passphrase credentials (PLAN-M20-B S2a).
 *
 * The credential primitive for a multi-user core: `node:crypto` **scrypt**
 * over a per-user random salt, with the derived key and the parameters that
 * produced it stored in the system DB (`user_credentials`). It needs no
 * network, no third party and no mail/SMTP — which is why it is the first
 * primitive; a passkey is a later adapter (§2a: WebAuthn needs a recovery
 * story that must be designed, not improvised).
 *
 * Discipline:
 *  - The passphrase is NEVER stored, logged, audited or returned. Only salt +
 *    derived key + params exist at rest, and {@link CredentialManager} returns
 *    decisions (`ok` / a typed `reason`) — never the derived key.
 *  - Comparison is `timingSafeEqual`, and a stored record whose key length is
 *    not the derived length is refused rather than thrown (a wrong-length
 *    buffer makes timingSafeEqual throw — that must not become a 500).
 *  - A wrong passphrase, an unknown user and a locked user are all typed
 *    refusals, so the HTTP layer maps them to 401/423 without try/catch and
 *    without leaking which of the three it was into a stack trace.
 *  - Consecutive failures lock the credential for a window (defaults mirror the
 *    pairing spine: 3 attempts, 5 minutes). A successful verify, a rotation
 *    and an elapsed window all reset the bucket.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { UserCredentialStore } from '../stores/types.js';

/** The scrypt parameters a derived key was produced with. */
export interface ScryptParams {
  /** CPU/memory cost (power of two); 2^17 is the OWASP-aligned minimum. */
  N: number;
  /** Block size. */
  r: number;
  /** Parallelization. */
  p: number;
  /** Derived key length in bytes. */
  keylen: number;
}

/**
 * The parameters new credentials are derived with — **documented on purpose**,
 * and stored per row so raising them later re-hashes only on rotation instead
 * of invalidating every existing credential.
 * N = 2^17 (131072), r = 8, p = 1, keylen = 32: the OWASP Password Storage
 * recommendation for scrypt, i.e. ~128 MiB and ~0.2 s per verification here.
 */
export const SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({
  N: 131_072,
  r: 8,
  p: 1,
  keylen: 32,
});

/**
 * OpenSSL refuses scrypt when `128 * N * r` reaches the limit exactly, so the
 * ceiling must exceed the 128 MiB the parameters above need.
 */
const SCRYPT_MAXMEM = 192 * 1024 * 1024;
/**
 * A fixed throwaway salt used ONLY to spend the same work on an absent user as a
 * real verification would (see `verify`). It guards no secret and is never
 * stored against a credential.
 */
const TIMING_PARITY_SALT = Buffer.alloc(16, 0);
/** Per-user random salt length in bytes. */
export const SALT_BYTES = 16;
/** Consecutive wrong passphrases before the credential locks (pairing spine). */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** How long a locked credential refuses verification (pairing spine). */
export const DEFAULT_LOCK_MS = 5 * 60 * 1000;

export type CredentialVerifyResult =
  | { ok: true }
  /**
   * `not_found` — this user has no credential (no passphrase was ever set);
   * `invalid` — wrong passphrase, or a stored record that cannot be used
   * (unparseable params / wrong-length key). Neither is a server error.
   */
  | { ok: false; reason: 'not_found' | 'invalid' }
  | { ok: false; reason: 'locked'; lockedUntil: number };

export type CredentialCreateResult =
  | { ok: true }
  | { ok: false; reason: 'empty_passphrase' | 'already_exists' };

export type CredentialRotateResult =
  | { ok: true }
  | { ok: false; reason: 'empty_passphrase' | 'not_found' };

export interface CredentialManager {
  /** Set this user's first passphrase. Refuses when one already exists. */
  create(userId: string, passphrase: string): Promise<CredentialCreateResult>;
  /**
   * Prove the passphrase for `userId`. Wrong → typed refusal; consecutive
   * failures lock the credential until `lockedUntil`.
   */
  verify(userId: string, passphrase: string): Promise<CredentialVerifyResult>;
  /**
   * Replace the passphrase with a freshly salted one — the OLD passphrase
   * stops working immediately, and the lockout bucket is cleared. Rotation is
   * the caller's decision (it must be an authenticated, audited act); this
   * module only invalidates the credential. Revoking the user's other
   * sessions on rotation belongs to the session layer.
   */
  rotate(userId: string, newPassphrase: string): Promise<CredentialRotateResult>;
}

export interface CredentialOptions {
  /** Injectable clock (epoch ms). */
  now?: () => number;
  maxAttempts?: number;
  lockMs?: number;
  /** Override the derivation parameters (tests may lower the cost). */
  params?: ScryptParams;
}

function deriveKey(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Strict hex → buffer of exactly `bytes`; null when the text is not that. */
function hexToBuffer(hex: unknown, bytes: number): Buffer | null {
  if (typeof hex !== 'string' || hex.length !== bytes * 2) return null;
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

/** Parse + sanity-check stored params; null when the row cannot be used. */
function parseParams(json: string): ScryptParams | null {
  const positive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const { N, r, p, keylen } = raw;
    if (!positive(N) || !positive(r) || !positive(p) || !positive(keylen)) return null;
    if ((N & (N - 1)) !== 0) return null; // scrypt requires a power of two
    if (keylen > 64) return null;
    // A tampered params row must not be able to make this process allocate
    // gigabytes, so it is bounded by the same ceiling the derivation uses.
    if (128 * N * r >= SCRYPT_MAXMEM) return null;
    return { N, r, p, keylen };
  } catch {
    return null;
  }
}

interface HashedPassphrase {
  saltHex: string;
  hashHex: string;
  params: string;
}

async function hashPassphrase(
  passphrase: string,
  params: ScryptParams,
): Promise<HashedPassphrase> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(passphrase, salt, params);
  return {
    saltHex: salt.toString('hex'),
    hashHex: key.toString('hex'),
    params: JSON.stringify(params),
  };
}

export function createCredentialManager(
  store: UserCredentialStore,
  options: CredentialOptions = {},
): CredentialManager {
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const lockMs = options.lockMs ?? DEFAULT_LOCK_MS;
  const params = options.params ?? SCRYPT_PARAMS;

  return {
    async create(userId: string, passphrase: string): Promise<CredentialCreateResult> {
      const value = String(passphrase);
      if (value === '') return { ok: false, reason: 'empty_passphrase' };
      if (store.findByUserId(userId) !== undefined) {
        return { ok: false, reason: 'already_exists' };
      }
      const at = now();
      const hashed = await hashPassphrase(value, params);
      store.upsert({
        userId,
        salt: hashed.saltHex,
        hash: hashed.hashHex,
        params: hashed.params,
        failedAttempts: 0,
        lockedUntil: null,
        createdAt: at,
        updatedAt: at,
      });
      return { ok: true };
    },

    async verify(userId: string, passphrase: string): Promise<CredentialVerifyResult> {
      const row = store.findByUserId(userId);
      if (row === undefined) {
        // TIMING PARITY, and it is load-bearing: without it this branch returns in
        // microseconds while a known user pays a full scrypt (~0.2 s), so response
        // TIME reveals whether a user id exists. The brief called that "bounded by
        // local-only user creation", but local-only bounds user CREATION — the
        // sign-in route is reached REMOTELY in the multi-user case, which is
        // exactly where enumeration is useful. Burn the same work, discard it.
        // (The route must ALSO return one uniform 401 body for every reason; that
        // half belongs to the sign-in route, not here.)
        await deriveKey(String(passphrase), TIMING_PARITY_SALT, params);
        return { ok: false, reason: 'not_found' };
      }
      const at = now();
      let attempts = row.failedAttempts;
      // An elapsed window is not a lock: the bucket starts fresh, so the next
      // wrong passphrase needs maxAttempts more failures to lock again.
      if (row.lockedUntil !== null && at >= row.lockedUntil) {
        attempts = 0;
        store.setAttempts(userId, 0, null);
      } else if (row.lockedUntil !== null) {
        return { ok: false, reason: 'locked', lockedUntil: row.lockedUntil };
      }

      const storedParams = parseParams(row.params);
      const salt = hexToBuffer(row.salt, SALT_BYTES);
      const expected = storedParams === null ? null : hexToBuffer(row.hash, storedParams.keylen);
      if (storedParams === null || salt === null || expected === null) {
        // The record cannot authenticate anyone; refusing is the safe outcome,
        // and it is a refusal rather than a throw so it cannot become a 500.
        return { ok: false, reason: 'invalid' };
      }

      const derived = await deriveKey(String(passphrase), salt, storedParams);
      const matches = derived.length === expected.length && timingSafeEqual(derived, expected);
      if (!matches) {
        const failures = attempts + 1;
        if (failures >= maxAttempts) {
          store.setAttempts(userId, 0, at + lockMs);
        } else {
          store.setAttempts(userId, failures, null);
        }
        return { ok: false, reason: 'invalid' };
      }
      store.setAttempts(userId, 0, null);
      return { ok: true };
    },

    async rotate(userId: string, newPassphrase: string): Promise<CredentialRotateResult> {
      const value = String(newPassphrase);
      if (value === '') return { ok: false, reason: 'empty_passphrase' };
      const existing = store.findByUserId(userId);
      if (existing === undefined) return { ok: false, reason: 'not_found' };
      const at = now();
      const hashed = await hashPassphrase(value, params);
      store.upsert({
        userId,
        salt: hashed.saltHex,
        hash: hashed.hashHex,
        params: hashed.params,
        // A rotation is a proven-identity act: it clears the lockout bucket.
        failedAttempts: 0,
        lockedUntil: null,
        // The row's creation instant survives; this credential is not new.
        createdAt: existing.createdAt,
        updatedAt: at,
      });
      return { ok: true };
    },
  };
}
