/**
 * M2 HTTP surface tests (PLAN-M2 "Core API"): every roots/grants/tools route
 * is authed (401) and 501s when no broker is wired; roots + grants CRUD;
 * the full write-preview flow over HTTP (add root -> files.edit proposal ->
 * approve high-risk apply -> file changed on disk); proposal discard; and an
 * audit scan proving exec params/results never leak secrets or file content.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { demoHarness, makeTempRoot, removeTempRoot, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';

const dirs: string[] = [];

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

function tempDir(): string {
  const dir = realpathSync(makeTempRoot());
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

const TOOL_ROUTES: Array<[string, string]> = [
  ['get', '/v1/roots'],
  ['post', '/v1/roots'],
  ['delete', '/v1/roots/x'],
  ['get', '/v1/grants'],
  ['post', '/v1/grants'],
  ['delete', '/v1/grants/x'],
  ['post', '/v1/tools/exec'],
  ['get', '/v1/tools/pending'],
  ['post', '/v1/tools/pending/x'],
  ['get', '/v1/tools/proposals/x'],
  ['post', '/v1/proposals/x/apply'],
  ['delete', '/v1/proposals/x'],
];

describe('auth gate on the M2 surface', () => {
  it('every root/grant/tool route returns 401 without a token', async () => {
    const h = demoHarness();
    try {
      for (const [method, path] of TOOL_ROUTES) {
        const res = await request(h.app)[method as 'get' | 'post' | 'delete'](path)
          .set('Host', ALLOWED_HOST)
          .send({});
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    } finally {
      h.close();
    }
  });
});

describe('not configured (no broker wired)', () => {
  it('the whole M2 surface responds 501 not_configured', async () => {
    const h = demoHarness({ broker: false });
    try {
      const token = await pairToken(h);
      const checks: Array<[string, string, object]> = [
        ['get', '/v1/roots', {}],
        ['post', '/v1/roots', { label: 'x', path: '/tmp' }],
        ['get', '/v1/grants', {}],
        ['post', '/v1/grants', { toolId: 'files.list', projectId: 'r' }],
        ['post', '/v1/tools/exec', { tool: 'files.list', params: {} }],
        ['get', '/v1/tools/pending', {}],
      ];
      for (const [method, path, body] of checks) {
        const res = await request(h.app)[method as 'get' | 'post'](path).set(authed(token)).send(body);
        expect(res.status, `${method} ${path}`).toBe(501);
        expect(res.body.error).toBe('not_configured');
      }
    } finally {
      h.close();
    }
  });
});

describe('roots CRUD over HTTP', () => {
  it('add/list/delete with validation errors mapped to status codes', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const dir = tempDir();

      // Relative + missing paths -> 400.
      const rel = await request(h.app).post('/v1/roots').set(authed(token)).send({ label: 'r', path: 'rel' });
      expect(rel.status).toBe(400);
      const missing = await request(h.app)
        .post('/v1/roots')
        .set(authed(token))
        .send({ label: 'r', path: join(dir, 'nope') });
      expect(missing.status).toBe(400);

      const created = await request(h.app)
        .post('/v1/roots')
        .set(authed(token))
        .send({ label: 'code', path: dir });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ label: 'code', path: realpathSync(dir), readOnly: false });
      const rootId = created.body.id as string;

      const dup = await request(h.app).post('/v1/roots').set(authed(token)).send({ label: 'again', path: dir });
      expect(dup.status).toBe(409);
      expect(dup.body.error).toBe('exists');

      const list = await request(h.app).get('/v1/roots').set(authed(token));
      expect(list.status).toBe(200);
      expect(list.body.roots.map((r: { id: string }) => r.id)).toContain(rootId);

      const del = await request(h.app).delete(`/v1/roots/${rootId}`).set(authed(token));
      expect(del.status).toBe(204);
      const gone = await request(h.app).delete(`/v1/roots/${rootId}`).set(authed(token));
      expect(gone.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('readOnly flag round-trips', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const dir = tempDir();
      const created = await request(h.app)
        .post('/v1/roots')
        .set(authed(token))
        .send({ label: 'ro', path: dir, readOnly: true });
      expect(created.status).toBe(201);
      expect(created.body.readOnly).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe('grants CRUD over HTTP', () => {
  it('add/list/delete and validation (unknown tool 400, unknown project 404)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const dir = tempDir();
      const root = await request(h.app).post('/v1/roots').set(authed(token)).send({ label: 'g', path: dir });
      const rootId = root.body.id as string;

      const badTool = await request(h.app)
        .post('/v1/grants')
        .set(authed(token))
        .send({ toolId: 'files.rm', projectId: rootId });
      expect(badTool.status).toBe(400);
      expect(badTool.body.error).toBe('unknown_tool');

      const badProject = await request(h.app)
        .post('/v1/grants')
        .set(authed(token))
        .send({ toolId: 'files.read', projectId: 'nope' });
      expect(badProject.status).toBe(404);

      const grant = await request(h.app)
        .post('/v1/grants')
        .set(authed(token))
        .send({ toolId: 'files.read', projectId: rootId, note: 'trusted' });
      expect(grant.status).toBe(201);
      expect(grant.body).toMatchObject({ toolId: 'files.read', projectId: rootId, source: 'user', note: 'trusted' });
      const grantId = grant.body.id as string;

      const list = await request(h.app).get('/v1/grants').set(authed(token));
      expect(list.body.grants.map((g: { id: string }) => g.id)).toContain(grantId);

      const del = await request(h.app).delete(`/v1/grants/${grantId}`).set(authed(token));
      expect(del.status).toBe(204);
      const gone = await request(h.app).delete(`/v1/grants/${grantId}`).set(authed(token));
      expect(gone.status).toBe(404);
    } finally {
      h.close();
    }
  });

  it('scopes an APP tool to `app` and refuses to let `app` stand in for a root', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const dir = tempDir();
      const root = await request(h.app).post('/v1/roots').set(authed(token)).send({ label: 'g', path: dir });
      const rootId = root.body.id as string;

      // An app-scoped tool takes ONLY the reserved scope id. It needs no root,
      // so a real root id is not a legal value for it either.
      const appGrant = await request(h.app)
        .post('/v1/grants')
        .set(authed(token))
        .send({ toolId: 'notes.read', projectId: 'app' });
      expect(appGrant.status).toBe(201);
      expect(appGrant.body).toMatchObject({ toolId: 'notes.read', projectId: 'app' });
      expect(h.broker?.grants.hasGrant('notes.read', 'app') ?? false).toBe(true);

      const withRoot = await request(h.app)
        .post('/v1/grants')
        .set(authed(token))
        .send({ toolId: 'notes.read', projectId: rootId });
      expect(withRoot.status).toBe(400);
      expect(withRoot.body.error).toBe('bad_params');

      // ...and the app scope can NEVER be used to grant a FILE tool, or `app`
      // would be a root alias that bypasses the roots manager entirely.
      const fileViaApp = await request(h.app)
        .post('/v1/grants')
        .set(authed(token))
        .send({ toolId: 'files.read', projectId: 'app' });
      expect(fileViaApp.status).toBe(400);
      expect(fileViaApp.body.error).toBe('bad_params');
      expect(h.broker?.grants.hasGrant('files.read', 'app') ?? false).toBe(false);
    } finally {
      h.close();
    }
  });
});

describe('write-preview happy flow over HTTP', () => {
  it('root -> edit proposal -> approve high-risk apply -> file changed; audit clean', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const dir = tempDir();
      const ORIGINAL = 'ORIGINAL-MARKER original content\nsk-route-leak-1234567890\n';
      const PROPOSED = 'PROPOSED-MARKER edited content v2\npassword=hunter2-route\nsk-route-other-7777777\n';
      writeFileSync(join(dir, 'notes.txt'), ORIGINAL);
      mkdirSync(join(dir, '.partner-trash'));

      // 1. Register the root.
      const rootRes = await request(h.app).post('/v1/roots').set(authed(token)).send({ label: 'code', path: dir });
      expect(rootRes.status).toBe(201);
      const rootId = rootRes.body.id as string;

      // 2. Medium files.edit runs under an EXPLICIT grant -> proposal created.
      const grantEdit = await request(h.app)
        .post('/v1/grants')
        .set(authed(token))
        .send({ toolId: 'files.edit', projectId: rootId });
      expect(grantEdit.status).toBe(201);

      const execEdit = await request(h.app)
        .post('/v1/tools/exec')
        .set(authed(token))
        .send({ tool: 'files.edit', params: { projectId: rootId, path: 'notes.txt', proposedContent: PROPOSED } });
      expect(execEdit.status).toBe(200);
      expect(execEdit.body.outcome).toBe('executed');
      const proposalId = execEdit.body.result.proposalId as string;
      expect(execEdit.body.result.originalContent).toBe(ORIGINAL);

      // 3. GET the proposal diff payload.
      const proposal = await request(h.app).get(`/v1/tools/proposals/${proposalId}`).set(authed(token));
      expect(proposal.status).toBe(200);
      expect(proposal.body).toMatchObject({
        open: true,
        path: 'notes.txt',
        originalContent: ORIGINAL,
        proposedContent: PROPOSED,
      });

      // 4. Disk is UNTOUCHED until apply.
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe(ORIGINAL);

      // 5. files.apply is HIGH risk: always asks without an explicit grant.
      const apply1 = await request(h.app)
        .post(`/v1/proposals/${proposalId}/apply`)
        .set(authed(token))
        .send({ projectId: rootId });
      expect(apply1.status).toBe(202);
      expect(apply1.body.outcome).toBe('needs_approval');
      const pendingId = apply1.body.pendingId as string;

      // 6. The approval queue shows the high-risk call.
      const pending = await request(h.app).get('/v1/tools/pending').set(authed(token));
      expect(pending.status).toBe(200);
      const row = pending.body.pending.find((p: { id: string }) => p.id === pendingId);
      expect(row).toMatchObject({ toolId: 'files.apply', risk: 'high', requestedBy: 'web' });

      // 7. Approve + remember -> grant persisted AND the approval itself
      //    executes the apply once (the point of the ask).
      const decide = await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(authed(token))
        .send({ decision: 'approve', remember: true, note: 'apply allowed' });
      expect(decide.status).toBe(200);
      expect(decide.body.grantId).toBeTruthy();
      expect(decide.body.executed).toBe(true);
      expect(h.broker?.grants.hasGrant('files.apply', rootId) || false).toBe(true);

      // 8. The approved apply already changed the file on disk; .bak holds
      //    the original.
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe(PROPOSED);
      expect(readFileSync(join(dir, 'notes.txt.bak'), 'utf8')).toBe(ORIGINAL);

      // 9. A second apply of the same (now-applied) proposal -> denied.
      const apply2 = await request(h.app)
        .post(`/v1/proposals/${proposalId}/apply`)
        .set(authed(token))
        .send({ projectId: rootId });
      expect(apply2.status).toBe(403);
      expect(apply2.body.reason).toBe('not_pending');

      // 10. Audit scan: no secret markers, no file content beyond lengths.
      const auditRows = h.audit.list(1000);
      const blob = auditRows.map((r) => JSON.stringify(r)).join('\n');
      expect(blob).not.toContain('sk-route-leak-1234567890');
      expect(blob).not.toContain('sk-route-other-7777777');
      expect(blob).not.toContain('hunter2');
      expect(blob).not.toContain('ORIGINAL-MARKER');
      expect(blob).not.toContain('PROPOSED-MARKER');
      const actions = auditRows.map((r) => r.action);
      expect(actions).toContain('files.edit.executed');
      expect(actions).toContain('files.apply.executed');
      expect(actions).toContain('tool.approve');
      expect(actions).toContain('roots.add');
      expect(actions).toContain('grant.add');
    } finally {
      h.close();
    }
  });

  it('exec route maps unknown tool to 404 and bad params to 400', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const unknown = await request(h.app)
        .post('/v1/tools/exec')
        .set(authed(token))
        .send({ tool: 'files.rm', params: { projectId: 'x' } });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ outcome: 'denied', reason: 'unknown_tool' });

      const bad = await request(h.app)
        .post('/v1/tools/exec')
        .set(authed(token))
        .send({ tool: 'files.list', params: { projectId: 'x' } });
      expect(bad.status).toBe(400);
      expect(bad.body.reason).toBe('bad_params');

      const noTool = await request(h.app).post('/v1/tools/exec').set(authed(token)).send({ params: {} });
      expect(noTool.status).toBe(400);
    } finally {
      h.close();
    }
  });

  it('proposal discard closes the row; a later apply is refused', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const dir = tempDir();
      writeFileSync(join(dir, 'f.txt'), 'v1');
      const root = await request(h.app).post('/v1/roots').set(authed(token)).send({ label: 'd', path: dir });
      const rootId = root.body.id as string;
      await request(h.app)
        .post('/v1/grants')
        .set(authed(token))
        .send({ toolId: 'files.edit', projectId: rootId });

      const edit = await request(h.app)
        .post('/v1/tools/exec')
        .set(authed(token))
        .send({ tool: 'files.edit', params: { projectId: rootId, path: 'f.txt', proposedContent: 'v2' } });
      const proposalId = edit.body.result.proposalId as string;

      const discard = await request(h.app).delete(`/v1/proposals/${proposalId}`).set(authed(token));
      expect(discard.status).toBe(204);

      const proposal = await request(h.app).get(`/v1/tools/proposals/${proposalId}`).set(authed(token));
      expect(proposal.status).toBe(200);
      expect(proposal.body.open).toBe(false);
      expect(proposal.body.discardedAt).toBeTruthy();

      // Apply of a discarded proposal: needs approval first; the approval
      // executes and FAILS (not_pending), and no grant is persisted.
      const apply1 = await request(h.app)
        .post(`/v1/proposals/${proposalId}/apply`)
        .set(authed(token))
        .send({ projectId: rootId });
      expect(apply1.status).toBe(202);
      const pendingId = apply1.body.pendingId as string;
      const decide = await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(authed(token))
        .send({ decision: 'approve', remember: true });
      expect(decide.status).toBe(200);
      expect(decide.body.executed).toBe(false);
      expect(decide.body.error).toBe('not_pending');
      // Review fix: a failed approval must NOT persist a grant.
      expect(h.broker?.grants.hasGrant('files.apply', rootId) || false).toBe(false);
      expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('v1');
    } finally {
      h.close();
    }
  });

  it('files.delete via exec (trash-first) works under a grant', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const dir = tempDir();
      writeFileSync(join(dir, 'trashme.txt'), 'bye');
      const root = await request(h.app).post('/v1/roots').set(authed(token)).send({ label: 't', path: dir });
      const rootId = root.body.id as string;
      await request(h.app)
        .post('/v1/grants')
        .set(authed(token))
        .send({ toolId: 'files.delete', projectId: rootId });

      const exec = await request(h.app)
        .post('/v1/tools/exec')
        .set(authed(token))
        .send({ tool: 'files.delete', params: { projectId: rootId, path: 'trashme.txt' } });
      expect(exec.status).toBe(200);
      expect(exec.body.outcome).toBe('executed');
      expect(existsSync(join(dir, 'trashme.txt'))).toBe(false);
      expect(existsSync(join(dir, exec.body.result.trashPath as string))).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe('drift protection (review fix)', () => {
  it('apply refuses when the file changed on disk after the proposal', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const dir = tempDir();
      writeFileSync(join(dir, 'd.txt'), 'v1\n');
      const root = await request(h.app).post('/v1/roots').set(authed(token)).send({ label: 'dr', path: dir });
      const rootId = root.body.id as string;
      await request(h.app)
        .post('/v1/grants')
        .set(authed(token))
        .send({ toolId: 'files.edit', projectId: rootId });
      await request(h.app)
        .post('/v1/grants')
        .set(authed(token))
        .send({ toolId: 'files.apply', projectId: rootId });

      const edit = await request(h.app)
        .post('/v1/tools/exec')
        .set(authed(token))
        .send({ tool: 'files.edit', params: { projectId: rootId, path: 'd.txt', proposedContent: 'v2\n' } });
      expect(edit.status).toBe(200);
      const proposalId = edit.body.result.proposalId as string;

      // The file changes on disk AFTER the proposal (e.g. another editor).
      writeFileSync(join(dir, 'd.txt'), 'v1.5\n');
      const future = Date.now() + 2000;
      const { utimesSync } = await import('node:fs');
      utimesSync(join(dir, 'd.txt'), future / 1000, future / 1000);

      const apply = await request(h.app)
        .post(`/v1/proposals/${proposalId}/apply`)
        .set(authed(token))
        .send({ projectId: rootId });
      expect(apply.status).toBe(403);
      expect(apply.body.reason).toBe('changed_since_proposal');
      expect(readFileSync(join(dir, 'd.txt'), 'utf8')).toBe('v1.5\n'); // untouched
    } finally {
      h.close();
    }
  });
});
