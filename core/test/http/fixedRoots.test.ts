/**
 * M22 — DEPLOYMENT-OWNED project roots (the remote-hosted / container shape).
 *
 * A container mounts one volume and that is all the file tools may ever see, so
 * the deployment registers the root and the client surface becomes read-only.
 * What matters here:
 *
 *  - the roots are registered from config AT BOOT, idempotently (grants reference
 *    a root by ID, so a second boot must reuse the row — a duplicate insert would
 *    orphan every existing grant);
 *  - a configured root that is not a directory FAILS THE BOOT instead of leaving
 *    the tools with no reachable root;
 *  - `POST`/`DELETE /v1/roots` refuse with `roots_fixed` and move no state;
 *  - the desktop shape (no FIXED_ROOTS) is unchanged — the user still manages
 *    roots from the Files view.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { ALLOWED_HOST, demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { createCore } from '../../src/index.js';
import type { CoreConfig } from '../../src/index.js';
import { loadConfig } from '../../src/config.js';
import { openDatabase, createGrantStore, createProjectRootStore } from '../../src/stores/db.js';
import { createProjectRootManager } from '../../src/broker/roots.js';
import { createGrantManager } from '../../src/broker/grants.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-fixed-roots-'));
  dirs.push(dir);
  return dir;
}

/** A live-ish config, but built with createCore over an in-memory db. */
function configFor(fixedRoots: string[]): CoreConfig {
  return { ...loadConfig({ DEMO_MODE: '1', SCHEDULER_TICK_MS: '0' }), fixedRoots };
}

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const res = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

describe('config parsing (FIXED_ROOTS)', () => {
  it('is empty by default (desktop: the user owns the roots)', () => {
    expect(loadConfig({ DEMO_MODE: '1' }).fixedRoots).toEqual([]);
  });

  it('splits, trims and drops empty entries', () => {
    const cfg = loadConfig({ DEMO_MODE: '1', FIXED_ROOTS: ' /files , /data/docs ,' });
    expect(cfg.fixedRoots).toEqual(['/files', '/data/docs']);
  });

  it('refuses a relative path (it would follow the process CWD)', () => {
    expect(() => loadConfig({ DEMO_MODE: '1', FIXED_ROOTS: 'files' })).toThrow(/absolute/);
    expect(() => loadConfig({ DEMO_MODE: '1', FIXED_ROOTS: '/ok,relative' })).toThrow(/absolute/);
  });
});

describe('createCore registers the fixed roots', () => {
  it('registers each configured directory once, idempotently across boots', () => {
    const dir = tempDir();
    const rootA = join(dir, 'files');
    mkdirSync(rootA);
    const db = openDatabase(':memory:');
    try {
      const config = configFor([rootA]);
      const first = createCore(config, db);
      const roots = first.projectRootManager.list();
      expect(roots).toHaveLength(1);
      expect(roots[0]?.path).toBe(rootA);
      expect(roots[0]?.label).toBe('files');

      // A SECOND boot over the same store must reuse the row: the id is what a
      // grant points at, so a fresh id would orphan every grant.
      const again = createCore(config, db);
      const after = again.projectRootManager.list();
      expect(after).toHaveLength(1);
      expect(after[0]?.id).toBe(roots[0]?.id);
      first.close();
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an existing GRANT pointing at the same root across a boot', () => {
    const dir = tempDir();
    const rootDir = join(dir, 'files');
    mkdirSync(rootDir);
    const db = openDatabase(':memory:');
    try {
      const config = configFor([rootDir]);
      const first = createCore(config, db);
      const rootId = first.projectRootManager.list()[0]?.id as string;
      createGrantManager({ store: createGrantStore(db) }).add('files.read', rootId);

      // A second boot over the same store (the handle stays open: `close()`
      // shuts the database down, which is not what a restart looks like).
      const second = createCore(config, db);
      const rootsAfter = second.projectRootManager.list();
      expect(rootsAfter.map((r) => r.id)).toEqual([rootId]);
      const grants = createGrantManager({ store: createGrantStore(db) }).list().filter((g) => g.projectId === rootId);
      expect(grants.length).toBe(1);
      second.close();
      first.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to boot when a configured root is not a directory', () => {
    const dir = tempDir();
    const missing = join(dir, 'not-mounted');
    expect(() => createCore(configFor([missing]), openDatabase(':memory:'))).toThrow(
      /FIXED_ROOTS: .*not-mounted is not an existing directory/,
    );
  });
});

describe('the roots surface is read-only when the deployment owns them', () => {
  it('lists them and reports rootsFixed, refusing add and remove', async () => {
    const dir = tempDir();
    const rootDir = join(dir, 'files');
    mkdirSync(rootDir);
    const h = demoHarness({ rootsFixed: true });
    try {
      h.projectRootManager?.add({ label: 'files', path: rootDir });
      const token = await pairToken(h);

      const list = await request(h.app).get('/v1/roots').set(authed(token));
      expect(list.status).toBe(200);
      expect(list.body.rootsFixed).toBe(true);
      expect((list.body.roots as { path: string }[]).map((r) => r.path)).toEqual([rootDir]);
      const rootId = (list.body.roots as { id: string }[])[0]?.id as string;

      const add = await request(h.app)
        .post('/v1/roots')
        .set(authed(token))
        .send({ label: 'extra', path: dir });
      expect(add.status).toBe(403);
      expect(add.body.error).toBe('roots_fixed');
      expect(h.projectRootManager?.list()).toHaveLength(1);

      const remove = await request(h.app).delete(`/v1/roots/${rootId}`).set(authed(token));
      expect(remove.status).toBe(403);
      expect(remove.body.error).toBe('roots_fixed');
      expect(h.projectRootManager?.list()).toHaveLength(1);

      // The refusal is audited, and carries no path or label.
      const rows = h.audit.list(100).filter((r) => r.action === 'roots.change_denied');
      expect(rows.length).toBe(2);
      expect(JSON.stringify(rows)).not.toContain(rootDir);
    } finally {
      h.close();
    }
  });

  it('leaves the desktop shape alone (rootsFixed false, add/remove work)', async () => {
    const dir = tempDir();
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const list = await request(h.app).get('/v1/roots').set(authed(token));
      expect(list.body.rootsFixed).toBe(false);

      const add = await request(h.app)
        .post('/v1/roots')
        .set(authed(token))
        .send({ label: 'mine', path: dir });
      expect(add.status).toBe(201);
      const id = add.body.id as string;
      const remove = await request(h.app).delete(`/v1/roots/${id}`).set(authed(token));
      expect(remove.status).toBe(204);
    } finally {
      h.close();
    }
  });
});

describe('FIXED_ROOTS_READ_ONLY (R6)', () => {
  it('registers the roots read-only and the file tools refuse to write', async () => {
    const dir = tempDir();
    const rootDir = join(dir, 'files');
    mkdirSync(rootDir);
    const config = {
      ...configFor([rootDir]),
      fixedRootsReadOnly: true,
    };
    const db = openDatabase(':memory:');
    const bundle = createCore(config, db);
    try {
      const root = bundle.projectRootManager.list()[0];
      expect(root?.readOnly).toBe(true);

      // A grant does not help: the ROOT is read-only, refused inside the tool.
      const rootId = root?.id as string;
      createGrantManager({ store: createGrantStore(db) }).add('files.edit', rootId);
      const attempted = await bundle.broker.exec(
        'files.edit',
        { projectId: rootId, path: 'x.txt', proposedContent: 'nope' },
        { requestedBy: 'web' },
      );
      // The broker answers a typed denial rather than throwing (M2 contract).
      expect(attempted).toMatchObject({ outcome: 'denied', reason: 'read_only' });
    } finally {
      bundle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('config refuses the knob without roots, and the flag is off by default', () => {
    expect(loadConfig({ DEMO_MODE: '1' }).fixedRootsReadOnly).toBe(false);
    expect(loadConfig({ DEMO_MODE: '1', FIXED_ROOTS_READ_ONLY: '1' }).fixedRootsReadOnly).toBe(true);
  });
});
