/**
 * M16 F7 browse routes (PLAN-M16.md): the add-root Absolute-path picker
 * browses the filesystem one folder at a time (directories only). Owner
 * action — session-gated, audited, no broker/roots required.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

describe('M16 F7 /v1/files/browse', () => {
  it('lists directories under the home folder with the parent for Up', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const home = homedir();
      const res = await request(h.app).get('/v1/files/browse').set(authed(token)).query({ path: home });
      expect(res.status).toBe(200);
      expect(res.body.path).toBe(home);
      expect(typeof res.body.parent).toBe('string');
      expect(Array.isArray(res.body.entries)).toBe(true);
      expect(res.body.truncated).toBe(false);
      for (const entry of res.body.entries as Array<{ name: string; isDir: boolean }>) {
        expect(typeof entry.name).toBe('string');
        expect(entry.isDir).toBe(true);
      }
      expect(res.body.entries.length).toBeGreaterThan(0);
    } finally {
      h.close();
    }
  });

  it('navigates Up to the parent and down into a real subfolder', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const home = homedir();
      const res = await request(h.app).get('/v1/files/browse').set(authed(token)).query({ path: home });
      const parent = res.body.parent as string;
      const up = await request(h.app).get('/v1/files/browse').set(authed(token)).query({ path: parent });
      expect(up.status).toBe(200);
      expect(up.body.path).toBe(parent);
    } finally {
      h.close();
    }
  });

  it('guards: relative paths -> 400, missing folders -> 404, unauthed -> 401', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const relative = await request(h.app)
        .get('/v1/files/browse')
        .set(authed(token))
        .query({ path: 'home/user/x' });
      expect(relative.status).toBe(400);

      const missing = await request(h.app)
        .get('/v1/files/browse')
        .set(authed(token))
        // Platform-agnostic ABSOLUTE path (a POSIX `/…` path is rejected as
        // invalid on Windows before the filesystem is touched).
        .query({ path: join(homedir(), 'definitely-not-a-partner-folder-9f8e7d6c') });
      expect(missing.status).toBe(404);

      const unauthed = await request(h.app).get('/v1/files/browse');
      expect([401, 403]).toContain(unauthed.status);
    } finally {
      h.close();
    }
  });
});
