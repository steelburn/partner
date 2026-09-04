/**
 * M3 persona HTTP surface tests (PLAN-M3 wire spec): every route authed; GET
 * lists the eight seeded starters; POST/PUT CRUD with typed validation;
 * DELETE of the default persona is refused (409 conflict); pause/resume.
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

describe('auth gate on the persona surface', () => {
  it('returns 401 without a token on every persona route', async () => {
    const h = demoHarness();
    try {
      const cases: Array<[string, string]> = [
        ['get', '/v1/personas'],
        ['post', '/v1/personas'],
        ['put', '/v1/personas/x'],
        ['delete', '/v1/personas/x'],
        ['post', '/v1/personas/x/pause'],
        ['post', '/v1/personas/x/resume'],
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
});

describe('persona CRUD routes', () => {
  it('GET lists the eight seeded starters with exactly one default', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await request(h.app).get('/v1/personas').set(authed(token));
      expect(res.status).toBe(200);
      const personas = res.body.personas as Array<{ name: string; isDefault: boolean; paused: boolean }>;
      expect(personas).toHaveLength(8);
      expect(personas.map((p) => p.name)).toContain('Default partner');
      expect(personas.filter((p) => p.isDefault)).toHaveLength(1);
      expect(personas.every((p) => p.paused === false)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('POST create (partial body) -> 201 with defaults; invalid input -> 400', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/personas')
        .set(authed(token))
        .send({ name: 'Alma', independence: { level: 'auto' } });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        name: 'Alma',
        isDefault: false,
        paused: false,
        independence: { level: 'auto' },
      });
      expect(typeof created.body.id).toBe('string');

      const noName = await request(h.app).post('/v1/personas').set(authed(token)).send({ name: ' ' });
      expect(noName.status).toBe(400);
      expect(noName.body.error).toBe('invalid_input');

      const badLevel = await request(h.app)
        .post('/v1/personas')
        .set(authed(token))
        .send({ name: 'X', independence: { level: 'rogue' } });
      expect(badLevel.status).toBe(400);
      expect(h.personas.list()).toHaveLength(9);
    } finally {
      h.close();
    }
  });

  it('PUT updates; setting isDefault moves the flag; unknown id -> 404', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/personas')
        .set(authed(token))
        .send({ name: 'Editable' });
      const id = (created.body as { id: string }).id;

      const updated = await request(h.app)
        .put(`/v1/personas/${id}`)
        .set(authed(token))
        .send({ name: 'Edited', tagline: 'updated', isDefault: true });
      expect(updated.status).toBe(200);
      expect(updated.body.name).toBe('Edited');
      expect(updated.body.isDefault).toBe(true);
      // Single default: the seeded default partner lost the flag.
      const seeded = h.personas.get('p-default');
      expect(seeded?.isDefault).toBe(false);
      expect(h.personas.list().filter((p) => p.isDefault)).toHaveLength(1);

      const missing = await request(h.app).put('/v1/personas/nope').set(authed(token)).send({ name: 'X' });
      expect(missing.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('DELETE of the default persona -> 409 conflict; non-default delete -> 204', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const refuse = await request(h.app).delete('/v1/personas/p-default').set(authed(token));
      expect(refuse.status).toBe(409);
      expect(refuse.body.error).toBe('conflict');

      const created = await request(h.app)
        .post('/v1/personas')
        .set(authed(token))
        .send({ name: 'Disposable' });
      const id = (created.body as { id: string }).id;
      const del = await request(h.app).delete(`/v1/personas/${id}`).set(authed(token));
      expect(del.status).toBe(204);
      expect(h.personas.get(id)).toBeNull();

      const missing = await request(h.app).delete('/v1/personas/nope').set(authed(token));
      expect(missing.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('pause/resume flip the persona and 404 on unknown ids', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const paused = await request(h.app).post('/v1/personas/p-studio/pause').set(authed(token));
      expect(paused.status).toBe(200);
      expect(paused.body.paused).toBe(true);
      expect(h.personas.isPaused('p-studio')).toBe(true);

      const resumed = await request(h.app).post('/v1/personas/p-studio/resume').set(authed(token));
      expect(resumed.status).toBe(200);
      expect(resumed.body.paused).toBe(false);

      const missing = await request(h.app).post('/v1/personas/nope/pause').set(authed(token));
      expect(missing.status).toBe(404);
    } finally {
      h.close();
    }
  });
});
