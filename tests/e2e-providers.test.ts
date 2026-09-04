/**
 * M1 cross-cutting e2e over a spawned demo core (PLAN-M1.md exit criteria):
 * provider CRUD with keys landing only in the (fake) keychain, plus the
 * integrated llm-self-service import against a LOCAL fake implementing the
 * S0 contract (login-key -> envelope session -> me/key). No real network:
 * the fake only ever answers loopback calls.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import {
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  constants,
} from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = `${here}..`;
const corePort = 40_000 + (process.pid % 10_000);

// ---------------------------------------------------------------------------
// Fake llm-self-service (S0 contract: /api/login-key, /api/session,
// /api/me/key) with a real RSA-OAEP envelope.
// ---------------------------------------------------------------------------

const EMAIL = 'jane@org.com';
const PASSWORD = 'secret-pw';
let fakePort = 0;
let fakeServer: http.Server;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw === '' ? {} : JSON.parse(raw);
  } catch {
    return { __malformed: true };
  }
}

function startFakeSelfService(): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fakeServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/login-key' && req.method === 'GET') {
      json(res, 200, { publicKeyPem: publicKey });
      return;
    }
    if (url.pathname === '/api/session' && req.method === 'POST') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const cipher = typeof body.passwordCipher === 'string' ? body.passwordCipher : '';
      let password = '';
      try {
        password = privateDecrypt(
          { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          Buffer.from(cipher, 'base64'),
        ).toString('utf8');
      } catch {
        password = '';
      }
      if (typeof body.email !== 'string' || password !== PASSWORD) {
        json(res, 401, { error: 'Invalid email or password' });
        return;
      }
      res.writeHead(201, {
        'content-type': 'application/json',
        'set-cookie': ['session=e2e-fake; Path=/; HttpOnly'],
      });
      res.end(JSON.stringify({ email: body.email, name: 'Jane Doe', outcome: 'retrieved' }));
      return;
    }
    if (url.pathname === '/api/me/key' && req.method === 'GET') {
      if (!(req.headers.cookie ?? '').includes('session=e2e-fake')) {
        json(res, 401, { error: 'Not authenticated' });
        return;
      }
      json(res, 200, {
        email: EMAIL,
        proxyBaseUrl: `http://127.0.0.1:${fakePort}`,
        endpoint: `http://127.0.0.1:${fakePort}/v1`,
        key: 'sk-e2e-import',
        expiresAt: null,
      });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });

  return new Promise((resolve, reject) => {
    fakeServer.once('error', reject);
    fakeServer.listen(0, '127.0.0.1', () => {
      fakePort = (fakeServer.address() as AddressInfo).port;
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Core spawn + helpers (mirrors tests/e2e-demo.test.ts).
// ---------------------------------------------------------------------------

interface CoreUnderTest {
  child: ChildProcess;
  base: string;
  stdoutBuf: string;
  stderrBuf: string;
}

let core: CoreUnderTest;
let pairToken = '';

async function waitForHealth(base: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`);
      if (res.ok) return;
      lastError = new Error(`health status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`core never became healthy: ${String(lastError)}`);
}

beforeAll(async () => {
  await startFakeSelfService();
  core = {
    child: spawn(process.execPath, ['--import', 'tsx', 'core/src/index.ts'], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        PORT: String(corePort),
        DEMO_MODE: '1',
        DB_PATH: ':memory:',
        HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    base: `http://127.0.0.1:${corePort}`,
    stdoutBuf: '',
    stderrBuf: '',
  };
  core.child.stdout?.on('data', (chunk: Buffer) => {
    core.stdoutBuf += chunk.toString();
  });
  core.child.stderr?.on('data', (chunk: Buffer) => {
    core.stderrBuf += chunk.toString();
  });
  try {
    await waitForHealth(core.base);
    // Pair once for the whole suite.
    const codeRes = await fetch(`${core.base}/v1/dev/pair-code`);
    const code = ((await codeRes.json()) as { code: string }).code;
    const pairRes = await fetch(`${core.base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(pairRes.status).toBe(200);
    pairToken = ((await pairRes.json()) as { token: string }).token;
  } catch (err) {
    core.child.kill('SIGTERM');
    throw new Error(
      `core setup failed. stdout:\n${core.stdoutBuf}\nstderr:\n${core.stderrBuf}\n${String(err)}`,
    );
  }
}, 25_000);

afterAll(async () => {
  fakeServer?.close();
  if (core) {
    const exited = new Promise<void>((resolve) => {
      core.child.once('exit', () => resolve());
      setTimeout(() => resolve(), 5000).unref();
    });
    core.child.kill('SIGTERM');
    await exited;
  }
});

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${core.base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${pairToken}`, ...(init.headers ?? {}) },
  });
}

describe('M1 e2e: providers + llm-self-service import', () => {
  it('starts with no providers and refuses unauthenticated provider routes', async () => {
    const anon = await fetch(`${core.base}/v1/providers`);
    expect(anon.status).toBe(401);

    const res = await authed('/v1/providers');
    expect(res.status).toBe(200);
    expect((await res.json()) as { providers: unknown[] }).toEqual({ providers: [] });
  });

  it('manual provider CRUD: key lands only in the keychain, never in responses', async () => {
    const created = await authed('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'manual-echo',
        endpoint: `http://127.0.0.1:${fakePort}/v1`,
      }),
    });
    expect(created.status).toBe(201);
    const provider = (await created.json()) as { id: string; source: string; keyRef?: unknown };
    expect(provider.source).toBe('manual');
    expect(provider.keyRef).toBeUndefined();

    const keyed = await authed(`/v1/providers/${provider.id}/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-manual-1234567890' }),
    });
    expect(keyed.status).toBe(204);

    // No response ever carries the key.
    const list = await authed('/v1/providers');
    const listText = await list.text();
    expect(listText).not.toContain('sk-manual-1234567890');
    expect(listText).toContain('manual-echo');

    const deleted = await authed(`/v1/providers/${provider.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);

    const empty = await authed('/v1/providers');
    expect(((await empty.json()) as { providers: unknown[] }).providers).toEqual([]);
  });

  it('rejects a plaintext password in self-service connect', async () => {
    const res = await authed('/v1/self-service/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: `http://127.0.0.1:${fakePort}`,
        email: EMAIL,
        password: PASSWORD,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('full import: envelope login key -> in-page encryption -> connect -> provider', async () => {
    const base = `http://127.0.0.1:${fakePort}`;

    // 1. The core proxies the envelope public key (no CORS needed).
    const keyRes = await authed('/v1/self-service/login-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: base }),
    });
    expect(keyRes.status).toBe(200);
    const pem = ((await keyRes.json()) as { publicKeyPem: string }).publicKeyPem;
    expect(pem).toContain('BEGIN PUBLIC KEY');

    // 2. Encrypt the password exactly like the portal login page (WebCrypto
    //    path; node's global crypto.subtle mirrors the browser API).
    const der = Buffer.from(
      pem
        .replace('-----BEGIN PUBLIC KEY-----', '')
        .replace('-----END PUBLIC KEY-----', '')
        .replace(/\s+/g, ''),
      'base64',
    );
    const key = await globalThis.crypto.subtle.importKey(
      'spki',
      der,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    );
    const enc = await globalThis.crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      key,
      new TextEncoder().encode(PASSWORD),
    );
    const passwordCipher = Buffer.from(enc).toString('base64');

    // 3. Wrong credentials are rejected with a generic 401.
    const wrongKey = await globalThis.crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      key,
      new TextEncoder().encode('not-the-password'),
    );
    const bad = await authed('/v1/self-service/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: base,
        email: EMAIL,
        passwordCipher: Buffer.from(wrongKey).toString('base64'),
      }),
    });
    expect(bad.status).toBe(401);
    const badBody = (await bad.json()) as { error?: string; message?: string };
    expect(badBody.error).toBe('auth_failed');
    expect(badBody.message).toBe('Invalid email or password');

    // 4. Correct credentials create the provider (key to keychain, never back).
    const ok = await authed('/v1/self-service/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: base, email: EMAIL, passwordCipher }),
    });
    expect(ok.status).toBe(201);
    const provider = (await ok.json()) as {
      id: string;
      source: string;
      endpoint: string;
      name: string;
      keyRef?: unknown;
    };
    expect(provider.source).toBe('llm-self-service');
    expect(provider.name).toBe('llm-self-service (org)');
    expect(provider.endpoint).toBe(`${base}/v1`);
    expect(provider.keyRef).toBeUndefined();
    expect(JSON.stringify(provider)).not.toContain('sk-e2e-import');

    // 5. The list endpoint exposes the profile but never the key.
    const list = await authed('/v1/providers');
    const text = await list.text();
    expect(text).toContain('llm-self-service (org)');
    expect(text).not.toContain('sk-e2e-import');
  });
});
