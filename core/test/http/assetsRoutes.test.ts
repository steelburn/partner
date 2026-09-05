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

describe('M11 F10 asset routes', () => {
  it('saves assets in bulk, lists them per conversation, deletes + promotes', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const conv = await request(h.app).post('/v1/conversations').set(authed(token)).send({});
      const conversationId = conv.body.id as string;

      const save = await request(h.app)
        .post(`/v1/conversations/${conversationId}/assets`)
        .set(authed(token))
        .send([
          { kind: 'table', title: 'Costs', body: '| a | b |\n|---|---|\n| 1 | 2 |' },
          { kind: 'code', title: 'snippet.ts', body: 'const x = 1;' },
        ]);
      expect(save.status).toBe(201);
      const saved = save.body.assets as Array<{ id: string; kind: string }>;
      expect(saved).toHaveLength(2);
      expect(saved.map((a) => a.kind)).toEqual(['table', 'code']);

      const list = await request(h.app)
        .get(`/v1/conversations/${conversationId}/assets`)
        .set(authed(token));
      expect(list.status).toBe(200);
      expect((list.body.assets as unknown[]).length).toBe(2);

      const other = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({});
      const denied = await request(h.app)
        .delete(`/v1/conversations/${other.body.id}/assets/${saved[0]?.id}`)
        .set(authed(token));
      expect(denied.status).toBe(404);

      const promote = await request(h.app)
        .post(`/v1/conversations/${conversationId}/assets/${saved[1]?.id}/promote`)
        .set(authed(token));
      expect(promote.status).toBe(200);
      expect(typeof promote.body.noteId).toBe('string');

      const del = await request(h.app)
        .delete(`/v1/conversations/${conversationId}/assets/${saved[0]?.id}`)
        .set(authed(token));
      expect(del.status).toBe(204);

      const audit = h.audit.query({ limit: 20, action: 'asset' });
      expect(audit.some((r) => r.action === 'asset.create')).toBe(true);
      expect(audit.some((r) => r.action === 'asset.promote')).toBe(true);
    } finally {
      h.close();
    }
  });
});
