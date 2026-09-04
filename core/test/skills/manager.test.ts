/**
 * M8 skill manager tests (PLAN-M8.md). install() validates + sha256s the
 * entry file + copies the bundle from the catalog into the store dir + records
 * the row; double install is a typed conflict. list/get/disable/enable keep
 * status invariants (conflict on no-op transitions), remove() wipes the code
 * dir AND the invocation history. Audit rows carry ids/versions only.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createSkillManager } from '../../src/skills/manager.js';
import { SkillError } from '../../src/skills/errors.js';
import { REPO_CATALOG, makeTempRoot, removeTempRoot } from '../helpers.js';
import { openDatabase, createSkillStore, createSkillInvocationStore, createAuditStore } from '../../src/stores/db.js';
import { auditLog } from '../../src/services/redaction.js';

function env() {
  const db = openDatabase(':memory:');
  const storeDir = makeTempRoot();
  const audit = auditLog({ store: createAuditStore(db) });
  const store = createSkillStore(db);
  const invocations = createSkillInvocationStore(db);
  const manager = createSkillManager({
    store,
    invocations,
    storeDir,
    catalogDir: REPO_CATALOG,
    tools: new Set(['files.read', 'files.list', 'files.search', 'files.edit', 'files.apply', 'files.delete']),
    audit,
  });
  return { db, storeDir, audit, store, invocations, manager, close(): void { db.close(); removeTempRoot(storeDir); } };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'no-error';
  } catch (err) {
    return (err as SkillError).code;
  }
}

describe('skill manager', () => {
  it('install copies code + records sha256 + returns a full summary', () => {
    const h = env();
    try {
      const summary = h.manager.install('hello-skill');
      expect(summary).toMatchObject({
        id: 'hello-skill',
        name: 'Hello Skill',
        version: '0.1.0',
        source: 'local',
        status: 'installed',
      });
      expect(summary.sha256).toMatch(/^[0-9a-f]{64}$/);
      // Code dir exists with the copied manifest + entry.
      const dir = join(h.storeDir, 'hello-skill');
      expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
      expect(existsSync(join(dir, 'entry.mjs'))).toBe(true);
      // sha matches the entry file on disk.
      const expected = readFileSync(join(REPO_CATALOG, 'hello-skill', 'entry.mjs'));
      expect(summary.sha256).toBe(sha256Of(expected));
      // Row recorded.
      expect(h.manager.list()).toHaveLength(1);
      expect(h.audit.list(50).map((a) => a.action)).toContain('skill.install');
      const row = h.audit.list(50).find((a) => a.action === 'skill.install');
      expect(JSON.parse(row?.details ?? '{}')).toMatchObject({ version: '0.1.0', source: 'local' });
    } finally {
      h.close();
    }
  });

  it('double install is an idempotent conflict (typed)', () => {
    const h = env();
    try {
      h.manager.install('hello-skill');
      expect(codeOf(() => h.manager.install('hello-skill'))).toBe('conflict');
      expect(h.manager.list()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('network skill install is refused with network_not_supported', () => {
    // A network skill never appears in the repo catalog listing, but a direct
    // install by id must still refuse with the clear typed error.
    const h = env();
    try {
      // Point the manager at a fixture catalog containing a network skill.
      const catalogDir = makeTempRoot();
      mkdirSync(join(catalogDir, 'net-skill'), { recursive: true });
      writeFileSync(
        join(catalogDir, 'net-skill', 'manifest.json'),
        JSON.stringify({
          id: 'net-skill',
          name: 'Net',
          description: 'd',
          author: 'a',
          version: '1',
          entrypoint: 'entry.mjs',
          permissions: { network: true, risk: 'low' },
        }),
      );
      writeFileSync(join(catalogDir, 'net-skill', 'entry.mjs'), 'export function run(){}');
      const manager = createSkillManager({
        store: h.store,
        invocations: h.invocations,
        storeDir: h.storeDir,
        catalogDir,
        tools: new Set(['files.read']),
        audit: h.audit,
      });
      expect(codeOf(() => manager.install('net-skill'))).toBe('network_not_supported');
      removeTempRoot(catalogDir);
    } finally {
      h.close();
    }
  });

  it('unknown catalog id install -> not_found', () => {
    const h = env();
    try {
      expect(codeOf(() => h.manager.install('ghost'))).toBe('not_found');
    } finally {
      h.close();
    }
  });

  it('get returns the parsed manifest detail; list orders by install', () => {
    const h = env();
    try {
      h.manager.install('hello-skill');
      h.manager.install('note-echo');
      const detail = h.manager.get('note-echo');
      expect(detail).toMatchObject({ id: 'note-echo', status: 'installed' });
      expect(detail?.manifest.permissions).toEqual({ tools: [], network: false, risk: 'low' });
      expect(h.manager.get('ghost')).toBeNull();
      expect(h.manager.list().map((s) => s.id)).toEqual(['hello-skill', 'note-echo']);
    } finally {
      h.close();
    }
  });

  it('disable/enable transitions with typed conflicts on no-ops', () => {
    const h = env();
    try {
      h.manager.install('hello-skill');
      const disabled = h.manager.disable('hello-skill');
      expect(disabled.status).toBe('disabled');
      expect(h.manager.get('hello-skill')?.status).toBe('disabled');
      expect(codeOf(() => h.manager.disable('hello-skill'))).toBe('conflict');
      expect(codeOf(() => h.manager.enable('ghost'))).toBe('not_found');
      const enabled = h.manager.enable('hello-skill');
      expect(enabled.status).toBe('installed');
      expect(codeOf(() => h.manager.enable('hello-skill'))).toBe('conflict');
      const actions = h.audit.list(50).map((a) => a.action);
      expect(actions).toContain('skill.disable');
      expect(actions).toContain('skill.enable');
    } finally {
      h.close();
    }
  });

  it('remove wipes the code dir + row + invocations and refuses unknowns', () => {
    const h = env();
    try {
      h.manager.install('hello-skill');
      h.invocations.insert({
        id: 'inv-1',
        skillId: 'hello-skill',
        personaId: null,
        startedAt: 1,
        finishedAt: 2,
        ok: 1,
        toolCalls: 0,
        error: null,
        ms: 1,
      });
      const dir = join(h.storeDir, 'hello-skill');
      expect(existsSync(dir)).toBe(true);
      h.manager.remove('hello-skill');
      expect(existsSync(dir)).toBe(false);
      expect(h.manager.list()).toHaveLength(0);
      expect(h.invocations.listBySkill('hello-skill', 10)).toHaveLength(0);
      expect(codeOf(() => h.manager.remove('hello-skill'))).toBe('not_found');
      expect(h.audit.list(50).map((a) => a.action)).toContain('skill.uninstall');
    } finally {
      h.close();
    }
  });

  it('listInvocations returns metadata rows only (no content columns)', () => {
    const h = env();
    try {
      h.manager.install('hello-skill');
      h.invocations.insert({
        id: 'i1',
        skillId: 'hello-skill',
        personaId: 'p-1',
        startedAt: 5,
        finishedAt: 9,
        ok: 1,
        toolCalls: 2,
        error: null,
        ms: 4,
      });
      const meta = h.manager.listInvocations('hello-skill');
      expect(meta).toHaveLength(1);
      expect(meta[0]).toMatchObject({
        id: 'i1',
        skillId: 'hello-skill',
        personaId: 'p-1',
        ok: true,
        toolCalls: 2,
        error: null,
        ms: 4,
      });
      expect(Object.keys(meta[0] ?? {}).sort()).toEqual([
        'error',
        'finishedAt',
        'id',
        'ms',
        'ok',
        'personaId',
        'skillId',
        'startedAt',
        'toolCalls',
      ]);
    } finally {
      h.close();
    }
  });
});

/** sha256 hex of a buffer (entry-file integrity at install). */
function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
