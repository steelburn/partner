/**
 * Pairing manager — 6-digit single-use codes, hashed at rest.
 *
 * Security semantics (M0 spine):
 *  - Codes come from a CSPRNG (`crypto.randomInt`); only a KEYED hash of a
 *    code is persisted (`pairings.code_hash`) — HMAC-SHA256 with a
 *    per-process random key, so the 10^6 code space is not offline-enumerable
 *    from the DB and codes die with the process. Plaintext lives in memory
 *    only for the display/dev seam and is never logged or stored.
 *  - Single active code: issuing a new code replaces the previous one.
 *  - Single use: the first successful verify() consumes the row.
 *  - Wrong-code bucketing: each wrong guess increments the active pairing's
 *    `attempts`; at `maxAttempts` the pairing locks for `lockMs`, after which
 *    the bucket resets. Locked/expired/absent are distinct reasons so the
 *    HTTP layer can map them to 429/401.
 */
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import type { PairingStore } from '../stores/types.js';

export interface PairingOptions {
  /** How long an issued code stays valid (default 120s). */
  codeTtlMs?: number;
  /** Wrong guesses before the pairing locks (default 3). */
  maxAttempts?: number;
  /** Lock duration after maxAttempts wrong guesses (default 5 min). */
  lockMs?: number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /**
   * When true, `devCode()` may reveal the active code. This is the M0 demo
   * seam the e2e test drives; production code paths never read it.
   */
  demo?: boolean;
}

export type PairingVerifyResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'locked' | 'invalid' };

export interface PairingManager {
  /** Issue a fresh 6-digit code (replaces any previous pairing). */
  issue(): Promise<string>;
  /**
   * Verify a code. Consumes the pairing on success. Wrong codes increment
   * the attempt bucket and lock the pairing at maxAttempts.
   */
  verify(code: string): Promise<PairingVerifyResult>;
  /** Demo-only seam: the current active code, or null when unavailable. */
  devCode(): Promise<string | null>;
}

/**
 * Unkeyed SHA-256 of a code — retained for negative assertions (proving the
 * stored hash is NOT this offline-reversible digest). Never used for storage.
 */
export function codeHash(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export function createPairingManager(store: PairingStore, options: PairingOptions = {}): PairingManager {
  const codeTtlMs = options.codeTtlMs ?? 120_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const lockMs = options.lockMs ?? 300_000;
  const now = options.now ?? Date.now;
  const demo = options.demo ?? false;

  /** Per-process HMAC key: codes die with the process; DB alone is useless. */
  const codeKey = randomBytes(32);
  const hashCode = (code: string): string =>
    createHmac('sha256', codeKey).update(code, 'utf8').digest('hex');

  /** Plaintext of the most recently issued code — memory only, never logged. */
  let active: { code: string; expiresAt: number } | null = null;

  return {
    async issue(): Promise<string> {
      const issuedAt = now();
      const expiresAt = issuedAt + codeTtlMs;
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      store.removeAll();
      store.insert(hashCode(code), issuedAt, expiresAt);
      active = { code, expiresAt };
      return code;
    },

    async verify(input: string): Promise<PairingVerifyResult> {
      const code = String(input ?? '').trim();
      const at = now();

      const row = store.findByCodeHash(hashCode(code));
      if (row) {
        if (row.lockedUntil !== null && at < row.lockedUntil) {
          return { ok: false, reason: 'locked' };
        }
        if (row.expiresAt <= at) {
          store.removeByCodeHash(row.codeHash);
          active = null;
          return { ok: false, reason: 'expired' };
        }
        // Single use: consume on the first successful verify.
        store.removeByCodeHash(row.codeHash);
        active = null;
        return { ok: true, code };
      }

      // The code did not match the active pairing (wrong guess or a code
      // that was already consumed). Bucket the attempt against the current
      // active pairing so brute force locks, not just wrong rows.
      const current = store.getLatest();
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.lockedUntil !== null && at < current.lockedUntil) {
        return { ok: false, reason: 'locked' };
      }
      if (current.expiresAt <= at) return { ok: false, reason: 'expired' };

      const attempts = current.attempts + 1;
      if (attempts >= maxAttempts) {
        // Lock the pairing; reset the bucket so a fresh code after lockMs
        // starts from zero wrong guesses.
        store.updateAttempts(current.id, 0, at + lockMs);
      } else {
        store.updateAttempts(current.id, attempts, current.lockedUntil);
      }
      return { ok: false, reason: 'invalid' };
    },

    async devCode(): Promise<string | null> {
      if (!demo || !active) return null;
      if (active.expiresAt <= now()) return null;
      // A live (unconsumed) row must still exist for the code.
      const row = store.findByCodeHash(hashCode(active.code));
      if (!row) return null;
      return active.code;
    },
  };
}
