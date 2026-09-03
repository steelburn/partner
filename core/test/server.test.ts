import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { ChatEvent } from '@partner/shared';
import { ALLOWED_HOST, ALTERNATE_HOST, demoHarness } from './helpers.js';
import type { Harness } from './helpers.js';

const FOREIGN_HOST = 'evil.example:9999';

function parseSse(text: string): ChatEvent[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as ChatEvent);
}

/** GET the demo pairing code (auto-issues on first read). */
async function fetchDevCode(app: Harness['app']): Promise<string> {
  const res = await request(app).get('/v1/dev/pair-code').set('Host', ALLOWED_HOST);
  expect(res.status).toBe(200);
  expect(res.body.code).toMatch(/^\d{6}$/);
  return res.body.code as string;
}

/** Exchange a code for a web session token. */
async function pair(app: Harness['app'], code: string): Promise<string> {
  const res = await request(app)
    .post('/v1/pair')
    .set('Host', ALLOWED_HOST)
    .send({ code });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ kind: 'web' });
  expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
  expect(typeof res.body.expiresAt).toBe('number');
  return res.body.token as string;
}

describe('public surface', () => {
  it('GET /v1/health is public and reports demo/version/schema', async () => {
    const h = demoHarness();
    try {
      const res = await request(h.app).get('/v1/health').set('Host', ALLOWED_HOST);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', demo: true, schemaVersion: 1 });
      expect(typeof res.body.version).toBe('string');
    } finally {
      h.close();
    }
  });

  it('rejects a foreign Host header with 403 before routing', async () => {
    const h = demoHarness();
    try {
      const res = await request(h.app).get('/v1/health').set('Host', FOREIGN_HOST);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden_host');
    } finally {
      h.close();
    }
  });

  it('hides /v1/dev/pair-code when demo is off', async () => {
    const h = demoHarness({ demo: false });
    try {
      const res = await request(h.app).get('/v1/dev/pair-code').set('Host', ALLOWED_HOST);
      expect(res.status).toBe(404);
    } finally {
      h.close();
    }
  });
});

describe('auth gate', () => {
  it('POST /v1/chat without a token is 401', async () => {
    const h = demoHarness();
    try {
      const res = await request(h.app)
        .post('/v1/chat')
        .set('Host', ALLOWED_HOST)
        .send({ messages: [{ role: 'user', content: 'hi' }] });
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('missing_token');
    } finally {
      h.close();
    }
  });

  it('rejects an unknown bearer token', async () => {
    const h = demoHarness();
    try {
      const res = await request(h.app)
        .post('/v1/chat')
        .set('Host', ALLOWED_HOST)
        .set('Authorization', `Bearer ${'f'.repeat(64)}`)
        .send({ messages: [{ role: 'user', content: 'hi' }] });
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('not_found');
    } finally {
      h.close();
    }
  });

  it('binds sessions to their origin: a session minted on one loopback host is refused on the other', async () => {
    const h = demoHarness();
    try {
      const code = await fetchDevCode(h.app);
      const token = await pair(h.app, code);
      const res = await request(h.app)
        .post('/v1/chat')
        .set('Host', ALTERNATE_HOST)
        .set('Authorization', `Bearer ${token}`)
        .send({ messages: [{ role: 'user', content: 'hi' }] });
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('origin_mismatch');
    } finally {
      h.close();
    }
  });
});

describe('pairing HTTP semantics', () => {
  it('three wrong codes give 401s, then the correct code is refused with 429 (locked)', async () => {
    const h = demoHarness();
    try {
      const code = await fetchDevCode(h.app);
      const wrongs = Array.from({ length: 3 }, (_, i) =>
        String((Number.parseInt(code, 10) + i + 1) % 1_000_000).padStart(6, '0'),
      );
      for (const wrong of wrongs) {
        const res = await request(h.app)
          .post('/v1/pair')
          .set('Host', ALLOWED_HOST)
          .send({ code: wrong });
        expect(res.status).toBe(401);
        expect(res.body.reason).toBe('invalid');
      }

      const locked = await request(h.app)
        .post('/v1/pair')
        .set('Host', ALLOWED_HOST)
        .send({ code });
      expect(locked.status).toBe(429);
      expect(locked.body.reason).toBe('locked');
    } finally {
      h.close();
    }
  });

  it('pairing an unknown code (nothing issued) is 401 not_found', async () => {
    const h = demoHarness();
    try {
      const res = await request(h.app)
        .post('/v1/pair')
        .set('Host', ALLOWED_HOST)
        .send({ code: '123456' });
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('not_found');
    } finally {
      h.close();
    }
  });
});

describe('full demo round trip', () => {
  it('pair-code -> pair -> SSE chat streams delta/usage/done without leaking the token', async () => {
    const h = demoHarness();
    try {
      const code = await fetchDevCode(h.app);
      const token = await pair(h.app, code);

      const chat = await request(h.app)
        .post('/v1/chat')
        .set('Host', ALLOWED_HOST)
        .set('Authorization', `Bearer ${token}`)
        .send({ messages: [{ role: 'user', content: 'hello world' }], model: 'demo' });
      expect(chat.status).toBe(200);
      expect(chat.type).toContain('text/event-stream');

      const events = parseSse(chat.text);
      expect(events.map((e) => e.type)).toEqual(['delta', 'usage', 'done']);
      const delta = events[0] as Extract<ChatEvent, { type: 'delta' }>;
      expect(delta.text).toContain('11'); // 'hello world'.length
      const done = events[events.length - 1] as Extract<ChatEvent, { type: 'done' }>;
      expect(done.model).toBe('demo');

      // The session token must never appear in any response body.
      expect(chat.text).not.toContain(token);
      expect(JSON.stringify(events)).not.toContain(token);

      // Audit captured the pairing + chat, with no secrets in details.
      const auditRows = h.audit.list(100);
      const actions = auditRows.map((r) => r.action);
      expect(actions).toContain('pair.issue');
      expect(actions).toContain('pair.verify');
      expect(actions).toContain('chat.stream');
      const auditBlob = auditRows.map((r) => JSON.stringify(r)).join('\n');
      expect(auditBlob).not.toContain('sk-');
      expect(auditBlob).not.toContain(token);
    } finally {
      h.close();
    }
  });

  it('GET /v1/audit (authed) lists redacted entries and honors limit', async () => {
    const h = demoHarness();
    try {
      const code = await fetchDevCode(h.app);
      const token = await pair(h.app, code);

      const res = await request(h.app)
        .get('/v1/audit?limit=1')
        .set('Host', ALLOWED_HOST)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].action).toBe('pair.verify');
      expect(JSON.stringify(res.body)).not.toContain(token);

      const unauth = await request(h.app).get('/v1/audit').set('Host', ALLOWED_HOST);
      expect(unauth.status).toBe(401);
    } finally {
      h.close();
    }
  });

  it('malformed chat bodies are 400 and unknown routes are 404', async () => {
    const h = demoHarness();
    try {
      const code = await fetchDevCode(h.app);
      const token = await pair(h.app, code);

      const bad = await request(h.app)
        .post('/v1/chat')
        .set('Host', ALLOWED_HOST)
        .set('Authorization', `Bearer ${token}`)
        .send({ messages: 'not-an-array' });
      expect(bad.status).toBe(400);

      const missing = await request(h.app)
        .get('/v1/nope')
        .set('Host', ALLOWED_HOST)
        .set('Authorization', `Bearer ${token}`);
      expect(missing.status).toBe(404);
    } finally {
      h.close();
    }
  });
});
