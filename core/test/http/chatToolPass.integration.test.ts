/**
 * M11 F2 slice-1 END-TO-END integration (PLAN-M11.md): a real chat turn
 * against a fake upstream whose reply carries a [[partner:tool …]]
 * directive — the route's tool pass must gate it through the persona +
 * broker and persist the outcome as a system note (executed path with a real
 * grant; refused path for an assist persona).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { sseReply } from '../support/server.js';

const dirs: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

/** Upstream whose SSE carries NATIVE tool_call deltas (files.read). */
function startToolCallsUpstream(
  rootId: string,
): Promise<{ server: http.Server; base: string; close(): Promise<void> }> {
  const frames = [
    {
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'files.read', arguments: '' } }],
          },
        },
      ],
    },
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: `{"projectId":"${rootId}",` } }] } }],
    },
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"path":"a.txt"}' } }] } }],
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    },
  ];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
        return;
      }
      if (path === '/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          frames
            .map((f) => `data: ${JSON.stringify(f)}\n\n`)
            .concat(['data: [DONE]\n\n'])
            .join(''),
        );
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        close: async () => {
          server.closeAllConnections?.();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

/** Capture upstream that streams ONE assistant text block (the directive). */
function startDirectiveUpstream(
  reply: string,
): Promise<{ server: http.Server; base: string; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
        return;
      }
      if (path === '/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sseReply([reply], { prompt: 10, completion: 10 }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        close: async () => {
          server.closeAllConnections?.();
          await new Promise<void>((done) => server.close(() => done()));
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

function directiveReply(rootId: string): string {
  return `I can read it.\n[[partner:tool files.read ${JSON.stringify({ projectId: rootId, path: 'a.txt' })}]]`;
}

describe('M11 F2 chat tool pass (route integration)', () => {
  it('executes a granted read and persists the result as a system note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'partner-toolpass-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'a.txt'), 'alpha file contents');
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const broker = h.broker as NonNullable<Harness['broker']>;
      const root = broker.roots.add({ label: 'RootA', path: dir });
      broker.grants.add('files.read', root.id, {});
      const upstream = await startDirectiveUpstream(directiveReply(root.id));
      servers.push(upstream);
      const provider = await h.providerManager.create({
        name: 'tool-upstream',
        endpoint: upstream.base,
        defaultModels: ['gpt-4o'],
      });
      await h.providerManager.setKey(provider.id, 'sk-fake-tool-key-123456789');

      // Route p-analyst through 'suggest' so a granted low-risk read can
      // execute (seeded levels may be more restrictive).
      const analyst = h.personas.get('p-analyst');
      expect(analyst).not.toBeNull();
      await request(h.app)
        .put(`/v1/personas/${analyst?.id}`)
        .set(authed(token))
        .send({
          name: analyst?.name,
          character: analyst?.character,
          model: analyst?.model,
          independence: { level: 'suggest', requireHumanFor: ['high'], autoScopes: [] },
          memory: analyst?.memory,
          isDefault: analyst?.isDefault,
        });
      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-analyst', messages: [{ role: 'user', content: 'read a.txt' }] });
      expect(chat.status).toBe(200);

      const meta = /"done_meta".*?\"conversationId\":\"([^\"]+)\"/.exec(chat.text);
      const conversationId = meta?.[1] ?? '';
      expect(conversationId).not.toBe('');
      const detail = h.conversations.get(conversationId);
      const roles = detail.messages.map((m) => m.role);
      // user turn + assistant directive reply + the executed result note.
      expect(roles).toContain('user');
      expect(roles).toContain('assistant');
      const note = detail.messages.find((m) => m.content.includes('[tool files.read result]'));
      expect(note).toBeDefined();
      expect(note?.content).toContain('alpha file contents');

      const audit = h.audit.query({ limit: 20, action: 'chat.tool' });
      expect(audit.some((r) => r.target === 'files.read' && r.details.includes('executed'))).toBe(true);
    } finally {
      h.close();
    }
  });

  it('an assist persona refuses with a note and no execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'partner-toolpass-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'a.txt'), 'secret contents');
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const broker = h.broker as NonNullable<Harness['broker']>;
      const root = broker.roots.add({ label: 'RootB', path: dir });
      broker.grants.add('files.read', root.id, {});
      const upstream = await startDirectiveUpstream(directiveReply(root.id));
      servers.push(upstream);
      const provider = await h.providerManager.create({
        name: 'tool-upstream-2',
        endpoint: upstream.base,
        defaultModels: ['gpt-4o'],
      });
      await h.providerManager.setKey(provider.id, 'sk-fake-tool-key-22222222');

      // Force an assist (propose-only) persona — create one explicitly.
      const created = await request(h.app)
        .post('/v1/personas')
        .set(authed(token))
        .send({
          name: 'AssistBot',
          character: { voice: 'warm', language: 'en', systemPrompt: 'Be careful.', temperature: 0.5 },
          model: { taskClasses: {} },
          independence: { level: 'assist', requireHumanFor: ['high'], autoScopes: [] },
          memory: { userProfile: 'none', episodes: 'none' },
        });
      expect(created.status).toBe(201);
      const assistId = created.body.id as string;
      void root;

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: assistId, messages: [{ role: 'user', content: 'read a.txt' }] });
      expect(chat.status).toBe(200);
      const meta = /"done_meta".*?\"conversationId\":\"([^\"]+)\"/.exec(chat.text);
      const conversationId = meta?.[1] ?? '';
      const detail = h.conversations.get(conversationId);
      const note = detail.messages.find((m) => m.content.includes('was refused'));
      expect(note).toBeDefined();
      expect(note?.content).toContain('assist_level_no_tools');
      // Nothing executed — no result note, no file leak into the transcript.
      expect(detail.messages.some((m) => m.content.includes('secret contents'))).toBe(false);
    } finally {
      h.close();
    }
  });
});


describe('M11 F2 native tool calls (route)', () => {
  it('tools:true streams native calls to gate+broker and persists the result note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'partner-native-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'a.txt'), 'native file body');
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const broker = h.broker as NonNullable<Harness['broker']>;
      const root = broker.roots.add({ label: 'RootN', path: dir });
      broker.grants.add('files.read', root.id, {});
      const upstream = await startToolCallsUpstream(root.id);
      servers.push(upstream);
      const provider = await h.providerManager.create({
        name: 'native-upstream',
        endpoint: upstream.base,
        defaultModels: ['gpt-4o'],
      });
      await h.providerManager.setKey(provider.id, 'sk-fake-native-key-00000001');
      const analyst = h.personas.get('p-analyst');
      expect(analyst).not.toBeNull();
      await request(h.app)
        .put(`/v1/personas/${analyst?.id}`)
        .set(authed(token))
        .send({
          name: analyst?.name,
          character: analyst?.character,
          model: analyst?.model,
          independence: { level: 'suggest', requireHumanFor: ['high'], autoScopes: [] },
          memory: analyst?.memory,
          isDefault: analyst?.isDefault,
        });

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          personaId: 'p-analyst',
          tools: true,
          messages: [{ role: 'user', content: 'read a.txt natively' }],
        });
      expect(chat.status).toBe(200);
      // The client stream never carries the tool_calls machinery event.
      expect(chat.text).not.toContain('"tool_calls"');

      const meta = /"done_meta".*?"conversationId":"([^"]+)"/.exec(chat.text);
      const detail = h.conversations.get(meta?.[1] ?? '');
      const note = detail.messages.find((m) => m.content.includes('[tool files.read result]'));
      expect(note).toBeDefined();
      expect(note?.content).toContain('native file body');
      const audit = h.audit.query({ limit: 20, action: 'chat.tool' });
      expect(audit.some((r) => r.details.includes('executed'))).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe('M11 F2 chat search tool (route)', () => {
  it('executes a directive search through the enabled backend and persists the result note', async () => {
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      // Fake Tavily backend on loopback.
      const backend = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query?: string };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              results: [{ title: body.query ?? 'q', url: 'https://found.example', content: 'search snippet body' }],
            }),
          );
        });
      });
      await new Promise<void>((done) => backend.listen(0, '127.0.0.1', done));
      const { port } = backend.address() as AddressInfo;
      servers.push({
        close: async () => {
          backend.closeAllConnections?.();
          await new Promise<void>((r) => backend.close(() => r()));
        },
      });
      const search = h.search as NonNullable<Harness['search']>;
      search.updateConfig({ enabled: true, provider: 'tavily', endpoint: `http://127.0.0.1:${port}/search` });
      await search.setKey('sk-chat-search-1234567890');

      const upstream = await startDirectiveUpstream(
        'Let me look.\n[[partner:tool search {"query":"pizza recipes"}]]',
      );
      servers.push(upstream);
      const provider = await h.providerManager.create({
        name: 'search-upstream',
        endpoint: upstream.base,
        defaultModels: ['gpt-4o'],
      });
      await h.providerManager.setKey(provider.id, 'sk-fake-search-chat-12345678');

      const analyst = h.personas.get('p-analyst');
      await request(h.app)
        .put(`/v1/personas/${analyst?.id}`)
        .set(authed(token))
        .send({
          name: analyst?.name,
          character: analyst?.character,
          model: analyst?.model,
          independence: { level: 'auto', requireHumanFor: ['high'], autoScopes: [] },
          memory: analyst?.memory,
          isDefault: analyst?.isDefault,
        });

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-analyst', messages: [{ role: 'user', content: 'search the web' }] });
      expect(chat.status).toBe(200);
      const meta = /"done_meta".*?"conversationId":"([^"]+)"/.exec(chat.text);
      const detail = h.conversations.get(meta?.[1] ?? '');
      const note = detail.messages.find((m) => m.content.includes('[tool search result]'));
      expect(note).toBeDefined();
      expect(note?.content).toContain('found.example'); // snippet kept in the note
      const audit = h.audit.query({ limit: 20, action: 'chat.tool' });
      expect(audit.some((r) => r.target === 'search' && r.details.includes('executed'))).toBe(true);
    } finally {
      h.close();
    }
  });

  it('refuses the search directive when the backend is disabled (default-deny)', async () => {
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const upstream = await startDirectiveUpstream(
        'I would search.\n[[partner:tool search {"query":"anything"}]]',
      );
      servers.push(upstream);
      const provider = await h.providerManager.create({
        name: 'search-off-upstream',
        endpoint: upstream.base,
        defaultModels: ['gpt-4o'],
      });
      await h.providerManager.setKey(provider.id, 'sk-fake-search-off-12345678');
      const analyst = h.personas.get('p-analyst');
      await request(h.app)
        .put(`/v1/personas/${analyst?.id}`)
        .set(authed(token))
        .send({
          name: analyst?.name,
          character: analyst?.character,
          model: analyst?.model,
          independence: { level: 'auto', requireHumanFor: ['high'], autoScopes: [] },
          memory: analyst?.memory,
          isDefault: analyst?.isDefault,
        });

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-analyst', messages: [{ role: 'user', content: 'search the web' }] });
      expect(chat.status).toBe(200);
      const meta = /"done_meta".*?"conversationId":"([^"]+)"/.exec(chat.text);
      const detail = h.conversations.get(meta?.[1] ?? '');
      const note = detail.messages.find((m) => m.content.includes('is disabled'));
      expect(note).toBeDefined();
      expect(note?.content).toContain('enable it');
    } finally {
      h.close();
    }
  });
});
