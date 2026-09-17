/**
 * M28 slice A — the flow document's runtime validator (PLAN-M28.md, D3).
 *
 * A flow is authored by a human on a canvas AND by a model from a description,
 * so the shape check cannot be a TypeScript type: it has to be a runtime
 * function that reads `unknown` and either produces a `SkillFlow` or a list of
 * named, node-attributed errors. This module is the only door into the compiler.
 *
 * WHAT IT IS STRICT ABOUT, and why:
 *
 *   - **Paths are a grammar, never emitted text** (D3). A field path must match
 *     `^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$`. That single
 *     regex is the injection boundary for the whole milestone: because a path
 *     can only ever be identifiers and integer indexes, the compiler is allowed
 *     to build an accessor expression out of it. `__proto__`, `constructor`,
 *     `a); process.exit(1);//` and `a..b` are refused HERE, before emission.
 *   - **Operators are a whitelist.** `eq/neq/gt/gte/lt/lte/contains/exists` —
 *     the fixed set D2 allows. There is no expression language.
 *   - **Shape is checked per type.** A recognised type with malformed `data` is
 *     `bad_node` (never silently defaulted), so a canvas can decorate exactly
 *     the offending node.
 *
 * BOUNDED ON PURPOSE: a flow is user-authored and model-authored, so node and
 * edge counts and template size carry explicit caps. A canvas cannot express a
 * million-node graph; a hand-written JSON payload can, and this is where it
 * stops.
 */
import type {
  FlowFieldSpec,
  FlowFieldType,
  FlowOperator,
  FlowPath,
  FlowValidationError,
  SkillFlow,
  SkillFlowEdge,
  SkillFlowNode,
  SkillFlowNodeType,
  SkillFlowValidation,
} from '@partner/shared';

/** The ONE path grammar (D3). Exported so the canvas mirrors it, not copies it. */
export const FLOW_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/;

/**
 * Property names a path may never name, even though the grammar would allow
 * them. A path compiles to an optional-chained ACCESSOR, so `__proto__` is not
 * code execution — but it IS a prototype reach, and a flow is authored by a
 * model as often as by a person. Refusing them here is what lets the compiler
 * emit an accessor without reasoning about prototypes at all.
 */
const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** The property names a path names, with `[n]` indexes dropped. */
function pathPropertyNames(path: string): string[] {
  return path.split('.').map((part) => part.replace(/\[\d+\]/g, ''));
}

/** The fixed operator set (D2/D3). There are no user-defined operators. */
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

/** The closed node vocabulary (D2) — ten types, no general-purpose language. */
export const FLOW_NODE_TYPES: readonly SkillFlowNodeType[] = [
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

export const FLOW_FIELD_TYPES: readonly FlowFieldType[] = ['string', 'number', 'boolean', 'json'];

/** Caps. A flow is authored by a model as often as by a hand — both are bounded. */
export const FLOW_MAX_NODES = 200;
export const FLOW_MAX_EDGES = 400;
export const FLOW_MAX_FIELDS = 50;
export const FLOW_MAX_MAP_KEYS = 50;
export const FLOW_MAX_MERGE_KEYS = 32;
/** One template's literal text. Generous for prose, small for a payload. */
export const FLOW_MAX_TEXT_CHARS = 20_000;
/** The prompt an `llm` node may send (the runner's own prompt cap is separate). */
export const FLOW_MAX_PROMPT_CHARS = 20_000;
/** Identifier length for a node id / field name. */
export const FLOW_MAX_ID_CHARS = 64;

export function isFlowPath(value: unknown): value is FlowPath {
  if (typeof value !== 'string' || value === '' || value.length > 256) return false;
  if (!FLOW_PATH_RE.test(value)) return false;
  return !pathPropertyNames(value).some((name) => FORBIDDEN_PATH_SEGMENTS.has(name));
}

export function isFlowOperator(value: unknown): value is FlowOperator {
  return typeof value === 'string' && (FLOW_OPERATORS as readonly string[]).includes(value);
}

export function isFlowNodeType(value: unknown): value is SkillFlowNodeType {
  return typeof value === 'string' && (FLOW_NODE_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Small structural readers. Every one takes `unknown` and narrows.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A non-empty, bounded identifier-shaped string (node ids, map/merge keys). */
function isId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= FLOW_MAX_ID_CHARS;
}

function isFieldName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

/** JSON-serializable, bounded — the shape a `const` node and args may hold. */
function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null) return true;
  const kind = typeof value;
  if (kind === 'string') return (value as string).length <= FLOW_MAX_TEXT_CHARS;
  if (kind === 'number') return Number.isFinite(value);
  if (kind === 'boolean') return true;
  if (Array.isArray(value)) {
    return value.length <= 1000 && value.every((item) => isJsonValue(item, depth + 1));
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    return (
      keys.length <= 100 &&
      keys.every((key) => key.length <= 256 && isJsonValue(value[key], depth + 1))
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-node data validation
// ---------------------------------------------------------------------------

interface NodeCheck {
  errors: FlowValidationError[];
}

function fail(
  errors: FlowValidationError[],
  code: FlowValidationError['code'],
  nodeId: string | null,
  message: string,
): void {
  errors.push({ code, nodeId, message });
}

/** `input` — the args declaration (also the Studio's test-run form). */
function checkInputData(nodeId: string, data: Record<string, unknown>, out: NodeCheck): void {
  const fields = data.fields;
  if (!Array.isArray(fields)) {
    fail(out.errors, 'bad_node', nodeId, 'an input node needs a `fields` array');
    return;
  }
  if (fields.length > FLOW_MAX_FIELDS) {
    fail(out.errors, 'bad_node', nodeId, `an input node may declare at most ${FLOW_MAX_FIELDS} fields`);
    return;
  }
  const seen = new Set<string>();
  for (const field of fields) {
    if (!isRecord(field)) {
      fail(out.errors, 'bad_node', nodeId, 'each input field must be an object');
      continue;
    }
    if (!isFieldName(field.name)) {
      fail(
        out.errors,
        'bad_node',
        nodeId,
        `field name ${JSON.stringify(field.name)} must be a plain identifier`,
      );
      continue;
    }
    if (seen.has(field.name)) {
      fail(out.errors, 'bad_node', nodeId, `duplicate field name "${field.name}"`);
      continue;
    }
    seen.add(field.name);
    if (!(FLOW_FIELD_TYPES as readonly unknown[]).includes(field.type)) {
      fail(out.errors, 'bad_node', nodeId, `field "${field.name}" has an unknown type`);
    }
    if (typeof field.required !== 'boolean') {
      fail(out.errors, 'bad_node', nodeId, `field "${field.name}" must declare required: boolean`);
    }
  }
}

/**
 * A `tool` node's args. The shared contract is
 * `Record<string, FlowPath | unknown>`, which cannot distinguish a path
 * reference from a string literal — so slice A fixes the rule, once, here:
 *
 *   **a string value is a PATH REFERENCE iff it matches the path grammar.**
 *   Every other JSON type is a literal, and a string literal that would be
 *   mistaken for a path is written `{"$literal": "..."}` (unwrapped by the
 *   compiler). References are the common case in a flow, so they get the short
 *   form; the escape hatch keeps literals expressible, which is what stops this
 *   being a trap.
 */
export const FLOW_LITERAL_KEY = '$literal';

/** Throws nothing: returns the offending path or null. */
export function badArgPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!isFlowPath(value)) {
    // Only strings that LOOK like a path attempt (no spaces, identifier-ish) are
    // reported: `"two words"` is plainly a literal, not a malformed reference.
    return /^[A-Za-z_$]/.test(value) && !/\s/.test(value) ? value : null;
  }
  return null;
}

function checkToolArgs(
  nodeId: string,
  args: Record<string, unknown>,
  out: NodeCheck,
): void {
  for (const [key, value] of Object.entries(args)) {
    if (key.length > FLOW_MAX_ID_CHARS) {
      fail(out.errors, 'bad_node', nodeId, `tool arg name "${key}" is too long`);
      continue;
    }
    if (isRecord(value) && FLOW_LITERAL_KEY in value) {
      const literal = value[FLOW_LITERAL_KEY];
      if (Object.keys(value).length !== 1 || !isJsonValue(literal)) {
        fail(out.errors, 'bad_node', nodeId, `arg "${key}" has a malformed ${FLOW_LITERAL_KEY}`);
      }
      continue;
    }
    const bad = badArgPath(value);
    if (bad !== null) {
      fail(out.errors, 'bad_path', nodeId, `arg "${key}" is not a valid path: ${JSON.stringify(bad)}`);
      continue;
    }
    if (!isJsonValue(value)) {
      fail(out.errors, 'bad_node', nodeId, `arg "${key}" is not JSON-serializable`);
    }
  }
}

function checkTemplateText(nodeId: string, text: string, out: NodeCheck): void {
  // The placeholders are validated HERE so the compiler's substitution pass can
  // never be handed a path it would have to sanitise or refuse mid-emission.
  const pattern = /\{\{([^{}]*)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const path = (match[1] ?? '').trim();
    if (!isFlowPath(path)) {
      fail(
        out.errors,
        'bad_path',
        nodeId,
        `template placeholder {{${path}}} is not a valid path`,
      );
    }
  }
}

function checkPredicate(
  nodeId: string,
  data: Record<string, unknown>,
  out: NodeCheck,
): void {
  if (!isFlowPath(data.path)) {
    fail(
      out.errors,
      'bad_path',
      nodeId,
      `path ${JSON.stringify(data.path)} must match ${FLOW_PATH_RE.source}`,
    );
  }
  if (!isFlowOperator(data.op)) {
    fail(out.errors, 'bad_operator', nodeId, `unknown operator ${JSON.stringify(data.op)}`);
    return;
  }
  // `exists` is a one-argument predicate; the others compare against `value`.
  if (data.op !== 'exists' && !('value' in data)) {
    fail(out.errors, 'bad_node', nodeId, `operator "${data.op}" needs a \`value\` to compare against`);
  }
  if ('value' in data && !isJsonValue(data.value)) {
    fail(out.errors, 'bad_node', nodeId, 'predicate value is not JSON-serializable');
  }
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

/**
 * Validate an arbitrary parsed value as a `SkillFlow`.
 *
 * Returns the narrow `SkillFlowValidation` from the shared contract, so the
 * canvas, the routes and the compiler all consume one shape. Warnings are
 * things that are legal but smell (kept separate so they can never block a
 * save or a compile) — slice A has none of its own yet; the compiler adds the
 * unused-permission warning, which needs the registry.
 */
export function validateFlow(raw: unknown): SkillFlowValidation {
  const errors: FlowValidationError[] = [];
  const warnings: FlowValidationError[] = [];

  if (!isRecord(raw)) {
    fail(errors, 'bad_node', null, 'a flow must be an object');
    return { ok: false, errors, warnings };
  }
  if (raw.version !== 1) {
    fail(errors, 'bad_node', null, 'flow version must be 1');
    return { ok: false, errors, warnings };
  }
  if (!Array.isArray(raw.nodes)) {
    fail(errors, 'bad_node', null, 'flow nodes must be an array');
    return { ok: false, errors, warnings };
  }
  if (!Array.isArray(raw.edges)) {
    fail(errors, 'bad_node', null, 'flow edges must be an array');
    return { ok: false, errors, warnings };
  }
  if (raw.nodes.length > FLOW_MAX_NODES) {
    fail(errors, 'bad_node', null, `a flow may hold at most ${FLOW_MAX_NODES} nodes`);
    return { ok: false, errors, warnings };
  }
  if (raw.edges.length > FLOW_MAX_EDGES) {
    fail(errors, 'bad_node', null, `a flow may hold at most ${FLOW_MAX_EDGES} edges`);
    return { ok: false, errors, warnings };
  }

  const nodes: SkillFlowNode[] = [];
  const ids = new Set<string>();

  for (const candidate of raw.nodes) {
    if (!isRecord(candidate)) {
      fail(errors, 'bad_node', null, 'every node must be an object');
      continue;
    }
    const id = candidate.id;
    if (!isId(id)) {
      fail(errors, 'bad_node', null, 'every node needs a non-empty id (≤64 chars)');
      continue;
    }
    if (ids.has(id)) {
      fail(errors, 'bad_node', id, `duplicate node id "${id}"`);
      continue;
    }
    ids.add(id);

    const position = candidate.position;
    if (
      !isRecord(position) ||
      !isFiniteNumber(position.x) ||
      !isFiniteNumber(position.y)
    ) {
      fail(errors, 'bad_node', id, 'every node needs a numeric {x, y} position');
      continue;
    }
    if (!isRecord(candidate.data)) {
      fail(errors, 'bad_node', id, 'every node needs a `data` object');
      continue;
    }
    if (!isFlowNodeType(candidate.type)) {
      fail(
        errors,
        'unknown_node_type',
        id,
        `unknown node type ${JSON.stringify(candidate.type)} (known: ${FLOW_NODE_TYPES.join(', ')})`,
      );
      continue;
    }

    const type = candidate.type;
    const data = candidate.data;
    const out: NodeCheck = { errors };

    switch (type) {
      case 'input':
        checkInputData(id, data, out);
        break;
      case 'const':
        if (!('value' in data)) {
          fail(errors, 'bad_node', id, 'a const node needs a `value`');
        } else if (!isJsonValue(data.value)) {
          fail(errors, 'bad_node', id, 'a const value must be JSON-serializable');
        }
        break;
      case 'tool': {
        const toolId = data.toolId;
        if (typeof toolId !== 'string' || toolId === '' || toolId.length > 128) {
          fail(errors, 'bad_node', id, 'a tool node needs a non-empty `toolId`');
          break;
        }
        if (!isRecord(data.args)) {
          fail(errors, 'bad_node', id, 'a tool node needs an `args` object');
          break;
        }
        checkToolArgs(id, data.args, out);
        break;
      }
      case 'template':
        if (!isText(data.text, FLOW_MAX_TEXT_CHARS)) {
          fail(
            errors,
            'bad_node',
            id,
            `a template node needs \`text\` (≤${FLOW_MAX_TEXT_CHARS} chars)`,
          );
          break;
        }
        checkTemplateText(id, data.text, out);
        break;
      case 'filter':
        checkPredicate(id, data, out);
        break;
      case 'branch':
        checkPredicate(id, data, out);
        break;
      case 'map': {
        const select = data.select;
        if (!isRecord(select)) {
          fail(errors, 'bad_node', id, 'a map node needs a `select` object');
          break;
        }
        const keys = Object.keys(select);
        if (keys.length === 0) {
          fail(errors, 'bad_node', id, 'a map node needs at least one selected key');
          break;
        }
        if (keys.length > FLOW_MAX_MAP_KEYS) {
          fail(errors, 'bad_node', id, `a map node may select at most ${FLOW_MAX_MAP_KEYS} keys`);
          break;
        }
        for (const key of keys) {
          if (!isFieldName(key)) {
            fail(errors, 'bad_node', id, `select key ${JSON.stringify(key)} must be an identifier`);
            continue;
          }
          if (!isFlowPath(select[key])) {
            fail(
              errors,
              'bad_path',
              id,
              `select["${key}"] must be a valid path (got ${JSON.stringify(select[key])})`,
            );
          }
        }
        break;
      }
      case 'merge': {
        if (data.shape !== 'object' && data.shape !== 'array') {
          fail(errors, 'bad_node', id, 'a merge node needs shape "object" or "array"');
          break;
        }
        if (!Array.isArray(data.keys) || data.keys.length > FLOW_MAX_MERGE_KEYS) {
          fail(errors, 'bad_node', id, `a merge node needs a \`keys\` array (≤${FLOW_MAX_MERGE_KEYS})`);
          break;
        }
        for (const key of data.keys) {
          if (typeof key !== 'string' || key === '' || key.length > FLOW_MAX_ID_CHARS) {
            fail(errors, 'bad_node', id, 'every merge key must be a non-empty string (≤64 chars)');
          }
        }
        break;
      }
      case 'llm':
        if (!isText(data.prompt, FLOW_MAX_PROMPT_CHARS)) {
          fail(
            errors,
            'bad_node',
            id,
            `an llm node needs a \`prompt\` (≤${FLOW_MAX_PROMPT_CHARS} chars)`,
          );
          break;
        }
        checkTemplateText(id, data.prompt, out);
        break;
      case 'output':
        if (data.shape !== 'json' && data.shape !== 'text') {
          fail(errors, 'bad_node', id, 'an output node needs shape "json" or "text"');
        }
        break;
    }

    nodes.push({
      id,
      type,
      position: { x: position.x, y: position.y },
      data: data as never,
    } as SkillFlowNode);
  }

  // Edges: both endpoints must exist, handles must be shaped like handles.
  const edges: SkillFlowEdge[] = [];
  const edgeIds = new Set<string>();
  for (const candidate of raw.edges) {
    if (!isRecord(candidate)) {
      fail(errors, 'bad_node', null, 'every edge must be an object');
      continue;
    }
    const { id, source, target } = candidate;
    if (!isId(id)) {
      fail(errors, 'bad_node', null, 'every edge needs a non-empty id (≤64 chars)');
      continue;
    }
    if (edgeIds.has(id)) {
      fail(errors, 'bad_node', id, `duplicate edge id "${id}"`);
      continue;
    }
    edgeIds.add(id);
    if (!isId(source) || !isId(target)) {
      fail(errors, 'bad_node', id, 'every edge needs a source and a target');
      continue;
    }
    if (!ids.has(source) || !ids.has(target)) {
      fail(errors, 'dangling_edge', id, `edge "${id}" points at a node that does not exist`);
      continue;
    }
    const sourceHandle = candidate.sourceHandle;
    const targetHandle = candidate.targetHandle;
    for (const [name, handle] of [
      ['sourceHandle', sourceHandle],
      ['targetHandle', targetHandle],
    ] as const) {
      if (handle !== undefined && handle !== null && !isId(handle)) {
        fail(errors, 'bad_node', id, `${name} must be null or a short string`);
      }
    }
    edges.push({
      id,
      source,
      target,
      ...(sourceHandle === undefined ? {} : { sourceHandle: sourceHandle as string | null }),
      ...(targetHandle === undefined ? {} : { targetHandle: targetHandle as string | null }),
    });
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    flow: { version: 1, nodes, edges },
    warnings,
  };
}

/** Type guard for a validated args form (used by the routes + the Studio). */
export function isFieldSpecList(value: unknown): value is FlowFieldSpec[] {
  return (
    Array.isArray(value) &&
    value.every(
      (field) =>
        isRecord(field) &&
        isFieldName(field.name) &&
        (FLOW_FIELD_TYPES as readonly unknown[]).includes(field.type) &&
        typeof field.required === 'boolean',
    )
  );
}
