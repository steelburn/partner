/**
 * M26 cut A — skill DRAFT HTTP surface (PLAN-M26.md).
 *
 * What these tests pin, beyond "the routes work":
 *   · authoring is a SEPARATE capability from installing (`skill.author` vs
 *     `skill.install`), and a mobile session is refused by name on both;
 *   · the surface is honest about a build with no generator (400, named);
 *   · the read surface returns the owner's own content, and NO audit row ever
 *     carries the code, the manifest text or the description;
 *   · the draft literal routes are registered before '/v1/skills/:id', so
 *     'drafts' and 'templates' can never be read as a skill id.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type {
  ChatEvent,
  ChatRequest,
  HealthReport,
  ProviderClient,
  ProviderSummary,
} from '@partner/shared';
import { ALLOWED_HOST, demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { createSkillGenerator } from '../../src/skills/generate.js';

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

const MANIFEST = (id: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    name: 'Tidy Text',
    description: 'uppercases text',
    author: 'me',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: { tools: [], network: false, risk: 'low' },
    budget: { timeMs: 5000 },
    ...over,
  });

describe('M26 draft routes', () => {
  it('every draft route is authed (401 without a token)', async () => {
    const h = demoHarness();
    try {
      const checks = [
        request(h.app).get('/v1/skills/drafts'),
        request(h.app).get('/v1/skills/templates'),
        request(h.app).get('/v1/skills/drafts/x'),
        request(h.app).post('/v1/skills/drafts').send({ mode: 'manual', name: 'X' }),
        request(h.app).put('/v1/skills/drafts/x').send({ code: '' }),
        request(h.app).post('/v1/skills/drafts/x/validate'),
        request(h.app).post('/v1/skills/drafts/x/install').send({}),
        request(h.app).delete('/v1/skills/drafts/x'),
        request(h.app).post('/v1/skills/hello-skill/fork'),
        request(h.app).post('/v1/skills/hello-skill/edit'),
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
      const res = await request(h.app).get('/v1/skills/drafts').set(authed(token));
      expect(res.status).toBe(501);
      expect(res.body.error).toBe('not_configured');
    } finally {
      h.close();
    }
  });

  it('reads the templates this build can actually honour', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await request(h.app).get('/v1/skills/templates').set(authed(token));
      expect(res.status).toBe(200);
      const ids = (res.body.templates as Array<{ id: string }>).map((t) => t.id);
      expect(ids).toEqual(['pure', 'reads-files']);
      // M27 has not wired notes/MCP, so no template may claim them.
      expect(ids).not.toContain('notes-checklist');
    } finally {
      h.close();
    }
  });

  it('runs the authored lifecycle without ever installing a skill', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);

      const created = await request(h.app)
        .post('/v1/skills/drafts')
        .set(headers)
        .send({ mode: 'template', template: 'pure', name: 'Tidy Text', description: 'x' });
      expect(created.status).toBe(201);
      const draftId = created.body.id as string;
      expect(created.body.validation.ok).toBe(true);

      // Authoring is inert: no installed skill appears.
      const installedDuringAuthoring = await request(h.app).get('/v1/skills').set(headers);
      expect(installedDuringAuthoring.body.skills).toEqual([]);

      const edited = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/validate`)
        .set(headers);
      expect(edited.status).toBe(200);
      // M27 S1: the app-scoped notes tools are now in the broker registry, so
      // a draft declaring one VALIDATES. Reach is bounded by the grant at run
      // time, not refused at author time.
      const notesDraft = await request(h.app)
        .put(`/v1/skills/drafts/${draftId}`)
        .set(headers)
        .send({ manifestText: MANIFEST(draftId, { permissions: { tools: ['notes.read'] } }) });
      expect(notesDraft.status).toBe(200);
      expect(notesDraft.body.validation.ok).toBe(true);

      // An id that is NOT in the registry still refuses, naming it.
      const unknown = await request(h.app)
        .put(`/v1/skills/drafts/${draftId}`)
        .set(headers)
        .send({ manifestText: MANIFEST(draftId, { permissions: { tools: ['files.write'] } }) });
      expect(unknown.status).toBe(200);
      expect(unknown.body.validation.ok).toBe(false);
      expect((unknown.body.validation.errors as string[]).join(' ')).toContain('files.write');

      const fixed = await request(h.app)
        .put(`/v1/skills/drafts/${draftId}`)
        .set(headers)
        .send({ manifestText: MANIFEST(draftId) });
      expect(fixed.body.validation.ok).toBe(true);

      const validated = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/validate`)
        .set(headers);
      expect(validated.status).toBe(200);
      expect(validated.body.validation.ok).toBe(true);

      const promoted = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/install`)
        .set(headers)
        .send({});
      expect(promoted.status).toBe(200);
      expect(promoted.body.mode).toBe('created');
      expect(promoted.body.skill).toMatchObject({ id: draftId, source: 'authored' });

      // Now, and only now, it is installed and invokable.
      const installed = await request(h.app).get('/v1/skills').set(headers);
      expect((installed.body.skills as Array<{ id: string }>).map((s) => s.id)).toEqual([draftId]);
      const invoked = await request(h.app)
        .post(`/v1/skills/${draftId}/invoke`)
        .set(headers)
        .send({ args: { text: 'hi', upper: true } });
      expect(invoked.status).toBe(200);
      expect(invoked.body.result).toMatchObject({ text: 'HI' });
    } finally {
      h.close();
    }
  });

  it('refuses an install that widens permissions until it is acknowledged', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);

      const created = await request(h.app)
        .post('/v1/skills/drafts')
        .set(headers)
        .send({ mode: 'template', template: 'pure', name: 'Grower', description: '' });
      const draftId = created.body.id as string;
      await request(h.app).post(`/v1/skills/drafts/${draftId}/install`).set(headers).send({});

      // Edit the installed skill and widen it.
      const editing = await request(h.app).post('/v1/skills/grower/edit').set(headers);
      expect(editing.status).toBe(201);
      const editId = editing.body.id as string;

      await request(h.app)
        .put(`/v1/skills/drafts/${editId}`)
        .set(headers)
        .send({
          manifestText: MANIFEST('grower', {
            version: '0.2.0',
            permissions: { tools: ['files.read'], network: false, risk: 'medium' },
          }),
        });

      const refused = await request(h.app)
        .post(`/v1/skills/drafts/${editId}/install`)
        .set(headers)
        .send({});
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('permission_change');

      const accepted = await request(h.app)
        .post(`/v1/skills/drafts/${editId}/install`)
        .set(headers)
        .send({ acknowledgePermissions: true });
      expect(accepted.status).toBe(200);
      expect(accepted.body.mode).toBe('updated');
      expect(
        (accepted.body.permissionDiff as Array<{ field: string }>).map((e) => e.field).sort(),
      ).toEqual(['risk', 'tools']);
    } finally {
      h.close();
    }
  });

  it('404s an unknown draft and keeps a write off an installed one', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      expect((await request(h.app).get('/v1/skills/drafts/nope').set(headers)).status).toBe(404);

      const created = await request(h.app)
        .post('/v1/skills/drafts')
        .set(headers)
        .send({ mode: 'template', template: 'pure', name: 'Locked', description: '' });
      const id = created.body.id as string;
      await request(h.app).post(`/v1/skills/drafts/${id}/install`).set(headers).send({});

      // The draft's source is frozen once it has shipped…
      for (const attempt of [
        request(h.app).put(`/v1/skills/drafts/${id}`).set(headers).send({ code: 'export function run(){}' }),
        request(h.app).post(`/v1/skills/drafts/${id}/validate`).set(headers),
        request(h.app).post(`/v1/skills/drafts/${id}/install`).set(headers).send({}),
      ]) {
        const res = await attempt;
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('conflict');
      }

      // …but DISCARDING the staging record is allowed, and it must never touch
      // the installed skill: the draft row is a note about what shipped, not
      // the skill itself.
      expect((await request(h.app).delete(`/v1/skills/drafts/${id}`).set(headers)).status).toBe(204);
      expect((await request(h.app).get(`/v1/skills/drafts/${id}`).set(headers)).status).toBe(404);
      const stillInstalled = await request(h.app).get('/v1/skills').set(headers);
      expect((stillInstalled.body.skills as Array<{ id: string }>).map((s) => s.id)).toEqual([id]);
    } finally {
      h.close();
    }
  });

  it('names the missing generator instead of pretending to author', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/skills/drafts')
        .set(authed(token))
        .send({ mode: 'generate', name: 'Invented', description: 'does something' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_input');
      expect(String(res.body.message)).toContain('template');
    } finally {
      h.close();
    }
  });

  it('renders a WIRED generator failure as 400 with its message', async () => {
    // A provider exists and answers, but with prose instead of a bundle - the
    // failure has to reach the caller as a readable 400, not a 500 or a
    // silently staged draft.
    const client: ProviderClient = {
      async *chatStream(_req: ChatRequest): AsyncGenerator<ChatEvent> {
        yield { type: 'delta', text: 'I would rather not draft that.' };
        yield { type: 'done', model: 'fake-model', latencyMs: 1 };
      },
      async health(): Promise<HealthReport> {
        return { ok: true, latencyMs: 0 };
      },
    };
    const provider: ProviderSummary = {
      id: 'p1',
      name: 'Fake provider',
      kind: 'openai-compatible',
      source: 'manual',
      purpose: 'general',
      endpoint: 'https://fake.example/v1',
      defaultModels: ['fake-model'],
      visionModels: [],
      enabled: true,
      budgetCents: null,
      createdAt: 1,
      updatedAt: 1,
      health: { ok: false, latencyMs: null, error: null, models: [], checkedAt: null },
    };
    const h = demoHarness({
      skillDraftGenerator: createSkillGenerator({
        providers: { list: () => [provider], clientFor: async () => client },
        demo: false,
      }),
    });
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/skills/drafts')
        .set(authed(token))
        .send({ mode: 'generate', name: 'Invented', description: 'does something' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_input');
      expect(String(res.body.message)).toContain('did not return a skill bundle');

      // A failed generation stages nothing.
      const listed = await request(h.app).get('/v1/skills/drafts').set(authed(token));
      expect(listed.body.drafts).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('refuses a mobile session BY NAME on authoring and on install', async () => {
    const h = demoHarness();
    try {
      const mobile = await classToken(h, 'mobile');
      const headers = authed(mobile);
      const authoring = await request(h.app)
        .post('/v1/skills/drafts')
        .set(headers)
        .send({ mode: 'manual', name: 'Phone Skill', description: '' });
      expect(authoring.status).toBe(403);
      expect(authoring.body).toMatchObject({ error: 'capability_denied' });

      const fork = await request(h.app).post('/v1/skills/hello-skill/fork').set(headers);
      expect(fork.status).toBe(403);

      const install = await request(h.app)
        .post('/v1/skills/drafts/whatever/install')
        .set(headers)
        .send({});
      expect(install.status).toBe(403);

      // Nothing was created on the way to that refusal.
      const desktop = await pairToken(h);
      const listed = await request(h.app).get('/v1/skills/drafts').set(authed(desktop));
      expect(listed.body.drafts).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('keeps draft source out of the audit log', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const created = await request(h.app)
        .post('/v1/skills/drafts')
        .set(headers)
        .send({
          mode: 'manual',
          name: 'Secret Keeper',
          description: 'a private description',
        });
      const id = created.body.id as string;
      const read = await request(h.app).get(`/v1/skills/drafts/${id}`).set(headers);
      // The owner's own UI DOES get the content back…
      expect(read.body.code).toContain('export async function run');
      expect(read.body.description).toBe('a private description');

      // …but the audit log must never carry it.
      const rows = h.audit.list(200);
      const serialized = JSON.stringify(rows.map((row) => ({ action: row.action, details: row.details })));
      expect(serialized).not.toContain('a private description');
      expect(serialized).not.toContain('export async function run');
      expect(rows.map((row) => row.action)).toContain('skill.draft.create');
    } finally {
      h.close();
    }
  });
});
