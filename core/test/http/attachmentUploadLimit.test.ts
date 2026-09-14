/**
 * M22/R7 — the upload cap is the UPLOAD cap.
 *
 * The defect this pins: uploads used to ride a base64 JSON envelope, so the
 * bytes that hit the wire were 4/3 of the file and the limit that refused them
 * was the 1 MiB JSON body cap. `MAX_UPLOAD_BYTES` (default 8 MiB) was therefore
 * unreachable — a real ceiling of ~786 KB, reported as a bare
 * `payload_too_large` token with no size in it. Photographs from a phone are
 * 2–5 MB, so every photo failed.
 *
 * Now the file bytes ARE the body (`express.raw`), the cap that refuses and the
 * cap the 413 quotes are the same `MAX_UPLOAD_BYTES`, and the client can read
 * it from `/v1/health` to refuse before spending the upload.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_HOST, attachmentUploadHeaders, demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const res = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

async function conversation(h: Harness, token: string): Promise<string> {
  const res = await request(h.app).post('/v1/conversations').set(authed(token)).send({ title: 'photos' });
  return res.body.id as string;
}

describe('R7 — attachment upload cap', () => {
  it('accepts a whole 8 MiB file and refuses 8 MiB + 1, naming the size and the cap', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const id = await conversation(h, token);
      const cap = 8 * 1024 * 1024;

      // A 1 MiB JPEG: refused by the old envelope (base64 → 1.33 MiB > the 1 MiB
      // JSON cap), and the size of an ordinary phone photo.
      const typical = await request(h.app)
        .post(`/v1/conversations/${id}/attachments`)
        .set(attachmentUploadHeaders(token, 'IMG_4821.jpg', 'image/jpeg'))
        .send(Buffer.alloc(1024 * 1024, 0x41));
      expect(typical.status).toBe(201);
      expect(typical.body.mime).toBe('image/jpeg');
      expect(typical.body.size).toBe(1024 * 1024);

      // Exactly the cap is allowed; one byte more is not.
      const exact = await request(h.app)
        .post(`/v1/conversations/${id}/attachments`)
        .set(attachmentUploadHeaders(token, 'exact.jpg', 'image/jpeg'))
        .send(Buffer.alloc(cap, 0x42));
      expect(exact.status).toBe(201);
      expect(exact.body.size).toBe(cap);

      const over = await request(h.app)
        .post(`/v1/conversations/${id}/attachments`)
        .set(attachmentUploadHeaders(token, 'huge.jpg', 'image/jpeg'))
        .send(Buffer.alloc(cap + 1, 0x43));
      expect(over.status).toBe(413);
      expect(over.body.error).toBe('payload_too_large');
      // The 413 is actionable: it names the file, its size and the limit. The
      // size rounds UP (8 MiB + 1 reads "8.1 MB") so it cannot appear equal to
      // the very limit it exceeded.
      expect(over.body.message).toBe('huge.jpg is 8.1 MB — the limit is 8 MB per file.');
    } finally {
      h.close();
    }
  }, 60_000);

  it('publishes the cap so the client can refuse before uploading', async () => {
    const h = demoHarness();
    try {
      const res = await request(h.app).get('/v1/health').set('Host', ALLOWED_HOST);
      expect(res.status).toBe(200);
      expect(res.body.maxUploadBytes).toBe(8 * 1024 * 1024);
    } finally {
      h.close();
    }
  });

  it('takes the mime from the content type and the NAME from the header (percent-encoded, never a URL)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const id = await conversation(h, token);

      const unicode = await request(h.app)
        .post(`/v1/conversations/${id}/attachments`)
        .set(attachmentUploadHeaders(token, 'foto ção — 1.png', 'image/png'))
        .send(Buffer.from('iVBORw0KGgo=', 'base64'));
      expect(unicode.status).toBe(201);
      expect(unicode.body.name).toBe('foto ção — 1.png');
      expect(unicode.body.mime).toBe('image/png');

      // A name that merely contains a percent sign is a name, not corrupted
      // encoding — it uploads literally rather than being refused.
      const literal = await request(h.app)
        .post(`/v1/conversations/${id}/attachments`)
        .set(attachmentUploadHeaders(token, '100% done.txt', 'text/plain'))
        .send(Buffer.from('done', 'utf8'));
      expect(literal.status).toBe(201);
      expect(literal.body.name).toBe('100% done.txt');

      // Content-type parameters are not part of the mime.
      const charset = await request(h.app)
        .post(`/v1/conversations/${id}/attachments`)
        .set({
          ...attachmentUploadHeaders(token, 'note.md', 'text/markdown'),
          'Content-Type': 'text/markdown; charset=utf-8',
        })
        .send(Buffer.from('hi', 'utf8'));
      expect(charset.status).toBe(201);
      expect(charset.body.mime).toBe('text/markdown');
    } finally {
      h.close();
    }
  });

  it('refuses a name-less upload and says so', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const id = await conversation(h, token);
      const res = await request(h.app)
        .post(`/v1/conversations/${id}/attachments`)
        .set({ Host: ALLOWED_HOST, Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' })
        .send(Buffer.from('bytes', 'utf8'));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_input');
      expect(res.body.message).toBe('attachment name is required');
    } finally {
      h.close();
    }
  });

  it('tells an old base64-JSON client what an upload must look like', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const id = await conversation(h, token);
      // Version skew only: the shipped SPA posts bytes.
      const res = await request(h.app)
        .post(`/v1/conversations/${id}/attachments`)
        .set(authed(token))
        .send({ name: 'a.txt', mime: 'text/plain', dataBase64: Buffer.from('x').toString('base64') });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_input');
      expect(res.body.message).toContain('x-attachment-name');
    } finally {
      h.close();
    }
  });

  it('a tightened cap governs the wire, the message and /v1/health alike', async () => {
    const h = demoHarness({ maxUploadBytes: 1024 });
    try {
      const token = await pairToken(h);
      const id = await conversation(h, token);

      const health = await request(h.app).get('/v1/health').set('Host', ALLOWED_HOST);
      expect(health.body.maxUploadBytes).toBe(1024);

      const under = await request(h.app)
        .post(`/v1/conversations/${id}/attachments`)
        .set(attachmentUploadHeaders(token, 'small.txt', 'text/plain'))
        .send(Buffer.alloc(1024, 0x44));
      expect(under.status).toBe(201);

      const over = await request(h.app)
        .post(`/v1/conversations/${id}/attachments`)
        .set(attachmentUploadHeaders(token, 'tall.txt', 'text/plain'))
        .send(Buffer.alloc(1025, 0x45));
      expect(over.status).toBe(413);
      expect(over.body.message).toBe('tall.txt is 1.1 KB — the limit is 1 KB per file.');
    } finally {
      h.close();
    }
  });
});
