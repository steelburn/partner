/**
 * M26 cut E - the sandboxed DRAFT DRY-RUN (PLAN-M26.md D5).
 *
 * The property this file exists for: a draft runs ONLY when the owner asks, and
 * when it does it runs in the REAL sandbox - a forked node process whose cwd is
 * the bundle the core just materialized - so the author sees what the worker
 * saw. Above all the worker's own log lines when the entry dies at import time,
 * which is the difference between "crashed" and knowing why.
 *
 * The paired invariants, each asserted below:
 *   · a dry-run is not history: no skill_invocations row, but one
 *     skill.draft.run audit row carrying counts only;
 *   · the materialized dir is wiped after the run, whatever the outcome;
 *   · the coded failures (budget_exceeded / crashed / caps_exceeded /
 *     tool_denied / skill_error) come back as run outcomes, not as 500s;
 *   · a build with no runner refuses a dry-run by name.
 *
 * `integrity` cannot arise here (a draft passes sha256 '', so the runner skips
 * the install-time hash check - pinned in runner.test.ts, together with the case
 * where a hash IS recorded and dirOverride still refuses tampered code).
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { loadConfig } from '../../src/config.js';
import type { SkillDraftManager } from '../../src/skills/drafts.js';
import { SkillError } from '../../src/skills/errors.js';

function draftsOf(h: Harness): SkillDraftManager {
  const drafts = h.skillDrafts;
  if (drafts === undefined) throw new Error('the harness wired no draft manager');
  return drafts;
}

/** Await a refusal and report its SkillError code. */
async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no-error';
  } catch (err) {
    return err instanceof SkillError ? err.code : `other:${String(err)}`;
  }
}

/**
 * Create a draft that VALIDATES, so the dry-run has a real bundle to
 * materialize: only the entry source (and optionally the budget) varies per
 * test, which is what keeps each test about one run outcome.
 */
async function draft(
  h: Harness,
  options: { name: string; code: string; budget?: { timeMs: number } },
): Promise<string> {
  const drafts = draftsOf(h);
  const created = await drafts.create({
    mode: 'manual',
    name: options.name,
    description: 'a dry-run fixture',
  });
  const manifest = {
    id: created.id,
    name: options.name,
    description: 'a dry-run fixture',
    author: 'tests',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: { tools: [], network: false, risk: 'low' },
    budget: options.budget ?? { timeMs: 10_000 },
  };
  const updated = drafts.update(created.id, {
    manifestText: JSON.stringify(manifest),
    code: options.code,
  });
  if (!updated.validation.ok) {
    throw new Error(`fixture does not validate: ${updated.validation.errors.join('; ')}`);
  }
  return created.id;
}

describe('M26 draft dry-run', () => {
  it('runs in the real sandbox, from a materialized dir it wipes afterwards', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const id = await draft(h, {
        name: 'Sandbox Probe',
        code: [
          "import { existsSync } from 'node:fs';",
          "import { join } from 'node:path';",
          'export function run() {',
          '  const cwd = process.cwd();',
          '  return {',
          '    pid: process.pid,',
          '    hasIpc: typeof process.send === "function",',
          '    hasManifest: existsSync(join(cwd, "manifest.json")),',
          '    hasEntry: existsSync(join(cwd, "entry.mjs")),',
          '    cwd,',
          '  };',
          '}',
        ].join('\n'),
      });

      const run = await drafts.runDraft(id, { args: { ignored: true } });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      const result = run.result as {
        pid: number;
        hasIpc: boolean;
        hasManifest: boolean;
        hasEntry: boolean;
        cwd: string;
      };
      // A full node process, not the test's own: the dry-run is the real
      // launcher, not a second implementation of it.
      expect(result.pid).not.toBe(process.pid);
      expect(result.hasIpc).toBe(true);
      // cwd is INSIDE the bundle the core wrote: manifest.json and the row's
      // entry file sit next to it, in a dir named after the draft (and a uuid).
      expect(result.hasManifest).toBe(true);
      expect(result.hasEntry).toBe(true);
      expect(basename(result.cwd).startsWith(`${id}-`)).toBe(true);
      // ...and the dir is gone once the run has settled (wiped in a finally).
      expect(existsSync(result.cwd)).toBe(false);

      expect(run.logs).toEqual([]);
      expect(typeof run.ms).toBe('number');
      // A dry-run installs nothing: the sandbox ran a bundle that lives in
      // scratch space, and the skills store is untouched.
      expect(h.skills?.list()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('returns the worker own redacted log lines when the entry throws at import time', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const id = await draft(h, {
        name: 'Load Failure',
        code: [
          "globalThis.partner.log('token=sk-abcdefgh12345678');",
          "throw new Error('boom at import');",
          'export function run() { return { never: true }; }',
        ].join('\n'),
      });

      const run = await drafts.runDraft(id);
      expect(run.ok).toBe(false);
      if (run.ok) return;
      expect(run.error).toBe('crashed');
      const joined = run.logs.join('\n');
      // This is the whole point of D5: the author sees WHY the run died
      // instead of an opaque `crashed`.
      expect(joined).toContain('skill load failed');
      expect(joined).toContain('boom at import');
      // ...and never a secret, even on the failure path.
      expect(joined).toContain('***[redacted]');
      expect(joined).not.toContain('sk-abcdefgh12345678');
    } finally {
      h.close();
    }
  });

  it('honours the manifest budget, and timeoutMs can only shorten it', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const id = await draft(h, {
        name: 'Never Returns',
        code: 'export function run(){ while (true) {} }',
        budget: { timeMs: 60_000 },
      });

      const run = await drafts.runDraft(id, { timeoutMs: 400 });
      expect(run.ok).toBe(false);
      if (run.ok) return;
      expect(run.error).toBe('budget_exceeded');
      // The 60s manifest budget was clamped DOWN by timeoutMs: without the
      // clamp this assertion could not be reached inside a test.
      expect(run.ms).toBeLessThan(5000);
    } finally {
      h.close();
    }
  });

  it('maps a result over the 1 MiB cap to caps_exceeded', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const id = await draft(h, {
        name: 'Fat Result',
        code: `export function run(){ return { blob: 'x'.repeat(${2 * 1024 * 1024}) }; }`,
      });
      const run = await drafts.runDraft(id);
      expect(run.ok).toBe(false);
      if (!run.ok) expect(run.error).toBe('caps_exceeded');
    } finally {
      h.close();
    }
  });

  it('refuses a tool the manifest does not declare (tool_denied)', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const id = await draft(h, {
        name: 'Undeclared Reach',
        code: [
          'export function run() {',
          '  return partner.tools.exec("files.read", { projectId: "x", path: "a" });',
          '}',
        ].join('\n'),
      });

      const run = await drafts.runDraft(id);
      expect(run.ok).toBe(false);
      if (run.ok) return;
      expect(run.error).toBe('tool_denied');
      // The attempt is counted, and no approval row is left dangling: a skill
      // (and a dry-run) is non-interactive, so a missing grant is a hard deny.
      expect(h.broker?.pending.list()).toEqual([]);
      const row = h.audit.list(100).find((entry) => entry.action === 'skill.draft.run');
      expect(JSON.parse(row?.details ?? '{}')).toMatchObject({
        ok: false,
        error: 'tool_denied',
        toolCalls: 1,
      });
    } finally {
      h.close();
    }
  });

  it('maps a throw inside run() to skill_error', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const id = await draft(h, {
        name: 'Runtime Throw',
        code: 'export function run(){ throw new Error("nope"); }',
      });
      const run = await drafts.runDraft(id);
      expect(run.ok).toBe(false);
      if (!run.ok) expect(run.error).toBe('skill_error');
    } finally {
      h.close();
    }
  });

  it('writes no skill_invocations row and one skill.draft.run audit row, counts only', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const id = await draft(h, {
        name: 'Quiet Run',
        code: 'export function run(){ return { ok: true }; }',
      });

      const run = await drafts.runDraft(id);
      expect(run.ok).toBe(true);

      // A dry-run is not history.
      expect(h.skillInvocationStore.listBySkill(id, 10)).toEqual([]);
      // One draft-run audit row, and it carries ids/counts only.
      const rows = h.audit.list(200).filter((row) => row.action === 'skill.draft.run');
      expect(rows).toHaveLength(1);
      const details = JSON.parse(rows[0]?.details ?? '{}') as Record<string, unknown>;
      expect(Object.keys(details).sort()).toEqual(['error', 'ms', 'ok', 'toolCalls']);
      expect(details).toMatchObject({ ok: true, error: null, toolCalls: 0 });

      // The runner's own skill.invoke row still lands (a run is auditable
      // either way) - and it also carries counts, never the log lines.
      expect(h.audit.list(200).filter((row) => row.action === 'skill.invoke')).toHaveLength(1);

      const serialized = JSON.stringify(h.audit.list(200).map((row) => row.details));
      expect(serialized).not.toContain('export function run');
      expect(serialized).not.toContain('a dry-run fixture');
    } finally {
      h.close();
    }
  });

  it('refuses a draft that does not validate, and a nonsense timeoutMs', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const created = await drafts.create({
        mode: 'manual',
        name: 'Broken',
        description: '',
      });
      drafts.update(created.id, { manifestText: '{ not json' });
      expect(await codeOfAsync(() => drafts.runDraft(created.id))).toBe('invalid_input');

      const id = await draft(h, {
        name: 'Fine',
        code: 'export function run(){ return 1; }',
      });
      expect(await codeOfAsync(() => drafts.runDraft(id, { timeoutMs: -1 }))).toBe('invalid_input');
      expect(await codeOfAsync(() => drafts.runDraft(id, { timeoutMs: 0 }))).toBe('invalid_input');
    } finally {
      h.close();
    }
  });

  it('refuses a dry run of a draft that has already been installed', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const id = await draft(h, {
        name: 'Shipped',
        code: 'export function run(){ return 1; }',
      });
      drafts.promote(id);
      // Same rule as validate/update: once a draft has shipped, its code is the
      // installed skill's code, and a dry-run of it would be a second, quieter
      // way to run something outside the installed surface.
      expect(await codeOfAsync(() => drafts.runDraft(id))).toBe('conflict');
    } finally {
      h.close();
    }
  });

  it('refuses a dry run by name when the runner is not wired', async () => {
    const h = demoHarness({ skillDraftRunner: false });
    try {
      const drafts = draftsOf(h);
      const id = await draft(h, {
        name: 'No Sandbox',
        code: 'export function run(){ return 1; }',
      });
      const err = await drafts
        .runDraft(id)
        .then(() => null)
        .catch((error: SkillError) => error);
      expect(err).toBeInstanceOf(SkillError);
      expect(err?.code).toBe('invalid_input');
      expect(err?.message).toContain('runner');
      // Drafting and validating still work without a sandbox; only the run is
      // refused, and nothing was executed.
      expect(drafts.get(id)?.validation.ok).toBe(true);
    } finally {
      h.close();
    }
  });
});

/**
 * The scratch root the dry-run materializes into is core OWNED state
 * (config.skillRunsDir), so its derivation is pinned here beside the runs that
 * depend on it: the same rule as `skillsDir`, and an env override that wins.
 */
describe('M26 dry-run scratch root (config.skillRunsDir)', () => {
  it('derives from the DB location, separately from the store, and honours the override', () => {
    const demo = loadConfig({ DEMO_MODE: '1' });
    expect(demo.dbPath).toBe(':memory:');
    expect(demo.skillRunsDir).toBe(join(tmpdir(), 'partner-draft-runs'));
    // Never the installed store: a dry-run bundle lives in scratch space.
    expect(demo.skillRunsDir).not.toBe(demo.skillsDir);

    const live = loadConfig({ DEMO_MODE: '0' });
    expect(live.skillRunsDir).toBe(join(dirname(live.dbPath), 'skill-runs'));

    expect(
      loadConfig({ DEMO_MODE: '1', SKILL_RUNS_DIR: '/custom/runs' }).skillRunsDir,
    ).toBe('/custom/runs');
  });
});
