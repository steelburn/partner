/**
 * M1 HTTP surface tests (PLAN-M1 wire spec, TDD 8-17): every provider route
 * is authed; keys live only in the keychain; /test probes a live fake
 * upstream; DELETE removes row + keychain entry; /v1/chat streams through a
 * real provider with budget caps; the self-service import proxies login-key
 * and connects against a FAKE llm-self-service (RSA-OAEP envelope). A final
 * scan proves no key/ciphertext/password ever appears in a response or audit
 * row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import { generateKeyPairSync, privateDecrypt, constants, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ChatEvent } from '@partner/shared';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { sseReply } from '../support/server.js';

// ---------------------------------------------------------------------------
// Pairing helpers (mirror server.test.ts)
// ---------------------------------------------------------------------------

async function pairToken(h: Harness): Promise<string> {
  // Issue the code through the manager (works demo AND live; the dev
  // pair-code HTTP seam is demo-only and covered by server.test + e2e).
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

function parseSse(text: string): ChatEvent[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as ChatEvent);
}

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible upstream (models + SSE chat)
// ---------------------------------------------------------------------------

interface FakeUpstream {
  server: http.Server;
  base: string;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
  close(): Promise<void>;
}

function startFakeUpstream(): Promise<FakeUpstream> {
  return new Promise((resolve, reject) => {
    const requests: FakeUpstream['requests'] = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1-mini' }] }));
        return;
      }
      if (path === '/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sseReply(['Hello ', 'world'], { prompt: 5000, completion: 5000 }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        requests,
        close(): Promise<void> {
          return new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          });
        },
      });
    });
  });
}

/**
 * Upstream that streams deltas one-by-one with a small delay between frames —
 * lets tests observe a budget stop MID-STREAM (the big delta is dropped).
 */
function startDelayedUpstream(deltas: string[]): Promise<FakeUpstream> {
  return new Promise((resolve, reject) => {
    const requests: FakeUpstream['requests'] = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
        return;
      }
      if (path === '/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        void (async () => {
          try {
            for (const delta of deltas) {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
              await new Promise((r) => setTimeout(r, 15));
            }
            res.end('data: [DONE]\n\n');
          } catch {
            res.destroy();
          }
        })();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        requests,
        close(): Promise<void> {
          return new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          });
        },
      });
    });
  });
}

const PROVISIONED_KEY = 'sk-demo-provisioned-123456';
const upstreams: Array<{ close(): Promise<void> }> = [];

async function track<T extends { close(): Promise<void> }>(t: T): Promise<T> {
  upstreams.push(t);
  return t;
}

afterEach(async () => {
  await Promise.all(upstreams.splice(0).map((u) => u.close()));
});

function secretTokens(): string[] {
  return [PROVISIONED_KEY, 'sk-pasted-secret-777777'];
}

// ---------------------------------------------------------------------------

describe('auth gate on every provider route', () => {
  it('returns 401 without a token for the whole M1 surface', async () => {
    const h = demoHarness();
    try {
      const cases: Array<[string, string]> = [
        ['get', '/v1/providers'],
        ['post', '/v1/providers'],
        ['post', '/v1/providers/x/key'],
        ['post', '/v1/providers/x/test'],
        ['delete', '/v1/providers/x'],
        ['get', '/v1/models?provider=x'],
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

describe('provider CRUD routes', () => {
  it('POST create -> 201; responses and the DB row never contain keyRef or the key', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'ne1', endpoint: 'https://api.ne1.dev/v1' });
      expect(created.status).toBe(201);
      const body = created.body as Record<string, unknown>;
      expect(body).toMatchObject({
        name: 'ne1',
        kind: 'openai-compatible',
        source: 'manual',
        enabled: true,
      });
      const text = JSON.stringify(body);
      expect(text).not.toContain('keyRef');
      expect(text).not.toContain('sk-');
      for (const secret of secretTokens()) expect(text).not.toContain(secret);

      const list = await request(h.app).get('/v1/providers').set(authed(token));
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain('keyRef');
      expect(JSON.stringify(list.body)).not.toContain('sk-');

      const row = h.db.prepare('SELECT * FROM providers').all();
      expect(row).toHaveLength(1);
      expect(JSON.stringify(row)).not.toContain('sk-');
      // The DB has NO column capable of holding the key.
      const columns = h.db.prepare('PRAGMA table_info(providers)').all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).not.toContain('key');
    } finally {
      h.close();
    }
  });

  it('defaults purpose to general; an explicit purpose round-trips (M11 F4)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'plain', endpoint: 'https://api.ne1.dev/v1' });
      expect(created.status).toBe(201);
      expect(created.body.purpose).toBe('general');

      const coding = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'coder', endpoint: 'https://api.ne1.dev/v1', purpose: 'coding' });
      expect(coding.status).toBe(201);
      expect(coding.body.purpose).toBe('coding');

      const list = await request(h.app).get('/v1/providers').set(authed(token));
      expect(list.status).toBe(200);
      const purposes = (
        (list.body as { providers: Array<{ name: string; purpose: string }> }).providers ?? []
      ).map((p) => [p.name, p.purpose]);
      expect(purposes).toContainEqual(['plain', 'general']);
      expect(purposes).toContainEqual(['coder', 'coding']);
    } finally {
      h.close();
    }
  });

  it('rejects invalid kind (400) and bad endpoint (400)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const badKind = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'x', kind: 'anthropic', endpoint: 'https://x.example/v1' });
      expect(badKind.status).toBe(400);
      expect(badKind.body.error).toBe('invalid_kind');

      const badEndpoint = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'x', endpoint: 'https://' });
      expect(badEndpoint.status).toBe(400);
      expect(badEndpoint.body.error).toBe('invalid_endpoint');
      expect(h.providerManager.list()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('POST key stores ONLY in the keychain (204); list stays clean; rotation replaces', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'k', endpoint: 'https://k.example/v1' });
      const id = (created.body as { id: string }).id;

      const set1 = await request(h.app)
        .post(`/v1/providers/${id}/key`)
        .set(authed(token))
        .send({ key: 'sk-pasted-secret-777777' });
      expect(set1.status).toBe(204);
      await expect(h.keychain.get('partner', `provider:${id}`)).resolves.toBe('sk-pasted-secret-777777');

      // Rotation overwrites atomically (no old value anywhere).
      const set2 = await request(h.app)
        .post(`/v1/providers/${id}/key`)
        .set(authed(token))
        .send({ key: 'sk-pasted-rotated-888888' });
      expect(set2.status).toBe(204);
      await expect(h.keychain.get('partner', `provider:${id}`)).resolves.toBe('sk-pasted-rotated-888888');

      const list = await request(h.app).get('/v1/providers').set(authed(token));
      const text = JSON.stringify(list.body);
      expect(text).not.toContain('sk-');
      expect(text).not.toContain('keyRef');
      expect(text).not.toContain('777777');
      expect(text).not.toContain('888888');
      const row = h.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown>;
      expect(JSON.stringify(row)).not.toContain('sk-');

      // Validation: empty key 400; unknown id 404.
      const empty = await request(h.app)
        .post(`/v1/providers/${id}/key`)
        .set(authed(token))
        .send({ key: '  ' });
      expect(empty.status).toBe(400);
      const missing = await request(h.app)
        .post('/v1/providers/does-not-exist/key')
        .set(authed(token))
        .send({ key: 'sk-x-12345678' });
      expect(missing.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('setKey surfaces a CLEAR 500 when the OS keychain is unavailable — never the key', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'k', endpoint: 'https://k.example/v1' });
      const id = (created.body as { id: string }).id;
      h.keychain.set = async () => {
        throw new Error('secret-service daemon down');
      };
      const res = await request(h.app)
        .post(`/v1/providers/${id}/key`)
        .set(authed(token))
        .send({ key: 'sk-sensitive-never-log-999' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('keychain_unavailable');
      expect(res.text).toContain('keyring daemon');
      expect(res.text).not.toContain('sk-sensitive');
      expect(res.text).not.toContain('999');
    } finally {
      h.close();
    }
  });

  it('test() probes the fake upstream, updates default_models + health, audits', async () => {
    const upstream = await track(await startFakeUpstream());
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'probe', endpoint: upstream.base });
      const id = (created.body as { id: string }).id;
      await request(h.app).post(`/v1/providers/${id}/key`).set(authed(token)).send({ key: PROVISIONED_KEY });

      const test = await request(h.app).post(`/v1/providers/${id}/test`).set(authed(token));
      expect(test.status).toBe(200);
      expect(test.body).toMatchObject({
        id,
        defaultModels: ['gpt-4o', 'gpt-4.1-mini'],
        health: { ok: true, models: ['gpt-4o', 'gpt-4.1-mini'] },
      });
      expect(typeof test.body.health.latencyMs).toBe('number');
      expect(JSON.stringify(test.body)).not.toContain(PROVISIONED_KEY);

      const audit = h.audit.list(100);
      const testRows = audit.filter((r) => r.action === 'provider.test');
      expect(testRows.length).toBe(1);
      expect(JSON.stringify(testRows[0])).not.toContain(PROVISIONED_KEY);

      const unknown = await request(h.app).post('/v1/providers/nope/test').set(authed(token));
      expect(unknown.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('test() NEVER clobbers curated default models (M13 purpose pins survive)', async () => {
    const upstream = await track(await startFakeUpstream());
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'curated', endpoint: upstream.base, defaultModels: ['gpt-4o'] });
      const id = (created.body as { id: string }).id;
      await request(h.app).post(`/v1/providers/${id}/key`).set(authed(token)).send({ key: PROVISIONED_KEY });

      const test = await request(h.app).post(`/v1/providers/${id}/test`).set(authed(token));
      expect(test.status).toBe(200);
      // The curated list is untouched — the upstream's FULL list (which also
      // contains gpt-4.1-mini) stays out of defaultModels.
      expect(test.body).toMatchObject({
        defaultModels: ['gpt-4o'],
        health: { ok: true, models: ['gpt-4o', 'gpt-4.1-mini'] },
      });
      const listed = await request(h.app).get('/v1/providers').set(authed(token));
      const row = (listed.body as { providers: Array<{ id: string; defaultModels: string[] }> }).providers.find(
        (p) => p.id === id,
      );
      expect(row?.defaultModels).toEqual(['gpt-4o']);
    } finally {
      h.close();
    }
  });

  it('DELETE removes the row AND the keychain entry (204)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'gone', endpoint: 'https://gone.example/v1' });
      const id = (created.body as { id: string }).id;
      await request(h.app).post(`/v1/providers/${id}/key`).set(authed(token)).send({ key: 'sk-del-12345678' });

      const del = await request(h.app).delete(`/v1/providers/${id}`).set(authed(token));
      expect(del.status).toBe(204);
      expect(h.providerManager.get(id)).toBeNull();
      await expect(h.keychain.get('partner', `provider:${id}`)).resolves.toBeNull();
      expect(h.audit.list(100).some((r) => r.action === 'provider.delete')).toBe(true);

      const missing = await request(h.app).delete('/v1/providers/nope').set(authed(token));
      expect(missing.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('GET /v1/models lists upstream models; guards unknown provider / missing key / param', async () => {
    const upstream = await track(await startFakeUpstream());
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'models', endpoint: upstream.base });
      const id = (created.body as { id: string }).id;

      const noParam = await request(h.app).get('/v1/models').set(authed(token));
      expect(noParam.status).toBe(400);

      const unknown = await request(h.app).get('/v1/models?provider=nope').set(authed(token));
      expect(unknown.status).toBe(404);

      const noKey = await request(h.app).get(`/v1/models?provider=${id}`).set(authed(token));
      expect(noKey.status).toBe(409);

      await request(h.app).post(`/v1/providers/${id}/key`).set(authed(token)).send({ key: PROVISIONED_KEY });
      const models = await request(h.app).get(`/v1/models?provider=${id}`).set(authed(token));
      expect(models.status).toBe(200);
      expect(models.body.models).toEqual(['gpt-4o', 'gpt-4.1-mini']);
    } finally {
      h.close();
    }
  });
});

describe('POST /v1/chat through a managed provider', () => {
  it('streams delta/usage/done from the fake upstream when a provider is registered', async () => {
    const upstream = await track(await startFakeUpstream());
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'chat', endpoint: upstream.base, defaultModels: ['gpt-4o'] });
      const id = (created.body as { id: string }).id;
      await request(h.app).post(`/v1/providers/${id}/key`).set(authed(token)).send({ key: PROVISIONED_KEY });

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o' });
      expect(chat.status).toBe(200);
      expect(chat.headers['content-type']).toContain('text/event-stream');
      const events = parseSse(chat.text);
      expect(events.map((e) => e.type)).toEqual(['delta', 'delta', 'usage', 'done']);
      const deltas = events
        .filter((e): e is Extract<ChatEvent, { type: 'delta' }> => e.type === 'delta')
        .map((e) => e.text)
        .join('');
      expect(deltas).toBe('Hello world');
      const usage = events.find((e) => e.type === 'usage') as Extract<ChatEvent, { type: 'usage' }>;
      expect(usage.totalTokens).toBe(10_000);
      const audit = h.audit.list(100).find((r) => r.action === 'chat.stream');
      expect(audit).toBeDefined();
      expect(JSON.stringify(audit)).not.toContain(token);
      expect(JSON.stringify(audit)).not.toContain(PROVISIONED_KEY);

      // The demo fallback is NOT used while a provider is registered.
      expect(chat.text).not.toContain('demo: received');
    } finally {
      h.close();
    }
  });

  it('emits ONE budget_reached event (no usage/done) when the spend cap trips', async () => {
    const upstream = await track(await startFakeUpstream());
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'capped', endpoint: upstream.base, budgetCents: 3, defaultModels: ['gpt-4o'] });
      const id = (created.body as { id: string }).id;
      await request(h.app).post(`/v1/providers/${id}/key`).set(authed(token)).send({ key: PROVISIONED_KEY });

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'expensive' }], model: 'gpt-4o' });
      expect(chat.status).toBe(200);
      const events = parseSse(chat.text);
      // The reply ('Hello world') is ~11 chars = ~3 est tokens -> below the cap
      // while streaming; the usage event (10_000 tokens @ gpt-4o 5 USD/MTok =
      // 5 cents >= 3) then trips the cap and stops the stream.
      expect(events.map((e) => e.type)).toEqual(['delta', 'delta', 'budget_reached']);
      expect(chat.text).not.toContain('"type":"done"');
      const budget = events[events.length - 1] as Extract<ChatEvent, { type: 'budget_reached' }>;
      expect(budget.limitCents).toBe(3);
      expect(budget.spentCents).toBeGreaterThanOrEqual(3);
      expect(budget.limitRequests).toBeNull();
    } finally {
      h.close();
    }
  });

  it('aborts the upstream MID-STREAM before a single over-budget delta is delivered', async () => {
    // A small delta first (fits the cap), then a huge delta that must trip the
    // cap at the checkpoint — BEFORE it is written and BEFORE 'done'.
    const upstream = await track(await startDelayedUpstream(['ok', 'x'.repeat(40_000)]));
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'capped-mid', endpoint: upstream.base, budgetCents: 5, defaultModels: ['gpt-4o'] });
      const id = (created.body as { id: string }).id;
      await request(h.app).post(`/v1/providers/${id}/key`).set(authed(token)).send({ key: PROVISIONED_KEY });

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'run' }], model: 'gpt-4o' });
      expect(chat.status).toBe(200);
      const events = parseSse(chat.text);
      // 40_000 chars ~= 10_000 est tokens @ gpt-4o = 25 cents >= 5 -> trip.
      // The huge delta is dropped (never delivered) and no done follows.
      expect(events.map((e) => e.type)).toEqual(['delta', 'budget_reached']);
      const deltas = events
        .filter((e): e is Extract<ChatEvent, { type: 'delta' }> => e.type === 'delta')
        .map((e) => e.text)
        .join('');
      expect(deltas).toBe('ok');
      expect(chat.text).not.toContain('x'.repeat(64));
      expect(chat.text).not.toContain('"type":"done"');
    } finally {
      h.close();
    }
  });

  it('a registered provider without a key is refused with 409', async () => {
    const upstream = await track(await startFakeUpstream());
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'nokey', endpoint: upstream.base, defaultModels: ['gpt-4o'] });
      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o' });
      expect(chat.status).toBe(409);
      expect(chat.body.error).toBe('missing_key');
    } finally {
      h.close();
    }
  });

  it('demo fallback still works when nothing is registered, and non-demo 501s', async () => {
    const demoH = demoHarness({ demo: true });
    try {
      const token = await pairToken(demoH);
      const chat = await request(demoH.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'hello world' }] });
      expect(chat.status).toBe(200);
      expect(chat.text).toContain('demo: received 11 characters');
      expect(chat.text).toContain('"type":"done"');
    } finally {
      demoH.close();
    }

    const liveH = demoHarness({ demo: false });
    try {
      const code = await liveH.pairing.issue();
      const pairRes = await request(liveH.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
      expect(pairRes.status).toBe(200);
      const token = pairRes.body.token as string;
      const chat = await request(liveH.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'hi' }] });
      expect(chat.status).toBe(501);
      expect(chat.body.error).toBe('no_provider');
    } finally {
      liveH.close();
    }
  });
});

describe('end-to-end redaction regression', () => {
  it('a key write + chat + probe never leaks the key into responses or audit', async () => {
    const upstream = await track(await startFakeUpstream());
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const bodies: string[] = [];

      // The secret enters through the provider key route (the M1 import path
      // that used to carry it was removed in M22).
      const created = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'redaction probe', endpoint: upstream.base });
      bodies.push(created.text);
      const id = (created.body as { id: string }).id;
      const keyWrite = await request(h.app)
        .post(`/v1/providers/${id}/key`)
        .set(authed(token))
        .send({ key: PROVISIONED_KEY });
      bodies.push(keyWrite.text);

      const models = await request(h.app).get(`/v1/models?provider=${id}`).set(authed(token));
      bodies.push(models.text);
      const test = await request(h.app).post(`/v1/providers/${id}/test`).set(authed(token));
      bodies.push(test.text);
      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o' });
      bodies.push(chat.text);
      const list = await request(h.app).get('/v1/providers').set(authed(token));
      bodies.push(list.text);
      const audit = await request(h.app).get('/v1/audit').set(authed(token));
      bodies.push(audit.text);

      const all = bodies.join('\n');
      expect(all).not.toContain(PROVISIONED_KEY);
      expect(all).not.toContain('sk-');
      expect(all).not.toContain('keyRef');

      const auditRows = h.audit.list(1000);
      const blob = auditRows.map((r) => JSON.stringify(r)).join('\n');
      expect(blob).not.toContain(PROVISIONED_KEY);
      expect(blob).not.toContain('sk-');
      expect(blob).not.toContain('keyRef');
      const actions = auditRows.map((r) => r.action);
      expect(actions).toContain('provider.set_key');
      expect(actions).toContain('provider.test');
      expect(actions).toContain('chat.stream');
    } finally {
      h.close();
    }
  });
});

describe('M10 cumulative spend ledger (route-level enforcement)', () => {
  function chatCalls(upstream: FakeUpstream): number {
    return upstream.requests.filter((r) => (r.url ?? '').includes('/chat/completions')).length;
  }

  async function addCappedProvider(h: Harness, upstream: FakeUpstream, budgetCents: number) {
    const token = await pairToken(h);
    const created = await request(h.app)
      .post('/v1/providers')
      .set(authed(token))
      .send({ name: 'ledger', endpoint: upstream.base, budgetCents, defaultModels: ['gpt-4o'] });
    const id = (created.body as { id: string }).id;
    await request(h.app).post(`/v1/providers/${id}/key`).set(authed(token)).send({ key: PROVISIONED_KEY });
    return { token, id };
  }

  it('refuses a turn BEFORE streaming once the window spend reaches the cap', async () => {
    const upstream = await track(await startFakeUpstream());
    const h = demoHarness();
    try {
      const { token, id } = await addCappedProvider(h, upstream, 100);
      // Seed the ledger to the cap (as if earlier turns had spent it).
      h.spendLedger.charge({ providerId: id, cents: 100 });

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'another turn' }], model: 'gpt-4o' });
      expect(chat.status).toBe(200);
      const events = parseSse(chat.text);
      expect(events.map((e) => e.type)).toEqual(['budget_reached']);
      expect(chat.text).not.toContain('"type":"delta"');
      expect(chat.text).not.toContain('"type":"done"');
      // The upstream was NEVER contacted for this turn.
      expect(chatCalls(upstream)).toBe(0);

      // Audit rows: chat.stream refused + a provider.budget refused row
      // carrying ids/cents only.
      const refused = h.audit.list(100).find((r) => r.action === 'provider.budget');
      expect(refused).toBeDefined();
      expect(refused?.details).toContain('"event":"refused"');
      expect(JSON.stringify(refused)).not.toContain(PROVISIONED_KEY);

      // GET /v1/providers surfaces the spent amount for budgeted providers.
      const list = await request(h.app).get('/v1/providers').set(authed(token));
      const row = (list.body.providers as Array<{ id: string; spentCents?: number }>).find(
        (p) => p.id === id,
      );
      expect(row?.spentCents).toBe(100);
    } finally {
      h.close();
    }
  });

  it('settles each finished turn and refuses the turn that would cross the cap', async () => {
    const upstream = await track(await startFakeUpstream());
    const h = demoHarness();
    try {
      // gpt-4o usage fixture = 10_000 tokens ≈ 5 cents per turn (pricing.ts).
      // Cap 10: turn 1 (5) and turn 2 (5 → 10) stream; the NEXT turn is
      // refused because the ledger already sits at the cap before it starts.
      const { token, id } = await addCappedProvider(h, upstream, 10);
      const chat = () =>
        request(h.app)
          .post('/v1/chat')
          .set(authed(token))
          .send({ messages: [{ role: 'user', content: 'charge me' }], model: 'gpt-4o' });

      const turn1 = await chat();
      expect(turn1.status).toBe(200);
      expect(turn1.text).toContain('"type":"done"');
      expect(h.spendLedger.spent(id)).toBe(5);

      const turn2 = await chat();
      expect(turn2.status).toBe(200);
      expect(turn2.text).toContain('"type":"done"');
      expect(h.spendLedger.spent(id)).toBe(10);

      // Turn 3: the ledger is already at the cap (10 >= 10) -> refused
      // before the upstream is contacted for this turn.
      const callsBefore = chatCalls(upstream);
      const turn3 = await chat();
      expect(turn3.status).toBe(200);
      const events = parseSse(turn3.text);
      expect(events.map((e) => e.type)).toEqual(['budget_reached']);
      expect(chatCalls(upstream)).toBe(callsBefore);

      const charged = h.audit
        .list(100)
        .filter((r) => r.action === 'provider.budget' && r.details.includes('"event":"charged"'));
      expect(charged.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(charged)).not.toContain('charge me');
    } finally {
      h.close();
    }
  });
});

describe('M13 purpose-provider bundle route', () => {
  function startModelsUpstream(models: string[], status = 200): Promise<{ base: string; close(): Promise<void> }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (path === '/models') {
          if (status !== 200) {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'boom' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'nf' }));
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          base: `http://127.0.0.1:${port}`,
          close(): Promise<void> {
            return new Promise((done) => {
              server.closeAllConnections();
              server.close(() => done());
            });
          },
        });
      });
    });
  }

  const BUNDLE_KEY = 'sk-bundle-secret-1234567890';

  it('creates one provider per purpose from one endpoint+key; key lands in each keychain item', async () => {
    const upstream = await startModelsUpstream(['gpt-4o', 'llama-3.1-8b']);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/providers/purposes')
        .set(authed(token))
        .send({ endpoint: upstream.base, key: BUNDLE_KEY });
      expect(res.status).toBe(201);
      const body = res.body as { created: Array<{ id: string; purpose: string; defaultModels: string[] }>; models: string[] };
      expect(body.models).toEqual(['gpt-4o', 'llama-3.1-8b']);
      expect(body.created).toHaveLength(6);
      expect(body.created.map((p) => p.purpose)).toEqual(['general', 'cheap', 'deep', 'coding', 'vision', 'research']);
      const vision = body.created.find((p) => p.purpose === 'vision');
      expect(vision?.defaultModels).toEqual(['gpt-4o']); // vision-capable only
      const general = body.created.find((p) => p.purpose === 'general');
      expect(general?.defaultModels).toEqual(['gpt-4o', 'llama-3.1-8b']);
      // The key never appears in the response or the DB — only the keychain.
      expect(JSON.stringify(res.body)).not.toContain(BUNDLE_KEY);
      for (const p of body.created) {
        await expect(h.keychain.get('partner', `provider:${p.id}`)).resolves.toBe(BUNDLE_KEY);
      }
      const listed = await request(h.app).get('/v1/providers').set(authed(token));
      expect((listed.body as { providers: unknown[] }).providers).toHaveLength(6);
      expect(JSON.stringify(listed.body)).not.toContain(BUNDLE_KEY);
    } finally {
      h.close();
      await upstream.close();
    }
  });

  it('honors an explicit purposes subset in PROVIDER_PURPOSES order', async () => {
    const upstream = await startModelsUpstream(['gpt-4o']);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/providers/purposes')
        .set(authed(token))
        .send({ endpoint: upstream.base, key: BUNDLE_KEY, purposes: ['research', 'vision'] });
      expect(res.status).toBe(201);
      const created = (res.body as { created: Array<{ purpose: string }> }).created;
      expect(created.map((p) => p.purpose)).toEqual(['vision', 'research']); // canonical order wins
    } finally {
      h.close();
      await upstream.close();
    }
  });

  it('validates: bad purpose / empty purposes / missing key all 400; unauthed 401', async () => {
    const upstream = await startModelsUpstream(['gpt-4o']);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const bad = await request(h.app)
        .post('/v1/providers/purposes')
        .set(authed(token))
        .send({ endpoint: upstream.base, key: BUNDLE_KEY, purposes: ['telepathy'] });
      expect(bad.status).toBe(400);
      const empty = await request(h.app)
        .post('/v1/providers/purposes')
        .set(authed(token))
        .send({ endpoint: upstream.base, key: BUNDLE_KEY, purposes: [] });
      expect(empty.status).toBe(400);
      const noKey = await request(h.app)
        .post('/v1/providers/purposes')
        .set(authed(token))
        .send({ endpoint: upstream.base });
      expect(noKey.status).toBe(400);
      const unauthed = await request(h.app)
        .post('/v1/providers/purposes')
        .set({ Host: ALLOWED_HOST })
        .send({ endpoint: upstream.base, key: BUNDLE_KEY });
      expect(unauthed.status).toBe(401);
      const listed = await request(h.app).get('/v1/providers').set(authed(token));
      expect((listed.body as { providers: unknown[] }).providers).toHaveLength(0);
    } finally {
      h.close();
      await upstream.close();
    }
  });

  it('surfaces an upstream failure as 502 without creating any profile', async () => {
    const upstream = await startModelsUpstream([], 500);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/providers/purposes')
        .set(authed(token))
        .send({ endpoint: upstream.base, key: BUNDLE_KEY });
      expect(res.status).toBe(502);
      const listed = await request(h.app).get('/v1/providers').set(authed(token));
      expect((listed.body as { providers: unknown[] }).providers).toHaveLength(0);
    } finally {
      h.close();
      await upstream.close();
    }
  });

  it('modelPins: each purpose profile carries EXACTLY the pinned models', async () => {
    const upstream = await startModelsUpstream(['gpt-4o', 'llama-3.1-8b', 'deepseek-r1']);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/providers/purposes')
        .set(authed(token))
        .send({
          endpoint: upstream.base,
          key: BUNDLE_KEY,
          purposes: ['general', 'coding', 'vision'],
          modelPins: {
            general: ['llama-3.1-8b'],
            coding: ['deepseek-r1', 'gpt-4o'],
            vision: ['gpt-4o'],
          },
        });
      expect(res.status).toBe(201);
      const created = (res.body as { created: Array<{ purpose: string; defaultModels: string[] }> }).created;
      const byPurpose = Object.fromEntries(created.map((p) => [p.purpose, p.defaultModels]));
      expect(byPurpose.general).toEqual(['llama-3.1-8b']);
      expect(byPurpose.coding).toEqual(['deepseek-r1', 'gpt-4o']); // order kept = default first
      expect(byPurpose.vision).toEqual(['gpt-4o']);
    } finally {
      h.close();
      await upstream.close();
    }
  });

  it('applies an optional budgetCents to every created purpose profile', async () => {
    const upstream = await startModelsUpstream(['gpt-4o']);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/providers/purposes')
        .set(authed(token))
        .send({ endpoint: upstream.base, key: BUNDLE_KEY, purposes: ['general', 'vision'], budgetCents: 250 });
      expect(res.status).toBe(201);
      const created = (res.body as { created: Array<{ budgetCents: number | null }> }).created;
      expect(created.map((p) => p.budgetCents)).toEqual([250, 250]);
      // A non-numeric cap is refused and nothing is created.
      const bad = await request(h.app)
        .post('/v1/providers/purposes')
        .set(authed(token))
        .send({ endpoint: upstream.base, key: BUNDLE_KEY, purposes: ['general'], budgetCents: 'lots' });
      expect(bad.status).toBe(400);
      const listed = await request(h.app).get('/v1/providers').set(authed(token));
      expect((listed.body as { providers: unknown[] }).providers).toHaveLength(2);
    } finally {
      h.close();
      await upstream.close();
    }
  });

  it('modelPins: rejects missing purposes, empty lists, unknown keys and off-list models', async () => {
    const upstream = await startModelsUpstream(['gpt-4o', 'llama-3.1-8b']);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const post = async (modelPins: unknown, purposes?: string[]): Promise<number> => {
        const res = await request(h.app)
          .post('/v1/providers/purposes')
          .set(authed(token))
          .send({
            endpoint: upstream.base,
            key: BUNDLE_KEY,
            purposes: purposes ?? ['general', 'vision'],
            modelPins,
          });
        return res.status;
      };
      // Every requested purpose must be pinned.
      expect(await post({ general: ['gpt-4o'] })).toBe(400);
      // Empty pin list.
      expect(await post({ general: ['gpt-4o'], vision: [] })).toBe(400);
      // Unknown purpose key inside the pins.
      expect(await post({ general: ['gpt-4o'], vision: ['llama-3.1-8b'], telepathy: ['x'] })).toBe(400);
      // A model the provider did not report.
      expect(await post({ general: ['gpt-4o'], vision: ['not-a-real-model'] })).toBe(400);
      // Nothing was created by any failed attempt.
      const listed = await request(h.app).get('/v1/providers').set(authed(token));
      expect((listed.body as { providers: unknown[] }).providers).toHaveLength(0);
    } finally {
      h.close();
      await upstream.close();
    }
  });

  it('discover returns the upstream models for an endpoint+key without persisting', async () => {
    const upstream = await startModelsUpstream(['gpt-4o', 'llama-3.1-8b']);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/providers/discover')
        .set(authed(token))
        .send({ endpoint: upstream.base, key: BUNDLE_KEY });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ endpoint: upstream.base, models: ['gpt-4o', 'llama-3.1-8b'] });
      expect(JSON.stringify(res.body)).not.toContain(BUNDLE_KEY);
      const listed = await request(h.app).get('/v1/providers').set(authed(token));
      expect((listed.body as { providers: unknown[] }).providers).toHaveLength(0);
      // Guards: missing key 400, bad endpoint 400, unauthed 401, upstream 502.
      const noKey = await request(h.app)
        .post('/v1/providers/discover')
        .set(authed(token))
        .send({ endpoint: upstream.base });
      expect(noKey.status).toBe(400);
      const unauthed = await request(h.app)
        .post('/v1/providers/discover')
        .set({ Host: ALLOWED_HOST })
        .send({ endpoint: upstream.base, key: BUNDLE_KEY });
      expect(unauthed.status).toBe(401);
      const broken = await startModelsUpstream([], 500);
      try {
        const failing = await request(h.app)
          .post('/v1/providers/discover')
          .set(authed(token))
          .send({ endpoint: broken.base, key: BUNDLE_KEY });
        expect(failing.status).toBe(502);
      } finally {
        await broken.close();
      }
    } finally {
      h.close();
      await upstream.close();
    }
  });
});

/**
 * M24 — declaring which models can read photos, over HTTP.
 *
 * The route exists so a WORKING provider can be fixed in place: before it, the
 * only way to tell Partner that a gateway alias (LiteLLM's `model_name`) can
 * see was to delete the profile and re-add it — and until it was declared, a
 * chat turn with an attached photo dropped the image and the persona reported
 * that no image had been sent.
 */
describe('M24 vision declaration route', () => {
  /** Minimal /models-only upstream (module scope so both M13 and M24 can use it). */
  async function startModelsUpstreamForBundle(
    models: string[],
  ): Promise<{ base: string; close(): Promise<void> }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (path === '/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'nf' }));
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          base: `http://127.0.0.1:${port}`,
          close(): Promise<void> {
            return new Promise((done) => {
              server.closeAllConnections();
              server.close(() => done());
            });
          },
        });
      });
    });
  }

  async function createdProvider(token: string, h: Harness): Promise<string> {
    const res = await request(h.app)
      .post('/v1/providers')
      .set(authed(token))
      .send({
        name: 'litellm',
        endpoint: 'https://api.ne1.dev/v1',
        defaultModels: ['my-photo-model', 'some-text-model'],
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('PUT stores the declaration, returns the summary, and leaves everything else alone', async () => {
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const id = await createdProvider(token, h);
      await request(h.app)
        .post(`/v1/providers/${id}/key`)
        .set(authed(token))
        .send({ key: 'sk-declare-route-123456' });

      const res = await request(h.app)
        .put(`/v1/providers/${id}`)
        .set(authed(token))
        .send({ visionModels: ['my-photo-model'] });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id,
        name: 'litellm',
        purpose: 'general',
        enabled: true,
        defaultModels: ['my-photo-model', 'some-text-model'],
        visionModels: ['my-photo-model'],
      });
      // The key is untouched and never echoed.
      expect(JSON.stringify(res.body)).not.toContain('sk-declare-route-123456');
      expect(JSON.stringify(res.body)).not.toContain('keyRef');
      await expect(h.keychain.get('partner', `provider:${id}`)).resolves.toBe(
        'sk-declare-route-123456',
      );
      // It survives a re-read (persisted, not just echoed).
      const listed = await request(h.app).get('/v1/providers').set(authed(token));
      const providers = (listed.body as { providers: Array<{ id: string; visionModels: string[] }> })
        .providers;
      expect(providers.find((p) => p.id === id)?.visionModels).toEqual(['my-photo-model']);
    } finally {
      h.close();
    }
  });

  it('PUT clears the declaration with an empty list', async () => {
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const id = await createdProvider(token, h);
      await request(h.app)
        .put(`/v1/providers/${id}`)
        .set(authed(token))
        .send({ visionModels: ['my-photo-model'] });
      const cleared = await request(h.app)
        .put(`/v1/providers/${id}`)
        .set(authed(token))
        .send({ visionModels: [] });
      expect(cleared.status).toBe(200);
      expect(cleared.body.visionModels).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('PUT is authed (401), refuses an unknown id (404) and a malformed body (400)', async () => {
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const id = await createdProvider(token, h);

      const anonymous = await request(h.app)
        .put(`/v1/providers/${id}`)
        .set({ Host: ALLOWED_HOST })
        .send({ visionModels: ['x'] });
      expect(anonymous.status).toBe(401);

      const missing = await request(h.app)
        .put('/v1/providers/does-not-exist')
        .set(authed(token))
        .send({ visionModels: ['x'] });
      expect(missing.status).toBe(404);

      for (const body of [
        { visionModels: 'my-photo-model' },
        { visionModels: [1, 2] },
        { purpose: 'hype' },
        { budgetCents: -5 },
        { name: '   ' },
      ]) {
        const bad = await request(h.app)
          .put(`/v1/providers/${id}`)
          .set(authed(token))
          .send(body);
        expect(bad.status, JSON.stringify(body)).toBe(400);
      }
      // No partial damage: the profile is exactly as created.
      expect(h.providerManager.get(id)).toMatchObject({
        name: 'litellm',
        purpose: 'general',
        budgetCents: null,
        visionModels: [],
      });
    } finally {
      h.close();
    }
  });

  it('the purpose bundle declares the models pinned to Vision', async () => {
    const upstream = await startModelsUpstreamForBundle(['my-photo-model', 'some-text-model']);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/providers/purposes')
        .set(authed(token))
        .send({
          endpoint: upstream.base,
          key: 'sk-bundle-secret-1234567890',
          purposes: ['vision', 'general'],
          modelPins: { vision: ['my-photo-model'], general: ['some-text-model'] },
        });
      expect(res.status).toBe(201);
      const created = (res.body as { created: Array<{ purpose: string; visionModels: string[] }> })
        .created;
      // The user pinned it FOR vision, which is the declaration.
      expect(created.find((p) => p.purpose === 'vision')?.visionModels).toEqual([
        'my-photo-model',
      ]);
      // A non-vision purpose declares nothing it cannot already see.
      expect(created.find((p) => p.purpose === 'general')?.visionModels).toEqual([]);
    } finally {
      await upstream.close();
      h.close();
    }
  });

  it('/v1/health states the inline image budget next to the upload cap', async () => {
    const h = demoHarness({ demo: false });
    try {
      const res = await request(h.app).get('/v1/health').set({ Host: ALLOWED_HOST });
      expect(res.status).toBe(200);
      // The composer must encode images to the SMALLER number; quoting only the
      // upload cap is what let a 4 MB photo "attach" and then never be sent.
      expect(res.body.maxInlineImageBytes).toBe(3 * 1024 * 1024);
      expect(res.body.maxUploadBytes).toBeGreaterThan(res.body.maxInlineImageBytes);
    } finally {
      h.close();
    }
  });
});
