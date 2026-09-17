/**
 * M28 slice B — flow/code coherence (PLAN-M28.md D1/D5/D6).
 *
 * The question these tests answer is the one D6 exists for: **can the draft
 * disagree with its own graph without anybody noticing?** The answer has to be
 * "yes, but it SAYS so", and the saying has to be derived rather than stored —
 * that is what makes a hand-edit that restores the compiled bytes clear the
 * warning by itself, with no flag to reset.
 *
 * Three properties are pinned here, at the manager level (the HTTP surface is
 * `core/test/http/skillFlowRoutes.test.ts`):
 *
 *   1. `flowStale` is a live comparison of `sha256(code)` against the hash the
 *      flow last compiled to — a hand-edit makes it stale, restoring the bytes
 *      clears it, and the row keeps recording what the flow compiled to either
 *      way (nothing about the state is stored twice).
 *   2. A save is NOT a compile: `saveFlow` writes the graph and leaves `code`
 *      exactly as it was.
 *   3. **A STALE DRAFT STILL INSTALLS AND RUNS.** Staleness is UI honesty, never
 *      a security state: install consumes `code`, which the install path
 *      re-validates. The last test asserts it by installing a stale draft whose
 *      hand-edited behaviour differs from the flow, and RUNNING it — so if a
 *      later change "helpfully" blocks a stale install, this fails loudly instead
 *      of quietly redefining what install means.
 */
import { describe, expect, it } from 'vitest';
import type { SkillFlow } from '@partner/shared';
import { demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import type { SkillDraftManager } from '../../src/skills/drafts.js';

function draftsOf(h: Harness): SkillDraftManager {
  if (h.skillDrafts === undefined) throw new Error('the drafts manager is unwired');
  return h.skillDrafts;
}

/** The smallest useful flow: args -> template -> text output. No tools, no model. */
function textFlow(text: string): SkillFlow {
  return {
    version: 1,
    nodes: [
      {
        id: 'in',
        type: 'input',
        position: { x: 0, y: 0 },
        data: { fields: [{ name: 'text', type: 'string', required: true }] },
      },
      { id: 'msg', type: 'template', position: { x: 1, y: 0 }, data: { text } },
      { id: 'out', type: 'output', position: { x: 2, y: 0 }, data: { shape: 'text' } },
    ],
    edges: [
      { id: 'e0', source: 'in', target: 'msg' },
      { id: 'e1', source: 'msg', target: 'out' },
    ],
  };
}

const FLOW_TEXT = '{{text}} from the flow';
const HAND_EDIT_TEXT = '{{text}} from the hand edit';

describe('M28 B — flow/code coherence is derived (D6)', () => {
  it('compiles, goes stale on a hand-edit, and clears when the compiled bytes are restored', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const draft = await drafts.create({ mode: 'manual', name: 'Text shaper', description: '' });

      // A code-authored draft has no flow, so there is nothing to be stale about.
      expect(drafts.getFlow(draft.id)).toEqual({
        flow: null,
        flowCompiledAt: null,
        flowStale: false,
      });

      const saved = drafts.saveFlow(draft.id, textFlow(FLOW_TEXT));
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.flow?.nodes).toHaveLength(3);
      // A flow that has never compiled IS stale: its code cannot be the flow's
      // output. That is what makes the Studio offer Recompile on a fresh graph.
      expect(saved.flowStale).toBe(true);
      expect(saved.flowCompiledAt).toBeNull();
      // A save is not a compile (D1): the entry source is untouched.
      expect(drafts.get(draft.id)?.code).toBe(draft.code);

      const compiled = drafts.compileFlow(draft.id);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      expect(compiled.tools).toEqual([]);
      expect(compiled.sha256).toMatch(/^[0-9a-f]{64}$/);

      const fresh = drafts.get(draft.id);
      expect(fresh?.code).toBe(compiled.code);
      expect(fresh?.flowSha256).toBe(compiled.sha256);
      expect(fresh?.flowStale).toBe(false);
      const state = drafts.getFlow(draft.id);
      expect(state.flowStale).toBe(false);
      expect(typeof state.flowCompiledAt).toBe('number');

      // The hand-edit: same draft, different bytes. Nothing is stored to say so.
      const edited = compiled.code.replace(' from the flow', ' from the hand edit');
      expect(edited).not.toBe(compiled.code);
      expect(drafts.update(draft.id, { code: edited }).flowStale).toBe(true);
      expect(drafts.getFlow(draft.id).flowStale).toBe(true);
      // The row still records the hash the flow compiled to — the comparison is
      // the only place the two are brought together.
      expect(drafts.get(draft.id)?.flowSha256).toBe(compiled.sha256);

      // Restoring the compiled bytes clears it BY ITSELF.
      expect(drafts.update(draft.id, { code: compiled.code }).flowStale).toBe(false);
      expect(drafts.getFlow(draft.id).flowStale).toBe(false);
    } finally {
      h.close();
    }
  });

  it('installs AND RUNS a stale draft — install consumes the code, not the flow', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const skills = h.skills;
      const runner = h.skillRunner;
      if (skills === undefined || runner === undefined) {
        throw new Error('the skills manager/runner is unwired in this harness');
      }

      const draft = await drafts.create({
        mode: 'manual',
        name: 'Stale but runnable',
        description: 'the flow and the code disagree, on purpose',
      });
      drafts.saveFlow(draft.id, textFlow(FLOW_TEXT));
      const compiled = drafts.compileFlow(draft.id);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;

      // Hand-edit the code so the draft is stale AND behaves differently from
      // the flow. Now nothing but `code` can decide what an install ships.
      const edited = compiled.code.replace(' from the flow', ' from the hand edit');
      drafts.update(draft.id, { code: edited });
      expect(drafts.get(draft.id)?.flowStale).toBe(true);

      // A stale flow is not a validation input: the draft still validates…
      expect(drafts.validate(draft.id).validation.ok).toBe(true);
      // …and it still INSTALLS. D6 says staleness is a UI honesty state, never a
      // security one — install re-validates and runs the code, which is exactly
      // what a stale draft's install means. Blocking it here would change what
      // install is, silently, for every existing draft.
      const installed = drafts.promote(draft.id);
      expect(installed.mode).toBe('created');
      expect(skills.readEntrySource(draft.id)).toBe(edited);

      const detail = skills.get(draft.id);
      if (detail === null) throw new Error('the stale draft did not install');
      const result = await runner.invoke(detail, { text: 'hello' }, { record: false });
      expect(result.ok).toBe(true);
      // The hand-edited behaviour, not the flow's — proof that install consumed
      // the code.
      if (result.ok) expect(result.result).toBe('hello from the hand edit');
    } finally {
      h.close();
    }
  });

  it('refuses a malformed flow without writing anything (a save is validated, a graph is not a program)', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const draft = await drafts.create({ mode: 'manual', name: 'Broken graph', description: '' });

      const refused = drafts.saveFlow(draft.id, {
        version: 1,
        nodes: [{ id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { fields: 'nope' } }],
        edges: [],
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.errors.map((error) => error.code)).toContain('bad_node');
      // Nothing was written: the draft still has no flow.
      expect(drafts.getFlow(draft.id).flow).toBeNull();

      // A well-formed graph that a COMPILE would refuse still saves: drawing is
      // not compiling (this graph has no output node yet).
      const half = drafts.saveFlow(draft.id, {
        ...textFlow(FLOW_TEXT),
        nodes: textFlow(FLOW_TEXT).nodes.filter((node) => node.type !== 'output'),
        edges: [],
      });
      expect(half.ok).toBe(true);
      expect(drafts.getFlow(draft.id).flow?.nodes).toHaveLength(2);
      // …and the compile is where that becomes a named error.
      const compiled = drafts.compileFlow(draft.id);
      expect(compiled.ok).toBe(false);
      if (compiled.ok) return;
      expect(compiled.errors.map((error) => error.code)).toContain('missing_output');
      // A refused compile leaves the code (and the compile record) untouched.
      expect(drafts.get(draft.id)?.code).toBe(draft.code);
      expect(drafts.get(draft.id)?.flowCompiledAt).toBeNull();
    } finally {
      h.close();
    }
  });

  it('refuses to compile a draft that has no flow, by name', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const draft = await drafts.create({ mode: 'manual', name: 'No graph', description: '' });
      expect(() => drafts.compileFlow(draft.id)).toThrowError(/no flow/);
    } finally {
      h.close();
    }
  });

  it('derives permissions.tools AND permissions.llm from the graph on compile (D5)', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const draft = await drafts.create({ mode: 'manual', name: 'Model shaped', description: '' });

      const flow: SkillFlow = {
        version: 1,
        nodes: [
          {
            id: 'in',
            type: 'input',
            position: { x: 0, y: 0 },
            data: { fields: [{ name: 'text', type: 'string', required: true }] },
          },
          {
            id: 'read',
            type: 'tool',
            position: { x: 1, y: 0 },
            data: { toolId: 'notes.read', args: { id: 'text' } },
          },
          {
            id: 'ask',
            type: 'llm',
            position: { x: 2, y: 0 },
            data: { prompt: 'Rewrite: {{text}}' },
          },
          { id: 'out', type: 'output', position: { x: 3, y: 0 }, data: { shape: 'text' } },
        ],
        edges: [
          { id: 'e0', source: 'in', target: 'read' },
          { id: 'e1', source: 'read', target: 'ask' },
          { id: 'e2', source: 'ask', target: 'out' },
        ],
      };
      drafts.saveFlow(draft.id, flow);
      const compiled = drafts.compileFlow(draft.id);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      expect(compiled.tools).toEqual(['notes.read']);
      expect(compiled.usesLlm).toBe(true);

      // Both derived fields landed in the manifest the install will read — an
      // `llm` node without `permissions.llm` is a bundle that refuses every
      // model call (`llm_not_declared`).
      expect(compiled.draft.manifest?.permissions.tools).toEqual(['notes.read']);
      expect(compiled.draft.manifest?.permissions.llm).toBe(true);
      expect(compiled.draft.validation.ok).toBe(true);

      // And the derivation is not one-way: a graph with no `llm` node writes
      // `llm: false`, so the declared set and the code cannot drift apart.
      const plain: SkillFlow = {
        version: 1,
        nodes: flow.nodes.filter((node) => node.type !== 'llm'),
        edges: [
          { id: 'e0', source: 'in', target: 'read' },
          { id: 'e1', source: 'read', target: 'out' },
        ],
      };
      expect(drafts.saveFlow(draft.id, plain).ok).toBe(true);
      const plainCompiled = drafts.compileFlow(draft.id);
      if (!plainCompiled.ok) throw new Error('the plain flow did not compile');
      expect(plainCompiled.usesLlm).toBe(false);
      expect(plainCompiled.tools).toEqual(['notes.read']);
      // `llm: false` in the owner's manifest text — and absent from the
      // NORMALISED manifest, because the M27 contract is "absent or false means
      // no model reach at all", and the shape validator drops the false. What
      // matters is the assertion above it is not `true`: the reach the previous
      // compile granted is gone with the node that needed it.
      expect(plainCompiled.draft.manifestText).toContain('"llm": false');
      expect(plainCompiled.draft.manifest?.permissions.llm).not.toBe(true);
    } finally {
      h.close();
    }
  });
});

describe('M28 B — the compile door enforces the manifest’s own ceiling (D5)', () => {
  /** args -> files.edit -> text: a MEDIUM tool reached from a LOW manifest. */
  function aboveCeilingFlow(): SkillFlow {
    return {
      version: 1,
      nodes: [
        {
          id: 'in',
          type: 'input',
          position: { x: 0, y: 0 },
          data: { fields: [{ name: 'path', type: 'string', required: true }] },
        },
        {
          id: 'edit',
          type: 'tool',
          position: { x: 1, y: 0 },
          data: { toolId: 'files.edit', args: { path: 'path' } },
        },
        { id: 'out', type: 'output', position: { x: 2, y: 0 }, data: { shape: 'text' } },
      ],
      edges: [
        { id: 'e0', source: 'in', target: 'edit' },
        { id: 'e1', source: 'edit', target: 'out' },
      ],
    };
  }

  it('refuses a graph above the ceiling with a NAMED error, writing nothing', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      // The starter manifest is `risk: 'low'`; `files.edit` is MEDIUM in the
      // broker's own registry. Without the ceiling at this door the compile
      // emits the call, writes `permissions.tools: ['files.edit']`, re-validates
      // OK and INSTALLS — a bundle that can never do what its graph says, and
      // only refused when a run finally reaches the node. That is the same
      // "compiles but is guaranteed to refuse" class `llm_not_available` exists
      // to prevent.
      const draft = await drafts.create({
        mode: 'manual',
        name: 'Above the ceiling',
        description: '',
      });
      expect(JSON.parse(draft.manifestText).permissions.risk).toBe('low');
      expect(drafts.saveFlow(draft.id, aboveCeilingFlow()).ok).toBe(true);

      const compiled = drafts.compileFlow(draft.id);
      expect(compiled.ok).toBe(false);
      if (compiled.ok) return;
      const offender = compiled.errors.find((error) => error.code === 'tool_requires_medium');
      expect(offender).toBeDefined();
      expect(offender?.nodeId).toBe('edit');

      // Nothing was written: the code is the draft's own starter, the manifest
      // permissions were not rewritten, and no compile is recorded — so the
      // draft does not claim to be freshly compiled either.
      const after = drafts.get(draft.id);
      expect(after?.code).toBe(draft.code);
      expect(after?.manifestText).toBe(draft.manifestText);
      expect(after?.flowSha256).toBeNull();
      expect(after?.flowCompiledAt).toBeNull();
      expect(after?.flowStale).toBe(true);
      // The refused compile is still audited — counts only, never the graph.
      const rows = h.audit.query({ limit: 20, action: 'skill.flow.compile' });
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.details ?? '{}')).toMatchObject({ ok: false, errorCount: 1 });
      expect(rows[0]?.details).not.toContain('files.edit');
    } finally {
      h.close();
    }
  });

  it('compiles the SAME graph once the manifest declares the ceiling it needs', async () => {
    const h = demoHarness();
    try {
      const drafts = draftsOf(h);
      const draft = await drafts.create({
        mode: 'manual',
        name: 'Ceiling raised',
        description: '',
      });
      expect(drafts.saveFlow(draft.id, aboveCeilingFlow()).ok).toBe(true);
      expect(drafts.compileFlow(draft.id).ok).toBe(false);

      // The gate reads the DRAFT's declared risk, not a fixed rule: `medium` is
      // exactly the tier `files.edit` needs.
      drafts.update(draft.id, {
        manifestText: draft.manifestText.replace('"risk": "low"', '"risk": "medium"'),
      });
      const compiled = drafts.compileFlow(draft.id);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      expect(compiled.tools).toEqual(['files.edit']);
      expect(compiled.draft.manifest?.permissions.tools).toEqual(['files.edit']);
    } finally {
      h.close();
    }
  });
});
