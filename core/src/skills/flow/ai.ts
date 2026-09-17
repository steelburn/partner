/**
 * M28 slice D — the flow authoring MODEL (PLAN-M28.md D7/D8, and the AI half of
 * the routes).
 *
 * Four verbs, one hook:
 *
 *   generate   a description -> a whole graph (`mode:'generate-flow'`)
 *   refine     a graph + an instruction -> a PROPOSAL (D8: never a write)
 *   fromCode   the draft's entry source -> a PROPOSAL that is declared LOSSY
 *              (D7: there is no decompiler; the model is guessing at intent)
 *   explain    a graph -> plain-language text for the owner's eyes only
 *
 * WHAT THIS FILE IS CAREFUL ABOUT
 *
 *   - **The model's reply is untrusted input that becomes code.** Every reply
 *     goes through `parseFlowReply` (fence-strip, typed failure) and then the
 *     slice-A `validateFlow` door; a reply the core would refuse is a typed
 *     failure with a sentence, never a partial graph. The emitted code is held
 *     to the SAME M26 gates afterwards, in `drafts.ts` (`lintEntry`,
 *     `validateManifestShape`, the dry-run, the owner's install).
 *   - **No model, no fabrication.** M26 D11 says a build with no provider
 *     configured still walks: the deterministic answers here are labelled
 *     `model: 'demo'` exactly like the demo skill bundle, and they are honest
 *     about what they are (a passthrough graph for `from-code`, an unchanged
 *     graph for `refine`, and a walkthrough DERIVED from the graph — not
 *     invented — for `explain`). A provider that IS configured but unusable is
 *     a different case and stays a typed failure the owner is told about.
 *   - **`refine` proposes, it does not decide.** The demo path returns the graph
 *     it was given; the live path returns whatever the model proposed. Either
 *     way nothing here writes: the only writer is `PUT …/flow` after a human
 *     accepts the diff.
 */
import type { FlowValidationError, SkillFlow, SkillFlowNode } from '@partner/shared';
import {
  runBoundedModelCall,
  type ModelCallFailureCode,
  type ModelCallOptions,
  type ModelCallOutcome,
} from '../model.js';
import {
  buildFlowExplainPrompt,
  buildFlowFromCodePrompt,
  buildFlowGeneratePrompt,
  buildFlowRefinePrompt,
  parseFlowReply,
} from './refine.js';

/** The provider seam, identical in shape to the M26 generator's. */
export interface FlowAiOptions extends ModelCallOptions {
  /** Demo mode never calls a provider (M26 D11, reused). */
  demo: boolean;
}

export interface FlowAiFlowRequest {
  /** `generate` only. */
  name?: string;
  description?: string;
  /** `refine` only: the graph the user drew. */
  flow?: SkillFlow;
  /** `refine` only: the owner's own words. */
  instruction?: string;
  /** `from-code` only: the draft's current entry source and manifest text. */
  code?: string;
  manifestText?: string;
  /** The broker ids a `tool` node may name in this build. */
  toolIds: readonly string[];
  /** Whether this build can compile an `llm` node (D9). */
  llmAvailable: boolean;
}

export type FlowAiFlowOutcome =
  | { ok: true; flow: SkillFlow; warnings: FlowValidationError[]; model: string }
  | { ok: false; message: string };

export type FlowAiExplainOutcome =
  | { ok: true; text: string; model: string }
  | { ok: false; message: string };

/**
 * The seam `createSkillDraftManager` takes. A fake in a test implements these
 * four methods and nothing else; a live build gets `createFlowAiHook` below.
 */
export interface FlowAiHook {
  generate(request: FlowAiFlowRequest): Promise<FlowAiFlowOutcome>;
  refine(request: FlowAiFlowRequest): Promise<FlowAiFlowOutcome>;
  fromCode(request: FlowAiFlowRequest): Promise<FlowAiFlowOutcome>;
  explain(request: {
    flow: SkillFlow;
    toolIds: readonly string[];
    llmAvailable: boolean;
  }): Promise<FlowAiExplainOutcome>;
}

/** The model name a deterministic answer reports (same convention as M26 D11). */
export const DEMO_FLOW_MODEL = 'demo';

/** Strip anything that could read as control text, then clamp (owner text is data). */
function clampText(raw: unknown, cap: number): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

/**
 * The deterministic graph for `generate` (D11 reused): args -> template ->
 * text output. It is a PURE skill (no tools, no model), valid by construction,
 * and it exercises the two nodes every flow needs, so the canvas, the compile,
 * the dry-run and the install are all walkable with no provider configured.
 *
 * The template text is the fixed placeholder `{{text}}` on purpose: the owner's
 * description is DATA, and a description containing `{{…}}` must not be able to
 * smuggle a placeholder (or a bad path) into the emitted code.
 */
export function demoGeneratedFlow(): SkillFlow {
  return {
    version: 1,
    nodes: [
      {
        id: 'input',
        type: 'input',
        position: { x: 40, y: 80 },
        data: { fields: [{ name: 'text', type: 'string', required: true }] },
      },
      {
        id: 'template',
        type: 'template',
        position: { x: 300, y: 80 },
        data: { text: '{{text}}' },
      },
      {
        id: 'output',
        type: 'output',
        position: { x: 560, y: 80 },
        data: { shape: 'text' },
      },
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'template' },
      { id: 'e2', source: 'template', target: 'output' },
    ],
  };
}

/**
 * The deterministic `from-code` graph: args -> JSON output (a passthrough).
 *
 * LOSSY BY CONSTRUCTION, and named that way everywhere it surfaces. Without a
 * model there is nothing that can read the entry source, and D7 forbids a
 * deterministic decompiler — so the demo answers the only honest thing it can:
 * a graph that reproduces the shape of the arguments and hands them back. It is
 * a PROPOSAL the owner accepts or rejects, exactly like a model's.
 */
export function demoFlowFromCode(): SkillFlow {
  return {
    version: 1,
    nodes: [
      {
        id: 'input',
        type: 'input',
        position: { x: 40, y: 80 },
        data: { fields: [{ name: 'args', type: 'json', required: false }] },
      },
      { id: 'output', type: 'output', position: { x: 360, y: 80 }, data: { shape: 'json' } },
    ],
    edges: [{ id: 'e1', source: 'input', target: 'output' }],
  };
}

/**
 * The operator, in the words a person reads. An explanation that says "pinned is
 * eq true" is a leaked enum; the flow's own eight operators have plain names and
 * an explanation is prose for the OWNER, so it uses them.
 */
function opWord(op: string): string {
  switch (op) {
    case 'eq':
      return 'equal to';
    case 'neq':
      return 'not equal to';
    case 'gt':
      return 'greater than';
    case 'gte':
      return 'at least';
    case 'lt':
      return 'less than';
    case 'lte':
      return 'at most';
    case 'contains':
      return 'containing';
    case 'exists':
      return 'present';
    default:
      // Unreachable for a validated flow; the raw op is the honest fallback.
      return op;
  }
}

/** The compared value as prose, omitted for the one-argument operator. */
function valueWord(op: string, value: unknown): string {
  if (op === 'exists') return '';
  return ` ${JSON.stringify(value) ?? 'undefined'}`;
}

/** One sentence per node, written for a person rather than for a compiler. */
function explainNode(node: SkillFlowNode): string {
  switch (node.type) {
    case 'input': {
      const names = node.data.fields.map((field) => field.name);
      return names.length === 0
        ? 'It starts with the arguments it is given.'
        : `It starts with the arguments ${names.join(', ')}.`;
    }
    case 'const':
      return 'It holds one fixed value.';
    case 'tool':
      return `It asks the tool ${node.data.toolId}, under the grants you gave it.`;
    case 'template':
      return 'It writes text, filling in the values it reads from the step before it.';
    case 'filter':
      return `It keeps only the items whose ${node.data.path} is ${opWord(node.data.op)}${valueWord(
        node.data.op,
        node.data.value,
      )}.`;
    case 'map':
      return `It turns each item into ${Object.keys(node.data.select).join(', ') || 'a smaller shape'}.`;
    case 'branch':
      return `It splits in two: one path when ${node.data.path} is ${opWord(
        node.data.op,
      )}${valueWord(node.data.op, node.data.value)}, the other when it is not.`;
    case 'merge':
      return node.data.shape === 'array'
        ? 'It joins its inputs into a list.'
        : `It joins its inputs into one object (${node.data.keys.join(', ') || 'its inputs'}).`;
    case 'llm':
      return 'It asks your configured model to answer a prompt built from the data — that text leaves your machine.';
    case 'output':
      return node.data.shape === 'text'
        ? 'It returns the result as text.'
        : 'It returns the result as data.';
  }
}

/**
 * The deterministic `explain`: a walkthrough DERIVED from the graph, so a build
 * with no model can still tell the owner what their flow does. Nothing here is
 * invented — each sentence is a fact about a node that exists — which is what
 * makes it honest to present beside a model's answer.
 */
export function demoFlowExplanation(flow: SkillFlow): string {
  const lines = [
    `This flow has ${flow.nodes.length} node${flow.nodes.length === 1 ? '' : 's'} and ${
      flow.edges.length
    } connection${flow.edges.length === 1 ? '' : 's'}.`,
    ...flow.nodes.map((node) => explainNode(node)),
    'Partner compiles it into the skill module for you — no JavaScript is written by hand, and nothing here runs until you test it and install it.',
  ];
  return lines.join(' ');
}

/** One live round-trip: call, then read the reply through the schema door. */
interface AskedFlow {
  ok: true;
  flow: SkillFlow;
  warnings: FlowValidationError[];
  model: string;
}
type AskResult = AskedFlow | { ok: false; code: ModelCallFailureCode | 'unusable_reply'; message: string };

async function askForFlow(
  options: FlowAiOptions,
  input: { system: string; user: string },
): Promise<AskResult> {
  const outcome: ModelCallOutcome = await runBoundedModelCall(options, input);
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
  const parsed = parseFlowReply(outcome.text);
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'unusable_reply',
      message:
        parsed.errors.length === 0
          ? parsed.error
          : `${parsed.error} (${parsed.errors
              .map((error) => (error.nodeId === null ? error.code : `${error.code}:${error.nodeId}`))
              .join(', ')})`,
    };
  }
  return { ok: true, flow: parsed.flow, warnings: parsed.warnings, model: outcome.model };
}

const USER_LINE = 'Answer with the single JSON object and nothing else.';

/**
 * The live hook. `demo` short-circuits before any provider is touched; a build
 * that is NOT in demo mode but has no provider configured falls back to the
 * same deterministic answers (M26 D11), while a provider that is configured but
 * unusable is reported as a failure.
 *
 * The division of labour is explicit: `askForFlow` says WHAT happened (with a
 * named code), and each verb decides what that means for its own answer. That
 * is why the fallback tests compare CODES rather than searching message text.
 */
export function createFlowAiHook(options: FlowAiOptions): FlowAiHook {
  const demoFlow = (flow: SkillFlow): FlowAiFlowOutcome => ({
    ok: true,
    flow,
    warnings: [],
    model: DEMO_FLOW_MODEL,
  });

  return {
    async generate(request: FlowAiFlowRequest): Promise<FlowAiFlowOutcome> {
      if (options.demo) return demoFlow(demoGeneratedFlow());
      const outcome = await askForFlow(options, {
        system: buildFlowGeneratePrompt({
          name: clampText(request.name, 80),
          description: clampText(request.description, 400),
          toolIds: request.toolIds,
          llmAvailable: request.llmAvailable,
        }),
        user: USER_LINE,
      });
      if (!outcome.ok) {
        // D11: no model configured is a WALKABLE state, so the deterministic
        // graph answers. A configured-but-unusable provider is not — it is
        // reported, because the owner asked for a model-written graph.
        if (outcome.code === 'no_model') return demoFlow(demoGeneratedFlow());
        return { ok: false, message: outcome.message };
      }
      return outcome;
    },

    async refine(request: FlowAiFlowRequest): Promise<FlowAiFlowOutcome> {
      const current = request.flow;
      if (current === undefined) return { ok: false, message: 'there is no flow to refine' };
      // No model, nothing changed: returning the graph UNCHANGED (and saying so
      // with model:'demo') is the honest answer. Inventing a "helpful" edit
      // would be a fabricated model reply.
      if (options.demo) return demoFlow(current);
      const outcome = await askForFlow(options, {
        system: buildFlowRefinePrompt({
          flow: current,
          instruction: clampText(request.instruction, 2000),
          toolIds: request.toolIds,
          llmAvailable: request.llmAvailable,
        }),
        user: USER_LINE,
      });
      if (!outcome.ok) {
        if (outcome.code === 'no_model') return demoFlow(current);
        return { ok: false, message: outcome.message };
      }
      return outcome;
    },

    async fromCode(request: FlowAiFlowRequest): Promise<FlowAiFlowOutcome> {
      if (options.demo) return demoFlow(demoFlowFromCode());
      const outcome = await askForFlow(options, {
        system: buildFlowFromCodePrompt({
          code: request.code ?? '',
          manifestText: request.manifestText ?? '',
          toolIds: request.toolIds,
          llmAvailable: request.llmAvailable,
        }),
        user: USER_LINE,
      });
      if (!outcome.ok) {
        if (outcome.code === 'no_model') return demoFlow(demoFlowFromCode());
        return { ok: false, message: outcome.message };
      }
      return outcome;
    },

    async explain(request: {
      flow: SkillFlow;
      toolIds: readonly string[];
      llmAvailable: boolean;
    }): Promise<FlowAiExplainOutcome> {
      const demo = (): FlowAiExplainOutcome => ({
        ok: true,
        text: demoFlowExplanation(request.flow),
        model: DEMO_FLOW_MODEL,
      });
      if (options.demo) return demo();
      const outcome: ModelCallOutcome = await runBoundedModelCall(options, {
        system: buildFlowExplainPrompt({
          flow: request.flow,
          toolIds: request.toolIds,
          llmAvailable: request.llmAvailable,
        }),
        user: 'Explain this flow to its owner now.',
      });
      if (!outcome.ok) {
        // An explanation is a courtesy, never a gate: no model means the
        // walkthrough DERIVED from the graph, not an error card. Any other
        // failure is reported, because it may be a key or an upstream problem
        // the owner wants to know about.
        if (outcome.code === 'no_model') return demo();
        return { ok: false, message: outcome.message };
      }
      return { ok: true, text: outcome.text, model: outcome.model };
    },
  };
}
