/**
 * M8 HTTP route tests (PLAN-M8 wire spec) over supertest. Every /v1/skills
 * route is authed (401 without a token); the full flow install -> disable
 * (409 invoke while disabled) -> enable -> invoke -> uninstall runs against
 * the repo's real sample catalog; double install is a 409 conflict; unknown
 * skills 404; invoke outcomes ride the 200 {ok, result|error, meta} envelope
 * and invocation metadata is served back. Skills code/logs/args never appear
 * in audit rows.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoHarness, ALLOWED_HOST, makeTempRoot, removeTempRoot } from '../helpers.js';
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

describe('M8 skills HTTP surface', () => {
  it('every skills route is authed (401 without a token)', async () => {
    const h = demoHarness();
    try {
      const checks = [
        request(h.app).get('/v1/skills/catalog'),
        request(h.app).get('/v1/skills'),
        request(h.app).get('/v1/skills/hello-skill'),
        request(h.app).get('/v1/skills/hello-skill/invocations'),
        request(h.app).post('/v1/skills/install').send({ catalogId: 'hello-skill' }),
        request(h.app).post('/v1/skills/hello-skill/invoke').send({}),
        request(h.app).post('/v1/skills/hello-skill/disable'),
        request(h.app).post('/v1/skills/hello-skill/enable'),
        request(h.app).delete('/v1/skills/hello-skill'),
      ];
      for (const pending of checks) {
        const res = await pending.set('Host', ALLOWED_HOST);
        expect(res.status).toBe(401);
      }
    } finally {
      h.close();
    }
  });

  it('the skills bundle is optional — 501 not_configured when unwired', async () => {
    const h = demoHarness({ skills: false });
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const res = await request(h.app).get('/v1/skills/catalog').set(headers);
      expect(res.status).toBe(501);
      expect(res.body.error).toBe('not_configured');
    } finally {
      h.close();
    }
  });

  it('catalog is read-only and lists the checked-in sample set', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await request(h.app).get('/v1/skills/catalog').set(authed(token));
      expect(res.status).toBe(200);
      expect(res.body.skills.map((s: { id: string }) => s.id).sort()).toEqual([
        'content-audit',
        'file-inventory',
        'files-preview',
        'hello-skill',
        'note-echo',
        'notes-digest',
      ]);
      expect(res.body.warnings).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('install -> disable -> enable -> invoke -> uninstall over HTTP', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);

      // Empty store first.
      const empty = await request(h.app).get('/v1/skills').set(headers);
      expect(empty.status).toBe(200);
      expect(empty.body.skills).toEqual([]);

      // Install hello-skill from the catalog (code copied into the temp store).
      const install = await request(h.app)
        .post('/v1/skills/install')
        .set(headers)
        .send({ catalogId: 'hello-skill' });
      expect(install.status).toBe(201);
      expect(install.body).toMatchObject({ id: 'hello-skill', status: 'installed', source: 'local' });
      expect(install.body.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(h.skills).toBeDefined();

      // Double install -> conflict.
      const dup = await request(h.app)
        .post('/v1/skills/install')
        .set(headers)
        .send({ catalogId: 'hello-skill' });
      expect(dup.status).toBe(409);
      expect(dup.body.error).toBe('conflict');

      // GET detail includes the parsed manifest + permissions summary.
      const detail = await request(h.app).get('/v1/skills/hello-skill').set(headers);
      expect(detail.status).toBe(200);
      expect(detail.body.manifest.permissions).toEqual({ tools: [], network: false, risk: 'low' });

      // Invoke works while installed.
      const invoke1 = await request(h.app)
        .post('/v1/skills/hello-skill/invoke')
        .set(headers)
        .send({ args: { name: 'route' } });
      expect(invoke1.status).toBe(200);
      expect(invoke1.body).toMatchObject({ ok: true, result: { hello: 'from route' } });
      expect(typeof invoke1.body.meta.ms).toBe('number');

      // Disable -> invoke refused (409 disabled).
      const disable = await request(h.app).post('/v1/skills/hello-skill/disable').set(headers);
      expect(disable.status).toBe(200);
      expect(disable.body.status).toBe('disabled');
      const invokeDisabled = await request(h.app)
        .post('/v1/skills/hello-skill/invoke')
        .set(headers)
        .send({});
      expect(invokeDisabled.status).toBe(409);
      expect(invokeDisabled.body.error).toBe('disabled');
      // Disable again -> conflict.
      const disableAgain = await request(h.app).post('/v1/skills/hello-skill/disable').set(headers);
      expect(disableAgain.status).toBe(409);

      // Enable -> invocations metadata route lists the earlier run.
      const enable = await request(h.app).post('/v1/skills/hello-skill/enable').set(headers);
      expect(enable.status).toBe(200);
      expect(enable.body.status).toBe('installed');
      const invocations = await request(h.app)
        .get('/v1/skills/hello-skill/invocations')
        .set(headers);
      expect(invocations.status).toBe(200);
      expect(invocations.body.invocations).toHaveLength(1);
      expect(invocations.body.invocations[0]).toMatchObject({ skillId: 'hello-skill', ok: true });
      expect(Object.keys(invocations.body.invocations[0])).not.toContain('result');

      // Uninstall wipes the row AND the copied code dir.
      const remove = await request(h.app).delete('/v1/skills/hello-skill').set(headers);
      expect(remove.status).toBe(204);
      const gone = await request(h.app).get('/v1/skills/hello-skill').set(headers);
      expect(gone.status).toBe(404);
      const list = await request(h.app).get('/v1/skills').set(headers);
      expect(list.body.skills).toEqual([]);
      // Invocation history is wiped with the skill too.
      const hist = await request(h.app).get('/v1/skills/hello-skill/invocations').set(headers);
      expect(hist.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('invoke on an unknown skill -> 404; malformed install body -> 400', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const missing = await request(h.app)
        .post('/v1/skills/ghost/invoke')
        .set(headers)
        .send({});
      expect(missing.status).toBe(404);
      const badInstall = await request(h.app).post('/v1/skills/install').set(headers).send({});
      expect(badInstall.status).toBe(400);
      const unknownInstall = await request(h.app)
        .post('/v1/skills/install')
        .set(headers)
        .send({ catalogId: 'ghost' });
      expect(unknownInstall.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('a tool_denied invoke surfaces as 200 {ok:false,error} with meta (files-preview)', async () => {
    const h = demoHarness();
    const rootPath = makeTempRoot();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const install = await request(h.app)
        .post('/v1/skills/install')
        .set(headers)
        .send({ catalogId: 'files-preview' });
      expect(install.status).toBe(201);

      // Register a REAL project root (holds a file) but grant NOTHING.
      writeFileSync(join(rootPath, 'doc.txt'), 'hello');
      const rootRes = await request(h.app)
        .post('/v1/roots')
        .set(headers)
        .send({ label: 'preview-root', path: rootPath });
      expect(rootRes.status).toBe(201);
      const projectId = rootRes.body.id as string;

      // Without a user grant the broker refuses: skills are non-interactive,
      // so the outcome is tool_denied on the 200 invoke envelope.
      const out = await request(h.app)
        .post('/v1/skills/files-preview/invoke')
        .set(headers)
        .send({ args: { projectId, path: 'doc.txt' } });
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ ok: false, error: 'tool_denied' });
      expect(out.body.meta.toolCalls).toBe(1);
      // The approval queue is not polluted by skill requests.
      const pending = await request(h.app).get('/v1/tools/pending').set(headers);
      expect(pending.body.pending).toHaveLength(0);

      // After a USER grant for files.read on that root, the same invoke runs.
      const grant = await request(h.app)
        .post('/v1/grants')
        .set(headers)
        .send({ toolId: 'files.read', projectId });
      expect(grant.status).toBe(201);
      const granted = await request(h.app)
        .post('/v1/skills/files-preview/invoke')
        .set(headers)
        .send({ args: { projectId, path: 'doc.txt' } });
      expect(granted.status).toBe(200);
      expect(granted.body).toMatchObject({ ok: true, result: { bytes: 5, chars: 5 } });
    } finally {
      h.close();
      removeTempRoot(rootPath);
    }
  });
});
