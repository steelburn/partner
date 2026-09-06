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
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '@partner/shared';
import { applySchema, createMessageStore, ensureColumn, openDatabase } from '../../src/stores/db.js';

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
      expect(meta?.value).toBe('13');
      expect(SCHEMA_VERSION).toBe(13);

      expect(columnNames(db, 'personas')).toContain('policy');
      expect(columnNames(db, 'providers')).toContain('purpose');
      expect(columnNames(db, 'conversations')).toContain('folder_id');
      expect(columnNames(db, 'messages')).toContain('content_type');

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
        .prepare('SELECT purpose FROM providers WHERE id = ?')
        .get('p-x') as { purpose: string };

      expect(conversation.folderId).toBeNull();
      expect(message.contentType).toBe('text');
      expect(provider.purpose).toBe('general');
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
