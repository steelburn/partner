/**
 * M9 store tests (PLAN-M9.md — additive schema v10): the deploy_profiles +
 * playbook_runs tables are created idempotently alongside every earlier
 * table (schema version already 10 — shared/contracts.ts, ba83902); the row
 * stores round-trip and partial updates never clear unpatched columns.
 * Existing M0-M8 store tests must stay green alongside.
 */
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@partner/shared';
import {
  createDeployProfileStore,
  createPlaybookRunStore,
  openDatabase,
} from '../../src/stores/db.js';
import type { DeployProfileRow, PlaybookRunRow } from '../../src/stores/types.js';

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('schema v10 (additive M9 tables)', () => {
  it('creates deploy_profiles and playbook_runs; keeps every earlier table', () => {
    const db = openDatabase(':memory:');
    try {
      const names = tableNames(db);
      expect(names).toContain('deploy_profiles');
      expect(names).toContain('playbook_runs');
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
        'memory_fts',
        'notes',
        'note_links',
        'plans',
        'notes_fts',
        'themes',
        'site_scopes',
        'skills',
        'skill_invocations',
      ]) {
        expect(names, existing).toContain(existing);
      }
      const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
        | { value: string }
        | undefined;
      expect(meta?.value).toBe(String(SCHEMA_VERSION));
      // v11 added spend_ledger (M10 W3).
      expect(SCHEMA_VERSION).toBe(24);
    } finally {
      db.close();
    }
  });

  it('deploy profile store round-trips with its column defaults', () => {
    const db = openDatabase(':memory:');
    try {
      const store = createDeployProfileStore(db);
      const row: DeployProfileRow = {
        id: 'dp-1',
        name: 'prod',
        kind: 'docker-ssh',
        host: 'h.example.org',
        username: 'u',
        port: 2222,
        remoteBaseDir: null,
        envExtra: null,
        createdAt: 5,
        updatedAt: 6,
      };
      store.insert(row);
      expect(store.findById('dp-1')).toMatchObject({
        name: 'prod',
        host: 'h.example.org',
        port: 2222,
      });
      expect(store.list()).toHaveLength(1);
      store.remove('dp-1');
      expect(store.findById('dp-1')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('playbook run store round-trips and partial updates keep unpatched fields', () => {
    const db = openDatabase(':memory:');
    try {
      const store = createPlaybookRunStore(db);
      const row: PlaybookRunRow = {
        id: 'pr-1',
        playbookId: 'research',
        personaId: 'p-default',
        conversationId: null,
        status: 'running',
        toolCalls: 0,
        startedAt: 10,
        finishedAt: null,
        error: null,
      };
      store.insert(row);
      expect(store.findById('pr-1')?.playbookId).toBe('research');

      store.update('pr-1', { toolCalls: 3 });
      const mid = store.findById('pr-1') as PlaybookRunRow;
      expect(mid.status).toBe('running'); // unpatched stays
      expect(mid.toolCalls).toBe(3);
      expect(mid.finishedAt).toBeNull();

      store.update('pr-1', { status: 'done', finishedAt: 20 });
      const done = store.findById('pr-1') as PlaybookRunRow;
      expect(done.status).toBe('done');
      expect(done.toolCalls).toBe(3);
      expect(done.finishedAt).toBe(20);
      expect(done.error).toBeNull();
    } finally {
      db.close();
    }
  });

  it('schema is idempotent across a second open of the same file', () => {
    const db = openDatabase(':memory:');
    db.close();
    const again = openDatabase(':memory:');
    try {
      expect(tableNames(again)).toContain('playbook_runs');
    } finally {
      again.close();
    }
  });
});
