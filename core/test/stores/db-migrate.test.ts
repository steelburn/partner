/**
 * M11 C1 — schema v12 & guarded column migrations (PLAN-M11.md).
 *
 * Before M11 the schema was additive-only: CREATE TABLE IF NOT EXISTS meant
 * existing file DBs could gain TABLES but never COLUMNS. C1 adds
 * ensureColumn (guarded ALTER TABLE ADD COLUMN) and the four guarded columns:
 *   personas.policy, providers.purpose, conversations.folder_id,
 *   messages.content_type.
 * These tests pin: fresh DBs open at v12 with the columns present; an
 * already-opened v11-era DB upgrades in place on the next open (simulated by
 * dropping the columns and re-running applySchema, which is what openDatabase
 * does); data survives; ensureColumn is a no-op when the column exists.
 *
 * The v22 block at the bottom does the same for M28 B's three flow columns on
 * `skill_drafts` (PLAN-M28.md), which is the v21 → v22 upgrade.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '@partner/shared';
import { applySchema, createMessageStore, createSkillDraftStore, ensureColumn, openDatabase } from '../../src/stores/db.js';

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe('M11 schema v12 (guarded columns)', () => {
  it('opens at v12 with all M11 columns present', () => {
    const db = openDatabase(':memory:');
    try {
      const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
        | { value: string }
        | undefined;
      expect(meta?.value).toBe(String(SCHEMA_VERSION));
      expect(SCHEMA_VERSION).toBe(24);

      expect(columnNames(db, 'personas')).toContain('policy');
      expect(columnNames(db, 'providers')).toContain('purpose');
      // M24 v20: the per-provider vision declaration (models the user says can
      // see, so a gateway alias is no longer decided by name).
      expect(columnNames(db, 'providers')).toContain('vision_models');
      expect(columnNames(db, 'conversations')).toContain('folder_id');
      expect(columnNames(db, 'messages')).toContain('content_type');
      // M16 v14: lineage columns + version/graph tables (PLAN-M16.md).
      expect(columnNames(db, 'conversations')).toContain('parent_id');
      expect(columnNames(db, 'conversations')).toContain('source_asset_id');
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
        (t) => t.name,
      );
      expect(tables).toContain('note_versions');
      expect(tables).toContain('note_graph');
      // M16 follow-up v15: brainstorm linkage tables.
      expect(tables).toContain('brainstorm_sessions');
      expect(tables).toContain('brainstorm_sources');
      // M17 v16: note<->folder membership (shared tree).
      expect(tables).toContain('note_folders');

      // Existing tables still have every legacy column (guards are additive).
      const legacy = [
        'id', 'name', 'voice', 'task_classes', 'independence_level', 'memory_flags',
      ];
      for (const column of legacy) expect(columnNames(db, 'personas')).toContain(column);
    } finally {
      db.close();
    }
  });

  it('upgrades a v11-era table in place: dropped column comes back, rows survive', () => {
    const db = openDatabase(':memory:');
    try {
      // Seed legacy-shaped data through the (now v12) stores.
      const messages = createMessageStore(db);
      messages.insert({
        id: 'm-legacy',
        conversationId: 'c-1',
        role: 'user',
        personaId: null,
        contentType: 'text',
        content: 'legacy row',
        model: null,
        latencyMs: null,
        createdAt: 1,
      });

      // Simulate the v11 world: the column never existed.
      db.exec('ALTER TABLE messages DROP COLUMN content_type');
      expect(columnNames(db, 'messages')).not.toContain('content_type');

      // Next open (applySchema) must restore it and keep the row.
      applySchema(db);
      expect(columnNames(db, 'messages')).toContain('content_type');

      const row = messages.findById('m-legacy');
      expect(row?.content).toBe('legacy row');
      expect(row?.contentType).toBe('text');
    } finally {
      db.close();
    }
  });

  it('legacy rows read back defaults for the guarded columns', () => {
    const db = openDatabase(':memory:');
    try {
      // Insert without the guarded columns (a v11-era writer).
      db.prepare(
        `INSERT INTO conversations (id, persona_id, title, created_at, updated_at)
         VALUES ('c-x', NULL, NULL, 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, persona_id, content, created_at)
         VALUES ('m-x', 'c-x', 'user', NULL, 'hi', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO providers (id, name, kind, source, endpoint, key_ref, created_at, updated_at)
         VALUES ('p-x', 'P', 'openai-compatible', 'manual', 'http://127.0.0.1:9/v1', 'p-x', 1, 1)`,
      ).run();

      const conversation = db
        .prepare('SELECT folder_id AS folderId FROM conversations WHERE id = ?')
        .get('c-x') as { folderId: string | null };
      const message = db
        .prepare('SELECT content_type AS contentType FROM messages WHERE id = ?')
        .get('m-x') as { contentType: string };
      const provider = db
        .prepare('SELECT purpose, vision_models AS visionModels FROM providers WHERE id = ?')
        .get('p-x') as { purpose: string; visionModels: string | null };

      expect(conversation.folderId).toBeNull();
      expect(message.contentType).toBe('text');
      expect(provider.purpose).toBe('general');
      // M24: a pre-v20 row declares nothing, which is exactly the old behaviour
      // (name hints only) — an upgrade must not invent a vision capability.
      expect(provider.visionModels).toBeNull();
    } finally {
      db.close();
    }
  });

  it('ensureColumn is a no-op when the column already exists', () => {
    const db = openDatabase(':memory:');
    try {
      const before = columnNames(db, 'providers');
      ensureColumn(db, 'providers', 'purpose', "purpose TEXT NOT NULL DEFAULT 'general'");
      expect(columnNames(db, 'providers')).toEqual(before);
      const row = db.prepare('SELECT purpose FROM providers LIMIT 1').get() as
        | { purpose: string }
        | undefined;
      expect(row ?? null).toBeNull(); // no schema churn: still empty table
    } finally {
      db.close();
    }
  });
});

/**
 * M28 B — schema v22's three additive columns on `skill_drafts`.
 *
 * The v21 world had no `flow_json` / `flow_sha256` / `flow_compiled_at`, so the
 * upgrade is simulated the way the v12 test does it: drop the columns, re-run
 * `applySchema` (what every open does), and assert a pre-v22 draft row comes
 * back unchanged — with the flow columns reading NULL, which is exactly "this
 * draft has no flow". An upgrade must never invent a graph.
 */
describe('M28 schema v22 (flow columns on skill_drafts)', () => {
  it('opens at v22 with the three flow columns present', () => {
    const db = openDatabase(':memory:');
    try {
      const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
        | { value: string }
        | undefined;
      expect(meta?.value).toBe(String(SCHEMA_VERSION));
      expect(SCHEMA_VERSION).toBe(24);
      expect(columnNames(db, 'skill_drafts')).toEqual(
        expect.arrayContaining(['flow_json', 'flow_sha256', 'flow_compiled_at']),
      );
    } finally {
      db.close();
    }
  });

  it('opens a v21-era skill_drafts row unchanged: columns appear, row survives', () => {
    const db = openDatabase(':memory:');
    try {
      const drafts = createSkillDraftStore(db);
      drafts.insert({
        id: 'legacy-draft',
        name: 'Legacy',
        description: 'authored before flows existed',
        status: 'draft',
        origin: 'manual',
        manifestJson: null,
        manifestText: '{}',
        code: 'export async function run() { return 1; }',
        prompt: '',
        model: null,
        validationJson: JSON.stringify({ ok: false, errors: [], warnings: [], checkedAt: 1 }),
        conversationId: null,
        personaId: null,
        installedVersion: null,
        flowJson: null,
        flowSha256: null,
        flowCompiledAt: null,
        createdAt: 1,
        updatedAt: 1,
      });

      // Simulate the v21 world: the flow columns never existed.
      for (const column of ['flow_json', 'flow_sha256', 'flow_compiled_at']) {
        db.exec(`ALTER TABLE skill_drafts DROP COLUMN ${column}`);
      }
      expect(columnNames(db, 'skill_drafts')).not.toContain('flow_json');

      // The next open (applySchema) restores them and keeps the row.
      applySchema(db);
      expect(columnNames(db, 'skill_drafts')).toEqual(
        expect.arrayContaining(['flow_json', 'flow_sha256', 'flow_compiled_at']),
      );
      const row = drafts.findById('legacy-draft');
      expect(row?.code).toBe('export async function run() { return 1; }');
      expect(row?.flowJson).toBeNull();
      expect(row?.flowSha256).toBeNull();
      expect(row?.flowCompiledAt).toBeNull();
    } finally {
      db.close();
    }
  });
});

/**
 * M33 — schema v24's `persona_scopes` on `profile_entries`.
 *
 * The v23 world knew only the single `persona_scope` (null = global, else one
 * persona id). v24 adds the JSON id array and backfills it ONCE, on the open
 * that crosses the version boundary. These tests pin both halves: a fresh DB
 * opens at v24 with the column present, and a v23-era row's single scope
 * becomes a one-element array while a global row stays NULL (= every persona).
 * A later open must NOT re-run the backfill, or widening a fact to all
 * personas would be silently undone on the next restart.
 */
describe('M33 schema v24 (multi-persona memory scope)', () => {
  function seedRow(db: Database.Database, id: string, scope: string | null): void {
    db.prepare(
      `INSERT INTO profile_entries (id, kind, key, value, evidence, source, status,
                                    persona_scope, created_at, updated_at)
       VALUES (?, 'rule', NULL, 'legacy fact', NULL, 'user', 'confirmed', ?, 1, 1)`,
    ).run(id, scope);
  }

  function scopesOf(db: Database.Database, id: string): unknown {
    const row = db
      .prepare('SELECT persona_scopes AS personaScopes FROM profile_entries WHERE id = ?')
      .get(id) as { personaScopes: string | null } | undefined;
    return row?.personaScopes ?? null;
  }

  it('opens at v24 with persona_scopes present', () => {
    const db = openDatabase(':memory:');
    try {
      expect(SCHEMA_VERSION).toBe(24);
      expect(columnNames(db, 'profile_entries')).toContain('persona_scopes');
    } finally {
      db.close();
    }
  });

  it('a v23-era single scope becomes a one-element array; global stays NULL', () => {
    const db = openDatabase(':memory:');
    try {
      // Simulate the v23 world: no array column, rows carry only persona_scope.
      db.exec('ALTER TABLE profile_entries DROP COLUMN persona_scopes');
      db.prepare("UPDATE meta SET value = '23' WHERE key = 'schema_version'").run();
      seedRow(db, 'pe-scoped', 'p-scribe');
      seedRow(db, 'pe-global', null);
      expect(columnNames(db, 'profile_entries')).not.toContain('persona_scopes');

      applySchema(db);
      expect(columnNames(db, 'profile_entries')).toContain('persona_scopes');
      expect(scopesOf(db, 'pe-scoped')).toBe(JSON.stringify(['p-scribe']));
      // NULL reads back as the empty array = every persona — unchanged meaning.
      expect(scopesOf(db, 'pe-global')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('the backfill runs once: widening a fact to all personas survives a reopen', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('ALTER TABLE profile_entries DROP COLUMN persona_scopes');
      db.prepare("UPDATE meta SET value = '23' WHERE key = 'schema_version'").run();
      seedRow(db, 'pe-scoped', 'p-scribe');
      applySchema(db);
      expect(scopesOf(db, 'pe-scoped')).toBe(JSON.stringify(['p-scribe']));

      // The user widens the fact to every persona (the array column is NULL).
      db.prepare("UPDATE profile_entries SET persona_scopes = NULL WHERE id = 'pe-scoped'").run();
      applySchema(db); // the next open
      expect(scopesOf(db, 'pe-scoped')).toBeNull();
      // The legacy column is left alone — it is the audit trail of the upgrade.
      expect(
        (db.prepare('SELECT persona_scope AS s FROM profile_entries WHERE id = ?').get('pe-scoped') as { s: string }).s,
      ).toBe('p-scribe');
    } finally {
      db.close();
    }
  });
});
