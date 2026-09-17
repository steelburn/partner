/**
 * M28 slice C view tests (PLAN-M28.md D2/D9/D10) — the Flow canvas and the
 * Nodes table.
 *
 * The web suite runs under the `node` environment with no DOM
 * (web/vitest.config.ts), so every render here is `react-dom/server`'s
 * `renderToStaticMarkup`, the house approach for this suite.
 *
 * What that CAN and CANNOT assert, stated plainly:
 *
 *  - React Flow renders its shell AND its nodes server-side — but only when
 *    `<ReactFlow>` builds its own store. With a `ReactFlowProvider` above it the
 *    store starts empty and the node layer renders nothing (verified: the
 *    `.react-flow__nodes` container comes out empty), which is why this view
 *    deliberately has no provider. Nodes, handles and the palette are therefore
 *    assertable markup; EDGES are not (their path needs measured handle bounds),
 *    so "one edge per document edge" is asserted through the Nodes table and the
 *    pure mapper, not through an SVG path.
 *  - Effects do not run under `renderToStaticMarkup`, so a property that lives in
 *    an event handler or an effect is asserted against the SOURCE with comments
 *    stripped (helpers/css.ts `source`). Each such case says so where it is used.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FlowValidationError, SkillFlow } from '@partner/shared';
import { SkillFlowView } from '../src/SkillFlow.js';
import { source, topLevelRules } from './helpers/css.js';

const noop = (): void => undefined;

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** A minimal compiling flow: input → filter → output, all of it positioned. */
const FLOW: SkillFlow = {
  version: 1,
  nodes: [
    {
      id: 'node-1',
      type: 'input',
      position: { x: 0, y: 0 },
      data: { fields: [{ name: 'text', type: 'string', required: true }] },
    },
    { id: 'node-2', type: 'filter', position: { x: 320, y: 0 }, data: { path: 'items', op: 'exists' } },
    { id: 'node-3', type: 'output', position: { x: 640, y: 0 }, data: { shape: 'text' } },
  ],
  edges: [
    { id: 'edge-1', source: 'node-1', target: 'node-2', sourceHandle: null, targetHandle: null },
    { id: 'edge-2', source: 'node-2', target: 'node-3', sourceHandle: null, targetHandle: null },
  ],
};

const BRANCH_FLOW: SkillFlow = {
  version: 1,
  nodes: [
    { id: 'node-1', type: 'input', position: { x: 0, y: 0 }, data: { fields: [] } },
    { id: 'node-2', type: 'branch', position: { x: 320, y: 0 }, data: { path: 'ok', op: 'exists' } },
    { id: 'node-3', type: 'output', position: { x: 640, y: 0 }, data: { shape: 'json' } },
  ],
  edges: [],
};

const EMPTY_FLOW: SkillFlow = { version: 1, nodes: [], edges: [] };

interface Overrides {
  flow?: SkillFlow;
  llmAvailable?: boolean;
  toolIds?: readonly string[];
  readOnly?: boolean;
  disabled?: boolean;
  errors?: readonly FlowValidationError[];
  initialView?: 'canvas' | 'nodes';
}

function render(overrides: Overrides = {}): string {
  return renderToStaticMarkup(
    h(SkillFlowView, {
      flow: overrides.flow ?? FLOW,
      llmAvailable: overrides.llmAvailable ?? true,
      toolIds: overrides.toolIds ?? ['files.read'],
      readOnly: overrides.readOnly ?? false,
      disabled: overrides.disabled ?? false,
      errors: overrides.errors ?? [],
      onChange: noop,
      initialView: overrides.initialView ?? 'canvas',
    }),
  );
}

describe('palette (D9: only offer what can be compiled)', () => {
  it('offers every node type the build can compile, in D2 order', () => {
    const html = render({ llmAvailable: true });
    expect(count(html, 'class="btn btn-secondary flow-palette-item"')).toBe(10);
    // The label and the one-line hint are both on the button.
    expect(html).toContain('>Input<');
    expect(html).toContain('>Model<');
    expect(html).toContain('Declares the arguments this skill is given.');
    expect(html).not.toContain('not offered');
  });

  it('omits the model node and says why when there is no model reach', () => {
    const html = render({ llmAvailable: false });
    expect(count(html, 'class="btn btn-secondary flow-palette-item"')).toBe(9);
    expect(html).not.toContain('>Model<');
    expect(html).toContain('A model node needs model reach');
  });
});

describe('canvas view', () => {
  it('renders one node per document node, with the canvas chrome', () => {
    const html = render();
    expect(count(html, 'data-testid="rf__node-')).toBe(FLOW.nodes.length);
    expect(html).toContain('rf__node-node-1');
    expect(html).toContain('rf__node-node-3');
    // The .n-graph canvas grammar: dotted background + the zoom controls.
    expect(html).toContain('react-flow__background-pattern dots');
    expect(html).toContain('react-flow__controls');
    // Each node carries its type label and its own summary line.
    expect(html).toContain('flow-node-type');
    expect(html).toContain('Keep items where items exists');
  });

  it('gives a branch two right-hand outputs and every other node one', () => {
    const branch = render({ flow: BRANCH_FLOW });
    expect(count(branch, 'data-handleid="then"')).toBe(1);
    expect(count(branch, 'data-handleid="else"')).toBe(1);
    // input + output still expose the plain left/right pair.
    expect(count(branch, 'class="react-flow__handle react-flow__handle-left')).toBe(3);

    const plain = render();
    expect(plain).not.toContain('data-handleid="then"');
    expect(count(plain, 'class="react-flow__handle react-flow__handle-right')).toBe(FLOW.nodes.length);
  });

  it('names the next step instead of showing an empty box', () => {
    const html = render({ flow: EMPTY_FLOW });
    expect(html).toContain('nothing to compile');
    expect(html).toContain('Input');
    expect(html).toContain('Output');
    expect(html).not.toContain('rf__wrapper');
  });

  it('marks the offending node and lists every issue with its code and node id', () => {
    const errors: FlowValidationError[] = [
      { code: 'unknown_tool', nodeId: 'node-2', message: 'no broker tool is registered as nope' },
    ];
    const html = render({ errors, toolIds: [] });
    expect(count(html, 'flow-node flow-node-error')).toBe(1);
    expect(html).toContain('1 structural problem');
    expect(html).toContain('unknown_tool');
    expect(html).toContain('no broker tool is registered as nope');
    expect(html).toContain('node-2');
    // The node itself carries the code, so the canvas points at the offender.
    expect(html).toContain('<span class="flow-issue">unknown_tool</span>');
  });

  it('shows the core’s list first, and never lists one problem twice', () => {
    // The core named the missing input; the mirror finds that AND the missing
    // output. The duplicate is dropped and the core's wording is the one shown.
    const errors: FlowValidationError[] = [
      { code: 'missing_input', nodeId: null, message: 'the core wants exactly one input node' },
    ];
    const html = render({ flow: EMPTY_FLOW, errors });
    expect(count(html, 'flow-issue-code">missing_input')).toBe(1);
    expect(count(html, 'the core wants exactly one input node')).toBe(1);
    expect(html).toContain('missing_output');
  });
});

/**
 * CSS-SOURCE guards, also on purpose: this suite cannot render a browser, so
 * the states the view depends on are pinned in the stylesheet text (comments
 * stripped first, so prose about a rule can never satisfy a guard). That is the
 * house approach for stylesheet properties (helpers/css.ts, sidebar-collapse).
 */
describe('the stylesheet carries the states this view needs', () => {
  const css = source('src/app.css');

  it('declares focus-visible and disabled for every control the view adds', () => {
    for (const selector of ['.flow-palette-item:focus-visible', '.flow-palette-item:disabled']) {
      expect(css).toContain(selector);
    }
    expect(css).toContain('.flow-node-remove:focus-visible');
    expect(css).toContain('.flow-node-remove:disabled');
    expect(css).toContain('.flow-handle:focus-visible');
  });

  it('keeps the fault ring visible on a node that is also selected', () => {
    expect(css).toContain('.react-flow__node.selected .flow-node.flow-node-error');
  });

  it('declares the edge colour alias on the canvas, as .n-graph-canvas does', () => {
    const rules = topLevelRules(css);
    const canvas = rules.find(([selector]) => selector === '.flow-canvas');
    expect(canvas?.[1]).toContain('--flow-edge: var(--text-faint)');
  });
});

describe('nodes view (D9: the keyboard path)', () => {
  it('lists every node of the same document, with an id field and a type select', () => {
    const html = render({ initialView: 'nodes' });
    expect(html).toContain('flow-table-caption">Nodes');
    expect(html).toContain('flow-table-caption">Edges');
    // Both live tables: three node rows (one id field each) and two edge rows.
    expect(count(html, 'value="node-1"')).toBeGreaterThanOrEqual(1);
    expect(count(html, '<caption')).toBe(2);
    // The type select can express every node type, including one the palette
    // hides (a document can hold an llm node this build cannot compile).
    expect(html).toContain('>Merge<');
    // The type-specific controls are the document's own values.
    expect(html).toContain('value="items"');
    expect(html).toContain('value="text"');
    // Every edge's endpoints and port are controls, and each row can be removed.
    expect(count(html, 'aria-label="Source of node-1 → node-2"')).toBe(1);
    expect(count(html, 'aria-label="Target of node-1 → node-2"')).toBe(1);
    expect(count(html, 'aria-label="Remove edge node-1 → node-2"')).toBe(1);
    expect(count(html, 'aria-label="Remove node node-2"')).toBe(1);
    expect(count(html, 'Add edge')).toBe(1);
  });

  it('marks a row the mirror found a problem in', () => {
    const html = render({ initialView: 'nodes', errors: [{ code: 'bad_path', nodeId: 'node-2', message: 'bad path' }] });
    expect(html).toContain('class="flow-row-error"');
    expect(html).toContain('bad_path');
  });

  it('says an edge needs two nodes instead of offering an unusable add row', () => {
    const single: SkillFlow = { version: 1, nodes: [FLOW.nodes[0]!], edges: [] };
    const html = render({ flow: single, initialView: 'nodes' });
    expect(html).toContain('An edge needs two nodes');
    expect(html).not.toContain('Add edge');
  });
});

describe('the Canvas | Nodes toggle', () => {
  it('is a segmented pill with the aria-pressed contract, opening on initialView', () => {
    const canvas = render({ initialView: 'canvas' });
    expect(canvas).toContain('class="seg-tabs flow-tabs"');
    expect(count(canvas, 'aria-pressed="true"')).toBe(1);
    expect(count(canvas, 'aria-pressed="false"')).toBe(1);
    expect(canvas).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Canvas<\/button>/);
    expect(canvas).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Nodes<\/button>/);

    const nodes = render({ initialView: 'nodes' });
    expect(nodes).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Nodes<\/button>/);
    expect(nodes).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Canvas<\/button>/);
  });
});

describe('readOnly and disabled', () => {
  it('renders no add or remove control at all for an installed draft', () => {
    const html = render({ readOnly: true, initialView: 'nodes' });
    expect(html).not.toContain('flow-palette-item');
    expect(html).not.toContain('Add edge');
    expect(html).not.toContain('Auto-arrange');
    expect(html).not.toContain('Remove node');
    // The rest of the surface is still readable — including the problems.
    expect(html).toContain('flow-table-caption">Nodes');
    expect(count(html, 'disabled=""')).toBeGreaterThan(0);
  });

  it('says a flow-less draft has no flow instead of inviting an edit', () => {
    const html = render({ flow: EMPTY_FLOW, readOnly: true });
    expect(html).toContain('This draft has no flow');
    expect(html).not.toContain('nothing to compile');
  });

  it('keeps the palette and the controls, switched off, while the session is locked', () => {
    const html = render({ disabled: true });
    expect(count(html, 'class="btn btn-secondary flow-palette-item"')).toBe(10);
    expect(html).toMatch(/<button[^>]*flow-palette-item[^>]*disabled[^>]*>/);
    expect(html).toMatch(/<button[^>]*>Auto-arrange<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Auto-arrange<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*disabled[^>]*>Canvas<\/button>/);
  });
});

/**
 * SOURCE-LEVEL on purpose: React Flow's behaviour lives in props this suite
 * cannot render — whether a drag commits, whether a connection is allowed, which
 * zoom bounds apply — and rendering it would only assert React Flow's own code.
 * Comments are stripped first, so prose describing the rule cannot satisfy it.
 */
describe('canvas wiring (asserted against the source)', () => {
  const view = source('src/SkillFlow.tsx');

  it('owns no requests of its own', () => {
    expect(view).not.toContain('fetch(');
    expect(view).not.toContain('lib/skills.js');
    expect(view).not.toContain('readStoredToken');
  });

  it('registers a component for all ten node types and commits edits through onChange', () => {
    expect(view).toContain('const nodeTypes: NodeTypes = {');
    // `flow-<type>` is the React Flow name (the library owns `input`/`output`
    // for its own built-in boxes); every document type has one.
    for (const type of ['input', 'const', 'tool', 'template', 'filter', 'map', 'branch', 'merge', 'llm', 'output']) {
      expect(view).toContain(`'flow-${type}': FlowNodeView`);
    }
    expect(view).toContain('type: rfNodeType(node.type)');
    expect(view).toContain('onNodeDragStop={commitDrag}');
    expect(view).toContain('onConnect={connect}');
    expect(view).toContain('deleteKeyCode={null}');
    expect(view).toContain('onChange({ ...flow, nodes:');
  });

  it('uses the house canvas chrome and locks the edits with the session', () => {
    expect(view).toContain('fitView');
    expect(view).toContain('minZoom={0.2}');
    expect(view).toContain('maxZoom={2.5}');
    expect(view).toContain('proOptions={{ hideAttribution: true }}');
    expect(view).toContain('<Background variant={BackgroundVariant.Dots} gap={24} size={1} />');
    expect(view).toContain('nodesDraggable={!locked}');
    expect(view).toContain('nodesConnectable={!locked}');
    expect(view).toContain('edgesReconnectable={false}');
    // A palette add is re-id'd by the allocator, so two adds cannot collide.
    expect(view).toContain('{ ...newFlowNode(type, { x: 0, y: 0 }), id: newNodeId(flow) }');
    // Removing a node takes its edges with it — no dangling_edge left behind.
    expect(view).toContain('edges: flow.edges.filter((edge) => edge.source !== id && edge.target !== id)');
  });

  it('shows the core’s list first and the mirror’s after it, de-duplicated', () => {
    expect(view).toContain('const seen = new Set(errors.map(key));');
    expect(view).toContain('...structuralIssues(flow, { llmAvailable, toolIds }).filter((error) => !seen.has(key(error)))');
  });
});

// ---------------------------------------------------------------------------
// A `tool` node's args (the D9 follow-up)
// ---------------------------------------------------------------------------

/**
 * `tool` args, the one node type this milestone exists for: D3 makes an arg
 * value a path reference or a literal and NOTHING else, so those two shapes are
 * the whole editor. The rows are asserted in the Nodes view because the canvas
 * inspector needs a selection (a click, which this suite has no DOM for) — and
 * because both views render ONE field editor, asserting it here asserts it there.
 */
const TOOL_FLOW: SkillFlow = {
  version: 1,
  nodes: [
    { id: 'node-1', type: 'input', position: { x: 0, y: 0 }, data: { fields: [] } },
    {
      id: 'node-2',
      type: 'tool',
      position: { x: 320, y: 0 },
      data: {
        toolId: 'files.read',
        // One of each shape: a bare path, and the escape form of the literal
        // text `read` (the schema's `{"$literal": …}` rule).
        args: { path: 'items[0].status', mode: { $literal: 'read' } },
      },
    },
    { id: 'node-3', type: 'output', position: { x: 640, y: 0 }, data: { shape: 'json' } },
  ],
  edges: [],
};

function esc(fragment: string): string {
  return fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is there an opening tag for `tag` carrying every `contains` fragment? Written
 * with lookaheads because attribute ORDER is React's business, not this test's:
 * an assertion that pinned the order would fail on an unrelated reorder.
 */
function controlTag(tag: string, html: string, ...contains: string[]): boolean {
  const lookaheads = contains.map((fragment) => `(?=[^>]*${esc(fragment)})`).join('');
  return new RegExp(`<${tag}${lookaheads}[^>]*>`).test(html);
}

describe('tool args (D3: a path reference or a literal, and nothing else)', () => {
  it('renders one row per arg, with its key, its kind and its value', () => {
    const html = render({ flow: TOOL_FLOW, initialView: 'nodes' });
    // Two args, two rows: every row here belongs to the tool node (the input
    // node declares no fields, and no other node type has rows).
    expect(count(html, 'class="flow-field-row"')).toBe(2);
    expect(count(html, 'aria-label="Argument 1 kind"')).toBe(1);
    expect(count(html, 'aria-label="Argument 2 kind"')).toBe(1);
    // The key, the kind and the value are all visible, and they are the arg's OWN
    // values, in the arg's own order.
    expect(controlTag('input', html, 'aria-label="Argument 1 name"', 'value="path"')).toBe(true);
    expect(controlTag('input', html, 'aria-label="Argument 1 value"', 'value="items[0].status"')).toBe(true);
    expect(controlTag('input', html, 'aria-label="Argument 2 name"', 'value="mode"')).toBe(true);
    expect(controlTag('input', html, 'aria-label="Argument 2 value"', 'value="&quot;read&quot;"')).toBe(true);
    // Both shapes are always offered, so either kind can be chosen per row.
    expect(count(html, '>Path reference<')).toBe(2);
    expect(count(html, '>Literal<')).toBe(2);
    // Every row can be removed, and a row can be added.
    expect(controlTag('button', html, 'aria-label="Remove argument 1"')).toBe(true);
    expect(controlTag('button', html, 'aria-label="Remove argument 2"')).toBe(true);
    expect(controlTag('button', html, '>Add argument')).toBe(true);
  });

  it('reads the kind off the stored value: a path string is a reference, the escape is a literal', () => {
    const html = render({ flow: TOOL_FLOW, initialView: 'nodes' });
    const first = html.indexOf('aria-label="Argument 1 kind"');
    const second = html.indexOf('aria-label="Argument 2 kind"');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    // Row 1 is a Path reference because its value IS a path; row 2 is a Literal
    // because its value is the escape — an object, never a path.
    expect(html.slice(first, second)).toContain('<option value="path" selected="">Path reference</option>');
    expect(html.slice(second)).toContain('<option value="literal" selected="">Literal</option>');
    // The literal row shows the PAYLOAD, not the wrapper: `{"$literal": "read"}`
    // is how the text `read` is stored, and the text is what the author edits.
    expect(controlTag('input', html, 'aria-label="Argument 2 value"', 'value="&quot;read&quot;"')).toBe(true);
  });

  /**
   * SOURCE-LEVEL, and it cannot be anything else: this rule lives in an event
   * handler (a keystroke in the value box), so no static markup can show it. It
   * is the ONE thing this editor must not get wrong (D3): a literal whose text
   * matches the path grammar has to be stored as `{"$literal": …}`, or the
   * compiled skill reads data where the author typed text. Comments are stripped
   * first, so prose describing the rule cannot satisfy it.
   */
  it('stores a literal that would read as a path in the $literal escape', () => {
    const view = source('src/SkillFlow.tsx');
    // The escape key is spelled once, exactly as the schema spells it.
    expect(view).toContain("const FLOW_LITERAL_KEY = '$literal';");
    // The write half: a path-shaped STRING is wrapped, and so is a value that is
    // already nothing but the escape (the compiler unwraps that too, so a bare
    // write of it would be read as a literal ONE level in).
    expect(view).toContain(
      "if (typeof value === 'string' && isFlowPath(value)) return { [FLOW_LITERAL_KEY]: value };",
    );
    expect(view).toContain('if (isLiteralEscape(value)) return { [FLOW_LITERAL_KEY]: value };');
    // Every parsed literal goes through it, so there is no bare write path.
    expect(view).toContain("commit(escapeArgLiteral(parsed), 'literal');");
    // The read half unwraps the payload, so editing a stored escape cannot
    // accumulate wrappers (`{"$literal": {"$literal": …}}`).
    expect(view).toContain('return value[FLOW_LITERAL_KEY];');
    // The path grammar is the shared helper's, never a second regex here.
    expect(view).toContain('isFlowPath,');
    expect(view).not.toContain('FLOW_PATH_RE');
  });

  it('switches every argument control off for an installed draft', () => {
    const html = render({ flow: TOOL_FLOW, initialView: 'nodes', readOnly: true });
    // The row stays READABLE (that is the point of the table), and every control
    // that could write is off — no control is missing, so nothing moves when the
    // draft is installed and the flow becomes history.
    expect(controlTag('input', html, 'aria-label="Argument 1 name"', 'disabled')).toBe(true);
    expect(controlTag('select', html, 'aria-label="Argument 1 kind"', 'disabled')).toBe(true);
    expect(controlTag('input', html, 'aria-label="Argument 1 value"', 'disabled')).toBe(true);
    expect(controlTag('button', html, 'aria-label="Remove argument 1"', 'disabled')).toBe(true);
    expect(controlTag('button', html, '>Add argument', 'disabled')).toBe(true);
  });

  it('refuses a second row while one has no name, instead of silently dropping it', () => {
    // The args object is keyed by the name, so two unnamed rows cannot both
    // exist: a second "Add" would look like a no-op. The row says why, and the
    // add control is off until the name is filled in.
    const unnamed: SkillFlow = {
      version: 1,
      nodes: [
        { id: 'node-1', type: 'input', position: { x: 0, y: 0 }, data: { fields: [] } },
        {
          id: 'node-2',
          type: 'tool',
          position: { x: 320, y: 0 },
          data: { toolId: 'files.read', args: { '': '' } },
        },
        { id: 'node-3', type: 'output', position: { x: 640, y: 0 }, data: { shape: 'json' } },
      ],
      edges: [],
    };
    const html = render({ flow: unnamed, initialView: 'nodes' });
    expect(html).toContain('An argument needs a name');
    // ...and the error is wired to the control that owns it, so a screen reader
    // hears WHY the name cannot be stored instead of just that it is invalid.
    expect(html).toContain('aria-describedby="flow-row-node-2-arg-0-name-error"');
    expect(html).toContain('id="flow-row-node-2-arg-0-name-error"');
    expect(controlTag('button', html, '>Add argument', 'disabled')).toBe(true);
  });
});
