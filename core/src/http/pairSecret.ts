/**
 * Networked-pairing secret manager (PLAN-M20-B S7) — 256-bit single-use QR
 * secrets, keyed-HMAC at rest.
 *
 * Mirrors `core/src/http/pairing.ts` (the 6-digit loopback manager), with the
 * entropy raised to the level a network path needs:
 *  - The secret is 32 CSPRNG bytes (`crypto.randomBytes`) carried as
 *    base64url (43 chars, unpadded) — nothing to guess, unlike a 10^6 code
 *    space, so the attempt lock here is defence in depth against a buggy or
 *    hostile client, not the load-bearing control.
 *  - Only a KEYED hash is stored: HMAC-SHA256 with a PER-PROCESS random key,
 *    so a captured store is useless offline and the record dies with the
 *    process. The plaintext exists only in the value `issue()` returns (the
 *    caller puts it in the QR payload) — never logged, never persisted.
 *  - Single active secret: issuing replaces any previous one.
 *  - Single use: the first successful verify() consumes the record.
 *  - Wrong guesses bucket against the active secret; at `maxAttempts` the
 *    manager locks for `lockMs` and then resets the bucket, so a fresh scan
 *    after the lock still pairs. `locked` / `expired` / `not_found` /
 *    `invalid` stay distinct so the HTTP layer can map them (429/401/404).
 *  - Fail closed: an empty, malformed or non-string presentation is HASHED and
 *    counted as a wrong guess — never trimmed into validity, never accepted,
 *    never thrown.
 *
 * The default store is IN MEMORY: a QR secret is valid for seconds and is
 * rendered by the process that issued it, so a restart legitimately
 * invalidates it (unlike the 6-digit code, which pairing.ts persists so a
 * restart does not strand a user mid-pair). `PairSecretStore` is injectable so
 * the at-rest property is observable in tests and so S7 may persist it if it
 * chooses.
 */
import { createHmac, randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 120_000; // short: a scan happens in seconds
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LOCK_MS = 300_000;
const SECRET_BYTES = 32; // 256 bits
const SECRET_CHARS = 43; // 32 bytes as base64url, no padding

export interface PairSecretRow {
  id: number;
  /** HMAC-SHA256 hex of the secret. The raw secret is never stored. */
  secretHash: string;
  createdAt: number;
  expiresAt: number;
  /** Wrong guesses since the last reset. */
  attempts: number;
  /** Epoch ms until which the secret is locked, else null. */
  lockedUntil: number | null;
}

/** Storage seam. The names mirror `PairingStore` method-for-method. */
export interface PairSecretStore {
  /** Remove every record (single-active-secret model). */
  removeAll(): void;
  /** Insert a fresh secret; attempts = 0, lockedUntil = null. */
  insert(secretHash: string, createdAt: number, expiresAt: number): number;
  findBySecretHash(secretHash: string): PairSecretRow | undefined;
  /** The most recently issued secret (the one a guess is bucketed against). */
  getLatest(): PairSecretRow | undefined;
  /** Rewrite the wrong-guess bucket (0 + lockedUntil after a lock). */
  updateAttempts(id: number, attempts: number, lockedUntil: number | null): void;
  /** Consume a secret (single use). */
  removeBySecretHash(secretHash: string): void;
}

/** Process-local store: correct for a secret that must not outlive the process. */
export function createMemoryPairSecretStore(): PairSecretStore {
  let rows: PairSecretRow[] = [];
  let nextId = 1;
  return {
    removeAll(): void {
      rows = [];
    },
    insert(secretHash: string, createdAt: number, expiresAt: number): number {
      const row: PairSecretRow = {
        id: nextId,
        secretHash,
        createdAt,
        expiresAt,
        attempts: 0,
        lockedUntil: null,
      };
      nextId += 1;
      rows.push(row);
      return row.id;
    },
    findBySecretHash(secretHash: string): PairSecretRow | undefined {
      return rows.find((row) => row.secretHash === secretHash);
    },
    getLatest(): PairSecretRow | undefined {
      return rows.length === 0 ? undefined : rows[rows.length - 1];
    },
    updateAttempts(id: number, attempts: number, lockedUntil: number | null): void {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return;
      row.attempts = attempts;
      row.lockedUntil = lockedUntil;
    },
    removeBySecretHash(secretHash: string): void {
      rows = rows.filter((row) => row.secretHash !== secretHash);
    },
  };
}

export interface PairSecretOptions {
  /** How long an issued secret stays valid (default 120s). */
  ttlMs?: number;
  /** Wrong guesses before the secret locks (default 3). */
  maxAttempts?: number;
  /** Lock duration after maxAttempts wrong guesses (default 5 min). */
  lockMs?: number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /** Store to use; defaults to a fresh in-memory store. */
  store?: PairSecretStore;
}

export type PairSecretVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'expired' | 'locked' | 'invalid' };

export interface PairSecretManager {
  /** Issue a fresh secret (replaces any previous one). */
  issue(): Promise<string>;
  /** Verify a presented secret; consumes it on success. */
  verify(input: string): Promise<PairSecretVerifyResult>;
}

/**
 * Shape guard: a canonical 32-byte base64url secret. The re-encode check
 * rejects strings that decode but carry non-zero padding bits, so a value
 * accepted here is exactly what `issue()` produces.
 */
export function isPairSecret(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== SECRET_CHARS) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.byteLength === SECRET_BYTES && bytes.toString('base64url') === value;
}

export function createPairSecretManager(options: PairSecretOptions = {}): PairSecretManager {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const lockMs = options.lockMs ?? DEFAULT_LOCK_MS;
  const now = options.now ?? Date.now;
  const store = options.store ?? createMemoryPairSecretStore();

  /** Per-process HMAC key: the record dies with the process. */
  const secretKey = randomBytes(32);
  const hashOf = (value: string): string =>
    createHmac('sha256', secretKey).update(value, 'utf8').digest('hex');

  return {
    async issue(): Promise<string> {
      const issuedAt = now();
      const expiresAt = issuedAt + ttlMs;
      const secret = randomBytes(SECRET_BYTES).toString('base64url');
      store.removeAll();
      store.insert(hashOf(secret), issuedAt, expiresAt);
      return secret;
    },

    async verify(input: string): Promise<PairSecretVerifyResult> {
      // No trimming: a secret is machine-presented, so a padded one is a
      // wrong secret rather than a formatting quirk to forgive.
      const secret = String(input ?? '');
      const at = now();

      const row = store.findBySecretHash(hashOf(secret));
      if (row) {
        if (row.lockedUntil !== null && at < row.lockedUntil) {
          return { ok: false, reason: 'locked' };
        }
        if (row.expiresAt <= at) {
          store.removeBySecretHash(row.secretHash);
          return { ok: false, reason: 'expired' };
        }
        // Single use: consume on the first successful verify.
        store.removeBySecretHash(row.secretHash);
        return { ok: true };
      }

      // The presented secret did not match the active one (wrong guess, a
      // secret that was already consumed, or unusable input). Bucket the
      // attempt against the active secret so brute force locks.
      const current = store.getLatest();
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.lockedUntil !== null && at < current.lockedUntil) {
        return { ok: false, reason: 'locked' };
      }
      if (current.expiresAt <= at) return { ok: false, reason: 'expired' };

      const attempts = current.attempts + 1;
      if (attempts >= maxAttempts) {
        // Lock it; reset the bucket so the post-lock attempt starts at zero.
        store.updateAttempts(current.id, 0, at + lockMs);
      } else {
        store.updateAttempts(current.id, attempts, current.lockedUntil);
      }
      return { ok: false, reason: 'invalid' };
    },
  };
}
