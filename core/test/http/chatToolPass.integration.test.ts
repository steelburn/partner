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

describe('M12 search approval flow (suggest persona → queue → decide)', () => {
  /** Fake Tavily POST backend + suggest-routed Default partner + directive
   *  upstream; returns a chat driver and backend hit counting. */
  async function setup(h: Harness, token: string): Promise<{
    chat: () => Promise<{ conversationId: string }>;
    hits: () => number;
    queries: () => string[];
  }> {
    const queries: string[] = [];
    let hits = 0;
    const backend = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c));
        req.on('end', () => {
          hits += 1;
          try {
            const body = JSON.parse(raw) as { query?: string };
            if (typeof body.query === 'string') queries.push(body.query);
          } catch {
            // ignore malformed
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              results: [{ title: 'hit', url: 'https://found.example', content: 'search snippet body' }],
            }),
          );
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
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
    search.updateConfig({ enabled: true, provider: 'tavily', endpoint: `http://127.0.0.1:${port}` });
    await search.setKey('sk-approval-flow-1234567890');

    // Default partner at SUGGEST (medium-risk external -> approval queue).
    const dp = h.personas.get('p-default');
    expect(dp).not.toBeNull();
    await request(h.app)
      .put(`/v1/personas/${dp?.id}`)
      .set(authed(token))
      .send({
        name: dp?.name,
        character: dp?.character,
        model: dp?.model,
        independence: { level: 'suggest', requireHumanFor: ['high'], autoScopes: [] },
        memory: dp?.memory,
        isDefault: dp?.isDefault,
      });

    const upstream = await startDirectiveUpstream(
      'Let me look that up.\n[[partner:tool search {"query":"ces approval flow"}]]',
    );
    servers.push(upstream);
    const provider = await h.providerManager.create({
      name: 'approval-upstream',
      endpoint: upstream.base,
      defaultModels: ['gpt-4o'],
    });
    await h.providerManager.setKey(provider.id, 'sk-approval-chat-12345678');

    const chat = async (): Promise<{ conversationId: string }> => {
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-default', messages: [{ role: 'user', content: 'search the web' }] });
      expect(res.status).toBe(200);
      const meta = /"done_meta".*?"conversationId":"([^"]+)"/.exec(res.text);
      expect(meta).not.toBeNull();
      return { conversationId: meta?.[1] ?? '' };
    };
    return { chat, hits: () => hits, queries: () => queries };
  }

  it('queues a search approval at suggest and approve executes it once into the conversation', async () => {
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const app = await setup(h, token);
      const { conversationId } = await app.chat();
      expect(conversationId).not.toBe('');

      // The turn queued an approval row, tagged with the persona.
      const list = await request(h.app).get('/v1/tools/pending').set(authed(token));
      expect(list.status).toBe(200);
      const row = (list.body.pending as Array<Record<string, unknown>>).find(
        (r) => r.toolId === 'search',
      );
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        toolId: 'search',
        risk: 'medium',
        requestedBy: 'persona',
        personaName: 'Default partner',
        // M12.6: chat-bound rows expose the conversation so the chat UI can
        // surface the approval for the ACTIVE conversation (and continue it).
        conversationId,
      });

      // Approve -> the backend runs exactly once and the result note lands.
      const pendingId = row?.id as string;
      const decided = await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(authed(token))
        .send({ decision: 'approve' });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ executed: true, grantId: null });
      expect(app.hits()).toBe(1);
      expect(app.queries()).toEqual(['ces approval flow']);

      const detail = h.conversations.get(conversationId);
      const note = detail.messages.find((m) => m.content.includes('[tool search result]'));
      expect(note).toBeDefined();
      expect(note?.content).toContain('found.example');
      expect(detail.messages.some((m) => m.content.includes('awaiting your approval'))).toBe(true);

      // Audit: the queue decision + the executed search, ids only.
      const audit = h.audit.query({ limit: 50 });
      expect(audit.some((r) => r.action === 'tool.approve' && r.details.includes('executed'))).toBe(true);
      expect(audit.some((r) => r.action === 'search.exec')).toBe(true);
      expect(audit.some((r) => r.action === 'chat.tool' && r.target === 'search' && r.details.includes('queued'))).toBe(true);
      // The query text never crosses audit.
      expect(JSON.stringify(audit)).not.toContain('ces approval flow');

      // Deciding twice is refused (row already closed -> 403 not_pending).
      const again = await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(authed(token))
        .send({ decision: 'approve' });
      expect(again.status).toBe(403);
    } finally {
      h.close();
    }
  });

  it('deny closes the row without running the backend and posts a denial note', async () => {
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const app = await setup(h, token);
      const { conversationId } = await app.chat();

      const list = await request(h.app).get('/v1/tools/pending').set(authed(token));
      const row = (list.body.pending as Array<Record<string, unknown>>).find(
        (r) => r.toolId === 'search',
      );
      expect(row).toBeDefined();
      const pendingId = row?.id as string;

      const decided = await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(authed(token))
        .send({ decision: 'deny' });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ executed: false, grantId: null });
      expect(app.hits()).toBe(0);

      const detail = h.conversations.get(conversationId);
      const denial = detail.messages.find((m) => m.content.includes('was denied'));
      expect(denial).toBeDefined();
      const audit = h.audit.query({ limit: 20, action: 'tool.deny' });
      expect(audit.some((r) => r.target === pendingId && r.details.includes('search'))).toBe(true);
    } finally {
      h.close();
    }
  });

  it('approving after the backend was disabled closes the row and notes the failure', async () => {
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const app = await setup(h, token);
      const { conversationId } = await app.chat();

      const list = await request(h.app).get('/v1/tools/pending').set(authed(token));
      const row = (list.body.pending as Array<Record<string, unknown>>).find(
        (r) => r.toolId === 'search',
      );
      expect(row).toBeDefined();
      const search = h.search as NonNullable<Harness['search']>;
      search.updateConfig({ enabled: false, provider: 'tavily', endpoint: null });

      const decided = await request(h.app)
        .post(`/v1/tools/pending/${row?.id as string}`)
        .set(authed(token))
        .send({ decision: 'approve' });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ executed: false, error: 'disabled' });
      expect(app.hits()).toBe(0);

      const detail = h.conversations.get(conversationId);
      expect(detail.messages.some((m) => m.content.includes('could not run (disabled)'))).toBe(true);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// M12.6 in-chat approvals → continuation (PLAN-M12 README pass): chat-bound
// queue rows expose their conversation, and a `continueTurn` chat request
// resumes the conversation WITHOUT a new user message so the assistant
// answers against the outcome note the decision just posted. The approval
// decision route stays the single execution point — the chat UI decides the
// row and then fires the continuation stream.
// ---------------------------------------------------------------------------

/** Upstream that answers each chat/completions request with the NEXT queued
 *  text block (first reply may carry a tool directive, later ones plain). */
function startStagedUpstream(
  replies: string[],
): Promise<{ server: http.Server; base: string; close(): Promise<void> }> {
  let index = 0;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
        return;
      }
      if (path === '/chat/completions') {
        const reply = replies[Math.min(index, replies.length - 1)] ?? '';
        index += 1;
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

describe('M12.6 chat approval continuation (decide in chat → continueTurn)', () => {
  /** Suggest-routed Default partner + enabled fake search backend + a
   *  staged persona upstream; returns drivers for one ask + one resume. */
  async function setup(
    h: Harness,
    token: string,
    staged: string[],
  ): Promise<{ ask: () => Promise<string>; resume: (conversationId: string) => Promise<{ status: number; text: string; body: Record<string, unknown> }>; hits: () => number; queries: () => string[] }> {
    const queries: string[] = [];
    let hits = 0;
    const backend = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c));
        req.on('end', () => {
          hits += 1;
          try {
            const body = JSON.parse(raw) as { query?: string };
            if (typeof body.query === 'string') queries.push(body.query);
          } catch {
            // ignore malformed
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              results: [{ title: 'hit', url: 'https://found.example', content: 'snippet body' }],
            }),
          );
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
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
    search.updateConfig({ enabled: true, provider: 'tavily', endpoint: `http://127.0.0.1:${port}` });
    await search.setKey('sk-continue-flow-1234567890');

    const dp = h.personas.get('p-default');
    expect(dp).not.toBeNull();
    await request(h.app)
      .put(`/v1/personas/${dp?.id}`)
      .set(authed(token))
      .send({
        name: dp?.name,
        character: dp?.character,
        model: dp?.model,
        independence: { level: 'suggest', requireHumanFor: ['high'], autoScopes: [] },
        memory: dp?.memory,
        isDefault: dp?.isDefault,
      });

    const upstream = await startStagedUpstream(staged);
    servers.push(upstream);
    const provider = await h.providerManager.create({
      name: 'continue-upstream',
      endpoint: upstream.base,
      defaultModels: ['gpt-4o'],
    });
    await h.providerManager.setKey(provider.id, 'sk-continue-chat-12345678');

    const ask = async (): Promise<string> => {
      const res = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ personaId: 'p-default', messages: [{ role: 'user', content: 'search the web' }] });
      expect(res.status).toBe(200);
      const meta = /"done_meta".*?"conversationId":"([^"]+)"/.exec(res.text);
      expect(meta).not.toBeNull();
      return meta?.[1] ?? '';
    };
    const resume = (conversationId: string): Promise<{ status: number; text: string; body: Record<string, unknown> }> =>
      request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ conversationId, continueTurn: true, messages: [] });
    return { ask, resume, hits: () => hits, queries: () => queries };
  }

  it('approve executes the search once; continueTurn streams the persona answer with no phantom user turn', async () => {
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const app = await setup(h, token, [
        'I will search the web.\n[[partner:tool search {"query":"continue after approval"}]]',
        'Here is what I found — https://found.example confirms the approval flow continues.',
      ]);
      const conversationId = await app.ask();
      expect(conversationId).not.toBe('');

      // The queued row is conversation-bound so the chat card can find it.
      const list = await request(h.app).get('/v1/tools/pending').set(authed(token));
      const row = (list.body.pending as Array<Record<string, unknown>>).find(
        (r) => r.toolId === 'search',
      );
      expect(row).toBeDefined();
      expect(row?.conversationId).toBe(conversationId);
      const pendingId = row?.id as string;

      const decided = await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(authed(token))
        .send({ decision: 'approve' });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ executed: true, grantId: null });
      expect(app.hits()).toBe(1);
      expect(app.queries()).toEqual(['continue after approval']);

      // Resume: the next persona round reads the posted result note and
      // answers WITHOUT the client fabricating a user message.
      const resumed = await app.resume(conversationId);
      expect(resumed.status).toBe(200);
      expect(resumed.text).toContain('Here is what I found');

      const detail = h.conversations.get(conversationId);
      const users = detail.messages.filter((m) => m.role === 'user');
      expect(users).toHaveLength(1);
      const assistants = detail.messages.filter((m) => m.role === 'assistant');
      expect(assistants).toHaveLength(2);
      expect(assistants[1]?.content).toContain('approval flow continues');
      expect(detail.messages.some((m) => m.content.includes('[tool search result]'))).toBe(true);
    } finally {
      h.close();
    }
  });

  it('deny closes the row without the backend and continueTurn still answers', async () => {
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const app = await setup(h, token, [
        'I would like to search.\n[[partner:tool search {"query":"deny me"}]]',
        'No search ran — I will continue without it.',
      ]);
      const conversationId = await app.ask();

      const list = await request(h.app).get('/v1/tools/pending').set(authed(token));
      const row = (list.body.pending as Array<Record<string, unknown>>).find(
        (r) => r.toolId === 'search',
      );
      expect(row).toBeDefined();
      const pendingId = row?.id as string;

      const decided = await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(authed(token))
        .send({ decision: 'deny' });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ executed: false, grantId: null });
      expect(app.hits()).toBe(0);

      const resumed = await app.resume(conversationId);
      expect(resumed.status).toBe(200);
      expect(resumed.text).toContain('No search ran');
      const detail = h.conversations.get(conversationId);
      expect(detail.messages.some((m) => m.content.includes('was denied'))).toBe(true);
      const assistants = detail.messages.filter((m) => m.role === 'assistant');
      expect(assistants).toHaveLength(2);
      expect(assistants[1]?.content).toContain('continue without it');
    } finally {
      h.close();
    }
  });

  it('rejects malformed continueTurn requests before any stream', async () => {
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      // No conversation to resume.
      const noConv = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ continueTurn: true, messages: [] });
      expect(noConv.status).toBe(400);
      expect(noConv.body.message).toContain('conversationId');
      // A resume round must not smuggle user messages.
      const withMessage = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ conversationId: 'conv-x', continueTurn: true, messages: [{ role: 'user', content: 'hi' }] });
      expect(withMessage.status).toBe(400);
      // noPersist has no conversation to resume into.
      const noPersist = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({ conversationId: 'conv-x', continueTurn: true, noPersist: true, messages: [] });
      expect(noPersist.status).toBe(400);
    } finally {
      h.close();
    }
  });
});
