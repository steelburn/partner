/**
 * M29 — per-user file roots, including the UPGRADE path.
 *
 * The interesting case is not "a fresh user gets `<volume>/<id>`": it is that an
 * account created by the PREVIOUS layout still holds a `project_roots` row for
 * the shared volume root (`/files`). If that row survived, the deployment's own
 * isolation promise would be false for every existing account — the file tools
 * would still reach the directory every other account lives in. The derived set
 * is authoritative in login mode, so the stale row must go.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, loadConfig } from '../../src/index.js';
import { openDatabase, createProjectRootStore } from '../../src/stores/db.js';
import { removeTempRoot } from '../helpers.js';

const dirs: string[] = [];
const bundles: Array<{ close(): void }> = [];

afterEach(() => {
  for (const bundle of bundles.splice(0)) bundle.close();
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-roots-'));
  dirs.push(dir);
  return dir;
}

describe('M29 per-user file roots', () => {
  it('gives the account its own directory and PRUNES a stale shared-root row', () => {
    const dir = tempDir();
    const volume = join(dir, 'files');
    mkdirSync(volume, { recursive: true });
    const db = openDatabase(':memory:');
    // The pre-M29 row: the deployment volume root itself.
    createProjectRootStore(db).insert({
      id: 'stale-root',
      label: 'files',
      path: volume,
      readOnly: 0,
      addedAt: 1,
    });

    const config = {
      ...loadConfig({ DEMO_MODE: '1', SCHEDULER_TICK_MS: '0' }),
      userId: 'ama',
      dataRoot: dir,
      fixedRoots: [volume],
    };
    const bundle = createCore(config, db);
    bundles.push(bundle);

    const roots = bundle.projectRootManager.list();
    expect(roots).toHaveLength(1);
    const first = roots[0] as { path: string };
    expect(first.path).toBe(join(volume, 'ama'));
    expect(existsSync(join(volume, 'ama'))).toBe(true);
    // The shared directory is NOT a root any more.
    expect(roots.some((root) => root.path === volume)).toBe(false);
  });

  it('with no deployment volume, the root lives inside the account partition', () => {
    const dir = tempDir();
    const db = openDatabase(':memory:');
    const config = {
      ...loadConfig({ DEMO_MODE: '1', SCHEDULER_TICK_MS: '0' }),
      userId: 'bo',
      dataRoot: dir,
      fixedRoots: [] as string[],
    };
    const bundle = createCore(config, db);
    bundles.push(bundle);
    const roots = bundle.projectRootManager.list();
    expect(roots).toHaveLength(1);
    const first = roots[0] as { path: string };
    expect(first.path).toBe(join(dir, 'users', 'bo', 'files'));
  });
});
