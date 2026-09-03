/**
 * Session manager — opaque 256-bit tokens, hashed at rest, origin-bound.
 *
 * Security semantics (M0 spine):
 *  - Tokens are `crypto.randomBytes(32)` (256-bit) hex; only the SHA-256 hex
 *    is persisted (`sessions.token_hash`). The raw token crosses exactly one
 *    boundary: the response of the pairing exchange.
 *  - Sessions are bound to (kind, origin). validate() rejects a revoked,
 *    expired, or unknown session and any origin mismatch.
 *  - `touch` bumps last_seen_at; `revoke` is immediate.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { SessionStore } from '../stores/types.js';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionOptions {
  /** Session lifetime (default 30 days). */
  ttlMs?: number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface SessionInfo {
  id: number;
  kind: string;
  origin: string;
  createdAt: number;
  expiresAt: number;
}

export type SessionValidationResult =
  | { ok: true; session: SessionInfo }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'origin_mismatch' };

export interface SessionManager {
  create(kind: string, origin: string): Promise<{ token: string; expiresAt: number }>;
  validate(token: string, origin: string): Promise<SessionValidationResult>;
  /** Bump last_seen_at when the token is live; false otherwise. */
  touch(token: string): Promise<boolean>;
  /** Revoke immediately; false when the token is unknown. */
  revoke(token: string): Promise<boolean>;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSessionManager(store: SessionStore, options: SessionOptions = {}): SessionManager {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  return {
    async create(kind: string, origin: string): Promise<{ token: string; expiresAt: number }> {
      const token = randomBytes(32).toString('hex');
      const createdAt = now();
      const expiresAt = createdAt + ttlMs;
      store.insert(tokenHash(token), kind, origin, createdAt, expiresAt, createdAt);
      return { token, expiresAt };
    },

    async validate(token: string, origin: string): Promise<SessionValidationResult> {
      const row = store.findByTokenHash(tokenHash(String(token)));
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.revokedAt !== null) return { ok: false, reason: 'revoked' };
      if (row.expiresAt <= now()) return { ok: false, reason: 'expired' };
      if (row.origin !== origin) return { ok: false, reason: 'origin_mismatch' };
      return {
        ok: true,
        session: {
          id: row.id,
          kind: row.kind,
          origin: row.origin,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        },
      };
    },

    async touch(token: string): Promise<boolean> {
      const row = store.findByTokenHash(tokenHash(String(token)));
      if (!row || row.revokedAt !== null || row.expiresAt <= now()) return false;
      store.touch(row.id, now());
      return true;
    },

    async revoke(token: string): Promise<boolean> {
      const row = store.findByTokenHash(tokenHash(String(token)));
      if (!row) return false;
      store.revoke(row.id, now());
      return true;
    },
  };
}
