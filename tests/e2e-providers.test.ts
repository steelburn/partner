/**
 * M1 cross-cutting e2e over a spawned demo core (PLAN-M1.md exit criteria):
 * provider CRUD against a real HTTP upstream, with keys landing only in the
 * (fake) keychain. No external servers, no real credentials. (The
 * llm-self-service demo-double import that used to live here was removed in
 * M22.)
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

describe('M1 e2e: providers (manual CRUD + keychain discipline)', () => {
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

});
