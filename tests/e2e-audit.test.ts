/**
 * M10 audit surface e2e over a spawned demo core (PLAN-M10 W4): after a
 * chat round the redacted audit log lists chat.stream rows (ids/counts
 * only — never the message content), and the actor/action filters narrow
 * the result set over the wire.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = `${here}..`;
const corePort = 41_000 + (process.pid % 5_000);

let core: ChildProcess;
let base: string;
let token = '';
let coreOut = '';

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
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
    const code = ((await (await fetch(`${base}/v1/dev/pair-code`)).json()) as { code: string })
      .code;
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
}, 30_000);

afterAll(async () => {
  core?.kill('SIGTERM');
});

describe('M10 e2e: audit log over the wire', () => {
  it('records chat turns redacted and filters by action + search', async () => {
    const secretMarker = 'needle-that-must-never-reach-audit';
    const chat = await authed('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        personaId: 'p-researcher',
        messages: [{ role: 'user', content: `hello audit ${secretMarker}` }],
      }),
    });
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain('demo: received');

    const all = await authed('/v1/audit?limit=100');
    expect(all.status).toBe(200);
    const entries = ((await all.json()) as { entries: Array<{ action: string; details: string }> })
      .entries;
    const chatRows = entries.filter((e) => e.action === 'chat.stream');
    expect(chatRows.length).toBeGreaterThanOrEqual(1);
    // Content never crosses (structural + redaction guarantees).
    for (const row of chatRows) {
      expect(JSON.stringify(row)).not.toContain(secretMarker);
    }

    const filtered = await authed('/v1/audit?action=chat');
    const filteredEntries = ((await filtered.json()) as {
      entries: Array<{ action: string }>;
    }).entries;
    expect(filteredEntries.length).toBeGreaterThanOrEqual(1);
    expect(filteredEntries.every((e) => e.action.includes('chat'))).toBe(true);

    const byActor = await authed('/v1/audit?actor=session');
    const actorEntries = ((await byActor.json()) as { entries: Array<{ actor: string }> })
      .entries;
    expect(actorEntries.every((e) => e.actor === 'session')).toBe(true);
  });
});
