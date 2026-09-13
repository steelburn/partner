/**
 * M20-B S4 capability ENFORCEMENT (PLAN-M20-B §S4, second half).
 *
 * `capabilities.ts` is the pure table; this file proves the table is actually
 * wired: each protected route group refuses a mobile session BY NAME, the
 * broker refuses an already-GRANTED mobile session (the envelope sits above the
 * grant — the whole point), refusals are audited with class + capability only
 * and move no state, and the read/chat/browser surface mobile may use keeps
 * working (so the guard is not a blanket deny).
 *
 * The class is minted directly on the session row (`sessions.create` takes a
 * clientClass); POST /v1/pair is untouched and still mints 'desktop'.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_HOST, demoHarness, makeTempRoot, removeTempRoot } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { tokenHash } from '../../src/http/session.js';
import type { Capability } from '../../src/http/capabilities.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

function tempDir(): string {
  const dir = makeTempRoot();
  dirs.push(dir);
  return dir;
}

/** The desktop session `/v1/pair` mints (untouched by this lane). */
async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

/** A session of a given client class, minted on the row (no pairing change). */
async function classToken(h: Harness, clientClass: string): Promise<string> {
  const created = await h.sessions.create({ kind: 'web', origin: ALLOWED_HOST, clientClass });
  return created.token;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

interface ProtectedRoute {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  body: Record<string, unknown>;
  capability: Capability;
}

/** One representative route per protected group (M20-B S4 capability map). */
function protectedRoutes(ctx: { dir: string; rootId: string }): ProtectedRoute[] {
  return [
    { method: 'post', path: '/v1/roots', body: { label: 'r', path: ctx.dir }, capability: 'roots' },
    { method: 'delete', path: `/v1/roots/${ctx.rootId}`, body: {}, capability: 'roots' },
    {
      method: 'post',
      path: '/v1/grants',
      body: { toolId: 'files.read', projectId: ctx.rootId },
      capability: 'grants',
    },
    { method: 'delete', path: '/v1/grants/x', body: {}, capability: 'grants' },
    {
      method: 'post',
      path: '/v1/proposals/x/apply',
      body: { projectId: ctx.rootId },
      capability: 'file.write',
    },
    { method: 'post', path: '/v1/deploy-profiles', body: { name: 'p' }, capability: 'deploy' },
    { method: 'delete', path: '/v1/deploy-profiles/x', body: {}, capability: 'deploy' },
    {
      method: 'post',
      path: '/v1/deploy-profiles/x/package',
      body: { projectDir: ctx.dir, outDir: join(ctx.dir, 'out') },
      capability: 'deploy',
    },
    {
      method: 'post',
      path: '/v1/skills/install',
      body: { catalogId: 'nope' },
      capability: 'skill.install',
    },
    { method: 'post', path: '/v1/skills/nope/enable', body: {}, capability: 'skill.install' },
    { method: 'post', path: '/v1/skills/nope/disable', body: {}, capability: 'skill.install' },
    { method: 'delete', path: '/v1/skills/nope', body: {}, capability: 'skill.install' },
    { method: 'post', path: '/v1/skills/nope/invoke', body: {}, capability: 'skill.invoke' },
    {
      method: 'post',
      path: '/v1/providers/x/key',
      body: { key: 'sk-test-not-a-real-key' },
      capability: 'provider.configure',
    },
    {
      method: 'put',
      path: '/v1/search/key',
      body: { key: 'sk-test-not-a-real-key' },
      capability: 'provider.configure',
    },
    {
      method: 'post',
      path: '/v1/playbooks/x/run',
      body: {},
      capability: 'persona.run',
    },
    {
      method: 'post',
      path: '/v1/personas/x/schedules/y/run-now',
      body: {},
      capability: 'persona.run',
    },
    {
      method: 'post',
      path: '/v1/mcp/servers/nope/call',
      body: { tool: 't' },
      capability: 'mcp.call',
    },
  ];
}

describe('the capability envelope is mounted per route group', () => {
  it('refuses mobile by name on every protected group and leaves them to desktop', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const dir = tempDir();
      const root = await request(h.app)
        .post('/v1/roots')
        .set(authed(desktop))
        .send({ label: 'r', path: dir });
      expect(root.status).toBe(201);
      const rootId = root.body.id as string;
      const mobile = await classToken(h, 'mobile');
      const routes = protectedRoutes({ dir, rootId });

      for (const route of routes) {
        const res = await request(h.app)[route.method](route.path)
          .set(authed(mobile))
          .send(route.body);
        const where = `${route.method} ${route.path}`;
        expect(res.status, where).toBe(403);
        expect(res.body, where).toMatchObject({
          error: 'capability_denied',
          reason: 'capability_denied',
          capability: route.capability,
          clientClass: 'mobile',
        });
      }

      // Desktop is not refused by the envelope: the bogus ids/params above
      // reach the handler's own validation and the broker instead.
      for (const route of routes) {
        const res = await request(h.app)[route.method](route.path)
          .set(authed(desktop))
          .send(route.body);
        const where = `${route.method} ${route.path}`;
        expect(res.body?.error, where).not.toBe('capability_denied');
        expect(res.body?.reason, where).not.toBe('capability_denied');
      }
    } finally {
      h.close();
    }
  });

  it('refuses the extension class (the least trusted client) on the same groups', async () => {
    const h = demoHarness();
    try {
      const ext = await classToken(h, 'extension');
      const dir = tempDir();

      const roots = await request(h.app)
        .post('/v1/roots')
        .set(authed(ext))
        .send({ label: 'r', path: dir });
      expect(roots.status).toBe(403);
      expect(roots.body).toMatchObject({ reason: 'capability_denied', capability: 'roots' });

      const call = await request(h.app)
        .post('/v1/mcp/servers/nope/call')
        .set(authed(ext))
        .send({ tool: 't' });
      expect(call.status).toBe(403);
      expect(call.body.capability).toBe('mcp.call');
    } finally {
      h.close();
    }
  });
});

describe('the broker envelope sits ABOVE the grant check', () => {
  it('refuses an already-granted mobile session, then lets the granting class through', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const dir = tempDir();
      writeFileSync(join(dir, 'notes.txt'), 'v1');
      const root = await request(h.app)
        .post('/v1/roots')
        .set(authed(desktop))
        .send({ label: 'r', path: dir });
      const rootId = root.body.id as string;
      const grant = await request(h.app)
        .post('/v1/grants')
        .set(authed(desktop))
        .send({ toolId: 'files.edit', projectId: rootId });
      expect(grant.status).toBe(201);
      expect(h.broker?.grants.hasGrant('files.edit', rootId)).toBe(true);

      const mobile = await classToken(h, 'mobile');
      const params = { projectId: rootId, path: 'notes.txt', proposedContent: 'v2' };
      const denied = await request(h.app)
        .post('/v1/tools/exec')
        .set(authed(mobile))
        .send({ tool: 'files.edit', params });
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ outcome: 'denied', reason: 'capability_denied' });

      // No state moved: no proposal, no approval row, file untouched, and the
      // grant the desktop session holds is still there (the guard denies, it
      // does not rewrite authorization).
      expect(h.proposalStore.listOpen()).toEqual([]);
      expect(h.pendingStore.listOpen()).toEqual([]);
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('v1');
      expect(h.broker?.grants.hasGrant('files.edit', rootId)).toBe(true);

      // The SAME tool + params + grant from the desktop session executes.
      const allowed = await request(h.app)
        .post('/v1/tools/exec')
        .set(authed(desktop))
        .send({ tool: 'files.edit', params });
      expect(allowed.status).toBe(200);
      expect(allowed.body.outcome).toBe('executed');
      expect(h.proposalStore.listOpen()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('maps every broker tool to the capability its class holds or lacks', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const dir = tempDir();
      writeFileSync(join(dir, 'a.txt'), 'hello');
      const root = await request(h.app)
        .post('/v1/roots')
        .set(authed(desktop))
        .send({ label: 'r', path: dir });
      const rootId = root.body.id as string;
      const mobile = await classToken(h, 'mobile');

      // No grants at all: a mobile READ tool therefore reaches the queue (the
      // envelope let it through and the grant gate answered), while every WRITE
      // tool is stopped by the envelope instead of being queued.
      const cases: Array<[string, Record<string, unknown>, 'file.read' | 'file.write']> = [
        ['files.list', { projectId: rootId, path: '.' }, 'file.read'],
        ['files.read', { projectId: rootId, path: 'a.txt' }, 'file.read'],
        ['files.search', { projectId: rootId, query: 'hello' }, 'file.read'],
        ['files.edit', { projectId: rootId, path: 'a.txt', proposedContent: 'x' }, 'file.write'],
        ['files.apply', { projectId: rootId, proposalId: 'x' }, 'file.write'],
        ['files.delete', { projectId: rootId, path: 'a.txt' }, 'file.write'],
      ];

      for (const [tool, params, capability] of cases) {
        const res = await request(h.app)
          .post('/v1/tools/exec')
          .set(authed(mobile))
          .send({ tool, params });
        const audited = h.audit
          .list(200)
          .find((row) => row.action === 'capability.denied' && row.target === tool);
        if (capability === 'file.read') {
          expect(res.status, tool).toBe(202);
          expect(res.body.outcome, tool).toBe('needs_approval');
          expect(audited, tool).toBeUndefined();
        } else {
          expect(res.status, tool).toBe(403);
          expect(res.body, tool).toMatchObject({ outcome: 'denied', reason: 'capability_denied' });
          expect(JSON.parse(audited?.details ?? '{}'), tool).toEqual({
            clientClass: 'mobile',
            capability: 'file.write',
          });
        }
      }

      // Only the three READ calls queued an approval; no write tool did.
      expect(h.pendingStore.listOpen().map((row) => row.toolId).sort()).toEqual([
        'files.list',
        'files.read',
        'files.search',
      ]);
      expect(h.proposalStore.listOpen()).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe('mobile keeps the surface its envelope allows', () => {
  it('still chats, reads files and manages browser scopes', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const dir = tempDir();
      writeFileSync(join(dir, 'readme.txt'), 'hello');
      const root = await request(h.app)
        .post('/v1/roots')
        .set(authed(desktop))
        .send({ label: 'r', path: dir });
      const rootId = root.body.id as string;
      for (const toolId of ['files.read', 'files.list']) {
        const grant = await request(h.app)
          .post('/v1/grants')
          .set(authed(desktop))
          .send({ toolId, projectId: rootId });
        expect(grant.status).toBe(201);
      }

      const mobile = await classToken(h, 'mobile');

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(mobile))
        .send({ messages: [{ role: 'user', content: 'hello there' }] });
      expect(chat.status).toBe(200);
      expect(chat.text).toContain('"type":"done"');

      const browse = await request(h.app)
        .get('/v1/files/browse')
        .set(authed(mobile))
        .query({ path: dir });
      expect(browse.status).toBe(200);

      const refs = await request(h.app)
        .get('/v1/files/refs')
        .set(authed(mobile))
        .query({ q: 'readme' });
      expect(refs.status).toBe(200);
      expect(refs.body.refs.map((ref: { path: string }) => ref.path)).toContain('readme.txt');

      // file.read through the BROKER too: the envelope is per-capability, not
      // a blanket refusal of a mobile session.
      const read = await request(h.app)
        .post('/v1/tools/exec')
        .set(authed(mobile))
        .send({ tool: 'files.read', params: { projectId: rootId, path: 'readme.txt' } });
      expect(read.status).toBe(200);
      expect(read.body.outcome).toBe('executed');

      const scope = await request(h.app)
        .put('/v1/browser/scopes/example.com')
        .set(authed(mobile))
        .send({ scope: 'ask' });
      expect(scope.status).toBe(200);
      expect(scope.body).toMatchObject({ origin: 'example.com', scope: 'ask' });
    } finally {
      h.close();
    }
  });
});

describe('refusal accounting', () => {
  it('audits class + capability only and changes no state', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const dir = tempDir();
      const root = await request(h.app)
        .post('/v1/roots')
        .set(authed(desktop))
        .send({ label: 'r', path: dir });
      const rootId = root.body.id as string;
      const mobile = await classToken(h, 'mobile');

      const secretLabel = 'label-that-must-not-be-audited';
      const routeDenial = await request(h.app)
        .post('/v1/roots')
        .set(authed(mobile))
        .send({ label: secretLabel, path: '/tmp/secret-path' });
      expect(routeDenial.status).toBe(403);

      const content = 'CONTENT-MUST-NOT-BE-AUDITED';
      const brokerDenial = await request(h.app)
        .post('/v1/tools/exec')
        .set(authed(mobile))
        .send({
          tool: 'files.edit',
          params: { projectId: rootId, path: 'x.txt', proposedContent: content },
        });
      expect(brokerDenial.status).toBe(403);

      const rows = h.audit.list(1000).filter((row) => row.action === 'capability.denied');
      expect(rows).toHaveLength(2);

      const routeRow = rows.find((row) => row.target === 'roots');
      const toolRow = rows.find((row) => row.target === 'files.edit');
      expect(routeRow?.actor).toBe('session');
      expect(JSON.parse(routeRow?.details ?? '{}')).toEqual({
        clientClass: 'mobile',
        capability: 'roots',
      });
      expect(toolRow?.actor).toBe('tool');
      expect(JSON.parse(toolRow?.details ?? '{}')).toEqual({
        clientClass: 'mobile',
        capability: 'file.write',
      });

      // No body, path or content ever reaches the audit rows.
      const blob = h.audit.list(1000).map((row) => JSON.stringify(row)).join('\n');
      expect(blob).not.toContain(secretLabel);
      expect(blob).not.toContain('secret-path');
      expect(blob).not.toContain(content);

      // And the refusals moved no state.
      expect(h.broker?.roots.list()).toHaveLength(1);
      expect(h.proposalStore.listOpen()).toEqual([]);
      expect(h.pendingStore.listOpen()).toEqual([]);
      expect(h.broker?.grants.list()).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe('the class comes from the session row', () => {
  it('ignores a class offered by the request (body, header or query)', async () => {
    const h = demoHarness();
    try {
      const mobile = await classToken(h, 'mobile');
      const dir = tempDir();

      const res = await request(h.app)
        .post('/v1/roots')
        .set({ ...authed(mobile), 'X-Client-Class': 'desktop', 'X-Partner-Client-Class': 'desktop' })
        .query({ clientClass: 'desktop' })
        .send({ label: 'r', path: dir, clientClass: 'desktop' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        reason: 'capability_denied',
        capability: 'roots',
        clientClass: 'mobile',
      });
      expect(h.broker?.roots.list()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('refuses an unknown class on the session row, never falling back to desktop', async () => {
    const h = demoHarness();
    try {
      // `sessions.create` refuses to mint a bad class, so this row is written
      // directly — a mis-mapped column must fail CLOSED, not become desktop.
      const raw = randomBytes(32).toString('hex');
      const now = Date.now();
      h.sessionStore.insert(tokenHash(raw), 'web', ALLOWED_HOST, now, now + 60_000, now, {
        clientClass: 'device',
      });

      const roots = await request(h.app)
        .post('/v1/roots')
        .set(authed(raw))
        .send({ label: 'r', path: 'x' });
      expect(roots.status).toBe(403);
      expect(roots.body).toMatchObject({
        error: 'capability_denied',
        reason: 'unknown_client_class',
        capability: 'roots',
        clientClass: 'device',
      });

      // The read/chat/browser surface is guarded too, so an unknown class is
      // not "desktop wherever the envelope has no entry to refuse" and the
      // mobile-allowed mounts are provably present.
      const guarded: Array<[string, string, object]> = [
        ['post', '/v1/chat', { messages: [{ role: 'user', content: 'hi' }] }],
        ['get', '/v1/files/browse', {}],
        ['get', '/v1/files/refs', {}],
        ['put', '/v1/browser/scopes/example.com', { scope: 'ask' }],
      ];
      for (const [method, path, body] of guarded) {
        const res = await request(h.app)[method as 'post' | 'get' | 'put'](path)
          .set(authed(raw))
          .send(body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.reason, `${method} ${path}`).toBe('unknown_client_class');
      }

      const exec = await request(h.app)
        .post('/v1/tools/exec')
        .set(authed(raw))
        .send({ tool: 'files.list', params: { projectId: 'p' } });
      expect(exec.status).toBe(403);
      expect(exec.body).toMatchObject({ outcome: 'denied', reason: 'unknown_client_class' });

      const rows = h.audit.list(1000).filter((row) => row.action === 'capability.denied');
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.parse(rows[0]?.details ?? '{}')).toMatchObject({ clientClass: 'device' });
    } finally {
      h.close();
    }
  });
});

describe('M20-B S4: MCP server CRUD is gated — configuring spawns a process', () => {
  // BLOCKER fix. Registering or editing an MCP server takes an arbitrary
  // `command`/`args` plus an `enabled` toggle, and an enabled server is SPAWNED
  // as a child process with the user's privileges (mcp/client.ts). Left ungated,
  // `capability('mcp.call')` on /call was decorative: any class could register and
  // enable a command, then invoke it.
  const BODY = { name: 'x', command: 'sh', args: ['-c', 'echo hi'], enabled: true };

  it('refuses create/update/delete for mobile and extension, with the named reason', async () => {
    const h = demoHarness();
    try {
      for (const clientClass of ['mobile', 'extension']) {
        const token = await classToken(h, clientClass);
        const routes = [
          ['post', '/v1/mcp/servers'],
          ['put', '/v1/mcp/servers/nope'],
          ['delete', '/v1/mcp/servers/nope'],
        ] as const;
        for (const [method, path] of routes) {
          const res = await request(h.app)[method](path).set(authed(token)).send(BODY);
          expect(res.status, `${clientClass} ${method} ${path}`).toBe(403);
          expect(res.body).toMatchObject({ reason: 'capability_denied', clientClass });
        }
      }
    } finally {
      h.close();
    }
  });

  it('does not refuse desktop by the ENVELOPE (other causes are allowed to differ)', async () => {
    // Scoped on purpose: the harness may have no MCP manager (501) or no such
    // server (404). Those are unrelated to the class, so the assertion is that
    // desktop is not stopped by the ENVELOPE — not a blanket status.
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const res = await request(h.app).post('/v1/mcp/servers').set(authed(desktop)).send(BODY);
      expect(res.status).not.toBe(403);
      expect(res.body?.reason).not.toBe('capability_denied');
    } finally {
      h.close();
    }
  });
});
