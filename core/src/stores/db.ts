/**
 * SQLite open + idempotent schema, and the M0 row-store factories.
 *
 * Schema is applied with CREATE TABLE IF NOT EXISTS so opening twice (or a
 * re-open after a crash mid-migration) is safe. WAL is enabled for file DBs;
 * ':memory:' databases are used by DEMO_MODE and every unit test.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '@partner/shared';
import type { SiteScopeRecord } from '@partner/shared';
import type {
  AuditQuery,
  AuditRow,
  AuditStore,
  ConversationRow,
  ConversationRowPatch,
  ConversationStore,
  EpisodeRow,
  EpisodeRowPatch,
  EpisodeStore,
  FileProposalRow,
  FileProposalStore,
  GrantRow,
  GrantStore,
  MemoryFtsHit,
  MemoryFtsStore,
  MemoryRefKind,
  MessageRow,
  MessageStore,
  PairingRow,
  PairingStore,
  PendingToolRow,
  PendingToolStore,
  PersonaRow,
  PersonaRowPatch,
  PersonaStore,
  ProfileEntryRow,
  ProfileEntryRowPatch,
  ProfileEntryStore,
  ProjectRootRow,
  ProjectRootStore,
  ProviderRow,
  ProviderRowPatch,
  ProviderStore,
  SessionRow,
  SessionStore,
  SettingsStore,
  SiteScopeStore,
  SkillInvocationRow,
  SkillInvocationStore,
  SkillRow,
  SkillRowPatch,
  SkillStore,
  ThemeRow,
  ThemeRowPatch,
  ThemeStore,
} from './types.js';

const META_SCHEMA_VERSION_KEY = 'schema_version';

import type {
  BrainstormSessionRow,
  BrainstormSessionStore,
  NoteLinkRow,
  NoteLinkStore,
  NoteRow,
  NoteRowPatch,
  NoteStore,
  NotesFtsHit,
  NotesFtsKind,
  NotesFtsStore,
  NoteVersionRow,
  NoteVersionStore,
  NoteGraphPosition,
  NoteGraphStore,
  PlanRow,
  PlanRowPatch,
  PlanStore,
  AssetRow,
  AssetStore,
  AttachmentRow,
  AttachmentStore,
  ChatBlobRow,
  ChatBlobStore,
  DeployProfileRow,
  DeployProfileStore,
  FolderRow,
  FolderRowPatch,
  FolderStore,
  McpServerRow,
  McpServerStore,
  PlaybookRunPatch,
  PlaybookRunRow,
  PlaybookRunStore,
  ScheduleRunFilter,
  ScheduleRunPatch,
  ScheduleRunRow,
  ScheduleRunStore,
  SpendLedgerRow,
  SpendLedgerStore,
} from './types.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pairings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'openai-compatible',
  source TEXT NOT NULL DEFAULT 'manual',
  endpoint TEXT NOT NULL,
  default_models TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  budget_cents INTEGER,
  key_ref TEXT NOT NULL,
  last_health TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- M2 tool-broker tables (PLAN-M2.md, additive schema v3). project_roots are
-- the only filesystem the broker can see; grants are the (tool, project)
-- allow-list; pending_tools is the approval queue; file_proposals holds
-- write-preview diffs until apply/discard. Content-bearing proposal text is
-- stored locally BY DESIGN (the diff must survive a core restart); it never
-- crosses audit or logs.

CREATE TABLE IF NOT EXISTS project_roots (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  read_only INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  note TEXT
);

CREATE TABLE IF NOT EXISTS pending_tools (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  project_id TEXT,
  params TEXT NOT NULL,
  risk TEXT NOT NULL,
  requested_by TEXT NOT NULL DEFAULT 'web',
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decision TEXT,
  decided_by TEXT,
  conversation_id TEXT,
  persona_id TEXT
);

CREATE TABLE IF NOT EXISTS file_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  original_mtime INTEGER NOT NULL,
  original_content TEXT,
  proposed_content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  discarded_at INTEGER
);

-- M3 persona/conversation tables (PLAN-M3.md, additive schema v4). Columns
-- follow the plan verbatim plus two additive extras so the full shared wire
-- Persona round-trips: color_theme (Persona.colorTheme) and auto_scopes
-- (independence.autoScopes — 'stored now, enforced later').

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT,
  avatar TEXT,
  color_theme TEXT,
  voice TEXT,
  language TEXT,
  system_prompt TEXT,
  temperature REAL,
  task_classes TEXT,
  fallback_model TEXT,
  provider_id TEXT,
  independence_level TEXT NOT NULL DEFAULT 'assist',
  require_human TEXT,
  auto_scopes TEXT,
  memory_flags TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  persona_id TEXT,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  persona_id TEXT,
  content TEXT NOT NULL,
  model TEXT,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);

-- M4 memory tables (PLAN-M4.md, additive schema v5). profile_entries hold
-- explicit user/partner facts (status confirmed|suggested|rejected); episodes
-- hold one summary per conversation (conversation_id UNIQUE); memory_fts is
-- the FTS5 mirror searched by GET /v1/memory/search. FTS5 availability is
-- asserted in assertFts5() before this schema runs (openDatabase).

CREATE TABLE IF NOT EXISTS profile_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- preference|identity|rule|style
  key TEXT,
  value TEXT NOT NULL,
  evidence TEXT,
  source TEXT NOT NULL, -- 'user'|'partner_suggestion'
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed|suggested|rejected
  persona_scope TEXT, -- null = global, else persona id
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT UNIQUE,
  persona_id TEXT,
  title TEXT,
  summary TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
  USING fts5(episode_ref, profile_ref, content);

-- M5 notes + plans tables (PLAN-M5.md, additive schema v6). notes holds the
-- owner's markdown; note_links is the wiki-link edge set (to_title is
-- NOCASE so [[Foo]]/[[foo]] collapse to one edge and backlink title matches
-- are case-insensitive); plans holds the structured document JSON. notes_fts
-- is the shared FTS5 mirror (note_ref XOR plan_ref) kept in step by the
-- notes/plans managers. Note/plan CONTENT lives in these tables only — it
-- never crosses audit/logs/errors (ids/titles/lengths beyond).

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  is_daily INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note_links (
  from_note TEXT NOT NULL,
  to_note TEXT,
  to_title TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (from_note, to_title)
);
CREATE INDEX IF NOT EXISTS idx_note_links_to_note ON note_links(to_note);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  document TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts
  USING fts5(note_ref, plan_ref, content);

-- M6 themes table (PLAN-M6.md, additive schema v7). One row = BOTH modes of
-- the design tokens (JSON ThemeTokens per mode, same discipline as
-- providers.default_models). Token bodies are not secrets, but audit rows
-- keep to ids/names/source only (manager-owned).

CREATE TABLE IF NOT EXISTS themes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL, -- preset | custom
  light_json TEXT NOT NULL,
  dark_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- M7 browser site-scopes table (PLAN-M7.md, additive schema v8). One row per
-- origin the user has explicitly configured (origin PK); ABSENCE of a row
-- means the default 'ask' scope. Origins are ids/ownership metadata only —
-- page content never reaches the core, let alone this table. Scope values
-- are validated by the scope manager; the column default mirrors the shared
-- SiteScope default.

CREATE TABLE IF NOT EXISTS site_scopes (
  origin TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'ask',
  updated_at INTEGER NOT NULL
);

-- M8 skills tables (PLAN-M8.md, additive schema v9). skills holds one row per
-- installed skill: manifest JSON + entry SHA-256 recorded from the LOCAL
-- catalog at install (remote gallery/signing deferred) + status. Code lives
-- on disk under <data>/skills/<id>/ (manager-owned, wiped on uninstall), so
-- only ids/versions/hashes cross this table. skill_invocations is a metadata
-- log (ids/counts/ms/coded errors) — skill args/results/logs NEVER reach
-- SQLite, let alone audit.

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  author TEXT NOT NULL,
  version TEXT NOT NULL,
  entrypoint TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'installed',
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_invocations (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  persona_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_skill_invocations_skill
  ON skill_invocations(skill_id, started_at);

-- M9 playbook + deploy-target tables (PLAN-M9.md, additive schema v10).
-- deploy_profiles are connection descriptors for the Ship playbook
-- (kind docker-ssh v1; env_extra is a JSON map column held for later
-- injection — secret VALUES never cross the API). playbook_runs is a
-- metadata row per capability run (playbook/persona/conversation ids +
-- status + tool-call count): conversation text lives in messages and tool
-- params/results never reach this table, let alone audit.

CREATE TABLE IF NOT EXISTS deploy_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'docker-ssh',
  host TEXT NOT NULL,
  username TEXT,
  port INTEGER DEFAULT 22,
  remote_base_dir TEXT,
  env_extra TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playbook_runs (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL,
  persona_id TEXT,
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  tool_calls INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_playbook_runs_persona
  ON playbook_runs(persona_id, started_at);

-- M14 scheduled runs (PLAN-M14.md, additive schema v13): one row per
-- autonomous schedule run attempt. Content discipline mirrors playbook runs
-- (label snapshot + ids/counts only; transcripts live in conversations).
CREATE TABLE IF NOT EXISTS scheduled_runs (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  conversation_id TEXT,
  pending_id TEXT,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  rounds INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_runs_persona
  ON scheduled_runs(persona_id, schedule_id, started_at DESC);

-- M10 spend ledger (PLAN-M10 W3, additive schema v11): cumulative spend per
-- provider for the CURRENT budget window (rolling, default 30 days). One row
-- per provider; the manager rolls the window by resetting cents when the row
-- is older than the window. No secrets — provider ids + cents only.
CREATE TABLE IF NOT EXISTS spend_ledger (
  provider_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  cents INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- M11 F11 folders (PLAN-M11.md, additive schema v12): the conversation
-- organizing tree. Conversations point here via conversations.folder_id
-- (guarded column, C1); NULL = Inbox. Names/edges only — chat content
-- never crosses this table.
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- M11 F1 chat attachments + blobs (PLAN-M11.md, additive schema v12).
-- Payload bytes sit in chat_blobs (deduped by sha256); attachment rows are
-- the per-message edges (NULL message_id = staged pre-turn upload). Owner
-- content never crosses audit.
CREATE TABLE IF NOT EXISTS chat_blobs (
  sha256 TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL DEFAULT 'upload',
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  ref_root_id TEXT,
  ref_path TEXT,
  extract_text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation
  ON attachments(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_message
  ON attachments(message_id, created_at);

-- M11 F10 assets (PLAN-M11.md, additive schema v12): typed saved artifacts
-- per conversation (bodies are owner content).
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_conversation
  ON assets(conversation_id, created_at);

-- M16 F3 note versions (PLAN-M16.md, additive schema v14): one snapshot row
-- per note mutation (seq 1-based per note). Owner content — never audit.
CREATE TABLE IF NOT EXISTS note_versions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  writer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (note_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_note_versions_note
  ON note_versions(note_id, seq DESC);

-- M16 F1 graph canvas positions (PLAN-M16.md, additive schema v14): nodes +
-- edges derive from notes + note_links; this table stores only the user's
-- dragged/auto-arranged x/y per note.
CREATE TABLE IF NOT EXISTS note_graph (
  note_id TEXT PRIMARY KEY,
  x REAL NOT NULL,
  y REAL NOT NULL
);

-- M16 follow-up brainstorm linkage (additive schema v15): one row per
-- brainstorm conversation, keyed by the deterministic set_key of its sorted
-- source note ids, plus the source join table. concluded is owner state:
-- a concluded session is reopened explicitly, never reused implicitly.
-- Owner data (ids/counts only) — never audit.
CREATE TABLE IF NOT EXISTS brainstorm_sessions (
  conversation_id TEXT PRIMARY KEY,
  set_key TEXT NOT NULL,
  concluded INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sessions_set
  ON brainstorm_sessions(set_key, concluded);

CREATE TABLE IF NOT EXISTS brainstorm_sources (
  conversation_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, note_id)
);
CREATE INDEX IF NOT EXISTS idx_brainstorm_sources_note
  ON brainstorm_sources(note_id);

-- M11 F2 MCP servers (PLAN-M11.md, additive schema v12): configured stdio
-- MCP clients. Command/args only; OFF by default. No secrets in this slice.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT NOT NULL,
  args TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** Column projections mapping snake_case storage to camelCase row types. */
const PAIRING_COLUMNS = `
  id, code_hash AS codeHash, expires_at AS expiresAt, attempts,
  locked_until AS lockedUntil, created_at AS createdAt`;

const SESSION_COLUMNS = `
  id, token_hash AS tokenHash, kind, origin, created_at AS createdAt,
  expires_at AS expiresAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt`;

const AUDIT_COLUMNS = `
  id, actor, action, target, details, created_at AS createdAt`;

const PROVIDER_COLUMNS = `
  id, name, kind, source, purpose, endpoint, default_models AS defaultModels,
  enabled, budget_cents AS budgetCents, key_ref AS keyRef,
  last_health AS lastHealth, created_at AS createdAt, updated_at AS updatedAt`;

const PROJECT_ROOT_COLUMNS = `
  id, label, path, read_only AS readOnly, added_at AS addedAt`;

const GRANT_COLUMNS = `
  id, tool_id AS toolId, project_id AS projectId, source,
  created_at AS createdAt, expires_at AS expiresAt, note`;

const PENDING_TOOL_COLUMNS = `
  id, tool_id AS toolId, project_id AS projectId, params, risk,
  requested_by AS requestedBy, created_at AS createdAt,
  decided_at AS decidedAt, decision, decided_by AS decidedBy,
  conversation_id AS conversationId, persona_id AS personaId`;

const FILE_PROPOSAL_COLUMNS = `
  id, project_id AS projectId, path, original_mtime AS originalMtime,
  original_content AS originalContent, proposed_content AS proposedContent,
  created_at AS createdAt, applied_at AS appliedAt, discarded_at AS discardedAt`;

const PERSONA_COLUMNS = `
  id, name, tagline, avatar, color_theme AS colorTheme,
  voice, language, system_prompt AS systemPrompt, temperature,
  task_classes AS taskClasses, fallback_model AS fallbackModel,
  provider_id AS providerId, independence_level AS independenceLevel,
  require_human AS requireHuman, auto_scopes AS autoScopes,
  memory_flags AS memoryFlags, policy, home_folder AS homeFolderId, schedules,
  is_default AS isDefault, paused,
  created_at AS createdAt, updated_at AS updatedAt`;

const CONVERSATION_COLUMNS = `
  id, persona_id AS personaId, title, folder_id AS folderId,
  parent_id AS parentId, source_asset_id AS sourceAssetId,
  created_at AS createdAt, updated_at AS updatedAt`;

const MESSAGE_COLUMNS = `
  id, conversation_id AS conversationId, role, persona_id AS personaId,
  content_type AS contentType, content, model, latency_ms AS latencyMs,
  created_at AS createdAt`;

const PROFILE_COLUMNS = `
  id, kind, key, value, evidence, source, status,
  persona_scope AS personaScope, created_at AS createdAt, updated_at AS updatedAt`;

const EPISODE_COLUMNS = `
  id, conversation_id AS conversationId, persona_id AS personaId,
  title, summary, model, created_at AS createdAt, updated_at AS updatedAt`;

/** snake_case column -> camelCase row key for the whitelisted update patch. */
type ProviderPatchKey =
  | 'name'
  | 'kind'
  | 'source'
  | 'purpose'
  | 'endpoint'
  | 'defaultModels'
  | 'enabled'
  | 'budgetCents'
  | 'keyRef'
  | 'lastHealth';

const PROVIDER_UPDATE_COLUMNS: Readonly<Record<string, ProviderPatchKey>> = {
  name: 'name',
  kind: 'kind',
  source: 'source',
  purpose: 'purpose',
  endpoint: 'endpoint',
  default_models: 'defaultModels',
  enabled: 'enabled',
  budget_cents: 'budgetCents',
  key_ref: 'keyRef',
  last_health: 'lastHealth',
};

const PROFILE_UPDATE_COLUMNS: Readonly<Record<string, keyof ProfileEntryRowPatch>> = {
  kind: 'kind',
  key: 'key',
  value: 'value',
  evidence: 'evidence',
  source: 'source',
  status: 'status',
  persona_scope: 'personaScope',
};

const EPISODE_UPDATE_COLUMNS: Readonly<Record<string, keyof EpisodeRowPatch>> = {
  persona_id: 'personaId',
  title: 'title',
  summary: 'summary',
  model: 'model',
};

/**
 * Assert the bundled SQLite has FTS5 (PLAN-M4): run a trivial probe and
 * throw a CLEAR error when the module is missing so a deployment surfaces
 * the reason instead of a cryptic CREATE VIRTUAL TABLE failure.
 */
export function assertFts5(db: Database.Database): void {
  try {
    db.exec('CREATE VIRTUAL TABLE __partner_fts5_probe USING fts5(x)');
    db.exec('DROP TABLE __partner_fts5_probe');
  } catch {
    throw new Error(
      'M4 memory search needs SQLite FTS5, but this build of better-sqlite3 has no FTS5 ' +
        'support — rebuild it against a full SQLite build or bundle one with FTS5 enabled',
    );
  }
}

const FOLDER_COLUMNS = `
  id, name, parent_id AS parentId, position,
  created_at AS createdAt, updated_at AS updatedAt`;

/**
 * M11 (PLAN-M11 C1) guarded additive columns on v1-era tables. Schema is
 * otherwise additive-only (CREATE TABLE IF NOT EXISTS), so existing file DBs
 * never gained a column — these four are added idempotently on every open
 * via ensureColumn. Kept in one place so the migration surface is auditable.
 */
const M11_GUARDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, ddl: string]> = [
  // Persona capability policy (F3): {skills:{default,banned},tools:{allowed,banned}}.
  ['personas', 'policy', 'policy TEXT'],
  // Persona home folder (D10): new chats for this persona auto-land here.
  ['personas', 'home_folder', 'home_folder TEXT'],
  // M14 schedules (PLAN-M14.md): independence.schedules[] JSON array.
  ['personas', 'schedules', 'schedules TEXT'],
  // Provider purpose tag (F4). Legacy rows read as 'general'.
  ['providers', 'purpose', "purpose TEXT NOT NULL DEFAULT 'general'"],
  // Chat folder binding (F11); NULL = Inbox.
  ['conversations', 'folder_id', 'folder_id TEXT'],
  // M16 F4 discuss lineage (PLAN-M16.md); NULL = top-level discussion.
  ['conversations', 'parent_id', 'parent_id TEXT'],
  ['conversations', 'source_asset_id', 'source_asset_id TEXT'],
  // Message payload kind (C2): 'text' | 'parts'. Legacy rows read as 'text'.
  ['messages', 'content_type', "content_type TEXT NOT NULL DEFAULT 'text'"],
  // M12 search approvals: external-tool (web search) queue rows carry the
  // conversation to post the outcome note into + the requesting persona.
  ['pending_tools', 'conversation_id', 'conversation_id TEXT'],
  ['pending_tools', 'persona_id', 'persona_id TEXT'],
];

/**
 * Idempotently add one column to an existing table. Safe on every open:
 * PRAGMA table_info guards, ALTER runs only when the column is missing.
 * Table/column/ddl come from this module's own constants (never user input).
 */
export function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function applySchema(db: Database.Database): void {
  assertFts5(db);
  db.exec(SCHEMA_SQL);
  for (const [table, column, ddl] of M11_GUARDED_COLUMNS) {
    ensureColumn(db, table, column, ddl);
  }
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(META_SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
}

export { applySchema };

/**
 * Open (creating parent directories as needed) and migrate a database.
 * `location` is ':memory:' or a file path.
 */
export function openDatabase(location: string): Database.Database {
  if (location !== ':memory:') {
    mkdirSync(dirname(location), { recursive: true });
  }
  const db = new Database(location);
  db.pragma('journal_mode = WAL');
  applySchema(db);
  return db;
}

/**
 * Open a LIVE-mode file database with whole-file encryption (M10 W1,
 * Decision A: `better-sqlite3` is aliased to the SQLCipher-compatible
 * better-sqlite3-multiple-ciphers fork; the key pragma uses the 32-byte hex
 * form so no SQLCipher KDF is involved).
 *
 * - A NEW (or empty) file is created encrypted with `keyHex`.
 * - An EXISTING PLAINTEXT Partner DB is refused with a migration message
 *   (the cipher open of plaintext yields "file is not a database", so this
 *   function pre-detects it with a plain open + schema probe).
 * - A wrong key / non-Partner file fails with a clear error.
 * `:memory:` is never encrypted here (demo/tests unchanged) — callers must
 * not pass it.
 */
export function openEncryptedDatabase(location: string, keyHex: string): Database.Database {
  if (location === ':memory:') {
    throw new Error('openEncryptedDatabase requires a file path (never :memory:)');
  }
  if (!/^[0-9a-f]{64}$/.test(keyHex)) {
    throw new Error('openEncryptedDatabase requires a 64-char hex key (32 bytes)');
  }
  mkdirSync(dirname(location), { recursive: true });
  const existed = existsSync(location) && statSync(location).size > 0;
  const db = new Database(location);
  const probe = (): boolean => {
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return true;
    } catch {
      return false;
    }
  };
  if (!existed) {
    // Fresh file: key it BEFORE anything can be written.
    db.pragma(`key = "x'${keyHex}'"`);
    db.pragma('journal_mode = WAL');
    applySchema(db);
    return db;
  }
  // Existing file: try the KEYED open first (an SQLCipher file without its
  // key can masquerade as readable plaintext, so the keyed probe decides).
  db.pragma(`key = "x'${keyHex}'"`);
  if (probe()) {
    db.pragma('journal_mode = WAL');
    applySchema(db);
    return db;
  }
  db.close();
  // Keyed open failed. Re-probe WITHOUT a key to tell a pre-M10 PLAINTEXT
  // Partner DB (migration required) from a wrong-key/corrupt file.
  const plain = new Database(location);
  let plaintextOk = false;
  try {
    plain.prepare('SELECT count(*) FROM sqlite_master').get();
    plaintextOk = true;
  } catch {
    plaintextOk = false;
  }
  if (plaintextOk) {
    let partner = false;
    try {
      partner =
        plain
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() !== undefined;
    } catch {
      partner = false;
    }
    plain.close();
    if (partner) {
      throw new Error(
        `plaintext Partner database detected at ${location} — M10 requires ` +
          'encryption at rest. Export your data or remove the file to start fresh ' +
          '(see docs/migrate-plaintext.md).',
      );
    }
    throw new Error(`refusing to open ${location}: not a Partner database`);
  }
  plain.close();
  throw new Error(
    `unable to open ${location}: wrong database key, or the file is not an ` +
      'encrypted Partner database',
  );
}

export function createPairingStore(db: Database.Database): PairingStore {
  const insert = db.prepare(
    'INSERT INTO pairings (code_hash, expires_at, attempts, locked_until, created_at) VALUES (?, ?, 0, NULL, ?)',
  );
  const find = db.prepare(`SELECT ${PAIRING_COLUMNS} FROM pairings WHERE code_hash = ?`);
  const latest = db.prepare(`SELECT ${PAIRING_COLUMNS} FROM pairings ORDER BY id DESC LIMIT 1`);
  const updateAttempts = db.prepare(
    'UPDATE pairings SET attempts = ?, locked_until = ? WHERE id = ?',
  );
  const removeAll = db.prepare('DELETE FROM pairings');
  const remove = db.prepare('DELETE FROM pairings WHERE code_hash = ?');

  return {
    removeAll(): void {
      removeAll.run();
    },
    insert(codeHash, createdAt, expiresAt): number {
      const info = insert.run(codeHash, expiresAt, createdAt);
      return Number(info.lastInsertRowid);
    },
    findByCodeHash(codeHash: string): PairingRow | undefined {
      return find.get(codeHash) as PairingRow | undefined;
    },
    getLatest(): PairingRow | undefined {
      return latest.get() as PairingRow | undefined;
    },
    updateAttempts(id: number, attempts: number, lockedUntil: number | null): void {
      updateAttempts.run(attempts, lockedUntil, id);
    },
    removeByCodeHash(codeHash: string): void {
      remove.run(codeHash);
    },
  };
}

export function createSessionStore(db: Database.Database): SessionStore {
  const insert = db.prepare(
    `INSERT INTO sessions (token_hash, kind, origin, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const find = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = ?`);
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
  const revoke = db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?');

  return {
    insert(tokenHash, kind, origin, createdAt, expiresAt, lastSeenAt): number {
      const info = insert.run(tokenHash, kind, origin, createdAt, expiresAt, lastSeenAt);
      return Number(info.lastInsertRowid);
    },
    findByTokenHash(tokenHash: string): SessionRow | undefined {
      return find.get(tokenHash) as SessionRow | undefined;
    },
    touch(id: number, at: number): void {
      touch.run(at, id);
    },
    revoke(id: number, at: number): void {
      revoke.run(at, id);
    },
  };
}

export function createAuditStore(db: Database.Database): AuditStore {
  const insert = db.prepare(
    'INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const list = db.prepare(
    `SELECT ${AUDIT_COLUMNS} FROM audit_log ORDER BY id DESC LIMIT ?`,
  );

  return {
    add(actor, action, target, details, createdAt): number {
      const info = insert.run(actor, action, target, details, createdAt);
      return Number(info.lastInsertRowid);
    },
    list(limit: number): AuditRow[] {
      return list.all(limit) as AuditRow[];
    },
    listFiltered(query: AuditQuery): AuditRow[] {
      const clauses: string[] = [];
      const args: unknown[] = [];
      if (query.actor !== undefined && query.actor !== '') {
        clauses.push('actor = ?');
        args.push(query.actor);
      }
      if (query.action !== undefined && query.action !== '') {
        // Substring match (instr avoids LIKE-escape pitfalls on action ids).
        clauses.push('instr(action, ?) > 0');
        args.push(query.action);
      }
      if (query.q !== undefined && query.q !== '') {
        clauses.push('(instr(target, ?) > 0 OR instr(details, ?) > 0)');
        args.push(query.q, query.q);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      const sql = `SELECT ${AUDIT_COLUMNS} FROM audit_log${where} ORDER BY id DESC LIMIT ?`;
      args.push(query.limit);
      return (db.prepare(sql).all(...(args as never[])) as AuditRow[]) ?? [];
    },
  };
}

export function createSettingsStore(db: Database.Database): SettingsStore {
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  return {
    get(key: string): string | null {
      const row = get.get(key) as { value: string | null } | undefined;
      return row?.value ?? null;
    },
    set(key: string, value: string, updatedAt: number): void {
      upsert.run(key, value, updatedAt);
    },
  };
}

/**
 * M1 provider row store (PLAN-M1.md). Plain CRUD with NO business logic —
 * the provider manager owns validation, keychain coordination, and health
 * probing. No key material ever crosses this interface.
 */
export function createProviderStore(db: Database.Database): ProviderStore {
  const insert = db.prepare(
    `INSERT INTO providers (id, name, kind, source, purpose, endpoint, default_models, enabled,
                            budget_cents, key_ref, last_health, created_at, updated_at)
     VALUES (@id, @name, @kind, @source, @purpose, @endpoint, @defaultModels, @enabled,
             @budgetCents, @keyRef, @lastHealth, @createdAt, @updatedAt)`,
  );
  const findById = db.prepare(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE id = ?`);
  const listAll = db.prepare(
    `SELECT ${PROVIDER_COLUMNS} FROM providers ORDER BY created_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM providers WHERE id = ?');
  const touch = db.prepare('UPDATE providers SET updated_at = ? WHERE id = ?');

  return {
    insert(row: ProviderRow): void {
      insert.run({ ...row });
    },
    findById(id: string): ProviderRow | undefined {
      return findById.get(id) as ProviderRow | undefined;
    },
    list(): ProviderRow[] {
      return listAll.all() as ProviderRow[];
    },
    update(id: string, patch: ProviderRowPatch): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { updatedAt: patch.updatedAt };
      for (const [column, key] of Object.entries(PROVIDER_UPDATE_COLUMNS)) {
        if (patch[key] !== undefined) {
          sets.push(`${column} = @${key}`);
          params[key] = patch[key];
        }
      }
      if (sets.length === 0) {
        touch.run(patch.updatedAt, id);
        return;
      }
      params.id = id;
      db.prepare(
        `UPDATE providers SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`,
      ).run(params);
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}

/**
 * M2 project-root row store. Plain CRUD; path canonicalization/validation
 * belongs to the root manager (broker/roots.ts).
 */
export function createProjectRootStore(db: Database.Database): ProjectRootStore {
  const insert = db.prepare(
    `INSERT INTO project_roots (id, label, path, read_only, added_at)
     VALUES (@id, @label, @path, @readOnly, @addedAt)`,
  );
  const findById = db.prepare(`SELECT ${PROJECT_ROOT_COLUMNS} FROM project_roots WHERE id = ?`);
  const findByPath = db.prepare(`SELECT ${PROJECT_ROOT_COLUMNS} FROM project_roots WHERE path = ?`);
  const listAll = db.prepare(
    `SELECT ${PROJECT_ROOT_COLUMNS} FROM project_roots ORDER BY added_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM project_roots WHERE id = ?');

  return {
    insert(row: ProjectRootRow): void {
      insert.run({ ...row });
    },
    findById(id: string): ProjectRootRow | undefined {
      return findById.get(id) as ProjectRootRow | undefined;
    },
    findByPath(path: string): ProjectRootRow | undefined {
      return findByPath.get(path) as ProjectRootRow | undefined;
    },
    list(): ProjectRootRow[] {
      return listAll.all() as ProjectRootRow[];
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}

/**
 * M2 grant row store (tool x project allow-list). Expiry is enforced by the
 * grant manager at read time; this store is plain CRUD.
 */
export function createGrantStore(db: Database.Database): GrantStore {
  const insert = db.prepare(
    `INSERT INTO grants (id, tool_id, project_id, source, created_at, expires_at, note)
     VALUES (@id, @toolId, @projectId, @source, @createdAt, @expiresAt, @note)`,
  );
  const findById = db.prepare(`SELECT ${GRANT_COLUMNS} FROM grants WHERE id = ?`);
  const listAll = db.prepare(
    `SELECT ${GRANT_COLUMNS} FROM grants ORDER BY created_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM grants WHERE id = ?');

  return {
    insert(row: GrantRow): void {
      insert.run({ ...row });
    },
    findById(id: string): GrantRow | undefined {
      return findById.get(id) as GrantRow | undefined;
    },
    list(): GrantRow[] {
      return listAll.all() as GrantRow[];
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}

/**
 * M2 approval-queue row store. `params` is a pre-serialized JSON string;
 * open/closed semantics live in the pending manager (broker/pending.ts).
 */
export function createPendingToolStore(db: Database.Database): PendingToolStore {
  const insert = db.prepare(
    `INSERT INTO pending_tools (id, tool_id, project_id, params, risk, requested_by, created_at, conversation_id, persona_id)
     VALUES (@id, @toolId, @projectId, @params, @risk, @requestedBy, @createdAt, @conversationId, @personaId)`,
  );
  const findById = db.prepare(`SELECT ${PENDING_TOOL_COLUMNS} FROM pending_tools WHERE id = ?`);
  const listOpen = db.prepare(
    `SELECT ${PENDING_TOOL_COLUMNS} FROM pending_tools
     WHERE decided_at IS NULL ORDER BY created_at ASC, rowid ASC`,
  );
  const updateDecision = db.prepare(
    'UPDATE pending_tools SET decided_at = ?, decision = ?, decided_by = ? WHERE id = ?',
  );

  return {
    insert(row: PendingToolRow): void {
      insert.run({ ...row });
    },
    findById(id: string): PendingToolRow | undefined {
      return findById.get(id) as PendingToolRow | undefined;
    },
    listOpen(): PendingToolRow[] {
      return listOpen.all() as PendingToolRow[];
    },
    updateDecision(id: string, decidedAt: number, decision: string, decidedBy: string): void {
      updateDecision.run(decidedAt, decision, decidedBy, id);
    },
  };
}

/**
 * M2 file-proposal row store (write-preview diffs). Content is stored here
 * BY DESIGN (diff survives restarts) but never crosses audit/logs/responses
 * beyond the explicit GET-proposal payload.
 */
export function createFileProposalStore(db: Database.Database): FileProposalStore {
  const insert = db.prepare(
    `INSERT INTO file_proposals (id, project_id, path, original_mtime, original_content,
                                 proposed_content, created_at)
     VALUES (@id, @projectId, @path, @originalMtime, @originalContent,
             @proposedContent, @createdAt)`,
  );
  const findById = db.prepare(`SELECT ${FILE_PROPOSAL_COLUMNS} FROM file_proposals WHERE id = ?`);
  const listOpen = db.prepare(
    `SELECT ${FILE_PROPOSAL_COLUMNS} FROM file_proposals
     WHERE applied_at IS NULL AND discarded_at IS NULL ORDER BY created_at DESC, rowid DESC`,
  );
  const apply = db.prepare('UPDATE file_proposals SET applied_at = ? WHERE id = ?');
  const discard = db.prepare('UPDATE file_proposals SET discarded_at = ? WHERE id = ?');

  return {
    insert(row: FileProposalRow): void {
      insert.run({ ...row });
    },
    findById(id: string): FileProposalRow | undefined {
      return findById.get(id) as FileProposalRow | undefined;
    },
    listOpen(): FileProposalRow[] {
      return listOpen.all() as FileProposalRow[];
    },
    markApplied(id: string, at: number): void {
      apply.run(at, id);
    },
    markDiscarded(id: string, at: number): void {
      discard.run(at, id);
    },
  };
}

// ---------------------------------------------------------------------------
// M3 row stores (PLAN-M3.md — additive schema v4). Plain typed CRUD with NO
// business logic; the persona manager owns validation/defaults/seed and the
// conversation manager owns persona binding, message ordering and cascades.
// Stores never read the clock: writes take explicit timestamps.
// ---------------------------------------------------------------------------

const PERSONA_UPDATE_COLUMNS: Readonly<Record<string, keyof PersonaRowPatch>> = {
  name: 'name',
  tagline: 'tagline',
  avatar: 'avatar',
  color_theme: 'colorTheme',
  voice: 'voice',
  language: 'language',
  system_prompt: 'systemPrompt',
  temperature: 'temperature',
  task_classes: 'taskClasses',
  fallback_model: 'fallbackModel',
  provider_id: 'providerId',
  independence_level: 'independenceLevel',
  require_human: 'requireHuman',
  auto_scopes: 'autoScopes',
  schedules: 'schedules',
  memory_flags: 'memoryFlags',
  policy: 'policy',
  home_folder: 'homeFolderId',
  is_default: 'isDefault',
  paused: 'paused',
};

export function createPersonaStore(db: Database.Database): PersonaStore {
  const insert = db.prepare(
    `INSERT INTO personas (id, name, tagline, avatar, color_theme, voice, language,
                           system_prompt, temperature, task_classes, fallback_model,
                           provider_id, independence_level, require_human, auto_scopes,
                           memory_flags, policy, home_folder, schedules, is_default, paused,
                           created_at, updated_at)
     VALUES (@id, @name, @tagline, @avatar, @colorTheme, @voice, @language,
             @systemPrompt, @temperature, @taskClasses, @fallbackModel,
             @providerId, @independenceLevel, @requireHuman, @autoScopes,
             @memoryFlags, @policy, @homeFolderId, @schedules, @isDefault, @paused,
             @createdAt, @updatedAt)`,
  );
  const findById = db.prepare(`SELECT ${PERSONA_COLUMNS} FROM personas WHERE id = ?`);
  const listAll = db.prepare(
    `SELECT ${PERSONA_COLUMNS} FROM personas ORDER BY created_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM personas WHERE id = ?');
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM personas');

  return {
    insert(row: PersonaRow): void {
      insert.run({ ...row });
    },
    findById(id: string): PersonaRow | undefined {
      return findById.get(id) as PersonaRow | undefined;
    },
    list(): PersonaRow[] {
      return listAll.all() as PersonaRow[];
    },
    update(id: string, patch: PersonaRowPatch): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { updatedAt: patch.updatedAt };
      for (const [column, key] of Object.entries(PERSONA_UPDATE_COLUMNS)) {
        if (patch[key as keyof PersonaRowPatch] !== undefined) {
          sets.push(`${column} = @${String(key)}`);
          params[String(key)] = patch[key as keyof PersonaRowPatch];
        }
      }
      if (sets.length === 0) {
        db.prepare('UPDATE personas SET updated_at = ? WHERE id = ?').run(patch.updatedAt, id);
        return;
      }
      params.id = id;
      db.prepare(
        `UPDATE personas SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`,
      ).run(params);
    },
    remove(id: string): void {
      remove.run(id);
    },
    count(): number {
      const row = countAll.get() as { n: number };
      return row.n;
    },
  };
}

export function createConversationStore(db: Database.Database): ConversationStore {
  const insert = db.prepare(
    `INSERT INTO conversations
       (id, persona_id, title, folder_id, parent_id, source_asset_id, created_at, updated_at)
     VALUES (@id, @personaId, @title, @folderId, @parentId, @sourceAssetId, @createdAt, @updatedAt)`,
  );
  const findById = db.prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`);
  const listAll = db.prepare(
    `SELECT ${CONVERSATION_COLUMNS} FROM conversations
     ORDER BY updated_at DESC, rowid DESC`,
  );
  const remove = db.prepare('DELETE FROM conversations WHERE id = ?');

  return {
    insert(row: ConversationRow): void {
      insert.run({
        id: row.id,
        personaId: row.personaId,
        title: row.title,
        folderId: row.folderId,
        parentId: row.parentId ?? null,
        sourceAssetId: row.sourceAssetId ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    },
    findById(id: string): ConversationRow | undefined {
      return findById.get(id) as ConversationRow | undefined;
    },
    list(): ConversationRow[] {
      return listAll.all() as ConversationRow[];
    },
    update(id: string, patch: ConversationRowPatch): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { updatedAt: patch.updatedAt };
      if (patch.title !== undefined) {
        sets.push('title = @title');
        params.title = patch.title;
      }
      if (patch.personaId !== undefined) {
        sets.push('persona_id = @personaId');
        params.personaId = patch.personaId;
      }
      if (patch.folderId !== undefined) {
        sets.push('folder_id = @folderId');
        params.folderId = patch.folderId;
      }
      if (patch.parentId !== undefined) {
        sets.push('parent_id = @parentId');
        params.parentId = patch.parentId;
      }
      if (patch.sourceAssetId !== undefined) {
        sets.push('source_asset_id = @sourceAssetId');
        params.sourceAssetId = patch.sourceAssetId;
      }
      if (sets.length === 0) {
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(patch.updatedAt, id);
        return;
      }
      params.id = id;
      db.prepare(
        `UPDATE conversations SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`,
      ).run(params);
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}

export function createMessageStore(db: Database.Database): MessageStore {
  const insert = db.prepare(
    `INSERT INTO messages (id, conversation_id, role, persona_id, content_type, content,
                           model, latency_ms, created_at)
     VALUES (@id, @conversationId, @role, @personaId, @contentType, @content, @model,
             @latencyMs, @createdAt)`,
  );
  const findById = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`);
  const listByConversation = db.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ?
     ORDER BY created_at ASC, rowid ASC`,
  );
  const countByConversation = db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
  );
  const countsAll = db.prepare(
    'SELECT conversation_id AS conversationId, COUNT(*) AS count FROM messages GROUP BY conversation_id',
  );
  const removeByConversation = db.prepare('DELETE FROM messages WHERE conversation_id = ?');

  return {
    insert(row: MessageRow): void {
      insert.run({ ...row });
    },
    findById(id: string): MessageRow | undefined {
      return findById.get(id) as MessageRow | undefined;
    },
    listByConversation(conversationId: string): MessageRow[] {
      return listByConversation.all(conversationId) as MessageRow[];
    },
    countByConversation(conversationId: string): number {
      const row = countByConversation.get(conversationId) as { n: number };
      return row.n;
    },
    countsByConversation(): Array<{ conversationId: string; count: number }> {
      return countsAll.all() as Array<{ conversationId: string; count: number }>;
    },
    removeByConversation(conversationId: string): void {
      removeByConversation.run(conversationId);
    },
  };
}

// ---------------------------------------------------------------------------
// M4 row stores (PLAN-M4.md — additive schema v5). Plain typed CRUD with NO
// business logic; the memory managers (core/src/memory/*) own validation,
// status rules, the FTS mirror, forgetting, export/import and audit. Stores
// never read the clock: writes take explicit timestamps. The factories keep
// the PLAN-M4 names (createProfileStore for the profile_entries table, row
// type ProfileEntryRow) so audits/tests can match the spec verbatim.
// ---------------------------------------------------------------------------

export function createProfileStore(db: Database.Database): ProfileEntryStore {
  const insert = db.prepare(
    `INSERT INTO profile_entries (id, kind, key, value, evidence, source, status,
                                  persona_scope, created_at, updated_at)
     VALUES (@id, @kind, @key, @value, @evidence, @source, @status,
             @personaScope, @createdAt, @updatedAt)`,
  );
  const findById = db.prepare(`SELECT ${PROFILE_COLUMNS} FROM profile_entries WHERE id = ?`);
  const listAll = db.prepare(
    `SELECT ${PROFILE_COLUMNS} FROM profile_entries ORDER BY created_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM profile_entries WHERE id = ?');

  return {
    insert(row: ProfileEntryRow): void {
      insert.run({ ...row });
    },
    findById(id: string): ProfileEntryRow | undefined {
      return findById.get(id) as ProfileEntryRow | undefined;
    },
    list(): ProfileEntryRow[] {
      return listAll.all() as ProfileEntryRow[];
    },
    update(id: string, patch: ProfileEntryRowPatch): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { updatedAt: patch.updatedAt };
      for (const [column, key] of Object.entries(PROFILE_UPDATE_COLUMNS)) {
        const value = patch[key as keyof ProfileEntryRowPatch];
        if (value !== undefined) {
          sets.push(`${column} = @${String(key)}`);
          params[String(key)] = value;
        }
      }
      if (sets.length === 0) {
        db.prepare('UPDATE profile_entries SET updated_at = ? WHERE id = ?').run(
          patch.updatedAt,
          id,
        );
        return;
      }
      params.id = id;
      db.prepare(
        `UPDATE profile_entries SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`,
      ).run(params);
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}

export function createEpisodeStore(db: Database.Database): EpisodeStore {
  const insert = db.prepare(
    `INSERT INTO episodes (id, conversation_id, persona_id, title, summary, model,
                           created_at, updated_at)
     VALUES (@id, @conversationId, @personaId, @title, @summary, @model,
             @createdAt, @updatedAt)`,
  );
  const findById = db.prepare(`SELECT ${EPISODE_COLUMNS} FROM episodes WHERE id = ?`);
  const findByConversationId = db.prepare(
    `SELECT ${EPISODE_COLUMNS} FROM episodes WHERE conversation_id = ?`,
  );
  const listAll = db.prepare(
    `SELECT ${EPISODE_COLUMNS} FROM episodes ORDER BY created_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM episodes WHERE id = ?');

  return {
    insert(row: EpisodeRow): void {
      insert.run({ ...row });
    },
    findById(id: string): EpisodeRow | undefined {
      return findById.get(id) as EpisodeRow | undefined;
    },
    findByConversationId(conversationId: string): EpisodeRow | undefined {
      return findByConversationId.get(conversationId) as EpisodeRow | undefined;
    },
    list(): EpisodeRow[] {
      return listAll.all() as EpisodeRow[];
    },
    update(id: string, patch: EpisodeRowPatch): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { updatedAt: patch.updatedAt };
      for (const [column, key] of Object.entries(EPISODE_UPDATE_COLUMNS)) {
        const value = patch[key as keyof EpisodeRowPatch];
        if (value !== undefined) {
          sets.push(`${column} = @${String(key)}`);
          params[String(key)] = value;
        }
      }
      if (sets.length === 0) {
        db.prepare('UPDATE episodes SET updated_at = ? WHERE id = ?').run(patch.updatedAt, id);
        return;
      }
      params.id = id;
      db.prepare(
        `UPDATE episodes SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`,
      ).run(params);
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}

/** FTS5 mirror helpers over the memory_fts virtual table (PLAN-M4). */
export function createMemoryFtsStore(db: Database.Database): MemoryFtsStore {
  const insert = db.prepare(
    'INSERT INTO memory_fts (episode_ref, profile_ref, content) VALUES (?, ?, ?)',
  );
  const deleteProfileRef = db.prepare('DELETE FROM memory_fts WHERE profile_ref = ?');
  const deleteEpisodeRef = db.prepare('DELETE FROM memory_fts WHERE episode_ref = ?');
  const matchQuery = db.prepare(
    `SELECT
       CASE WHEN profile_ref IS NOT NULL THEN 'profile' ELSE 'episode' END AS kind,
       COALESCE(profile_ref, episode_ref) AS refId,
       bm25(memory_fts) AS rank
     FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank ASC LIMIT ?`,
  );

  return {
    upsertProfile(id: string, content: string): void {
      deleteProfileRef.run(id);
      insert.run(null, id, content);
    },
    upsertEpisode(id: string, content: string): void {
      deleteEpisodeRef.run(id);
      insert.run(id, null, content);
    },
    deleteRef(kind: MemoryRefKind, id: string): void {
      if (kind === 'profile') deleteProfileRef.run(id);
      else deleteEpisodeRef.run(id);
    },
    match(query: string, limit: number): MemoryFtsHit[] {
      const rows = matchQuery.all(query, limit) as Array<{
        kind: MemoryRefKind;
        refId: string;
        rank: number;
      }>;
      return rows.map((row) => ({ kind: row.kind, refId: row.refId, rank: row.rank }));
    },
  };
}

// ---------------------------------------------------------------------------
// M5 notes + plans row stores (PLAN-M5.md — additive schema v6). Plain typed
// CRUD with NO business logic; the managers (core/src/notes/manager.ts,
// core/src/plans/manager.ts) own wiki-link parsing/resolution, tags, the
// daily-note rule, document shape validation, the notes_fts mirror and
// audit. Stores never read the clock: writes take explicit timestamps.
// ---------------------------------------------------------------------------

const NOTE_COLUMNS = `
  id, title, content, tags, is_daily AS isDaily,
  created_at AS createdAt, updated_at AS updatedAt`;

const NOTE_LINK_COLUMNS = `
  from_note AS fromNote, to_note AS toNote, to_title AS toTitle`;

const NOTE_VERSION_COLUMNS = `
  id, note_id AS noteId, seq, title, content, tags, writer,
  created_at AS createdAt`;

const PLAN_COLUMNS = `
  id, title, description, document,
  created_at AS createdAt, updated_at AS updatedAt`;

const NOTE_UPDATE_COLUMNS: Readonly<Record<string, keyof NoteRowPatch>> = {
  title: 'title',
  content: 'content',
  tags: 'tags',
  is_daily: 'isDaily',
};

const PLAN_UPDATE_COLUMNS: Readonly<Record<string, keyof PlanRowPatch>> = {
  title: 'title',
  description: 'description',
  document: 'document',
};

export function createNoteStore(db: Database.Database): NoteStore {
  const insert = db.prepare(
    `INSERT INTO notes (id, title, content, tags, is_daily, created_at, updated_at)
     VALUES (@id, @title, @content, @tags, @isDaily, @createdAt, @updatedAt)`,
  );
  const findById = db.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`);
  const findIdByTitle = db.prepare(
    'SELECT id FROM notes WHERE title = ? COLLATE NOCASE ORDER BY created_at ASC, rowid ASC LIMIT 1',
  );
  const listAll = db.prepare(
    `SELECT ${NOTE_COLUMNS} FROM notes ORDER BY created_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM notes WHERE id = ?');

  return {
    insert(row: NoteRow): void {
      insert.run({ ...row });
    },
    findById(id: string): NoteRow | undefined {
      return findById.get(id) as NoteRow | undefined;
    },
    findIdByTitle(title: string): string | undefined {
      const row = findIdByTitle.get(title) as { id: string } | undefined;
      return row?.id;
    },
    list(): NoteRow[] {
      return listAll.all() as NoteRow[];
    },
    update(id: string, patch: NoteRowPatch): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { updatedAt: patch.updatedAt };
      for (const [column, key] of Object.entries(NOTE_UPDATE_COLUMNS)) {
        const value = patch[key as keyof NoteRowPatch];
        if (value !== undefined) {
          sets.push(`${column} = @${String(key)}`);
          params[String(key)] = value;
        }
      }
      if (sets.length === 0) {
        db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(patch.updatedAt, id);
        return;
      }
      params.id = id;
      db.prepare(
        `UPDATE notes SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`,
      ).run(params);
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}

export function createNoteLinkStore(db: Database.Database): NoteLinkStore {
  const insertOne = db.prepare(
    `INSERT OR IGNORE INTO note_links (from_note, to_note, to_title)
     VALUES (@fromNote, @toNote, @toTitle)`,
  );
  const removeForNote = db.prepare('DELETE FROM note_links WHERE from_note = ?');
  const listFrom = db.prepare(
    `SELECT ${NOTE_LINK_COLUMNS} FROM note_links
     WHERE from_note = ? ORDER BY to_title ASC, rowid ASC`,
  );
  const linkingTo = db.prepare(
    `SELECT DISTINCT from_note AS fromNote FROM note_links
     WHERE to_note = ? OR to_title = ? ORDER BY fromNote ASC`,
  );

  return {
    replaceForNote(
      fromNote: string,
      links: ReadonlyArray<{ toNote: string | null; toTitle: string }>,
    ): void {
      const tx = db.transaction(() => {
        removeForNote.run(fromNote);
        for (const link of links) {
          insertOne.run({ fromNote, toNote: link.toNote, toTitle: link.toTitle });
        }
      });
      tx();
    },
    removeForNote(fromNote: string): void {
      removeForNote.run(fromNote);
    },
    listFrom(fromNote: string): NoteLinkRow[] {
      return listFrom.all(fromNote) as NoteLinkRow[];
    },
    listLinkingTo(noteId: string, title: string): string[] {
      const rows = linkingTo.all(noteId, title) as Array<{ fromNote: string }>;
      return rows.map((r) => r.fromNote);
    },
  };
}

export function createNoteVersionStore(db: Database.Database): NoteVersionStore {
  const insert = db.prepare(
    `INSERT INTO note_versions (id, note_id, seq, title, content, tags, writer, created_at)
     VALUES (@id, @noteId, @seq, @title, @content, @tags, @writer, @createdAt)`,
  );
  const listForNote = db.prepare(
    `SELECT ${NOTE_VERSION_COLUMNS} FROM note_versions
     WHERE note_id = ? ORDER BY seq DESC, rowid DESC`,
  );
  const maxSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM note_versions WHERE note_id = ?',
  );
  const find = db.prepare(
    `SELECT ${NOTE_VERSION_COLUMNS} FROM note_versions WHERE note_id = ? AND id = ?`,
  );
  const prune = db.prepare(
    `DELETE FROM note_versions WHERE note_id = ? AND seq <= ?`,
  );
  const removeForNote = db.prepare('DELETE FROM note_versions WHERE note_id = ?');

  return {
    insert(row: NoteVersionRow): void {
      insert.run({ ...row });
    },
    listForNote(noteId: string): NoteVersionRow[] {
      return listForNote.all(noteId) as NoteVersionRow[];
    },
    maxSeq(noteId: string): number {
      const row = maxSeq.get(noteId) as { maxSeq: number };
      return row.maxSeq;
    },
    find(noteId: string, versionId: string): NoteVersionRow | undefined {
      return find.get(noteId, versionId) as NoteVersionRow | undefined;
    },
    prune(noteId: string, keep: number): void {
      const max = maxSeq.get(noteId) as { maxSeq: number };
      if (max.maxSeq > keep) prune.run(noteId, max.maxSeq - keep);
    },
    removeForNote(noteId: string): void {
      removeForNote.run(noteId);
    },
  };
}

export function createBrainstormSessionStore(db: Database.Database): BrainstormSessionStore {
  const insertSession = db.prepare(
    `INSERT INTO brainstorm_sessions
       (conversation_id, set_key, concluded, used, truncated, created_at, updated_at)
     VALUES
       (@conversationId, @setKey, @concluded, @used, @truncated, @createdAt, @updatedAt)`,
  );
  const insertSource = db.prepare(
    'INSERT OR IGNORE INTO brainstorm_sources (conversation_id, note_id) VALUES (?, ?)',
  );
  const deleteSources = db.prepare('DELETE FROM brainstorm_sources WHERE conversation_id = ?');
  const findSession = db.prepare(
    `SELECT conversation_id AS conversationId, set_key AS setKey, concluded, used, truncated,
            created_at AS createdAt, updated_at AS updatedAt
     FROM brainstorm_sessions WHERE conversation_id = ?`,
  );
  const listBySetKey = db.prepare(
    `SELECT conversation_id AS conversationId, set_key AS setKey, concluded, used, truncated,
            created_at AS createdAt, updated_at AS updatedAt
     FROM brainstorm_sessions WHERE set_key = ? ORDER BY updated_at DESC, rowid DESC`,
  );
  const listSessions = db.prepare(
    `SELECT conversation_id AS conversationId, set_key AS setKey, concluded, used, truncated,
            created_at AS createdAt, updated_at AS updatedAt
     FROM brainstorm_sessions ORDER BY updated_at DESC, rowid DESC`,
  );
  const listSources = db.prepare(
    'SELECT note_id AS noteId FROM brainstorm_sources WHERE conversation_id = ? ORDER BY rowid ASC',
  );
  const listConversationsForNote = db.prepare(
    'SELECT conversation_id AS conversationId FROM brainstorm_sources WHERE note_id = ?',
  );
  const setConcluded = db.prepare(
    'UPDATE brainstorm_sessions SET concluded = ?, updated_at = ? WHERE conversation_id = ?',
  );
  const removeSession = db.prepare('DELETE FROM brainstorm_sessions WHERE conversation_id = ?');
  const removeNoteSource = db.prepare('DELETE FROM brainstorm_sources WHERE note_id = ?');

  /** SQLite stores booleans as 0/1 — normalize at the row boundary. */
  function normalize(row: Record<string, unknown> | undefined): BrainstormSessionRow | undefined {
    if (row === undefined) return undefined;
    return { ...(row as unknown as BrainstormSessionRow), concluded: row.concluded === 1 };
  }

  return {
    insert(row: BrainstormSessionRow): void {
      insertSession.run({ ...row, concluded: row.concluded ? 1 : 0 });
    },
    setSources(conversationId: string, noteIds: readonly string[]): void {
      const tx = db.transaction(() => {
        deleteSources.run(conversationId);
        for (const noteId of noteIds) insertSource.run(conversationId, noteId);
      });
      tx();
    },
    findByConversation(conversationId: string): BrainstormSessionRow | undefined {
      return normalize(findSession.get(conversationId) as Record<string, unknown> | undefined);
    },
    listBySetKey(setKey: string): BrainstormSessionRow[] {
      return (listBySetKey.all(setKey) as Array<Record<string, unknown>>).map(
        (row) => normalize(row) as BrainstormSessionRow,
      );
    },
    list(): BrainstormSessionRow[] {
      return (listSessions.all() as Array<Record<string, unknown>>).map(
        (row) => normalize(row) as BrainstormSessionRow,
      );
    },
    listSourceIds(conversationId: string): string[] {
      return (listSources.all(conversationId) as Array<{ noteId: string }>).map((r) => r.noteId);
    },
    listConversationIdsForNote(noteId: string): string[] {
      return (listConversationsForNote.all(noteId) as Array<{ conversationId: string }>).map(
        (r) => r.conversationId,
      );
    },
    setConcluded(conversationId: string, concluded: boolean, updatedAt: number): void {
      setConcluded.run(concluded ? 1 : 0, updatedAt, conversationId);
    },
    remove(conversationId: string): void {
      const tx = db.transaction(() => {
        deleteSources.run(conversationId);
        removeSession.run(conversationId);
      });
      tx();
    },
    removeNote(noteId: string): void {
      removeNoteSource.run(noteId);
    },
  };
}

export function createNoteGraphStore(db: Database.Database): NoteGraphStore {
  const set = db.prepare(
    `INSERT INTO note_graph (note_id, x, y) VALUES (@noteId, @x, @y)
     ON CONFLICT(note_id) DO UPDATE SET x = excluded.x, y = excluded.y`,
  );
  const get = db.prepare(`SELECT note_id AS noteId, x, y FROM note_graph WHERE note_id = ?`);
  const listAll = db.prepare(`SELECT note_id AS noteId, x, y FROM note_graph`);
  const remove = db.prepare('DELETE FROM note_graph WHERE note_id = ?');

  return {
    set(noteId: string, x: number, y: number): void {
      set.run({ noteId, x, y });
    },
    get(noteId: string): NoteGraphPosition | undefined {
      return get.get(noteId) as NoteGraphPosition | undefined;
    },
    listAll(): NoteGraphPosition[] {
      return listAll.all() as NoteGraphPosition[];
    },
    remove(noteId: string): void {
      remove.run(noteId);
    },
  };
}

export function createPlanStore(db: Database.Database): PlanStore {
  const insert = db.prepare(
    `INSERT INTO plans (id, title, description, document, created_at, updated_at)
     VALUES (@id, @title, @description, @document, @createdAt, @updatedAt)`,
  );
  const findById = db.prepare(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = ?`);
  const listAll = db.prepare(
    `SELECT ${PLAN_COLUMNS} FROM plans ORDER BY created_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM plans WHERE id = ?');

  return {
    insert(row: PlanRow): void {
      insert.run({ ...row });
    },
    findById(id: string): PlanRow | undefined {
      return findById.get(id) as PlanRow | undefined;
    },
    list(): PlanRow[] {
      return listAll.all() as PlanRow[];
    },
    update(id: string, patch: PlanRowPatch): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { updatedAt: patch.updatedAt };
      for (const [column, key] of Object.entries(PLAN_UPDATE_COLUMNS)) {
        const value = patch[key as keyof PlanRowPatch];
        if (value !== undefined) {
          sets.push(`${column} = @${String(key)}`);
          params[String(key)] = value;
        }
      }
      if (sets.length === 0) {
        db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(patch.updatedAt, id);
        return;
      }
      params.id = id;
      db.prepare(
        `UPDATE plans SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`,
      ).run(params);
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}

/** FTS5 mirror helpers over the shared notes_fts virtual table (PLAN-M5). */
export function createNotesFtsStore(db: Database.Database): NotesFtsStore {
  const insert = db.prepare(
    'INSERT INTO notes_fts (note_ref, plan_ref, content) VALUES (?, ?, ?)',
  );
  const deleteNoteRef = db.prepare('DELETE FROM notes_fts WHERE note_ref = ?');
  const deletePlanRef = db.prepare('DELETE FROM notes_fts WHERE plan_ref = ?');
  const matchQuery = db.prepare(
    `SELECT
       CASE WHEN note_ref IS NOT NULL THEN 'note' ELSE 'plan' END AS kind,
       COALESCE(note_ref, plan_ref) AS refId,
       bm25(notes_fts) AS rank
     FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank ASC LIMIT ?`,
  );

  return {
    upsertNote(id: string, content: string): void {
      deleteNoteRef.run(id);
      insert.run(id, null, content);
    },
    upsertPlan(id: string, content: string): void {
      deletePlanRef.run(id);
      insert.run(null, id, content);
    },
    deleteRef(kind: NotesFtsKind, id: string): void {
      if (kind === 'note') deleteNoteRef.run(id);
      else deletePlanRef.run(id);
    },
    match(query: string, limit: number): NotesFtsHit[] {
      const rows = matchQuery.all(query, limit) as Array<{
        kind: NotesFtsKind;
        refId: string;
        rank: number;
      }>;
      return rows.map((row) => ({ kind: row.kind, refId: row.refId, rank: row.rank }));
    },
  };
}

// ---------------------------------------------------------------------------
// M6 themes row store (PLAN-M6.md — additive schema v7). Plain typed CRUD
// with NO business logic; the theme manager (core/src/theming/manager.ts)
// owns the lint/contrast gate, preset seeding, activation and persona
// binding. light_json/dark_json are JSON ThemeTokens strings the store never
// interprets. Stores never read the clock: writes take explicit timestamps.
// ---------------------------------------------------------------------------

const THEME_COLUMNS = `
  id, name, source, light_json AS lightJson, dark_json AS darkJson,
  created_at AS createdAt, updated_at AS updatedAt`;

const THEME_UPDATE_COLUMNS: Readonly<Record<string, keyof ThemeRowPatch>> = {
  name: 'name',
  light_json: 'lightJson',
  dark_json: 'darkJson',
};

export function createThemeStore(db: Database.Database): ThemeStore {
  const insert = db.prepare(
    `INSERT INTO themes (id, name, source, light_json, dark_json, created_at, updated_at)
     VALUES (@id, @name, @source, @lightJson, @darkJson, @createdAt, @updatedAt)`,
  );
  const findById = db.prepare(`SELECT ${THEME_COLUMNS} FROM themes WHERE id = ?`);
  const listAll = db.prepare(
    `SELECT ${THEME_COLUMNS} FROM themes ORDER BY created_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM themes WHERE id = ?');
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM themes');

  return {
    insert(row: ThemeRow): void {
      insert.run({ ...row });
    },
    findById(id: string): ThemeRow | undefined {
      return findById.get(id) as ThemeRow | undefined;
    },
    list(): ThemeRow[] {
      return listAll.all() as ThemeRow[];
    },
    update(id: string, patch: ThemeRowPatch): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { updatedAt: patch.updatedAt };
      for (const [column, key] of Object.entries(THEME_UPDATE_COLUMNS)) {
        const value = patch[key as keyof ThemeRowPatch];
        if (value !== undefined) {
          sets.push(`${column} = @${String(key)}`);
          params[String(key)] = value;
        }
      }
      if (sets.length === 0) {
        db.prepare('UPDATE themes SET updated_at = ? WHERE id = ?').run(patch.updatedAt, id);
        return;
      }
      params.id = id;
      db.prepare(
        `UPDATE themes SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`,
      ).run(params);
    },
    remove(id: string): void {
      remove.run(id);
    },
    count(): number {
      const row = countAll.get() as { n: number };
      return row.n;
    },
  };
}

// ---------------------------------------------------------------------------
// M7 site-scopes row store (PLAN-M7.md — additive schema v8). Plain typed
// CRUD with NO business logic; the scope manager (core/src/browser/scopes.ts)
// owns origin normalization, blocklist precedence and scope validation.
// Stores never read the clock: writes take explicit timestamps.
// ---------------------------------------------------------------------------

const SITE_SCOPE_COLUMNS = `origin, scope, updated_at AS updatedAt`;

export function createSiteScopeStore(db: Database.Database): SiteScopeStore {
  const upsert = db.prepare(
    `INSERT INTO site_scopes (origin, scope, updated_at) VALUES (@origin, @scope, @updatedAt)
     ON CONFLICT(origin) DO UPDATE SET
       scope = excluded.scope,
       updated_at = excluded.updated_at`,
  );
  const findByOrigin = db.prepare(`SELECT ${SITE_SCOPE_COLUMNS} FROM site_scopes WHERE origin = ?`);
  const listAll = db.prepare(
    `SELECT ${SITE_SCOPE_COLUMNS} FROM site_scopes ORDER BY origin ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM site_scopes WHERE origin = ?');

  return {
    upsert(row: SiteScopeRecord): void {
      upsert.run({ ...row });
    },
    findByOrigin(origin: string): SiteScopeRecord | undefined {
      return findByOrigin.get(origin) as SiteScopeRecord | undefined;
    },
    list(): SiteScopeRecord[] {
      return listAll.all() as SiteScopeRecord[];
    },
    remove(origin: string): void {
      remove.run(origin);
    },
  };
}

// ---------------------------------------------------------------------------
// M8 skills row stores (PLAN-M8.md — additive schema v9). Plain typed CRUD
// with NO business logic; the skill manager (core/src/skills/*) owns manifest
// validation, the on-disk code store, install/uninstall hygiene and audit.
// Stores never read the clock: writes take explicit timestamps.
// ---------------------------------------------------------------------------

const SKILL_COLUMNS = `
  id, name, description, author, version, entrypoint,
  manifest_json AS manifestJson, sha256, source, status,
  installed_at AS installedAt, updated_at AS updatedAt`;

const SKILL_INVOCATION_COLUMNS = `
  id, skill_id AS skillId, persona_id AS personaId,
  started_at AS startedAt, finished_at AS finishedAt, ok,
  tool_calls AS toolCalls, error, ms`;

const SKILL_UPDATE_COLUMNS: Readonly<Record<string, keyof SkillRowPatch>> = {
  name: 'name',
  description: 'description',
  author: 'author',
  version: 'version',
  entrypoint: 'entrypoint',
  manifest_json: 'manifestJson',
  sha256: 'sha256',
  source: 'source',
  status: 'status',
};

export function createSkillStore(db: Database.Database): SkillStore {
  const insert = db.prepare(
    `INSERT INTO skills (id, name, description, author, version, entrypoint,
                         manifest_json, sha256, source, status,
                         installed_at, updated_at)
     VALUES (@id, @name, @description, @author, @version, @entrypoint,
             @manifestJson, @sha256, @source, @status,
             @installedAt, @updatedAt)`,
  );
  const findById = db.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE id = ?`);
  const listAll = db.prepare(
    `SELECT ${SKILL_COLUMNS} FROM skills ORDER BY installed_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM skills WHERE id = ?');

  return {
    insert(row: SkillRow): void {
      insert.run({ ...row });
    },
    findById(id: string): SkillRow | undefined {
      return findById.get(id) as SkillRow | undefined;
    },
    list(): SkillRow[] {
      return listAll.all() as SkillRow[];
    },
    update(id: string, patch: SkillRowPatch): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { updatedAt: patch.updatedAt };
      for (const [column, key] of Object.entries(SKILL_UPDATE_COLUMNS)) {
        const value = patch[key as keyof SkillRowPatch];
        if (value !== undefined) {
          sets.push(`${column} = @${String(key)}`);
          params[String(key)] = value;
        }
      }
      if (sets.length === 0) {
        db.prepare('UPDATE skills SET updated_at = ? WHERE id = ?').run(patch.updatedAt, id);
        return;
      }
      params.id = id;
      db.prepare(
        `UPDATE skills SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`,
      ).run(params);
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}

export function createSkillInvocationStore(db: Database.Database): SkillInvocationStore {
  const insert = db.prepare(
    `INSERT INTO skill_invocations (id, skill_id, persona_id, started_at,
                                    finished_at, ok, tool_calls, error, ms)
     VALUES (@id, @skillId, @personaId, @startedAt,
             @finishedAt, @ok, @toolCalls, @error, @ms)`,
  );
  const findById = db.prepare(
    `SELECT ${SKILL_INVOCATION_COLUMNS} FROM skill_invocations WHERE id = ?`,
  );
  const listBySkill = db.prepare(
    `SELECT ${SKILL_INVOCATION_COLUMNS} FROM skill_invocations
     WHERE skill_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
  );
  const removeBySkill = db.prepare('DELETE FROM skill_invocations WHERE skill_id = ?');

  return {
    insert(row: SkillInvocationRow): void {
      insert.run({ ...row });
    },
    findById(id: string): SkillInvocationRow | undefined {
      return findById.get(id) as SkillInvocationRow | undefined;
    },
    listBySkill(skillId: string, limit: number): SkillInvocationRow[] {
      return listBySkill.all(skillId, limit) as SkillInvocationRow[];
    },
    removeBySkill(skillId: string): void {
      removeBySkill.run(skillId);
    },
  };
}

// ---------------------------------------------------------------------------
// M9 row stores (PLAN-M9.md — additive schema v10). Plain typed CRUD with NO
// business logic; the deploy manager (playbooks/deploy.ts) and playbook
// manager (playbooks/manager.ts) own validation, run-state transitions and
// audit. Stores never read the clock: writes take explicit timestamps.
// ---------------------------------------------------------------------------

const DEPLOY_PROFILE_COLUMNS = `
  id, name, kind, host, username, port,
  remote_base_dir AS remoteBaseDir, env_extra AS envExtra,
  created_at AS createdAt, updated_at AS updatedAt`;

const PLAYBOOK_RUN_COLUMNS = `
  id, playbook_id AS playbookId, persona_id AS personaId,
  conversation_id AS conversationId, status,
  tool_calls AS toolCalls, started_at AS startedAt,
  finished_at AS finishedAt, error`;

const SCHEDULE_RUN_COLUMNS = `
  id, persona_id AS personaId, schedule_id AS scheduleId, label, status,
  conversation_id AS conversationId, pending_id AS pendingId,
  tool_calls AS toolCalls, rounds, model, started_at AS startedAt,
  finished_at AS finishedAt, error`;

export function createDeployProfileStore(db: Database.Database): DeployProfileStore {
  const insert = db.prepare(
    `INSERT INTO deploy_profiles (id, name, kind, host, username, port,
                                  remote_base_dir, env_extra, created_at, updated_at)
     VALUES (@id, @name, @kind, @host, @username, @port,
             @remoteBaseDir, @envExtra, @createdAt, @updatedAt)`,
  );
  const findById = db.prepare(
    `SELECT ${DEPLOY_PROFILE_COLUMNS} FROM deploy_profiles WHERE id = ?`,
  );
  const listAll = db.prepare(
    `SELECT ${DEPLOY_PROFILE_COLUMNS} FROM deploy_profiles ORDER BY created_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM deploy_profiles WHERE id = ?');

  return {
    insert(row: DeployProfileRow): void {
      insert.run({ ...row });
    },
    findById(id: string): DeployProfileRow | undefined {
      return findById.get(id) as DeployProfileRow | undefined;
    },
    list(): DeployProfileRow[] {
      return listAll.all() as DeployProfileRow[];
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}

export function createPlaybookRunStore(db: Database.Database): PlaybookRunStore {
  const insert = db.prepare(
    `INSERT INTO playbook_runs (id, playbook_id, persona_id, conversation_id, status,
                                tool_calls, started_at, finished_at, error)
     VALUES (@id, @playbookId, @personaId, @conversationId, @status,
             @toolCalls, @startedAt, @finishedAt, @error)`,
  );
  const findById = db.prepare(
    `SELECT ${PLAYBOOK_RUN_COLUMNS} FROM playbook_runs WHERE id = ?`,
  );
  const update = db.prepare(
    `UPDATE playbook_runs SET
       status = COALESCE(@status, status),
       tool_calls = COALESCE(@toolCalls, tool_calls),
       finished_at = COALESCE(@finishedAt, finished_at),
       error = COALESCE(@error, error)
     WHERE id = @id`,
  );

  return {
    insert(row: PlaybookRunRow): void {
      insert.run({ ...row });
    },
    findById(id: string): PlaybookRunRow | undefined {
      return findById.get(id) as PlaybookRunRow | undefined;
    },
    update(id: string, patch: PlaybookRunPatch): void {
      update.run({
        id,
        status: patch.status ?? null,
        toolCalls: patch.toolCalls ?? null,
        finishedAt: patch.finishedAt ?? null,
        error: patch.error ?? null,
      });
    },
  };
}

export function createScheduleRunStore(db: Database.Database): ScheduleRunStore {
  const insert = db.prepare(
    `INSERT INTO scheduled_runs (id, persona_id, schedule_id, label, status,
                                 conversation_id, pending_id, tool_calls, rounds,
                                 model, started_at, finished_at, error)
     VALUES (@id, @personaId, @scheduleId, @label, @status,
             @conversationId, @pendingId, @toolCalls, @rounds,
             @model, @startedAt, @finishedAt, @error)`,
  );
  const findById = db.prepare(
    `SELECT ${SCHEDULE_RUN_COLUMNS} FROM scheduled_runs WHERE id = ?`,
  );
  const listSql = db.prepare(
    `SELECT ${SCHEDULE_RUN_COLUMNS} FROM scheduled_runs
     WHERE (@personaId IS NULL OR persona_id = @personaId)
       AND (@scheduleId IS NULL OR schedule_id = @scheduleId)
       AND (@status IS NULL OR status = @status)
     ORDER BY started_at DESC, rowid DESC LIMIT @limit`,
  );
  const waitingSql = db.prepare(
    `SELECT ${SCHEDULE_RUN_COLUMNS} FROM scheduled_runs
     WHERE pending_id = ? AND status = 'queued' ORDER BY started_at DESC LIMIT 1`,
  );
  const update = db.prepare(
    `UPDATE scheduled_runs SET
       status = @status,
       pending_id = @pendingId,
       tool_calls = COALESCE(@toolCalls, tool_calls),
       rounds = COALESCE(@rounds, rounds),
       model = @model,
       finished_at = @finishedAt,
       error = @error,
       conversation_id = COALESCE(@conversationId, conversation_id)
     WHERE id = @id`,
  );

  return {
    insert(row: ScheduleRunRow): void {
      insert.run({ ...row });
    },
    findById(id: string): ScheduleRunRow | undefined {
      return findById.get(id) as ScheduleRunRow | undefined;
    },
    list(filter?: ScheduleRunFilter): ScheduleRunRow[] {
      const limit = Math.min(100, Math.max(1, filter?.limit ?? 50));
      return listSql.all({
        personaId: filter?.personaId ?? null,
        scheduleId: filter?.scheduleId ?? null,
        status: filter?.status ?? null,
        limit,
      }) as ScheduleRunRow[];
    },
    findWaitingByPending(pendingId: string): ScheduleRunRow | undefined {
      return waitingSql.get(pendingId) as ScheduleRunRow | undefined;
    },
    update(id: string, patch: ScheduleRunPatch): void {
      update.run({
        id,
        status: patch.status ?? null,
        pendingId: patch.pendingId ?? null,
        toolCalls: patch.toolCalls ?? null,
        rounds: patch.rounds ?? null,
        model: patch.model ?? null,
        finishedAt: patch.finishedAt ?? null,
        error: patch.error ?? null,
        conversationId: patch.conversationId ?? null,
      });
    },
  };
}

export function createSpendLedgerStore(db: Database.Database): SpendLedgerStore {
  const find = db.prepare(
    `SELECT provider_id AS providerId, window_start AS windowStart,
            cents, updated_at AS updatedAt
     FROM spend_ledger WHERE provider_id = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO spend_ledger (provider_id, window_start, cents, updated_at)
     VALUES (@providerId, @windowStart, @cents, @updatedAt)
     ON CONFLICT(provider_id) DO UPDATE SET
       window_start = excluded.window_start,
       cents = excluded.cents,
       updated_at = excluded.updated_at`,
  );
  const remove = db.prepare('DELETE FROM spend_ledger WHERE provider_id = ?');

  return {
    find(providerId: string): SpendLedgerRow | undefined {
      return find.get(providerId) as SpendLedgerRow | undefined;
    },
    upsert(row: SpendLedgerRow): void {
      upsert.run({ ...row });
    },
    remove(providerId: string): void {
      remove.run(providerId);
    },
  };
}

/**
 * M11 F11 folder row store (PLAN-M11.md). Plain typed CRUD with sibling
 * ordering; tree semantics (cycles, reparenting, Inbox) belong to the folder
 * manager. Stores never read the clock.
 */
export function createFolderStore(db: Database.Database): FolderStore {
  const insert = db.prepare(
    `INSERT INTO folders (id, name, parent_id, position, created_at, updated_at)
     VALUES (@id, @name, @parentId, @position, @createdAt, @updatedAt)`,
  );
  const findById = db.prepare(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE id = ?`);
  const listAll = db.prepare(
    `SELECT ${FOLDER_COLUMNS} FROM folders ORDER BY parent_id IS NOT NULL, position ASC, name ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM folders WHERE id = ?');

  return {
    insert(row: FolderRow): void {
      insert.run({ ...row });
    },
    findById(id: string): FolderRow | undefined {
      return findById.get(id) as FolderRow | undefined;
    },
    list(): FolderRow[] {
      return listAll.all() as FolderRow[];
    },
    update(id: string, patch: FolderRowPatch): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { updatedAt: patch.updatedAt };
      if (patch.name !== undefined) {
        sets.push('name = @name');
        params.name = patch.name;
      }
      if (patch.parentId !== undefined) {
        sets.push('parent_id = @parentId');
        params.parentId = patch.parentId;
      }
      if (patch.position !== undefined) {
        sets.push('position = @position');
        params.position = patch.position;
      }
      if (sets.length === 0) {
        db.prepare('UPDATE folders SET updated_at = ? WHERE id = ?').run(patch.updatedAt, id);
        return;
      }
      params.id = id;
      db.prepare(
        `UPDATE folders SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`,
      ).run(params);
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}

/** Column projection for chat_blobs + attachments rows (snake -> camel). */
const ATTACHMENT_COLUMNS = `
  id, conversation_id AS conversationId, message_id AS messageId, kind,
  name, mime, size, sha256, ref_root_id AS refRootId, ref_path AS refPath,
  extract_text AS extractText, created_at AS createdAt`;

export function createChatBlobStore(db: Database.Database): ChatBlobStore {
  const find = db.prepare('SELECT sha256, mime, size, data, created_at AS createdAt FROM chat_blobs WHERE sha256 = ?');
  const insert = db.prepare(
    `INSERT INTO chat_blobs (sha256, mime, size, data, created_at)
     VALUES (@sha256, @mime, @size, @data, @createdAt)`,
  );
  const remove = db.prepare('DELETE FROM chat_blobs WHERE sha256 = ?');
  const referencing = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE sha256 = ?');

  return {
    find(sha256: string): ChatBlobRow | undefined {
      const row = find.get(sha256) as
        | { sha256: string; mime: string; size: number; data: Buffer; createdAt: number }
        | undefined;
      return row === undefined ? undefined : { ...row, data: row.data };
    },
    insert(row: ChatBlobRow): void {
      insert.run({ ...row });
    },
    remove(sha256: string): void {
      remove.run(sha256);
    },
    referencing(sha256: string): number {
      const row = referencing.get(sha256) as { n: number };
      return row.n;
    },
  };
}

export function createAttachmentStore(db: Database.Database): AttachmentStore {
  const insert = db.prepare(
    `INSERT INTO attachments (id, conversation_id, message_id, kind, name, mime, size,
                              sha256, ref_root_id, ref_path, extract_text, created_at)
     VALUES (@id, @conversationId, @messageId, @kind, @name, @mime, @size,
             @sha256, @refRootId, @refPath, @extractText, @createdAt)`,
  );
  const findById = db.prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?`);
  const listByConversation = db.prepare(
    `SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE conversation_id = ?
     ORDER BY (message_id IS NULL) DESC, created_at ASC, rowid ASC`,
  );
  const listByMessage = db.prepare(
    `SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE message_id = ?
     ORDER BY created_at ASC, rowid ASC`,
  );
  const bind = db.prepare('UPDATE attachments SET message_id = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM attachments WHERE id = ?');

  return {
    insert(row: AttachmentRow): void {
      insert.run({ ...row });
    },
    findById(id: string): AttachmentRow | undefined {
      return findById.get(id) as AttachmentRow | undefined;
    },
    listByConversation(conversationId: string): AttachmentRow[] {
      return listByConversation.all(conversationId) as AttachmentRow[];
    },
    listByMessage(messageId: string): AttachmentRow[] {
      return listByMessage.all(messageId) as AttachmentRow[];
    },
    bind(id: string, messageId: string): void {
      bind.run(messageId, id);
    },
    remove(id: string): AttachmentRow | undefined {
      const row = findById.get(id) as AttachmentRow | undefined;
      if (row) remove.run(id);
      return row;
    },
  };
}

/** Column projection for asset rows (snake -> camel). */
const ASSET_COLUMNS = `
  id, conversation_id AS conversationId, message_id AS messageId, kind,
  title, body, tags, created_at AS createdAt`;

export function createAssetStore(db: Database.Database): AssetStore {
  const insert = db.prepare(
    `INSERT INTO assets (id, conversation_id, message_id, kind, title, body, tags, created_at)
     VALUES (@id, @conversationId, @messageId, @kind, @title, @body, @tags, @createdAt)`,
  );
  const findById = db.prepare(`SELECT ${ASSET_COLUMNS} FROM assets WHERE id = ?`);
  const listByConversation = db.prepare(
    `SELECT ${ASSET_COLUMNS} FROM assets WHERE conversation_id = ?
     ORDER BY created_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM assets WHERE id = ?');

  return {
    insert(row: AssetRow): void {
      insert.run({ ...row });
    },
    findById(id: string): AssetRow | undefined {
      return findById.get(id) as AssetRow | undefined;
    },
    listByConversation(conversationId: string): AssetRow[] {
      return listByConversation.all(conversationId) as AssetRow[];
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}

/** Column projection for mcp_servers rows (snake -> camel). */
const MCP_SERVER_COLUMNS = `
  id, name, transport, command, args, enabled,
  created_at AS createdAt, updated_at AS updatedAt`;

export function createMcpServerStore(db: Database.Database): McpServerStore {
  const insert = db.prepare(
    `INSERT INTO mcp_servers (id, name, transport, command, args, enabled, created_at, updated_at)
     VALUES (@id, @name, @transport, @command, @args, @enabled, @createdAt, @updatedAt)`,
  );
  const findById = db.prepare(`SELECT ${MCP_SERVER_COLUMNS} FROM mcp_servers WHERE id = ?`);
  const listAll = db.prepare(
    `SELECT ${MCP_SERVER_COLUMNS} FROM mcp_servers ORDER BY created_at ASC, rowid ASC`,
  );
  const remove = db.prepare('DELETE FROM mcp_servers WHERE id = ?');

  return {
    insert(row: McpServerRow): void {
      insert.run({ ...row });
    },
    findById(id: string): McpServerRow | undefined {
      return findById.get(id) as McpServerRow | undefined;
    },
    list(): McpServerRow[] {
      return listAll.all() as McpServerRow[];
    },
    update(id: string, patch: { name?: string; command?: string; args?: string[] | null; enabled?: boolean; updatedAt: number }): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { updatedAt: patch.updatedAt };
      if (patch.name !== undefined) { sets.push('name = @name'); params.name = patch.name; }
      if (patch.command !== undefined) { sets.push('command = @command'); params.command = patch.command; }
      if (patch.args !== undefined) { sets.push('args = @args'); params.args = patch.args === null ? null : JSON.stringify(patch.args); }
      if (patch.enabled !== undefined) { sets.push('enabled = @enabled'); params.enabled = patch.enabled ? 1 : 0; }
      if (sets.length === 0) {
        db.prepare('UPDATE mcp_servers SET updated_at = ? WHERE id = ?').run(patch.updatedAt, id);
        return;
      }
      params.id = id;
      db.prepare(`UPDATE mcp_servers SET ${sets.join(', ')}, updated_at = @updatedAt WHERE id = @id`).run(params);
    },
    remove(id: string): void {
      remove.run(id);
    },
  };
}
