/**
 * M28 slice A — the flow document's runtime validator (PLAN-M28.md D3).
 *
 * The flow is written by a human on a canvas AND by a model from a description,
 * so this validator is a real trust boundary, not a formality. What these tests
 * pin, in order of how much damage a regression would do:
 *
 *   1. **The path grammar is the injection boundary.** A path becomes an
 *      accessor expression in the compiler, so `__proto__`, `constructor`,
 *      `a); process.exit(1);//` and a malformed `a..b` must be refused HERE,
 *      before any emission is possible.
 *   2. **Operators are a whitelist** — there is no expression language to fall
 *      back on (D2).
 *   3. **A recognised type with malformed data is `bad_node`**, attributed to
 *      the node, so a canvas can decorate exactly the offender. A silently
 *      defaulted field would compile into something the author did not draw.
 *   4. **Counts and sizes are bounded** — a canvas cannot express a
 *      million-node graph; a hand-written JSON body can.
 */
import { describe, expect, it } from 'vitest';
import {
  FLOW_MAX_NODES,
  FLOW_OPERATORS,
  FLOW_PATH_RE,
  isFlowOperator,
  isFlowPath,
  validateFlow,
} from '../../src/skills/flow/schema.js';

const pos = { x: 0, y: 0 };

function flow(nodes: unknown[], edges: unknown[] = []): unknown {
  return { version: 1, nodes, edges };
}

/** One valid example of every node type (the union must round-trip entirely). */
const VALID_NODES: Array<Record<string, unknown>> = [
  { id: 'in', type: 'input', position: pos, data: { fields: [{ name: 'q', type: 'string', required: true }] } },
  { id: 'c', type: 'const', position: pos, data: { value: { a: [1, 2], b: null, c: 'x' } } },
  { id: 't', type: 'tool', position: pos, data: { toolId: 'files.read', args: { path: 'p', n: 3 } } },
  { id: 'tpl', type: 'template', position: pos, data: { text: 'hi {{a.b}}' } },
  { id: 'f', type: 'filter', position: pos, data: { path: 'status', op: 'neq', value: 'done' } },
  { id: 'm', type: 'map', position: pos, data: { select: { a: 'x.y', b: 'z[0]' } } },
  { id: 'b', type: 'branch', position: pos, data: { path: 'ok', op: 'exists' } },
  { id: 'mg', type: 'merge', position: pos, data: { shape: 'array', keys: [] } },
  { id: 'l', type: 'llm', position: pos, data: { prompt: 'summarise {{c}}' } },
  { id: 'o', type: 'output', position: pos, data: { shape: 'json' } },
];

/** Validate, then collect the error codes — most call sites want both steps. */
function codesOf(raw: unknown): string[] {
  return codes(validateFlow(raw));
}

/** The codes of an ALREADY-validated result (for tests that inspect it twice). */
function codes(result: ReturnType<typeof validateFlow>): string[] {
  return result.ok ? [] : result.errors.map((error) => error.code);
}

describe('validateFlow — the ten node types', () => {
  it('round-trips one of every type', () => {
    const result = validateFlow(flow(VALID_NODES, []));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flow.nodes.map((node) => node.type)).toEqual([
      'input', 'const', 'tool', 'template', 'filter', 'map', 'branch', 'merge', 'llm', 'output',
    ]);
    // Positions survive verbatim (D10: they live in the document).
    expect(result.flow.nodes[0]?.position).toEqual({ x: 0, y: 0 });
    // The `input` node's fields become the args form.
    const input = result.flow.nodes[0];
    if (input?.type === 'input') {
      expect(input.data.fields).toEqual([{ name: 'q', type: 'string', required: true }]);
    }
  });

  it('names an unknown node type and lists what IS known', () => {
    const result = validateFlow(flow([{ id: 'x', type: 'loop', position: pos, data: {} }]));
    expect(codes(result)).toContain('unknown_node_type');
    if (!result.ok) expect(result.errors[0]?.message).toContain('input, const, tool');
  });

  it('requires the version, the node array and the edge array', () => {
    expect(codesOf(validateFlow(null))).toContain('bad_node');
    expect(codesOf(validateFlow({ version: 2, nodes: [], edges: [] }))).toContain('bad_node');
    expect(codesOf(validateFlow({ version: 1, nodes: {} }))).toContain('bad_node');
    expect(codesOf(validateFlow({ version: 1, nodes: [], edges: {} }))).toContain('bad_node');
  });

  it('attributes a malformed node to its id, never to the whole document', () => {
    const result = validateFlow(
      flow([
        { id: 'ok', type: 'const', position: pos, data: { value: 1 } },
        { id: 'bad', type: 'template', position: pos, data: { text: 42 } },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'bad_node', nodeId: 'bad' }),
    ]);
  });

  it('refuses a duplicate node id, a duplicate edge id and a dangling edge', () => {
    expect(
      codesOf(
        flow([
          { id: 'a', type: 'const', position: pos, data: { value: 1 } },
          { id: 'a', type: 'const', position: pos, data: { value: 2 } },
        ]),
      ),
    ).toContain('bad_node');

    const withEdges = flow(
      [{ id: 'a', type: 'const', position: pos, data: { value: 1 } }],
      [
        { id: 'e', source: 'a', target: 'a' },
        { id: 'e', source: 'a', target: 'a' },
      ],
    );
    expect(codesOf(withEdges)).toContain('bad_node');

    const dangling = flow(
      [{ id: 'a', type: 'const', position: pos, data: { value: 1 } }],
      [{ id: 'e', source: 'a', target: 'ghost' }],
    );
    expect(codesOf(dangling)).toContain('dangling_edge');
  });

  it('requires a numeric position and a data object on every node', () => {
    expect(
      codesOf(flow([{ id: 'a', type: 'const', data: { value: 1 } }])),
    ).toContain('bad_node');
    expect(
      codesOf(flow([{ id: 'a', type: 'const', position: { x: 0, y: 'top' }, data: { value: 1 } }])),
    ).toContain('bad_node');
    expect(
      codesOf(flow([{ id: 'a', type: 'const', position: pos }])),
    ).toContain('bad_node');
  });

  it('bounds the document', () => {
    const tooMany = Array.from({ length: FLOW_MAX_NODES + 1 }, (_, index) => ({
      id: `n${index}`,
      type: 'const',
      position: pos,
      data: { value: index },
    }));
    expect(codesOf(flow(tooMany))).toContain('bad_node');
  });
});

describe('validateFlow — the path grammar is the injection boundary (D3)', () => {
  it('accepts the shapes a real flow uses', () => {
    for (const path of ['a', 'a.b', 'a_b', '_x', 'a.b[0].c', 'items[12].name', 'a[0][1]']) {
      expect(isFlowPath(path)).toBe(true);
    }
  });

  it('refuses everything that could become code or reach a prototype', () => {
    const refused = [
      '__proto__',
      'a.__proto__.x',
      'constructor',
      'a.constructor.prototype',
      'a); process.exit(1);//',
      'a[',
      'a..b',
      '.a',
      'a.',
      'a b',
      'a-b',
      'a["x"]',
      'a[0',
      'a}',
      '',
      'a'.repeat(300),
    ];
    for (const path of refused) {
      expect(isFlowPath(path), `expected ${JSON.stringify(path)} to be refused`).toBe(false);
    }
  });

  it('reports a bad path on a filter/branch, naming the node', () => {
    for (const type of ['filter', 'branch'] as const) {
      const result = validateFlow(
        flow([{ id: 'n', type, position: pos, data: { path: 'a.__proto__', op: 'exists' } }]),
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]).toMatchObject({ code: 'bad_path', nodeId: 'n' });
    }
  });

  it('reports a bad path inside a template placeholder', () => {
    const result = validateFlow(
      flow([{ id: 'n', type: 'template', position: pos, data: { text: 'x {{a);x//}} y' } }]),
    );
    expect(codes(result)).toContain('bad_path');
  });

  it('reports a bad path inside a map selection', () => {
    const result = validateFlow(
      flow([{ id: 'n', type: 'map', position: pos, data: { select: { a: 'a..b' } } }]),
    );
    expect(codes(result)).toContain('bad_path');
  });

  it('reports a bad path in tool args — and lets a plain literal through', () => {
    const result = validateFlow(
      flow([
        {
          id: 'n',
          type: 'tool',
          position: pos,
          data: { toolId: 'files.read', args: { good: 'a.b', bad: 'a..b', words: 'two words', n: 3 } },
        },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'bad_path', nodeId: 'n' });
    expect(result.errors[0]?.message).toContain('bad');
  });

  it('accepts the $literal escape hatch for a string that looks like a path', () => {
    const result = validateFlow(
      flow([
        {
          id: 'n',
          type: 'tool',
          position: pos,
          data: { toolId: 'files.read', args: { q: { $literal: 'status' } } },
        },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a malformed $literal wrapper', () => {
    for (const value of [{ $literal: 'x', extra: 1 }, { $literal: undefined }]) {
      const result = validateFlow(
        flow([{ id: 'n', type: 'tool', position: pos, data: { toolId: 'files.read', args: { q: value } } }]),
      );
      expect(result.ok).toBe(false);
    }
  });

  it('exposes the grammar so the canvas mirrors it instead of copying it', () => {
    expect(FLOW_PATH_RE.source).toBe(
      '^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*|\\[\\d+\\])*$',
    );
  });
});

describe('validateFlow — operators are a whitelist (D2)', () => {
  it('accepts exactly the eight fixed operators', () => {
    expect(FLOW_OPERATORS).toEqual(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']);
    for (const op of FLOW_OPERATORS) expect(isFlowOperator(op)).toBe(true);
    for (const op of ['matches', 'in', 'and', 'or', '=', 'LIKE']) {
      expect(isFlowOperator(op), `expected ${op} to be refused`).toBe(false);
    }
  });

  it('names an unknown operator on the node', () => {
    const result = validateFlow(
      flow([{ id: 'n', type: 'filter', position: pos, data: { path: 'a', op: 'matches', value: 'x' } }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ code: 'bad_operator', nodeId: 'n' });
  });

  it('requires a comparison value for every operator except `exists`', () => {
    const missing = validateFlow(
      flow([{ id: 'n', type: 'filter', position: pos, data: { path: 'a', op: 'eq' } }]),
    );
    expect(codesOf(missing)).toContain('bad_node');

    const exists = validateFlow(
      flow([{ id: 'n', type: 'filter', position: pos, data: { path: 'a', op: 'exists' } }]),
    );
    expect(exists.ok).toBe(true);
  });
});

describe('validateFlow — per-type data rules', () => {
  it('input: field names must be identifiers, and must not repeat', () => {
    const bad = validateFlow(
      flow([
        {
          id: 'n',
          type: 'input',
          position: pos,
          data: { fields: [{ name: 'a b', type: 'string', required: true }] },
        },
      ]),
    );
    expect(codesOf(bad)).toContain('bad_node');

    const dup = validateFlow(
      flow([
        {
          id: 'n',
          type: 'input',
          position: pos,
          data: {
            fields: [
              { name: 'a', type: 'string', required: true },
              { name: 'a', type: 'number', required: false },
            ],
          },
        },
      ]),
    );
    expect(codesOf(dup)).toContain('bad_node');

    const badType = validateFlow(
      flow([
        {
          id: 'n',
          type: 'input',
          position: pos,
          data: { fields: [{ name: 'a', type: 'date', required: true }] },
        },
      ]),
    );
    expect(codesOf(badType)).toContain('bad_node');
  });

  it('tool: needs a toolId and a plain args object', () => {
    expect(
      codesOf(flow([{ id: 'n', type: 'tool', position: pos, data: { args: {} } }])),
    ).toContain('bad_node');
    expect(
      codesOf(flow([{ id: 'n', type: 'tool', position: pos, data: { toolId: 'files.read', args: [] } }])),
    ).toContain('bad_node');
  });

  it('merge: shape is object|array and keys are bounded strings', () => {
    expect(
      codesOf(flow([{ id: 'n', type: 'merge', position: pos, data: { shape: 'set', keys: [] } }])),
    ).toContain('bad_node');
    expect(
      codesOf(flow([{ id: 'n', type: 'merge', position: pos, data: { shape: 'object', keys: ['', 3] } }])),
    ).toContain('bad_node');
  });

  it('output: shape is json|text', () => {
    expect(
      codesOf(flow([{ id: 'n', type: 'output', position: pos, data: { shape: 'html' } }])),
    ).toContain('bad_node');
  });

  it('map: needs at least one key, and select keys must be identifiers', () => {
    expect(
      codesOf(flow([{ id: 'n', type: 'map', position: pos, data: { select: {} } }])),
    ).toContain('bad_node');
    expect(
      codesOf(flow([{ id: 'n', type: 'map', position: pos, data: { select: { 'a b': 'x' } } }])),
    ).toContain('bad_node');
  });

  it('llm: needs a bounded prompt', () => {
    expect(
      codesOf(flow([{ id: 'n', type: 'llm', position: pos, data: {} }])),
    ).toContain('bad_node');
    expect(
      codesOf(flow([{ id: 'n', type: 'llm', position: pos, data: { prompt: 'x'.repeat(20_001) } }])),
    ).toContain('bad_node');
  });

  it('refuses a non-JSON value where one is required', () => {
    expect(
      codesOf(flow([{ id: 'n', type: 'const', position: pos, data: { value: () => 1 } }])),
    ).toContain('bad_node');
  });

  it('refuses a handle that is neither null nor a short string', () => {
    const result = validateFlow(
      flow(
        [
          { id: 'a', type: 'const', position: pos, data: { value: 1 } },
          { id: 'b', type: 'output', position: pos, data: { shape: 'json' } },
        ],
        [{ id: 'e', source: 'a', target: 'b', sourceHandle: 7 }],
      ),
    );
    expect(codes(result)).toContain('bad_node');
  });
});
