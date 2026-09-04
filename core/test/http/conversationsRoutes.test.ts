/**
 * M3 conversation HTTP surface tests (PLAN-M3 wire spec): every route
 * authed; POST create validates a bound persona; GET list shows titles +
 * messageCount; GET transcript + DELETE cascade round-trip through the
 * managers on the harness db.
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

describe('auth gate on the conversation surface', () => {
  it('returns 401 without a token on every conversation route', async () => {
    const h = demoHarness();
    try {
      const cases: Array<[string, string]> = [
        ['get', '/v1/conversations'],
        ['post', '/v1/conversations'],
        ['get', '/v1/conversations/x'],
        ['delete', '/v1/conversations/x'],
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

describe('conversation routes', () => {
  it('POST create -> 201 summary; bound persona validated (404 when unknown)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ personaId: 'p-researcher', title: 'Deep dive' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        personaId: 'p-researcher',
        title: 'Deep dive',
        messageCount: 0,
      });
      expect(typeof created.body.id).toBe('string');

      const unbound = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ title: 'General' });
      expect(unbound.status).toBe(201);
      expect(unbound.body.personaId).toBeNull();

      const unknownPersona = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ personaId: 'p-nope' });
      expect(unknownPersona.status).toBe(404);
      expect(unknownPersona.body.error).toBe('not_found');
    } finally {
      h.close();
    }
  });

  it('GET list + GET detail + DELETE cascade', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const empty = await request(h.app).get('/v1/conversations').set(authed(token));
      expect(empty.status).toBe(200);
      expect(empty.body.conversations).toEqual([]);

      const created = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ title: 'Q&A' });
      const id = (created.body as { id: string }).id;

      // Simulate a persisted turn through the manager (chat appends live in
      // the /v1/chat tests; managers share this db).
      h.conversations.append(id, 'user', { content: 'hello', personaId: 'p-researcher' });
      h.conversations.append(id, 'assistant', { content: 'hi back', model: 'demo', latencyMs: 4 });

      const list = await request(h.app).get('/v1/conversations').set(authed(token));
      expect(list.status).toBe(200);
      expect(list.body.conversations).toHaveLength(1);
      expect(list.body.conversations[0]).toMatchObject({ id, title: 'Q&A', messageCount: 2 });

      const detail = await request(h.app).get(`/v1/conversations/${id}`).set(authed(token));
      expect(detail.status).toBe(200);
      expect(detail.body.conversation.id).toBe(id);
      expect(detail.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
      expect(detail.body.messages[1].content).toBe('hi back');

      const missing = await request(h.app).get('/v1/conversations/nope').set(authed(token));
      expect(missing.status).toBe(404);

      const del = await request(h.app).delete(`/v1/conversations/${id}`).set(authed(token));
      expect(del.status).toBe(204);
      // Cascade removed the messages too.
      expect(() => h.conversations.get(id)).toThrowError(/conversation not found/);

      const delMissing = await request(h.app).delete('/v1/conversations/nope').set(authed(token));
      expect(delMissing.status).toBe(404);
    } finally {
      h.close();
    }
  });
});
