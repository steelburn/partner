/**
 * M3 multi-turn upstream context tests (regression for the fix that made
 * persisted conversations actually multi-turn over a real provider):
 *
 *  - POST /v1/chat with personaId sends the persona's character.systemPrompt
 *    as the first system message and its character.temperature to the
 *    upstream (/chat/completions request body).
 *  - a SECOND turn in the same conversation (client sends only the newest
 *    user message + conversationId) replays the persisted prior turns into
 *    the upstream request — the model can answer with context.
 *  - when the client supplies a full transcript (2+ messages) the upstream
 *    gets it verbatim: no double history replay.
 *  - one-shot chat (no persona/conversation) sends the body unchanged: no
 *    system prompt, no temperature.
 */
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatMessage } from '@partner/shared';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { sseReply } from '../support/server.js';

const PROVISIONED_KEY = 'sk-test-0123456789abcdef';

/** Loose SSE event shape — server events include done_meta, which is not a
 *  member of the shared ChatEvent union used by the streaming clients. */
interface AnyServerEvent {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Capturing upstream: /models + /chat/completions that records request BODIES
// ---------------------------------------------------------------------------

interface CapturedChat {
  body: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    stream: boolean;
    tools?: unknown[];
  };
}

function startCaptureUpstream(): Promise<{ base: string; calls: CapturedChat[]; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const calls: CapturedChat[] = [];
    const server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'llama-test' }] }));
        return;
      }
      if (path === '/chat/completions') {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          try {
            calls.push({ body: JSON.parse(raw) as CapturedChat['body'] });
          } catch {
            calls.push({ body: { model: '', messages: [], stream: false } });
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(sseReply(['ok '], { prompt: 10, completion: 10 }));
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        calls,
        close(): Promise<void> {
          return new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          });
        },
      });
    });
  });
}

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

function doneMeta(text: string): { messageId: string; conversationId: string } {
  const meta = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as AnyServerEvent)
    .find((e) => e.type === 'done_meta') as { messageId: string; conversationId: string } | undefined;
  expect(meta).toBeDefined();
  return meta as { messageId: string; conversationId: string };
}

async function registerProvider(h: Harness, token: string, base: string): Promise<string> {
  const created = await request(h.app)
    .post('/v1/providers')
    .set(authed(token))
    .send({ name: 'capture', endpoint: base, defaultModels: ['llama-test'], enabled: true });
  expect(created.status).toBe(201);
  const id = (created.body as { id: string }).id;
  await request(h.app).post(`/v1/providers/${id}/key`).set(authed(token)).send({ key: PROVISIONED_KEY });
  return id;
}

/** Route a persona to the capture provider + pin the chat model. */
async function routePersona(h: Harness, token: string, personaId: string, providerId: string): Promise<void> {
  const persona = h.personas.get(personaId);
  expect(persona).not.toBeNull();
  const res = await request(h.app)
    .put(`/v1/personas/${personaId}`)
    .set(authed(token))
    .send({
      name: persona?.name,
      character: persona?.character,
      model: {
        providerId,
        fallback: 'llama-test',
        taskClasses: { chat: 'llama-test' },
      },
      independence: persona?.independence,
      memory: persona?.memory,
      isDefault: persona?.isDefault,
    });
  expect(res.status).toBe(200);
}

describe('chat upstream context (multi-turn + persona identity)', () => {
  let upstream: Awaited<ReturnType<typeof startCaptureUpstream>> | null = null;

  afterEach(async () => {
    await upstream?.close();
    upstream = null;
  });

  it('sends persona systemPrompt + temperature and replays prior turns on the second message', async () => {
    upstream = await startCaptureUpstream();
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const providerId = await registerProvider(h, token, upstream.base);
      await routePersona(h, token, 'p-analyst', providerId);
      // p-analyst: temperature 0.2, seeded generic system prompt.
      const analyst = h.personas.get('p-analyst');
      expect(analyst?.character.temperature).toBe(0.2);

      // Turn 1 — upstream body = [system(persona), user].
      const first = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-analyst', messages: [{ role: 'user', content: 'first turn' }] });
      expect(first.status).toBe(200);
      const convId = doneMeta(first.text).conversationId;
      expect(upstream.calls).toHaveLength(1);
      const body1 = upstream.calls[0]?.body;
      const system1 = body1?.messages[0];
      expect(system1?.role).toBe('system');
      expect(typeof system1?.content).toBe('string');
      const content1 = String(system1?.content);
      // M11 C3: the persona identity prompt plus the structured-interaction
      // guidance (deterministic containers) ride the same system message.
      expect(content1).toContain(analyst?.character.systemPrompt ?? '');
      expect(content1).toContain(':::partner.choice');
      expect(body1?.messages.slice(1)).toEqual([{ role: 'user', content: 'first turn' }]);
      expect(body1?.temperature).toBe(0.2);

      // Turn 2 — same conversation, client sends ONLY the newest message.
      const second = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ conversationId: convId, messages: [{ role: 'user', content: 'second turn' }] });
      expect(second.status).toBe(200);
      expect(upstream.calls).toHaveLength(2);
      const body2 = upstream.calls[1]?.body;
      const system2 = body2?.messages[0];
      expect(system2?.role).toBe('system');
      expect(String(system2?.content)).toContain(analyst?.character.systemPrompt ?? '');
      expect(String(system2?.content)).toContain(':::partner.choice');
      expect(body2?.messages.slice(1)).toEqual([
        { role: 'user', content: 'first turn' },
        { role: 'assistant', content: 'ok ' }, // the capture upstream echo, persisted
        { role: 'user', content: 'second turn' },
      ]);
      expect(body2?.temperature).toBe(0.2);
    } finally {
      h.close();
    }
  });

  it('a client-supplied transcript is used verbatim (no double history)', async () => {
    upstream = await startCaptureUpstream();
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const providerId = await registerProvider(h, token, upstream.base);
      await routePersona(h, token, 'p-scribe', providerId);

      const transcript: ChatMessage[] = [
        { role: 'user', content: 'old q' },
        { role: 'assistant', content: 'old a' },
        { role: 'user', content: 'new q' },
      ];
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-scribe', conversationId: 'does-not-exist-yet', messages: transcript });
      // Unknown conversationId is refused BEFORE streaming (existing rule).
      expect(res.status).toBe(404);
      expect(upstream.calls).toHaveLength(0);

      // Now drive the same transcript into a real conversation.
      const first = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-scribe', messages: [{ role: 'user', content: 'seed' }] });
      const convId = doneMeta(first.text).conversationId;
      const turn = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-scribe', conversationId: convId, messages: transcript });
      expect(turn.status).toBe(200);
      const body = upstream.calls[1]?.body;
      const scribe = h.personas.get('p-scribe');
      // Verbatim transcript + persona system prompt (with the M11 C3
      // structured guidance suffix), NOT seeded from history.
      const system = body?.messages[0];
      expect(system?.role).toBe('system');
      expect(String(system?.content)).toContain(scribe?.character.systemPrompt ?? '');
      expect(String(system?.content)).toContain(':::partner.choice');
      expect(body?.messages.slice(1)).toEqual([...transcript]);
    } finally {
      h.close();
    }
  });

  it('one-shot chat (no persona) keeps the body byte-identical: no system, no temperature', async () => {
    upstream = await startCaptureUpstream();
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      await registerProvider(h, token, upstream.base);
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'plain' }] });
      expect(res.status).toBe(200);
      const body = upstream.calls[0]?.body;
      expect(body?.messages).toEqual([{ role: 'user', content: 'plain' }]);
      expect(body?.temperature).toBeUndefined();
      // No done_meta: not persisted.
      expect(res.text).not.toContain('done_meta');
    } finally {
      h.close();
    }
  });
});

describe('M12 capability declaration in the persona chat context', () => {
  let upstream: Awaited<ReturnType<typeof startCaptureUpstream>> | null = null;

  afterEach(async () => {
    await upstream?.close();
    upstream = null;
  });

  const setIndependence = async (h: Harness, token: string, personaId: string, level: string): Promise<void> => {
    const res = await request(h.app)
      .put(`/v1/personas/${personaId}`)
      .set(authed(token))
      .send({ independence: { level, requireHumanFor: ['high'], autoScopes: [] } });
    expect(res.status).toBe(200);
  };

  it('declares the level always; search grammar only when enabled AND the persona can run it', async () => {
    upstream = await startCaptureUpstream();
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const providerId = await registerProvider(h, token, upstream.base);
      await routePersona(h, token, 'p-builder', providerId);
      // p-builder seeds at auto; raise to autonomous (direct-executes
      // whatever the envelope grants).
      await setIndependence(h, token, 'p-builder', 'autonomous');

      const systemOf = async (personaId: string): Promise<string> => {
        const res = await request(h.app)
          .post('/v1/chat')
          .set(authed(token))
          .send({ personaId, messages: [{ role: 'user', content: 'ping' }] });
        expect(res.status).toBe(200);
        const body = upstream?.calls[upstream.calls.length - 1]?.body;
        return String(body?.messages[0]?.content ?? '');
      };

      // 1. Backend OFF (default-deny): the level IS declared, the tool is NOT.
      let system = await systemOf('p-builder');
      expect(system).toContain('Your independence level is autonomous');
      expect(system).not.toContain('[[partner:tool search');

      // 2. Backend ON: an autonomous persona is told the grammar.
      const search = h.search;
      expect(search).toBeDefined();
      search!.updateConfig({ enabled: true, provider: 'tavily' });
      await search!.setKey('sk-capability-test-12345678');
      system = await systemOf('p-builder');
      expect(system).toContain('Your independence level is autonomous');
      expect(system).toContain('Internet search is available to you');
      expect(system).toContain('[[partner:tool search {"query":"<what to look up>"}]]');

      // 3. Assist persona (p-default): level declared, tool NOT announced —
      // an assist persona can never execute tools (gate refuses always).
      await routePersona(h, token, 'p-default', providerId);
      const assistSystem = await systemOf('p-default');
      expect(assistSystem).toContain('Your independence level is assist');
      expect(assistSystem).not.toContain('partner:tool search');

      // 4. Suggest persona with the backend on: the APPROVAL grammar is
      // announced (medium-risk external -> every use queues an approval),
      // not the direct-run grammar.
      await setIndependence(h, token, 'p-default', 'suggest');
      const suggestSystem = await systemOf('p-default');
      expect(suggestSystem).toContain('Your independence level is suggest');
      expect(suggestSystem).toContain('[[partner:tool search {"query":"<what to look up>"}]]');
      expect(suggestSystem).toContain('approve each use');
      expect(suggestSystem).not.toContain('lets you run it');

      // 5. Banned at autonomous: no announcement even when the backend is on.
      const ban = await request(h.app)
        .put('/v1/personas/p-builder')
        .set(authed(token))
        .send({ policy: { tools: { banned: ['search'] } } });
      expect(ban.status).toBe(200);
      system = await systemOf('p-builder');
      expect(system).toContain('Your independence level is autonomous');
      expect(system).not.toContain('partner:tool search');
    } finally {
      h.close();
    }
  });

  it('advertises the native search function only to runnable personas (tools:true)', async () => {
    upstream = await startCaptureUpstream();
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const providerId = await registerProvider(h, token, upstream.base);
      const search = h.search;
      expect(search).toBeDefined();
      search!.updateConfig({ enabled: true, provider: 'tavily' });
      await search!.setKey('sk-capability-native-12345678');
      await routePersona(h, token, 'p-builder', providerId); // auto

      const advertised = async (): Promise<unknown[]> => {
        const res = await request(h.app)
          .post('/v1/chat')
          .set(authed(token))
          .send({ personaId: 'p-builder', messages: [{ role: 'user', content: 'ping' }], tools: true });
        expect(res.status).toBe(200);
        const body = upstream?.calls[upstream.calls.length - 1]?.body;
        return (body?.tools as unknown[] | undefined) ?? [];
      };
      const names = (tools: unknown[]): string[] =>
        tools.map((t) => (t as { function?: { name?: string } }).function?.name ?? '');

      // Enabled + auto persona: the search function is advertised.
      expect(names(await advertised())).toContain('search');

      // Banned persona: search is never advertised (files.* may still be).
      const ban = await request(h.app)
        .put('/v1/personas/p-builder')
        .set(authed(token))
        .send({ policy: { tools: { banned: ['search'] } } });
      expect(ban.status).toBe(200);
      expect(names(await advertised())).not.toContain('search');
    } finally {
      h.close();
    }
  });
});

describe('M13 per-turn provider pin (chat model picker)', () => {
  let upstreamA: Awaited<ReturnType<typeof startCaptureUpstream>> | null = null;
  let upstreamB: Awaited<ReturnType<typeof startCaptureUpstream>> | null = null;

  afterEach(async () => {
    await upstreamA?.close();
    await upstreamB?.close();
    upstreamA = null;
    upstreamB = null;
  });

  it('an explicit providerId + model rides that provider for one turn (persona pin ignored)', async () => {
    upstreamA = await startCaptureUpstream();
    upstreamB = await startCaptureUpstream();
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const idA = await registerProvider(h, token, upstreamA.base);
      const idB = await registerProvider(h, token, upstreamB.base);
      await routePersona(h, token, 'p-analyst', idA);

      // Persona-default turn goes to A.
      const plain = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-analyst', messages: [{ role: 'user', content: 'hi' }] });
      expect(plain.status).toBe(200);
      expect(upstreamA.calls).toHaveLength(1);

      // Explicit per-turn model switch: B serves gpt-4o-x for THIS turn.
      const switched = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          personaId: 'p-analyst',
          providerId: idB,
          model: 'gpt-4o-x',
          messages: [{ role: 'user', content: 'now on the other provider' }],
        });
      expect(switched.status).toBe(200);
      expect(upstreamA.calls).toHaveLength(1); // unchanged
      expect(upstreamB.calls).toHaveLength(1);
      expect(upstreamB.calls[0]?.body.model).toBe('gpt-4o-x');
    } finally {
      h.close();
    }
  });

  it('rejects an unknown (404) or disabled (400) explicit provider', async () => {
    upstreamA = await startCaptureUpstream();
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const idA = await registerProvider(h, token, upstreamA.base);
      const ghost = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ providerId: 'nope', model: 'x', messages: [{ role: 'user', content: 'hi' }] });
      expect(ghost.status).toBe(404);

      // A provider created disabled cannot be pinned (400 provider_disabled).
      const off = await request(h.app)
        .post('/v1/providers')
        .set(authed(token))
        .send({ name: 'offline', endpoint: upstreamA.base, defaultModels: ['x'], enabled: false });
      expect(off.status).toBe(201);
      const disabled = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ providerId: off.body.id, model: 'x', messages: [{ role: 'user', content: 'hi' }] });
      expect(disabled.status).toBe(400);
    } finally {
      h.close();
    }
  });
});
