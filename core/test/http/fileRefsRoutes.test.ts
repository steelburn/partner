/**
 * M11 F1 file-reference route tests (PLAN-M11.md).
 *
 * /v1/files/refs lists files ONLY inside roots with an ACTIVE files.read
 * grant — roots without a grant never leak filenames.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

describe('M11 F1 file refs route', () => {
  it('lists granted-root files only and filters by query', async () => {
    const h = demoHarness();
    const dirA = mkdtempSync(join(tmpdir(), 'partner-refs-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'partner-refs-b-'));
    dirs.push(dirA, dirB);
    writeFileSync(join(dirA, 'alpha.md'), '# Alpha');
    mkdirSync(join(dirA, 'notes'));
    writeFileSync(join(dirA, 'notes', 'zeta.txt'), 'zeta');
    writeFileSync(join(dirB, 'secret.txt'), 'secret');
    try {
      const token = await pairToken(h);
      const broker = h.broker as NonNullable<Harness['broker']>;
      const rootA = broker.roots.add({ label: 'AlphaRoot', path: dirA });
      broker.roots.add({ label: 'SecretRoot', path: dirB });
      // Grant files.read for root A only.
      broker.grants.add('files.read', rootA.id, {});

      const all = await request(h.app).get('/v1/files/refs').set(authed(token));
      expect(all.status).toBe(200);
      const paths = (all.body.refs as Array<{ path: string; rootLabel: string }>).map((r) => r.path);
      expect(paths).toContain('alpha.md');
      expect(paths).toContain('notes/zeta.txt');
      // Root B has no grant — its filenames never appear.
      expect(paths.some((p) => p.includes('secret'))).toBe(false);
      expect(all.body.refs.every((r: { rootLabel: string }) => r.rootLabel === 'AlphaRoot')).toBe(true);

      const filtered = await request(h.app)
        .get('/v1/files/refs?q=zeta')
        .set(authed(token));
      const filteredPaths = (filtered.body.refs as Array<{ path: string }>).map((r) => r.path);
      expect(filteredPaths).toEqual(['notes/zeta.txt']);

      // q that matches nothing yields an empty list (not an error).
      const none = await request(h.app).get('/v1/files/refs?q=nope').set(authed(token));
      expect(none.status).toBe(200);
      expect((none.body.refs as unknown[]).length).toBe(0);
    } finally {
      h.close();
    }
  });
});
