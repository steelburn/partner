/**
 * M8 store tests (PLAN-M8.md — additive schema v9). The two new tables are
 * plain typed CRUD over the same SQLite handle: skills holds one row per
 * installed skill (manifest JSON + entry SHA + status); skill_invocations is
 * a metadata log (ok/toolCalls/ms/error codes — never content). Schema stays
 * additive + idempotent: opening the same file twice (or after a re-open)
 * never fails. SCHEMA_VERSION moved 9 → 10 with the M9 wire contracts
 * (ba83902): deploy_profiles + playbook_runs live in the shared constant
 * while this milestone's own tables were already on the same schema.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase, createSkillStore, createSkillInvocationStore } from '../../src/stores/db.js';
import { SCHEMA_VERSION } from '@partner/shared';
import { makeTempRoot, removeTempRoot } from '../helpers.js';
import { join } from 'node:path';

describe('M8 skills stores (additive, idempotent)', () => {
  // The version is asserted as a LITERAL on purpose: a schema bump must be a
  // deliberate edit here, not something that silently follows the constant. The
  // title therefore does NOT name a version — it drifted to "at 11" while
  // asserting 18, which is precisely the contradiction a schema guard exists to
  // surface.
  it('stamps the current SCHEMA_VERSION into the meta row (18 at the time of writing)', () => {
    const db = openDatabase(':memory:');
    const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as {
      value: string;
    };
    expect(SCHEMA_VERSION).toBe(19);
    expect(meta.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it('re-opening the same file db twice is safe (additive, idempotent)', () => {
    const dir = makeTempRoot();
    try {
      const location = join(dir, 'skills.db');
      const first = openDatabase(location);
      createSkillStore(first).insert({
        id: 'hello-skill',
        name: 'Hello',
        description: 'd',
        author: 'a',
        version: '0.1.0',
        entrypoint: 'entry.mjs',
        manifestJson: '{}',
        sha256: 'aa',
        source: 'local',
        status: 'installed',
        installedAt: 1,
        updatedAt: 1,
      });
      first.close();
      // Re-open after close: CREATE TABLE IF NOT EXISTS is a no-op.
      const second = openDatabase(location);
      const store = createSkillStore(second);
      expect(store.findById('hello-skill')).toMatchObject({ id: 'hello-skill' });
      second.close();
    } finally {
      removeTempRoot(dir);
    }
  });

  it('skill store CRUD: insert / find / list / update / remove', () => {
    const db = openDatabase(':memory:');
    const store = createSkillStore(db);
    const row = {
      id: 'hello-skill',
      name: 'Hello Skill',
      description: 'Returns a greeting.',
      author: 'Partner Samples',
      version: '0.1.0',
      entrypoint: 'entry.mjs',
      manifestJson: '{"id":"hello-skill"}',
      sha256: '0123456789abcdef',
      source: 'local',
      status: 'installed',
      installedAt: 100,
      updatedAt: 100,
    };
    store.insert(row);
    expect(store.findById('hello-skill')).toMatchObject({ status: 'installed' });
    expect(store.findById('nope')).toBeUndefined();
    expect(store.list()).toHaveLength(1);

    store.update('hello-skill', { status: 'disabled', updatedAt: 200 });
    expect(store.findById('hello-skill')).toMatchObject({ status: 'disabled', updatedAt: 200 });
    // Patch list order does not matter; other fields untouched.
    store.update('hello-skill', { sha256: 'deadbeef', updatedAt: 300 });
    expect(store.findById('hello-skill')).toMatchObject({ sha256: 'deadbeef', updatedAt: 300 });

    store.remove('hello-skill');
    expect(store.list()).toHaveLength(0);
    db.close();
  });

  it('invocation store: insert / newest-first listBySkill / removeBySkill', () => {
    const db = openDatabase(':memory:');
    const store = createSkillInvocationStore(db);
    store.insert({
      id: 'i1',
      skillId: 'hello-skill',
      personaId: null,
      startedAt: 10,
      finishedAt: 15,
      ok: 1,
      toolCalls: 0,
      error: null,
      ms: 5,
    });
    store.insert({
      id: 'i2',
      skillId: 'hello-skill',
      personaId: 'p-1',
      startedAt: 20,
      finishedAt: 21,
      ok: 0,
      toolCalls: 1,
      error: 'tool_denied',
      ms: 1,
    });
    store.insert({
      id: 'other',
      skillId: 'files-preview',
      personaId: null,
      startedAt: 30,
      finishedAt: 31,
      ok: 1,
      toolCalls: 2,
      error: null,
      ms: 1,
    });
    const rows = store.listBySkill('hello-skill', 10);
    expect(rows.map((r) => r.id)).toEqual(['i2', 'i1']); // newest first
    expect(store.findById('i1')?.skillId).toBe('hello-skill');

    store.removeBySkill('hello-skill');
    expect(store.listBySkill('hello-skill', 10)).toHaveLength(0);
    expect(store.findById('other')).toBeDefined(); // other skill untouched
    db.close();
  });
});
