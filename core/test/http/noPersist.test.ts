/**
 * M11 A/B studio: {noPersist:true} streams a persona turn WITHOUT persisting
 * a conversation — comparisons never clutter the rail.
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

describe('M11 noPersist chat (A/B compare)', () => {
  it('streams a persona turn and persists nothing', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const before = h.conversations.list().length;
      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          personaId: 'p-analyst',
          noPersist: true,
          messages: [{ role: 'user', content: 'compare this' }],
        });
      expect(chat.status).toBe(200);
      expect(chat.text).toContain('usage');
      expect(chat.text).not.toContain('done_meta');
      expect(h.conversations.list().length).toBe(before);

      // noPersist is scoped to the turn: without it the same call persists.
      const persisted = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          personaId: 'p-analyst',
          messages: [{ role: 'user', content: 'keep this' }],
        });
      expect(persisted.status).toBe(200);
      expect(persisted.text).toContain('done_meta');
      expect(h.conversations.list().length).toBe(before + 1);
    } finally {
      h.close();
    }
  });
});
