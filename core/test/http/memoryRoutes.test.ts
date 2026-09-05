/**
 * M4 HTTP surface tests (PLAN-M4.md wire spec): every /v1/memory route is
 * authed (401); 501 not_configured when no memory bundle is wired; profile /
 * episode / search / forget / export / import happy paths and typed errors;
 * and the chat-time tailoring contract — a persona routed through a real
 * provider gets the confirmed-global profile prelude as the FIRST system
 * message of the upstream request, while demo and one-shot paths stay
 * byte-identical and the prelude is never persisted into the transcript.
 */
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { ChatEvent, ChatMessage } from '@partner/shared';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { startHttpServer, sseReply } from '../support/server.js';
import type { TestServer } from '../support/server.js';

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

function parseSse(text: string): Array<{ type: string; [key: string]: unknown }> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; [key: string]: unknown });
}

/** SSE text minus done_meta lines (ids are random per conversation) and
 *  timing noise — the demo provider reports real measured latencyMs, which
 *  varies 0/1ms between runs under parallel load and is not part of the
 *  memory-on-vs-off property under test. */
function withoutMeta(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && !line.includes('"type":"done_meta"'))
    .map((line) => line.replace(/"latencyMs":\d+/g, '"latencyMs":0'))
    .join('\n');
}

/** Fake OpenAI-compatible upstream that records every chat/completions body. */
function startChatUpstream(): Promise<{ server: TestServer; bodies: Array<{ model: string; messages: ChatMessage[] }> }> {
  const bodies: Array<{ model: string; messages: ChatMessage[] }> = [];
  return startHttpServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
      return;
    }
    if (path === '/chat/completions') {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(data) as { model?: unknown; messages?: unknown };
          bodies.push({
            model: typeof parsed.model === 'string' ? parsed.model : '',
            messages: Array.isArray(parsed.messages)
              ? (parsed.messages as ChatMessage[])
              : [],
          });
        } catch {
          // ignore malformed probe bodies
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sseReply(['honored '], { prompt: 3, completion: 2 }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }).then((server) => ({ server, bodies }));
}

const upstreams: Array<{ server: TestServer }> = [];

afterEach(async () => {
  await Promise.all(upstreams.splice(0).map((u) => u.server.close()));
});

describe('auth + wiring gates on the memory surface', () => {
  it('returns 401 without a token for every /v1/memory route', async () => {
    const h = demoHarness();
    try {
      const cases: Array<[string, string]> = [
        ['get', '/v1/memory/profile'],
        ['post', '/v1/memory/profile'],
        ['put', '/v1/memory/profile/x'],
        ['delete', '/v1/memory/profile/x'],
        ['get', '/v1/memory/episodes'],
        ['post', '/v1/memory/episodes/c-1'],
        ['delete', '/v1/memory/episodes/x'],
        ['get', '/v1/memory/search?q=hi'],
        ['post', '/v1/memory/forget'],
        ['get', '/v1/memory/export'],
        ['post', '/v1/memory/import'],
      ];
      for (const [method, path] of cases) {
        const res = await request(h.app)[method as 'get' | 'post' | 'put' | 'delete'](path)
          .set('Host', ALLOWED_HOST)
          .send({});
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    } finally {
      h.close();
    }
  });

  it('501s not_configured on every memory route when no bundle is wired', async () => {
    const h = demoHarness({ memory: false });
    try {
      const token = await pairToken(h);
      const cases: Array<[string, string]> = [
        ['get', '/v1/memory/profile'],
        ['post', '/v1/memory/profile'],
        ['get', '/v1/memory/episodes'],
        ['get', '/v1/memory/search?q=x'],
        ['get', '/v1/memory/export'],
        ['post', '/v1/memory/forget'],
      ];
      for (const [method, path] of cases) {
        const res = await request(h.app)[method as 'get' | 'post'](path).set(authed(token)).send({});
        expect(res.status, `${method} ${path}`).toBe(501);
        expect(res.body.error).toBe('not_configured');
      }
    } finally {
      h.close();
    }
  });
});

describe('profile routes', () => {
  it('POST adds (201, confirmed by default), GET lists, DELETE removes', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const created = await request(h.app)
        .post('/v1/memory/profile')
        .set(authed(token))
        .send({ kind: 'preference', value: 'prefers tldr summaries' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        kind: 'preference',
        value: 'prefers tldr summaries',
        status: 'confirmed',
        source: 'user',
        personaScope: null,
      });
      const id = created.body.id as string;

      const list = await request(h.app).get('/v1/memory/profile').set(authed(token));
      expect(list.status).toBe(200);
      expect(list.body.profile).toHaveLength(1);
      expect(list.body.profile[0].id).toBe(id);

      const del = await request(h.app).delete(`/v1/memory/profile/${id}`).set(authed(token));
      expect(del.status).toBe(204);
      const after = await request(h.app).get('/v1/memory/profile').set(authed(token));
      expect(after.body.profile).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('validation -> 400 invalid_input; unknown id -> 404', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const bad = await request(h.app)
        .post('/v1/memory/profile')
        .set(authed(token))
        .send({ kind: 'preference', value: '  ' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('invalid_input');

      const missing = await request(h.app)
        .delete('/v1/memory/profile/ghost')
        .set(authed(token));
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('not_found');
    } finally {
      h.close();
    }
  });

  it('PUT confirm/update round-trips; rejected hidden unless includeRejected', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const suggested = await request(h.app)
        .post('/v1/memory/profile')
        .set(authed(token))
        .send({
          kind: 'style',
          value: 'short replies',
          source: 'partner_suggestion',
          evidence: 'seen in last chats',
        });
      const id = (suggested.body as { id: string }).id;
      expect(suggested.body.status).toBe('suggested');

      const confirmed = await request(h.app)
        .put(`/v1/memory/profile/${id}`)
        .set(authed(token))
        .send({ status: 'confirmed', value: 'short, warm replies' });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toMatchObject({ status: 'confirmed', value: 'short, warm replies' });

      // reject then list: gone by default, present with includeRejected.
      await request(h.app)
        .put(`/v1/memory/profile/${id}`)
        .set(authed(token))
        .send({ status: 'rejected' });
      const plain = await request(h.app).get('/v1/memory/profile').set(authed(token));
      expect(plain.body.profile).toHaveLength(0);
      const all = await request(h.app)
        .get('/v1/memory/profile?includeRejected=1')
        .set(authed(token));
      expect(all.body.profile).toHaveLength(1);

      const badStatus = await request(h.app)
        .put(`/v1/memory/profile/${id}`)
        .set(authed(token))
        .send({ status: 'maybe' });
      expect(badStatus.status).toBe(400);
    } finally {
      h.close();
    }
  });
});

describe('episode routes', () => {
  async function seedConversation(h: Harness, content: string): Promise<string> {
    const conv = h.conversations.create({ personaId: 'p-scribe' });
    h.conversations.append(conv.id, 'user', { content });
    return conv.id;
  }

  it('POST summarize writes the demo placeholder (201); resummarize updates (200); GET lists', async () => {
    const h = demoHarness(); // demo: true -> placeholder summaries
    try {
      const token = await pairToken(h);
      const convId = await seedConversation(h, 'remember this chat');

      const created = await request(h.app)
        .post(`/v1/memory/episodes/${convId}`)
        .set(authed(token));
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        conversationId: convId,
        personaId: 'p-scribe',
        title: 'remember this chat',
        summary: 'Demo summary of 1 messages: remember this chat',
        model: null,
      });
      const episodeId = created.body.id as string;

      const updated = await request(h.app)
        .post(`/v1/memory/episodes/${convId}`)
        .set(authed(token));
      expect(updated.status).toBe(200); // updated in place, not duplicated
      expect(updated.body.id).toBe(episodeId);

      const list = await request(h.app).get('/v1/memory/episodes').set(authed(token));
      expect(list.status).toBe(200);
      expect(list.body.episodes).toHaveLength(1);
      expect(list.body.episodes[0].id).toBe(episodeId);
    } finally {
      h.close();
    }
  });

  it('unknown conversation -> 404; DELETE episode -> 204 (conversation kept)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const ghost = await request(h.app)
        .post('/v1/memory/episodes/c-ghost')
        .set(authed(token));
      expect(ghost.status).toBe(404);
      expect(ghost.body.error).toBe('not_found');

      const convId = await seedConversation(h, 'delete me later');
      const created = await request(h.app)
        .post(`/v1/memory/episodes/${convId}`)
        .set(authed(token));
      const episodeId = (created.body as { id: string }).id;

      const del = await request(h.app)
        .delete(`/v1/memory/episodes/${episodeId}`)
        .set(authed(token));
      expect(del.status).toBe(204);
      expect(h.conversations.get(convId).summary.id).toBe(convId); // untouched

      const missing = await request(h.app)
        .delete('/v1/memory/episodes/ghost')
        .set(authed(token));
      expect(missing.status).toBe(404);
    } finally {
      h.close();
    }
  });
});

describe('search + forget + export/import routes', () => {
  it('search finds profile text added over HTTP; empty q -> 400', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      await request(h.app)
        .post('/v1/memory/profile')
        .set(authed(token))
        .send({ kind: 'preference', value: 'loves karaoke on tuesdays' });

      const hit = await request(h.app)
        .get('/v1/memory/search?q=karaoke')
        .set(authed(token));
      expect(hit.status).toBe(200);
      expect(hit.body.hits).toHaveLength(1);
      expect(hit.body.hits[0]).toMatchObject({
        kind: 'profile',
        snippet: 'loves karaoke on tuesdays',
      });

      for (const q of ['', undefined]) {
        const path = q === undefined ? '/v1/memory/search' : '/v1/memory/search?q=';
        const bad = await request(h.app).get(path).set(authed(token));
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe('invalid_input');
      }
    } finally {
      h.close();
    }
  });

  it('forget entry/all over HTTP with typed errors', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const add = await request(h.app)
        .post('/v1/memory/profile')
        .set(authed(token))
        .send({ kind: 'rule', value: 'route-forget-topic' });
      const id = (add.body as { id: string }).id;

      const gone = await request(h.app)
        .post('/v1/memory/forget')
        .set(authed(token))
        .send({ what: 'entry', id });
      expect(gone.status).toBe(200);
      expect(gone.body.removed).toEqual({ entriesRemoved: 1, episodesRemoved: 0 });

      const unknown = await request(h.app)
        .post('/v1/memory/forget')
        .set(authed(token))
        .send({ what: 'entry', id: 'ghost' });
      expect(unknown.status).toBe(404);

      const bad = await request(h.app)
        .post('/v1/memory/forget')
        .set(authed(token))
        .send({ what: 'entry' });
      expect(bad.status).toBe(400);

      const wipe = await request(h.app)
        .post('/v1/memory/forget')
        .set(authed(token))
        .send({ what: 'all' });
      expect(wipe.status).toBe(200);
      expect(wipe.body.removed).toEqual({ entriesRemoved: 0, episodesRemoved: 0 });
    } finally {
      h.close();
    }
  });

  it('export returns the memory/v1 bundle; import round-trips with new ids; schema guard 400', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      await request(h.app)
        .post('/v1/memory/profile')
        .set(authed(token))
        .send({ kind: 'identity', value: 'export route fact' });

      const exported = await request(h.app).get('/v1/memory/export').set(authed(token));
      expect(exported.status).toBe(200);
      expect(exported.body).toMatchObject({ schema: 'memory/v1', exportedAt: expect.any(Number) });
      expect(exported.body.profile).toHaveLength(1);
      expect(exported.body.episodes).toEqual([]);

      const imported = await request(h.app)
        .post('/v1/memory/import')
        .set(authed(token))
        .send({ bundle: exported.body });
      expect(imported.status).toBe(200);
      expect(imported.body.imported).toEqual({ profile: 1, episodes: 0 });

      // Additive: two rows now, distinct ids.
      const after = await request(h.app).get('/v1/memory/profile').set(authed(token));
      expect(after.body.profile).toHaveLength(2);
      expect(new Set(after.body.profile.map((e: { id: string }) => e.id)).size).toBe(2);

      const badSchema = await request(h.app)
        .post('/v1/memory/import')
        .set(authed(token))
        .send({ bundle: { schema: 'memory/v9', profile: [], episodes: [] } });
      expect(badSchema.status).toBe(400);
      expect(badSchema.body.error).toBe('invalid_input');
    } finally {
      h.close();
    }
  });

  it('no memory content ever lands in audit rows from the HTTP surface', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const secret = 'route-secret-never-in-audit-zzz';
      const add = await request(h.app)
        .post('/v1/memory/profile')
        .set(authed(token))
        .send({ kind: 'identity', value: secret, evidence: 'ev', source: 'partner_suggestion' });
      const id = (add.body as { id: string }).id;
      await request(h.app).put(`/v1/memory/profile/${id}`).set(authed(token)).send({ status: 'confirmed' });
      await request(h.app).get('/v1/memory/export').set(authed(token));
      await request(h.app).post('/v1/memory/forget').set(authed(token)).send({ what: 'entry', id });

      const rows = h.audit.list(500);
      const actions = rows.map((r) => r.action);
      expect(actions).toContain('profile.add');
      expect(actions).toContain('profile.update');
      expect(actions).toContain('memory.export');
      expect(actions).toContain('memory.forget');
      const blob = rows.map((r) => JSON.stringify(r)).join('\n');
      expect(blob).not.toContain(secret);
      expect(blob).not.toContain('Demo summary');
    } finally {
      h.close();
    }
  });
});

describe('chat-time tailoring over the wire', () => {
  it('persona + provider: the first upstream message is the profile prelude', async () => {
    const upstream = await startChatUpstream();
    upstreams.push(upstream);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      h.profile?.add({
        kind: 'preference',
        value: 'always start with a tldr',
        evidence: 'in 6 of 10 asks',
      });
      const provider = await h.providerManager.create({
        name: 'tailor-upstream',
        endpoint: upstream.server.base,
        defaultModels: ['gpt-4o'],
      });
      await h.providerManager.setKey(provider.id, 'sk-fake-tailor-key-12345678');

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-researcher', model: 'gpt-4o', messages: [{ role: 'user', content: 'help me write' }] });
      expect(chat.status).toBe(200);
      const events = parseSse(chat.text);
      expect(events.map((e) => e.type)).toEqual(['delta', 'usage', 'done', 'done_meta']);

      expect(upstream.bodies).toHaveLength(1);
      const sent = upstream.bodies[0];
      const researcher = h.personas.get('p-researcher');
      // M4 order: profile prelude first, then the persona identity system
      // prompt (M3 multi-turn fix), then the client's user message.
      expect(sent?.messages[0]).toEqual({
        role: 'system',
        content:
          '<Partner profile you should honor>\n- preference: always start with a tldr (evidence: in 6 of 10 asks)',
      });
      expect(sent?.messages[1]).toEqual({
        role: 'system',
        content: researcher?.character.systemPrompt,
      });
      expect(sent?.messages[2]).toEqual({ role: 'user', content: 'help me write' });

      // The prelude is NOT persisted: only user + assistant turns exist.
      const meta = events.find((e) => e.type === 'done_meta') as
        | { conversationId: string }
        | undefined;
      expect(meta).toBeDefined();
      const transcript = h.conversations.get((meta as { conversationId: string }).conversationId)
        .messages;
      expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(transcript.every((m) => m.content !== sent?.messages[0]?.content)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('no prelude when no confirmed GLOBAL entries exist (suggested/scoped only)', async () => {
    const upstream = await startChatUpstream();
    upstreams.push(upstream);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      h.profile?.add({ kind: 'preference', value: 'suggested only', source: 'partner_suggestion' });
      h.profile?.add({ kind: 'identity', value: 'scribe scoped', personaScope: 'p-scribe' });
      const provider = await h.providerManager.create({
        name: 'u2',
        endpoint: upstream.server.base,
        defaultModels: ['gpt-4o'],
      });
      await h.providerManager.setKey(provider.id, 'sk-fake-key-00000000');

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-researcher', model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
      expect(chat.status).toBe(200);
      const sent = upstream.bodies[0];
      const researcher = h.personas.get('p-researcher');
      // No prelude (no confirmed GLOBAL entries): the persona identity
      // system prompt leads, then the client's own user message.
      expect(sent?.messages[0]).toEqual({
        role: 'system',
        content: researcher?.character.systemPrompt,
      });
      expect(sent?.messages[1]).toEqual({ role: 'user', content: 'hi' });
    } finally {
      h.close();
    }
  });

  it('one-shot chat through a provider never injects (no persona)', async () => {
    const upstream = await startChatUpstream();
    upstreams.push(upstream);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      h.profile?.add({ kind: 'preference', value: 'global fact present' });
      const provider = await h.providerManager.create({
        name: 'u3',
        endpoint: upstream.server.base,
        defaultModels: ['gpt-4o'],
      });
      await h.providerManager.setKey(provider.id, 'sk-fake-key-11111111');

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'one shot' }] });
      expect(chat.status).toBe(200);
      const sent = upstream.bodies[0];
      expect(sent?.messages[0]).toEqual({ role: 'user', content: 'one shot' });
      // No persistence events either.
      expect(chat.text).not.toContain('done_meta');
    } finally {
      h.close();
    }
  });

  it('demo persona chat is byte-identical with and without a memory bundle', async () => {
    const withMemory = demoHarness(); // demo on, memory on
    const withoutMemory = demoHarness({ memory: false }); // demo on, memory off
    try {
      const content = 'same bytes please';
      const body = { personaId: 'p-researcher', messages: [{ role: 'user', content }] };
      const tokenA = await pairToken(withMemory);
      const tokenB = await pairToken(withoutMemory);
      const resA = await request(withMemory.app).post('/v1/chat').set(authed(tokenA)).send(body);
      const resB = await request(withoutMemory.app).post('/v1/chat').set(authed(tokenB)).send(body);
      expect(resA.status).toBe(200);
      // done_meta ids are random UUIDs; every OTHER SSE byte must match.
      expect(withoutMeta(resA.text)).toBe(withoutMeta(resB.text));
      expect(resA.text).not.toContain('<Partner profile you should honor>');
    } finally {
      withMemory.close();
      withoutMemory.close();
    }
  });

  it('tailoring survives the demo/one-shot byte check: no prelude on the demo path even with a persona + entries', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      h.profile?.add({ kind: 'preference', value: 'profile bytes never in demo' });
      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-researcher', messages: [{ role: 'user', content: 'hi' }] });
      expect(chat.status).toBe(200);
      expect(chat.text).toContain('demo: received');
      expect(chat.text).not.toContain('<Partner profile you should honor>');
      expect(chat.text).not.toContain('profile bytes never in demo');
    } finally {
      h.close();
    }
  });
});
