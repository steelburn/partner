/**
 * M28 slice D+E cross-cutting e2e over a SPAWNED demo core (PLAN-M28.md): the
 * whole flow lifecycle over real HTTP, in the shape a user walks it.
 *
 *   generate-flow  -> the model (deterministic in demo) returns a GRAPH, which
 *                     the core validates, compiles and derives a manifest from
 *   refine         -> a PROPOSAL, and the draft is untouched by it (D8)
 *   save + compile -> the canvas save and the one writer of `code` (D1)
 *   dry-run        -> the real M8 sandbox runs the compiled module
 *   install/invoke -> the same artifact any other draft installs (D1)
 *
 * WHY the malformed-reply half of the spec's sketch is NOT here: the demo
 * generator has no malformed mode, so "refused while the reply is malformed"
 * cannot be driven from a demo build over HTTP. It is asserted where it is
 * deterministic instead — `core/test/skills/flowAi.test.ts` (a stubbed provider
 * streams prose, a fence-less non-graph, and a graph with a hostile path) and
 * `core/test/skills/flowRefine.test.ts` (the manager's second validation). What
 * THIS file proves is the part only a spawned core can: the demo walk end to
 * end, including that a flow-backed draft installs, runs and uninstalls like
 * every other skill.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = `${here}..`;
const corePort = 41_000 + (process.pid % 10_000);

let core: ChildProcess;
let base: string;
let token = '';
let coreOut = '';

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('core never became healthy');
}

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeAll(async () => {
  core = spawn(process.execPath, ['--import', 'tsx', 'core/src/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PORT: String(corePort),
      DEMO_MODE: '1',
      DB_PATH: ':memory:',
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  core.stdout?.on('data', (d: Buffer) => {
    coreOut += d.toString();
  });
  core.stderr?.on('data', (d: Buffer) => {
    coreOut += d.toString();
  });
  base = `http://127.0.0.1:${corePort}`;
  try {
    await waitForHealth();
    const code = ((await (await fetch(`${base}/v1/dev/pair-code`)).json()) as { code: string }).code;
    const pair = await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(pair.status).toBe(200);
    token = ((await pair.json()) as { token: string }).token;
  } catch (err) {
    core.kill('SIGTERM');
    throw new Error(`core setup failed:\n${coreOut}\n${String(err)}`);
  }
}, 25_000);

afterAll(async () => {
  core?.kill('SIGTERM');
});

interface DraftBody {
  id: string;
  origin: string;
  model: string | null;
  code: string;
  flow: { nodes: Array<{ id: string; type: string; data: Record<string, unknown> }> } | null;
  flowStale: boolean;
  flowSha256: string | null;
  manifest: { permissions: { tools: string[]; llm?: boolean } };
  validation: { ok: boolean };
}

describe('M28 e2e: the flow lifecycle', () => {
  it('walks generate-flow -> refine -> save -> compile -> run -> install -> invoke -> uninstall', async () => {
    // 1. `generate-flow`: the model returns a GRAPH and the core compiles it.
    const created = await authed('/v1/skills/drafts', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'generate-flow',
        name: 'E2E Flow Skill',
        description: 'returns the text it is given',
      }),
    });
    expect(created.status).toBe(201);
    const draft = await json<DraftBody>(created);
    expect(draft.origin).toBe('flow');
    expect(draft.model).toBe('demo');
    expect(draft.flow).not.toBeNull();
    expect(draft.flowStale).toBe(false);
    expect(draft.validation.ok).toBe(true);
    expect(draft.manifest.permissions.tools).toEqual([]);

    // 2. `refine` is a PROPOSAL. In demo mode the model does not run, so the
    // honest answer is the graph unchanged — and the draft is untouched by it.
    const refined = await authed(`/v1/skills/drafts/${draft.id}/flow/refine`, {
      method: 'POST',
      body: JSON.stringify({ instruction: 'make it friendlier' }),
    });
    expect(refined.status).toBe(200);
    const proposal = await json<{
      ok: boolean;
      proposal?: { diff: Record<string, unknown>; model: string | null };
    }>(refined);
    expect(proposal.ok).toBe(true);
    expect(proposal.proposal?.model).toBe('demo');
    expect(proposal.proposal?.diff).toEqual({
      nodesAdded: [],
      nodesRemoved: [],
      nodesChanged: [],
      edgesChanged: 0,
    });
    const untouched = await json<DraftBody>(
      await authed(`/v1/skills/drafts/${draft.id}`),
    );
    expect(untouched.flowStale).toBe(false);
    expect(untouched.code).toBe(draft.code);

    // 3. The canvas SAVE: a hand-drawn change to the graph. A save is not a
    // compile, so the code does not move and the flow reads stale (D6).
    const editedFlow = structuredClone(draft.flow!);
    const template = editedFlow.nodes.find((node) => node.type === 'template');
    expect(template).toBeDefined();
    template!.data.text = '{{text}} from the e2e';
    const saved = await authed(`/v1/skills/drafts/${draft.id}/flow`, {
      method: 'PUT',
      body: JSON.stringify(editedFlow),
    });
    expect(saved.status).toBe(200);
    const savedState = await json<{ flowStale: boolean }>(saved);
    expect(savedState.flowStale).toBe(true);

    // 4. `compile` is the one writer of code from a flow (D1).
    const compiled = await authed(`/v1/skills/drafts/${draft.id}/flow/compile`, {
      method: 'POST',
    });
    expect(compiled.status).toBe(200);
    const compileBody = await json<{
      ok: boolean;
      code: string;
      sha256: string;
      tools: string[];
      usesLlm: boolean;
      draft: DraftBody;
    }>(compiled);
    expect(compileBody.ok).toBe(true);
    expect(compileBody.draft.flowStale).toBe(false);
    expect(compileBody.draft.code).toContain('from the e2e');
    expect(compileBody.tools).toEqual([]);
    expect(compileBody.usesLlm).toBe(false);

    // A plain-language walkthrough is available, and writes nothing.
    const explained = await authed(`/v1/skills/drafts/${draft.id}/flow/explain`, {
      method: 'POST',
    });
    expect(explained.status).toBe(200);
    const explanation = await json<{ ok: boolean; text: string }>(explained);
    expect(explanation.ok).toBe(true);
    expect(explanation.text.length).toBeGreaterThan(0);

    // 5. The dry-run: the REAL sandbox runs the compiled module.
    const dryRun = await authed(`/v1/skills/drafts/${draft.id}/run`, {
      method: 'POST',
      body: JSON.stringify({ args: { text: 'hello' } }),
    });
    expect(dryRun.status).toBe(200);
    const runOutcome = await json<{ ok: boolean; result: unknown }>(dryRun);
    expect(runOutcome.ok).toBe(true);
    expect(runOutcome.result).toBe('hello from the e2e');

    // 6. Install, then invoke as the installed skill.
    const installed = await authed(`/v1/skills/drafts/${draft.id}/install`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(installed.status).toBe(200);
    expect((await json<{ mode: string }>(installed)).mode).toBe('created');

    const invoked = await authed(`/v1/skills/${draft.id}/invoke`, {
      method: 'POST',
      body: JSON.stringify({ args: { text: 'installed' } }),
    });
    expect(invoked.status).toBe(200);
    expect((await json<{ result: unknown }>(invoked)).result).toBe('installed from the e2e');

    // 7. Uninstall: the skill is gone from the installed list.
    const removed = await authed(`/v1/skills/${draft.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    const list = await json<{ skills: Array<{ id: string }> }>(await authed('/v1/skills'));
    expect(list.skills.map((skill) => skill.id)).not.toContain(draft.id);
  }, 40_000);
});
