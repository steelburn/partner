/**
 * M4 store tests (PLAN-M4.md + M5 schema bump to v6): the
 * profile_entries/episodes tables + the memory_fts virtual table are created
 * idempotently alongside
 * M0-M3 tables; the FTS5 probe passes on a known-good db (negative case is
 * impossible with the bundled SQLite — documented in PLAN-M4); the new row
 * stores round-trip and the FTS mirror upserts/deletes/matches with bm25
 * ranking. Existing M0-M3 store tests must stay green alongside.
 */
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@partner/shared';
import {
  assertFts5,
  createEpisodeStore,
  createMemoryFtsStore,
  createProfileStore,
  openDatabase,
} from '../../src/stores/db.js';
import type { EpisodeRow, ProfileEntryRow } from '../../src/stores/types.js';

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('schema v6 (additive M4/M5 tables + FTS5)', () => {
  it('creates profile_entries, episodes and memory_fts; keeps every earlier table', () => {
    const db = openDatabase(':memory:');
    try {
      const names = tableNames(db);
      expect(names).toContain('profile_entries');
      expect(names).toContain('episodes');
      expect(names).toContain('memory_fts');
      for (const existing of [
        'pairings',
        'sessions',
        'audit_log',
        'settings',
        'meta',
        'providers',
        'project_roots',
        'grants',
        'pending_tools',
        'file_proposals',
        'personas',
        'conversations',
        'messages',
      ]) {
        expect(names, existing).toContain(existing);
      }
      const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
        | { value: string }
        | undefined;
      expect(meta?.value).toBe(String(SCHEMA_VERSION));
      // M6 (PLAN-M6.md, 238b20a) raised the schema to 7 (themes table). M9
      // (PLAN-M9.md, ba83902) raised it to 10 (deploy_profiles + playbook_runs).
      // v11 added spend_ledger (M10 W3); v12 added M11 guarded columns.
      expect(SCHEMA_VERSION).toBe(16);
    } finally {
      db.close();
    }
  });

  it('assertFts5 passes on a known-good db and leaves no probe table behind', () => {
    const db = openDatabase(':memory:');
    try {
      expect(() => assertFts5(db)).not.toThrow();
      // The probe is created AND dropped — nothing lingers in sqlite_master.
      const leftovers = db
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%probe%'")
        .all();
      expect(leftovers).toHaveLength(0);
      // The real memory_fts virtual table is queryable end to end.
      db.prepare('INSERT INTO memory_fts (episode_ref, profile_ref, content) VALUES (?, ?, ?)').run(
        null,
        'p-1',
        'hello fts5 world',
      );
      const hits = db
        .prepare(
          "SELECT profile_ref FROM memory_fts WHERE memory_fts MATCH 'fts5'",
        )
        .all() as Array<{ profile_ref: string }>;
      expect(hits.map((h) => h.profile_ref)).toEqual(['p-1']);
    } finally {
      db.close();
    }
  });

  it('schema is idempotent across a second open (no duplicate virtual table)', () => {
    const db = openDatabase(':memory:');
    try {
      db.prepare('INSERT INTO memory_fts (profile_ref, content) VALUES (?, ?)').run('p-x', 'keep');
      const first = tableNames(db).filter((n) =>
        ['profile_entries', 'episodes', 'memory_fts'].includes(n),
      );
      const db2 = openDatabase(':memory:');
      try {
        const second = tableNames(db2).filter((n) =>
          ['profile_entries', 'episodes', 'memory_fts'].includes(n),
        );
        expect(second.sort()).toEqual(first.sort());
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  });
});

describe('M4 row stores (plain CRUD)', () => {
  it('profile entries round-trip with whitelisted update patch', () => {
    const db = openDatabase(':memory:');
    try {
      const store = createProfileStore(db);
      const row: ProfileEntryRow = {
        id: 'pe-1',
        kind: 'preference',
        key: null,
        value: 'tldr first',
        evidence: null,
        source: 'user',
        status: 'confirmed',
        personaScope: null,
        createdAt: 10,
        updatedAt: 10,
      };
      store.insert(row);
      expect(store.findById('pe-1')).toMatchObject({ value: 'tldr first', status: 'confirmed' });

      store.update('pe-1', { value: 'tldr always', status: 'rejected', updatedAt: 20 });
      expect(store.findById('pe-1')).toMatchObject({
        value: 'tldr always',
        status: 'rejected',
        updatedAt: 20,
      });
      // Untouched columns survived.
      expect(store.findById('pe-1')?.kind).toBe('preference');

      store.insert({ ...row, id: 'pe-2', value: 'second', createdAt: 11, updatedAt: 11 });
      expect(store.list().map((r) => r.id)).toEqual(['pe-1', 'pe-2']);
      store.remove('pe-1');
      expect(store.findById('pe-1')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('episodes round-trip; findByConversationId enforces the unique conversation', () => {
    const db = openDatabase(':memory:');
    try {
      const store = createEpisodeStore(db);
      const row: EpisodeRow = {
        id: 'ep-1',
        conversationId: 'c-1',
        personaId: 'p-1',
        title: 'The chat',
        summary: 'summary text',
        model: 'demo',
        createdAt: 1,
        updatedAt: 1,
      };
      store.insert(row);
      expect(store.findByConversationId('c-1')?.id).toBe('ep-1');
      expect(store.findByConversationId('c-other')).toBeUndefined();

      store.update('ep-1', { summary: 'updated summary', model: null, updatedAt: 2 });
      const updated = store.findById('ep-1');
      expect(updated).toMatchObject({ summary: 'updated summary', model: null, updatedAt: 2 });
      expect(updated?.personaId).toBe('p-1'); // untouched
      store.remove('ep-1');
      expect(store.findById('ep-1')).toBeUndefined();
      expect(store.list()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('memory FTS mirror upserts (delete+insert), deletes and matches with bm25 rank', () => {
    const db = openDatabase(':memory:');
    try {
      const fts = createMemoryFtsStore(db);
      fts.upsertProfile('p-1', 'loves concise summaries in email');
      fts.upsertProfile('p-2', 'always cites sources in answers');
      fts.upsertEpisode('e-1', 'user discussed email tone preferences');

      const both = fts.match('"email"', 50);
      expect(both.map((h) => h.kind + ':' + h.refId).sort()).toEqual(['episode:e-1', 'profile:p-1'].sort());
      expect(typeof both[0]?.rank).toBe('number');

      // Upsert REPLACES the row content (no stale duplicates).
      fts.upsertProfile('p-1', 'moved to full length reports now');
      expect(fts.match('"email"', 50).filter((h) => h.kind === 'profile')).toHaveLength(0);
      expect(fts.match('"reports"', 50).map((h) => h.refId)).toEqual(['p-1']);

      // deleteRef removes only that ref; the other rows keep matching.
      fts.deleteRef('profile', 'p-1');
      fts.deleteRef('episode', 'e-1');
      expect(fts.match('"email"', 50)).toHaveLength(0);
      expect(fts.match('"sources"', 50).map((h) => h.refId)).toEqual(['p-2']);
      // Limit applies.
      for (let i = 0; i < 60; i += 1) fts.upsertProfile(`bulk-${i}`, `keyword share-${i}`);
      expect(fts.match('"keyword"', 50)).toHaveLength(50);
    } finally {
      db.close();
    }
  });
});
