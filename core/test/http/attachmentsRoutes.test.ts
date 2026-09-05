/**
 * M11 F1 attachment HTTP surface tests (PLAN-M11.md).
 *
 * Uploads stage per conversation; /v1/chat binds staged ids to the persisted
 * user turn; content is served conversation-scoped; unsupported types and
 * unknown staged ids are refused with typed errors.
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

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('M11 F1 attachment routes', () => {
  it('401 without a token on the surface', async () => {
    const h = demoHarness();
    try {
      const res = await request(h.app)
        .post('/v1/conversations/x/attachments')
        .set('Host', ALLOWED_HOST)
        .send({ name: 'a.txt', mime: 'text/plain', dataBase64: b64('x') });
      expect(res.status).toBe(401);
    } finally {
      h.close();
    }
  });

  it('uploads stage, bind on the next chat turn, and the detail shows them bound', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const conv = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ title: 'files' });
      const conversationId = conv.body.id as string;

      const upload = await request(h.app)
        .post(`/v1/conversations/${conversationId}/attachments`)
        .set(authed(token))
        .send({ name: 'draft.md', mime: 'text/markdown', dataBase64: b64('# Draft\nbody text here') });
      expect(upload.status).toBe(201);
      expect(upload.body.messageId).toBeNull();

      const bad = await request(h.app)
        .post(`/v1/conversations/${conversationId}/attachments`)
        .set(authed(token))
        .send({ name: 'evil.exe', mime: 'application/octet-stream', dataBase64: b64('x') });
      expect(bad.status).toBe(415);

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          conversationId,
          attachmentIds: [upload.body.id],
          messages: [{ role: 'user', content: 'read the draft' }],
        });
      expect(chat.status).toBe(200);
      expect(chat.text).toContain('done_meta');

      // The staged row is now bound to the persisted user turn.
      const detail = await request(h.app)
        .get(`/v1/conversations/${conversationId}`)
        .set(authed(token));
      expect(detail.status).toBe(200);
      const byMessage = detail.body.attachmentsByMessage as Record<string, Array<{ name: string }>>;
      const values = Object.values(byMessage).flat();
      expect(values.some((a) => a.name === 'draft.md')).toBe(true);
      expect((detail.body.stagedAttachments as unknown[]).length).toBe(0);
    } finally {
      h.close();
    }
  });

  it('serves content conversation-scoped and deletes staged uploads', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const conv = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ title: 'media' });
      const conversationId = conv.body.id as string;
      const other = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ title: 'other' });
      const otherId = other.body.id as string;

      const upload = await request(h.app)
        .post(`/v1/conversations/${conversationId}/attachments`)
        .set(authed(token))
        .send({ name: 'x.txt', mime: 'text/plain', dataBase64: b64('content bytes') });
      const attId = upload.body.id as string;

      const content = await request(h.app)
        .get(`/v1/conversations/${conversationId}/attachments/${attId}/content`)
        .set(authed(token));
      expect(content.status).toBe(200);
      expect(content.headers['content-type']).toContain('text/plain');
      expect(content.text).toContain('content bytes');

      const denied = await request(h.app)
        .get(`/v1/conversations/${otherId}/attachments/${attId}/content`)
        .set(authed(token));
      expect(denied.status).toBe(404);

      const del = await request(h.app)
        .delete(`/v1/conversations/${conversationId}/attachments/${attId}`)
        .set(authed(token));
      expect(del.status).toBe(204);
      const gone = await request(h.app)
        .get(`/v1/conversations/${conversationId}/attachments/${attId}/content`)
        .set(authed(token));
      expect(gone.status).toBe(404);
    } finally {
      h.close();
    }
  });
});
