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
import type { ChatEvent, ChatMessage } from '@partner/shared';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { sseReply } from '../support/server.js';

const PROVISIONED_KEY = 'sk-test-0123456789abcdef';

// ---------------------------------------------------------------------------
// Capturing upstream: /models + /chat/completions that records request BODIES
// ---------------------------------------------------------------------------

interface CapturedChat {
  body: { model: string; messages: ChatMessage[]; temperature?: number; stream: boolean };
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
    .map((line) => JSON.parse(line.slice(6)) as ChatEvent)
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
      expect(body1?.messages).toEqual([
        { role: 'system', content: analyst?.character.systemPrompt },
        { role: 'user', content: 'first turn' },
      ]);
      expect(body1?.temperature).toBe(0.2);

      // Turn 2 — same conversation, client sends ONLY the newest message.
      const second = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ conversationId: convId, messages: [{ role: 'user', content: 'second turn' }] });
      expect(second.status).toBe(200);
      expect(upstream.calls).toHaveLength(2);
      const body2 = upstream.calls[1]?.body;
      expect(body2?.messages).toEqual([
        { role: 'system', content: analyst?.character.systemPrompt },
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
      // Verbatim transcript + persona system prompt, NOT seeded from history.
      expect(body?.messages).toEqual([
        { role: 'system', content: scribe?.character.systemPrompt },
        ...transcript,
      ]);
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
