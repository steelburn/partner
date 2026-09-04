/**
 * M4 cross-cutting e2e over a spawned demo core (PLAN-M4.md exit): add a
 * profile entry (confirmed), search finds it, export carries it, forget
 * removes it — all over the real loopback with a paired session.
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

describe('M4 e2e: memory lifecycle', () => {
  it('adds a confirmed profile entry, finds it via search, exports it, forgets it', async () => {
    const add = await authed('/v1/memory/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'preference',
        key: 'tldr-first',
        value: 'Prefers a TL;DR before details',
        source: 'user',
        status: 'confirmed',
      }),
    });
    expect(add.status).toBe(201);
    const entry = (await add.json()) as { id: string; value: string };
    expect(entry.value).toContain('TL;DR');

    const list = ((await (await authed('/v1/memory/profile')).json()) as {
      profile: Array<{ value: string }>;
    }).profile;
    expect(list.some((e) => e.value.includes('TL;DR'))).toBe(true);

    // Search finds it.
    const search = ((await (
      await authed('/v1/memory/search?q=TL;DR')
    ).json()) as { hits: Array<{ kind: string; snippet: string }> }).hits;
    expect(search.some((h) => h.kind === 'profile' && h.snippet.includes('TL;DR'))).toBe(true);

    // Export carries it (bundle-shaped JSON).
    const exportRes = await authed('/v1/memory/export');
    expect(exportRes.status).toBe(200);
    const bundle = (await exportRes.json()) as {
      schema: string;
      profile: Array<{ value: string }>;
    };
    expect(bundle.schema).toBe('memory/v1');
    expect(bundle.profile.some((p) => p.value.includes('TL;DR'))).toBe(true);

    // Forget that entry -> gone from list and search.
    const forget = await authed('/v1/memory/forget', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ what: 'entry', id: entry.id }),
    });
    expect(forget.status).toBe(200);

    const afterList = ((await (await authed('/v1/memory/profile')).json()) as {
      profile: Array<{ value: string }>;
    }).profile;
    expect(afterList.some((e) => e.value.includes('TL;DR'))).toBe(false);

    const afterSearch = ((await (
      await authed('/v1/memory/search?q=TL;DR')
    ).json()) as { hits: unknown[] }).hits;
    expect(afterSearch).toHaveLength(0);
  });
});
