/**
 * M5 store tests (PLAN-M5.md, schema v6): the notes/note_links/plans tables
 * + the shared notes_fts virtual table are created idempotently alongside
 * M0-M4 tables (schema version already 6 — shared/contracts.ts, dce37d0);
 * the new row stores round-trip and the FTS mirror upserts/deletes/matches
 * with bm25 ranking. Existing M0-M4 store tests must stay green alongside.
 */
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@partner/shared';
import {
  createNoteLinkStore,
  createNoteStore,
  createNotesFtsStore,
  createPlanStore,
  openDatabase,
} from '../../src/stores/db.js';
import type { NoteRow, PlanRow } from '../../src/stores/types.js';

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('schema v6 (additive M5 tables + shared FTS5)', () => {
  it('creates notes, note_links, plans and notes_fts; keeps every earlier table', () => {
    const db = openDatabase(':memory:');
    try {
      const names = tableNames(db);
      expect(names).toContain('notes');
      expect(names).toContain('note_links');
      expect(names).toContain('plans');
      expect(names).toContain('notes_fts');
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
        'profile_entries',
        'episodes',
      ]) {
        expect(names, existing).toContain(existing);
      }
      const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
        | { value: string }
        | undefined;
      expect(meta?.value).toBe(String(SCHEMA_VERSION));
      // M6 (PLAN-M6.md, 238b20a) raised the schema to 7 (themes table).
      expect(SCHEMA_VERSION).toBe(7);
    } finally {
      db.close();
    }
  });

  it('schema is idempotent across a second open (no duplicate virtual tables)', () => {
    const db = openDatabase(':memory:');
    try {
      db.prepare('INSERT INTO notes_fts (note_ref, content) VALUES (?, ?)').run('n-x', 'keep');
      const first = tableNames(db)
        .filter((n) => ['notes', 'note_links', 'plans', 'notes_fts'].includes(n))
        .sort();
      const db2 = openDatabase(':memory:');
      try {
        const second = tableNames(db2)
          .filter((n) => ['notes', 'note_links', 'plans', 'notes_fts'].includes(n))
          .sort();
        expect(second).toEqual(first);
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  });
});

describe('M5 row stores (plain CRUD)', () => {
  it('notes round-trip; findIdByTitle is case-insensitive and stable', () => {
    const db = openDatabase(':memory:');
    try {
      const store = createNoteStore(db);
      const row: NoteRow = {
        id: 'n-1',
        title: 'Groceries',
        content: 'buy milk',
        tags: '["home","errands"]',
        isDaily: 0,
        createdAt: 10,
        updatedAt: 10,
      };
      store.insert(row);
      store.insert({ ...row, id: 'n-2', title: 'other', tags: '[]', createdAt: 11, updatedAt: 11 });
      expect(store.findById('n-1')?.content).toBe('buy milk');
      expect(store.findById('n-missing')).toBeUndefined();
      expect(store.findIdByTitle('groceries')).toBe('n-1');
      expect(store.findIdByTitle('GROCERIES')).toBe('n-1');
      expect(store.findIdByTitle('other')).toBe('n-2');
      expect(store.findIdByTitle('nope')).toBeUndefined();
      expect(store.list().map((r) => r.id)).toEqual(['n-1', 'n-2']); // createdAt asc

      store.update('n-1', { title: 'Groceries 2', content: 'buy eggs', tags: '["home"]', updatedAt: 20 });
      expect(store.findById('n-1')).toMatchObject({ title: 'Groceries 2', content: 'buy eggs', updatedAt: 20 });
      expect(store.findById('n-1')?.createdAt).toBe(10); // untouched
      // Bare touch (no writable fields) only bumps updated_at.
      store.update('n-2', { updatedAt: 21 });
      expect(store.findById('n-2')?.updatedAt).toBe(21);
      store.remove('n-1');
      expect(store.findById('n-1')).toBeUndefined();
      expect(store.list().map((r) => r.id)).toEqual(['n-2']);
    } finally {
      db.close();
    }
  });

  it('note_links replace/list/link-to round-trip; to_title is case-insensitive', () => {
    const db = openDatabase(':memory:');
    try {
      const store = createNoteLinkStore(db);
      store.replaceForNote('a', [
        { toNote: 'b', toTitle: 'Beta' },
        { toNote: null, toTitle: 'Dangling' },
        { toNote: null, toTitle: 'Beta' }, // duplicate title collapses (PK NOCASE)
      ]);
      expect(store.listFrom('a')).toEqual([
        { fromNote: 'a', toNote: 'b', toTitle: 'Beta' },
        { fromNote: 'a', toNote: null, toTitle: 'Dangling' },
      ]);
      // listLinkingTo matches by resolved id OR by case-insensitive title
      // (a dangling [[Beta]] counts as a link to whatever owns that title).
      expect(store.listLinkingTo('b', 'Beta')).toEqual(['a']);
      expect(store.listLinkingTo('b', 'beta')).toEqual(['a']);
      expect(store.listLinkingTo('nope', 'Gamma')).toEqual([]);
      store.replaceForNote('d', [{ toNote: null, toTitle: 'Beta' }]);
      expect(store.listLinkingTo('zz', 'Beta')).toEqual(['a', 'd']);

      // Replace drops the old edges and inserts the new ones.
      store.replaceForNote('a', [{ toNote: 'c', toTitle: 'Gamma' }]);
      expect(store.listFrom('a').map((l) => l.toTitle)).toEqual(['Gamma']);
      expect(store.listLinkingTo('b', 'Beta')).toEqual(['d']);
      expect(store.listLinkingTo('c', 'gamma')).toEqual(['a']);

      store.replaceForNote('d', [{ toNote: 'c', toTitle: 'Gamma' }]);
      expect(store.listLinkingTo('c', 'Gamma')).toEqual(['a', 'd']);

      store.removeForNote('a');
      expect(store.listFrom('a')).toEqual([]);
      expect(store.listLinkingTo('c', 'Gamma')).toEqual(['d']);
    } finally {
      db.close();
    }
  });

  it('plans round-trip with a whitelisted update patch', () => {
    const db = openDatabase(':memory:');
    try {
      const store = createPlanStore(db);
      const row: PlanRow = {
        id: 'p-1',
        title: 'Ship M5',
        description: null,
        document: '{"milestones":[]}',
        createdAt: 1,
        updatedAt: 1,
      };
      store.insert(row);
      expect(store.findById('p-1')?.title).toBe('Ship M5');

      store.update('p-1', {
        description: 'core notes + plans',
        document: '{"milestones":[{"id":"m1","title":"M","tasks":[]}]}',
        updatedAt: 2,
      });
      const updated = store.findById('p-1');
      expect(updated).toMatchObject({ description: 'core notes + plans', updatedAt: 2 });
      expect(JSON.parse(updated?.document ?? '{}')).toEqual({
        milestones: [{ id: 'm1', title: 'M', tasks: [] }],
      });

      store.insert({ ...row, id: 'p-2', title: 'Second', createdAt: 2, updatedAt: 2 });
      expect(store.list().map((r) => r.id)).toEqual(['p-1', 'p-2']);
      store.remove('p-1');
      expect(store.findById('p-1')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('notes_fts mirror upserts (delete+insert), deletes and matches with bm25 rank', () => {
    const db = openDatabase(':memory:');
    try {
      const fts = createNotesFtsStore(db);
      fts.upsertNote('n-1', 'groceries buy milk and eggs');
      fts.upsertNote('n-2', 'research sqlite fts5 ranking');
      fts.upsertPlan('p-1', 'plan migrate the notes schema');

      const notes = fts.match('"sqlite"', 50).filter((h) => h.kind === 'note');
      expect(notes.map((h) => h.refId)).toEqual(['n-2']);
      const plans = fts.match('"migrate"', 50).filter((h) => h.kind === 'plan');
      expect(plans.map((h) => h.refId)).toEqual(['p-1']);
      expect(typeof notes[0]?.rank).toBe('number');

      // Upsert REPLACES the row content (no stale duplicates).
      fts.upsertNote('n-1', 'moved to full length reports now');
      expect(fts.match('"milk"', 50).filter((h) => h.kind === 'note')).toHaveLength(0);
      expect(fts.match('"reports"', 50).filter((h) => h.kind === 'note').map((h) => h.refId)).toEqual(['n-1']);

      fts.deleteRef('note', 'n-1');
      fts.deleteRef('plan', 'p-1');
      expect(fts.match('"reports"', 50)).toHaveLength(0);
      expect(fts.match('"sqlite"', 50).filter((h) => h.kind === 'note')).toHaveLength(1);
      // Limit applies.
      for (let i = 0; i < 60; i += 1) fts.upsertNote(`bulk-${i}`, `keyword share-${i}`);
      expect(fts.match('"keyword"', 50)).toHaveLength(50);
    } finally {
      db.close();
    }
  });
});
