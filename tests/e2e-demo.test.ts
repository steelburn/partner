/**
 * M0 cross-cutting e2e (PLAN-M0.md exit criteria): spawn the REAL core
 * process in demo mode, then prove the security spine over the loopback:
 * health -> demo pairing code -> single-use pair -> authed SSE chat ->
 * audit. Plus the Host-guard rejection over raw HTTP (fetch forbids Host
 * overrides). Child is always killed, even on assertion failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = `${here}..`;
const port = 4600 + (process.pid % 500);

interface CoreUnderTest {
  child: ChildProcess;
  base: string;
  stdoutBuf: string;
  stderrBuf: string;
}

let core: CoreUnderTest;
let coreExited = false;
let coreExitInfo = '';
let coreSpawnError = '';

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

/** Raw http.request — needed to send a foreign Host header (fetch forbids it). */
function rawRequest(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: Number(url.port), method, path: url.pathname, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function readSseText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

beforeAll(async () => {
  core = {
    child: spawn(
      process.execPath,
      ['--import', 'tsx', 'core/src/index.ts'],
      {
        cwd: root,
        // Deliberately minimal env: vitest sets NODE_OPTIONS/loader hooks in
        // the worker that would break a freshly spawned node process.
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          PORT: String(port),
          DEMO_MODE: '1',
          DB_PATH: ':memory:',
          HOST: '127.0.0.1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
    base: `http://127.0.0.1:${port}`,
    stdoutBuf: '',
    stderrBuf: '',
  };
  core.child.on('error', (err) => {
    coreSpawnError = err.message;
    process.stderr.write(`[core] spawn error: ${err.message}\n`);
  });
  core.child.on('exit', (code, signal) => {
    coreExited = true;
    coreExitInfo = `code=${code} signal=${signal}`;
    process.stderr.write(`[core] exited: ${coreExitInfo}\n`);
  });
  core.child.stdout?.on('data', (chunk: Buffer) => {
    core.stdoutBuf += chunk.toString();
    process.stdout.write(`[core] ${chunk}`);
  });
  core.child.stderr?.on('data', (chunk: Buffer) => {
    core.stderrBuf += chunk.toString();
    process.stderr.write(`[core] ${chunk}`);
  });
  try {
    await waitForHealth(core.base);
  } catch (err) {
    throw new Error(
      `core never became healthy (spawnError=${coreSpawnError || 'none'}, exited=${coreExitInfo || 'no'}).\n` +
        `--- stdout ---\n${core.stdoutBuf}\n--- stderr ---\n${core.stderrBuf}\n` +
        `cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}, 20_000);

afterAll(async () => {
  if (!core) return;
  const exited = new Promise<void>((resolve) => {
    core.child.once('exit', () => resolve());
    setTimeout(() => resolve(), 5000).unref();
  });
  core.child.kill('SIGTERM');
  await exited;
});

describe('M0 e2e over a spawned demo core', () => {
  it('reports health with the demo flag', async () => {
    const res = await fetch(`${core.base}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.demo).toBe(true);
  });

  it('rejects a foreign Host header before routing (403)', async () => {
    const res = await rawRequest(core.base, 'GET', '/v1/health', {
      Host: 'evil.example',
    });
    expect(res.status).toBe(403);
  });

  it('pairs with a demo code, then chats over SSE with the token', async () => {
    const codeRes = await fetch(`${core.base}/v1/dev/pair-code`);
    expect(codeRes.status).toBe(200);
    const code = ((await codeRes.json()) as { code: string }).code;
    expect(code).toMatch(/^\d{6}$/);

    const pairRes = await fetch(`${core.base}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(pairRes.status).toBe(200);
    const { token } = (await pairRes.json()) as { token: string };
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThanOrEqual(32);

    // Unauthenticated chat is refused.
    const anon = await fetch(`${core.base}/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(anon.status).toBe(401);

    // Authed SSE stream: delta -> usage -> done, JSON per `data:` line.
    const chat = await fetch(`${core.base}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello partner' }] }),
    });
    expect(chat.status).toBe(200);
    expect(chat.headers.get('content-type')).toContain('text/event-stream');

    const text = await readSseText(chat);
    const events = text
      .split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
    const types = events.map((e) => e.type);
    expect(types).toContain('delta');
    expect(types).toContain('usage');
    expect(types[types.length - 1]).toBe('done');
    expect((events.find((e) => e.type === 'delta') as Record<string, unknown>).text).toContain(
      'demo: received 13 characters',
    );

    // The same pairing code must not work twice (single-use).
    const reuse = await fetch(`${core.base}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(reuse.status).toBe(401);

    // Audit rows exist for the pairing + chat, without any token material.
    const audit = await fetch(`${core.base}/v1/audit`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(audit.status).toBe(200);
    const { entries } = (await audit.json()) as { entries: Array<{ action: string }> };
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('pair.verify');
    expect(actions).toContain('chat.stream');
  });
});
