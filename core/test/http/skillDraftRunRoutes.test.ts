/**
 * M26 cut E - the dry-run and bundle HTTP surface (PLAN-M26.md D5/D12).
 *
 * What these pin beyond "the routes answer":
 *   · the run route is the owner's own action and nothing else: it is authed,
 *     gated on `skill.author` (so a mobile-class session is refused BY NAME),
 *     and it 501s when no draft manager is wired;
 *   · the run RESPONSE is the shared `SkillDraftRun` envelope - ok/result, or a
 *     coded failure WITH the worker's own redacted log lines, so an import-time
 *     crash is readable in the Studio;
 *   · export hands the SPA the bundle JSON, and import lands it as a new INERT
 *     draft (never an installed skill).
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_HOST, demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

async function classToken(h: Harness, clientClass: string): Promise<string> {
  const created = await h.sessions.create({ kind: 'web', origin: ALLOWED_HOST, clientClass });
  return created.token;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

const BUNDLE = {
  version: 1,
  manifestText: JSON.stringify({
    id: 'imported-skill',
    name: 'Imported Skill',
    description: 'arrived as a bundle',
    author: 'someone',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: { tools: [], network: false, risk: 'low' },
    budget: { timeMs: 5000 },
  }),
  code: 'export function run(){ return { imported: true }; }',
};

describe('M26 draft run/bundle/import routes', () => {
  it('every new route is authed (401 without a token)', async () => {
    const h = demoHarness();
    try {
      const checks = [
        request(h.app).post('/v1/skills/drafts/x/run').send({}),
        request(h.app).post('/v1/skills/drafts/x/bundle'),
        request(h.app).post('/v1/skills/drafts/import').send(BUNDLE),
      ];
      for (const pending of checks) {
        const res = await pending.set('Host', ALLOWED_HOST);
        expect(res.status).toBe(401);
      }
    } finally {
      h.close();
    }
  });

  it('501s when the drafts manager is unwired', async () => {
    const h = demoHarness({ skills: false });
    try {
      const token = await pairToken(h);
      const run = await request(h.app).post('/v1/skills/drafts/x/run').set(authed(token)).send({});
      expect(run.status).toBe(501);
      expect(run.body.error).toBe('not_configured');
      const imported = await request(h.app)
        .post('/v1/skills/drafts/import')
        .set(authed(token))
        .send(BUNDLE);
      expect(imported.status).toBe(501);
    } finally {
      h.close();
    }
  });

  it('refuses a mobile-class session BY NAME on all three routes', async () => {
    const h = demoHarness();
    try {
      const headers = authed(await classToken(h, 'mobile'));
      for (const pending of [
        request(h.app).post('/v1/skills/drafts/x/run').set(headers).send({}),
        request(h.app).post('/v1/skills/drafts/x/bundle').set(headers),
        request(h.app).post('/v1/skills/drafts/import').set(headers).send(BUNDLE),
      ]) {
        const res = await pending;
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('capability_denied');
      }

      // The refusal created nothing on the way out.
      const desktop = await pairToken(h);
      const listed = await request(h.app).get('/v1/skills/drafts').set(authed(desktop));
      expect(listed.body.drafts).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('404s an unknown draft on run and on export', async () => {
    const h = demoHarness();
    try {
      const headers = authed(await pairToken(h));
      const run = await request(h.app).post('/v1/skills/drafts/nope/run').set(headers).send({});
      expect(run.status).toBe(404);
      expect(run.body.error).toBe('not_found');
      const bundle = await request(h.app).post('/v1/skills/drafts/nope/bundle').set(headers);
      expect(bundle.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('runs a draft in the sandbox and answers with the SkillDraftRun shape', async () => {
    const h = demoHarness();
    try {
      const headers = authed(await pairToken(h));
      const created = await request(h.app)
        .post('/v1/skills/drafts')
        .set(headers)
        .send({ mode: 'template', template: 'pure', name: 'Tidy Text', description: 'x' });
      const id = created.body.id as string;

      const run = await request(h.app)
        .post(`/v1/skills/drafts/${id}/run`)
        .set(headers)
        .send({ args: { text: 'hi', upper: true } });
      expect(run.status).toBe(200);
      expect(run.body).toEqual({
        ok: true,
        result: { text: 'HI', length: 2 },
        logs: [],
        ms: expect.any(Number) as unknown as number,
      });

      // A dry-run installs nothing, so the code is still the owner's to edit.
      const listed = await request(h.app).get('/v1/skills').set(headers);
      expect(listed.body.skills).toEqual([]);
      const draft = await request(h.app).get(`/v1/skills/drafts/${id}`).set(headers);
      expect(draft.body.status).toBe('draft');

      // The failure path keeps the 200 envelope and carries the reason.
      await request(h.app)
        .put(`/v1/skills/drafts/${id}`)
        .set(headers)
        .send({ code: "throw new Error('boom at import');\nexport function run(){ return 1; }" });
      const failed = await request(h.app).post(`/v1/skills/drafts/${id}/run`).set(headers).send({});
      expect(failed.status).toBe(200);
      expect(failed.body.ok).toBe(false);
      expect(failed.body.error).toBe('crashed');
      expect((failed.body.logs as string[]).join('\n')).toContain('boom at import');

      // The run is audited with counts only (never a log line).
      const rows = h.audit.list(200);
      const runRows = rows.filter((row) => row.action === 'skill.draft.run');
      expect(runRows).toHaveLength(2);
      const details = JSON.parse(runRows[0]?.details ?? '{}') as Record<string, unknown>;
      expect(Object.keys(details).sort()).toEqual(['error', 'ms', 'ok', 'toolCalls']);
      expect(JSON.stringify(rows.map((row) => row.details))).not.toContain('boom at import');
    } finally {
      h.close();
    }
  });

  it('exports a bundle and imports it as a new inert draft', async () => {
    const h = demoHarness();
    try {
      const headers = authed(await pairToken(h));
      const created = await request(h.app)
        .post('/v1/skills/drafts')
        .set(headers)
        .send({ mode: 'template', template: 'pure', name: 'Tidy Text', description: 'x' });
      const id = created.body.id as string;

      const exported = await request(h.app).post(`/v1/skills/drafts/${id}/bundle`).set(headers);
      expect(exported.status).toBe(200);
      expect(exported.body).toMatchObject({ version: 1 });
      expect(exported.body.code).toBe(created.body.code);
      expect(exported.body.manifestText).toBe(created.body.manifestText);

      const imported = await request(h.app)
        .post('/v1/skills/drafts/import')
        .set(headers)
        .send(exported.body);
      expect(imported.status).toBe(201);
      expect(imported.body).toMatchObject({
        id: 'tidy-text-2',
        origin: 'import',
        status: 'draft',
      });
      expect(imported.body.code).toBe(created.body.code);
      expect(imported.body.manifest.id).toBe('tidy-text-2');

      // Inert, still: two drafts and no installed skill.
      const listed = await request(h.app).get('/v1/skills/drafts').set(headers);
      expect((listed.body.drafts as Array<{ id: string }>).map((row) => row.id).sort()).toEqual([
        'tidy-text',
        'tidy-text-2',
      ]);
      const skills = await request(h.app).get('/v1/skills').set(headers);
      expect(skills.body.skills).toEqual([]);

      // A malformed body is a named 400, not a staged draft.
      const bad = await request(h.app)
        .post('/v1/skills/drafts/import')
        .set(headers)
        .send({ version: 3, code: 'export function run(){}' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('invalid_input');
    } finally {
      h.close();
    }
  });
});
