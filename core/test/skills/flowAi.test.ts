/**
 * M28 slice D — the flow authoring model (`core/src/skills/flow/ai.ts`).
 *
 * What these tests pin, in order of how much they matter:
 *
 *   1. **DETERMINISTIC WITH NO MODEL.** Demo mode and "no provider configured"
 *      both answer with a graph that VALIDATES and COMPILES (asserted against
 *      the real schema door and the real compiler, not a shape check), reporting
 *      `model: 'demo'` — the same honesty M26's demo bundle established. A
 *      provider that IS configured but unusable stays a typed failure.
 *   2. **`refine` PROPOSES, IT DOES NOT DECIDE.** With no model it returns the
 *      graph it was GIVEN, unchanged, rather than inventing an edit — an
 *      unchanged proposal is the honest answer, and a fabricated "improvement"
 *      would be a model reply nobody asked for.
 *   3. **THE REPLY IS UNTRUSTED INPUT THAT BECOMES CODE.** A streamed reply that
 *      is not a graph is refused with a sentence; a reply that IS a graph goes
 *      through `validateFlow`, so the hook can never hand the manager something
 *      the schema would reject.
 *   4. **`explain` IS DERIVED, NOT INVENTED, when there is no model** — every
 *      sentence is a fact about a node that exists, which is what makes it
 *      honest to show beside a model's answer.
 */
import { describe, expect, it } from 'vitest';
import type {
  ChatEvent,
  ChatRequest,
  HealthReport,
  ProviderClient,
  ProviderSummary,
} from '@partner/shared';
import { compileFlow } from '../../src/skills/flow/compile.js';
import { validateFlow } from '../../src/skills/flow/schema.js';
import {
  createFlowAiHook,
  demoFlowExplanation,
  demoFlowFromCode,
  demoGeneratedFlow,
  DEMO_FLOW_MODEL,
} from '../../src/skills/flow/ai.js';
import type { FlowAiOptions } from '../../src/skills/flow/ai.js';
import type { SkillFlow } from '@partner/shared';

const TOOL_IDS = ['files.read', 'notes.read'];
const REGISTRY = new Set(TOOL_IDS);

/** The args -> template -> text graph every "does it compile" assertion uses. */
function textFlow(text = '{{text}}'): SkillFlow {
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
      {
        id: 'read',
        type: 'tool',
        position: { x: 2, y: 0 },
        data: { toolId: 'notes.read', args: { id: 'text' } },
      },
      { id: 'out', type: 'output', position: { x: 3, y: 0 }, data: { shape: 'text' } },
    ],
    edges: [
      { id: 'e0', source: 'in', target: 'msg' },
      { id: 'e1', source: 'msg', target: 'read' },
      { id: 'e2', source: 'read', target: 'out' },
    ],
  };
}

function summary(over: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    id: 'p1',
    name: 'Fake provider',
    kind: 'openai-compatible',
    source: 'manual',
    purpose: 'general',
    endpoint: 'https://fake.example/v1',
    defaultModels: ['fake-model'],
    visionModels: [],
    enabled: true,
    budgetCents: null,
    createdAt: 1,
    updatedAt: 1,
    health: { ok: false, latencyMs: null, error: null, models: [], checkedAt: null },
    ...over,
  };
}

function streamClient(reply: string): { client: ProviderClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    async *chatStream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      requests.push(req);
      yield { type: 'delta', text: reply };
      yield { type: 'done', model: 'fake-model', latencyMs: 1 };
    },
    async health(): Promise<HealthReport> {
      return { ok: true, latencyMs: 0 };
    },
  };
  return { client, requests };
}

function hookFor(
  options: Partial<FlowAiOptions> & { providers?: FlowAiOptions['providers'] } = {},
) {
  const providers = options.providers ?? {
    list: () => [] as ProviderSummary[],
    clientFor: async () => {
      throw new Error('no client');
    },
  };
  return createFlowAiHook({
    providers,
    demo: options.demo ?? true,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.replyCapBytes === undefined ? {} : { replyCapBytes: options.replyCapBytes }),
  });
}

const REQUEST = { toolIds: TOOL_IDS, llmAvailable: true } as const;

describe('M28 D — the flow authoring model', () => {
  it('the deterministic generate answer validates AND compiles (schema + compiler, not a shape check)', async () => {
    const outcome = await hookFor({ demo: true }).generate({
      name: 'Text shaper',
      description: 'returns the text it is given',
      ...REQUEST,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model).toBe(DEMO_FLOW_MODEL);
    const validated = validateFlow(outcome.flow);
    expect(validated.ok).toBe(true);
    const compiled = compileFlow(outcome.flow, { registry: REGISTRY, llmAvailable: true });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    // A pure skill: it reaches nothing, so it installs under any grant state.
    expect(compiled.tools).toEqual([]);
    expect(compiled.usesLlm).toBe(false);
  });

  it('the deterministic answer is stable, and a hostile description cannot reach the graph', async () => {
    const hook = hookFor({ demo: true });
    const a = await hook.generate({ name: 'A', description: 'one', ...REQUEST });
    const b = await hook.generate({ name: 'B', description: 'two', ...REQUEST });
    expect(a).toEqual(b);
    expect(demoGeneratedFlow()).toEqual(demoGeneratedFlow());
    // The description is DATA: it is not interpolated into the template, so a
    // description carrying {{...}} cannot smuggle a placeholder (or a bad path).
    const nasty = await hook.generate({
      name: 'N',
      description: '{{a); process.exit(1);//}} and `${evil}`',
      ...REQUEST,
    });
    expect(nasty.ok).toBe(true);
    if (!nasty.ok) return;
    const validated = validateFlow(nasty.flow);
    expect(validated.ok).toBe(true);
  });

  it('refine with no model returns the graph it was given, unchanged and honestly labelled', async () => {
    const flow = textFlow('{{text}} before');
    const outcome = await hookFor({ demo: true }).refine({
      flow,
      instruction: 'add a branch on whether the text is empty',
      ...REQUEST,
    });
    expect(outcome).toEqual({ ok: true, flow, warnings: [], model: DEMO_FLOW_MODEL });
  });

  it('from-code with no model answers a passthrough graph that compiles, and says it is demo', async () => {
    const outcome = await hookFor({ demo: true }).fromCode({
      code: 'export function run(args) { return args; }',
      manifestText: '{"id":"x"}',
      ...REQUEST,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model).toBe(DEMO_FLOW_MODEL);
    expect(outcome.flow).toEqual(demoFlowFromCode());
    const compiled = compileFlow(outcome.flow, { registry: REGISTRY, llmAvailable: true });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    // A passthrough returns the args: `run(args)` with a single input node.
    expect(compiled.tools).toEqual([]);
  });

  it('explain with no model DERIVES a walkthrough from the graph (nothing invented)', async () => {
    const flow = textFlow('{{text}}');
    const first = await hookFor({ demo: true }).explain({ flow, ...REQUEST });
    const second = await hookFor({ demo: true }).explain({ flow, ...REQUEST });
    expect(first.ok).toBe(true);
    expect(first).toEqual(second);
    if (!first.ok) return;
    expect(first.model).toBe(DEMO_FLOW_MODEL);
    // Every sentence is a fact about a node that exists.
    expect(first.text).toContain('notes.read');
    expect(first.text).toContain('4 nodes');
    expect(demoFlowExplanation(flow)).toBe(first.text);
    // Prose, not a leaked enum: an explanation is for the owner.
    expect(first.text).not.toContain(' is eq ');
    // A graph with no tool node never mentions one.
    const bare = demoFlowExplanation(demoFlowFromCode());
    expect(bare).not.toContain('notes.read');

    // The BRANCH reads as prose, not as a leaked enum: `pinned is eq true` would
    // be the operator's wire spelling shown to the owner.
    const branchWords = demoFlowExplanation({
      version: 1,
      nodes: [
        {
          id: 'in',
          type: 'input',
          position: { x: 0, y: 0 },
          data: { fields: [{ name: 'pinned', type: 'boolean', required: false }] },
        },
        {
          id: 'decide',
          type: 'branch',
          position: { x: 1, y: 0 },
          data: { path: 'pinned', op: 'eq', value: true },
        },
        { id: 'out', type: 'output', position: { x: 2, y: 0 }, data: { shape: 'json' } },
      ],
      edges: [
        { id: 'e0', source: 'in', target: 'decide' },
        { id: 'e1', source: 'decide', target: 'out' },
      ],
    });
    expect(branchWords).toContain('pinned is equal to true');
    expect(branchWords).not.toContain(' is eq ');
  });

  it('no provider configured in a LIVE build still answers deterministically (M26 D11 reused)', async () => {
    const hook = hookFor({ demo: false });
    const generated = await hook.generate({ name: 'X', description: 'y', ...REQUEST });
    expect(generated.ok).toBe(true);
    if (generated.ok) expect(generated.model).toBe(DEMO_FLOW_MODEL);
    const refined = await hook.refine({
      flow: textFlow(),
      instruction: 'anything',
      ...REQUEST,
    });
    expect(refined.ok).toBe(true);
    if (refined.ok) expect(refined.model).toBe(DEMO_FLOW_MODEL);
    const explained = await hook.explain({ flow: textFlow(), ...REQUEST });
    expect(explained.ok).toBe(true);
  });

  it('a configured-but-unusable provider is REPORTED, never papered over', async () => {
    const hook = hookFor({
      demo: false,
      providers: {
        list: () => [summary()],
        clientFor: async () => {
          throw new Error('no key');
        },
      },
    });
    const outcome = await hook.generate({ name: 'X', description: 'y', ...REQUEST });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/cannot serve/);
  });

  it('reads a streamed reply through the schema door: a real flow is accepted', async () => {
    const { client, requests } = streamClient(JSON.stringify(textFlow('{{text}} from the model')));
    const hook = hookFor({
      demo: false,
      providers: { list: () => [summary()], clientFor: async () => client },
    });
    const outcome = await hook.generate({ name: 'X', description: 'y', ...REQUEST });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model).toBe('fake-model');
    expect(outcome.flow.nodes).toHaveLength(4);
    // The prompt the model received is the vocabulary contract, not JavaScript.
    const system = requests[0]?.messages[0]?.content ?? '';
    expect(system).toContain('notes.read');
    expect(system).toContain('EXACTLY ONE per flow');
    expect(system).not.toContain('function ');
  });

  it('refuses a reply that is not a graph, naming the problem and writing nothing', async () => {
    const { client } = streamClient('I cannot help with that.');
    const hook = hookFor({
      demo: false,
      providers: { list: () => [summary()], clientFor: async () => client },
    });
    const outcome = await hook.generate({ name: 'X', description: 'y', ...REQUEST });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message.length).toBeGreaterThan(0);
    // The reply text never reaches the message (a model reply is not echoed).
    expect(outcome.message).not.toContain('I cannot help');
  });

  it('refuses a graph the schema rejects, with the named per-node error', async () => {
    const { client } = streamClient(
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: 'in',
            type: 'input',
            position: { x: 0, y: 0 },
            data: { fields: [{ name: 'text', type: 'string', required: true }] },
          },
          { id: 'bad', type: 'template', position: { x: 1, y: 0 }, data: { text: '{{__proto__}}' } },
          { id: 'out', type: 'output', position: { x: 2, y: 0 }, data: { shape: 'text' } },
        ],
        edges: [
          { id: 'e0', source: 'in', target: 'bad' },
          { id: 'e1', source: 'bad', target: 'out' },
        ],
      }),
    );
    const hook = hookFor({
      demo: false,
      providers: { list: () => [summary()], clientFor: async () => client },
    });
    const outcome = await hook.generate({ name: 'X', description: 'y', ...REQUEST });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('bad_path');
  });

  it('honours the reply cap and the timeout (one bounded call, not a per-verb one)', async () => {
    const { client } = streamClient(JSON.stringify(textFlow()));
    const capped = hookFor({
      demo: false,
      replyCapBytes: 8,
      providers: { list: () => [summary()], clientFor: async () => client },
    });
    const overCap = await capped.generate({ name: 'X', description: 'y', ...REQUEST });
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.message).toContain('8 bytes');

    const silent: ProviderClient = {
      async *chatStream(_req: ChatRequest): AsyncGenerator<ChatEvent> {
        await new Promise<void>(() => undefined);
      },
      async health(): Promise<HealthReport> {
        return { ok: true, latencyMs: 0 };
      },
    };
    const timed = hookFor({
      demo: false,
      timeoutMs: 10,
      providers: { list: () => [summary()], clientFor: async () => silent },
    });
    const outcome = await timed.generate({ name: 'X', description: 'y', ...REQUEST });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/timed out/);
  });
});
