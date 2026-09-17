/**
 * M28 slice A — the flow compiler (PLAN-M28.md, D1/D3/D4/D5).
 *
 * Turns a validated `SkillFlow` into the ONE artifact the rest of the system
 * already understands: an ES module exporting `run(args)` for the M8 sandbox.
 * There is no second runtime, no interpreter and no `flow.json` shipped — a
 * flow is a way to AUTHOR the code that installs.
 *
 * FOUR PROPERTIES THIS FILE EXISTS TO GUARANTEE:
 *
 *   1. **Deterministic** (D4). Nodes are emitted in an order derived from the
 *      graph's structure — `(rank, nodeId)`, where `rank` is the longest
 *      distance from a source — never in array-iteration order. Shuffling the
 *      `nodes`/`edges` arrays of the same graph produces BYTE-IDENTICAL output,
 *      which is what makes D6's staleness check a hash comparison rather than a
 *      flag nobody can trust.
 *   2. **Total.** Every one of the ten node types has an emitter, and every
 *      failure mode is a NAMED error before a single byte is emitted (a cycle,
 *      a dangling edge, a missing `output`, more than one `input`). There is no
 *      path through this function that throws or half-emits.
 *   3. **Non-injectable** (D3). Paths are validated by the schema against a
 *      fixed grammar and re-checked here, then compiled to an optional-chained
 *      ACCESSOR — user text never becomes user code. Template literals are
 *      escaped (`\`, backtick, `${`), values are emitted through
 *      `JSON.parse(...)` of a JSON string literal (so a `__proto__` key in a
 *      `const` cannot pollute a prototype), and no interpolation site accepts
 *      raw text.
 *   4. **The permission set is DERIVED** (D5). `tools` is exactly the union of
 *      the graph's `tool` node ids — the caller writes that into
 *      `permissions.tools`, so the consent summary cannot drift from the code.
 *
 * SEMANTICS, stated once because the compiler is where they become real:
 *   - A node's **scope** is the value of its single inbound data edge; a node
 *     with no inbound edge reads the skill's `args` (`__args`).
 *   - **A node whose scope is `undefined` does nothing.** That is what makes
 *     `branch` meaningful under D2's "sequential awaits only" ceiling: a
 *     non-taken port yields `undefined`, so the nodes behind it skip their tool
 *     and model calls instead of running them with empty data. (Both ports are
 *     still *evaluated* — this is not a conditional jump — but nothing beyond
 *     the guard does I/O.)
 *   - `filter` / `map` paths are relative to the ARRAY ITEM; every other path is
 *     relative to the node's scope.
 *   - `merge` joins its inbound edges, ordered deterministically.
 *   - `output` returns; `shape: 'text'` stringifies, `'json'` passes through.
 */
import { createHash } from 'node:crypto';
import type {
  FlowFieldSpec,
  FlowOperator,
  FlowPath,
  FlowValidationError,
  SkillFlow,
  SkillFlowEdge,
  SkillFlowNode,
  ToolRisk,
} from '@partner/shared';
import { MAX_ENTRY_BYTES } from '../manifest.js';
import { FLOW_LITERAL_KEY, isFlowPath, validateFlow } from './schema.js';

const RISK_RANK: Record<ToolRisk, number> = { low: 0, medium: 1, high: 2 };

export interface FlowCompileOptions {
  /**
   * The broker tool registry (D5). EVERY `tool` node's id must be in here; a
   * `tool` node can only pick from it. Slice B supplies this from
   * `defaultToolRegistry()`.
   */
  registry: ReadonlySet<string>;
  /**
   * M27 S5 (D9). When false/absent an `llm` node is refused with
   * `llm_not_available`, so the palette can never offer a node the build cannot
   * compile.
   */
  llmAvailable?: boolean;
  /** The manifest's own risk tier; enables `tool_requires_medium` when set. */
  riskCeiling?: ToolRisk;
  /** A tool's risk from the broker manifest (needed only with `riskCeiling`). */
  riskOf?: (toolId: string) => ToolRisk | null;
}

// ---------------------------------------------------------------------------
// Emission primitives — the whole injection boundary is in these four helpers.
// ---------------------------------------------------------------------------

/** Escape text destined to be a template literal's LITERAL part. */
function escapeTemplateText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * A JS string literal for arbitrary text. `JSON.stringify` is the escaper
 * (quotes, backslashes and control characters), plus the two line separators
 * that are legal in JSON but were not always legal in a JS string literal.
 */
function jsString(text: string): string {
  return JSON.stringify(text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * A JSON value as the JS expression that produces it.
 *
 * Primitives are emitted as their own literal (`JSON.stringify` IS a JS literal
 * escaper for them). Objects and arrays go through `JSON.parse` of a string
 * literal instead of a bare `{...}` literal, so a `__proto__` key inside a
 * `const` node's value becomes an own property rather than mutating a
 * prototype — the one way a value authored by a user or a model could reach
 * past its own data.
 */
function jsValue(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null';
  const safe = json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  if (value === null || typeof value !== 'object') return safe;
  return `JSON.parse(${jsString(json)})`;
}

/** The segments of a validated path: property names and numeric indexes. */
function pathSegments(path: FlowPath): string[] {
  return path.match(/[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/g) ?? [];
}

/**
 * A validated path compiled to an optional-chained accessor over `base`.
 * Re-validated here (never assumed): if the grammar slipped, the accessor is
 * refused rather than emitted, because this is the one place user text becomes
 * an expression.
 */
function accessor(base: string, path: FlowPath): string {
  if (!isFlowPath(path)) return 'undefined';
  let out = base;
  for (const segment of pathSegments(path)) {
    // A property segment is `a`, an index segment is `[0]`; both chain safely
    // with `?.` (`?.[0]` is the optional computed form).
    out += `?.${segment}`;
  }
  return out;
}

/** A predicate over `base` for one operator. Always parenthesised. */
function predicate(base: string, path: FlowPath, op: FlowOperator, value: unknown): string {
  const left = accessor(base, path);
  switch (op) {
    case 'eq':
      return `(${left} === ${jsValue(value)})`;
    case 'neq':
      return `(${left} !== ${jsValue(value)})`;
    case 'gt':
      return `(${left} > ${jsValue(value)})`;
    case 'gte':
      return `(${left} >= ${jsValue(value)})`;
    case 'lt':
      return `(${left} < ${jsValue(value)})`;
    case 'lte':
      return `(${left} <= ${jsValue(value)})`;
    case 'contains':
      return `(Array.isArray(${left}) ? ${left}.includes(${jsValue(value)}) : (typeof ${left} === 'string' && ${left}.includes(${jsValue(value)})))`;
    case 'exists':
      return `(${left} !== undefined && ${left} !== null)`;
    default:
      // Unreachable for a validated operator; kept total on purpose.
      return '(false)';
  }
}

/**
 * A `{{path}}` template compiled to a template literal over `base`. Everything
 * outside a placeholder is escaped LITERAL text (D3) — a backtick or a `${` in
 * the user's prose can never open an expression.
 */
function templateLiteral(base: string, text: string): string {
  const pattern = /\{\{([^{}]*)\}\}/g;
  let out = '`';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    out += escapeTemplateText(text.slice(cursor, match.index));
    const path = (match[1] ?? '').trim();
    out += `\${${accessor(base, path)}}`;
    cursor = match.index + match[0].length;
  }
  out += escapeTemplateText(text.slice(cursor));
  return `${out}\``;
}

/** A value position that may be a path reference (the `tool.args` rule). */
function argValue(base: string, value: unknown): string {
  if (typeof value === 'string' && isFlowPath(value)) return accessor(base, value);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && FLOW_LITERAL_KEY in record) {
      return jsValue(record[FLOW_LITERAL_KEY]);
    }
  }
  return jsValue(value);
}

// ---------------------------------------------------------------------------
// Graph analysis
// ---------------------------------------------------------------------------

interface Analysis {
  errors: FlowValidationError[];
  warnings: FlowValidationError[];
  order: SkillFlowNode[];
  rankOf: Map<string, number>;
  inboundOf: Map<string, SkillFlowEdge[]>;
}

function err(
  list: FlowValidationError[],
  code: FlowValidationError['code'],
  nodeId: string | null,
  message: string,
): void {
  list.push({ code, nodeId, message });
}

/** Outgoing edges sorted deterministically (rank, id, target) — never array order. */
function sortEdges(
  edges: readonly SkillFlowEdge[],
  rank: (id: string) => number,
): SkillFlowEdge[] {
  return [...edges].sort(
    (a, b) =>
      rank(a.source) - rank(b.source) ||
      a.source.localeCompare(b.source) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Structural checks + deterministic ordering. Everything that can fail is
 * reported here, before emission, so there is no partial-output path.
 */
function analyse(flow: SkillFlow, options: FlowCompileOptions): Analysis {
  const errors: FlowValidationError[] = [];
  const warnings: FlowValidationError[] = [];

  const byId = new Map<string, SkillFlowNode>();
  for (const node of flow.nodes) byId.set(node.id, node);

  const inbound = new Map<string, SkillFlowEdge[]>();
  for (const node of flow.nodes) inbound.set(node.id, []);
  for (const edge of flow.edges) {
    inbound.get(edge.target)?.push(edge);
  }

  // --- exactly one source and one sink -------------------------------------
  const inputs = flow.nodes.filter((node) => node.type === 'input');
  const outputs = flow.nodes.filter((node) => node.type === 'output');
  if (inputs.length === 0) {
    err(errors, 'missing_input', null, 'a flow needs exactly one input node (it declares the args)');
  } else if (inputs.length > 1) {
    for (const node of inputs) {
      err(errors, 'duplicate_input', node.id, 'a flow may have only one input node');
    }
  }
  if (outputs.length === 0) {
    err(errors, 'missing_output', null, 'a flow needs exactly one output node (it is what `run` returns)');
  } else if (outputs.length > 1) {
    for (const node of outputs.slice(1)) {
      err(errors, 'bad_node', node.id, 'a flow may have only one output node');
    }
  }

  // --- per-node edge rules -------------------------------------------------
  for (const node of flow.nodes) {
    const incoming = inbound.get(node.id) ?? [];
    const isSource = node.type === 'input' || node.type === 'const';
    if (isSource && incoming.length > 0) {
      err(
        errors,
        'bad_node',
        node.id,
        `a ${node.type} node takes no inbound edge (it is a source of data)`,
      );
    }
    if (!isSource && node.type !== 'merge' && incoming.length > 1) {
      err(
        errors,
        'bad_node',
        node.id,
        `this node has ${incoming.length} inbound edges — only a merge node may join more than one`,
      );
    }
    for (const edge of incoming) {
      const source = byId.get(edge.source);
      if (source === undefined) continue; // dangling, reported by the schema
      const handle = edge.sourceHandle ?? null;
      if (source.type === 'branch') {
        if (handle !== null && handle !== 'then' && handle !== 'else') {
          err(
            errors,
            'bad_node',
            edge.id,
            `a branch emits "then" or "else", not ${JSON.stringify(handle)}`,
          );
        }
      } else if (handle !== null) {
        err(
          errors,
          'bad_node',
          edge.id,
          `only a branch node has named outputs (${source.type} has one)`,
        );
      }
    }
  }

  // --- tools (D5) ----------------------------------------------------------
  for (const node of flow.nodes) {
    if (node.type !== 'tool') continue;
    const toolId = node.data.toolId;
    if (!options.registry.has(toolId)) {
      err(errors, 'unknown_tool', node.id, `no broker tool is registered as ${JSON.stringify(toolId)}`);
      continue;
    }
    if (options.riskCeiling !== undefined && options.riskOf !== undefined) {
      const risk = options.riskOf(toolId);
      if (risk !== null && RISK_RANK[risk] > RISK_RANK[options.riskCeiling]) {
        err(
          errors,
          'tool_requires_medium',
          node.id,
          `${toolId} is ${risk} risk but this skill declares ${options.riskCeiling}`,
        );
      }
    }
  }

  // --- llm availability (D9) ----------------------------------------------
  if (options.llmAvailable !== true) {
    for (const node of flow.nodes) {
      if (node.type !== 'llm') continue;
      err(
        errors,
        'llm_not_available',
        node.id,
        'this build has no model reach, so an llm node cannot be compiled',
      );
    }
  }

  // --- cycle detection + rank (longest distance from a source) -------------
  const rank = new Map<string, number>();
  const remaining = new Set(flow.nodes.map((node) => node.id));
  const indegree = new Map<string, number>();
  for (const node of flow.nodes) {
    indegree.set(
      node.id,
      (inbound.get(node.id) ?? []).filter((edge) => byId.has(edge.source)).length,
    );
  }
  // Kahn's algorithm, with the frontier taken in sorted order so `rank` never
  // depends on array order.
  let frontier = [...remaining].filter((id) => (indegree.get(id) ?? 0) === 0).sort();
  for (const id of frontier) rank.set(id, 0);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      remaining.delete(id);
      const outgoing = sortEdges(
        flow.edges.filter((edge) => edge.source === id),
        (nodeId) => rank.get(nodeId) ?? 0,
      );
      for (const edge of outgoing) {
        const target = edge.target;
        if (!byId.has(target)) continue;
        rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(id) ?? 0) + 1));
        indegree.set(target, (indegree.get(target) ?? 1) - 1);
        if ((indegree.get(target) ?? 0) === 0) next.push(target);
      }
    }
    frontier = [...new Set(next)].sort();
  }
  if (remaining.size > 0) {
    // Every node still holding an indegree sits on (or behind) a cycle. Name the
    // smallest id so the canvas highlights a stable, predictable offender.
    const offender = [...remaining].sort()[0] ?? null;
    err(
      errors,
      'cycle',
      offender,
      'the flow has a cycle — data must move in one direction only',
    );
  }

  // Deterministic emission order: (rank, nodeId). `rank` alone is already a
  // valid topological order, so this is stable AND correct.
  const order = [...flow.nodes].sort(
    (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) || a.id.localeCompare(b.id),
  );

  return { errors, warnings, order, rankOf: rank, inboundOf: inbound };
}

// ---------------------------------------------------------------------------
// compileFlow
// ---------------------------------------------------------------------------

/**
 * Compile a validated flow. Accepts `unknown` so a caller can hand it whatever
 * came off the wire: the schema runs first and its errors are returned as-is.
 */
export function compileFlow(raw: unknown, options: FlowCompileOptions): ReturnType<typeof finish> {
  const validated = validateFlow(raw);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors, warnings: validated.warnings };
  }
  return finish(validated.flow, validated.warnings, options);
}

function finish(
  flow: SkillFlow,
  schemaWarnings: FlowValidationError[],
  options: FlowCompileOptions,
):
  | {
      ok: true;
      code: string;
      sha256: string;
      tools: string[];
      usesLlm: boolean;
      argsForm: FlowFieldSpec[];
      warnings: FlowValidationError[];
    }
  | { ok: false; errors: FlowValidationError[]; warnings: FlowValidationError[] } {
  const analysis = analyse(flow, options);
  const warnings = [...schemaWarnings, ...analysis.warnings];
  if (analysis.errors.length > 0) {
    return { ok: false, errors: analysis.errors, warnings };
  }

  // --- identifier assignment: stable names in (rank, id) order -------------
  const varOf = new Map<string, string>();
  analysis.order.forEach((node, index) => varOf.set(node.id, `n${index}`));

  const byId = new Map<string, SkillFlowNode>();
  for (const node of flow.nodes) byId.set(node.id, node);

  /** The scope expression for a node: its single inbound value, else `__args`. */
  function scopeOf(node: SkillFlowNode): string {
    const incoming = analysis.inboundOf.get(node.id) ?? [];
    if (incoming.length === 0) return '__args';
    const edge = [...incoming].sort((a, b) => a.id.localeCompare(b.id))[0];
    if (edge === undefined) return '__args';
    const source = byId.get(edge.source);
    const base = varOf.get(edge.source) ?? '__args';
    if (source?.type === 'branch') {
      const handle = edge.sourceHandle ?? null;
      if (handle === 'then' || handle === 'else') return `${base}_${handle}`;
    }
    // A `merge` scopes itself; anything else here is a single edge.
    return base;
  }

  const lines: string[] = [];
  const push = (line: string): void => {
    lines.push(line);
  };

  const usedTools = new Set<string>();

  // The `output` node's `return` is emitted LAST, whatever its rank: any node
  // that does not feed it would otherwise land after the return and be dead
  // code in a file the owner reads.
  const outputNode: SkillFlowNode | undefined = analysis.order.find(
    (node) => node.type === 'output',
  );
  // Typed as the full union on purpose: the switch below must stay exhaustive
  // over all ten node types even though this list cannot contain an `output`.
  const emitOrder: SkillFlowNode[] = analysis.order.filter((node) => node.type !== 'output');

  for (const node of emitOrder) {
    const name = varOf.get(node.id) as string;
    const scope = scopeOf(node);
    switch (node.type) {
      case 'input':
        // The input node IS the args object; its fields are metadata (argsForm).
        push(`  const ${name} = __args;`);
        break;

      case 'const':
        push(`  const ${name} = ${jsValue(node.data.value)};`);
        break;

      case 'tool': {
        const { toolId, args } = node.data;
        usedTools.add(toolId);
        const entries = Object.keys(args)
          .sort()
          .map((key) => `${jsString(key)}: ${argValue(scope, args[key])}`);
        push(
          `  const ${name} = (${scope} === undefined ? undefined : await partner.tools.exec(${jsString(toolId)}, { ${entries.join(', ')} }));`,
        );
        break;
      }

      case 'template':
        push(`  const ${name} = (${scope} === undefined ? undefined : ${templateLiteral(scope, node.data.text)});`);
        break;

      case 'filter': {
        const { path, op, value } = node.data;
        const test = predicate('__i', path, op, value);
        push(
          `  const ${name} = (${scope} === undefined ? undefined : (Array.isArray(${scope}) ? ${scope}.filter((__i) => ${test}) : []));`,
        );
        break;
      }

      case 'map': {
        const select = node.data.select;
        const entries = Object.keys(select)
          .sort()
          .map((key) => `${jsString(key)}: ${accessor('__i', select[key] as FlowPath)}`);
        push(
          `  const ${name} = (${scope} === undefined ? undefined : (Array.isArray(${scope}) ? ${scope}.map((__i) => ({ ${entries.join(', ')} })) : []));`,
        );
        break;
      }

      case 'branch': {
        const { path, op, value } = node.data;
        const test = predicate(name, path, op, value);
        push(`  const ${name} = ${scope};`);
        push(`  const ${name}_then = (${test} ? ${name} : undefined);`);
        push(`  const ${name}_else = (${test} ? undefined : ${name});`);
        break;
      }

      case 'merge': {
        const incoming = sortEdges(analysis.inboundOf.get(node.id) ?? [], (id) => analysis.rankOf.get(id) ?? 0);
        const valueOf = (edge: SkillFlowEdge): string => {
          const source = byId.get(edge.source);
          const base = varOf.get(edge.source) ?? 'undefined';
          const handle = edge.sourceHandle ?? null;
          if (source?.type === 'branch' && (handle === 'then' || handle === 'else')) {
            return `${base}_${handle}`;
          }
          return base;
        };
        const values = incoming.map(valueOf);
        if (node.data.shape === 'array') {
          push(`  const ${name} = [${values.join(', ')}];`);
          break;
        }
        // `shape: 'object'`: the KEY each input lands under. An inbound edge may
        // name its own key with `targetHandle` (what a canvas sets when the
        // author wires a merge input to a named port) — without it the
        // positional fallback would bind by (rank, source id), which is
        // deterministic but NOT what the author drew. `data.keys` stays the
        // DECLARED set, so a mismatch is a warning rather than a silent remap.
        const keys = node.data.keys;
        const pairs = incoming.map((edge, index) => {
          const handle = edge.targetHandle;
          const named = typeof handle === 'string' && handle !== '' ? handle : undefined;
          return { key: named ?? keys[index] ?? `in${index}`, value: values[index] as string };
        });
        const produced = pairs.map((pair) => pair.key).sort();
        const declared = [...keys].sort();
        if (produced.join('\u0000') !== declared.join('\u0000')) {
          err(
            warnings,
            'bad_node',
            node.id,
            `merge keys are [${declared.join(', ')}] but its inbound edges supply [${produced.join(', ')}]`,
          );
        }
        push(`  const ${name} = { ${pairs.map((pair) => `${jsString(pair.key)}: ${pair.value}`).join(', ')} };`);
        break;
      }

      case 'llm': {
        const prompt = templateLiteral(scope, node.data.prompt);
        push(
          `  const ${name} = (${scope} === undefined ? undefined : await partner.llm.complete({ prompt: ${prompt} }));`,
        );
        break;
      }

      case 'output':
        // Handled after the loop (it is always the last statement).
        break;
    }
  }

  if (outputNode !== undefined) {
    const scope = scopeOf(outputNode);
    if (outputNode.type === 'output' && outputNode.data.shape === 'text') {
      push(`  return ${scope} === undefined ? undefined : __text(${scope});`);
    } else {
      push(`  return ${scope};`);
    }
  }

  // `output text` renders a value as text. A value carrying a `text` string —
  // which is exactly what an `llm` node produces (`partner.llm.complete`
  // resolves `{text, usage}`) — yields THAT text rather than the useless
  // "[object Object]". Emitted only when a text output exists, so a flow that
  // does not need it gets no extra line.
  const needsText = flow.nodes.some(
    (node) => node.type === 'output' && node.data.shape === 'text',
  );

  const code = [
    '// Generated from a Flow by Partner. Edit the flow, not this file.',
    'export async function run(args) {',
    '  const __args = args === undefined || args === null ? {} : args;',
    ...(needsText
      ? [
          '  const __text = (v) => (v !== null && typeof v === \'object\' && typeof v.text === \'string\' ? v.text : String(v));',
        ]
      : []),
    ...lines,
    '}',
    '',
  ].join('\n');

  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > MAX_ENTRY_BYTES) {
    return {
      ok: false,
      errors: [
        {
          code: 'bad_node',
          nodeId: null,
          message: `the compiled entry is ${bytes} bytes — over the ${MAX_ENTRY_BYTES}-byte limit; shorten a template or a prompt`,
        },
      ],
      warnings,
    };
  }

  const input = flow.nodes.find((node) => node.type === 'input');
  const argsForm: FlowFieldSpec[] =
    input !== undefined && input.type === 'input' ? input.data.fields.map((f) => ({ ...f })) : [];

  return {
    ok: true,
    code,
    sha256: createHash('sha256').update(code, 'utf8').digest('hex'),
    tools: [...usedTools].sort(),
    // Derived like  (D5): slice B writes both into the manifest, so a
    // flow that calls a model cannot install a manifest that forbids it.
    usesLlm: flow.nodes.some((node) => node.type === 'llm'),
    argsForm,
    warnings,
  };
}

/** Exported for slice B, which compares a compiled hash against a draft's code. */
export function sha256Of(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}
