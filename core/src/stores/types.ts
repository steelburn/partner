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
import type { KeyAccess, ShareKind, SiteScopeRecord, UserRole } from '@partner/shared';

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
  /**
   * The app user this session acts as, or NULL for a session that predates
   * the authentication lane (M20-B S3 first half). NULL means "no user", not
   * "any user": per-user reads must not match it.
   */
  userId: string | null;
  /**
   * Client class — 'desktop' (default) | 'mobile' | 'extension' — i.e. the
   * M20-B S4 capability-envelope dimension. Deliberately NOT `kind`: `kind`
   * is already the audit actor for the file/root/grant routes (see
   * `actorOf` in http/server.ts), so widening it would silently rewrite what
   * `?actor=` queries return.
   */
  clientClass: string;
  /** Human label for the device ("Sam's phone"); null when none was given. */
  deviceLabel: string | null;
  /** Platform tag ('ios', 'win32', 'chrome-extension'); null when none. */
  platform: string | null;
  /** When this row's token was last replaced; null = never rotated. */
  rotatedAt: number | null;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

/** Optional client/device identity for `insert`; absent = class 'desktop'. */
export interface SessionInsertMeta {
  userId?: string | null;
  clientClass?: string;
  deviceLabel?: string | null;
  platform?: string | null;
}

export interface SessionStore {
  /** The trailing meta object is optional so the M0 positional callers stay. */
  insert(
    tokenHash: string,
    kind: string,
    origin: string,
    createdAt: number,
    expiresAt: number,
    lastSeenAt: number,
    meta?: SessionInsertMeta,
  ): number;
  findByTokenHash(tokenHash: string): SessionRow | undefined;
  touch(id: number, at: number): void;
  revoke(id: number, at: number): void;
  /**
   * Replace this row's token hash IN PLACE and stamp `rotated_at`: the row
   * (the device record) survives with its user/class/label/platform, while
   * the outgoing token stops resolving at all. False when the id is unknown.
   */
  rotate(id: number, newTokenHash: string, expiresAt: number, at: number): boolean;
  /** Push `expires_at` out without touching the token (refresh). */
  extend(id: number, expiresAt: number): boolean;
  /** One user's sessions, oldest first; NULL-user rows never match. */
  listByUser(userId: string): SessionRow[];
  /**
   * EVERY session row, oldest first, whatever its user — including the
   * NULL-user rows `listByUser` can never match (SQL `user_id = NULL` is
   * never true, so a user-scoped read cannot reach them).
   *
   * Transitional (M20-B S5): the sign-in route does not exist yet, so every
   * session in the field has `user_id` NULL and a user-scoped device list
   * would be empty on every install that exists today. On an install that has
   * no users at all the single-user core IS the whole core, so its device list
   * is every row. The device routes reach this ONLY through
   * `SessionManager.listDevices(null)` / `revokeDeviceById(id, null)`; a
   * session that NAMES a user must never fall back here, or one user would
   * read every other user's devices. The authentication lane deletes this
   * method with that fallback.
   */
  listUnscoped(): SessionRow[];
  /**
   * Revoke one session, scoped to its owner: an id belonging to another user
   * matches nothing and returns false, so the caller answers 404 rather than
   * 403 and ids cannot be enumerated across users.
   */
  revokeById(id: number, userId: string, at: number): boolean;
  /**
   * Revoke one USER-LESS session (`user_id IS NULL`), scoped by that predicate.
   *
   * Exists so the transitional pre-auth path cannot reach a NAMED user's row: an
   * unscoped `UPDATE … WHERE id = ?` would let a legacy device revoke anyone's
   * session once users exist, which is the whole reason this is scoped rather
   * than plain.
   */
  revokeUnscoped(id: number, at: number): boolean;
  /** Revoke every live session of one user; the count that were killed. */
  revokeAllForUser(userId: string, at: number): number;
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

/** Filtered audit query (all filters optional, limit required). */
export interface AuditQuery {
  /** Newest-first cap. */
  limit: number;
  /** Exact actor match (session / persona / web). */
  actor?: string;
  /** Substring match on the action id (e.g. 'chat', 'playbook'). */
  action?: string;
  /** Substring match across target + details (never on unredacted text). */
  q?: string;
}

export interface AuditStore {
  add(actor: string, action: string, target: string, details: string, createdAt: number): number;
  /** Newest first, capped at limit. */
  list(limit: number): AuditRow[];
  /** Newest first with optional filters, capped at limit. */
  listFiltered(query: AuditQuery): AuditRow[];
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
  /** 'manual' | 'llm-self-service' (the latter is legacy — M22 removed the import). */
  source: string;
  /** M11 purpose tag: 'general'|'cheap'|'deep'|'coding'|'vision'|'research' (default 'general'). */
  purpose: string;
  /** Full OpenAI-compatible base URL, e.g. https://api.ne1.dev/v1 */
  endpoint: string;
  /** JSON array of model ids reported by the last probe (null = none). */
  defaultModels: string | null;
  /**
   * M24 (v20) JSON array of model ids the user declared image-capable for this
   * profile (null = none declared). Read alongside `defaultModels`: a model
   * listed here rides chat turns as an inline image part even when its id
   * matches no vision-name hint — which is the normal case behind a gateway
   * that aliases models (LiteLLM `model_name`).
   */
  visionModels: string | null;
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
    | 'purpose'
    | 'endpoint'
    | 'defaultModels'
    | 'visionModels'
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
  /** M12 search approvals: conversation to post the outcome note into. */
  conversationId: string | null;
  /** M12 search approvals: persona behind the request (queue tagging). */
  personaId: string | null;
  /**
   * M26 (v21): 'tool' (a broker call, the default) or 'skill_install' (a
   * persona asking to promote a skill draft). The HTTP decide route branches on
   * this; `broker.decide` REFUSES anything but 'tool'.
   */
  kind: string;
  /** M26: the draft an install ask refers to (kind 'skill_install' only). */
  draftId: string | null;
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
  /** M14 schedules JSON array (PLAN-M14.md) — independence.schedules[]. */
  schedules: string | null;
  /** memory flags as JSON {userProfile, episodes}. */
  memoryFlags: string | null;
  /** M11 persona policy JSON {skills:{default,banned},tools:{allowed,banned}} (null = none). */
  policy: string | null;
  /** D10 home folder id for auto chat placement (null = Inbox). */
  homeFolderId: string | null;
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
    | 'schedules'
    | 'memoryFlags'
    | 'policy'
    | 'homeFolderId'
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
  /** M11 folder (Projects/Folders) this conversation belongs to; null = Inbox. */
  folderId: string | null;
  /** M16 F4 discuss lineage: parent discussion this thread branches from. */
  parentId?: string | null;
  /** M16 F4 discuss lineage: asset id that sparked this forked discussion. */
  sourceAssetId?: string | null;
  createdAt: number;
  /** Bumped on every message append (list = recent activity first). */
  updatedAt: number;
}

/** Writable fields for a conversation (append bumps updated_at). */
export type ConversationRowPatch = Partial<
  Pick<ConversationRow, 'title' | 'personaId' | 'folderId' | 'parentId' | 'sourceAssetId'>
> & {
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
  /** M11: 'text' (canonical markdown) | 'parts' (multipart JSON, C2). Default 'text'. */
  contentType: string;
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
  /**
   * JSON array of persona ids (M33), or NULL/`[]` for global (every persona).
   * Raw column text — the memory manager owns parse/serialize (same split as
   * `providers.vision_models`). The pre-M33 single `persona_scope` column is
   * legacy and no longer read or written.
   */
  personaScopes: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Writable fields for a profile row; a write always stamps updated_at. */
export type ProfileEntryRowPatch = Partial<
  Pick<
    ProfileEntryRow,
    'kind' | 'key' | 'value' | 'evidence' | 'source' | 'status' | 'personaScopes'
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

// ---------------------------------------------------------------------------
// M5 notes + plans tables (PLAN-M5.md — additive schema v6). Row profile
// only; the managers (core/src/notes/*, core/src/plans/*) own wiki-link
// parsing/resolution, tags, the daily-note rule, document shape validation,
// the shared notes_fts mirror and audit. Stores never read the clock: every
// write takes explicit timestamps.
// ---------------------------------------------------------------------------

/** `notes` row — one local markdown note (owner content lives HERE only). */
export interface NoteRow {
  id: string;
  title: string;
  content: string;
  /** JSON string array of tags ([] serialized); the store never interprets it. */
  tags: string | null;
  /** 0 | 1 — daily notes are title/date-keyed by the manager. */
  isDaily: number;
  createdAt: number;
  updatedAt: number;
}

/** Writable fields for a note row; a write always stamps updated_at. */
export type NoteRowPatch = Partial<Pick<NoteRow, 'title' | 'content' | 'tags' | 'isDaily'>> & {
  updatedAt: number;
};

export interface NoteStore {
  insert(row: NoteRow): void;
  findById(id: string): NoteRow | undefined;
  /**
   * Case-insensitive (ASCII NOCASE) title lookup — the wiki-link resolution
   * target at save time; undefined when no note has that title yet.
   */
  findIdByTitle(title: string): string | undefined;
  /** All rows ascending by createdAt (stable) — the manager sorts/filters. */
  list(): NoteRow[];
  update(id: string, patch: NoteRowPatch): void;
  remove(id: string): void;
}

/**
 * `note_links` row — one resolved wiki-link edge. from_note is the source
 * note id; to_title is the (trimmed) bracket title, case-insensitively
 * unique per source note; to_note is the target id when the title resolved
 * at save time, else NULL (dangling, resolvable later via backlinks by title).
 */
export interface NoteLinkRow {
  fromNote: string;
  /** Resolved target id at save time; null = dangling. */
  toNote: string | null;
  toTitle: string;
}

export interface NoteLinkStore {
  /**
   * Replace a note's outgoing links in ONE transaction (delete-then-insert,
   * INSERT OR IGNORE per row so duplicate titles collapse).
   */
  replaceForNote(
    fromNote: string,
    links: ReadonlyArray<{ toNote: string | null; toTitle: string }>,
  ): void;
  /** Remove a note's outgoing links (update/delete cleanup). */
  removeForNote(fromNote: string): void;
  /** A note's outgoing links, to_title ascending (stable). */
  listFrom(fromNote: string): NoteLinkRow[];
  /**
   * Distinct source-note ids whose links target this note — resolved
   * (to_note = id) OR dangling by exact case-insensitive title match — the
   * backlink set. The manager filters out the note itself.
   */
  listLinkingTo(noteId: string, title: string): string[];
}

/** `plans` row — a structured plan; document is a JSON PlanDocument string. */
export interface PlanRow {
  id: string;
  title: string;
  description: string | null;
  /** JSON: {milestones: [{id,title,tasks:[{id,title,status,ownerPersonaId?}]}]}. */
  document: string;
  createdAt: number;
  updatedAt: number;
}

/** Writable fields for a plan row; a write always stamps updated_at. */
export type PlanRowPatch = Partial<Pick<PlanRow, 'title' | 'description' | 'document'>> & {
  updatedAt: number;
};

export interface PlanStore {
  insert(row: PlanRow): void;
  findById(id: string): PlanRow | undefined;
  /** All rows ascending by createdAt (stable). */
  list(): PlanRow[];
  update(id: string, patch: PlanRowPatch): void;
  remove(id: string): void;
}

/**
 * `notes_fts` (FTS5) mirror helpers — the shared searchable text behind M5
 * retrieval. One FTS row per indexed object tagged by which ref column is
 * set: notes set `note_ref`, plans set `plan_ref`; content holds searchable
 * text (never audit/logs/errors).
 */
export type NotesFtsKind = 'note' | 'plan';

export interface NotesFtsHit {
  kind: NotesFtsKind;
  refId: string;
  /** bm25 rank of the FTS row (lower = better). */
  rank: number;
}

export interface NotesFtsStore {
  /** Delete + reinsert the note's searchable text (title + content). */
  upsertNote(id: string, content: string): void;
  /** Delete + reinsert the plan's searchable text (title/desc/milestone-task titles). */
  upsertPlan(id: string, content: string): void;
  /** Remove the FTS row for one ref (no-op when absent). */
  deleteRef(kind: NotesFtsKind, id: string): void;
  /**
   * FTS5 MATCH over the content column, ranked by bm25 ascending, capped at
   * limit. The caller has already escaped the query.
   */
  match(query: string, limit: number): NotesFtsHit[];
}

// ---------------------------------------------------------------------------
// M16 F1/F3 (PLAN-M16.md — additive schema v14). `note_versions` snapshots
// every note mutation at the manager's single choke point (covers captures,
// promote, summarize, restore); `note_graph` persists canvas positions only
// (nodes/edges derive from notes + note_links, never duplicated here).
// ---------------------------------------------------------------------------

export interface NoteVersionRow {
  id: string;
  noteId: string;
  /** 1-based per-note sequence (never reused after delete). */
  seq: number;
  title: string;
  content: string;
  /** JSON string array of tags (mirrors notes.tags) or null. */
  tags: string | null;
  /** Origin writer tag: user|capture|promote|… (manager-owned vocabulary). */
  writer: string;
  createdAt: number;
}

export interface NoteVersionStore {
  insert(row: NoteVersionRow): void;
  /** Newest first (desc seq) — history list order. */
  listForNote(noteId: string): NoteVersionRow[];
  /** Highest seq for a note (0 = no versions yet). */
  maxSeq(noteId: string): number;
  find(noteId: string, versionId: string): NoteVersionRow | undefined;
  /** Drop versions with seq <= (maxSeq - keep) — retention cap. */
  prune(noteId: string, keep: number): void;
  /** Remove a note's versions (note delete cascade). */
  removeForNote(noteId: string): void;
}

export interface NoteGraphPosition {
  noteId: string;
  x: number;
  y: number;
}

export interface NoteGraphStore {
  /** Upsert one canvas position (REAL values validated by the manager). */
  set(noteId: string, x: number, y: number): void;
  get(noteId: string): NoteGraphPosition | undefined;
  /** Every stored position (notes without one are absent). */
  listAll(): NoteGraphPosition[];
  /** Remove a note's position (note delete cascade). */
  remove(noteId: string): void;
}

// ---------------------------------------------------------------------------
// M16 follow-up brainstorm linkage (additive schema v15). `brainstorm_sessions`
// keys a brainstorm conversation by the deterministic set of its source note
// ids; `brainstorm_sources` is the note<->conversation join. `concluded` is
// owner state — only an explicit reopen flips it back.
// ---------------------------------------------------------------------------

export interface BrainstormSessionRow {
  conversationId: string;
  /** Deterministic key over the sorted source note ids. */
  setKey: string;
  concluded: boolean;
  used: number;
  truncated: number;
  createdAt: number;
  updatedAt: number;
}

export interface BrainstormSessionStore {
  insert(row: BrainstormSessionRow): void;
  /** Set/replace the source note ids for a session (delete-then-insert). */
  setSources(conversationId: string, noteIds: readonly string[]): void;
  findByConversation(conversationId: string): BrainstormSessionRow | undefined;
  /** Newest-first sessions for one set key (active + concluded). */
  listBySetKey(setKey: string): BrainstormSessionRow[];
  /** Every session, most recently updated first. */
  list(): BrainstormSessionRow[];
  /** Source note ids for one session (ordered as inserted). */
  listSourceIds(conversationId: string): string[];
  /** Conversation ids linked to a note (both active and concluded). */
  listConversationIdsForNote(noteId: string): string[];
  setConcluded(conversationId: string, concluded: boolean, updatedAt: number): void;
  /** Remove one session + its source rows (conversation delete cascade). */
  remove(conversationId: string): void;
  /** Remove a NOTE from every session's source set (note delete cascade). */
  removeNote(noteId: string): void;
}

// ---------------------------------------------------------------------------
// M6 themes table (PLAN-M6.md — additive schema v7). Row profile only; the
// theme manager (core/src/theming/*) owns lint/contrast gating, preset
// seeding, activation and persona binding. Each row holds BOTH modes of the
// design tokens as JSON strings (exactly like providers.default_models) —
// the store never interprets them. Token bodies are not secrets, but the
// manager keeps audit rows to ids/names/source only. Stores never read the
// clock: every write takes explicit timestamps.
// ---------------------------------------------------------------------------

/** `themes` row — one id/name + JSON ThemeTokens for light and dark modes. */
export interface ThemeRow {
  id: string;
  name: string;
  /** 'preset' | 'custom' — presets are immutable (manager-enforced). */
  source: string;
  /** JSON ThemeTokens for the light mode. */
  lightJson: string;
  /** JSON ThemeTokens for the dark mode. */
  darkJson: string;
  createdAt: number;
  updatedAt: number;
}

/** Writable fields for a theme row; a write always stamps updated_at. */
export type ThemeRowPatch = Partial<Pick<ThemeRow, 'name' | 'lightJson' | 'darkJson'>> & {
  updatedAt: number;
};

export interface ThemeStore {
  insert(row: ThemeRow): void;
  findById(id: string): ThemeRow | undefined;
  /** All rows ascending by createdAt (stable); the manager sorts/derives. */
  list(): ThemeRow[];
  /** Apply a whitelisted patch, always stamping updated_at. */
  update(id: string, patch: ThemeRowPatch): void;
  remove(id: string): void;
  /** Total rows (preset seeding runs only when the table is empty). */
  count(): number;
}

// ---------------------------------------------------------------------------
// M7 browser site scopes table (PLAN-M7.md — additive schema v8). One row per
// origin the user has explicitly configured; ABSENCE means the default 'ask'
// scope. Origin strings are ids/ownership metadata ONLY — page content never
// reaches this store (it lives in the owner's browser, never the core). The
// scope manager (core/src/browser/scopes.ts) owns blocklist + validation;
// this row store is plain CRUD over the shared SiteScopeRecord shape.
// ---------------------------------------------------------------------------

export interface SiteScopeStore {
  /** Upsert one origin-scope mapping (origin PK — scope default 'ask'). */
  upsert(row: SiteScopeRecord): void;
  findByOrigin(origin: string): SiteScopeRecord | undefined;
  /** All rows ascending by origin (stable order for the web list view). */
  list(): SiteScopeRecord[];
  /** Remove a mapping (back to the default 'ask'). Idempotent. */
  remove(origin: string): void;
}

// ---------------------------------------------------------------------------
// M8 skills tables (PLAN-M8.md — additive schema v9). Row profile only; the
// skill manager (core/src/skills/*) owns manifest validation, the code store
// on disk (storeDir/<id>), install/uninstall hygiene and audit. manifest_json
// is the JSON SkillManifest string the store never interprets; sha256 covers
// the ENTRY FILE at install time (local-catalog integrity, PLAN-M8 §9
// deviation). skill_invocations rows are METADATA ONLY (ok/toolCalls/ms/
// error codes) — skill args/results/logs never reach this store or audit.
// Stores never read the clock: every write takes explicit timestamps.
// ---------------------------------------------------------------------------

/** `skills` row — one installed skill (user-scoped, per-core profile). */
export interface SkillRow {
  id: string;
  name: string;
  description: string | null;
  author: string;
  version: string;
  /** Code path under the per-core skill store (e.g. 'entry.mjs'). */
  entrypoint: string;
  /** JSON SkillManifest string (the store never interprets it). */
  manifestJson: string;
  /** SHA-256 hex of the entry file recorded at install time. */
  sha256: string;
  /** 'local' in v1 (remote gallery deferred). */
  source: string;
  /** 'installed' | 'disabled' (manager-owned). */
  status: string;
  installedAt: number;
  updatedAt: number;
}

/** Writable fields; a write always stamps updatedAt (mirrors PersonaRowPatch). */
export type SkillRowPatch = Partial<
  Pick<
    SkillRow,
    | 'name'
    | 'description'
    | 'author'
    | 'version'
    | 'entrypoint'
    | 'manifestJson'
    | 'sha256'
    | 'source'
    | 'status'
  >
> & { updatedAt: number };

export interface SkillStore {
  insert(row: SkillRow): void;
  findById(id: string): SkillRow | undefined;
  /** Installed order (oldest first) — the manager owns status/ordering. */
  list(): SkillRow[];
  /** Apply a whitelisted patch, always stamping updated_at. */
  update(id: string, patch: SkillRowPatch): void;
  remove(id: string): void;
}

/** `skill_drafts` row — an INERT authored bundle (M26, schema v21; flow v22). */
export interface SkillDraftRow {
  id: string;
  name: string;
  description: string;
  /** 'draft' | 'installed' (manager-owned). */
  status: string;
  /** 'generated'|'template'|'manual'|'chat'|'fork'|'import'. */
  origin: string;
  /** Parsed+normalized SkillManifest JSON; NULL while the manifest is invalid. */
  manifestJson: string | null;
  /** Exactly what the owner/model wrote (editable verbatim). */
  manifestText: string;
  /** The entry.mjs source. */
  code: string;
  /** The description the draft was generated from ('' when manual/template). */
  prompt: string;
  /** Which model drafted it (NULL for manual/template/fork). */
  model: string | null;
  /** JSON SkillDraftValidation — the deterministic result, never a run. */
  validationJson: string;
  conversationId: string | null;
  personaId: string | null;
  /** Set on promote: the version that shipped (audit trail). */
  installedVersion: string | null;
  /**
   * M28 (v22): the flow document (JSON `SkillFlow`), NULL for a code-authored
   * draft. It is an AUTHORING view — install still consumes `code`.
   */
  flowJson: string | null;
  /** The sha256 of the code the flow last compiled to (NULL = never compiled). */
  flowSha256: string | null;
  /** When that compile happened (NULL = never compiled). */
  flowCompiledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Whitelisted patch; every write stamps updated_at. */
export type SkillDraftRowPatch = Partial<
  Pick<
    SkillDraftRow,
    | 'name'
    | 'description'
    | 'status'
    | 'origin'
    | 'manifestJson'
    | 'manifestText'
    | 'code'
    | 'prompt'
    | 'model'
    | 'validationJson'
    | 'conversationId'
    | 'personaId'
    | 'installedVersion'
    | 'flowJson'
    | 'flowSha256'
    | 'flowCompiledAt'
  >
> & { updatedAt: number };

export interface SkillDraftStore {
  insert(row: SkillDraftRow): void;
  findById(id: string): SkillDraftRow | undefined;
  /** Newest first — the Studio's rail order. */
  list(): SkillDraftRow[];
  update(id: string, patch: SkillDraftRowPatch): void;
  /** Hard delete: a draft is not history (the audit row is). */
  remove(id: string): void;
}

/** `skill_invocations` row — metadata of one worker run (never content). */
export interface SkillInvocationRow {
  id: string;
  skillId: string;
  /** Persona that triggered the run (null = no persona). */
  personaId: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** 0 | 1 — null while the run is open (rows are written after settle). */
  ok: number | null;
  /** Number of broker-mediated tool requests the worker made. */
  toolCalls: number;
  /** Coded outcome only — never content (null when ok). */
  error: string | null;
  /** Wall-clock duration in ms (null while open). */
  ms: number | null;
}

export interface SkillInvocationStore {
  insert(row: SkillInvocationRow): void;
  findById(id: string): SkillInvocationRow | undefined;
  /** Newest first, capped at limit (metadata only). */
  listBySkill(skillId: string, limit: number): SkillInvocationRow[];
  /** Cascade: drop a skill's invocation history on uninstall. */
  removeBySkill(skillId: string): void;
}

// ---------------------------------------------------------------------------
// M9 playbook-run + deploy-profile row stores (PLAN-M9.md — additive schema
// v10). Plain typed CRUD with NO business logic; the playbook manager
// (core/src/playbooks/manager.ts) and deploy manager
// (core/src/playbooks/deploy.ts) own validation, run-state transitions and
// audit. Stores never read the clock: writes take explicit timestamps.
// playbook_runs rows are metadata only — conversation transcript content
// stays in messages; tool params/results never cross this table or audit.
// ---------------------------------------------------------------------------

/** Column projection for `deploy_profiles` (snake_case -> camelCase). */
export interface DeployProfileRow {
  id: string;
  name: string;
  /** Only 'docker-ssh' in v1 (PLAN-M9). */
  kind: string;
  host: string;
  /** SSH login user when set (null = host default). */
  username: string | null;
  port: number;
  /** Base path on the target host where apps land (null = default). */
  remoteBaseDir: string | null;
  /**
   * JSON map of extra env the deployment should inject. NOT part of the
   * create/update API (PLAN-M9: "env_extra not part of API") — the column
   * exists for a later milestone; secret VALUES are never accepted.
   */
  envExtra: string | null;
  createdAt: number;
  updatedAt: number;
}

/** `playbook_runs` row — metadata of one playbook run (never content). */
export interface PlaybookRunRow {
  id: string;
  playbookId: string;
  personaId: string | null;
  conversationId: string | null;
  /** running|done|error|loop_exhausted (queued runs stay 'running'). */
  status: string;
  /** Count of executed broker tools in the loop. */
  toolCalls: number;
  startedAt: number;
  finishedAt: number | null;
  /** Coded error only — never content. */
  error: string | null;
}

/** Whitelisted patch for an open playbook_runs row. */
export type PlaybookRunPatch = Partial<
  Pick<PlaybookRunRow, 'status' | 'toolCalls' | 'finishedAt' | 'error'>
>;

export interface DeployProfileStore {
  insert(row: DeployProfileRow): void;
  findById(id: string): DeployProfileRow | undefined;
  list(): DeployProfileRow[];
  remove(id: string): void;
}

export interface PlaybookRunStore {
  insert(row: PlaybookRunRow): void;
  findById(id: string): PlaybookRunRow | undefined;
  update(id: string, patch: PlaybookRunPatch): void;
}

// ---------------------------------------------------------------------------
// M14 scheduled runs store (PLAN-M14.md — additive schema v13). One row per
// autonomous schedule run attempt. Content discipline mirrors playbook runs:
// label snapshot + ids/counts/status only — schedule prompts and transcript
// content never touch the row (conversations own the text).
// ---------------------------------------------------------------------------

export interface ScheduleRunRow {
  id: string;
  personaId: string;
  scheduleId: string;
  /** Snapshot label at run time (thread title / UI / audit label). */
  label: string;
  /** running|done|queued|error|loop_exhausted (queued waits on pendingId). */
  status: string;
  conversationId: string | null;
  /** Non-null while a queued run waits on this approval row. */
  pendingId: string | null;
  /** Broker tools executed (direct + approval-executed on resume). */
  toolCalls: number;
  /** Model rounds consumed. */
  rounds: number;
  model: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** Coded error only — never content. */
  error: string | null;
}

export type ScheduleRunPatch = Partial<
  Pick<
    ScheduleRunRow,
    | 'status'
    | 'conversationId'
    | 'pendingId'
    | 'toolCalls'
    | 'rounds'
    | 'model'
    | 'finishedAt'
    | 'error'
  >
>;

export interface ScheduleRunFilter {
  personaId?: string;
  scheduleId?: string;
  status?: string;
  limit?: number;
}

export interface ScheduleRunStore {
  insert(row: ScheduleRunRow): void;
  findById(id: string): ScheduleRunRow | undefined;
  /** Newest started first, filtered. Default limit 50, cap 100. */
  list(filter?: ScheduleRunFilter): ScheduleRunRow[];
  /** The queued run waiting on a given approval row, if any. */
  findWaitingByPending(pendingId: string): ScheduleRunRow | undefined;
  update(id: string, patch: ScheduleRunPatch): void;
}

/** `spend_ledger` row — cumulative cents for the current budget window. */
export interface SpendLedgerRow {
  providerId: string;
  /** Epoch ms when the current rolling window started. */
  windowStart: number;
  /** Cents charged in the current window. */
  cents: number;
  updatedAt: number;
}

export interface SpendLedgerStore {
  find(providerId: string): SpendLedgerRow | undefined;
  /** Insert-or-overwrite one provider's window row. */
  upsert(row: SpendLedgerRow): void;
  /** Remove a provider's ledger row (profile delete/cleanup). */
  remove(providerId: string): void;
}

// ---------------------------------------------------------------------------
// M11 F11 folders store (PLAN-M11.md — additive schema v12). A folder is a
// node in the conversation-organizing tree; conversations.folder_id (M11 C1
// guarded column) is the edge. Tree semantics (cycle guard, reparenting,
// chat counts, Inbox for folder_id NULL) live in the folder manager — this
// store is plain typed CRUD with sibling ordering.
// ---------------------------------------------------------------------------

/** `folders` row — one node of the chat tree. */
export interface FolderRow {
  id: string;
  name: string;
  /** Parent folder id; null = root level (rail top). */
  parentId: string | null;
  /** Sibling order within the parent (append = max+1). */
  position: number;
  createdAt: number;
  updatedAt: number;
}

export type FolderRowPatch = Partial<Pick<FolderRow, 'name' | 'parentId' | 'position'>> & {
  updatedAt: number;
};

export interface FolderStore {
  insert(row: FolderRow): void;
  findById(id: string): FolderRow | undefined;
  /** Flat list, parent-major then position (tree assembly is the manager's). */
  list(): FolderRow[];
  update(id: string, patch: FolderRowPatch): void;
  remove(id: string): void;
}

// ---------------------------------------------------------------------------
// M17 note<->folder membership store (additive schema v16). A note may sit in
// zero or more folders (many-to-many); no row = unfiled ("Inbox"). Folders
// stay one shared tree for chats AND notes — notes never get their own tree.
// Membership writes are transactional replace-for-note; the note manager owns
// validation and audit (ids/counts only).
// ---------------------------------------------------------------------------

/** `note_folders` row — one membership edge. */
export interface NoteFolderRow {
  noteId: string;
  folderId: string;
  createdAt: number;
}

export interface NoteFolderStore {
  /**
   * Replace a note's memberships in ONE transaction (delete-then-insert).
   * Duplicate folder ids collapse; empty clears to unfiled. `at` stamps
   * createdAt on the newly inserted rows only.
   */
  setForNote(noteId: string, folderIds: readonly string[], at: number): void;
  /** Folder ids for one note, oldest membership first (deterministic). */
  listFolderIdsForNote(noteId: string): string[];
  /** Note ids directly in one folder, note-id ascending (deterministic). */
  listNoteIdsInFolder(folderId: string): string[];
  /** Union of note ids across the given folders (subtree reads), ascending. */
  listNoteIdsInFolders(folderIds: readonly string[]): string[];
  /** Direct membership count per folder id (folders with none are absent). */
  countByFolder(): Map<string, number>;
  /** Remove a note's memberships (note delete cascade). */
  removeForNote(noteId: string): void;
  /** Remove a folder's memberships (folder delete cascade; notes survive). */
  removeForFolder(folderId: string): void;
}

// ---------------------------------------------------------------------------
// M11 F1 chat attachments + blobs stores (PLAN-M11.md — additive schema
// v12). A conversation owns staged uploads (`message_id NULL`) until the
// next turn binds them to the persisted user message. Payload bytes live in
// chat_blobs, deduped by sha256 (an attachment row references one blob). The
// `ref` kind is a mention of a root-granted file: no bytes, just provenance.
// Content is owner data — never audit (rows/ids/lengths only).
// ---------------------------------------------------------------------------

/** `chat_blobs` row — deduped attachment payload bytes. */
export interface ChatBlobRow {
  sha256: string;
  mime: string;
  size: number;
  data: Buffer;
  createdAt: number;
}

/** `attachments` row — one staged or bound file on a conversation message. */
export interface AttachmentRow {
  id: string;
  conversationId: string;
  /** Null while staged (uploaded but the next turn has not been sent). */
  messageId: string | null;
  kind: 'upload' | 'ref';
  name: string;
  mime: string;
  size: number;
  /** sha256 of the payload when kind=upload; null for refs. */
  sha256: string | null;
  /** Ref provenance: granted root id + path inside it (kind=ref). */
  refRootId: string | null;
  refPath: string | null;
  /** Extracted UTF-8 text for text-ish uploads (cap: manager-owned). */
  extractText: string | null;
  createdAt: number;
}

export interface ChatBlobStore {
  find(sha256: string): ChatBlobRow | undefined;
  insert(row: ChatBlobRow): void;
  /** Remove a blob when no attachment row references it (manager-owned). */
  remove(sha256: string): void;
  /** Attachment rows referencing a blob (for refcount checks). */
  referencing(sha256: string): number;
}

export interface AttachmentStore {
  insert(row: AttachmentRow): void;
  findById(id: string): AttachmentRow | undefined;
  /** Conversation rows, oldest first (staged rows message_id NULL first). */
  listByConversation(conversationId: string): AttachmentRow[];
  /** Bound rows for one message (turn). */
  listByMessage(messageId: string): AttachmentRow[];
  /** Bind a staged row to a persisted message (turn send). */
  bind(id: string, messageId: string): void;
  /** Delete one row; returns its blob sha for refcount cleanup. */
  remove(id: string): AttachmentRow | undefined;
}

// ---------------------------------------------------------------------------
// M11 F10 assets store (PLAN-M11.md — additive schema v12). Typed saved
// artifacts extracted from conversation messages. Owner content (bodies) —
// audit rows carry ids/kinds/titles only.
// ---------------------------------------------------------------------------

/** `assets` row — one typed saved artifact. */
export interface AssetRow {
  id: string;
  conversationId: string;
  messageId: string | null;
  kind: string;
  title: string;
  body: string;
  tags: string | null;
  createdAt: number;
}

export interface AssetStore {
  insert(row: AssetRow): void;
  findById(id: string): AssetRow | undefined;
  listByConversation(conversationId: string): AssetRow[];
  /**
   * conversationId -> row count for EVERY conversation, in one query (M35).
   * The conversation list needs a per-chat asset count, and calling
   * `listByConversation` per chat would be an N-query read of the whole table;
   * this mirrors `MessageStore.countsByConversation` deliberately.
   */
  countsByConversation(): Array<{ conversationId: string; count: number }>;
  remove(id: string): void;
}

// ---------------------------------------------------------------------------
// M11 F2 MCP servers store (PLAN-M11.md — additive schema v12). One row per
// configured MCP stdio server (command/args only — no secrets in this slice;
// headers/env are reserved for the http transport). Off by default.
// ---------------------------------------------------------------------------

/** `mcp_servers` row — a configured stdio MCP server. */
export interface McpServerRow {
  id: string;
  name: string;
  transport: string;
  command: string;
  args: string | null;
  enabled: number;
  createdAt: number;
  updatedAt: number;
}

export interface McpServerStore {
  insert(row: McpServerRow): void;
  findById(id: string): McpServerRow | undefined;
  list(): McpServerRow[];
  update(id: string, patch: { name?: string; command?: string; args?: string[] | null; enabled?: boolean; updatedAt: number }): void;
  remove(id: string): void;
}

// ---------------------------------------------------------------------------
// M20-B S2/S2a system-DB stores (PLAN-M20-B.md §2a — additive schema v17).
// These two tables are the PRE-USER ones: they must exist before any app user
// is resolved, so they live in `data/system.db` (keychain account
// `system-key`; see core/src/system/db.ts) rather than inside a per-user
// partition. Row CRUD only — `users/manager.ts` owns id validation, first-run
// and the disabled gate, `users/credentials.ts` owns hashing and lockout.
// ---------------------------------------------------------------------------

/** `users` row — one app user of this core. User #0 is the OS-profile holder. */
export interface UserRow {
  id: string;
  /** Display name (the OS login name for a first-run user). */
  label: string;
  /**
   * The OS login this user is the app-side of, lowercased (`osProfile.ts`).
   * NULL for a user with no OS profile on this machine — someone who reaches
   * this core from another device. UNIQUE, so one OS user maps to exactly one
   * app user and an install that never had users keeps behaving as it does.
   */
  osProfileKey: string | null;
  createdAt: number;
  /**
   * Set by disable(): the user refuses requests while kept intact. Null means
   * active. Nothing in this store ever deletes a user or their data — a
   * disabled user's rows, partition and files stay, and a delete is a
   * deliberate act elsewhere (partition dir removal + this row) rather than a
   * side effect of disabling.
   */
  disabledAt: number | null;
  /**
   * M20-B S9: keep this user's partition key in the keychain so their schedules
   * run while nobody is signed in. False (the default) means the key lives only
   * inside the passphrase-wrapped record — signed out means unreadable.
   */
  keepUnlocked: boolean;
  /** M29: owner or member (see `@partner/shared` USER_ROLES). */
  role: UserRole;
  /** M29: own credentials or the deployment's shared provider/search config. */
  keyAccess: KeyAccess;
}

/**
 * `key_wraps` row (M20-B S9) — a partition key wrapped under a key derived from
 * the user's passphrase. The stored credential verifier cannot unwrap it: the
 * wrap uses its own salt plus HKDF domain separation (see `users/keyWrap.ts`).
 */
export interface KeyWrapRow {
  userId: string;
  /** Reserved: the vault key today, the runner's job key later (S8). */
  purpose: string;
  /** base64: the wrap's own salt (16 bytes). */
  salt: string;
  /** base64: AES-GCM nonce (12 bytes). */
  nonce: string;
  /** base64: AES-GCM authentication tag (16 bytes). */
  tag: string;
  /** base64: the wrapped 32-byte key. */
  ciphertext: string;
  createdAt: number;
  updatedAt: number;
}

export interface KeyWrapStore {
  upsert(row: KeyWrapRow): void;
  findByUser(userId: string): KeyWrapRow | undefined;
  /** Drop a user's wrap (account recovery path). True when a row was removed. */
  removeByUser(userId: string): boolean;
  list(): KeyWrapRow[];
}

export interface UserStore {
  insert(row: UserRow): void;
  findById(id: string): UserRow | undefined;
  /** The app user mapped to an OS profile (the one-profile-one-user rule). */
  findByOsProfileKey(key: string): UserRow | undefined;
  /** Every user, oldest first; disabled users are included (see disabledAt). */
  list(): UserRow[];
  /** Stamp disabled_at. False when the id is unknown. Never deletes a row. */
  disable(id: string, at: number): boolean;
  /** Clear disabled_at (disable is reversible). False when the id is unknown. */
  enable(id: string): boolean;
  /**
   * M20-B S9: the per-user at-rest policy. `true` keeps the partition key in the
   * keychain so this user's schedules run with nobody signed in — the promise is
   * weakened for THIS user, by their own explicit choice. Audited by the caller.
   */
  setKeepUnlocked(id: string, value: boolean): boolean;
}

/**
 * `invites` row (M29) — a single-use invitation minted by an owner.
 *
 * The code itself is NEVER stored: `codeHash` is its SHA-256 hex, so a database
 * dump cannot be replayed as an invite. `role`/`keyAccess` are the authority the
 * redeemER gains, decided by the MINTING owner; sign-up reads them from here, so
 * a request body cannot escalate.
 */
export interface InviteRow {
  id: string;
  codeHash: string;
  role: UserRole;
  keyAccess: KeyAccess;
  /** The owner who minted it (null for the legacy loopback operator mint). */
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  /** Set the moment it is redeemed; a non-null row can never be used again. */
  usedAt: number | null;
  usedBy: string | null;
}

export interface InviteStore {
  insert(row: InviteRow): void;
  findById(id: string): InviteRow | undefined;
  findByCodeHash(codeHash: string): InviteRow | undefined;
  /** Every row, newest first (the owner's admin list). */
  list(): InviteRow[];
  /**
   * Consume a live invite in ONE conditional UPDATE: marks `used_at`/`used_by`
   * only while the row is still unused. False when it was already spent (the
   * race two concurrent sign-ups would otherwise win twice).
   */
  consume(id: string, usedAt: number, usedBy: string): boolean;
  /** Delete one row (owner revocation). False when it did not exist. */
  remove(id: string): boolean;
}

/**
 * `shares` row (M29) — a note or asset one user handed to another.
 *
 * The content is a SNAPSHOT (`body`/`meta`), copied when the owner shares it and
 * refreshed on demand. That is deliberate: the grantee never opens the owner's
 * encrypted partition, so sharing cannot become a cross-user read path, and a
 * share stays readable while its owner is signed out.
 */
export interface ShareRow {
  id: string;
  ownerId: string;
  kind: ShareKind;
  resourceId: string;
  /** The asset's conversation, when `kind` is 'asset'; null for notes. */
  conversationId: string | null;
  granteeId: string;
  permission: string;
  title: string;
  body: string;
  /** JSON kind-specific extras (tags, source, provenance), or null. */
  meta: string | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export interface ShareStore {
  insert(row: ShareRow): void;
  findById(id: string): ShareRow | undefined;
  /** Active shares this user granted, newest first. */
  listByOwner(ownerId: string): ShareRow[];
  /** Active shares granted TO this user, newest first. */
  listByGrantee(granteeId: string): ShareRow[];
  /**
   * Rewrite the snapshot columns (owner "update shared copy"). False when the
   * row is absent, revoked, or not owned by `ownerId`.
   */
  refresh(id: string, ownerId: string, title: string, body: string, meta: string | null, at: number): boolean;
  /** Mark revoked. False when absent, already revoked, or not owned. */
  revoke(id: string, ownerId: string, at: number): boolean;
}

/**
 * `shared_access` key/value (M29) — the deployment configuration an owner
 * published for members with `keyAccess: 'shared'`. Secrets never live here: the
 * provider/search KEYS sit in the deployment keychain under `shared-*` accounts,
 * and the values are non-secret JSON written by `core/src/sharing/sharedAccess.ts`.
 */
export interface SharedAccessStore {
  get(key: string): { value: string; updatedAt: number } | undefined;
  set(key: string, value: string, at: number): void;
  remove(key: string): boolean;
  /** Keys present, so a caller can report what is published without parsing. */
  keys(): string[];
}

/**
 * `user_credentials` row — one passphrase credential per user.
 *
 * The passphrase itself is NEVER stored: only a random per-user salt, the
 * scrypt-derived key and the parameters that produced it. `hash` is read by
 * the credential manager alone (to compare) and is never returned by it,
 * logged, or placed in an audit row.
 */
export interface UserCredentialRow {
  userId: string;
  /** Per-user random salt, hex (16 bytes). */
  salt: string;
  /** scrypt-derived key, hex. */
  hash: string;
  /** JSON `ScryptParams` the key was derived with (users/credentials.ts). */
  params: string;
  /** Consecutive failed verifications since the last success / lock expiry. */
  failedAttempts: number;
  /** While set and still in the future, verify() refuses with `locked`. */
  lockedUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface UserCredentialStore {
  /** Create the credential, or REPLACE salt+hash+params (first set / rotation). */
  upsert(row: UserCredentialRow): void;
  findByUserId(userId: string): UserCredentialRow | undefined;
  /**
   * Rewrite the lockout bucket: `failedAttempts` consecutive failures and the
   * instant a lock releases (`lockedUntil` null = not locked).
   */
  setAttempts(userId: string, failedAttempts: number, lockedUntil: number | null): void;
}
