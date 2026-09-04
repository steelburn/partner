/**
 * M8 cross-cutting e2e over a spawned demo core (PLAN-M8.md exit): the
 * local catalog lists sample skills; installing hello-skill, invoking it
 * with args returns the echo; uninstalling removes it from the list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = `${here}..`;
const corePort = 40_000 + (process.pid % 10_000);

let core: ChildProcess;
let base: string;
let token = '';
let coreOut = '';

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('core never became healthy');
}

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

beforeAll(async () => {
  core = spawn(process.execPath, ['--import', 'tsx', 'core/src/index.ts'], {
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
  });
  core.stdout?.on('data', (d: Buffer) => {
    coreOut += d.toString();
  });
  core.stderr?.on('data', (d: Buffer) => {
    coreOut += d.toString();
  });
  base = `http://127.0.0.1:${corePort}`;
  try {
    await waitForHealth();
    const code = ((await (await fetch(`${base}/v1/dev/pair-code`)).json()) as { code: string }).code;
    const pair = await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(pair.status).toBe(200);
    token = ((await pair.json()) as { token: string }).token;
  } catch (err) {
    core.kill('SIGTERM');
    throw new Error(`core setup failed:\n${coreOut}\n${String(err)}`);
  }
}, 25_000);

afterAll(async () => {
  core?.kill('SIGTERM');
});

describe('M8 e2e: skills lifecycle', () => {
  it('lists the local catalog with sample skills', async () => {
    const catalog = ((await (await authed('/v1/skills/catalog')).json()) as {
      skills: Array<{ id: string }>;
    }).skills;
    const ids = catalog.map((s) => s.id);
    expect(ids).toContain('hello-skill');
    expect(ids).toContain('files-preview');
  });

  it('installs hello-skill, invokes it with args, then uninstalls it', async () => {
    const installed = await authed('/v1/skills/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalogId: 'hello-skill' }),
    });
    expect(installed.status).toBe(201);
    const skill = (await installed.json()) as { id: string; status: string };
    expect(skill.id).toBe('hello-skill');
    expect(skill.status).toBe('installed');

    const invoke = await authed('/v1/skills/hello-skill/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { name: 'e2e' } }),
    });
    expect(invoke.status).toBe(200);
    const body = (await invoke.json()) as { ok: boolean; result?: { hello?: string } };
    expect(body.ok).toBe(true);
    expect(body.result?.hello).toBe('from e2e');

    const removed = await authed('/v1/skills/hello-skill', { method: 'DELETE' });
    expect(removed.status).toBe(204);

    const after = ((await (await authed('/v1/skills')).json()) as {
      skills: Array<{ id: string }>;
    }).skills;
    expect(after.some((s) => s.id === 'hello-skill')).toBe(false);
  });
});
