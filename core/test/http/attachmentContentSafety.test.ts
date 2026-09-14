/**
 * Attachment content-safety tests (PLAN-M20.md §8.1.1).
 *
 * The hole this closes: the SPA and the API share an origin, and the session
 * bearer token lives in that origin's `localStorage`. The upload allowlist
 * accepts any `text/*` — including `text/html` — so serving such a body
 * `inline` let a document execute on the authenticated origin and read the
 * token. `nosniff` does not prevent that: it stops content *sniffing*, not an
 * explicitly declared `text/html`.
 *
 * The realistic trigger is not an attacker uploading a file. The partner
 * generates an HTML/CSS prototype (a first-class capability), and the user
 * opens it — which is why the policy is asserted here at the HTTP boundary
 * rather than assumed of the client.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_HOST, attachmentUploadHeaders, demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import {
  attachmentContentHeaders,
  isInlineSafeMime,
} from '../../src/http/server.js';

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const res = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

async function uploadAndFetch(
  h: Harness,
  token: string,
  file: { name: string; mime: string; body: string },
): Promise<request.Response> {
  const conv = await request(h.app)
    .post('/v1/conversations')
    .set(authed(token))
    .send({ title: 'safety' });
  const conversationId = conv.body.id as string;
  const upload = await request(h.app)
    .post(`/v1/conversations/${conversationId}/attachments`)
    .set(attachmentUploadHeaders(token, file.name, file.mime))
    .send(Buffer.from(file.body, 'utf8'));
  expect(upload.status).toBe(201);
  return request(h.app)
    .get(`/v1/conversations/${conversationId}/attachments/${upload.body.id}/content`)
    .set(authed(token));
}

describe('attachment content disposition policy', () => {
  it('treats only non-executable render types as inline-safe', () => {
    // Renderable media the SPA displays in the transcript.
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']) {
      expect(isInlineSafeMime(mime)).toBe(true);
    }
    // Everything that can carry script or be sniffed into a document.
    for (const mime of [
      'text/html',
      'text/plain',
      'text/markdown',
      'text/css',
      'text/csv',
      'text/javascript',
      'application/javascript',
      'application/json',
      'application/xml',
      'application/octet-stream',
      'image/svg+xml',
      '',
    ]) {
      expect(isInlineSafeMime(mime)).toBe(false);
    }
  });

  it('ignores case and surrounding whitespace in the declared type', () => {
    expect(isInlineSafeMime('  IMAGE/PNG ')).toBe(true);
    expect(isInlineSafeMime('TEXT/HTML')).toBe(false);
  });

  it('forces a download and an opaque origin for HTML', () => {
    const headers = attachmentContentHeaders('text/html', 'prototype.html');
    expect(headers['Content-Disposition']).toContain('attachment');
    expect(headers['Content-Disposition']).toContain('prototype.html');
    expect(headers['Content-Security-Policy']).toBe('sandbox');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('keeps images and PDF inline, without a sandbox that would break them', () => {
    // `sandbox` blocks plugins, so applying it to PDF would break the browser's
    // inline viewer — a security fix must not cost a feature.
    for (const mime of ['image/png', 'application/pdf']) {
      const headers = attachmentContentHeaders(mime, 'a.bin');
      expect(headers['Content-Disposition']).toContain('inline');
      expect(headers['Content-Security-Policy']).toBeUndefined();
    }
  });

  it('still escapes a filename rather than letting it inject a header', () => {
    const headers = attachmentContentHeaders('text/plain', 'a"; evil=1; .txt');
    expect(headers['Content-Disposition']).not.toContain('\n');
    expect(headers['Content-Disposition']).toContain(encodeURIComponent('a"; evil=1; .txt'));
  });
});

describe('attachment content over HTTP', () => {
  it('serves an uploaded HTML file as an attachment, never inline', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await uploadAndFetch(h, token, {
        name: 'prototype.html',
        mime: 'text/html',
        body: '<script>localStorage.getItem("partner.token")</script>',
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-security-policy']).toBe('sandbox');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      // The bytes still round-trip: the partner may legitimately read HTML.
      expect(res.text).toContain('localStorage.getItem');
    } finally {
      h.close();
    }
  });

  it('still serves an image inline so the transcript can render it', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await uploadAndFetch(h, token, {
        name: 'shot.png',
        mime: 'image/png',
        body: 'not-a-real-png-but-the-route-does-not-parse-it',
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('inline');
      expect(res.headers['content-security-policy']).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it('keeps SVG out of the surface entirely', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const conv = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ title: 'svg' });
      const res = await request(h.app)
        .post(`/v1/conversations/${conv.body.id}/attachments`)
        .set(attachmentUploadHeaders(token, 'icon.svg', 'image/svg+xml'))
        .send(Buffer.from('<svg onload="alert(1)"/>', 'utf8'));
      // SVG is script-bearing and is neither text/*, an allowed image type nor
      // PDF — the upload allowlist already refuses it.
      expect(res.status).toBe(415);
    } finally {
      h.close();
    }
  });

  it('refuses an unconverted HEIC with the conversion instruction, not a bare 415', async () => {
    // The SPA converts iPhone photos to JPEG before uploading
    // (web/src/lib/image-convert.ts), so this answers a client that did not —
    // the user-reported phone case must never come back as an opaque refusal.
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const conv = await request(h.app)
        .post('/v1/conversations')
        .set(authed(token))
        .send({ title: 'heic' });
      for (const mime of ['image/heic', 'image/heif', 'image/heic-sequence']) {
        const res = await request(h.app)
          .post(`/v1/conversations/${conv.body.id}/attachments`)
          .set(attachmentUploadHeaders(token, 'IMG_0001.HEIC', mime))
          .send(Buffer.from('not really a heic', 'utf8'));
        expect(res.status).toBe(415);
        expect(res.body.error).toBe('unsupported');
        expect(res.body.message).toBe(
          `${mime} is not supported — attach the photo as JPEG (Safari converts iPhone photos automatically)`,
        );
      }
    } finally {
      h.close();
    }
  });
});
