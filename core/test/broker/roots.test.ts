/**
 * Project-root manager tests (M2): add() requires an absolute EXISTING
 * directory, canonicalizes + symlink-resolves it, rejects duplicates; list /
 * getById / remove behave; the four M2 tables exist on a fresh schema v3 db.
 */
import { makeTempRoot, removeTempRoot, canCreateSymlinks } from '../helpers.js';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, createProjectRootStore } from '../../src/stores/db.js';
import { createProjectRootManager } from '../../src/broker/roots.js';
import type { ProjectRootManager } from '../../src/broker/roots.js';
import type { ToolError } from '../../src/broker/errors.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(makeTempRoot());
  dirs.push(dir);
  return dir;
}

function newManager(): { manager: ProjectRootManager; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase(':memory:');
  return { manager: createProjectRootManager({ store: createProjectRootStore(db) }), db };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

describe('project root manager', () => {
  it('schema v3 creates the four M2 tables', () => {
    const db = openDatabase(':memory:');
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    for (const table of ['project_roots', 'grants', 'pending_tools', 'file_proposals']) {
      expect(names).toContain(table);
    }
    db.close();
  });

  it.skipIf(!canCreateSymlinks())('add requires an absolute existing directory and canonicalizes', () => {
    const { manager } = newManager();
    const dir = tempDir();
    mkdirSync(join(dir, 'nested'));
    const nested = realpathSync(join(dir, 'nested'));

    // Symlink to a dir is stored as its REAL path.
    symlinkSync(nested, join(dir, 'alias'));
    const root = manager.add({ label: 'code', path: join(dir, 'alias') });
    expect(root.path).toBe(nested);
    expect(root.label).toBe('code');
    expect(root.readOnly).toBe(false);
    expect(manager.getById(root.id)?.path).toBe(nested);
  });

  it('add rejects relative, missing, and non-directory paths', () => {
    const { manager } = newManager();
    const dir = tempDir();
    writeFileSync(join(dir, 'file.txt'), 'x');
    expect(() => manager.add({ label: 'r', path: 'relative/path' })).toThrowError(
      expect.objectContaining({ code: 'bad_params' }),
    );
    expect(() => manager.add({ label: 'r', path: join(dir, 'missing') })).toThrowError(
      expect.objectContaining({ code: 'bad_params' }),
    );
    expect(() => manager.add({ label: 'r', path: join(dir, 'file.txt') })).toThrowError(
      expect.objectContaining({ code: 'bad_params' }),
    );
    expect(() => manager.add({ label: '  ', path: dir })).toThrowError(
      expect.objectContaining({ code: 'bad_params' }),
    );
  });

  it('add rejects duplicate canonical paths and persists readOnly', () => {
    const { manager } = newManager();
    const dir = tempDir();
    const first = manager.add({ label: 'one', path: dir, readOnly: true });
    expect(first.readOnly).toBe(true);
    expect(() => manager.add({ label: 'two', path: dir })).toThrowError(
      expect.objectContaining({ code: 'exists' }),
    );
    expect(manager.list()).toHaveLength(1);
  });

  it('list orders by addedAt and remove revokes (404-style not_found when absent)', () => {
    const { manager } = newManager();
    const a = tempDir();
    const b = tempDir();
    const rootA = manager.add({ label: 'a', path: a });
    const rootB = manager.add({ label: 'b', path: b });
    expect(manager.list().map((r) => r.id)).toEqual([rootA.id, rootB.id]);

    manager.remove(rootA.id);
    expect(manager.getById(rootA.id)).toBeNull();
    expect(manager.list().map((r) => r.id)).toEqual([rootB.id]);

    try {
      manager.remove('nope');
      throw new Error('expected not_found');
    } catch (err) {
      expect((err as ToolError).code).toBe('not_found');
    }
  });
});
