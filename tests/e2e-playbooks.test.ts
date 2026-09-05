/**
 * M9 cross-cutting e2e over a spawned demo core (PLAN-M9.md exit): run a
 * text playbook end-to-end over the real SSE wire (loop_step / delta /
 * done_meta) with the conversation persisted AND the save-as-note shortcut
 * landing a note; then create a deploy profile and package it under a
 * granted project root so the bundle files exist on disk. Exercises the
 * actual core <-> web contract seam — the layer where the M9 SSE/route
 * drift (done_meta, resume path, note body field) used to hide behind
 * green unit suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = `${here}..`;
const corePort = 40_500 + (process.pid % 5_000);

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

/** Parse the SSE body into typed wire frames (same shape as the web client). */
async function sseFrames(text: string): Promise<Array<Record<string, unknown>>> {
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>);
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

describe('M9 e2e: playbook runs + deploy package over the wire', () => {
  it('runs a text playbook into a conversation with note:true -> done_meta + note', async () => {
    // A fresh conversation to persist the run transcript into.
    const created = await authed('/v1/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personaId: 'p-scribe' }),
    });
    expect(created.status).toBe(201);
    const conversation = (await created.json()) as { id: string };
    expect(conversation.id.length).toBeGreaterThan(0);

    const run = await authed('/v1/playbooks/docgen/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        personaId: 'p-scribe',
        conversationId: conversation.id,
        inputs: { prompt: 'e2e release notes' },
        note: true,
      }),
    });
    expect(run.status).toBe(200);
    const frames = await sseFrames(await run.text());
    const types = frames.map((f) => f.type);
    expect(types).toContain('loop_step');
    expect(types).toContain('delta');
    // The spec terminal frame — the frame the web client renders the end on.
    expect(types[types.length - 1]).toBe('done_meta');
    expect(types.some((t) => t === 'run_start' || t === 'run_end')).toBe(false);
    const meta = frames[frames.length - 1] as {
      status: string;
      noteId: string | null;
      noteTitle: string | null;
      conversationId: string | null;
      pendingId: string | null;
    };
    expect(meta.status).toBe('done');
    expect(meta.pendingId).toBeNull();
    expect(meta.conversationId).toBe(conversation.id);
    expect(meta.noteId).not.toBeNull();
    expect(meta.noteTitle).toBe('Docgen');

    // The transcript persisted (user + assistant turns)…
    const conv = await authed(`/v1/conversations/${conversation.id}`);
    expect(conv.status).toBe(200);
    const detail = (await conv.json()) as {
      conversation: { messageCount: number };
      messages: Array<{ role: string }>;
    };
    expect(detail.conversation.messageCount).toBe(2);
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    // …and the save-as-note shortcut landed a real note.
    const notesRes = await authed('/v1/notes');
    expect(notesRes.status).toBe(200);
    const notes = (await notesRes.json()) as { notes: Array<{ id: string; title: string }> };
    const saved = notes.notes.find((n) => n.id === meta.noteId);
    expect(saved).toBeDefined();
    expect(saved?.title).toBe('Docgen');
  });

  it('packages a deploy profile under a granted project root -> files on disk', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'partner-e2e-proj-'));
    const outDir = join(projectDir, 'dist');

    // The package action only runs under a granted root.
    const rootRes = await authed('/v1/roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'e2e-project', path: projectDir, readOnly: false }),
    });
    expect(rootRes.status).toBe(201);

    const profileRes = await authed('/v1/deploy-profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-ship', host: 'app.example.org' }),
    });
    expect(profileRes.status).toBe(201);
    const profile = (await profileRes.json()) as { id: string };

    const pkg = await authed(`/v1/deploy-profiles/${profile.id}/package`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectDir, outDir }),
    });
    expect(pkg.status).toBe(200);
    const result = (await pkg.json()) as { files: string[]; outDir: string };
    expect(result.outDir).toBe(outDir);
    expect(result.files).toHaveLength(4);
    for (const file of result.files) {
      expect(existsSync(file), file).toBe(true);
    }

    // A path outside every granted root is refused.
    const escape = mkdtempSync(join(tmpdir(), 'partner-e2e-escape-'));
    const refused = await authed(`/v1/deploy-profiles/${profile.id}/package`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectDir, outDir: join(escape, 'x') }),
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe('invalid_input');
  });
});
