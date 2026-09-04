/**
 * M1 cross-cutting e2e over a spawned demo core (PLAN-M1.md exit criteria):
 * provider CRUD with keys landing only in the (fake) keychain, plus the
 * integrated llm-self-service import running against the BUILT-IN demo
 * double — fully offline, no external servers, no real credentials
 * (review-fixed: DEMO_MODE must not hit the real enter.ne1.dev).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = `${here}..`;
const corePort = 40_000 + (process.pid % 10_000);

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

async function encryptWithPem(pem: string, password: string): Promise<string> {
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
    new TextEncoder().encode(password),
  );
  return Buffer.from(enc).toString('base64');
}

describe('M1 e2e: providers + offline llm-self-service import', () => {
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
      body: JSON.stringify({ name: 'manual-echo', endpoint: `http://127.0.0.1:1/v1` }),
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

    const listText = await (await authed('/v1/providers')).text();
    expect(listText).not.toContain('sk-manual-1234567890');
    expect(listText).toContain('manual-echo');

    expect((await authed(`/v1/providers/${provider.id}`, { method: 'DELETE' })).status).toBe(204);
    const empty = await authed('/v1/providers');
    expect(((await empty.json()) as { providers: unknown[] }).providers).toEqual([]);
  });

  it('rejects a plaintext password in self-service connect', async () => {
    const res = await authed('/v1/self-service/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://enter.ne1.dev',
        email: 'demo@example.com',
        password: 'not-allowed',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('full offline import via the built-in demo double (no external server)', async () => {
    const endpoint = 'https://enter.ne1.dev'; // would be the real portal if NOT demo

    const keyRes = await authed('/v1/self-service/login-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    expect(keyRes.status).toBe(200);
    const pem = ((await keyRes.json()) as { publicKeyPem: string }).publicKeyPem;

    // Wrong (too short) credentials -> identical generic 401, no enumeration.
    const bad = await authed('/v1/self-service/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint,
        email: 'demo@example.com',
        passwordCipher: await encryptWithPem(pem, 'x'),
      }),
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { message?: string }).message).toBe('Invalid email or password');

    const ok = await authed('/v1/self-service/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint,
        email: 'demo@example.com',
        passwordCipher: await encryptWithPem(pem, 'demo-pass-123'),
      }),
    });
    expect(ok.status).toBe(201);
    const provider = (await ok.json()) as {
      id: string;
      source: string;
      name: string;
      endpoint: string;
    };
    expect(provider.source).toBe('llm-self-service');
    expect(provider.name).toBe('llm-self-service (org)');
    expect(provider.endpoint).toBe(`http://127.0.0.1:${corePort}/v1`);
    expect(JSON.stringify(provider)).not.toContain('sk-demo-import');

    // List never leaks the key.
    const listText = await (await authed('/v1/providers')).text();
    expect(listText).toContain('llm-self-service (org)');
    expect(listText).not.toContain('sk-demo-import');

    // Chat still works offline: demo ignores llm-self-service-sourced
    // providers as a chat backend (their endpoint is this core itself).
    const chat = await authed('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello partner' }] }),
    });
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain('demo: received');
  });
});
