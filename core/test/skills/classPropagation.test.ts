/**
 * M27 S3 - the acting session's client class propagates into the skill runner
 * (PLAN-M27.md S3 + decision D7). This closes the gap M20-B S4 recorded against
 * itself: "neither `core/src/skills/` nor `core/src/mcp/` consults the session's
 * client class today, so the class would NOT constrain what they do on mobile's
 * behalf". `broker.exec` called from a skill passed no `clientClass`, so every
 * skill-mediated tool call saw the DESKTOP envelope.
 *
 * What these pin:
 *   - the M20-B S4 case: a GRANTED `files.edit` on a project root, reached
 *     through the skill runner by a mobile-class session, is refused
 *     `capability_denied` at the broker. The grant is verified present at the
 *     STORE first: without that, a refusal would only prove the grant gate M8
 *     has always enforced, not the class envelope that sits above it. The same
 *     runner call for a desktop class executes and creates the proposal;
 *   - the class is per-CAPABILITY, never a blanket deny of a narrow client: the
 *     SAME granted mobile context may still READ, because the envelope table
 *     hands `file.read` to mobile (PLAN-M27 D3 leans on exactly that);
 *   - the class comes from the SESSION ROW: a body field can neither raise nor
 *     set it, on either route into the runner;
 *   - an ABSENT class keeps the desktop envelope: a persona or scheduled run has
 *     no session, and that documented meaning of `ExecContext.clientClass` is
 *     unchanged;
 *   - BOTH doors into the runner carry it: `POST /v1/skills/:id/invoke` and the
 *     `POST /v1/skills/drafts/:id/run` dry-run, which reaches the same runner.
 *
 * Defence in depth is two layers and both are asserted here. The ROUTE refuses a
 * mobile session by name before the runner is in the call stack (`skill.invoke`
 * and `skill.author` are desktop-only in the envelope), and the runner forwards
 * the row's class to every `broker.exec` it mediates so an entry that DID reach
 * it is refused ABOVE the skill's grants. That second layer is unreachable
 * through a route today - which is what the first layer is for - so it is driven
 * through the runner with exactly the class the route reads.
 *
 * Nothing here is stubbed: the real routes, the real broker, the real session
 * rows and real worker processes. `files-preview` (read) comes from the repo
 * catalog; the write probe is an authored bundle installed through the manager's
 * one door (`installFromBundle`), because the catalog has no write-shaped skill
 * and the ceiling rule needs a manifest that declares `files.edit` at medium.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { SkillDetail, SkillManifest } from '@partner/shared';
import { ALLOWED_HOST, demoHarness, makeTempRoot, removeTempRoot } from '../helpers.js';
import type { Harness } from '../helpers.js';
import type { SkillDraftManager } from '../../src/skills/drafts.js';
import type { SkillRunner } from '../../src/skills/runner.js';

const READ_TOOL = 'files.read';
const WRITE_TOOL = 'files.edit';
const WRITER_ID = 'class-write-probe';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

function tempDir(): string {
  const dir = makeTempRoot();
  dirs.push(dir);
  return dir;
}

/** The desktop session `/v1/pair` mints (untouched by M20-B S4). */
async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

/** A session of a given client class, minted on the row. */
async function classToken(h: Harness, clientClass: string): Promise<string> {
  const created = await h.sessions.create({ kind: 'web', origin: ALLOWED_HOST, clientClass });
  return created.token;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

function runnerOf(h: Harness): SkillRunner {
  const runner = h.skillRunner;
  if (runner === undefined) throw new Error('the skill runner is unwired in this harness');
  return runner;
}

function draftsOf(h: Harness): SkillDraftManager {
  const drafts = h.skillDrafts;
  if (drafts === undefined) throw new Error('the skill drafts manager is unwired in this harness');
  return drafts;
}

function detailOf(h: Harness, id: string): SkillDetail {
  const detail = h.skills?.get(id) ?? null;
  if (detail === null) throw new Error(`skill ${id} is not installed`);
  return detail;
}

/**
 * The broker's own class-refusal row for a tool (what `broker.exec` writes when
 * the envelope refuses), or undefined when the broker was never reached. The two
 * halves are the evidence in their own right: a ROUTE refusal leaves no tool row
 * at all, a BROKER refusal writes one carrying class + capability only.
 */
function toolDenialRow(
  h: Harness,
  toolId: string,
): { actor: string; details: unknown } | undefined {
  const row = h.audit
    .list(500)
    .find((entry) => entry.action === 'capability.denied' && entry.target === toolId);
  if (row === undefined) return undefined;
  return { actor: row.actor, details: JSON.parse(row.details) as unknown };
}

/**
 * The AUTHORED write probe. It declares `files.edit` at the medium risk the
 * broker's own manifest carries, so the skill's risk ceiling is satisfied and
 * neither the registry nor the ceiling can be what refuses a caller: only the
 * class envelope can.
 */
const WRITER_MANIFEST: SkillManifest = {
  id: WRITER_ID,
  name: 'Class Write Probe',
  description: 'proposes one edit through the broker (class-propagation fixture)',
  author: 'tests',
  version: '0.1.0',
  entrypoint: 'entry.mjs',
  permissions: { tools: [WRITE_TOOL], network: false, risk: 'medium' },
  budget: { timeMs: 5000 },
};

/** One brokered files.edit call; the error code is what the worker reports. */
const PROBE_CODE = `export async function run(args = {}) {
  const result = await globalThis.partner.tools.exec('files.edit', {
    projectId: args.projectId,
    path: args.path,
    proposedContent: args.proposedContent,
  });
  return { proposed: typeof result.proposalId === 'string' };
}`;

interface Args {
  projectId: string;
  path: string;
  proposedContent: string;
}

interface Probe {
  projectId: string;
  args: Args;
  /** files-preview (catalog): a granted files.read, medium risk. */
  reader: SkillDetail;
  /** class-write-probe (authored): a granted files.edit, medium risk. */
  writer: SkillDetail;
}

/**
 * The premise of every assertion in this file, built the way a user builds it:
 * one REAL project root holding one file, registered through the route, with
 * USER grants for `files.read` AND `files.edit` on it, plus both probe skills.
 * Each grant is checked at the STORE, not merely by status code - the class
 * envelope sits ABOVE them, so "refused" has to mean "refused despite them".
 */
async function probes(h: Harness, desktop: string): Promise<Probe> {
  const rootPath = tempDir();
  writeFileSync(join(rootPath, 'doc.txt'), 'v1');
  const root = await request(h.app)
    .post('/v1/roots')
    .set(authed(desktop))
    .send({ label: 'class-propagation', path: rootPath });
  expect(root.status).toBe(201);
  const projectId = root.body.id as string;

  for (const toolId of [READ_TOOL, WRITE_TOOL]) {
    const grant = await request(h.app)
      .post('/v1/grants')
      .set(authed(desktop))
      .send({ toolId, projectId });
    expect(grant.status).toBe(201);
    expect(h.broker?.grants.hasGrant(toolId, projectId)).toBe(true);
  }

  const install = await request(h.app)
    .post('/v1/skills/install')
    .set(authed(desktop))
    .send({ catalogId: 'files-preview' });
  expect(install.status).toBe(201);

  const skills = h.skills;
  if (skills === undefined) throw new Error('the skills manager is unwired in this harness');
  skills.installFromBundle(
    { manifest: WRITER_MANIFEST, code: PROBE_CODE },
    { update: false, source: 'authored' },
  );

  return {
    projectId,
    args: { projectId, path: 'doc.txt', proposedContent: 'v2' },
    reader: detailOf(h, 'files-preview'),
    writer: detailOf(h, WRITER_ID),
  };
}

describe('M27 S3 - /v1/skills/:id/invoke carries the session class', () => {
  it('executes a granted READ for a desktop session (route -> runner -> broker)', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const p = await probes(h, desktop);

      const res = await request(h.app)
        .post('/v1/skills/files-preview/invoke')
        .set(authed(desktop))
        .send({ args: { projectId: p.projectId, path: 'doc.txt' } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, result: { bytes: 2, chars: 2 } });
      expect(res.body.meta.toolCalls).toBe(1);
    } finally {
      h.close();
    }
  });

  it('refuses a mobile session at the route, with the grants still in place', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const p = await probes(h, desktop);
      const mobile = await classToken(h, 'mobile');

      const res = await request(h.app)
        .post('/v1/skills/files-preview/invoke')
        .set(authed(mobile))
        .send({ args: { projectId: p.projectId, path: 'doc.txt' } });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        error: 'capability_denied',
        reason: 'capability_denied',
        capability: 'skill.invoke',
        clientClass: 'mobile',
      });

      // The refusal moved nothing: both grants survive, the phone never reached
      // the broker (no tool-level denial row) or the sandbox (no invocation row
      // and no queue entry).
      expect(h.broker?.grants.hasGrant(READ_TOOL, p.projectId)).toBe(true);
      expect(h.broker?.grants.hasGrant(WRITE_TOOL, p.projectId)).toBe(true);
      expect(toolDenialRow(h, READ_TOOL)).toBeUndefined();
      expect(h.skillInvocationStore.listBySkill('files-preview', 10)).toEqual([]);
      expect(h.pendingStore.listOpen()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('refuses the granted WRITE at the broker for a mobile class (the M20-B S4 case)', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const p = await probes(h, desktop);

      // The class a mobile session row carries, handed to the runner exactly as
      // the route hands it over. Both grants exist, both skills declare their
      // tool and both risk ceilings are satisfied.
      const readOut = await runnerOf(h).invoke(
        p.reader,
        { projectId: p.projectId, path: 'doc.txt' },
        { clientClass: 'mobile' },
      );

      const writeOut = await runnerOf(h).invoke(p.writer, p.args, { clientClass: 'mobile' });
      expect(writeOut.ok).toBe(false);
      if (!writeOut.ok) expect(writeOut.error).toBe('capability_denied');
      expect(writeOut.meta).toMatchObject({ ok: false, error: 'capability_denied', toolCalls: 1 });

      // The refusal is the ENVELOPE, not a missing grant and not the skill's own
      // gates: the files.edit grant survives, the broker never queued an
      // approval (it checks the class before params, root and grant), and no
      // proposal was created - the phone wrote nothing.
      expect(h.broker?.grants.hasGrant(WRITE_TOOL, p.projectId)).toBe(true);
      expect(h.pendingStore.listOpen()).toEqual([]);
      expect(h.proposalStore.listOpen()).toEqual([]);
      const row = toolDenialRow(h, WRITE_TOOL);
      expect(row?.actor).toBe('tool');
      expect(row?.details).toEqual({ clientClass: 'mobile', capability: 'file.write' });
      expect(h.skillInvocationStore.listBySkill(WRITER_ID, 10)).toMatchObject([
        { skillId: WRITER_ID, ok: 0, toolCalls: 1, error: 'capability_denied' },
      ]);

      // The class is per-CAPABILITY, not a blanket refusal of a narrow client:
      // the SAME mobile context may still READ, because the envelope table hands
      // `file.read` to mobile (capabilities.ts; PLAN-M27 D3 depends on it).
      expect(readOut.ok).toBe(true);
      if (readOut.ok) expect(readOut.result).toEqual({ bytes: 2, chars: 2 });

      // And the very same call from the desktop class executes, so the refusal
      // above is the class and nothing else.
      const desktopOut = await runnerOf(h).invoke(p.writer, p.args, { clientClass: 'desktop' });
      expect(desktopOut.ok).toBe(true);
      if (desktopOut.ok) expect(desktopOut.result).toEqual({ proposed: true });
      expect(h.proposalStore.listOpen()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('keeps the desktop envelope when NO class is given (the internal/session-less path)', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const p = await probes(h, desktop);

      // A persona, schedule or playbook run has no session: an absent class is
      // the documented "internal caller" case and stays the desktop envelope,
      // which is what those paths had before M27.
      const out = await runnerOf(h).invoke(p.writer, p.args);
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result).toEqual({ proposed: true });
      expect(toolDenialRow(h, WRITE_TOOL)).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it('takes the class from the session row, never from the body', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const p = await probes(h, desktop);
      const mobile = await classToken(h, 'mobile');

      // Raising: a mobile session offering 'desktop' in the body is still the
      // mobile session row, so it is refused and nothing executes.
      const raised = await request(h.app)
        .post(`/v1/skills/${WRITER_ID}/invoke`)
        .set(authed(mobile))
        .send({ args: p.args, clientClass: 'desktop' });
      expect(raised.status).toBe(403);
      expect(raised.body).toMatchObject({
        reason: 'capability_denied',
        capability: 'skill.invoke',
        clientClass: 'mobile',
      });
      expect(h.proposalStore.listOpen()).toEqual([]);

      // Setting: a desktop session offering 'mobile' in the body still runs -
      // and that is the observable proof the class reaching the broker came from
      // the row. Were the body honoured, the runner would have passed 'mobile'
      // and this granted write would have come back capability_denied.
      const lowered = await request(h.app)
        .post(`/v1/skills/${WRITER_ID}/invoke`)
        .set(authed(desktop))
        .send({ args: p.args, clientClass: 'mobile' });
      expect(lowered.status).toBe(200);
      expect(lowered.body).toMatchObject({ ok: true, result: { proposed: true } });
    } finally {
      h.close();
    }
  });
});

/** A draft whose entry makes ONE brokered files.edit call, like /invoke. */
async function writeDraft(h: Harness): Promise<string> {
  const drafts = draftsOf(h);
  const created = await drafts.create({
    mode: 'manual',
    name: 'Propose One Edit',
    description: 'dry-run fixture for the session class',
  });
  drafts.update(created.id, {
    manifestText: JSON.stringify(
      {
        id: created.id,
        name: 'Propose One Edit',
        description: 'proposes one edit through the broker',
        author: 'You',
        version: '0.1.0',
        entrypoint: 'entry.mjs',
        permissions: { tools: [WRITE_TOOL], network: false, risk: 'medium' },
        budget: { timeMs: 5000 },
      },
      null,
      2,
    ),
    code: PROBE_CODE,
  });
  return created.id;
}

describe('M27 S3 - the dry-run route carries the same class', () => {
  it('runs the draft for a desktop session and ignores a class in the body', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const p = await probes(h, desktop);
      const id = await writeDraft(h);

      const run = await request(h.app)
        .post(`/v1/skills/drafts/${id}/run`)
        .set(authed(desktop))
        .send({ args: p.args });
      expect(run.status).toBe(200);
      expect(run.body).toMatchObject({ ok: true, result: { proposed: true } });

      // The dry-run reaches the SAME runner, so a body-supplied class would be
      // just as reachable here as on /invoke: it changes nothing.
      const viaBody = await request(h.app)
        .post(`/v1/skills/drafts/${id}/run`)
        .set(authed(desktop))
        .send({ args: p.args, clientClass: 'mobile' });
      expect(viaBody.status).toBe(200);
      expect(viaBody.body).toMatchObject({ ok: true, result: { proposed: true } });
    } finally {
      h.close();
    }
  });

  it('refuses a mobile session on the dry-run too, leaving the grant and draft alone', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const p = await probes(h, desktop);
      const id = await writeDraft(h);
      const mobile = await classToken(h, 'mobile');

      const run = await request(h.app)
        .post(`/v1/skills/drafts/${id}/run`)
        .set(authed(mobile))
        .send({ args: p.args, clientClass: 'desktop' });
      expect(run.status).toBe(403);
      expect(run.body).toMatchObject({
        error: 'capability_denied',
        reason: 'capability_denied',
        capability: 'skill.author',
        clientClass: 'mobile',
      });

      expect(h.broker?.grants.hasGrant(WRITE_TOOL, p.projectId)).toBe(true);
      expect(draftsOf(h).get(id)?.status).toBe('draft');
      expect(h.proposalStore.listOpen()).toEqual([]);
      expect(h.audit.list(500).filter((row) => row.action === 'skill.draft.run')).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('threads the class through runDraft: mobile refused, desktop and absent execute', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const p = await probes(h, desktop);
      const id = await writeDraft(h);
      const drafts = draftsOf(h);

      // The class the run route reads off a mobile session row.
      const mobileRun = await drafts.runDraft(id, { args: p.args, clientClass: 'mobile' });
      expect(mobileRun.ok).toBe(false);
      if (!mobileRun.ok) expect(mobileRun.error).toBe('capability_denied');
      expect(h.broker?.grants.hasGrant(WRITE_TOOL, p.projectId)).toBe(true);
      expect(h.pendingStore.listOpen()).toEqual([]);
      expect(h.proposalStore.listOpen()).toEqual([]);
      expect(toolDenialRow(h, WRITE_TOOL)?.details).toEqual({
        clientClass: 'mobile',
        capability: 'file.write',
      });

      const desktopRun = await drafts.runDraft(id, { args: p.args, clientClass: 'desktop' });
      expect(desktopRun).toMatchObject({ ok: true, result: { proposed: true } });

      // Absent = no session (an internal caller), so the desktop envelope.
      const internalRun = await drafts.runDraft(id, { args: p.args });
      expect(internalRun).toMatchObject({ ok: true, result: { proposed: true } });
    } finally {
      h.close();
    }
  });
});
