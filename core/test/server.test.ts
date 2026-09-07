import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent } from '@partner/shared';
import { SCHEMA_VERSION } from '@partner/shared';
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
      expect(res.body).toMatchObject({ status: 'ok', demo: true, schemaVersion: SCHEMA_VERSION });
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

describe('device pairing channel (M15)', () => {
  const SECRET = 'shell-boot-secret-abc123';

  it('does not exist without a configured device secret (plain live core)', async () => {
    const h = demoHarness({ demo: false });
    try {
      const res = await request(h.app)
        .get('/v1/pair/device')
        .set('Host', ALLOWED_HOST)
        .set('x-partner-device', SECRET);
      expect(res.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('stays demo-only for /v1/dev/pair-code in live mode even with a secret', async () => {
    const h = demoHarness({ demo: false, deviceSecret: SECRET });
    try {
      const res = await request(h.app).get('/v1/dev/pair-code').set('Host', ALLOWED_HOST);
      expect(res.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('rejects a wrong device secret with 401', async () => {
    const h = demoHarness({ demo: false, deviceSecret: SECRET });
    try {
      const res = await request(h.app)
        .get('/v1/pair/device')
        .set('Host', ALLOWED_HOST)
        .set('x-partner-device', 'wrong-secret');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('device_secret_mismatch');
      // A wrong guess must not rotate the active code.
      const res2 = await request(h.app)
        .get('/v1/pair/device')
        .set('Host', ALLOWED_HOST)
        .set('x-partner-device', SECRET);
      expect(res2.status).toBe(200);
      expect(res2.body.code).toMatch(/^\d{6}$/);
    } finally {
      h.close();
    }
  });

  it('issues a fresh single-use code the web pair flow can exchange', async () => {
    const h = demoHarness({ demo: false, deviceSecret: SECRET });
    try {
      const res = await request(h.app)
        .get('/v1/pair/device')
        .set('Host', ALLOWED_HOST)
        .set('x-partner-device', SECRET);
      expect(res.status).toBe(200);
      expect(res.body.code).toMatch(/^\d{6}$/);

      // The tray-minted code flows through the ordinary web pairing ceremony
      // (host-allowlisted loopback -> web session).
      const token = await pair(h.app, res.body.code as string);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      h.close();
    }
  });

  it('audits device issues as pair.issue.device (shell actor, no code logged)', async () => {
    const h = demoHarness({ demo: false, deviceSecret: SECRET });
    try {
      await request(h.app)
        .get('/v1/pair/device')
        .set('Host', ALLOWED_HOST)
        .set('x-partner-device', SECRET);
      const rows = h.audit.list(100);
      const device = rows.find((row) => row.action === 'pair.issue.device');
      expect(device).toBeDefined();
      expect(device?.actor).toBe('shell');
      // The code itself never lands in the audit trail (details stay empty).
      expect(JSON.parse(String(device?.details ?? '{}'))).toEqual({});
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

  it('GET /v1/audit never leaks a secret seeded straight into the audit service', async () => {
    const h = demoHarness();
    try {
      const code = await fetchDevCode(h.app);
      const token = await pair(h.app, code);
      // Worst case: a caller passes a secret-shaped detail object. The single
      // serialization point must scrub it before the row (and the API) see it.
      h.audit.log('web', 'provider.create', 'p-1', {
        name: 'ne1',
        key: 'sk-live-9999888877776666',
        endpoint: 'https://ne1/v1',
        env: '{"DATABASE_URL":"postgres://u:routeSecretPass123@db/x"}',
        note: 'pem -----BEGIN PRIVATE KEY-----\nabcDefGhiJkl123\n-----END PRIVATE KEY-----',
      });
      const res = await request(h.app)
        .get('/v1/audit')
        .set('Host', ALLOWED_HOST)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const blob = JSON.stringify(res.body);
      expect(blob).not.toContain('sk-live-9999888877776666');
      expect(blob).not.toContain('routeSecretPass123');
      expect(blob).not.toContain('abcDefGhiJkl123');
      expect(blob).not.toContain('BEGIN PRIVATE KEY');
      expect(blob).toContain('ne1');
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

describe('SPA static serving (review fix)', () => {
  it('serves index.html and assets from staticDir, still behind the Host guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'partner-static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Partner</title>');
    writeFileSync(join(dir, 'app.css'), 'body{color:var(--text)}');
    const h = demoHarness({ staticDir: dir });
    try {
      const root = await request(h.app).get('/').set('Host', ALLOWED_HOST);
      expect(root.status).toBe(200);
      expect(root.headers['content-type']).toContain('text/html');
      expect(root.text).toContain('Partner');

      const asset = await request(h.app).get('/app.css').set('Host', ALLOWED_HOST);
      expect(asset.status).toBe(200);
      expect(asset.text).toContain('var(--text)');

      // The loopback guard still applies to static routes.
      const foreign = await request(h.app).get('/').set('Host', 'evil.example:9999');
      expect(foreign.status).toBe(403);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls through to JSON 404 when staticDir has no index.html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'partner-empty-'));
    const h = demoHarness({ staticDir: dir });
    try {
      const res = await request(h.app).get('/').set('Host', ALLOWED_HOST);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('robust errors & session revocation (review fixes)', () => {
  it('malformed JSON returns a JSON 400 with no HTML/stack/paths', async () => {
    const h = demoHarness();
    try {
      const res = await request(h.app)
        .post('/v1/pair')
        .set('Host', ALLOWED_HOST)
        .set('Content-Type', 'application/json')
        .send('{not valid json');
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).toEqual({ error: 'bad_json' });
      expect(res.text).not.toContain('at '); // no stack trace
      expect(res.text).not.toContain('/home/'); // no internal paths
    } finally {
      h.close();
    }
  });

  it('DELETE /v1/session revokes the presented token', async () => {
    const h = demoHarness();
    try {
      const code = await fetchDevCode(h.app);
      const token = await pair(h.app, code);

      const del = await request(h.app)
        .delete('/v1/session')
        .set('Host', ALLOWED_HOST)
        .set('Authorization', `Bearer ${token}`);
      expect(del.status).toBe(204);

      // The revoked token is refused afterwards.
      const chat = await request(h.app)
        .post('/v1/chat')
        .set('Host', ALLOWED_HOST)
        .set('Authorization', `Bearer ${token}`)
        .send({ messages: [{ role: 'user', content: 'hi' }] });
      expect(chat.status).toBe(401);
      expect(chat.body.reason).toBe('revoked');

      // And the revocation is audited.
      const rows = h.audit.list(100);
      expect(rows.filter((e) => e.action === 'session.revoke').length).toBe(1);
    } finally {
      h.close();
    }
  });
});

describe('audit filters (M10 W4)', () => {
  it('filters by actor, action substring and free text; actors list stays clean', async () => {
    const h = demoHarness();
    try {
      const code = await fetchDevCode(h.app);
      const token = await pair(h.app, code);
      const authed = (): Record<string, string> => ({
        Host: ALLOWED_HOST,
        Authorization: `Bearer ${token}`,
      });
      // Seed a spread of rows through the real service (redacted by design).
      h.audit.log('session', 'chat.stream', 'gpt-4o', { ok: true, events: 3, sessionId: 's1' });
      h.audit.log('persona', 'playbook.run', 'docgen', { runId: 'r1', status: 'done' });
      h.audit.log('web', 'provider.create', 'p-9', { name: 'ne1' });
      h.audit.log('session', 'chat.stream', 'gpt-4o', { ok: false, events: 0, sessionId: 's1' });

      const byActor = await request(h.app).get('/v1/audit?actor=persona').set(authed());
      expect(byActor.body.entries).toHaveLength(1);
      expect(byActor.body.entries[0].action).toBe('playbook.run');

      const byAction = await request(h.app).get('/v1/audit?action=chat&limit=50').set(authed());
      expect(byAction.body.entries.length).toBeGreaterThanOrEqual(2);
      expect(byAction.body.entries.every((e: { action: string }) => e.action.includes('chat'))).toBe(true);

      const byQ = await request(h.app).get('/v1/audit?q=ne1').set(authed());
      expect(byQ.body.entries).toHaveLength(1);
      expect(byQ.body.entries[0].action).toBe('provider.create');
    } finally {
      h.close();
    }
  });
});
