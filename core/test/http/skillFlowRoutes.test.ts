/**
 * M28 slice B — the FLOW HTTP surface (PLAN-M28.md D1/D5/D6).
 *
 * What these tests pin, beyond "the routes work":
 *   · `GET` needs only a session; every WRITE needs `skill.author`, and a mobile
 *     or extension session is refused BY NAME on both writes (the M20-B
 *     envelope, not a second list of capabilities);
 *   · a PUT is NOT a compile: it writes the graph and leaves `code` and the
 *     manifest's permissions exactly as they were;
 *   · `/compile` is D1's only writer of code from a flow, and it derives the
 *     manifest's permissions from the GRAPH — both `tools` and `llm` (D5);
 *   · a flow that does not compile answers with its named error list and writes
 *     nothing;
 *   · `flowStale` is derived on every read (D6), never stored, and a stale draft
 *     installs (install consumes code);
 *   · no audit row ever carries the flow body, the code or the manifest text.
 *
 * The manager-level tests for the same decisions live in
 * `core/test/skills/flowStale.test.ts`; slice A's compiler tests are
 * `flowCompile.test.ts` / `flowSchema.test.ts` / `flowRun.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { SkillFlow } from '@partner/shared';
import type { FlowAiHook } from '../../src/skills/flow/ai.js';
import { ALLOWED_HOST, demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';

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

/** args -> template -> text output. No tools, no model: it installs and runs. */
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

/** args -> notes.read -> llm -> text output: the D5 case (tools AND llm). */
function toolAndLlmFlow(): SkillFlow {
  return {
    version: 1,
    nodes: [
      {
        id: 'in',
        type: 'input',
        position: { x: 0, y: 0 },
        data: { fields: [{ name: 'id', type: 'string', required: true }] },
      },
      {
        id: 'read',
        type: 'tool',
        position: { x: 1, y: 0 },
        data: { toolId: 'notes.read', args: { id: 'id' } },
      },
      { id: 'ask', type: 'llm', position: { x: 2, y: 0 }, data: { prompt: 'Summarise: {{id}}' } },
      { id: 'out', type: 'output', position: { x: 3, y: 0 }, data: { shape: 'text' } },
    ],
    edges: [
      { id: 'e0', source: 'in', target: 'read' },
      { id: 'e1', source: 'read', target: 'ask' },
      { id: 'e2', source: 'ask', target: 'out' },
    ],
  };
}

/**
 * A FlowAiHook double. The DEFAULT fake answers a flow that differs from the one
 * it was given in exactly ONE node (the template's text), so a diff assertion
 * can name the single change — which is what distinguishes "the model proposed
 * something" from "the model answered with what it was handed".
 */
function fakeFlowAi(overrides: Partial<FlowAiHook> = {}): FlowAiHook {
  return {
    generate: async () => ({
      ok: true,
      flow: textFlow('{{text}}'),
      warnings: [],
      model: 'fake-model',
    }),
    refine: async () => ({
      ok: true,
      flow: textFlow('{{text}} refined'),
      warnings: [],
      model: 'fake-model',
    }),
    fromCode: async () => ({
      ok: true,
      flow: textFlow('{{text}} from code'),
      warnings: [],
      model: 'fake-model',
    }),
    explain: async () => ({
      ok: true,
      text: 'It reads the text you give it and writes it back.',
      model: 'fake-model',
    }),
    ...overrides,
  };
}

/** Create a manual draft (a valid starter bundle) and return its id. */
async function newDraft(h: Harness, token: string, name = 'Flow draft'): Promise<string> {
  const created = await request(h.app)
    .post('/v1/skills/drafts')
    .set(authed(token))
    .send({ mode: 'manual', name, description: 'built on a canvas' });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

describe('M28 B flow routes', () => {
  it('every flow route is authed (401 without a token)', async () => {
    const h = demoHarness();
    try {
      const checks = [
        request(h.app).get('/v1/skills/drafts/x/flow'),
        request(h.app).put('/v1/skills/drafts/x/flow').send(textFlow('{{text}}')),
        request(h.app).post('/v1/skills/drafts/x/flow/compile'),
        request(h.app).post('/v1/skills/drafts/x/flow/refine').send({ instruction: 'anything' }),
        request(h.app).post('/v1/skills/drafts/x/flow/from-code'),
        request(h.app).post('/v1/skills/drafts/x/flow/explain'),
      ];
      for (const pending of checks) {
        const res = await pending.set('Host', ALLOWED_HOST);
        expect(res.status).toBe(401);
      }
    } finally {
      h.close();
    }
  });

  it('501s when the drafts manager is unwired', async () => {
    const h = demoHarness({ skills: false });
    try {
      const token = await pairToken(h);
      const res = await request(h.app).get('/v1/skills/drafts/x/flow').set(authed(token));
      expect(res.status).toBe(501);
      expect(res.body.error).toBe('not_configured');
    } finally {
      h.close();
    }
  });

  it('404s an unknown draft on all three routes', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const checks = [
        request(h.app).get('/v1/skills/drafts/nope/flow').set(headers),
        request(h.app).put('/v1/skills/drafts/nope/flow').set(headers).send(textFlow('x')),
        request(h.app).post('/v1/skills/drafts/nope/flow/compile').set(headers),
      ];
      for (const pending of checks) {
        const res = await pending;
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('not_found');
      }
    } finally {
      h.close();
    }
  });

  it('saves a flow without touching the code, and reports derived staleness (D1/D6)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await newDraft(h, token);
      const before = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);
      expect(before.body.flow).toBeNull();
      expect(before.body.flowStale).toBe(false);

      // The canvas save. The body IS the flow document.
      const saved = await request(h.app)
        .put(`/v1/skills/drafts/${draftId}/flow`)
        .set(headers)
        .send(textFlow('{{text}} from the canvas'));
      expect(saved.status).toBe(200);
      expect(saved.body.flow.nodes).toHaveLength(3);
      // Never compiled => stale: the draft's code cannot be this flow's output.
      expect(saved.body.flowStale).toBe(true);
      expect(saved.body.flowCompiledAt).toBeNull();

      const read = await request(h.app).get(`/v1/skills/drafts/${draftId}/flow`).set(headers);
      expect(read.status).toBe(200);
      expect(read.body.flow.edges).toHaveLength(2);
      expect(read.body.flowStale).toBe(true);

      // A save is NOT a compile: neither the code nor the manifest (and so
      // neither the permissions derived from the graph) moved.
      const after = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);
      expect(after.body.code).toBe(before.body.code);
      expect(after.body.manifestText).toBe(before.body.manifestText);
      expect(after.body.manifest.permissions.tools).toEqual([]);

      // A second save that ADDS a tool node still changes no permissions — the
      // only writer of those is /compile.
      const toolSaved = await request(h.app)
        .put(`/v1/skills/drafts/${draftId}/flow`)
        .set(headers)
        .send(toolAndLlmFlow());
      expect(toolSaved.status).toBe(200);
      const stillPlain = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);
      expect(stillPlain.body.code).toBe(before.body.code);
      expect(stillPlain.body.manifest.permissions.tools).toEqual([]);

      // A malformed graph is refused with per-node errors and writes nothing:
      // the previously saved flow is still there.
      const refused = await request(h.app)
        .put(`/v1/skills/drafts/${draftId}/flow`)
        .set(headers)
        .send({
          version: 1,
          nodes: [{ id: 'in', type: 'input', position: { x: 0, y: 0 }, data: { fields: 'nope' } }],
          edges: [],
        });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('invalid_input');
      expect((refused.body.flowErrors as Array<{ code: string }>).map((e) => e.code)).toContain(
        'bad_node',
      );
      const unchanged = await request(h.app).get(`/v1/skills/drafts/${draftId}/flow`).set(headers);
      expect(unchanged.body.flow.nodes).toHaveLength(4);
    } finally {
      h.close();
    }
  });

  it('compiles a flow into installable code whose permissions match the graph (D1/D5)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await newDraft(h, token, 'Model shaped');
      const before = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);
      expect(before.body.code).not.toContain('notes.read');

      await request(h.app)
        .put(`/v1/skills/drafts/${draftId}/flow`)
        .set(headers)
        .send(toolAndLlmFlow());

      const compiled = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/flow/compile`)
        .set(headers);
      expect(compiled.status).toBe(200);
      expect(compiled.body.ok).toBe(true);
      expect(compiled.body.tools).toEqual(['notes.read']);
      expect(compiled.body.usesLlm).toBe(true);
      expect(compiled.body.argsForm).toEqual([{ name: 'id', type: 'string', required: true }]);
      expect(compiled.body.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(compiled.body.code).toContain('notes.read');

      // The compile IS a write, and it derives the manifest's reach from the
      // graph — both fields. `permissions.llm` matters as much as the tools: an
      // `llm` node without it installs a manifest that refuses every model call.
      expect(compiled.body.draft.code).toBe(compiled.body.code);
      expect(compiled.body.draft.flowStale).toBe(false);
      expect(compiled.body.draft.validation.ok).toBe(true);
      const after = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);
      expect(after.body.manifest.permissions.tools).toEqual(['notes.read']);
      expect(after.body.manifest.permissions.llm).toBe(true);
      expect(after.body.manifestText).toContain('"notes.read"');

      // D6 on the read surface: the hash the flow compiled to matches the code,
      // so the derived flag is clear without anything having been stored.
      const state = await request(h.app).get(`/v1/skills/drafts/${draftId}/flow`).set(headers);
      expect(state.body.flowStale).toBe(false);
      expect(typeof state.body.flowCompiledAt).toBe('number');

      // A compile of the SAME flow again is byte-identical (D4's determinism,
      // now visible over the wire) — this is what makes staleness comparable.
      const again = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/flow/compile`)
        .set(headers);
      expect(again.status).toBe(200);
      expect(again.body.sha256).toBe(compiled.body.sha256);

      // And it installs: the consent summary the owner reads comes from the same
      // derived set the code was generated against.
      const installed = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/install`)
        .set(headers)
        .send({});
      expect(installed.status).toBe(200);
      expect(installed.body.mode).toBe('created');
      const skill = await request(h.app).get(`/v1/skills/${draftId}`).set(headers);
      expect(skill.body.manifest.permissions.tools).toEqual(['notes.read']);
      expect(skill.body.manifest.permissions.llm).toBe(true);
    } finally {
      h.close();
    }
  });

  it('installs and RUNS a flow-backed draft over HTTP, and a stale one still installs', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await newDraft(h, token, 'Text shaper');
      await request(h.app)
        .put(`/v1/skills/drafts/${draftId}/flow`)
        .set(headers)
        .send(textFlow('{{text}} from the flow'));
      const compiled = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/flow/compile`)
        .set(headers);
      expect(compiled.body.ok).toBe(true);

      // A hand-edit of the code marks the flow stale (derived, D6)…
      const edited = String(compiled.body.code).replace(
        ' from the flow',
        ' from the hand edit',
      );
      const editedPut = await request(h.app)
        .put(`/v1/skills/drafts/${draftId}`)
        .set(headers)
        .send({ code: edited });
      expect(editedPut.status).toBe(200);
      expect(editedPut.body.flowStale).toBe(true);

      // …and a STALE draft still installs, because install consumes `code`. This
      // assertion exists so nobody later "helpfully" blocks it: staleness is UI
      // honesty, not a security state.
      const installed = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/install`)
        .set(headers)
        .send({});
      expect(installed.status).toBe(200);
      expect(installed.body.mode).toBe('created');

      // The proof that install consumed the CODE and not the flow: run it.
      const invoked = await request(h.app)
        .post(`/v1/skills/${draftId}/invoke`)
        .set(headers)
        .send({ args: { text: 'hello' } });
      expect(invoked.status).toBe(200);
      expect(invoked.body.result).toBe('hello from the hand edit');
    } finally {
      h.close();
    }
  });

  it('answers a flow that cannot compile with its named errors and writes nothing', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await newDraft(h, token);
      const before = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);

      // Structurally valid (a half-drawn graph saves), but it has no output node.
      const saved = await request(h.app)
        .put(`/v1/skills/drafts/${draftId}/flow`)
        .set(headers)
        .send({ version: 1, nodes: textFlow('x').nodes.slice(0, 2), edges: [] });
      expect(saved.status).toBe(200);

      const compiled = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/flow/compile`)
        .set(headers);
      expect(compiled.status).toBe(200);
      expect(compiled.body.ok).toBe(false);
      expect((compiled.body.errors as Array<{ code: string }>).map((e) => e.code)).toContain(
        'missing_output',
      );

      // Nothing was written: the code is the draft's own, and no compile is
      // recorded (so the flow is not falsely reported as compiled).
      const after = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);
      expect(after.body.code).toBe(before.body.code);
      expect(after.body.flowSha256).toBeNull();
      expect(after.body.flowCompiledAt).toBeNull();
    } finally {
      h.close();
    }
  });

  it('refuses a mobile or extension session BY NAME on the writes, and allows the read', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const draftId = await newDraft(h, desktop);

      for (const clientClass of ['mobile', 'extension']) {
        const token = await classToken(h, clientClass);
        const headers = authed(token);

        const write = await request(h.app)
          .put(`/v1/skills/drafts/${draftId}/flow`)
          .set(headers)
          .send(textFlow('{{text}}'));
        expect(write.status).toBe(403);
        expect(write.body).toMatchObject({ error: 'capability_denied' });

        const compile = await request(h.app)
          .post(`/v1/skills/drafts/${draftId}/flow/compile`)
          .set(headers);
        expect(compile.status).toBe(403);
        expect(compile.body).toMatchObject({ error: 'capability_denied' });

        // The READ is not capability-gated (it is the owner's own document, like
        // GET /v1/skills/drafts/:id) — the gate is exactly the write.
        const read = await request(h.app).get(`/v1/skills/drafts/${draftId}/flow`).set(headers);
        expect(read.status).toBe(200);
      }

      // Nothing was written on the way to those refusals.
      const after = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(authed(desktop));
      expect(after.body.flow).toBeNull();
    } finally {
      h.close();
    }
  });

  it('keeps a write off an already-installed draft (409, like every other authoring write)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await newDraft(h, token, 'Shipped');
      const installed = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/install`)
        .set(headers)
        .send({});
      expect(installed.status).toBe(200);

      const save = await request(h.app)
        .put(`/v1/skills/drafts/${draftId}/flow`)
        .set(headers)
        .send(textFlow('{{text}}'));
      expect(save.status).toBe(409);
      expect(save.body.error).toBe('conflict');

      const compile = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/flow/compile`)
        .set(headers);
      // The draft has no flow either; the frozen-draft refusal comes first, so
      // an installed draft cannot be recompiled into new code behind the
      // install's back.
      expect(compile.status).toBe(409);
      expect(compile.body.error).toBe('conflict');
    } finally {
      h.close();
    }
  });

  it('keeps the flow body and the compiled code out of the audit log', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await newDraft(h, token, 'Quiet graph');
      const flow = textFlow('{{text}} PRIVATE-TEMPLATE-TEXT');
      await request(h.app).put(`/v1/skills/drafts/${draftId}/flow`).set(headers).send(flow);
      await request(h.app).post(`/v1/skills/drafts/${draftId}/flow/compile`).set(headers);

      const rows = h.audit.list(200);
      const serialized = JSON.stringify(
        rows.map((row) => ({ action: row.action, details: row.details })),
      );
      expect(serialized).not.toContain('PRIVATE-TEMPLATE-TEXT');
      expect(serialized).not.toContain('Generated from a Flow by Partner');
      expect(serialized).not.toContain('export async function run');

      const actions = rows.map((row) => row.action);
      expect(actions).toContain('skill.flow.save');
      expect(actions).toContain('skill.flow.compile');
      const save = rows.find((row) => row.action === 'skill.flow.save');
      const compile = rows.find((row) => row.action === 'skill.flow.compile');
      // Counts, ids and a boolean — the shape the audit rule allows. `details`
      // is stored as JSON text by the audit store, so it is parsed back here.
      expect(JSON.parse(String(save?.details))).toEqual({ nodes: 3, edges: 2, stale: true });
      expect(JSON.parse(String(compile?.details))).toMatchObject({
        ok: true,
        nodes: 3,
        edges: 2,
        tools: [],
        errorCount: 0,
      });
      expect(typeof JSON.parse(String(compile?.details)).codeBytes).toBe('number');
    } finally {
      h.close();
    }
  });

  it('404s an unknown draft on the three AI verbs too', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const checks = [
        request(h.app)
          .post('/v1/skills/drafts/nope/flow/refine')
          .set(headers)
          .send({ instruction: 'x' }),
        request(h.app).post('/v1/skills/drafts/nope/flow/from-code').set(headers),
        request(h.app).post('/v1/skills/drafts/nope/flow/explain').set(headers),
      ];
      for (const pending of checks) {
        const res = await pending;
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('not_found');
      }
    } finally {
      h.close();
    }
  });

  it('refuses a mobile or extension session BY NAME on the three AI verbs', async () => {
    const h = demoHarness();
    try {
      const desktop = await pairToken(h);
      const draftId = await newDraft(h, desktop);
      for (const clientClass of ['mobile', 'extension']) {
        const headers = authed(await classToken(h, clientClass));
        const checks = [
          request(h.app)
            .post(`/v1/skills/drafts/${draftId}/flow/refine`)
            .set(headers)
            .send({ instruction: 'x' }),
          request(h.app).post(`/v1/skills/drafts/${draftId}/flow/from-code`).set(headers),
          request(h.app).post(`/v1/skills/drafts/${draftId}/flow/explain`).set(headers),
        ];
        for (const pending of checks) {
          const res = await pending;
          expect(res.status).toBe(403);
          expect(res.body).toMatchObject({ error: 'capability_denied' });
        }
      }
    } finally {
      h.close();
    }
  });

  it('refuses a refine with no flow, and one with an empty instruction, writing nothing', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await newDraft(h, token);
      const before = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);

      // A code-authored draft has no flow, so there is nothing to propose
      // against (D7) — refused by name, not a silent no-op.
      const noFlow = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/flow/refine`)
        .set(headers)
        .send({ instruction: 'add a branch' });
      expect(noFlow.status).toBe(400);
      expect(noFlow.body.error).toBe('invalid_input');

      await request(h.app)
        .put(`/v1/skills/drafts/${draftId}/flow`)
        .set(headers)
        .send(textFlow('{{text}}'));
      const empty = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/flow/refine`)
        .set(headers)
        .send({ instruction: '   ' });
      expect(empty.status).toBe(400);
      expect(empty.body.error).toBe('invalid_input');

      const after = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);
      // The only difference is the flow the test itself saved.
      expect(after.body.code).toBe(before.body.code);
      expect(after.body.manifestText).toBe(before.body.manifestText);
    } finally {
      h.close();
    }
  });

  it('returns a refine PROPOSAL and leaves the draft byte-identical (D8)', async () => {
    const h = demoHarness({ skillFlowAi: fakeFlowAi() });
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await newDraft(h, token, 'Refinable');
      await request(h.app)
        .put(`/v1/skills/drafts/${draftId}/flow`)
        .set(headers)
        .send(textFlow('{{text}} before'));
      const before = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);

      const refined = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/flow/refine`)
        .set(headers)
        .send({ instruction: 'PRIVATE-INSTRUCTION make the text friendlier' });
      expect(refined.status).toBe(200);
      expect(refined.body.ok).toBe(true);
      expect(refined.body.proposal.model).toBe('fake-model');
      // The diff counts the ONE node the model changed: the template. Positions
      // and identical edges are not changes.
      expect(refined.body.proposal.diff).toEqual({
        nodesAdded: [],
        nodesRemoved: [],
        nodesChanged: ['msg'],
        edgesChanged: 0,
      });
      expect(refined.body.proposal.flow.nodes).toHaveLength(3);

      // NOTHING was written: the row after the call is the row before it. This
      // is the whole of D8 — the model cannot restructure the graph behind the
      // user's back.
      const after = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);
      expect(after.body).toEqual(before.body);
      expect(after.body.flow.nodes.find((n: { id: string }) => n.id === 'msg').data.text).toBe(
        '{{text}} before',
      );

      // The audit row carries COUNTS and the model name — never the instruction,
      // never the graph.
      const rows = h.audit.list(200);
      const serialized = JSON.stringify(rows.map((row) => ({ action: row.action, details: row.details })));
      expect(serialized).not.toContain('PRIVATE-INSTRUCTION');
      expect(serialized).not.toContain('friendlier');
      const row = rows.find((entry) => entry.action === 'skill.flow.refine');
      expect(JSON.parse(String(row?.details))).toEqual({
        ok: true,
        nodesAdded: 0,
        nodesRemoved: 0,
        nodesChanged: 1,
        edgesChanged: 0,
        model: 'fake-model',
      });
    } finally {
      h.close();
    }
  });

  it('refuses an unusable model reply with a sentence, and still writes nothing', async () => {
    const h = demoHarness({
      skillFlowAi: fakeFlowAi({
        refine: async () => ({ ok: false, message: 'the model returned no text' }),
      }),
    });
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await newDraft(h, token);
      await request(h.app)
        .put(`/v1/skills/drafts/${draftId}/flow`)
        .set(headers)
        .send(textFlow('{{text}}'));
      const before = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);

      const refused = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/flow/refine`)
        .set(headers)
        .send({ instruction: 'anything' });
      // 200: the request SUCCEEDED in determining the answer, exactly as
      // /validate and /compile report a negative result.
      expect(refused.status).toBe(200);
      expect(refused.body.ok).toBe(false);
      expect(refused.body.error).toBe('the model returned no text');

      const after = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);
      expect(after.body).toEqual(before.body);
      const row = h.audit.list(200).find((entry) => entry.action === 'skill.flow.refine');
      expect(JSON.parse(String(row?.details))).toMatchObject({ ok: false, model: null });
    } finally {
      h.close();
    }
  });

  it('turns the entry source into a flow as an explicitly LOSSY proposal (D7)', async () => {
    const h = demoHarness({ skillFlowAi: fakeFlowAi() });
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await newDraft(h, token, 'Written as code');
      const before = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);
      expect(before.body.flow).toBeNull();

      const proposed = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/flow/from-code`)
        .set(headers);
      expect(proposed.status).toBe(200);
      expect(proposed.body.ok).toBe(true);
      // Measured against the EMPTY graph: a code-authored draft's first proposal
      // is "everything here is new", which is the honest reading.
      expect(proposed.body.proposal.diff.nodesAdded).toHaveLength(3);
      expect(proposed.body.proposal.diff.nodesRemoved).toEqual([]);

      // Never applied automatically: the draft still has no flow at all.
      const after = await request(h.app).get(`/v1/skills/drafts/${draftId}`).set(headers);
      expect(after.body.flow).toBeNull();
      expect(after.body.code).toBe(before.body.code);
      expect(after.body.manifestText).toBe(before.body.manifestText);
      const row = h.audit.list(200).find((entry) => entry.action === 'skill.flow.fromCode');
      expect(JSON.parse(String(row?.details))).toEqual({
        ok: true,
        nodes: 3,
        edges: 2,
        model: 'fake-model',
      });
    } finally {
      h.close();
    }
  });

  it('explains a flow for the owner, writing nothing and auditing nothing', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const draftId = await newDraft(h, token, 'Explainable');
      await request(h.app)
        .put(`/v1/skills/drafts/${draftId}/flow`)
        .set(headers)
        .send(toolAndLlmFlow());
      const actionsBefore = h.audit.list(200).map((row) => row.action);

      const explained = await request(h.app)
        .post(`/v1/skills/drafts/${draftId}/flow/explain`)
        .set(headers);
      expect(explained.status).toBe(200);
      expect(explained.body.ok).toBe(true);
      expect(typeof explained.body.text).toBe('string');
      expect(explained.body.text).toContain('notes.read');

      // An explanation is not a state change: no row, and no draft mutation.
      const actionsAfter = h.audit.list(200).map((row) => row.action);
      expect(actionsAfter).toEqual(actionsBefore);
    } finally {
      h.close();
    }
  });

  it('creates a COMPILED, flow-backed draft from `mode: generate-flow`', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const headers = authed(token);
      const created = await request(h.app)
        .post('/v1/skills/drafts')
        .set(headers)
        .send({ mode: 'generate-flow', name: 'Notes digest', description: 'writes the text back' });
      expect(created.status).toBe(201);
      const draft = created.body as {
        id: string;
        origin: string;
        model: string | null;
        flow: SkillFlow | null;
        flowStale: boolean;
        code: string;
        manifestText: string;
        validation: { ok: boolean };
        manifest: { permissions: { tools: string[]; llm?: boolean } };
      };
      expect(draft.origin).toBe('flow');
      expect(draft.model).toBe('demo');
      expect(draft.flow?.nodes).toHaveLength(3);
      expect(draft.flowStale).toBe(false);
      expect(draft.validation.ok).toBe(true);
      expect(draft.code).toContain('export async function run(args)');
      // The manifest is DERIVED from the graph, and this graph reaches nothing.
      expect(draft.manifest.permissions.tools).toEqual([]);
      // `llm` is written in BOTH directions into the manifest text (D5), so the
      // declaration and the graph are visibly equal; the parsed manifest omits a
      // false value, exactly as the M26 validator normalises it.
      expect(draft.manifest.permissions.llm).toBeUndefined();
      expect(draft.manifestText).toContain('"llm": false');

      // The read surface reports the same derived state, plus the palette gate.
      const state = await request(h.app)
        .get(`/v1/skills/drafts/${draft.id}/flow`)
        .set(headers);
      expect(state.body.flowStale).toBe(false);
      expect(state.body.llmAvailable).toBe(true);
    } finally {
      h.close();
    }
  });
});
