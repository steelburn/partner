/**
 * Session manager — opaque 256-bit tokens, hashed at rest, origin-bound.
 *
 * Security semantics (M0 spine, widened by M20-B S3):
 *  - Tokens are `crypto.randomBytes(32)` (256-bit) hex; only the SHA-256 hex
 *    is persisted (`sessions.token_hash`). The raw token crosses exactly one
 *    boundary: the response of the pairing exchange (or of a rotation).
 *  - Sessions are bound to (kind, origin). validate() rejects a revoked,
 *    expired, or unknown session and any origin mismatch.
 *  - `touch` bumps last_seen_at; `revoke` is immediate.
 *  - M20-B S3 adds the client class / device identity, `refresh` (push the
 *    expiry out) and `rotate` (replace the token in place, keeping the device
 *    row). A rotated-out token is NOT revoked — it is gone: replacing the
 *    hash leaves nothing to resolve, so the next request presenting it fails
 *    as `not_found`. `revoked` stays reserved for a row that is kept and
 *    marked, which is the case when a device is signed out rather than
 *    re-keyed.
 *  - M20-B S5 adds the device registry on top of the same rows:
 *    `listDevices` / `revokeDeviceById` / `revokeAllDevices`. These are the
 *    ONLY reader of session rows for the /v1/devices routes, deliberately:
 *    the owner scope ("another user's device id is not found, not forbidden")
 *    is decided in ONE place here instead of being re-derived per route, and
 *    every read is PROJECTED through `DeviceRecord`, a type with no
 *    `tokenHash` field, so a credential hash cannot reach a response body by
 *    adding a field at a route.
 */
import { createHash, randomBytes } from 'node:crypto';
import { isClientClass } from './capabilities.js';
import type { SessionRow, SessionStore } from '../stores/types.js';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionOptions {
  /** Session lifetime (default 30 days). */
  ttlMs?: number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

/**
 * What a session is created as. Every field but `kind`/`origin` is optional:
 * a legacy pairing passes neither, which yields a `desktop` session that
 * belongs to no user yet (M20-B §2a — pairing enrolls a device; only a
 * user-authentication event may name one).
 */
export interface SessionCreateInput {
  kind: string;
  origin: string;
  /** 'desktop' (default) | 'mobile' | 'extension' — the S4 client class. */
  clientClass?: string;
  deviceLabel?: string | null;
  platform?: string | null;
  /** The acting user; null/absent = a session that predates the auth lane. */
  userId?: string | null;
}

export interface CreatedSession {
  token: string;
  expiresAt: number;
}

export interface SessionInfo {
  id: number;
  kind: string;
  origin: string;
  /** The acting user, or null for a session that predates the auth lane. */
  userId: string | null;
  /** Client class as stored — the S4 capability envelope reads this. */
  clientClass: string;
  deviceLabel: string | null;
  /** Platform tag as stored ('ios', 'win32', 'chrome-extension'); null = none. */
  platform: string | null;
  createdAt: number;
  expiresAt: number;
}

export type SessionValidationResult =
  | { ok: true; session: SessionInfo }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'origin_mismatch' };

/**
 * One row of the M20-B S5 device registry.
 *
 * Deliberately NOT a `SessionRow`: `tokenHash` is absent from the type, so a
 * device list cannot leak a credential hash by adding a field at the route —
 * the every-read-is-projected rule has to hold at the type level to be worth
 * anything. `revokedAt` non-null are KEPT rows: a revoked device stays in its
 * owner's list (that is how a user sees what was signed out) while its token
 * stops resolving at the next request.
 */
export interface DeviceRecord {
  id: number;
  /** 'desktop' | 'mobile' | 'extension' — the S4 capability dimension. */
  clientClass: string;
  deviceLabel: string | null;
  platform: string | null;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

/** What `revokeAllDevices` did, so the response states it instead of implying it. */
export interface DeviceRevokeAllResult {
  /** Rows this call actually revoked (already-revoked rows are not counted). */
  revoked: number;
  /**
   * True when the calling session's own device was among them. Always true
   * today — revoke-all INCLUDES the caller — and reported rather than assumed,
   * because a client that silently locks itself out must be told (see the
   * route comment in http/server.ts).
   */
  currentSessionRevoked: boolean;
}

/** Outcome of a single-device revoke; null = not the caller's device. */
export interface DeviceRevokeResult {
  /** True when the row was already revoked: the call is idempotent, not an error. */
  alreadyRevoked: boolean;
}

export interface SessionManager {
  create(input: SessionCreateInput): Promise<CreatedSession>;
  validate(token: string, origin: string): Promise<SessionValidationResult>;
  /** Bump last_seen_at when the token is live; false otherwise. */
  touch(token: string): Promise<boolean>;
  /** Revoke immediately; false when the token is unknown. */
  revoke(token: string): Promise<boolean>;
  /**
   * Extend a live session's expiry by the manager TTL without changing what
   * it identifies (same row, token, user, class). Null when the token is
   * unknown, revoked or already expired.
   */
  refresh(token: string): Promise<{ expiresAt: number } | null>;
  /**
   * Replace a live session's token IN PLACE: the device row survives (id,
   * user, class, label unchanged, `rotated_at` stamped) and the presented
   * token is gone at the next request. Null when the token is unknown,
   * revoked or already expired.
   */
  rotate(token: string): Promise<CreatedSession | null>;
  /**
   * The device registry of one caller (M20-B S5), oldest first, projected
   * WITHOUT the token hash.
   *
   * `userId === null` is the transitional pre-auth rule, and it lives HERE so
   * it cannot drift per route: every session in the field today has
   * `user_id` NULL because the sign-in route does not exist yet, so a
   * user-scoped read would list NOTHING on every install that exists. On an
   * install with no users at all the single-user core IS the whole core, so
   * the device list is every row. `null` is "no user", never "any user": a
   * caller that NAMES a user is answered from that user's rows only and can
   * never fall back to the whole table. The authentication lane removes the
   * branch (and `SessionStore.listAll` with it) once no session can lack a
   * user.
   */
  listDevices(userId: string | null): Promise<DeviceRecord[]>;
  /**
   * Revoke ONE device, scoped to its owner. Null when the id is not in the
   * caller's own registry — another user's device, or no row at all — which
   * the route answers as 404 (a 403 would confirm the row exists and turn an
   * id into a cross-user enumeration oracle). Idempotent: an already-revoked
   * (or concurrently revoked) row is a success with `alreadyRevoked: true`,
   * not a 404.
   */
  revokeDeviceById(id: number, userId: string | null): Promise<DeviceRevokeResult | null>;
  /**
   * Revoke EVERY device of one caller, the calling session included, and
   * report both what was killed and whether the caller's own device was in
   * that set. Used by "sign out everywhere" — the panic action for a leaked
   * bearer — so leaving the caller's own (possibly leaked) session alive would
   * defeat the point; `currentSessionRevoked` is what lets the client say
   * "pair again" instead of leaving the user to discover it on the next call.
   */
  revokeAllDevices(
    userId: string | null,
    currentSessionId: number,
  ): Promise<DeviceRevokeAllResult>;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSessionManager(store: SessionStore, options: SessionOptions = {}): SessionManager {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  /** The live row behind a token, or undefined (unknown / revoked / expired). */
  function liveRow(token: string): SessionRow | undefined {
    const row = store.findByTokenHash(tokenHash(String(token)));
    if (!row || row.revokedAt !== null || row.expiresAt <= now()) return undefined;
    return row;
  }

  /**
   * The rows one caller's device read may see — the ONE place the transitional
   * user-less rule lives. A named user reads `listByUser`; a session with NO
   * user reads only OTHER user-less rows, never a named user's.
   *
   * Scoped rather than unscoped on purpose: the previous `SELECT … FROM sessions`
   * meant a legacy (pre-auth) session could read and revoke a NAMED user's
   * devices once users exist — and since every session in the field is user-less
   * today, that wide branch was the DEFAULT, not an edge case.
   */
  function deviceRows(userId: string | null): SessionRow[] {
    return userId === null ? store.listUnscoped() : store.listByUser(userId);
  }

  /** Project a row for the wire: the token hash never crosses this boundary. */
  function toDevice(row: SessionRow): DeviceRecord {
    return {
      id: row.id,
      clientClass: row.clientClass,
      deviceLabel: row.deviceLabel,
      platform: row.platform,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      revokedAt: row.revokedAt,
    };
  }

  return {
    async create(input: SessionCreateInput): Promise<CreatedSession> {
      const clientClass = input.clientClass ?? 'desktop';
      if (!isClientClass(clientClass)) {
        // Fail closed at the mint: a mistyped class would make every
        // capability check refuse this session (S4 denies unknown classes).
        throw new Error(`invalid_client_class: ${String(clientClass)}`);
      }
      const token = randomBytes(32).toString('hex');
      const createdAt = now();
      const expiresAt = createdAt + ttlMs;
      store.insert(tokenHash(token), input.kind, input.origin, createdAt, expiresAt, createdAt, {
        userId: input.userId ?? null,
        clientClass,
        deviceLabel: input.deviceLabel ?? null,
        platform: input.platform ?? null,
      });
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
          userId: row.userId,
          clientClass: row.clientClass,
          deviceLabel: row.deviceLabel,
          platform: row.platform,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        },
      };
    },

    async touch(token: string): Promise<boolean> {
      const row = liveRow(token);
      if (!row) return false;
      store.touch(row.id, now());
      return true;
    },

    async revoke(token: string): Promise<boolean> {
      const row = store.findByTokenHash(tokenHash(String(token)));
      if (!row) return false;
      store.revoke(row.id, now());
      return true;
    },

    async refresh(token: string): Promise<{ expiresAt: number } | null> {
      const row = liveRow(token);
      if (!row) return null;
      const expiresAt = now() + ttlMs;
      if (!store.extend(row.id, expiresAt)) return null;
      return { expiresAt };
    },

    async rotate(token: string): Promise<CreatedSession | null> {
      const row = liveRow(token);
      if (!row) return null;
      const next = randomBytes(32).toString('hex');
      const expiresAt = now() + ttlMs;
      if (!store.rotate(row.id, tokenHash(next), expiresAt, now())) return null;
      return { token: next, expiresAt };
    },

    async listDevices(userId: string | null): Promise<DeviceRecord[]> {
      return deviceRows(userId).map(toDevice);
    },

    async revokeDeviceById(
      id: number,
      userId: string | null,
    ): Promise<DeviceRevokeResult | null> {
      const owned = deviceRows(userId).find((row) => row.id === id);
      // Not in the caller's own registry: another user's device, or no such
      // row. The route cannot tell those apart, and must not.
      if (owned === undefined) return null;
      if (owned.revokedAt !== null) return { alreadyRevoked: true };
      const at = now();
      if (userId === null) {
        // Scoped to user-less rows, NOT a plain `revoke(id)`: the row was found
        // through `deviceRows(null)` so it is user-less by construction, and the
        // write is scoped to match so a race cannot turn this into revoking a
        // named user's session.
        if (!store.revokeUnscoped(id, at)) return { alreadyRevoked: true };
      } else if (!store.revokeById(id, userId, at)) {
        // Lost the race to a concurrent revoke between the read and the write.
        // The caller's intent is already satisfied, so this stays a success.
        return { alreadyRevoked: true };
      }
      return { alreadyRevoked: false };
    },

    async revokeAllDevices(
      userId: string | null,
      currentSessionId: number,
    ): Promise<DeviceRevokeAllResult> {
      const live = deviceRows(userId).filter((row) => row.revokedAt === null);
      const at = now();
      let revoked: number;
      if (userId === null) {
        // Transitional, same rule and same lifetime as `deviceRows`: there is no
        // user to scope an UPDATE by, so the rows the READ returned — user-less
        // rows only — are revoked one by one.
        for (const row of live) store.revokeUnscoped(row.id, at);
        revoked = live.length;
      } else {
        revoked = store.revokeAllForUser(userId, at);
      }
      // Derived from the set that was live BEFORE the revoke, so the response
      // states what happened rather than what the caller assumes happened.
      return { revoked, currentSessionRevoked: live.some((row) => row.id === currentSessionId) };
    },
  };
}
