/**
 * M28 slice C — the Flow canvas's DOM-free layer (PLAN-M28.md D2/D9/D10).
 *
 * WHY THIS FILE EXISTS, and what each half is allowed to claim:
 *
 *   1. **The palette is a capability list, not a wish list (D9).** `paletteFor`
 *      omits the `llm` entry when this build has no model reach, because offering
 *      a node whose compile ends in `llm_not_available` would make the palette
 *      lie. The order is D2's vocabulary order, so the rail never reshuffles.
 *   2. **`structuralIssues` is a CLIENT-SIDE MIRROR, for instant feedback only.**
 *      The core is the authority — `validateFlow` (the runtime door) and
 *      `compileFlow` (the total compiler) decide whether a flow is usable, and
 *      `core/test/skills/flowCompile.test.ts` asserts their codes. This mirror
 *      exists so a problem appears while the author is drawing instead of at the
 *      next save, and it is written to agree with the core's CODES for the
 *      cases both can see, using the core's own wording where they overlap. It
 *      mirrors codes, not the whole checker: the bounded counts, the JSON
 *      serializability rules and `tool_requires_medium` (which needs the
 *      registry's risk tiers, not just ids) are NOT mirrored. **It therefore
 *      never claims a flow is compilable** — a clean mirror is not a pass, and
 *      nothing in the UI may render it as one.
 *   3. **Auto-arrange is D10 and nothing more.** A stored position of exactly
 *      `{x: 0, y: 0}` is what `newFlowNode` and the palette produce and counts as
 *      UNSET; every other position is an author drag and is NEVER moved. The
 *      ranking and placement are `layOutGraph`'s — the one layout implementation
 *      in the repo (M16), reused rather than re-derived.
 *   4. **Ids are deterministic and stable across reloads** (`node-1`, `node-2`,
 *      …). A canvas has no session identity to lean on: an id that changed on
 *      reload would break every edge that names it, and one that depended on
 *      `Date.now()` would break the flow→code hash (D4/D6).
 *
 * Nothing here imports React, the DOM or core: node-env tests exercise all of it.
 */
import type {
  FlowFieldSpec,
  FlowFieldType,
  FlowInputNode,
  FlowOperator,
  FlowPosition,
  FlowValidationError,
  SkillFlow,
  SkillFlowEdge,
  SkillFlowNode,
  SkillFlowNodeType,
  SkillFlowProposal,
} from '@partner/shared';
import { layOutGraph, type LayoutNodeInput } from './graph-layout.js';
import { clampText } from './memory-helpers.js';

// ---------------------------------------------------------------------------
// The vocabulary (D2) and the palette (D9)
// ---------------------------------------------------------------------------

/** D2's order. The palette, the Nodes table's type select and the docs share it. */
export const FLOW_NODE_ORDER: readonly SkillFlowNodeType[] = [
  'input',
  'const',
  'tool',
  'template',
  'filter',
  'map',
  'branch',
  'merge',
  'llm',
  'output',
];

/** Every type's name as the owner reads it — never the wire enum. */
export const FLOW_NODE_LABELS: Record<SkillFlowNodeType, string> = {
  input: 'Input',
  const: 'Constant',
  tool: 'Tool',
  template: 'Template',
  filter: 'Filter',
  map: 'Map',
  branch: 'Branch',
  merge: 'Merge',
  llm: 'Model',
  output: 'Output',
};

/** One line per type: what it does, in the owner's words. */
const FLOW_NODE_HINTS: Record<SkillFlowNodeType, string> = {
  input: 'Declares the arguments this skill is given.',
  const: 'A fixed JSON value you type in.',
  tool: 'One call to a broker tool — you pick which.',
  template: 'Text with {{path}} placeholders filled from the data.',
  filter: 'Keeps the list items that match a condition.',
  map: 'Projects each list item to the keys you choose.',
  branch: 'Sends the value down "then" or "else".',
  merge: 'Joins its inputs into one object or one list.',
  llm: 'Asks the model once; the reply comes back as text.',
  output: 'What running the skill returns.',
};

export interface FlowPaletteEntry {
  type: SkillFlowNodeType;
  label: string;
  hint: string;
}

/**
 * The nodes this build can actually compile. `llm` is absent without model
 * reach (D9) — the palette is a list of capabilities, and a node type whose
 * compile is refused by construction is not one of them.
 */
export function paletteFor(options: { llmAvailable: boolean }): FlowPaletteEntry[] {
  return FLOW_NODE_ORDER.filter((type) => type !== 'llm' || options.llmAvailable).map((type) => ({
    type,
    label: FLOW_NODE_LABELS[type],
    hint: FLOW_NODE_HINTS[type],
  }));
}

// ---------------------------------------------------------------------------
// The path grammar and the operators (D3), mirrored from the core
// ---------------------------------------------------------------------------

/**
 * The ONE path grammar (`FLOW_PATH_RE` in `core/src/skills/flow/schema.ts`).
 * Kept as a local mirror ON PURPOSE: the web bundle cannot import core, and a
 * canvas that accepted a path the core refuses would teach the wrong thing.
 */
const FLOW_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/;

/**
 * Names a path may never use, though the grammar would allow them — the core
 * refuses prototype reaches and so must the mirror, or the canvas would show a
 * node as fine and the compiler would refuse it (`bad_path`).
 */
const FORBIDDEN_PATH_NAMES: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** Mirrors the core's `isFlowPath` (grammar + forbidden segments). */
export function isFlowPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 256) return false;
  if (!FLOW_PATH_RE.test(value)) return false;
  const names = value.split('.').map((part) => part.replace(/\[\d+\]/g, ''));
  return !names.some((name) => FORBIDDEN_PATH_NAMES.includes(name));
}

/** The fixed operator set (D2/D3). There is no expression language to offer. */
export const FLOW_OPERATORS: readonly FlowOperator[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'exists',
];

export const FLOW_OPERATOR_LABELS: Record<FlowOperator, string> = {
  eq: 'equals',
  neq: 'is not',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  exists: 'exists',
};

export const FLOW_FIELD_TYPES: readonly FlowFieldType[] = ['string', 'number', 'boolean', 'json'];

/** An operator as the owner reads it; an unknown value is named, never invented. */
export function operatorLabel(op: string): string {
  return (FLOW_OPERATOR_LABELS as Record<string, string | undefined>)[op] ?? op;
}

function isFlowOperator(value: unknown): value is FlowOperator {
  return typeof value === 'string' && (FLOW_OPERATORS as readonly string[]).includes(value);
}

/** The `{{path}}` placeholders in a template or a prompt, in document order. */
function templatePaths(text: string): string[] {
  const paths: string[] = [];
  const pattern = /\{\{([^{}]*)\}\}/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    paths.push((match[1] ?? '').trim());
    match = pattern.exec(text);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Ids: deterministic, collision-free, stable across reloads
// ---------------------------------------------------------------------------

/**
 * `node-1`, `node-2`, … — one past the highest number already in the document.
 * Why the highest rather than the smallest free slot: an id is never reused
 * after a delete, so a stale edge in a hand-edited document cannot silently
 * re-attach itself to a freshly added node. No counter, no timestamp, no
 * randomness — reload the same flow and the next add gets the same id.
 */
export function newNodeId(flow: SkillFlow): string {
  return nextId('node', flow.nodes.map((node) => node.id));
}

/** `edge-1`, `edge-2`, … — the same rule as `newNodeId`, for the same reasons. */
export function newEdgeId(flow: SkillFlow): string {
  return nextId('edge', flow.edges.map((edge) => edge.id));
}

function nextId(prefix: string, ids: readonly string[]): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match === null) continue;
    highest = Math.max(highest, Number.parseInt(match[1] as string, 10));
  }
  return `${prefix}-${highest + 1}`;
}

// ---------------------------------------------------------------------------
// A new node and the unset-position rule (D10)
// ---------------------------------------------------------------------------

/**
 * A node of `type` with the shape that type requires and NOTHING invented.
 *
 * Three defaults are deliberately left incomplete, because a sensible value
 * cannot be guessed and a guess would look configured: a `tool` node has no tool
 * id yet, and a `filter`/`branch` has no field path yet. The mirror names each
 * one (`bad_node` / `bad_path`, the codes the core would use) so the author sees
 * the hole instead of a node that silently means something.
 *
 * The id is the same fresh `node-1` on every call: this function cannot see the
 * document, so it cannot know which numbers are taken. Adding to an existing
 * flow MUST therefore re-id with `newNodeId(flow)` — the palette does exactly
 * that, and the tests assert the composition is collision-free.
 */
export function newFlowNode(type: SkillFlowNodeType, position: FlowPosition): SkillFlowNode {
  const base = { id: 'node-1', position: { x: position.x, y: position.y } };
  switch (type) {
    case 'input':
      return { ...base, type, data: { fields: [] } };
    case 'const':
      return { ...base, type, data: { value: null } };
    case 'tool':
      return { ...base, type, data: { toolId: '', args: {} } };
    case 'template':
      return { ...base, type, data: { text: '' } };
    case 'filter':
      // `exists` takes no comparison value, so the node is one field away from
      // complete rather than one field AND one value away.
      return { ...base, type, data: { path: '', op: 'exists' } };
    case 'map':
      return { ...base, type, data: { select: {} } };
    case 'branch':
      return { ...base, type, data: { path: '', op: 'exists' } };
    case 'merge':
      return { ...base, type, data: { shape: 'object', keys: [] } };
    case 'llm':
      return { ...base, type, data: { prompt: '' } };
    case 'output':
      return { ...base, type, data: { shape: 'json' } };
  }
}

/**
 * D10: the palette places a node at exactly `{x: 0, y: 0}`, and that — and only
 * that — means "no position chosen yet". Any other pair is the author's drag.
 */
function isUnsetPosition(position: FlowPosition): boolean {
  return position.x === 0 && position.y === 0;
}

// ---------------------------------------------------------------------------
// The args form, the tool set, and the derived facts D5/D6 lean on
// ---------------------------------------------------------------------------

/**
 * The `input` node's fields — the args the runner seeds a test run with. Mirrors
 * the compiler's own `argsForm` derivation (the first input node, in document
 * order), so the Studio seeds a run with exactly the fields the core will
 * declare.
 */
export function flowArgsForm(flow: SkillFlow): FlowFieldSpec[] {
  const input = flow.nodes.find((node): node is FlowInputNode => node.type === 'input');
  return input === undefined ? [] : input.data.fields.map((field) => ({ ...field }));
}

/**
 * The tool ids this graph requests — de-duplicated and sorted, which is the
 * shape D5 derives `permissions.tools` from. An unchosen tool (`toolId: ''`) is
 * not a request; it is the `bad_node` the mirror already reports.
 */
export function flowToolIds(flow: SkillFlow): string[] {
  const ids = new Set<string>();
  for (const node of flow.nodes) {
    if (node.type === 'tool' && node.data.toolId !== '') ids.add(node.data.toolId);
  }
  return [...ids].sort();
}

// ---------------------------------------------------------------------------
// The structural mirror (instant feedback only — the core is the authority)
// ---------------------------------------------------------------------------

function issue(code: FlowValidationError['code'], nodeId: string | null, message: string): FlowValidationError {
  return { code, nodeId, message };
}

/** The core's `badArgPath` heuristic: an identifier-ish string that is not a path. */
function looksLikePathAttempt(value: string): boolean {
  return /^[A-Za-z_$]/.test(value) && !/\s/.test(value);
}

/**
 * The structural problems the canvas can see for itself, in the core's order
 * (schema-level edge faults, the one-input/one-output rule, per-node edge rules,
 * per-node data, model reach, then the cycle) with the core's codes and — where
 * they overlap — the core's wording.
 *
 * @param flow the document as it stands on screen
 * @param options `llmAvailable` decides the `llm_not_available` check (D9);
 *   `toolIds` is the broker vocabulary the core's registry would be asked for,
 *   so an id outside it is `unknown_tool` here too.
 */
export function structuralIssues(
  flow: SkillFlow,
  options: { llmAvailable: boolean; toolIds: readonly string[] },
): FlowValidationError[] {
  const issues: FlowValidationError[] = [];
  const byId = new Map<string, SkillFlowNode>(flow.nodes.map((node) => [node.id, node]));
  const knownTools = new Set(options.toolIds);

  // --- schema-level: an edge that names a node the document does not have ----
  for (const edge of flow.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      issues.push(
        issue('dangling_edge', edge.id, `edge "${edge.id}" points at a node that does not exist`),
      );
    }
  }

  const inbound = new Map<string, SkillFlowEdge[]>();
  for (const node of flow.nodes) inbound.set(node.id, []);
  for (const edge of flow.edges) inbound.get(edge.target)?.push(edge);

  // --- exactly one input and exactly one output -----------------------------
  const inputs = flow.nodes.filter((node) => node.type === 'input');
  const outputs = flow.nodes.filter((node) => node.type === 'output');
  if (inputs.length === 0) {
    issues.push(
      issue('missing_input', null, 'a flow needs exactly one input node (it declares the args)'),
    );
  } else if (inputs.length > 1) {
    for (const node of inputs) {
      issues.push(issue('duplicate_input', node.id, 'a flow may have only one input node'));
    }
  }
  if (outputs.length === 0) {
    issues.push(
      issue('missing_output', null, 'a flow needs exactly one output node (it is what run returns)'),
    );
  } else if (outputs.length > 1) {
    for (const node of outputs.slice(1)) {
      issues.push(issue('bad_node', node.id, 'a flow may have only one output node'));
    }
  }

  // --- per-node edge rules (the core's `analyse`) ---------------------------
  for (const node of flow.nodes) {
    const incoming = inbound.get(node.id) ?? [];
    const isSource = node.type === 'input' || node.type === 'const';
    if (isSource && incoming.length > 0) {
      issues.push(
        issue(
          'bad_node',
          node.id,
          `a ${node.type} node takes no inbound edge (it is a source of data)`,
        ),
      );
    }
    if (!isSource && node.type !== 'merge' && incoming.length > 1) {
      issues.push(
        issue(
          'bad_node',
          node.id,
          `this node has ${incoming.length} inbound edges — only a merge node may join more than one`,
        ),
      );
    }
    for (const edge of incoming) {
      const source = byId.get(edge.source);
      if (source === undefined) continue;
      const handle = edge.sourceHandle ?? null;
      if (source.type === 'branch') {
        if (handle !== null && handle !== 'then' && handle !== 'else') {
          issues.push(
            issue(
              'bad_node',
              edge.id,
              `a branch emits "then" or "else", not ${JSON.stringify(handle)}`,
            ),
          );
        }
      } else if (handle !== null) {
        // Attributed to the EDGE, as the core attributes it: the strip names the
        // same offender either way, and no node owns the fault.
        issues.push(
          issue('bad_node', edge.id, `only a branch node has named outputs (${source.type} has one)`),
        );
      }
    }
  }

  // --- per-node data the editor can break ----------------------------------
  for (const node of flow.nodes) {
    switch (node.type) {
      case 'input': {
        const seen = new Set<string>();
        for (const field of node.data.fields) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name)) {
            issues.push(
              issue(
                'bad_node',
                node.id,
                `field name ${JSON.stringify(field.name)} must be a plain identifier`,
              ),
            );
            continue;
          }
          if (seen.has(field.name)) {
            issues.push(issue('bad_node', node.id, `duplicate field name "${field.name}"`));
            continue;
          }
          seen.add(field.name);
        }
        break;
      }
      case 'tool': {
        if (node.data.toolId === '') {
          issues.push(issue('bad_node', node.id, 'a tool node needs a tool id'));
          break;
        }
        if (!knownTools.has(node.data.toolId)) {
          issues.push(
            issue(
              'unknown_tool',
              node.id,
              `no broker tool is registered as ${JSON.stringify(node.data.toolId)}`,
            ),
          );
        }
        for (const [key, value] of Object.entries(node.data.args)) {
          if (typeof value === 'string' && !isFlowPath(value) && looksLikePathAttempt(value)) {
            issues.push(
              issue('bad_path', node.id, `arg "${key}" is not a valid path: ${JSON.stringify(value)}`),
            );
          }
        }
        break;
      }
      case 'filter':
      case 'branch': {
        if (!isFlowPath(node.data.path)) {
          issues.push(
            issue(
              'bad_path',
              node.id,
              `path ${JSON.stringify(node.data.path)} must match ${FLOW_PATH_RE.source}`,
            ),
          );
        }
        if (!isFlowOperator(node.data.op)) {
          issues.push(
            issue('bad_operator', node.id, `unknown operator ${JSON.stringify(node.data.op)}`),
          );
        } else if (node.data.op !== 'exists' && !('value' in node.data)) {
          issues.push(
            issue('bad_node', node.id, `operator "${node.data.op}" needs a \`value\` to compare against`),
          );
        }
        break;
      }
      case 'map': {
        const keys = Object.keys(node.data.select);
        if (keys.length === 0) {
          issues.push(issue('bad_node', node.id, 'a map node needs at least one selected key'));
        }
        for (const key of keys) {
          if (!isFlowPath(node.data.select[key])) {
            issues.push(
              issue(
                'bad_path',
                node.id,
                `select["${key}"] must be a valid path (got ${JSON.stringify(node.data.select[key])})`,
              ),
            );
          }
        }
        break;
      }
      case 'template':
      case 'llm': {
        const text = node.type === 'template' ? node.data.text : node.data.prompt;
        for (const path of templatePaths(text)) {
          if (!isFlowPath(path)) {
            issues.push(
              issue('bad_path', node.id, `placeholder {{${path}}} is not a valid path`),
            );
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // --- model reach (D9) -----------------------------------------------------
  if (!options.llmAvailable) {
    for (const node of flow.nodes) {
      if (node.type !== 'llm') continue;
      issues.push(
        issue(
          'llm_not_available',
          node.id,
          'this build has no model reach, so an llm node cannot be compiled',
        ),
      );
    }
  }

  // --- cycle: the core's Kahn frontier, so the named offender matches --------
  const indegree = new Map<string, number>();
  for (const node of flow.nodes) {
    indegree.set(
      node.id,
      (inbound.get(node.id) ?? []).filter((edge) => byId.has(edge.source)).length,
    );
  }
  const remaining = new Set<string>(flow.nodes.map((node) => node.id));
  let frontier = [...remaining].filter((id) => (indegree.get(id) ?? 0) === 0).sort();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      remaining.delete(id);
      for (const edge of flow.edges) {
        if (edge.source !== id || !byId.has(edge.target)) continue;
        indegree.set(edge.target, (indegree.get(edge.target) ?? 1) - 1);
        if ((indegree.get(edge.target) ?? 0) === 0) next.push(edge.target);
      }
    }
    frontier = [...new Set(next)].sort();
  }
  if (remaining.size > 0) {
    issues.push(
      issue(
        'cycle',
        [...remaining].sort()[0] ?? null,
        'the flow has a cycle — data must move in one direction only',
      ),
    );
  }

  return issues;
}

/**
 * Issues grouped by the node they belong to — the canvas's decoration input.
 * Keys are whatever the error attributes, which is a node id in every case
 * except the two edge-handle faults the core attributes to the EDGE (those
 * appear in the strip, and name no node because none is at fault).
 */
export function flowNodeErrors(
  errors: readonly FlowValidationError[],
): Map<string, FlowValidationError[]> {
  const byNode = new Map<string, FlowValidationError[]>();
  for (const error of errors) {
    if (error.nodeId === null || error.nodeId === '') continue;
    const list = byNode.get(error.nodeId) ?? [];
    list.push(error);
    byNode.set(error.nodeId, list);
  }
  return byNode;
}

// ---------------------------------------------------------------------------
// Auto-arrange (D10) — layout is `layOutGraph`'s job, not a second one here
// ---------------------------------------------------------------------------

/**
 * Fill in every UNSET position with the shared layered layout. Nodes the author
 * dragged keep their exact position (the `{x: 0, y: 0}` rule above), the
 * document order is preserved, and the result is deterministic: the same flow
 * always yields the same positions, which is what lets this be an ordinary
 * `onChange`.
 */
export function autoArrangeFlow(flow: SkillFlow): SkillFlow {
  const inputs: LayoutNodeInput[] = flow.nodes.map((node) => ({
    id: node.id,
    // The node's own one-line summary is its layout title: `layOutGraph` orders
    // a rank by title, and the summary is the text a reader sees on the node.
    title: nodeSummary(node),
    x: isUnsetPosition(node.position) ? null : node.position.x,
    y: isUnsetPosition(node.position) ? null : node.position.y,
  }));
  const edges = flow.edges.map((edge) => ({ source: edge.source, target: edge.target }));
  const positions = new Map(layOutGraph(inputs, edges).map((at) => [at.id, at]));
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const at = positions.get(node.id);
      return at === undefined ? node : { ...node, position: { x: at.x, y: at.y } };
    }),
  };
}

// ---------------------------------------------------------------------------
// Lines and rows: what a node says about itself
// ---------------------------------------------------------------------------

/** A JSON value as one short line; `undefined` cannot be JSON, so it is named. */
function jsonPreview(value: unknown): string {
  const text = JSON.stringify(value);
  return clampText(text === undefined ? 'not set' : text, 60);
}

function squashed(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A path as the summary reads it; an unset path is named, never left blank. */
function pathLabel(path: string): string {
  return isFlowPath(path) ? path : 'an unset field';
}

/** The predicate half of a filter/branch summary (`exists` has no value). */
function predicateText(path: string, op: string, value: unknown, hasValue: boolean): string {
  const opText = operatorLabel(op);
  return hasValue ? `${pathLabel(path)} ${opText} ${jsonPreview(value)}` : `${pathLabel(path)} ${opText}`;
}

/**
 * The one line a node shows on the canvas and in the Nodes table. Deliberately
 * built from structure and declared ids only — never from text the owner typed
 * beyond a clamped first line — and it doubles as the layout title.
 */
export function nodeSummary(node: SkillFlowNode): string {
  switch (node.type) {
    case 'input': {
      const names = node.data.fields.map((field) => field.name || '(unnamed)');
      return names.length === 0 ? 'No arguments declared' : `Args: ${names.join(', ')}`;
    }
    case 'const':
      return `Value: ${jsonPreview(node.data.value)}`;
    case 'tool':
      return node.data.toolId === '' ? 'No tool chosen' : node.data.toolId;
    case 'template':
      return node.data.text.trim() === ''
        ? 'Empty template'
        : `Text: ${clampText(squashed(node.data.text), 60)}`;
    case 'filter':
      return isFlowPath(node.data.path)
        ? `Keep items where ${predicateText(node.data.path, node.data.op, node.data.value, 'value' in node.data)}`
        : 'Needs a field path';
    case 'map': {
      const keys = Object.keys(node.data.select);
      return keys.length === 0 ? 'No keys selected' : `Projects to ${keys.join(', ')}`;
    }
    case 'branch':
      return isFlowPath(node.data.path)
        ? `Then/else on ${predicateText(node.data.path, node.data.op, node.data.value, 'value' in node.data)}`
        : 'Needs a field path';
    case 'merge': {
      const keys = node.data.keys;
      const shape = node.data.shape === 'array' ? 'list' : 'object';
      return keys.length === 0 ? `Merge into one ${shape}` : `Merge into one ${shape}: ${keys.join(', ')}`;
    }
    case 'llm':
      return node.data.prompt.trim() === ''
        ? 'Empty prompt'
        : `Prompt: ${clampText(squashed(node.data.prompt), 60)}`;
    case 'output':
      return node.data.shape === 'text' ? 'Returns text' : 'Returns JSON';
  }
}

/**
 * The node's declared facts as label/value rows — the read-only half of the
 * inspector (and of a Nodes-table row), so the author can see what is stored
 * without every value being a form control. Rows are derived from shape and
 * declared ids only: no code, no prompt bodies beyond a clamp.
 */
export function nodeDetailRows(node: SkillFlowNode): Array<{ label: string; value: string }> {
  switch (node.type) {
    case 'input':
      return node.data.fields.length === 0
        ? [{ label: 'Fields', value: 'none declared — this skill takes no arguments yet' }]
        : node.data.fields.map((field) => ({
            label: field.name || '(unnamed)',
            value: `${field.type}${field.required ? ' · required' : ' · optional'}`,
          }));
    case 'const':
      return [{ label: 'Value', value: jsonPreview(node.data.value) }];
    case 'tool': {
      const rows = [
        { label: 'Tool', value: node.data.toolId === '' ? 'not chosen yet' : node.data.toolId },
      ];
      for (const key of Object.keys(node.data.args)) {
        const value = node.data.args[key];
        rows.push({
          label: key,
          value: typeof value === 'string' ? value : jsonPreview(value),
        });
      }
      return rows;
    }
    case 'template': {
      const paths = templatePaths(node.data.text);
      return [
        { label: 'Text', value: node.data.text === '' ? 'empty' : clampText(squashed(node.data.text), 80) },
        { label: 'Fills', value: paths.length === 0 ? 'no placeholders' : paths.join(', ') },
      ];
    }
    case 'filter':
    case 'branch': {
      const rows = [
        { label: 'Field', value: pathLabel(node.data.path) },
        { label: 'Operator', value: operatorLabel(node.data.op) },
      ];
      if (node.data.op !== 'exists') {
        rows.push({ label: 'Value', value: jsonPreview(node.data.value) });
      }
      return rows;
    }
    case 'map': {
      const keys = Object.keys(node.data.select);
      if (keys.length === 0) return [{ label: 'Keys', value: 'none selected yet' }];
      return keys.map((key) => ({ label: key, value: node.data.select[key] as string }));
    }
    case 'merge': {
      const keys = node.data.keys;
      return [
        { label: 'Shape', value: node.data.shape === 'array' ? 'one list' : 'one object' },
        {
          label: 'Keys',
          value: keys.length === 0 ? 'none declared — inbound edges name their own keys' : keys.join(', '),
        },
      ];
    }
    case 'llm':
      return [
        {
          label: 'Prompt',
          value: node.data.prompt === '' ? 'empty' : clampText(squashed(node.data.prompt), 80),
        },
      ];
    case 'output':
      return [
        { label: 'Shape', value: node.data.shape === 'text' ? 'Text' : 'JSON' },
      ];
  }
}

/** How many ids a diff row lists before it summarises the tail. */
const DIFF_LIST_MAX = 6;

function listDetail(ids: readonly string[]): string {
  if (ids.length <= DIFF_LIST_MAX) return ids.join(', ');
  return `${ids.slice(0, DIFF_LIST_MAX).join(', ')} (+${ids.length - DIFF_LIST_MAX} more)`;
}

/**
 * The proposal card's rows (D8). Only non-empty buckets appear: a row reading
 * "Nodes added: none" would look like a change report for a proposal that
 * changed nothing, and the card says "no change" for the all-zero case.
 */
export function proposalDiffRows(
  diff: SkillFlowProposal['diff'],
): Array<{ label: string; detail: string }> {
  const rows: Array<{ label: string; detail: string }> = [];
  if (diff.nodesAdded.length > 0) {
    rows.push({ label: 'Nodes added', detail: listDetail(diff.nodesAdded) });
  }
  if (diff.nodesRemoved.length > 0) {
    rows.push({ label: 'Nodes removed', detail: listDetail(diff.nodesRemoved) });
  }
  if (diff.nodesChanged.length > 0) {
    rows.push({ label: 'Nodes changed', detail: listDetail(diff.nodesChanged) });
  }
  if (diff.edgesChanged > 0) {
    rows.push({ label: 'Edges changed', detail: String(diff.edgesChanged) });
  }
  return rows;
}

/** The text one edge's controls name it by (Nodes view, canvas edge label). */
export function edgeLabel(edge: SkillFlowEdge): string {
  const handle =
    edge.sourceHandle === null || edge.sourceHandle === undefined ? '' : ` (${edge.sourceHandle})`;
  return `${edge.source}${handle} → ${edge.target}`;
}
