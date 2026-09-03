/**
 * Row + store interface contracts for the M0 SQLite tables.
 *
 * Factories live in `db.ts`; these interfaces keep the row stores small and
 * typed with NO business logic — managers (pairing/session) and services
 * (audit) own the semantics. All timestamps are epoch milliseconds.
 *
 * Stores never read the clock: every write takes explicit timestamps so
 * tests can inject `now()`.
 */

export interface PairingRow {
  id: number;
  /** SHA-256 hex of the plaintext pairing code. Plaintext is never stored. */
  codeHash: string;
  expiresAt: number;
  /** Consecutive wrong-code attempts against this pairing. */
  attempts: number;
  /** When set, verify() must refuse with `locked` until this instant. */
  lockedUntil: number | null;
  createdAt: number;
}

export interface PairingStore {
  /** Remove every pairing row (single-active-code model). */
  removeAll(): void;
  /** Insert a fresh pairing; attempts = 0, lockedUntil = null. */
  insert(codeHash: string, createdAt: number, expiresAt: number): number;
  findByCodeHash(codeHash: string): PairingRow | undefined;
  /** The most recently issued pairing (the one a guess is bucketed against). */
  getLatest(): PairingRow | undefined;
  /** Rewrite the wrong-code attempt bucket (0 + lockedUntil after a lock). */
  updateAttempts(id: number, attempts: number, lockedUntil: number | null): void;
  /** Consume a pairing (single use). */
  removeByCodeHash(codeHash: string): void;
}

export interface SessionRow {
  id: number;
  /** SHA-256 hex of the session token. The raw token is never stored. */
  tokenHash: string;
  kind: string;
  /** Binding origin (loopback Host header); validate() enforces a match. */
  origin: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

export interface SessionStore {
  insert(
    tokenHash: string,
    kind: string,
    origin: string,
    createdAt: number,
    expiresAt: number,
    lastSeenAt: number,
  ): number;
  findByTokenHash(tokenHash: string): SessionRow | undefined;
  touch(id: number, at: number): void;
  revoke(id: number, at: number): void;
}

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  target: string;
  /** Redacted JSON string — never raw secrets (see services/redaction). */
  details: string;
  createdAt: number;
}

export interface AuditStore {
  add(actor: string, action: string, target: string, details: string, createdAt: number): number;
  /** Newest first, capped at limit. */
  list(limit: number): AuditRow[];
}

export interface SettingsRow {
  key: string;
  value: string | null;
  updatedAt: number;
}

export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string, updatedAt: number): void;
}
