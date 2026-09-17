/**
 * M28 slice A — the flow compiler (PLAN-M28.md D1/D3/D4/D5).
 *
 * The strongest thing these tests do is EXECUTE the emitted module: the code
 * string is turned back into a function with a fake `partner` and run, so the
 * assertions are about behaviour (the tool was called with these args, the
 * branch's non-taken arm did no I/O, the template rendered) rather than about
 * substrings of generated text. Substring tests would pass on code that does not
 * work; these would not.
 *
 * What is pinned:
 *   - **Determinism (D4)** — the same graph compiles byte-for-byte identically,
 *     including when the `nodes` and `edges` ARRAYS are shuffled. That is what
 *     makes D6's staleness a hash comparison instead of a flag.
 *   - **Totality** — every failure is a named error before any bytes are
 *     emitted: a cycle, a dangling edge, a missing `output`, two `input`s, an
 *     unknown tool, an unavailable `llm`.
 *   - **Non-injectability (D3)** — a backtick, `${`, quote or `__proto__` in
 *     user text is escaped or refused, never executed. This is the promise that
 *     lets an AI-written graph compile at all.
 *   - **The derived permission set (D5)** — `tools` is exactly the graph's
 *     `tool` node ids.
 *   - The emitted entry passes the unmodified M26 `lintEntry`.
 *
 * A note on the shape of every graph here: a flow ALWAYS declares one `input`
 * node (it is the args form, even when that form is empty) and one `output`
 * node. Graphs below therefore carry an `in` node even when nothing reads it —
 * that is the contract, not test noise.
 */
import { describe, expect, it } from 'vitest';
import { lintEntry } from '../../src/skills/manifest.js';
import { compileFlow, sha256Of } from '../../src/skills/flow/compile.js';

const REGISTRY = new Set(['files.read', 'files.list', 'notes.read', 'notes.search']);

interface N {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

/** `[source, target, sourceHandle?, targetHandle?]`. */
type Edge = [string, string] | [string, string, string | null] | [string, string, string | null, string | null];

const INPUT: N = { id: 'in', type: 'input', data: { fields: [] } };
const OUTPUT: N = { id: 'out', type: 'output', data: { shape: 'json' } };

function graph(nodes: N[], edges: Edge[]): unknown {
  return {
    version: 1,
    nodes: nodes.map((node, index) => ({ ...node, position: { x: index, y: 0 } })),
    edges: edges.map(([source, target, sourceHandle, targetHandle], index) => ({
      id: `e${index}`,
      source,
      target,
      ...(sourceHandle == null ? {} : { sourceHandle }),
      ...(targetHandle == null ? {} : { targetHandle }),
    })),
  };
}

function compile(raw: unknown, options: Partial<Parameters<typeof compileFlow>[1]> = {}) {
  return compileFlow(raw, { registry: REGISTRY, llmAvailable: true, ...options });
}

function ok(raw: unknown, options: Partial<Parameters<typeof compileFlow>[1]> = {}) {
  const result = compile(raw, options);
  if (!result.ok) throw new Error(`expected a compile, got ${JSON.stringify(result.errors)}`);
  return result;
}

function errorsOf(raw: unknown, options: Partial<Parameters<typeof compileFlow>[1]> = {}) {
  const result = compile(raw, options);
  if (result.ok) throw new Error('expected a failure, got code');
  return result.errors;
}

/**
 * Turn the emitted ES module back into a callable `run` with a fake `partner`.
 * The generated entry has no imports by construction, so stripping the `export`
 * keyword is the whole transformation.
 */
function load(code: string, partner: Record<string, unknown>) {
  const body = `${code.replace('export async function run', 'async function run')}\nreturn run;`;
  const factory = new Function('partner', body) as (
    partner: unknown,
  ) => (args: unknown) => Promise<unknown>;
  return factory(partner);
}

interface Recorder {
  partner: Record<string, unknown>;
  toolCalls: Array<{ toolId: string; params: Record<string, unknown> }>;
  llmCalls: Array<{ prompt: string }>;
}

function recorder(results: Record<string, unknown> = {}, llm = 'MODEL-REPLY'): Recorder {
  const toolCalls: Recorder['toolCalls'] = [];
  const llmCalls: Recorder['llmCalls'] = [];
  const partner = {
    log: () => undefined,
    tools: {
      exec: async (toolId: string, params: Record<string, unknown>) => {
        toolCalls.push({ toolId, params });
        if (!(toolId in results)) {
          throw Object.assign(new Error('tool_denied'), { code: 'tool_denied' });
        }
        return results[toolId];
      },
    },
    llm: {
      complete: async (input: { prompt: string }) => {
        llmCalls.push({ prompt: input.prompt });
        return { text: llm, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    },
  };
  return { partner, toolCalls, llmCalls };
}

describe('M28 A — every node type emits code that RUNS', () => {
  it('input -> tool -> template -> output(text), passing args through', async () => {
    const rec = recorder({ 'notes.read': { title: 'Launch', body: 'the cat sat' } });
    const result = ok(
      graph(
        [
          { id: 'in', type: 'input', data: { fields: [{ name: 'id', type: 'string', required: true }] } },
          { id: 'read', type: 'tool', data: { toolId: 'notes.read', args: { id: 'id' } } },
          { id: 'msg', type: 'template', data: { text: '# {{title}}\n{{body}}' } },
          { id: 'out', type: 'output', data: { shape: 'text' } },
        ],
        [
          ['in', 'read'],
          ['read', 'msg'],
          ['msg', 'out'],
        ],
      ),
    );

    const run = load(result.code, rec.partner);
    expect(await run({ id: 'note-7' })).toBe('# Launch\nthe cat sat');
    expect(rec.toolCalls).toEqual([{ toolId: 'notes.read', params: { id: 'note-7' } }]);
    expect(result.argsForm).toEqual([{ name: 'id', type: 'string', required: true }]);
  });

  it('const -> filter -> map -> output(json)', async () => {
    const result = ok(
      graph(
        [
          INPUT,
          {
            id: 'rows',
            type: 'const',
            data: {
              value: [
                { name: 'a', status: 'done', score: 1 },
                { name: 'b', status: 'open', score: 2 },
                { name: 'c', status: 'open', score: 3 },
              ],
            },
          },
          { id: 'open', type: 'filter', data: { path: 'status', op: 'eq', value: 'open' } },
          { id: 'pick', type: 'map', data: { select: { label: 'name', points: 'score' } } },
          OUTPUT,
        ],
        [
          ['rows', 'open'],
          ['open', 'pick'],
          ['pick', 'out'],
        ],
      ),
    );
    const run = load(result.code, recorder().partner);
    expect(await run({})).toEqual([
      { label: 'b', points: 2 },
      { label: 'c', points: 3 },
    ]);
  });

  it('map over a nested path with an index', async () => {
    const build = (value: unknown, select: Record<string, string>) =>
      ok(
        graph(
          [
            INPUT,
            { id: 'data', type: 'const', data: { value } },
            { id: 'pick', type: 'map', data: { select } },
            OUTPUT,
          ],
          [
            ['data', 'pick'],
            ['pick', 'out'],
          ],
        ),
      );
    // A nested index path resolves through the item.
    const nested = build([{ tags: ['x', 'y'] }], { second: 'tags[1]' });
    expect(await load(nested.code, recorder().partner)({})).toEqual([{ second: 'y' }]);
    // A map's input must be an ARRAY: an object yields [] rather than throwing,
    // so a mis-wired canvas shows an empty result instead of a crashed worker.
    const wrongType = build({ tags: ['x', 'y'] }, { second: 'tags[1]' });
    expect(await load(wrongType.code, recorder().partner)({})).toEqual([]);
    // ...and a missing path yields undefined for that key, never a throw.
    const missing = build([{ tags: [] }], { nope: 'tags[9].x' });
    expect(await load(missing.code, recorder().partner)({})).toEqual([{ nope: undefined }]);
  });

  it('filter with contains, exists and a numeric comparison', async () => {
    const rows = [
      { name: 'a', tags: ['x'], n: 1 },
      { name: 'b', tags: ['y'], n: 5 },
      { name: 'c', tags: [], n: 9 },
    ];
    const build = (predicate: Record<string, unknown>) =>
      ok(
        graph(
          [
            INPUT,
            { id: 'rows', type: 'const', data: { value: rows } },
            { id: 'keep', type: 'filter', data: predicate },
            { id: 'pick', type: 'map', data: { select: { name: 'name' } } },
            OUTPUT,
          ],
          [
            ['rows', 'keep'],
            ['keep', 'pick'],
            ['pick', 'out'],
          ],
        ),
      );
    expect(await load(build({ path: 'tags', op: 'contains', value: 'y' }).code, recorder().partner)({})).toEqual([
      { name: 'b' },
    ]);
    expect(await load(build({ path: 'n', op: 'gte', value: 5 }).code, recorder().partner)({})).toEqual([
      { name: 'b' },
      { name: 'c' },
    ]);
    expect(await load(build({ path: 'tags', op: 'exists' }).code, recorder().partner)({})).toEqual([
      { name: 'a' },
      { name: 'b' },
      { name: 'c' },
    ]);
  });

  it('branch: the non-taken arm does NO I/O, and merge binds keys by port', async () => {
    const rec = recorder({ 'files.read': { body: 'YES' }, 'files.list': { entries: ['NO'] } });
    const result = ok(
      graph(
        [
          { id: 'in', type: 'input', data: { fields: [{ name: 'go', type: 'boolean', required: true }] } },
          { id: 'br', type: 'branch', data: { path: 'go', op: 'eq', value: true } },
          { id: 'yes', type: 'tool', data: { toolId: 'files.read', args: { path: { $literal: 'a.txt' } } } },
          { id: 'no', type: 'tool', data: { toolId: 'files.list', args: { path: { $literal: '.' } } } },
          { id: 'mg', type: 'merge', data: { shape: 'object', keys: ['then', 'else'] } },
          OUTPUT,
        ],
        [
          ['in', 'br'],
          ['br', 'yes', 'then'],
          ['br', 'no', 'else'],
          // The merge names each input's key with targetHandle — without it the
          // positional fallback would bind by source id and put `no` under `then`.
          ['yes', 'mg', null, 'then'],
          ['no', 'mg', null, 'else'],
          ['mg', 'out'],
        ],
      ),
    );

    const run = load(result.code, rec.partner);
    expect(await run({ go: true })).toEqual({ then: { body: 'YES' }, else: undefined });
    expect(rec.toolCalls.map((call) => call.toolId)).toEqual(['files.read']);

    rec.toolCalls.length = 0;
    expect(await run({ go: false })).toEqual({ then: undefined, else: { entries: ['NO'] } });
    expect(rec.toolCalls.map((call) => call.toolId)).toEqual(['files.list']);
  });

  it('merge(array) joins its inbound arms in a deterministic order', async () => {
    const result = ok(
      graph(
        [
          INPUT,
          { id: 'a', type: 'const', data: { value: 'A' } },
          { id: 'b', type: 'const', data: { value: 'B' } },
          { id: 'mg', type: 'merge', data: { shape: 'array', keys: [] } },
          OUTPUT,
        ],
        [
          ['a', 'mg'],
          ['b', 'mg'],
          ['mg', 'out'],
        ],
      ),
    );
    const run = load(result.code, recorder().partner);
    // Both consts are rank 0; `a` sorts before `b`.
    expect(await run({})).toEqual(['A', 'B']);
  });

  it('llm: the prompt is the rendered template and `output text` yields its text', async () => {
    const rec = recorder({}, 'a tidy checklist');
    const result = ok(
      graph(
        [
          { id: 'in', type: 'input', data: { fields: [{ name: 'topic', type: 'string', required: true }] } },
          { id: 'ask', type: 'llm', data: { prompt: 'Turn {{topic}} into a checklist.' } },
          { id: 'out', type: 'output', data: { shape: 'text' } },
        ],
        [
          ['in', 'ask'],
          ['ask', 'out'],
        ],
      ),
    );
    const run = load(result.code, rec.partner);
    // `partner.llm.complete` resolves `{text, usage}`; `output text` renders the
    // text rather than "[object Object]" (the footgun this pins).
    expect(await run({ topic: 'launch' })).toBe('a tidy checklist');
    expect(rec.llmCalls).toEqual([{ prompt: 'Turn launch into a checklist.' }]);
  });

  it('a template reading an llm node gets its text by path', async () => {
    const rec = recorder({}, 'ANSWER');
    const result = ok(
      graph(
        [
          INPUT,
          { id: 'ask', type: 'llm', data: { prompt: 'hi' } },
          { id: 'tpl', type: 'template', data: { text: 'model said: {{text}}' } },
          { id: 'out', type: 'output', data: { shape: 'text' } },
        ],
        [
          ['in', 'ask'],
          ['ask', 'tpl'],
          ['tpl', 'out'],
        ],
      ),
    );
    expect(await load(result.code, rec.partner)({})).toBe('model said: ANSWER');
  });

  it('a node with no inbound edge reads the args directly', async () => {
    const rec = recorder({ 'notes.read': { title: 'T' } });
    const result = ok(
      graph(
        [
          { id: 'in', type: 'input', data: { fields: [{ name: 'id', type: 'string', required: true }] } },
          { id: 'read', type: 'tool', data: { toolId: 'notes.read', args: { id: 'id' } } },
          OUTPUT,
        ],
        // No input -> tool edge: the tool is scoped to `args`.
        [['read', 'out']],
      ),
    );
    const run = load(result.code, rec.partner);
    expect(await run({ id: 'n1' })).toEqual({ title: 'T' });
    expect(rec.toolCalls[0]?.params).toEqual({ id: 'n1' });
  });

  it('a tool rejection reaches the caller as its coded error', async () => {
    const rec = recorder({}); // no results registered -> exec throws tool_denied
    const result = ok(
      graph(
        [
          INPUT,
          { id: 'read', type: 'tool', data: { toolId: 'notes.read', args: {} } },
          OUTPUT,
        ],
        [
          ['in', 'read'],
          ['read', 'out'],
        ],
      ),
    );
    await expect(load(result.code, rec.partner)({})).rejects.toMatchObject({ code: 'tool_denied' });
  });
});

describe('M28 A — determinism (D4)', () => {
  const flow = (): unknown =>
    graph(
      [
        { id: 'in', type: 'input', data: { fields: [{ name: 'q', type: 'string', required: true }] } },
        { id: 'srch', type: 'tool', data: { toolId: 'notes.search', args: { query: 'q' } } },
        { id: 'pick', type: 'map', data: { select: { t: 'title' } } },
        OUTPUT,
      ],
      [
        ['in', 'srch'],
        ['srch', 'pick'],
        ['pick', 'out'],
      ],
    );

  it('is byte-identical for the same graph', () => {
    const a = ok(flow());
    const b = ok(flow());
    expect(a.code).toBe(b.code);
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toBe(sha256Of(a.code));
  });

  it('is byte-identical when the nodes and edges ARRAYS are shuffled', () => {
    const base = flow() as { nodes: unknown[]; edges: unknown[] };
    const shuffled = {
      version: 1,
      nodes: [...base.nodes].reverse(),
      edges: [...base.edges].reverse(),
    };
    const a = ok(base);
    const b = ok(shuffled);
    expect(b.code).toBe(a.code);
    expect(b.sha256).toBe(a.sha256);
    expect(b.tools).toEqual(a.tools);
  });

  it('does not depend on the insertion order of a tool node\'s args', () => {
    const withArgs = (args: Record<string, unknown>) =>
      graph(
        [
          { id: 'in', type: 'input', data: { fields: [{ name: 'a', type: 'string', required: true }] } },
          { id: 't', type: 'tool', data: { toolId: 'notes.read', args } },
          OUTPUT,
        ],
        [
          ['in', 't'],
          ['t', 'out'],
        ],
      );
    expect(ok(withArgs({ extra: 1, id: 'a' })).code).toBe(ok(withArgs({ id: 'a', extra: 1 })).code);
  });

  it('does not depend on the file order of two same-rank siblings', () => {
    const build = (ids: [string, string]) =>
      graph(
        [
          INPUT,
          { id: ids[0], type: 'const', data: { value: ids[0] } },
          { id: ids[1], type: 'const', data: { value: ids[1] } },
          { id: 'mg', type: 'merge', data: { shape: 'array', keys: [] } },
          OUTPUT,
        ],
        [
          [ids[0], 'mg'],
          [ids[1], 'mg'],
          ['mg', 'out'],
        ],
      );
    expect(ok(build(['a', 'b'])).code).toBe(ok(build(['a', 'b'])).code);
    // Same graph, nodes listed in the other order: still identical.
    const one = build(['a', 'b']) as { nodes: unknown[]; edges: unknown[] };
    const two = build(['b', 'a']) as { nodes: unknown[]; edges: unknown[] };
    const reordered = { version: 1, nodes: [...two.nodes].reverse(), edges: one.edges };
    expect(ok(reordered).code).toBe(ok(one).code);
  });
});

describe('M28 A — totality: every failure is named, and nothing is emitted', () => {
  it('refuses a cycle and emits no code', () => {
    const result = compile(
      graph(
        [
          INPUT,
          { id: 'a', type: 'map', data: { select: { x: 'y' } } },
          { id: 'b', type: 'map', data: { select: { x: 'y' } } },
          OUTPUT,
        ],
        [
          ['in', 'a'],
          ['a', 'b'],
          ['b', 'a'],
          ['b', 'out'],
        ],
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toContain('cycle');
    expect('code' in result).toBe(false);
  });

  it('refuses a self-loop as a cycle', () => {
    const errors = errorsOf(
      graph(
        [
          INPUT,
          { id: 'a', type: 'map', data: { select: { x: 'y' } } },
          OUTPUT,
        ],
        [
          ['in', 'a'],
          ['a', 'a'],
          ['a', 'out'],
        ],
      ),
    );
    expect(errors.map((error) => error.code)).toContain('cycle');
  });

  it('names a missing output, a missing input and two inputs', () => {
    const empty = errorsOf(graph([{ id: 'c', type: 'const', data: { value: 1 } }], []));
    expect(empty.map((error) => error.code)).toContain('missing_output');
    expect(empty.map((error) => error.code)).toContain('missing_input');

    const twoInputs = errorsOf(
      graph(
        [
          { id: 'i1', type: 'input', data: { fields: [] } },
          { id: 'i2', type: 'input', data: { fields: [] } },
          OUTPUT,
        ],
        [['i1', 'out']],
      ),
    );
    expect(twoInputs.map((error) => error.code)).toContain('duplicate_input');
  });

  it('names a dangling edge', () => {
    const errors = errorsOf(
      graph([INPUT, OUTPUT], [
        ['in', 'out'],
        ['in', 'ghost'],
      ]),
    );
    expect(errors.map((error) => error.code)).toContain('dangling_edge');
  });

  it('names an unknown tool, against the passed registry', () => {
    const build = (toolId: string) =>
      graph(
        [
          INPUT,
          { id: 't', type: 'tool', data: { toolId, args: {} } },
          OUTPUT,
        ],
        [
          ['in', 't'],
          ['t', 'out'],
        ],
      );
    expect(errorsOf(build('files.write')).map((error) => error.code)).toContain('unknown_tool');
    // ...and a registry id compiles, so the check is the registry, not a list.
    expect(ok(build('notes.read')).code).toContain('notes.read');
  });

  it('refuses an llm node when this build has no model reach (D9)', () => {
    const raw = graph(
      [
        INPUT,
        { id: 'l', type: 'llm', data: { prompt: 'hi' } },
        { id: 'out', type: 'output', data: { shape: 'text' } },
      ],
      [
        ['in', 'l'],
        ['l', 'out'],
      ],
    );
    const errors = errorsOf(raw, { llmAvailable: false });
    expect(errors.map((error) => error.code)).toContain('llm_not_available');
    expect(errors[0]?.nodeId).toBe('l');
    expect(ok(raw, { llmAvailable: true }).code).toContain('partner.llm.complete');
  });

  it('refuses a tool above the manifest ceiling', () => {
    const raw = graph(
      [
        INPUT,
        { id: 't', type: 'tool', data: { toolId: 'files.read', args: {} } },
        OUTPUT,
      ],
      [
        ['in', 't'],
        ['t', 'out'],
      ],
    );
    expect(errorsOf(raw, { riskCeiling: 'low', riskOf: () => 'high' }).map((e) => e.code)).toContain(
      'tool_requires_medium',
    );
    // With no ceiling supplied the same graph compiles (slice A stays pure).
    expect(ok(raw).code).toContain('files.read');
  });

  it('refuses two inbound edges into a node that is not a merge', () => {
    const errors = errorsOf(
      graph(
        [
          INPUT,
          { id: 'a', type: 'const', data: { value: 1 } },
          { id: 'b', type: 'const', data: { value: 2 } },
          { id: 'tpl', type: 'template', data: { text: 'x' } },
          OUTPUT,
        ],
        [
          ['a', 'tpl'],
          ['b', 'tpl'],
          ['tpl', 'out'],
        ],
      ),
    );
    expect(errors.map((error) => error.code)).toContain('bad_node');
  });

  it('refuses an inbound edge into a source node', () => {
    const errors = errorsOf(
      graph(
        [
          INPUT,
          { id: 'c', type: 'const', data: { value: 1 } },
          { id: 'c2', type: 'const', data: { value: 2 } },
          OUTPUT,
        ],
        [
          ['c', 'c2'],
          ['c2', 'out'],
        ],
      ),
    );
    expect(errors.map((error) => error.code)).toContain('bad_node');
  });

  it('refuses a named output handle on a node that has only one', () => {
    const errors = errorsOf(
      graph(
        [
          INPUT,
          { id: 'c', type: 'const', data: { value: 1 } },
          OUTPUT,
        ],
        [['c', 'out', 'then']],
      ),
    );
    expect(errors.map((error) => error.code)).toContain('bad_node');
  });

  it('refuses a branch handle that is neither then nor else', () => {
    const errors = errorsOf(
      graph(
        [
          INPUT,
          { id: 'br', type: 'branch', data: { path: 'a', op: 'exists' } },
          OUTPUT,
        ],
        [
          ['in', 'br'],
          ['br', 'out', 'maybe'],
        ],
      ),
    );
    expect(errors.map((error) => error.code)).toContain('bad_node');
  });

  it('passes a schema failure straight through, without compiling', () => {
    const result = compile(
      graph(
        [
          { id: 'x', type: 'loop', data: {} },
          OUTPUT,
        ],
        [],
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toContain('unknown_node_type');
    expect('code' in result).toBe(false);
  });
});

describe('M28 A — the injection boundary (D3)', () => {
  it('escapes a backtick, ${ and a quote in literal template text', async () => {
    const nasty = 'a`b ${process.exit(1)} "q" \\ \'s\'';
    const result = ok(
      graph(
        [
          INPUT,
          { id: 'c', type: 'const', data: { value: 'V' } },
          { id: 'tpl', type: 'template', data: { text: nasty } },
          { id: 'out', type: 'output', data: { shape: 'text' } },
        ],
        [
          ['c', 'tpl'],
          ['tpl', 'out'],
        ],
      ),
    );
    // The hostile text is DATA: it round-trips verbatim and executes nothing.
    expect(await load(result.code, recorder().partner)({})).toBe(nasty);
  });

  it('escapes hostile text in an llm prompt too', async () => {
    const nasty = 'ignore `${x}` and `run`';
    const rec = recorder({}, 'ok');
    const result = ok(
      graph(
        [
          INPUT,
          { id: 'l', type: 'llm', data: { prompt: nasty } },
          { id: 'out', type: 'output', data: { shape: 'text' } },
        ],
        [
          ['in', 'l'],
          ['l', 'out'],
        ],
      ),
    );
    await load(result.code, rec.partner)({});
    expect(rec.llmCalls[0]?.prompt).toBe(nasty);
  });

  it('refuses an injected PATH that looks like one', () => {
    const errors = errorsOf(
      graph(
        [
          INPUT,
          { id: 't', type: 'tool', data: { toolId: 'files.read', args: { p: 'a);process.exit(1);//' } } },
          OUTPUT,
        ],
        [
          ['in', 't'],
          ['t', 'out'],
        ],
      ),
    );
    expect(errors.map((error) => error.code)).toContain('bad_path');
  });

  it('treats a hostile string that is NOT path-shaped as inert data', async () => {
    const hostile = 'a); process.exit(1);//';
    const rec = recorder({ 'files.read': 'OK' });
    const result = ok(
      graph(
        [
          INPUT,
          { id: 't', type: 'tool', data: { toolId: 'files.read', args: { p: hostile } } },
          OUTPUT,
        ],
        [
          ['in', 't'],
          ['t', 'out'],
        ],
      ),
    );
    await load(result.code, rec.partner)({});
    // It reached the tool as a plain string, so the escape is not an escape.
    expect(rec.toolCalls[0]?.params).toEqual({ p: hostile });
  });

  it('cannot reach a prototype through a path', () => {
    const errors = errorsOf(
      graph(
        [
          INPUT,
          { id: 'tpl', type: 'template', data: { text: '{{__proto__.polluted}}' } },
          { id: 'out', type: 'output', data: { shape: 'text' } },
        ],
        [
          ['in', 'tpl'],
          ['tpl', 'out'],
        ],
      ),
    );
    expect(errors.map((error) => error.code)).toContain('bad_path');
  });

  it('cannot pollute a prototype through a const value', async () => {
    const value = JSON.parse('{"__proto__":{"polluted":"yes"}}') as unknown;
    const result = ok(
      graph(
        [
          INPUT,
          { id: 'c', type: 'const', data: { value } },
          OUTPUT,
        ],
        [['c', 'out']],
      ),
    );
    const produced = await load(result.code, recorder().partner)({});
    // The key is an OWN property of the produced object, not a prototype write.
    expect(Object.prototype.hasOwnProperty.call(produced, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('M28 A — the derived permission set and the M26 gates (D5)', () => {
  it('tools is exactly the graph\'s tool node ids, de-duplicated and sorted', () => {
    const result = ok(
      graph(
        [
          INPUT,
          { id: 'a', type: 'tool', data: { toolId: 'notes.search', args: {} } },
          { id: 'b', type: 'tool', data: { toolId: 'files.read', args: {} } },
          { id: 'c', type: 'tool', data: { toolId: 'notes.search', args: {} } },
          { id: 'mg', type: 'merge', data: { shape: 'array', keys: [] } },
          OUTPUT,
        ],
        [
          ['in', 'a'],
          ['in', 'b'],
          ['in', 'c'],
          ['a', 'mg'],
          ['b', 'mg'],
          ['c', 'mg'],
          ['mg', 'out'],
        ],
      ),
    );
    expect(result.tools).toEqual(['files.read', 'notes.search']);
  });

  it('lists NO tool for a graph that calls none — no undeclared use either way', () => {
    const result = ok(
      graph(
        [
          INPUT,
          { id: 'c', type: 'const', data: { value: 1 } },
          OUTPUT,
        ],
        [['c', 'out']],
      ),
    );
    expect(result.tools).toEqual([]);
  });

  it('reports model reach separately, so the manifest cannot forbid what the graph does', () => {
    const withoutLlm = ok(
      graph(
        [
          INPUT,
          { id: 't', type: 'tool', data: { toolId: 'notes.read', args: {} } },
          OUTPUT,
        ],
        [
          ['in', 't'],
          ['t', 'out'],
        ],
      ),
    );
    expect(withoutLlm.tools).toEqual(['notes.read']);
    expect(withoutLlm.usesLlm).toBe(false);

    const withLlm = ok(
      graph(
        [
          INPUT,
          { id: 'l', type: 'llm', data: { prompt: 'hi' } },
          { id: 'out', type: 'output', data: { shape: 'text' } },
        ],
        [
          ['in', 'l'],
          ['l', 'out'],
        ],
      ),
    );
    // An `llm` node uses no TOOL; the two derivations are independent.
    expect(withLlm.tools).toEqual([]);
    expect(withLlm.usesLlm).toBe(true);
  });

  it('every emitted entry passes the unmodified M26 lintEntry', () => {
    const flows = [
      graph(
        [
          { id: 'in', type: 'input', data: { fields: [{ name: 'q', type: 'string', required: true }] } },
          { id: 't', type: 'tool', data: { toolId: 'notes.search', args: { query: 'q' } } },
          OUTPUT,
        ],
        [
          ['in', 't'],
          ['t', 'out'],
        ],
      ),
      graph(
        [
          INPUT,
          { id: 'l', type: 'llm', data: { prompt: 'hi {{x}}' } },
          { id: 'out', type: 'output', data: { shape: 'text' } },
        ],
        [
          ['in', 'l'],
          ['l', 'out'],
        ],
      ),
      graph(
        [
          INPUT,
          { id: 'c', type: 'const', data: { value: [1, 2] } },
          OUTPUT,
        ],
        [['c', 'out']],
      ),
    ];
    for (const raw of flows) {
      const lint = lintEntry(ok(raw).code);
      expect(lint.errors).toEqual([]);
      expect(lint.ok).toBe(true);
    }
  });

  it('emits no imports at all — nothing to resolve in the sandbox', () => {
    const code = ok(
      graph(
        [
          INPUT,
          { id: 'c', type: 'const', data: { value: 1 } },
          OUTPUT,
        ],
        [['c', 'out']],
      ),
    ).code;
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  it('warns when the merge\'s declared keys do not match what its edges supply', () => {
    const result = ok(
      graph(
        [
          INPUT,
          { id: 'a', type: 'const', data: { value: 1 } },
          { id: 'b', type: 'const', data: { value: 2 } },
          { id: 'mg', type: 'merge', data: { shape: 'object', keys: ['only'] } },
          OUTPUT,
        ],
        [
          ['a', 'mg'],
          ['b', 'mg'],
          ['mg', 'out'],
        ],
      ),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.nodeId).toBe('mg');
    // A mismatch is a WARNING: the flow still compiles (the extra key defaults
    // to its positional name) because the author has to be able to save it.
    expect(result.code).toContain('"in1"');
  });
});
