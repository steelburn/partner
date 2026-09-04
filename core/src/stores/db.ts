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
import type {
  AuditRow,
  AuditStore,
  FileProposalRow,
  FileProposalStore,
  GrantRow,
  GrantStore,
  PairingRow,
  PairingStore,
  PendingToolRow,
  PendingToolStore,
  ProjectRootRow,
  ProjectRootStore,
  ProviderRow,
  ProviderRowPatch,
  ProviderStore,
  SessionRow,
  SessionStore,
  SettingsStore,
} from './types.js';

const META_SCHEMA_VERSION_KEY = 'schema_version';

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

function applySchema(db: Database.Database): void {
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
