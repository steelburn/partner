/**
 * M14 schedule HTTP surface (PLAN-M14.md S5) — auth gate, run-now (headless
 * fire → poll to done), run history + detail, guards (paused 423, level 400,
 * unknown 404), and the 501 not_configured surface.
 *
 * Schedule definitions ride the persona surface (independence.schedules via
 * POST/PATCH /v1/personas) — no duplicate CRUD is tested here.
 */
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

const brief = (): Record<string, unknown> => ({
  id: 's-morning',
  label: 'Morning brief',
  when: { kind: 'interval', everyMinutes: 5 },
  prompt: 'Give a one-line status summary.',
  enabled: true,
});

async function createScheduledPersona(
  h: Harness,
  token: string,
  level = 'autonomous',
): Promise<string> {
  const res = await request(h.app)
    .post('/v1/personas')
    .set(authed(token))
    .send({
      name: 'Scheduled partner',
      independence: { level, schedules: [brief()] },
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Poll a run row over HTTP until terminal or timeout. */
async function waitRun(
  h: Harness,
  token: string,
  runId: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(h.app)
      .get(`/v1/schedules/runs/${runId}`)
      .set(authed(token));
    expect(res.status).toBe(200);
    const run = res.body as { status: string };
    if (run.status !== 'running') return res.body as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error(`run ${runId} never finished: ${JSON.stringify(run)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('M14 schedules — auth gate', () => {
  it('returns 401 without a token on every route', async () => {
    const h = demoHarness();
    try {
      const cases: Array<[string, string]> = [
        ['post', '/v1/personas/p-x/schedules/s-1/run-now'],
        ['get', '/v1/schedules/runs'],
        ['get', '/v1/schedules/runs/x'],
      ];
      for (const [method, path] of cases) {
        const res = await request(h.app)[method as 'get'](path).set('Host', ALLOWED_HOST);
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    } finally {
      h.close();
    }
  });

  it('501 not_configured when the schedule manager is not wired', async () => {
    const h = demoHarness({ schedules: false });
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .get('/v1/schedules/runs')
        .set(authed(token));
      expect(res.status).toBe(501);
      expect(res.body.error).toBe('not_configured');
    } finally {
      h.close();
    }
  });
});

describe('M14 run-now', () => {
  it('fires a headless run against the demo provider, completes and lands in a conversation', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const personaId = await createScheduledPersona(h, token);

      const fired = await request(h.app)
        .post(`/v1/personas/${personaId}/schedules/s-morning/run-now`)
        .set(authed(token));
      expect(fired.status).toBe(200);
      const { runId, conversationId } = fired.body as { runId: string; conversationId: string };
      expect(runId).toBeTruthy();
      expect(conversationId).toBeTruthy();

      const run = await waitRun(h, token, runId);
      expect(run.status).toBe('done');
      expect(run.personaId).toBe(personaId);
      expect(run.scheduleId).toBe('s-morning');
      expect(run.conversationId).toBe(conversationId);
      expect(run.rounds).toBeGreaterThanOrEqual(1);
      expect(run.finishedAt).not.toBeNull();

      // The transcript has the brief (user) and the persona's answer.
      const detail = h.conversations.get(conversationId);
      const messages = (detail as { messages: Array<{ role: string; content: string }> }).messages;
      expect(messages.length).toBe(2);
      expect(messages[0]?.role).toBe('user');
      expect(messages[0]?.content).toContain('[Scheduled: Morning brief]');
      expect(messages[1]?.role).toBe('assistant');
      expect(messages[1]?.content.length).toBeGreaterThan(0);

      // Audit: run row ids/status only, never the brief text.
      const serialized = JSON.stringify(h.audit.list(50));
      expect(serialized).toContain('schedule.run');
      expect(serialized).not.toContain('one-line status summary');
    } finally {
      h.close();
    }
  });

  it('guards: paused 423, assist-level 400, unknown ids 404', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const personaId = await createScheduledPersona(h, token, 'assist');
      const paused = await request(h.app)
        .post(`/v1/personas/${personaId}/pause`)
        .set(authed(token));
      expect(paused.status).toBe(200);
      const pausedRes = await request(h.app)
        .post(`/v1/personas/${personaId}/schedules/s-morning/run-now`)
        .set(authed(token));
      expect(pausedRes.status).toBe(423);

      // resume + level still below auto -> 400 level_refused
      await request(h.app).post(`/v1/personas/${personaId}/resume`).set(authed(token));
      const levelRes = await request(h.app)
        .post(`/v1/personas/${personaId}/schedules/s-morning/run-now`)
        .set(authed(token));
      expect(levelRes.status).toBe(400);
      expect(levelRes.body.error).toBe('level_refused');

      const missingPersona = await request(h.app)
        .post('/v1/personas/nope/schedules/s-morning/run-now')
        .set(authed(token));
      expect(missingPersona.status).toBe(404);

      const autonomousId = await createScheduledPersona(h, token, 'autonomous');
      const missingSchedule = await request(h.app)
        .post(`/v1/personas/${autonomousId}/schedules/nope/run-now`)
        .set(authed(token));
      expect(missingSchedule.status).toBe(404);
    } finally {
      h.close();
    }
  });
});

describe('M14 run history', () => {
  it('lists runs newest-first with persona/status filters and serves detail', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const personaId = await createScheduledPersona(h, token);
      const fired = await request(h.app)
        .post(`/v1/personas/${personaId}/schedules/s-morning/run-now`)
        .set(authed(token));
      const { runId } = fired.body as { runId: string };
      await waitRun(h, token, runId);

      const all = await request(h.app)
        .get('/v1/schedules/runs')
        .set(authed(token));
      expect(all.status).toBe(200);
      const runs = (all.body as { runs: Array<{ id: string; personaId: string; status: string }> }).runs;
      const mine = runs.find((r) => r.id === runId);
      expect(mine).toBeDefined();
      expect(mine?.personaId).toBe(personaId);

      const byPersona = await request(h.app)
        .get(`/v1/schedules/runs?personaId=${personaId}`)
        .set(authed(token));
      expect((byPersona.body as { runs: unknown[] }).runs.length).toBeGreaterThanOrEqual(1);

      const byStatus = await request(h.app)
        .get('/v1/schedules/runs?status=done')
        .set(authed(token));
      const statuses = (byStatus.body as { runs: Array<{ status: string }> }).runs;
      expect(statuses.every((r) => r.status === 'done')).toBe(true);

      const missing = await request(h.app).get('/v1/schedules/runs/nope').set(authed(token));
      expect(missing.status).toBe(404);
    } finally {
      h.close();
    }
  });
});
