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

// ---------------------------------------------------------------------------
// M1 providers store (PLAN-M1.md). Row profile only — the key NEVER lives in
// this table; it sits in the OS keychain at service `partner`, account
// `provider:<id>` (the row's keyRef is just that account base).
// ---------------------------------------------------------------------------

/** Column projection for the `providers` table (snake_case -> camelCase). */
export interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  /** 'manual' | 'llm-self-service'. */
  source: string;
  /** Full OpenAI-compatible base URL, e.g. https://api.ne1.dev/v1 */
  endpoint: string;
  /** JSON array of model ids reported by the last probe (null = none). */
  defaultModels: string | null;
  /** 0 | 1. */
  enabled: number;
  /** Optional per-session spend cap in USD cents (null = off). */
  budgetCents: number | null;
  /** Keychain account base; the secret sits at service 'partner', account `provider:<id>`. */
  keyRef: string;
  /** JSON {ok,latencyMs,error,models,checkedAt} of the last probe (null = never probed). */
  lastHealth: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Writable fields (identity + timestamps excluded); a write always stamps updatedAt. */
export type ProviderRowPatch = Partial<
  Pick<
    ProviderRow,
    | 'name'
    | 'kind'
    | 'source'
    | 'endpoint'
    | 'defaultModels'
    | 'enabled'
    | 'budgetCents'
    | 'keyRef'
    | 'lastHealth'
  >
> & { updatedAt: number };

export interface ProviderStore {
  insert(row: ProviderRow): void;
  findById(id: string): ProviderRow | undefined;
  /** All rows in creation order (oldest first) — resolution picks the first enabled. */
  list(): ProviderRow[];
  /** Apply a patch, always stamping updated_at; no-op-safe when the row is absent. */
  update(id: string, patch: ProviderRowPatch): void;
  remove(id: string): void;
}

// ---------------------------------------------------------------------------
// M2 tool-broker tables (PLAN-M2.md — additive schema v3). Row profile only;
// managers (broker/*, files/*) own validation, grants, and filesystem rules.
// ---------------------------------------------------------------------------

/** `project_roots` row — the ONLY filesystem surface the broker can see. */
export interface ProjectRootRow {
  id: string;
  label: string;
  /** Canonical absolute path (symlinks resolved at add time). */
  path: string;
  /** 0 | 1. Write tools refuse read-only roots. */
  readOnly: number;
  addedAt: number;
}

export interface ProjectRootStore {
  insert(row: ProjectRootRow): void;
  findById(id: string): ProjectRootRow | undefined;
  /** Canonical path uniqueness (UNIQUE constraint); undefined when absent. */
  findByPath(path: string): ProjectRootRow | undefined;
  /** Creation order (oldest first). */
  list(): ProjectRootRow[];
  remove(id: string): void;
}

/** `grants` row — (tool, project) allow-list; expiry optional. */
export interface GrantRow {
  id: string;
  toolId: string;
  projectId: string;
  /** 'user' in v1 (persona/skill arrive with M3/M8). */
  source: string;
  createdAt: number;
  /** Epoch ms or null (never expires). */
  expiresAt: number | null;
  note: string | null;
}

export interface GrantStore {
  insert(row: GrantRow): void;
  findById(id: string): GrantRow | undefined;
  /** ALL rows including expired ones (manager filters at read). */
  list(): GrantRow[];
  remove(id: string): void;
}

/** `pending_tools` row — an approval-queue entry (open until decided). */
export interface PendingToolRow {
  id: string;
  toolId: string;
  projectId: string | null;
  /** JSON string of the original (redaction-safe by construction at the broker). */
  params: string;
  /** ToolRisk, denormalized so the queue renders without a manifest lookup. */
  risk: string;
  requestedBy: string;
  createdAt: number;
  decidedAt: number | null;
  /** 'approve' | 'deny' | null while open. */
  decision: string | null;
  decidedBy: string | null;
}

export interface PendingToolStore {
  insert(row: PendingToolRow): void;
  findById(id: string): PendingToolRow | undefined;
  /** Open rows only (decided_at IS NULL), oldest first — the approval queue. */
  listOpen(): PendingToolRow[];
  /** Close a row with a decision. */
  updateDecision(id: string, decidedAt: number, decision: string, decidedBy: string): void;
}

/** `file_proposals` row — a files.edit write-preview awaiting apply/discard. */
export interface FileProposalRow {
  id: string;
  projectId: string;
  /** Relative path inside the root (POSIX form). */
  path: string;
  /** Original file mtime captured at proposal time (epoch ms). */
  originalMtime: number;
  originalContent: string | null;
  proposedContent: string;
  createdAt: number;
  appliedAt: number | null;
  discardedAt: number | null;
}

export interface FileProposalStore {
  insert(row: FileProposalRow): void;
  findById(id: string): FileProposalRow | undefined;
  /** Open rows (neither applied nor discarded) newest first — pending diffs. */
  listOpen(): FileProposalRow[];
  markApplied(id: string, at: number): void;
  markDiscarded(id: string, at: number): void;
}
