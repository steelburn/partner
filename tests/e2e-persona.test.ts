/**
 * M3 cross-cutting e2e over a spawned demo core (PLAN-M3.md exit): seeded
 * personas exist; chatting under a persona auto-creates and PERSISTS a
 * conversation (messages retrievable, done_meta carries ids); pausing the
 * persona refuses chat with 423; resuming restores it; the no-persona
 * one-shot path stays unpaginated demo behaviour.
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

describe('M3 e2e: personas, conversations, persistence', () => {
  it('seeds starter personas with a single default', async () => {
    const res = await authed('/v1/personas');
    expect(res.status).toBe(200);
    const { personas } = (await res.json()) as {
      personas: Array<{ name: string; isDefault: boolean; paused: boolean }>;
    };
    expect(personas.length).toBeGreaterThanOrEqual(8);
    expect(personas.filter((p) => p.isDefault).length).toBe(1);
  });

  it('chats under a persona: auto conversation + persisted turns + done_meta', async () => {
    const personas = ((await (await authed('/v1/personas')).json()) as {
      personas: Array<{ id: string; name: string; independence: { level: string } }>;
    }).personas;
    const builder = personas.find((p) => p.name === 'Builder') as { id: string };

    const chat = await authed('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        personaId: builder.id,
        messages: [{ role: 'user', content: 'hello builder' }],
      }),
    });
    expect(chat.status).toBe(200);
    const text = await chat.text();
    expect(text).toContain('demo: received');
    expect(text).toContain('done_meta');
    const meta = (JSON.parse(
      text
        .split('\n\n')
        .map((b) => b.trim())
        .filter((b) => b.startsWith('data: '))
        .map((b) => b.slice(6))
        .find((b) => b.includes('"done_meta"')) as string,
    )) as { type: string; conversationId: string; messageId: string };
    expect(meta.type).toBe('done_meta');
    expect(meta.conversationId.length).toBeGreaterThan(0);

    // The conversation exists with both turns persisted.
    const conv = await authed(`/v1/conversations/${meta.conversationId}`);
    expect(conv.status).toBe(200);
    const detail = (await conv.json()) as {
      conversation: { personaId: string; messageCount: number };
      messages: Array<{ role: string; content: string; id: string }>;
    };
    expect(detail.conversation.personaId).toBe(builder.id);
    expect(detail.conversation.messageCount).toBe(2);
    const roles = detail.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant']);
    expect(detail.messages[0]?.content).toBe('hello builder');
    expect(detail.messages.find((m) => m.id === meta.messageId)?.role).toBe('assistant');

    // List shows it.
    const list = await authed('/v1/conversations');
    const summaries = ((await list.json()) as { conversations: Array<{ id: string }> }).conversations;
    expect(summaries.some((c) => c.id === meta.conversationId)).toBe(true);
  });

  it('paused persona refuses chat with 423; resume restores', async () => {
    const personas = ((await (await authed('/v1/personas')).json()) as {
      personas: Array<{ id: string; name: string; paused: boolean }>;
    }).personas;
    const analyst = personas.find((p) => p.name === 'Analyst') as { id: string };

    expect((await authed(`/v1/personas/${analyst.id}/pause`, { method: 'POST' })).status).toBeLessThan(
      300,
    );

    const refused = await authed('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personaId: analyst.id, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(refused.status).toBe(423);

    expect(
      (await authed(`/v1/personas/${analyst.id}/resume`, { method: 'POST' })).status,
    ).toBeLessThan(300);

    const ok = await authed('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personaId: analyst.id, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(ok.status).toBe(200);
  });

  it('one-shot chat without persona/conversation stays non-persistent demo behaviour', async () => {
    const chat = await authed('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'plain hello' }] }),
    });
    const text = await chat.text();
    expect(text).toContain('demo: received');
    expect(text).not.toContain('done_meta');
  });
});
