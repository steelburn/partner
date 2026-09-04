/**
 * M3 chat persistence tests (PLAN-M3.md §"Tests"): POST /v1/chat over the
 * demoHarness DEMO stream (no providers).
 *
 *  - personaId -> auto conversation created (bound to the persona, title =
 *    first user message truncated to 60) + user turn + assistant turn (demo
 *    content, model, latency) persisted + trailing done_meta with ids.
 *  - second chat with the returned conversationId APPENDS (no new
 *    conversation) and derives the persona from the conversation.
 *  - paused persona -> 423 persona_paused (no rows created).
 *  - unknown personaId -> 404 (no rows created).
 *  - no personaId/conversationId -> byte-identical one-shot: no persistence,
 *    no done_meta, demo text unchanged.
 *  - audit rows carry ids/lengths, never content.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { ConversationMessage } from '@partner/shared';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

interface ParsedSse {
  type: string;
  [key: string]: unknown;
}

function parseSse(text: string): ParsedSse[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as ParsedSse);
}

const demoReply = (content: string): string => `demo: received ${content.length} characters`;

function messagesOf(h: Harness, conversationId: string): ConversationMessage[] {
  return h.conversations.get(conversationId).messages;
}

/** First delta text of the demo stream. */
function firstDelta(events: ParsedSse[]): string {
  const delta = events.find((e) => e.type === 'delta') as unknown as
    | { text: string }
    | undefined;
  expect(delta).toBeDefined();
  return (delta as { text: string }).text;
}

/** The trailing done_meta event (asserted present). */
function doneMeta(events: ParsedSse[]): { messageId: string; conversationId: string } {
  const meta = events.find((e) => e.type === 'done_meta') as unknown as
    | { messageId: string; conversationId: string }
    | undefined;
  expect(meta).toBeDefined();
  return meta as { messageId: string; conversationId: string };
}

describe('chat persistence with a persona (demo provider)', () => {
  it('auto-creates a conversation, persists the turn, and emits done_meta ids', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const content = 'how do neural nets work';
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content }], personaId: 'p-researcher' });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      const events = parseSse(res.text);
      expect(events.map((e) => e.type)).toEqual(['delta', 'usage', 'done', 'done_meta']);
      // Demo stream text is unchanged by persistence.
      expect(firstDelta(events)).toBe(demoReply(content));
      const meta = doneMeta(events);
      expect(meta.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(meta.conversationId).toMatch(/^[0-9a-f-]{36}$/);

      // One auto conversation bound to the persona, titled by the first user
      // message; both turns persisted.
      const list = h.conversations.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ personaId: 'p-researcher', title: content, messageCount: 2 });
      expect(list[0]?.id).toBe(meta.conversationId);

      const messages = messagesOf(h, meta.conversationId);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(messages[0]).toMatchObject({
        role: 'user',
        personaId: 'p-researcher',
        content,
        model: null,
        latencyMs: null,
      });
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        personaId: 'p-researcher',
        content: demoReply(content),
        model: 'demo',
      });
      expect(typeof messages[1]?.latencyMs).toBe('number');
      expect(messages[1]?.id).toBe(meta.messageId);
    } finally {
      h.close();
    }
  });

  it('a second chat with the returned conversationId appends (no new conversation)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const first = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'first turn' }], personaId: 'p-researcher' });
      const meta = doneMeta(parseSse(first.text));

      const second = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'second turn' }], conversationId: meta.conversationId });
      expect(second.status).toBe(200);
      const secondMeta = doneMeta(parseSse(second.text));
      expect(secondMeta.conversationId).toBe(meta.conversationId);

      // Same conversation, four messages in order — persona derived from the
      // conversation, so rows keep the persona id.
      expect(h.conversations.list()).toHaveLength(1);
      const messages = messagesOf(h, meta.conversationId);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(messages.map((m) => m.personaId)).toEqual([
        'p-researcher',
        'p-researcher',
        'p-researcher',
        'p-researcher',
      ]);
      expect(messages.map((m) => m.content)).toEqual([
        'first turn',
        demoReply('first turn'),
        'second turn',
        demoReply('second turn'),
      ]);
      expect(messages[2]?.content).toBe('second turn');
    } finally {
      h.close();
    }
  });

  it('paused persona -> 423 persona_paused and NOTHING is created', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      h.personas.pause('p-studio');
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'hi' }], personaId: 'p-studio' });
      expect(res.status).toBe(423);
      expect(res.body.error).toBe('persona_paused');
      expect(h.conversations.list()).toHaveLength(0);

      // Resume restores chatting (423 -> 200 and a fresh conversation).
      h.personas.resume('p-studio');
      const ok = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'hi again' }], personaId: 'p-studio' });
      expect(ok.status).toBe(200);
      expect(parseSse(ok.text).some((e) => e.type === 'done_meta')).toBe(true);
      expect(h.conversations.list()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('unknown personaId -> 404 and NOTHING is created', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'hi' }], personaId: 'p-ghost' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
      expect(h.conversations.list()).toHaveLength(0);
      expect(h.messageStore.listByConversation('x')).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('unknown conversationId -> 404 before any streaming or write', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'hi' }], conversationId: 'c-ghost' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
      expect(h.conversations.list()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('a paused persona reached via its conversation is refused too (423)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const first = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'under persona' }], personaId: 'p-scribe' });
      const meta = doneMeta(parseSse(first.text));
      h.personas.pause('p-scribe');
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: 'blocked' }], conversationId: meta.conversationId });
      expect(res.status).toBe(423);
      expect(res.body.error).toBe('persona_paused');
      expect(messagesOf(h, meta.conversationId)).toHaveLength(2); // nothing appended
    } finally {
      h.close();
    }
  });

  it('one-shot chat (no personaId/conversationId) is NOT persisted and has no done_meta', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const content = 'one shot';
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content }] });
      expect(res.status).toBe(200);
      const events = parseSse(res.text);
      expect(events.map((e) => e.type)).toEqual(['delta', 'usage', 'done']);
      expect(firstDelta(events)).toBe(demoReply(content));
      expect(res.text).not.toContain('done_meta');
      expect(h.conversations.list()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('auto conversation titles are truncated to 60 chars', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const long = 'x'.repeat(120);
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: long }], personaId: 'p-researcher' });
      expect(res.status).toBe(200);
      const meta = doneMeta(parseSse(res.text));
      const summary = h.conversations.get(meta.conversationId).summary;
      expect(summary.title?.length).toBe(60);
    } finally {
      h.close();
    }
  });

  it('persisted turns are retrievable over HTTP (conversation list + transcript)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const content = 'persist me';
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content }], personaId: 'p-default' });
      const meta = doneMeta(parseSse(res.text));

      const list = await request(h.app).get('/v1/conversations').set(authed(token));
      expect(list.status).toBe(200);
      expect(list.body.conversations[0]).toMatchObject({
        id: meta.conversationId,
        messageCount: 2,
        title: content,
      });

      const transcript = await request(h.app)
        .get(`/v1/conversations/${meta.conversationId}`)
        .set(authed(token));
      expect(transcript.status).toBe(200);
      const contents = transcript.body.messages.map((m: { content: string }) => m.content);
      expect(contents).toContain(content);
      expect(contents).toContain(demoReply(content));
    } finally {
      h.close();
    }
  });
});

describe('audit rows for chat persistence', () => {
  it('conversation.create/message.append carry ids + lengths, NEVER content', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const secret = 'needle-content-never-in-audit-xyz';
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ messages: [{ role: 'user', content: secret }], personaId: 'p-analyst' });
      expect(res.status).toBe(200);
      expect(parseSse(res.text).some((e) => e.type === 'done_meta')).toBe(true);

      const rows = h.audit.list(500);
      const actions = rows.map((r) => r.action);
      expect(actions).toContain('conversation.create');
      expect(actions).toContain('message.append');
      const blob = rows.map((r) => JSON.stringify(r)).join('\n');
      expect(blob).not.toContain(secret);
      expect(blob).not.toContain('demo: received');
      // Lengths are present in the (redacted) details objects.
      const appends = rows.filter((r) => r.action === 'message.append');
      expect(
        appends.map((r) => JSON.parse(r.details) as { contentLength: number }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ contentLength: secret.length }),
          expect.objectContaining({ contentLength: demoReply(secret).length }),
        ]),
      );
      const convRow = rows.find((r) => r.action === 'conversation.create');
      expect(JSON.parse(convRow?.details ?? '{}')).toMatchObject({ personaId: 'p-analyst' });
      // No token material anywhere.
      expect(blob).not.toContain(token);
    } finally {
      h.close();
    }
  });
});

describe('conversation persona rebind on per-message persona switch (review fix)', () => {
  it('a chat under a different persona in an existing conversation rebinds it', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      // Conversation bound to Analyst first.
      const first = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-analyst', messages: [{ role: 'user', content: 'from analyst' }] });
      const convId = doneMeta(parseSse(first.text)).conversationId;

      // Second turn under Builder in the SAME conversation -> conversation
      // follows its latest message persona.
      const second = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          conversationId: convId,
          personaId: 'p-builder',
          messages: [{ role: 'user', content: 'now builder' }],
        });
      expect(second.status).toBe(200);

      const detail = (
        await request(h.app).get(`/v1/conversations/${convId}`).set(authed(token))
      ).body as {
        conversation: { personaId: string | null };
        messages: Array<{ role: string; personaId: string | null }>;
      };
      expect(detail.conversation.personaId).toBe('p-builder');
      expect(detail.messages[detail.messages.length - 1]?.personaId).toBe('p-builder');
    } finally {
      h.close();
    }
  });
});
