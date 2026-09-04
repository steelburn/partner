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

// ---------------------------------------------------------------------------
// M3 persona/conversation tables (PLAN-M3.md — additive schema v4). Row
// profile only; the persona manager owns validation, defaults, the single
// isDefault invariant, pause state and the seed. JSON-ish columns (task
// classes, requireHumanFor, autoScopes, memory flags) are stored as JSON
// strings exactly like providers.default_models — the manager serializes and
// parses them, the store never interprets them.
// ---------------------------------------------------------------------------

/** `personas` row — flattened persona; nested wire fields are JSON strings. */
export interface PersonaRow {
  id: string;
  name: string;
  tagline: string | null;
  avatar: string | null;
  colorTheme: string | null;
  /** character.voice */
  voice: string;
  /** character.language */
  language: string;
  /** character.systemPrompt */
  systemPrompt: string;
  /** character.temperature */
  temperature: number;
  /** model.taskClasses as JSON object (known task-class keys only). */
  taskClasses: string | null;
  /** model.fallback */
  fallbackModel: string | null;
  /** model.providerId */
  providerId: string | null;
  /** independence.level: 'assist'|'suggest'|'auto'|'autonomous'. */
  independenceLevel: string;
  /** independence.requireHumanFor as JSON array of 'high'|'medium'. */
  requireHuman: string | null;
  /** independence.autoScopes as JSON string array (stored now, enforced later). */
  autoScopes: string | null;
  /** memory flags as JSON {userProfile, episodes}. */
  memoryFlags: string | null;
  /** 0 | 1. At most one row has 1 (single-default invariant, manager-owned). */
  isDefault: number;
  /** 0 | 1. Pause = kill switch: chat/tools refuse a paused persona (423). */
  paused: number;
  createdAt: number;
  updatedAt: number;
}

/** Writable fields; a write always stamps updatedAt (mirrors ProviderRowPatch). */
export type PersonaRowPatch = Partial<
  Pick<
    PersonaRow,
    | 'name'
    | 'tagline'
    | 'avatar'
    | 'colorTheme'
    | 'voice'
    | 'language'
    | 'systemPrompt'
    | 'temperature'
    | 'taskClasses'
    | 'fallbackModel'
    | 'providerId'
    | 'independenceLevel'
    | 'requireHuman'
    | 'autoScopes'
    | 'memoryFlags'
    | 'isDefault'
    | 'paused'
  >
> & { updatedAt: number };

export interface PersonaStore {
  insert(row: PersonaRow): void;
  findById(id: string): PersonaRow | undefined;
  /** Creation order (oldest first) — the manager owns default/ordering logic. */
  list(): PersonaRow[];
  /** Apply a whitelisted patch, always stamping updated_at. */
  update(id: string, patch: PersonaRowPatch): void;
  remove(id: string): void;
  /** Total rows (seed + default invariants). */
  count(): number;
}

/** `conversations` row — multi-turn chat bound to an optional persona. */
export interface ConversationRow {
  id: string;
  /** Denormalized persona id; null when the conversation has no persona. */
  personaId: string | null;
  /** First-user-message title (route-side, truncated), or null. */
  title: string | null;
  createdAt: number;
  /** Bumped on every message append (list = recent activity first). */
  updatedAt: number;
}

/** Writable fields for a conversation (append bumps updated_at). */
export type ConversationRowPatch = Partial<Pick<ConversationRow, 'title' | 'personaId'>> & {
  updatedAt: number;
};

export interface ConversationStore {
  insert(row: ConversationRow): void;
  findById(id: string): ConversationRow | undefined;
  /** Most recently active first. */
  list(): ConversationRow[];
  update(id: string, patch: ConversationRowPatch): void;
  remove(id: string): void;
}

/** `messages` row — one stored turn within a conversation (ASC by time). */
export interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  /** Denormalized persona id at append time (may be null). */
  personaId: string | null;
  content: string;
  model: string | null;
  latencyMs: number | null;
  createdAt: number;
}

export interface MessageStore {
  insert(row: MessageRow): void;
  findById(id: string): MessageRow | undefined;
  /** Oldest first (conversation transcript order). */
  listByConversation(conversationId: string): MessageRow[];
  countByConversation(conversationId: string): number;
  /** conversationId -> row count for EVERY conversation (list summaries). */
  countsByConversation(): Array<{ conversationId: string; count: number }>;
  /** Cascade: remove a conversation's messages (conversation delete). */
  removeByConversation(conversationId: string): void;
}

// ---------------------------------------------------------------------------
// M4 memory tables (PLAN-M4.md — additive schema v5). Row profile only; the
// memory managers (core/src/memory/*) own validation, status rules, FTS
// mirroring, forgetting, export/import and audit. Wire shapes are the shared
// ProfileEntry/EpisodeSummary types (camelCase). Stores never read the clock.
// ---------------------------------------------------------------------------

/** `profile_entries` row — one explicit, user-visible memory fact. */
export interface ProfileEntryRow {
  id: string;
  /** preference | identity | rule | style (validated by the manager). */
  kind: string;
  /** Machine key when applicable (e.g. tone, language); null when none. */
  key: string | null;
  value: string;
  /** Why the partner thinks this (observed examples); null when none. */
  evidence: string | null;
  /** 'user' | 'partner_suggestion'. */
  source: string;
  /** confirmed | suggested | rejected. */
  status: string;
  /** null = global (every persona); else a persona id. */
  personaScope: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Writable fields for a profile row; a write always stamps updated_at. */
export type ProfileEntryRowPatch = Partial<
  Pick<
    ProfileEntryRow,
    'kind' | 'key' | 'value' | 'evidence' | 'source' | 'status' | 'personaScope'
  >
> & { updatedAt: number };

export interface ProfileEntryStore {
  insert(row: ProfileEntryRow): void;
  findById(id: string): ProfileEntryRow | undefined;
  /** All rows in creation order (oldest first) — the manager filters. */
  list(): ProfileEntryRow[];
  update(id: string, patch: ProfileEntryRowPatch): void;
  remove(id: string): void;
}

/** `episodes` row — one summarized conversation (conversation_id UNIQUE). */
export interface EpisodeRow {
  id: string;
  /** UNIQUE — an episode is the per-conversation summary. */
  conversationId: string;
  /** Denormalized persona id of the conversation at summarize time. */
  personaId: string | null;
  title: string;
  summary: string;
  /** Model that produced the summary; null for demo/placeholder summaries. */
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Writable fields for an episode row; a write always stamps updated_at. */
export type EpisodeRowPatch = Partial<
  Pick<EpisodeRow, 'personaId' | 'title' | 'summary' | 'model'>
> & { updatedAt: number };

export interface EpisodeStore {
  insert(row: EpisodeRow): void;
  findById(id: string): EpisodeRow | undefined;
  /** Lookup by the UNIQUE conversation id (resummarize dedupe). */
  findByConversationId(conversationId: string): EpisodeRow | undefined;
  /** All rows in creation order (oldest first). */
  list(): EpisodeRow[];
  update(id: string, patch: EpisodeRowPatch): void;
  remove(id: string): void;
}

/**
 * `memory_fts` (FTS5) mirror helpers — the searchable text behind M4
 * retrieval. One FTS row per indexed object, tagged by which ref column is
 * set: profile rows set `profile_ref`, episode rows set `episode_ref`.
 * content holds the object's searchable text (never audit/logs).
 */
export type MemoryRefKind = 'profile' | 'episode';

export interface MemoryFtsHit {
  kind: MemoryRefKind;
  refId: string;
  /** bm25 rank of the FTS row (lower = better). */
  rank: number;
}

export interface MemoryFtsStore {
  /** Delete + reinsert the profile row's searchable text (content = value). */
  upsertProfile(id: string, content: string): void;
  /** Delete + reinsert the episode row's searchable text (title + summary). */
  upsertEpisode(id: string, content: string): void;
  /** Remove the FTS row for one ref (no-op when absent). */
  deleteRef(kind: MemoryRefKind, id: string): void;
  /**
   * FTS5 MATCH over the content column, ranked by bm25 ascending, capped at
   * limit. The caller has already escaped the query.
   */
  match(query: string, limit: number): MemoryFtsHit[];
}
