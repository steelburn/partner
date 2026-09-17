/**
 * M27 S1 — a SKILL that reaches the user's notes, end to end (PLAN-M27.md).
 *
 * `notesTools.test.ts` pins the broker contract. This file pins the thing the
 * slice was FOR: an installed skill declaring `notes.read` runs in the real
 * sandbox, gets the note body back, and is refused when it asks without the
 * grant — with **no project root registered anywhere**, which was impossible
 * before S1 (the broker resolved a root before it ever checked a grant).
 *
 * The refusal shape matters as much as the success: skills are NON-INTERACTIVE
 * (M8), so a missing grant is a hard `tool_denied` to the worker and the
 * just-enqueued pending row is closed, not left for the user to approve. The
 * owner grants app reach BEFORE invoking.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillDetail, SkillManifest, ToolId } from '@partner/shared';
import { APP_SCOPE_ID } from '@partner/shared';
import { demoHarness, makeTempRoot, removeTempRoot } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { createSkillRunner } from '../../src/skills/runner.js';
import type { SkillRunner } from '../../src/skills/runner.js';

const SKILL_ID = 'notes-reader';
/** Distinctive strings: the leak assertions search the audit rows for these. */
const BODY_MARKER = 'NOTE-BODY-MARKER the launch is on Tuesday';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

/** Reports the note body, or the coded refusal — never throws. */
const ENTRY = `export async function run(args = {}) {
  try {
    const out = await globalThis.partner.tools.exec('notes.read', { id: args.id });
    globalThis.partner.log('read ' + out.title);
    return { title: out.title, content: out.content };
  } catch (err) {
    globalThis.partner.log('notes.read refused: ' + err.code);
    return { refused: err.code };
  }
}`;

interface Env {
  h: Harness;
  runner: SkillRunner;
  lines(): string[];
  close(): void;
}

function buildEnv(): Env {
  const storeDir = makeTempRoot();
  dirs.push(storeDir);
  const h = demoHarness({ skills: { storeDir } });
  const lines: string[] = [];
  const runner = createSkillRunner({
    dataDir: storeDir,
    broker: h.broker as NonNullable<Harness['broker']>,
    audit: h.audit,
    invocations: h.skillInvocationStore,
    log: (line) => {
      lines.push(line);
    },
  });
  return { h, runner, lines: () => lines, close: () => h.close() };
}

function installNotesSkill(h: Harness, tools: readonly ToolId[] = ['notes.read']): SkillDetail {
  const manifest: SkillManifest = {
    id: SKILL_ID,
    name: 'Notes reader',
    description: "reads one of the user's notes",
    author: 'tests',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: { tools: [...tools], network: false, risk: 'low' },
    budget: { timeMs: 5000 },
  };
  const skills = h.skills;
  if (skills === undefined) throw new Error('the skills manager is unwired in this harness');
  skills.installFromBundle({ manifest, code: ENTRY }, { update: false, source: 'authored' });
  const detail = skills.get(SKILL_ID);
  if (detail === null) throw new Error('the notes skill did not install');
  return detail;
}

describe('M27 S1 — a skill reaches notes with no project root', () => {
  it('installs a manifest declaring notes.read, then reads a note once granted', async () => {
    const env = buildEnv();
    try {
      const h = env.h;
      const detail = installNotesSkill(h);

      // The premise: no root exists, and the skill installs anyway.
      expect(h.broker?.roots.list()).toEqual([]);
      expect(detail.manifest.permissions.tools).toEqual(['notes.read']);

      const note = h.notes?.create({ title: 'Launch plan', content: BODY_MARKER });
      if (note === undefined) throw new Error('the notes manager is unwired in this harness');

      // Ungranted: a coded denial, and NO row left in the approval queue.
      const refused = await env.runner.invoke(detail, { id: note.id });
      expect(refused.ok).toBe(true);
      if (refused.ok) expect(refused.result).toMatchObject({ refused: 'tool_denied' });
      expect(h.pendingManager?.list() ?? []).toEqual([]);

      // The owner grants app reach (not a root), and the run succeeds.
      h.broker?.grants.add('notes.read', APP_SCOPE_ID);
      const ok = await env.runner.invoke(detail, { id: note.id });
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        expect(ok.result).toMatchObject({ title: 'Launch plan', content: BODY_MARKER });
      }
      // Still no roots: app reach never registers one.
      expect(h.broker?.roots.list()).toEqual([]);
    } finally {
      env.close();
    }
  });

  it('refuses a tool the manifest did not declare, even when the grant exists', async () => {
    const env = buildEnv();
    try {
      // The skill declares notes.list; it ASKS for notes.read anyway.
      const detail = installNotesSkill(env.h, ['notes.list']);
      env.h.broker?.grants.add('notes.read', APP_SCOPE_ID);
      env.h.broker?.grants.add('notes.list', APP_SCOPE_ID);
      const note = env.h.notes?.create({ title: 'Launch plan', content: BODY_MARKER });
      if (note === undefined) throw new Error('the notes manager is unwired in this harness');

      const res = await env.runner.invoke(detail, { id: note.id });
      expect(res.ok).toBe(true);
      // The manifest ceiling is the control, not the grant.
      if (res.ok) expect(res.result).toMatchObject({ refused: 'tool_denied' });
    } finally {
      env.close();
    }
  });

  it('never writes the note body to an audit row', async () => {
    const env = buildEnv();
    try {
      const detail = installNotesSkill(env.h);
      env.h.broker?.grants.add('notes.read', APP_SCOPE_ID);
      const note = env.h.notes?.create({ title: 'Launch plan', content: BODY_MARKER });
      if (note === undefined) throw new Error('the notes manager is unwired in this harness');

      const res = await env.runner.invoke(detail, { id: note.id });
      expect(res.ok).toBe(true);

      const text = (env.h.audit.list(1000) as unknown as Array<{ action: string; target: string; details: string }>)
        .map((row) => `${row.action} ${row.target} ${row.details}`)
        .join('\n');
      expect(text).not.toContain(BODY_MARKER);
      // The trace that IS kept: the tool acted, on the app scope, with a length.
      expect(text).toContain('notes.read.executed');
      expect(text).toContain(`"result.chars":${BODY_MARKER.length}`);
    } finally {
      env.close();
    }
  });
});
