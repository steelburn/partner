/**
 * M5 HTTP surface tests (PLAN-M5 wire spec): every /v1/notes, /v1/tags and
 * /v1/plans route is authed (401); 501 not_configured when the managers are
 * not wired (notesPlans: false); happy paths (CRUD, capture, daily,
 * summarize placeholder, search, backlinks, exports, task status) and typed
 * errors (404 not_found / 400 invalid_input). Note/plan content rides
 * responses to the OWNER by design — audit rows never carry it (manager
 * tests scan the audit store; here we only assert the wire).
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

describe('M5 routes — auth + wiring gates', () => {
  it('returns 401 without a token for every M5 route', async () => {
    const h = demoHarness();
    try {
      const cases: Array<[string, string]> = [
        ['get', '/v1/notes'],
        ['post', '/v1/notes'],
        ['get', '/v1/notes/n-1'],
        ['put', '/v1/notes/n-1'],
        ['delete', '/v1/notes/n-1'],
        ['post', '/v1/notes/capture'],
        ['get', '/v1/notes/daily'],
        ['post', '/v1/notes/daily/summarize'],
        ['get', '/v1/notes/search?q=hi'],
        ['get', '/v1/notes/n-1/backlinks'],
        ['get', '/v1/notes/export'],
        ['get', '/v1/tags'],
        ['get', '/v1/plans'],
        ['post', '/v1/plans'],
        ['get', '/v1/plans/p-1'],
        ['put', '/v1/plans/p-1'],
        ['delete', '/v1/plans/p-1'],
        ['post', '/v1/plans/p-1/tasks/t-1'],
        ['get', '/v1/plans/p-1/export'],
      ];
      for (const [method, path] of cases) {
        const res = await request(h.app)[method as 'get' | 'post' | 'put' | 'delete'](path)
          .set('Host', ALLOWED_HOST)
          .send({});
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    } finally {
      h.close();
    }
  });

  it('501s not_configured when notes/plans managers are not wired', async () => {
    const h = demoHarness({ notesPlans: false });
    try {
      const token = await pairToken(h);
      const cases: Array<[string, string]> = [
        ['get', '/v1/notes'],
        ['post', '/v1/notes'],
        ['post', '/v1/notes/capture'],
        ['get', '/v1/notes/daily'],
        ['post', '/v1/notes/daily/summarize'],
        ['get', '/v1/notes/search?q=x'],
        ['get', '/v1/notes/export'],
        ['get', '/v1/tags'],
        ['get', '/v1/plans'],
        ['post', '/v1/plans'],
        ['post', '/v1/plans/p-1/tasks/t-1'],
      ];
      for (const [method, path] of cases) {
        const res = await request(h.app)[method as 'get' | 'post'](path)
          .set(authed(token))
          .send({ title: 'x', text: 'x', status: 'done' });
        expect(res.status, `${method} ${path}`).toBe(501);
        expect(res.body.error).toBe('not_configured');
      }
    } finally {
      h.close();
    }
  });
});

describe('M5 notes routes', () => {
  it('CRUD + tags + export happy path with typed envelope shapes', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);

      // create
      const created = await request(h.app).post('/v1/notes').set(headers).send({
        title: 'Groceries',
        content: 'buy milk\nsee [[Plan]]',
        tags: ['home'],
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        title: 'Groceries',
        content: 'buy milk\nsee [[Plan]]',
        tags: ['home'],
        isDaily: false,
      });
      const noteId = created.body.id as string;
      expect(typeof noteId).toBe('string');

      // list (summary-only)
      const list = await request(h.app).get('/v1/notes').set(headers);
      expect(list.status).toBe(200);
      expect(list.body.notes.map((n: { id: string }) => n.id)).toEqual([noteId]);
      expect(list.body.notes[0]).not.toHaveProperty('content');

      // detail includes outgoing links (dangling [[Plan]])
      const detail = await request(h.app).get(`/v1/notes/${noteId}`).set(headers);
      expect(detail.status).toBe(200);
      expect(detail.body.note.content).toBe('buy milk\nsee [[Plan]]');
      expect(detail.body.links).toEqual([{ toNoteId: null, toTitle: 'Plan' }]);

      // update re-parses links; search finds the new content only
      const updated = await request(h.app)
        .put(`/v1/notes/${noteId}`)
        .set(headers)
        .send({ content: 'buy eggs and mangoes' });
      expect(updated.status).toBe(200);
      expect(updated.body.content).toBe('buy eggs and mangoes');
      const gone = await request(h.app).get('/v1/notes/search').query({ q: 'plan' }).set(headers);
      expect(gone.body.notes).toHaveLength(0);
      const found = await request(h.app).get('/v1/notes/search').query({ q: 'mangoes' }).set(headers);
      expect(found.status).toBe(200);
      expect(found.body.notes.map((n: { id: string }) => n.id)).toEqual([noteId]);

      // export bundle
      const exportRes = await request(h.app).get('/v1/notes/export').set(headers);
      expect(exportRes.status).toBe(200);
      expect(exportRes.body.schema).toBe('notes/v1');
      expect(exportRes.body.notes).toHaveLength(1);

      // tags
      const tags = await request(h.app).get('/v1/tags').set(headers);
      expect(tags.status).toBe(200);
      expect(tags.body.tags).toEqual([{ tag: 'home', count: 1 }]);

      // delete
      const del = await request(h.app).delete(`/v1/notes/${noteId}`).set(headers);
      expect(del.status).toBe(204);
      const after = await request(h.app).get('/v1/notes').set(headers);
      expect(after.body.notes).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('capture + daily + summarize placeholder over the wire', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);

      const captured = await request(h.app).post('/v1/notes/capture').set(headers).send({
        text: 'Quick win\n- fixed it',
      });
      expect(captured.status).toBe(201);
      expect(captured.body).toMatchObject({ title: 'Quick win', content: '- fixed it' });

      const daily = await request(h.app).get('/v1/notes/daily').set(headers);
      expect(daily.status).toBe(200);
      expect(daily.body.isDaily).toBe(true);

      // Same day -> same daily note (idempotent at the route too).
      const daily2 = await request(h.app).get('/v1/notes/daily').set(headers);
      expect(daily2.body.id).toBe(daily.body.id);

      const summarized = await request(h.app).post('/v1/notes/daily/summarize').set(headers).send({});
      expect(summarized.status).toBe(200);
      expect(summarized.body.id).toBe(daily.body.id);
      expect(summarized.body.content).toContain('## Daily summary');
      expect(summarized.body.content).toContain('Demo daily summary of 1 note...');
    } finally {
      h.close();
    }
  });

  it('backlinks resolve across notes (dangling then created)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const first = await request(h.app)
        .post('/v1/notes')
        .set(headers)
        .send({ title: 'Alpha', content: 'seed' });
      const alphaId = first.body.id as string;
      const linker = await request(h.app)
        .post('/v1/notes')
        .set(headers)
        .send({ title: 'Uses alpha', content: 'see [[alpha]]' });
      const back = await request(h.app).get(`/v1/notes/${alphaId}/backlinks`).set(headers);
      expect(back.status).toBe(200);
      expect(back.body.backlinks.map((n: { id: string }) => n.id)).toEqual([linker.body.id]);
    } finally {
      h.close();
    }
  });

  it('typed errors: 404s for missing notes, 400 invalid_input for bad bodies', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const notFound: Array<[string, string]> = [
        ['get', '/v1/notes/missing'],
        ['put', '/v1/notes/missing'],
        ['delete', '/v1/notes/missing'],
        ['get', '/v1/notes/missing/backlinks'],
      ];
      for (const [method, path] of notFound) {
        const res = await request(h.app)[method as 'get' | 'put' | 'delete'](path)
          .set(headers)
          .send({ title: 'x' });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.body.error).toBe('not_found');
      }
      const invalid: Array<[string, string, unknown]> = [
        ['post', '/v1/notes', { content: 'no title' }],
        ['post', '/v1/notes/capture', { text: '   ' }],
        ['get', '/v1/notes/search?q=', {}],
      ];
      for (const [method, path, body] of invalid) {
        const res = await request(h.app)[method as 'get' | 'post'](path)
          .set(headers)
          .send(body as object);
        expect(res.status, `${method} ${path}`).toBe(400);
        expect(res.body.error).toBe('invalid_input');
      }
      // An invalid patch on an EXISTING note is 400 (unknown id is 404).
      const seeded = await request(h.app)
        .post('/v1/notes')
        .set(headers)
        .send({ title: 'seed' });
      const badPatch = await request(h.app)
        .put(`/v1/notes/${seeded.body.id}`)
        .set(headers)
        .send({ tags: 'nope' });
      expect(badPatch.status).toBe(400);
      expect(badPatch.body.error).toBe('invalid_input');
    } finally {
      h.close();
    }
  });
});

describe('M5 plans routes', () => {
  it('CRUD + task status + export happy path', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);

      const created = await request(h.app).post('/v1/plans').set(headers).send({
        title: 'Plan',
        description: 'goals',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        title: 'Plan',
        description: 'goals',
        document: { milestones: [] },
        taskCount: 0,
        doneCount: 0,
      });
      const planId = created.body.id as string;

      const doc = {
        milestones: [
          {
            id: 'm1',
            title: 'Milestone',
            tasks: [
              { id: 't1', title: 'Write store', status: 'open' },
              { id: 't2', title: 'Write manager', status: 'open' },
            ],
          },
        ],
      };
      const updated = await request(h.app).put(`/v1/plans/${planId}`).set(headers).send({ document: doc });
      expect(updated.status).toBe(200);
      expect(updated.body.taskCount).toBe(2);

      // list shows progress summary
      const list = await request(h.app).get('/v1/plans').set(headers);
      expect(list.status).toBe(200);
      expect(list.body.plans).toEqual([
        expect.objectContaining({ id: planId, taskCount: 2, doneCount: 0 }),
      ]);
      expect(list.body.plans[0]).not.toHaveProperty('document');

      // toggle one task done (with a note), progress updates
      const toggled = await request(h.app)
        .post(`/v1/plans/${planId}/tasks/t1`)
        .set(headers)
        .send({ status: 'done', note: 'done!' });
      expect(toggled.status).toBe(200);
      expect(toggled.body.doneCount).toBe(1);
      expect(toggled.body.document.milestones[0].tasks[0]).toMatchObject({
        id: 't1',
        status: 'done',
        note: 'done!',
      });

      // get + export
      const got = await request(h.app).get(`/v1/plans/${planId}`).set(headers);
      expect(got.status).toBe(200);
      expect(got.body.document.milestones).toHaveLength(1);
      const exportRes = await request(h.app).get(`/v1/plans/${planId}/export`).set(headers);
      expect(exportRes.status).toBe(200);
      expect(exportRes.body).toMatchObject({ schema: 'plan/v1' });
      expect(typeof exportRes.body.exportedAt).toBe('number');
      expect(exportRes.body.plan.id).toBe(planId);
      // PLAN-M5.md's POST form is also wired (read-only export under both verbs).
      const exportPost = await request(h.app).post(`/v1/plans/${planId}/export`).set(headers);
      expect(exportPost.status).toBe(200);
      expect(exportPost.body.plan.id).toBe(planId);

      const del = await request(h.app).delete(`/v1/plans/${planId}`).set(headers);
      expect(del.status).toBe(204);
      const empty = await request(h.app).get('/v1/plans').set(headers);
      expect(empty.body.plans).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('typed errors: 404 missing plan/task, 400 bad document/status', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const created = await request(h.app).post('/v1/plans').set(headers).send({ title: 'P' });
      const planId = created.body.id as string;

      const notFound: Array<[string, string]> = [
        ['get', '/v1/plans/missing'],
        ['put', '/v1/plans/missing'],
        ['delete', '/v1/plans/missing'],
        ['get', '/v1/plans/missing/export'],
        ['post', `/v1/plans/${planId}/tasks/no-such-task`],
        ['post', '/v1/plans/missing/tasks/t1'],
      ];
      for (const [method, path] of notFound) {
        const res = await request(h.app)[method as 'get' | 'post' | 'put' | 'delete'](path)
          .set(headers)
          .send({ status: 'done', title: 'x' });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.body.error).toBe('not_found');
      }

      const invalid: Array<[string, string, unknown]> = [
        ['post', '/v1/plans', { description: 'no title' }],
        ['put', `/v1/plans/${planId}`, { document: { milestones: 'x' } }],
        ['put', `/v1/plans/${planId}`, { document: { milestones: [{ id: 'm1', title: 'M', tasks: [{ id: 't1', title: 'T', status: 'maybe' }] }] } }],
        ['post', `/v1/plans/${planId}/tasks/t1`, { status: 'maybe' }],
      ];
      for (const [method, path, body] of invalid) {
        const res = await request(h.app)[method as 'post' | 'put'](path)
          .set(headers)
          .send(body as object);
        expect(res.status, `${method} ${path}`).toBe(400);
        expect(res.body.error).toBe('invalid_input');
      }
    } finally {
      h.close();
    }
  });
});
