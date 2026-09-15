/**
 * M6 store tests (PLAN-M6.md, schema v7): the `themes` table is created
 * idempotently alongside every earlier table (schema version already 7 —
 * shared/contracts.ts, 238b20a); the row store round-trips with a
 * whitelisted update patch. Existing M0-M5 store tests must stay green
 * alongside (additive schema only).
 */
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@partner/shared';
import { createThemeStore, openDatabase } from '../../src/stores/db.js';
import type { ThemeRow } from '../../src/stores/types.js';

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

const ROW: ThemeRow = {
  id: 'preset-default',
  name: 'Default',
  source: 'preset',
  lightJson: '{"bg":"#ffffff","text":"#16181d"}',
  darkJson: '{"bg":"#101214","text":"#e8eaed"}',
  createdAt: 10,
  updatedAt: 10,
};

describe('schema v7 (additive M6 themes table)', () => {
  it('creates themes and keeps every earlier table; records schema v7', () => {
    const db = openDatabase(':memory:');
    try {
      const names = tableNames(db);
      expect(names).toContain('themes');
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
        'notes',
        'note_links',
        'plans',
        'notes_fts',
      ]) {
        expect(names, existing).toContain(existing);
      }
      const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
        | { value: string }
        | undefined;
      expect(meta?.value).toBe(String(SCHEMA_VERSION));
      // M9 (PLAN-M9.md, ba83902) raised the schema to 10 (deploy_profiles +
      // playbook_runs); the themes milestone (M6, 238b20a) was v7.
      // v11 added spend_ledger (M10 W3); v12 added M11 guarded columns.
      expect(SCHEMA_VERSION).toBe(20);
    } finally {
      db.close();
    }
  });

  it('schema is idempotent across a second open (no duplicate tables)', () => {
    const db = openDatabase(':memory:');
    try {
      db.prepare("INSERT INTO themes (id, name, source, light_json, dark_json, created_at, updated_at) VALUES ('x','X','preset','{}','{}',1,1)").run();
      const first = tableNames(db)
        .filter((n) => ['notes_fts', 'themes'].includes(n))
        .sort();
      const db2 = openDatabase(':memory:');
      try {
        const second = tableNames(db2)
          .filter((n) => ['notes_fts', 'themes'].includes(n))
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

describe('M6 themes row store (plain CRUD)', () => {
  it('round-trips rows; list is creation-ordered; count works', () => {
    const db = openDatabase(':memory:');
    try {
      const store = createThemeStore(db);
      store.insert(ROW);
      store.insert({
        ...ROW,
        id: 'custom-2',
        name: 'Second',
        source: 'custom',
        createdAt: 11,
        updatedAt: 11,
      });
      expect(store.findById('preset-default')).toMatchObject({ name: 'Default', source: 'preset' });
      expect(store.findById('missing')).toBeUndefined();
      expect(store.list().map((r) => r.id)).toEqual(['preset-default', 'custom-2']);
      expect(store.count()).toBe(2);

      // Whitelisted patch: name + a token doc; created_at is untouched.
      store.update('custom-2', {
        name: 'Second v2',
        lightJson: '{"bg":"#ffffff"}',
        updatedAt: 20,
      });
      expect(store.findById('custom-2')).toMatchObject({
        name: 'Second v2',
        lightJson: '{"bg":"#ffffff"}',
        updatedAt: 20,
      });
      expect(store.findById('custom-2')?.createdAt).toBe(11);
      // Bare touch only bumps updated_at.
      store.update('preset-default', { updatedAt: 21 });
      expect(store.findById('preset-default')?.updatedAt).toBe(21);

      store.remove('custom-2');
      expect(store.findById('custom-2')).toBeUndefined();
      expect(store.count()).toBe(1);
    } finally {
      db.close();
    }
  });
});
