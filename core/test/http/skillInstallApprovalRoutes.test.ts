/**
 * M26 cut C — the install approval over HTTP (PLAN-M26.md D2b).
 *
 * The route is the OWNER's door: `POST /v1/skills/drafts/:id/request-install`
 * creates the ask, `POST /v1/tools/pending/:id` decides it, and the branch that
 * decides it calls the same `drafts.promote` the Studio button calls. What these
 * tests pin beyond "it works":
 *
 *   · an ask installs NOTHING — no skill row exists until an approve;
 *   · approve installs exactly once (the second decide is `not_pending`);
 *   · a denied or discarded ask leaves no card and no installed skill;
 *   · `broker.decide` refuses the row (`wrong_kind`) instead of executing;
 *   · a WIDENED permission set still needs the acknowledgement (D6), on this
 *     path too;
 *   · a mobile session may neither create the ask nor approve it — approving an
 *     install IS the install act (`skill.install`);
 *   · `GET /v1/tools/pending` labels the row with its draft so the queue can
 *     render it without a tool manifest;
 *   · no audit row carries draft code or manifest text.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { ALLOWED_HOST, demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { ToolError } from '../../src/broker/errors.js';
import { DRAFT_TOOL_ID, authoringToolExternal } from '../../src/skills/tool.js';

/** Install the catalog's smallest skill, the subject every update test changes. */
function installHello(h: Harness): void {
  const installed = h.skills?.install('hello-skill');
  if (installed === undefined) throw new Error('the harness wired no skill manager');
}

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

async function classToken(h: Harness, clientClass: string): Promise<string> {
  const created = await h.sessions.create({ kind: 'web', origin: ALLOWED_HOST, clientClass });
  return created.token;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

const MANIFEST = (id: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id,
    name: 'Scratch To Checklist',
    description: 'turns scratch notes into a checklist',
    author: 'Partner',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: { tools: [], network: false, risk: 'low' },
    budget: { timeMs: 5000 },
    ...over,
  });

/** A validating draft, created through the HTTP surface (template path). */
async function createDraft(
  h: Harness,
  headers: Record<string, string>,
  name = 'Scratch To Checklist',
): Promise<string> {
  const created = await request(h.app)
    .post('/v1/skills/drafts')
    .set(headers)
    .send({ mode: 'template', template: 'pure', name, description: 'uppercases text' });
  expect(created.status).toBe(201);
  expect(created.body.validation.ok).toBe(true);
  return created.body.id as string;
}

async function askInstall(
  h: Harness,
  headers: Record<string, string>,
  draftId: string,
  body: Record<string, unknown> = { conversationId: 'conv-1' },
): Promise<string> {
  const asked = await request(h.app)
    .post(`/v1/skills/drafts/${draftId}/request-install`)
    .set(headers)
    .send(body);
  expect(asked.status).toBe(201);
  return asked.body.pendingId as string;
}

describe('M26 install approval routes', () => {
  it('is authed (401 without a token)', async () => {
    const h = demoHarness();
    try {
      const checks = [
        request(h.app).get('/v1/tools/pending'),
        request(h.app).post('/v1/tools/pending/x').send({ decision: 'approve' }),
        request(h.app).post('/v1/skills/drafts/x/request-install').send({}),
      ];
      for (const pending of checks) {
        const res = await pending.set('Host', ALLOWED_HOST);
        expect(res.status).toBe(401);
      }
    } finally {
      h.close();
    }
  });

  it('creates the ask, labels it, and installs nothing until an approve', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await createDraft(h, headers);
      const pendingId = await askInstall(h, headers, draftId);

      // The ask is a queue row of its own KIND, and it installed nothing.
      const installedDuringAsk = await request(h.app).get('/v1/skills').set(headers);
      expect(installedDuringAsk.body.skills).toEqual([]);
      const queue = await request(h.app).get('/v1/tools/pending').set(headers);
      expect(queue.status).toBe(200);
      const row = (queue.body.pending as Array<Record<string, unknown>>).find(
        (entry) => entry.id === pendingId,
      );
      expect(row).toMatchObject({
        kind: 'skill_install',
        draftId,
        // The label the queue renders without any broker manifest.
        draftName: 'Scratch To Checklist',
        conversationId: 'conv-1',
        requestedBy: 'persona',
      });

      // Approve: the same promote the Studio calls, reported in the shape the
      // chat approval card already consumes.
      const approved = await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(headers)
        .send({ decision: 'approve' });
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ ok: true, executed: true });
      expect(approved.body.result).toMatchObject({ skillId: draftId, mode: 'created' });

      const installed = await request(h.app).get('/v1/skills').set(headers);
      expect(installed.body.skills).toHaveLength(1);
      expect(installed.body.skills[0]).toMatchObject({ id: draftId, source: 'authored' });

      // The install is audited as APPROVAL-sourced, and it happened exactly once.
      const install = h.audit
        .query({ limit: 50, action: 'skill.draft.install' })
        .map((entry) => JSON.parse(entry.details ?? '{}') as Record<string, unknown>);
      expect(install).toContainEqual(
        expect.objectContaining({ via: 'approval', mode: 'created', acked: false }),
      );
      const again = await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(headers)
        .send({ decision: 'approve' });
      expect(again.status).toBe(403);
      expect(again.body.error).toBe('not_pending');
      const stillOne = await request(h.app).get('/v1/skills').set(headers);
      expect(stillOne.body.skills).toHaveLength(1);
      // ...and the card is gone from the queue.
      const emptyQueue = await request(h.app).get('/v1/tools/pending').set(headers);
      expect(emptyQueue.body.pending).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('denying closes the ask and leaves the draft intact', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await createDraft(h, headers);
      const pendingId = await askInstall(h, headers, draftId);

      const denied = await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(headers)
        .send({ decision: 'deny' });
      expect(denied.status).toBe(200);
      expect(denied.body).toMatchObject({ ok: true, executed: false });

      // The draft is exactly where it was; nothing is installed; no card left.
      const draft = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);
      expect(draft.status).toBe(200);
      expect(draft.body.status).toBe('draft');
      expect(draft.body.pendingInstallId).toBeNull();
      expect(draft.body.validation.ok).toBe(true);
      const installed = await request(h.app).get('/v1/skills').set(headers);
      expect(installed.body.skills).toEqual([]);
      const queue = await request(h.app).get('/v1/tools/pending').set(headers);
      expect(queue.body.pending).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('refuses broker.decide on the row and executes nothing', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await createDraft(h, headers);
      const pendingId = await askInstall(h, headers, draftId);

      const broker = h.broker as NonNullable<Harness['broker']>;
      let code = 'no-error';
      try {
        broker.decide(pendingId, { decision: 'approve' }, 'web');
      } catch (err) {
        code = err instanceof ToolError ? err.code : `other:${String(err)}`;
      }
      expect(code).toBe('wrong_kind');
      expect(h.broker?.pending.list()).toHaveLength(1);
      const installed = await request(h.app).get('/v1/skills').set(headers);
      expect(installed.body.skills).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('still demands the permission acknowledgement for a widened update', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await createDraft(h, headers);
      const firstAsk = await askInstall(h, headers, draftId);
      await request(h.app)
        .post(`/v1/tools/pending/${firstAsk}`)
        .set(headers)
        .send({ decision: 'approve' });

      // Edit the installed skill into a draft and widen its permissions.
      const edited = await request(h.app)
        .post(`/v1/skills/${draftId}/edit`)
        .set(headers)
        .send({});
      expect(edited.status).toBe(201);
      const editId = edited.body.id as string;
      const widened = await request(h.app)
        .put(`/v1/skills/drafts/${editId}`)
        .set(headers)
        .send({
          manifestText: MANIFEST(draftId, {
            version: '0.2.0',
            permissions: { tools: ['files.read'], network: false, risk: 'medium' },
          }),
        });
      expect(widened.status).toBe(200);
      expect(widened.body.validation.ok).toBe(true);

      const ask = await askInstall(h, headers, editId);
      const unacked = await request(h.app)
        .post(`/v1/tools/pending/${ask}`)
        .set(headers)
        .send({ decision: 'approve' });
      // The card must show the before/after table first: a silent widening is
      // exactly what D6 exists to prevent, on both surfaces.
      expect(unacked.status).toBe(200);
      expect(unacked.body).toMatchObject({ ok: true, executed: false, error: 'permission_change' });
      const stillOpen = await request(h.app).get('/v1/tools/pending').set(headers);
      expect(stillOpen.body.pending).toHaveLength(1);
      const unchanged = await request(h.app).get(`/v1/skills/${draftId}`).set(headers);
      expect(unchanged.body.version).toBe('0.1.0');

      const acked = await request(h.app)
        .post(`/v1/tools/pending/${ask}`)
        .set(headers)
        .send({ decision: 'approve', acknowledgePermissions: true });
      expect(acked.status).toBe(200);
      expect(acked.body).toMatchObject({ ok: true, executed: true });
      const updated = await request(h.app).get(`/v1/skills/${draftId}`).set(headers);
      expect(updated.body.version).toBe('0.2.0');
      const install = h.audit
        .query({ limit: 50, action: 'skill.draft.install' })
        .map((entry) => JSON.parse(entry.details ?? '{}') as Record<string, unknown>);
      expect(install.some((row) => row.via === 'approval' && row.acked === true)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('refuses a mobile session by class, at the ask and at the approve', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const headers = authed(desktop);
      const draftId = await createDraft(h, headers);
      const pendingId = await askInstall(h, headers, draftId);

      const mobile = await classToken(h, 'mobile');
      const mobileHeaders = authed(mobile);
      // The ASK is `skill.author`, which mobile does not hold.
      const mobileAsk = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/request-install`)
        .set(mobileHeaders)
        .send({});
      expect(mobileAsk.status).toBe(403);
      expect(mobileAsk.body.error).toBe('capability_denied');

      // Approving EXECUTES, so it needs `skill.install` - denied to mobile by
      // the envelope table, whatever it was handed.
      const mobileApprove = await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(mobileHeaders)
        .send({ decision: 'approve' });
      expect(mobileApprove.status).toBe(403);
      expect(mobileApprove.body.error).toBe('capability_denied');
      expect(h.audit.query({ limit: 20, action: 'capability.denied' }).length).toBeGreaterThan(0);

      // Nothing changed: the ask is still open and nothing is installed.
      const queue = await request(h.app).get('/v1/tools/pending').set(headers);
      expect(queue.body.pending).toHaveLength(1);
      const installed = await request(h.app).get('/v1/skills').set(headers);
      expect(installed.body.skills).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('refuses an ask for a draft that cannot be installed, by name', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const missing = await request(h.app)
        .post('/v1/skills/drafts/nope/request-install')
        .set(headers)
        .send({});
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('not_found');

      const draftId = await createDraft(h, headers);
      const broken = await request(h.app)
        .put(`/v1/skills/drafts/${draftId}`)
        .set(headers)
        .send({ manifestText: MANIFEST(draftId, { permissions: { tools: [], risk: 'extreme' } }) });
      expect(broken.body.validation.ok).toBe(false);
      const refused = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/request-install`)
        .set(headers)
        .send({});
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('invalid_input');
      const queue = await request(h.app).get('/v1/tools/pending').set(headers);
      expect(queue.body.pending).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('never puts draft code or manifest text in an audit row', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await createDraft(h, headers);
      const pendingId = await askInstall(h, headers, draftId);
      await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(headers)
        .send({ decision: 'approve' });

      const rows = h.audit.query({ limit: 100 });
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('export function run');
      expect(serialized).not.toContain('entrypoint');
      expect(serialized).not.toContain('uppercases text');
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// M26 review — the ask the CHAT makes about an INSTALLED skill.
//
// The Studio's `/edit` route already covered "an update that widens needs the
// acknowledgement" (above). What this adds is the door a persona actually uses:
// `skills.draft` with `skillId` stages the update into the skill's edit draft,
// `skills.requestInstall` opens the ask, and approving it twice is what the
// owner does in the card — once to see the change table, once to acknowledge it.
// Without this the chat could only ever create NEW skills.
// ---------------------------------------------------------------------------

describe('M26 review: a persona-proposed UPDATE through the same approval door', () => {
  it('needs the acknowledgement, then updates the installed skill in place', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      // A real installed skill, then a staged update that adds a tool.
      installHello(h);
      const provider = authoringToolExternal({
        drafts: h.skillDrafts,
        toolIds: new Set(['files.list', 'files.read', 'files.search']),
      });
      const staged = provider?.exec(DRAFT_TOOL_ID, {
        skillId: 'hello-skill',
        name: 'Hello Skill',
        description: 'greets, and now reads a file',
        tools: ['files.read'],
        code: 'export function run(){ return { ok: true }; }',
      });
      const result = (staged as { result: Record<string, unknown> }).result;
      expect(result).toMatchObject({ ok: true, mode: 'update', draftId: 'hello-skill-edit' });
      expect(result.widens).toBe(true);

      const ask = await askInstall(h, headers, 'hello-skill-edit');
      // The queue row names the draft, so the card renders without a manifest.
      const queue = await request(h.app).get('/v1/tools/pending').set(headers);
      expect(queue.body.pending).toHaveLength(1);
      expect(queue.body.pending[0]).toMatchObject({
        kind: 'skill_install',
        draftId: 'hello-skill-edit',
        draftName: 'Hello Skill',
      });

      // First approve: refused until the change table has been acknowledged.
      const unacked = await request(h.app)
        .post(`/v1/tools/pending/${ask}`)
        .set(headers)
        .send({ decision: 'approve' });
      expect(unacked.body).toMatchObject({ ok: true, executed: false, error: 'permission_change' });
      const stillOpen = await request(h.app).get('/v1/tools/pending').set(headers);
      expect(stillOpen.body.pending).toHaveLength(1);
      const unchanged = await request(h.app).get('/v1/skills/hello-skill').set(headers);
      expect(unchanged.body.manifest.permissions.tools).toEqual([]);

      // Second approve, WITH the acknowledgement the card sends: in place.
      const acked = await request(h.app)
        .post(`/v1/tools/pending/${ask}`)
        .set(headers)
        .send({ decision: 'approve', acknowledgePermissions: true });
      expect(acked.status).toBe(200);
      expect(acked.body).toMatchObject({ ok: true, executed: true });
      expect(acked.body.result).toMatchObject({ skillId: 'hello-skill', mode: 'updated' });

      const updated = await request(h.app).get('/v1/skills/hello-skill').set(headers);
      expect(updated.body.manifest.permissions.tools).toEqual(['files.read']);
      expect(updated.body.manifest.description).toContain('reads a file');
      // ONE skill, not a second one.
      const listed = await request(h.app).get('/v1/skills').set(headers);
      expect(listed.body.skills).toHaveLength(1);
      // The draft is spent history now, so the rail cannot re-install it.
      const draft = await request(h.app).get('/v1/skills/drafts/hello-skill-edit').set(headers);
      expect(draft.body.status).toBe('installed');
    } finally {
      h.close();
    }
  });
});
