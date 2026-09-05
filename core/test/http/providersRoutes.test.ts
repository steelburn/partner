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

interface FakeSelfService {
  server: http.Server;
  base: string;
  publicKeyPem: string;
  provisionedKey: string;
  close(): Promise<void>;
}

function startFakeSelfService(creds: Record<string, string>, provisionedKey: string): Promise<FakeSelfService> {
  return new Promise((resolve, reject) => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const sessions = new Map<string, string>(); // token -> email

    function decrypt(b64: string): string | null {
      try {
        return privateDecrypt(
          { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          Buffer.from(b64, 'base64'),
        ).toString('utf8');
      } catch {
        return null;
      }
    }

    function readBody(req: http.IncomingMessage): Promise<string> {
      return new Promise((resolveBody) => {
        let data = '';
        req.on('data', (c: Buffer) => {
          data += c.toString('utf8');
        });
        req.on('end', () => resolveBody(data));
      });
    }

    const server = http.createServer(async (req, res) => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const url = new URL(req.url ?? '/', base);
      const json = (status: number, body: Record<string, unknown>): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (url.pathname === '/api/login-key' && req.method === 'GET') {
        json(200, { publicKeyPem: publicKey });
        return;
      }
      if (url.pathname === '/api/session' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          email?: unknown;
          passwordCipher?: unknown;
        };
        const email = typeof body.email === 'string' ? body.email : '';
        const password =
          typeof body.passwordCipher === 'string' ? decrypt(body.passwordCipher) : null;
        if (email === '' || password === null || creds[email] !== password) {
          // Identical shape for wrong-password AND unknown-user (no enumeration).
          json(401, { error: 'Invalid email or password' });
          return;
        }
        const token = randomBytes(16).toString('hex');
        sessions.set(token, email);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `partner_ss=${token}; HttpOnly; Path=/; SameSite=Lax`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === '/api/me/key' && req.method === 'GET') {
        const cookie = String(req.headers.cookie ?? '');
        const match = /partner_ss=([0-9a-f]+)/.exec(cookie);
        const email = match ? sessions.get(match[1] ?? '') : undefined;
        if (!email) {
          json(401, { error: 'Not authenticated' });
          return;
        }
        json(200, {
          email,
          proxyBaseUrl: base,
          endpoint: `${base}/v1`,
          key: provisionedKey,
          expiresAt: null,
        });
        return;
      }
      json(404, { error: 'not found' });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        publicKeyPem: publicKey,
        provisionedKey,
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

/** WebCrypto RSA-OAEP/SHA-256 envelope — byte-for-byte the portal's client. */
async function encryptPassword(publicKeyPem: string, password: string): Promise<string> {
  const der = Buffer.from(
    publicKeyPem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, ''),
    'base64',
  );
  const key = await crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    key,
    new TextEncoder().encode(password),
  );
  return Buffer.from(encrypted).toString('base64');
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
  return [PROVISIONED_KEY, 'sk-pasted-secret-777777', 'ciphertext-block', 's3cret-plaintext-pw'];
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
        ['post', '/v1/self-service/login-key'],
        ['post', '/v1/self-service/connect'],
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

describe('self-service import routes', () => {
  const GOOD_EMAIL = 'good@example.com';
  const GOOD_PASSWORD = 'correct horse battery';

  it('login-key proxies the fake PEM (authed)', async () => {
    const ss = await track(await startFakeSelfService({ [GOOD_EMAIL]: GOOD_PASSWORD }, PROVISIONED_KEY));
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/self-service/login-key')
        .set(authed(token))
        .send({ endpoint: ss.base });
      expect(res.status).toBe(200);
      expect(res.body.publicKeyPem).toBe(ss.publicKeyPem);

      const bad = await request(h.app)
        .post('/v1/self-service/login-key')
        .set(authed(token))
        .send({ endpoint: 'http://not-loopback.example' });
      expect(bad.status).toBe(400);

      const unreachable = await request(h.app)
        .post('/v1/self-service/login-key')
        .set(authed(token))
        .send({ endpoint: 'http://127.0.0.1:1' });
      expect([502, 504]).toContain(unreachable.status);
    } finally {
      h.close();
    }
  });

  it('connect happy path: envelope login -> provider (source llm-self-service) + key in keychain', async () => {
    const ss = await track(await startFakeSelfService({ [GOOD_EMAIL]: GOOD_PASSWORD }, PROVISIONED_KEY));
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const cipher = await encryptPassword(ss.publicKeyPem, GOOD_PASSWORD);
      expect(cipher.length).toBeGreaterThan(0);

      const connect = await request(h.app)
        .post('/v1/self-service/connect')
        .set(authed(token))
        .send({ endpoint: ss.base, email: GOOD_EMAIL, passwordCipher: cipher });
      expect(connect.status).toBe(201);
      const summary = connect.body as {
        id: string;
        name: string;
        source: string;
        endpoint: string;
        kind: string;
      };
      expect(summary).toMatchObject({
        name: 'llm-self-service (org)',
        source: 'llm-self-service',
        kind: 'openai-compatible',
        endpoint: `${ss.base}/v1`,
      });
      // The key went to the keychain, never into the response.
      await expect(h.keychain.get('partner', `provider:${summary.id}`)).resolves.toBe(PROVISIONED_KEY);
      const connectText = JSON.stringify(connect.body);
      expect(connectText).not.toContain(PROVISIONED_KEY);
      expect(connectText).not.toContain('keyRef');
      expect(connectText).not.toContain(cipher);

      // The provider shows up in the normal list without secrets.
      const list = await request(h.app).get('/v1/providers').set(authed(token));
      expect(JSON.stringify(list.body)).not.toContain(PROVISIONED_KEY);
      expect(JSON.stringify(list.body)).not.toContain('keyRef');

      // Audit rows: import + set_key + connect all present, none with secrets.
      const rows = h.audit.list(100);
      const actions = rows.map((r) => r.action);
      expect(actions).toContain('self_service.connect');
      expect(actions).toContain('provider.set_key');
      expect(actions).toContain('provider.create');
      const blob = rows.map((r) => JSON.stringify(r)).join('\n');
      expect(blob).not.toContain(PROVISIONED_KEY);
      expect(blob).not.toContain(cipher);
      expect(blob).not.toContain(GOOD_PASSWORD);
    } finally {
      h.close();
    }
  });

  it('rejects a plaintext password field with 400 (envelope only) and creates nothing', async () => {
    const ss = await track(await startFakeSelfService({ [GOOD_EMAIL]: GOOD_PASSWORD }, PROVISIONED_KEY));
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/self-service/connect')
        .set(authed(token))
        .send({ endpoint: ss.base, email: GOOD_EMAIL, password: GOOD_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('plaintext_password_rejected');
      expect(JSON.stringify(res.body)).not.toContain(GOOD_PASSWORD);
      expect(h.providerManager.list()).toHaveLength(0);
      const rows = h.audit.list(100).filter((r) => r.action === 'self_service.connect');
      expect(rows.some((r) => r.details.includes('plaintext_password'))).toBe(true);
      expect(rows.map((r) => JSON.stringify(r)).join('\n')).not.toContain(GOOD_PASSWORD);
    } finally {
      h.close();
    }
  });

  it('wrong password and unknown user both map to the SAME generic 401', async () => {
    const ss = await track(await startFakeSelfService({ [GOOD_EMAIL]: GOOD_PASSWORD }, PROVISIONED_KEY));
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);

      const wrongPw = await encryptPassword(ss.publicKeyPem, 'wrong password');
      const wrong = await request(h.app)
        .post('/v1/self-service/connect')
        .set(authed(token))
        .send({ endpoint: ss.base, email: GOOD_EMAIL, passwordCipher: wrongPw });
      expect(wrong.status).toBe(401);
      expect(wrong.body.message).toBe('Invalid email or password');

      const unknownPw = await encryptPassword(ss.publicKeyPem, GOOD_PASSWORD);
      const unknown = await request(h.app)
        .post('/v1/self-service/connect')
        .set(authed(token))
        .send({ endpoint: ss.base, email: 'nobody@example.com', passwordCipher: unknownPw });
      expect(unknown.status).toBe(401);
      // Identical wording — no enumeration of which failure happened.
      expect(unknown.body).toEqual(wrong.body);

      expect(h.providerManager.list()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
});

describe('end-to-end redaction regression', () => {
  it('a full import + chat + probe never leaks key/cipher/password into responses or audit', async () => {
    const upstream = await track(await startFakeUpstream());
    const ss = await track(
      await startFakeSelfService({ ['good@example.com']: 'horse-battery-staple' }, PROVISIONED_KEY),
    );
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const bodies: string[] = [];

      const cipher = await encryptPassword(ss.publicKeyPem, 'horse-battery-staple');
      const loginKey = await request(h.app)
        .post('/v1/self-service/login-key')
        .set(authed(token))
        .send({ endpoint: ss.base });
      bodies.push(loginKey.text);
      const connect = await request(h.app)
        .post('/v1/self-service/connect')
        .set(authed(token))
        .send({ endpoint: ss.base, email: 'good@example.com', passwordCipher: cipher });
      bodies.push(connect.text);
      const id = (connect.body as { id: string }).id;

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
      expect(all).not.toContain(cipher);
      expect(all).not.toContain('horse-battery-staple');
      expect(all).not.toContain('keyRef');

      const auditRows = h.audit.list(1000);
      const blob = auditRows.map((r) => JSON.stringify(r)).join('\n');
      expect(blob).not.toContain(PROVISIONED_KEY);
      expect(blob).not.toContain('sk-');
      expect(blob).not.toContain(cipher);
      expect(blob).not.toContain('horse-battery-staple');
      expect(blob).not.toContain('keyRef');
      const actions = auditRows.map((r) => r.action);
      expect(actions).toContain('self_service.connect');
      expect(actions).toContain('provider.test');
      expect(actions).toContain('chat.stream');
    } finally {
      h.close();
    }
  });
});

describe('demo double (offline llm-self-service import)', () => {
  // DEMO_MODE=1 must keep the import fully offline: the core serves the S0
  // double itself (no network, no credentials) — end of the review major.
  it('login-key + connect work in demo against the built-in double', async () => {
    const h = demoHarness(); // demo: true
    try {
      const token = await pairToken(h);
      const keyRes = await request(h.app)
        .post('/v1/self-service/login-key')
        .set(authed(token))
        .send({ endpoint: 'https://enter.ne1.dev' }); // would be real network if not demo
      expect(keyRes.status).toBe(200);
      const pem = keyRes.body.publicKeyPem as string;
      expect(pem).toContain('BEGIN PUBLIC KEY');

      const cipher = await encryptPassword(pem, 'demo-pass-123');
      const connect = await request(h.app)
        .post('/v1/self-service/connect')
        .set(authed(token))
        .send({ endpoint: 'https://enter.ne1.dev', email: 'demo@example.com', passwordCipher: cipher });
      expect(connect.status).toBe(201);
      const summary = connect.body as { source: string; endpoint: string; id: string };
      expect(summary.source).toBe('llm-self-service');
      expect(summary.endpoint).toBe('http://127.0.0.1:4390/v1');
      await expect(h.keychain.get('partner', `provider:${summary.id}`)).resolves.toBe('sk-demo-import');
      expect(JSON.stringify(connect.body)).not.toContain('sk-demo-import');

      // Wrong password -> identical generic 401 (no enumeration). The double
      // accepts any >=4-char password (demo semantics), so use a short one.
      const badCipher = await encryptPassword(pem, 'x');
      const bad = await request(h.app)
        .post('/v1/self-service/connect')
        .set(authed(token))
        .send({ endpoint: 'https://enter.ne1.dev', email: 'demo@example.com', passwordCipher: badCipher });
      expect(bad.status).toBe(401);
      expect(bad.body.message).toBe('Invalid email or password');

      // Chat still works offline in demo: the demo-imported provider is not
      // used as a chat backend (its endpoint is this core itself).
      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'hi' }] });
      expect(chat.status).toBe(200);
      expect(chat.text).toContain('demo: received');
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
