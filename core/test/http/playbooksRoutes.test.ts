/**
 * M9 playbook + deploy HTTP surface tests (PLAN-M9 wire spec).
 *
 * Every route authed (401 without a token); GET /v1/playbooks returns the
 * registry metadata; POST /:id/run streams SSE (run_start / loop_step /
 * persona_tool / delta / done / run_end) for a demo text playbook against
 * the demo provider and persists a playbook_runs row (+ transcript when a
 * conversationId is given); a paused persona is 423; a non-demo harness with
 * nothing configured is no_provider 501; resume is 404 for an unknown run.
 * Deploy profiles: create/list/remove + validation errors + the package step
 * into a temp outDir.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatEvent } from '@partner/shared';
import { demoHarness, ALLOWED_HOST, makeTempRoot, removeTempRoot } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { PLAYBOOKS } from '../../src/playbooks/registry.js';

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

function parseSse(text: string): unknown[] {
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as unknown);
}

describe('auth gate on the M9 playbook + deploy surface', () => {
  it('returns 401 without a token on every route', async () => {
    const h = demoHarness();
    try {
      const cases: Array<[string, string]> = [
        ['get', '/v1/playbooks'],
        ['post', '/v1/playbooks/research/run'],
        ['post', '/v1/playbooks/runs/x/resume'],
        ['get', '/v1/deploy-profiles'],
        ['post', '/v1/deploy-profiles'],
        ['delete', '/v1/deploy-profiles/x'],
        ['post', '/v1/deploy-profiles/x/package'],
      ];
      for (const [method, path] of cases) {
        const res = await request(h.app)[method as 'get' | 'post' | 'delete'](path)
          .set('Host', ALLOWED_HOST)
          .send({});
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    } finally {
      h.close();
    }
  });
});

describe('playbook routes', () => {
  it('GET /v1/playbooks lists the registry metadata', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await request(h.app).get('/v1/playbooks').set(authed(token));
      expect(res.status).toBe(200);
      expect(res.body.playbooks).toHaveLength(PLAYBOOKS.length);
      const docgen = res.body.playbooks.find((p: { id: string }) => p.id === 'docgen');
      expect(docgen).toMatchObject({
        id: 'docgen',
        area: 'docgen',
        defaultIndependence: 'assist',
      });
      expect(docgen.allowedTools).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('POST /v1/playbooks/:id/run streams SSE loop events for a demo text playbook', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/playbooks/docgen/run')
        .set(authed(token))
        .send({ personaId: 'p-scribe', inputs: { prompt: 'Release notes for v0.2' } });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      const events = parseSse(res.text);
      expect(events[0]).toMatchObject({ type: 'run_start', playbookId: 'docgen' });
      const types = events.map((e) => (e as { type: string }).type);
      expect(types).toContain('loop_step');
      expect(types).toContain('delta');
      expect(types).toContain('done');
      expect(types[types.length - 1]).toBe('run_end');
      const runEnd = events[events.length - 1] as {
        type: string;
        status: string;
        text: string;
        runId: string;
      };
      expect(runEnd.status).toBe('done');
      expect(runEnd.text).toMatch(/^demo: received \d+ characters$/);
      // Persisted run row + playbook.run audit (ids/counts only).
      const row = h.playbookRunStore.findById(runEnd.runId);
      expect(row?.status).toBe('done');
      expect(row?.personaId).toBe('p-scribe');
      const audit = h.audit.list(50).find((a) => a.action === 'playbook.run');
      expect(audit?.details).toContain('"status":"done"');
    } finally {
      h.close();
    }
  });

  it('persists the transcript when a conversationId is given', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const convo = h.conversations.create({ personaId: 'p-scribe' });
      const res = await request(h.app)
        .post('/v1/playbooks/research/run')
        .set(authed(token))
        .send({ conversationId: convo.id, inputs: { topic: 'x' } });
      expect(res.status).toBe(200);
      const events = parseSse(res.text);
      const runEnd = events[events.length - 1] as { status: string };
      expect(runEnd.status).toBe('done');
      expect(h.messageStore.listByConversation(convo.id)).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it('unknown playbook 404; paused persona 423; garbage inputs 400', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const unknown = await request(h.app)
        .post('/v1/playbooks/nope/run')
        .set(authed(token))
        .send({ personaId: 'p-scribe', inputs: {} });
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toBe('not_found');

      h.personas.pause('p-scribe');
      const paused = await request(h.app)
        .post('/v1/playbooks/docgen/run')
        .set(authed(token))
        .send({ personaId: 'p-scribe', inputs: {} });
      expect(paused.status).toBe(423);
      expect(paused.body.error).toBe('persona_paused');

      const badInputs = await request(h.app)
        .post('/v1/playbooks/docgen/run')
        .set(authed(token))
        .send({ personaId: 'p-scribe', inputs: 'nope' });
      expect(badInputs.status).toBe(400);
      expect(badInputs.body.error).toBe('invalid_input');
    } finally {
      h.close();
    }
  });

  it('no_provider 501 when nothing usable is configured (non-demo)', async () => {
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/playbooks/docgen/run')
        .set(authed(token))
        .send({ personaId: 'p-scribe', inputs: {} });
      expect(res.status).toBe(501);
      expect(res.body.error).toBe('no_provider');
    } finally {
      h.close();
    }
  });

  it('resume is 404 for an unknown run; a queued run resumes after approve', async () => {
    const dir = makeTempRoot();
    try {
      // A scripted provider emits one files.edit directive then a final
      // answer — drives a REAL queue -> decide -> resume over HTTP.
      const editDirective = (projectId: string): string =>
        `[[partner:tool files.edit ${JSON.stringify({
          projectId,
          path: 'notes.md',
          proposedContent: 'rewritten by persona',
        })}]]`;
      let rootId = '';
      let calls = 0;
      const h = demoHarness({
        playbookProvider: () => ({
          client: {
            async *chatStream(): AsyncGenerator<ChatEvent> {
              calls += 1;
              const text =
                calls === 1 ? `propose\n${editDirective(rootId)}` : 'route-final answer';
              yield { type: 'delta', text };
              yield { type: 'done', model: 'fake', latencyMs: 1 };
            },
            async health() {
              return { ok: true, latencyMs: 0 };
            },
          },
          model: 'fake',
        }),
      });
      try {
        const token = await pairToken(h);
        const missing = await request(h.app)
          .post('/v1/playbooks/runs/not-a-run/resume')
          .set(authed(token))
          .send({ pendingId: 'nope' });
        expect(missing.status).toBe(404);

        const root = (h.broker as NonNullable<Harness['broker']>).roots.add({
          label: 'r',
          path: dir,
          readOnly: false,
        });
        rootId = root.id;
        writeFileSync(join(dir, 'notes.md'), 'original body', 'utf8');

        const run = await request(h.app)
          .post('/v1/playbooks/vibe-code/run')
          .set(authed(token))
          .send({ personaId: 'p-builder', inputs: { projectId: root.id, task: 'x' } });
        expect(run.status).toBe(200);
        const events = parseSse(run.text);
        const queued = events.find(
          (e) =>
            (e as { type?: string }).type === 'persona_tool' &&
            (e as { decision?: string }).decision === 'queued',
        ) as { pendingId: string } | undefined;
        expect(queued).toBeDefined();
        const runEnd = events[events.length - 1] as { runId: string; status: string };
        expect(runEnd.status).toBe('queued');
        // The run row is still 'running' while waiting on the approval.
        expect(h.playbookRunStore.findById(runEnd.runId)?.status).toBe('running');

        // Resume before the decision -> conflict.
        const open = await request(h.app)
          .post(`/v1/playbooks/runs/${runEnd.runId}/resume`)
          .set(authed(token))
          .send({ pendingId: queued?.pendingId ?? '' });
        expect(open.status).toBe(409);
        expect(open.body.error).toBe('conflict');

        // M2 approve executes the queued tool once.
        const decide = await request(h.app)
          .post(`/v1/tools/pending/${queued?.pendingId ?? ''}`)
          .set(authed(token))
          .send({ decision: 'approve' });
        expect(decide.status).toBe(200);
        expect(decide.body.executed).toBe(true);

        // Resume now streams the final answer.
        const resumed = await request(h.app)
          .post(`/v1/playbooks/runs/${runEnd.runId}/resume`)
          .set(authed(token))
          .send({ pendingId: queued?.pendingId ?? '' });
        expect(resumed.status).toBe(200);
        const resumedEvents = parseSse(resumed.text);
        const finalEnd = resumedEvents[resumedEvents.length - 1] as {
          type: string;
          status: string;
          text: string;
        };
        expect(finalEnd.type).toBe('run_end');
        expect(finalEnd.status).toBe('done');
        expect(finalEnd.text).toBe('route-final answer');
        expect(h.playbookRunStore.findById(runEnd.runId)?.status).toBe('done');
      } finally {
        h.close();
      }
    } finally {
      removeTempRoot(dir);
    }
  });
});

describe('deploy-profile routes', () => {
  it('create/list/remove round-trip with validation', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/deploy-profiles')
        .set(authed(token))
        .send({ name: 'edge', host: 'edge.example.org', username: 'ops' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ kind: 'docker-ssh', port: 22, host: 'edge.example.org' });

      const dup = await request(h.app)
        .post('/v1/deploy-profiles')
        .set(authed(token))
        .send({ name: 'edge', host: 'other.example.org' });
      expect(dup.status).toBe(409);
      expect(dup.body.error).toBe('conflict');

      const badPort = await request(h.app)
        .post('/v1/deploy-profiles')
        .set(authed(token))
        .send({ name: 'x', host: 'h.example.org', port: 70000 });
      expect(badPort.status).toBe(400);
      expect(badPort.body.error).toBe('invalid_input');

      const list = await request(h.app).get('/v1/deploy-profiles').set(authed(token));
      expect(list.status).toBe(200);
      expect(list.body.profiles).toHaveLength(1);

      const removed = await request(h.app)
        .delete(`/v1/deploy-profiles/${created.body.id as string}`)
        .set(authed(token));
      expect(removed.status).toBe(204);
      const gone = await request(h.app)
        .delete('/v1/deploy-profiles/not-there')
        .set(authed(token));
      expect(gone.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('package writes the bundle under outDir and returns files + dockerfile', async () => {
    const h = demoHarness();
    const dir = makeTempRoot();
    try {
      const token = await pairToken(h);
      const profile = await request(h.app)
        .post('/v1/deploy-profiles')
        .set(authed(token))
        .send({ name: 'ship', host: 'app.example.org' });
      const pkg = await request(h.app)
        .post(`/v1/deploy-profiles/${profile.body.id as string}/package`)
        .set(authed(token))
        .send({ projectDir: dir, outDir: join(dir, 'out') });
      expect(pkg.status).toBe(200);
      expect(pkg.body.dockerfile).toContain('node:20-alpine');
      expect(pkg.body.files).toHaveLength(4);
      expect(pkg.body.outDir).toBe(join(dir, 'out'));

      const pkgBad = await request(h.app)
        .post('/v1/deploy-profiles/not-there/package')
        .set(authed(token))
        .send({ projectDir: dir, outDir: join(dir, 'x') });
      expect(pkgBad.status).toBe(404);
    } finally {
      removeTempRoot(dir);
      h.close();
    }
  });

  it('playbook + deploy surfaces 501 when not wired', async () => {
    const h = demoHarness({ playbooks: false, deployProfiles: false });
    try {
      const token = await pairToken(h);
      const list = await request(h.app).get('/v1/playbooks').set(authed(token));
      expect(list.status).toBe(501);
      const profiles = await request(h.app).get('/v1/deploy-profiles').set(authed(token));
      expect(profiles.status).toBe(501);
    } finally {
      h.close();
    }
  });
});
