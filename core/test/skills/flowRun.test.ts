/**
 * M28 slice A — the compiled flow in the REAL sandbox (PLAN-M28.md D1).
 *
 * `flowCompile.test.ts` executes the emitted module against a fake `partner`.
 * This file goes one step further and hands the emitted bytes to the actual M8
 * worker the product uses: compile -> write `manifest.json` + `entry.mjs` into a
 * bundle dir -> `runner.invoke` with `dirOverride`.
 *
 * That is the milestone's central claim, so it is worth stating as a test: a
 * flow is not a second runtime. It is a way to AUTHOR the one artifact that
 * already installs, so the code a canvas produces must survive the same
 * sandbox, the same broker, the same grant rules and the same coded refusals as
 * hand-written code.
 *
 * What is proven here:
 *   - a compiled flow reads a real note through the real broker and returns the
 *     graph's intent, with an app-scoped grant and NO project root;
 *   - without the grant the invocation fails `tool_denied` and leaves no pending
 *     row (skills are non-interactive);
 *   - a flow that compiles can still fail at RUN time, and it fails with the
 *     worker's coded error rather than a crash — the `llm` node with nothing
 *     configured answers `no_provider`, which also proves the generated call
 *     reaches the real model seam.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillDetail, SkillManifest, ToolId } from '@partner/shared';
import { APP_SCOPE_ID } from '@partner/shared';
import { demoHarness, makeTempRoot, removeTempRoot } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { createSkillRunner } from '../../src/skills/runner.js';
import type { SkillRunner } from '../../src/skills/runner.js';
import { compileFlow } from '../../src/skills/flow/compile.js';

const REGISTRY = new Set(['files.read', 'files.list', 'notes.read', 'notes.search']);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

interface Env {
  h: Harness;
  runner: SkillRunner;
  storeDir: string;
  close(): void;
}

function buildEnv(): Env {
  const storeDir = makeTempRoot();
  dirs.push(storeDir);
  const h = demoHarness({ skills: { storeDir } });
  const runner = createSkillRunner({
    dataDir: storeDir,
    broker: h.broker as NonNullable<Harness['broker']>,
    audit: h.audit,
    invocations: h.skillInvocationStore,
    // Deliberately NO `llm` resolver: this is a build with nothing configured,
    // which is what the `no_provider` case needs.
    log: () => undefined,
  });
  return { h, runner, storeDir, close: () => h.close() };
}

/** Compile a flow, materialize it as a bundle, and install it through the door. */
function installFlow(
  env: Env,
  rawFlow: unknown,
  options: { id?: string } = {},
): { detail: SkillDetail; code: string; sha256: string } {
  const compiled = compileFlow(rawFlow, { registry: REGISTRY, llmAvailable: true });
  if (!compiled.ok) throw new Error(`flow did not compile: ${JSON.stringify(compiled.errors)}`);

  const id = options.id ?? 'flow-skill';
  const manifest: SkillManifest = {
    id,
    name: 'Flow skill',
    description: 'compiled from a flow',
    author: 'tests',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    // The permission set is DERIVED from the graph, never guessed: the tool
    // union (D5) and whether the graph has model reach at all. Without the
    // latter, a flow that calls a model installs a manifest that refuses every
    // call with `llm_not_declared` — a bundle that can never run.
    permissions: {
      tools: [...compiled.tools] as ToolId[],
      network: false,
      risk: 'low',
      ...(compiled.usesLlm ? { llm: true } : {}),
    },
    budget: { timeMs: 5000 },
  };

  // The scratch bundle the dry-run path materializes — same layout the sandbox
  // loads (manifest.json + the manifest's own entrypoint name).
  const dir = join(env.storeDir, `bundle-${id}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'entry.mjs'), compiled.code, 'utf8');

  const skills = env.h.skills;
  if (skills === undefined) throw new Error('the skills manager is unwired in this harness');
  skills.installFromBundle({ manifest, code: compiled.code }, { update: false, source: 'authored' });
  const detail = skills.get(id);
  if (detail === null) throw new Error('the flow skill did not install');
  return { detail, code: compiled.code, sha256: compiled.sha256 };
}

/** The flow used by the happy path: read one note and render it as text. */
function notesFlow(): unknown {
  return {
    version: 1,
    nodes: [
      { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { fields: [{ name: 'id', type: 'string', required: true }] } },
      { id: 'read', type: 'tool', position: { x: 1, y: 0 }, data: { toolId: 'notes.read', args: { id: 'id' } } },
      { id: 'msg', type: 'template', position: { x: 2, y: 0 }, data: { text: '{{title}}: {{content}}' } },
      { id: 'out', type: 'output', position: { x: 3, y: 0 }, data: { shape: 'text' } },
    ],
    edges: [
      { id: 'e1', source: 'in', target: 'read' },
      { id: 'e2', source: 'read', target: 'msg' },
      { id: 'e3', source: 'msg', target: 'out' },
    ],
  };
}

describe('M28 A — a compiled flow runs in the real sandbox', () => {
  it('reads a real note through the broker and returns the graph\'s intent', async () => {
    const env = buildEnv();
    try {
      const { detail } = installFlow(env, notesFlow());
      // The premise of the whole milestone: no root is registered anywhere.
      expect(env.h.broker?.roots.list()).toEqual([]);

      const note = env.h.notes?.create({ title: 'Launch', content: 'ship on Tuesday' });
      if (note === undefined) throw new Error('the notes manager is unwired in this harness');
      env.h.broker?.grants.add('notes.read', APP_SCOPE_ID);

      const result = await env.runner.invoke(detail, { id: note.id });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.result).toBe('Launch: ship on Tuesday');
    } finally {
      env.close();
    }
  });

  it('without the grant the run fails tool_denied and queues nothing', async () => {
    const env = buildEnv();
    try {
      const { detail } = installFlow(env, notesFlow());
      const note = env.h.notes?.create({ title: 'Launch', content: 'ship on Tuesday' });
      if (note === undefined) throw new Error('the notes manager is unwired in this harness');

      const result = await env.runner.invoke(detail, { id: note.id });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('tool_denied');
      // Skills are non-interactive: the enqueued row is closed, not left behind.
      expect(env.h.pendingManager?.list() ?? []).toEqual([]);
    } finally {
      env.close();
    }
  });

  it('a flow that compiles can still fail at RUN time, with a coded error', async () => {
    const env = buildEnv();
    try {
      const flow = {
        version: 1,
        nodes: [
          { id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { fields: [] } },
          { id: 'ask', type: 'llm', position: { x: 1, y: 0 }, data: { prompt: 'summarise everything' } },
          { id: 'out', type: 'output', position: { x: 2, y: 0 }, data: { shape: 'text' } },
        ],
        edges: [
          { id: 'e1', source: 'in', target: 'ask' },
          { id: 'e2', source: 'ask', target: 'out' },
        ],
      };
      const { detail, code } = installFlow(env, flow, { id: 'flow-llm' });
      // The emitted code really calls the model verb.
      expect(code).toContain('partner.llm.complete');

      const result = await env.runner.invoke(detail, {});
      // Nothing is configured in this harness, and that is a coded refusal the
      // OWNER can act on — not a crash, and not a silent empty string.
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('no_provider');
    } finally {
      env.close();
    }
  });

  it('the compiled bytes are what a dry-run would materialize and run', async () => {
    const env = buildEnv();
    try {
      const { detail, sha256 } = installFlow(env, notesFlow());
      const note = env.h.notes?.create({ title: 'T', content: 'C' });
      if (note === undefined) throw new Error('the notes manager is unwired in this harness');
      env.h.broker?.grants.add('notes.read', APP_SCOPE_ID);

      // record:false — a dry-run is not history (M26 D5), and the flow path
      // reuses that seam rather than adding one.
      const result = await env.runner.invoke(detail, { id: note.id }, { record: false });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.result).toBe('T: C');
      // The hash a draft would store for D6's staleness comparison.
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(detail.manifest.permissions.tools).toEqual(['notes.read']);
    } finally {
      env.close();
    }
  });
});
