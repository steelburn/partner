/**
 * SQLite open + idempotent schema, and the M0 row-store factories.
 *
 * Schema is applied with CREATE TABLE IF NOT EXISTS so opening twice (or a
 * re-open after a crash mid-migration) is safe. WAL is enabled for file DBs;
 * ':memory:' databases are used by DEMO_MODE and every unit test.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '@partner/shared';
import type { SiteScopeRecord } from '@partner/shared';
import type {
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
  NoteLinkRow,
  NoteLinkStore,
  NoteRow,
  NoteRowPatch,
  NoteStore,
  NotesFtsHit,
  NotesFtsKind,
  NotesFtsStore,
  PlanRow,
  PlanRowPatch,
  PlanStore,
  DeployProfileRow,
  DeployProfileStore,
  PlaybookRunPatch,
  PlaybookRunRow,
  PlaybookRunStore,
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
  decided_by TEXT
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
  id, name, kind, source, endpoint, default_models AS defaultModels,
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
  decided_at AS decidedAt, decision, decided_by AS decidedBy`;

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
  memory_flags AS memoryFlags, is_default AS isDefault, paused,
  created_at AS createdAt, updated_at AS updatedAt`;

const CONVERSATION_COLUMNS = `
  id, persona_id AS personaId, title,
  created_at AS createdAt, updated_at AS updatedAt`;

const MESSAGE_COLUMNS = `
  id, conversation_id AS conversationId, role, persona_id AS personaId,
  content, model, latency_ms AS latencyMs, created_at AS createdAt`;

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

function applySchema(db: Database.Database): void {
  assertFts5(db);
  db.exec(SCHEMA_SQL);
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(META_SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
}

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
    `INSERT INTO providers (id, name, kind, source, endpoint, default_models, enabled,
                            budget_cents, key_ref, last_health, created_at, updated_at)
     VALUES (@id, @name, @kind, @source, @endpoint, @defaultModels, @enabled,
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
    `INSERT INTO pending_tools (id, tool_id, project_id, params, risk, requested_by, created_at)
     VALUES (@id, @toolId, @projectId, @params, @risk, @requestedBy, @createdAt)`,
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
  memory_flags: 'memoryFlags',
  is_default: 'isDefault',
  paused: 'paused',
};

export function createPersonaStore(db: Database.Database): PersonaStore {
  const insert = db.prepare(
    `INSERT INTO personas (id, name, tagline, avatar, color_theme, voice, language,
                           system_prompt, temperature, task_classes, fallback_model,
                           provider_id, independence_level, require_human, auto_scopes,
                           memory_flags, is_default, paused, created_at, updated_at)
     VALUES (@id, @name, @tagline, @avatar, @colorTheme, @voice, @language,
             @systemPrompt, @temperature, @taskClasses, @fallbackModel,
             @providerId, @independenceLevel, @requireHuman, @autoScopes,
             @memoryFlags, @isDefault, @paused, @createdAt, @updatedAt)`,
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
    `INSERT INTO conversations (id, persona_id, title, created_at, updated_at)
     VALUES (@id, @personaId, @title, @createdAt, @updatedAt)`,
  );
  const findById = db.prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`);
  const listAll = db.prepare(
    `SELECT ${CONVERSATION_COLUMNS} FROM conversations
     ORDER BY updated_at DESC, rowid DESC`,
  );
  const remove = db.prepare('DELETE FROM conversations WHERE id = ?');

  return {
    insert(row: ConversationRow): void {
      insert.run({ ...row });
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
    `INSERT INTO messages (id, conversation_id, role, persona_id, content, model,
                           latency_ms, created_at)
     VALUES (@id, @conversationId, @role, @personaId, @content, @model,
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
