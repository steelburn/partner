/**
 * M5 cross-cutting e2e over a spawned demo core (PLAN-M5.md exit): notes
 * with wiki-links + backlinks, the daily note, and a plan whose task
 * toggles update progress — all over the real loopback.
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

describe('M5 e2e: notes, wiki-links, daily, plans', () => {
  it('creates notes with a wiki-link and resolves backlinks', async () => {
    const link = await authed('/v1/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Meeting notes',
        content: 'Discussed roadmap with [[Architecture]].',
        tags: ['work'],
      }),
    });
    expect(link.status).toBe(201);

    // Dangling until the target exists, then resolvable.
    const other = await authed('/v1/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Architecture', content: 'The plan.' }),
    });
    expect(other.status).toBe(201);

    // Find the target note's id (list by title search) then fetch backlinks.
    const archId = ((await (await authed('/v1/notes')).json()) as {
      notes: Array<{ id: string; title: string }>;
    }).notes.find((n) => n.title === 'Architecture')?.id;
    expect(archId).toBeTruthy();
    const backlinks = ((await (await authed(`/v1/notes/${archId as string}/backlinks`)).json()) as {
      backlinks: Array<{ toTitle: string }>;
    }).backlinks;
    expect(backlinks.length).toBeGreaterThan(0);

    const tags = ((await (await authed('/v1/tags')).json()) as { tags: Array<{ tag: string }> })
      .tags;
    expect(tags.some((t) => t.tag === 'work')).toBe(true);
  });

  it('exposes a daily note and summarises it (placeholder in demo)', async () => {
    const daily = await authed('/v1/notes/daily');
    expect(daily.status).toBe(200);
    const note = (await daily.json()) as { isDaily: boolean; title: string };
    expect(note.isDaily).toBe(true);

    const summarize = await authed('/v1/notes/daily/summarize', { method: 'POST' });
    expect(summarize.status).toBe(200);
    const after = (await summarize.json()) as { content: string };
    expect(after.content.length).toBeGreaterThan(0);
  });

  it('plan tasks toggle and progress updates; export carries state', async () => {
    const created = await authed('/v1/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Partner alpha', description: 'Road to alpha.' }),
    });
    expect(created.status).toBe(201);
    const planId = ((await created.json()) as { id: string }).id;

    // Add two tasks via a document update.
    const updated = await authed(`/v1/plans/${planId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        document: {
          milestones: [
            {
              id: 'm1',
              title: 'Milestone 1',
              tasks: [
                { id: 't1', title: 'Wire providers', status: 'open' },
                { id: 't2', title: 'Ship extension', status: 'open' },
              ],
            },
          ],
        },
      }),
    });
    expect(updated.status).toBe(200);
    const plan = (await updated.json()) as { taskCount: number; doneCount: number };
    expect(plan.taskCount).toBe(2);
    expect(plan.doneCount).toBe(0);

    const toggle = await authed(`/v1/plans/${planId}/tasks/t1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(toggle.status).toBe(200);
    const after = (await toggle.json()) as { doneCount: number; document: { milestones: Array<{ tasks: Array<{ id: string; status: string }> }> } };
    expect(after.doneCount).toBe(1);
    expect(after.document.milestones[0]?.tasks.find((t) => t.id === 't1')?.status).toBe('done');

    const exported = await authed(`/v1/plans/${planId}/export`);
    expect(exported.status).toBe(200);
    const bundle = (await exported.json()) as { schema: string; plan: { title: string } };
    expect(bundle.schema).toBe('plan/v1');
    expect(bundle.plan.title).toBe('Partner alpha');
  });
});
