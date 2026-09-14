/**
 * M11 F1 attachment HTTP surface tests (PLAN-M11.md).
 *
 * Uploads stage per conversation; /v1/chat binds staged ids to the persisted
 * user turn; content is served conversation-scoped; unsupported types and
 * unknown staged ids are refused with typed errors.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { demoHarness, ALLOWED_HOST, attachmentUploadHeaders } from '../helpers.js';
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

/** M22/R7: the file bytes are the body; name/mime ride headers. */
function upload(
  h: Harness,
  token: string,
  conversationId: string,
  file: { name: string; mime: string; body: string },
): request.Test {
  return request(h.app)
    .post(`/v1/conversations/${conversationId}/attachments`)
    .set(attachmentUploadHeaders(token, file.name, file.mime))
    .send(Buffer.from(file.body, 'utf8'));
}

describe('M11 F1 attachment routes', () => {
  it('401 without a token on the surface', async () => {
    const h = demoHarness();
    try {
      const unauthorized = await request(h.app)
        .post('/v1/conversations/x/attachments')
        .set(attachmentUploadHeaders('', 'a.txt', 'text/plain'))
        .send(Buffer.from('x', 'utf8'));
      expect(unauthorized.status).toBe(401);
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

      const uploaded = await upload(h, token, conversationId, {
        name: 'draft.md',
        mime: 'text/markdown',
        body: '# Draft\nbody text here',
      });
      expect(uploaded.status).toBe(201);
      expect(uploaded.body.messageId).toBeNull();

      const bad = await upload(h, token, conversationId, {
        name: 'evil.exe',
        mime: 'application/octet-stream',
        body: 'x',
      });
      expect(bad.status).toBe(415);

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          conversationId,
          attachmentIds: [uploaded.body.id],
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

      const uploaded = await upload(h, token, conversationId, {
        name: 'x.txt',
        mime: 'text/plain',
        body: 'content bytes',
      });
      const attId = uploaded.body.id as string;

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
