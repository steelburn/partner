/**
 * M28 slice C pure-logic tests (PLAN-M28.md D2/D9/D10).
 *
 * The web suite runs under the `node` environment with no DOM, and everything
 * here is a pure call. Two conventions are deliberate:
 *
 *  - **The core's codes are HARDCODED as strings.** Importing
 *    `core/src/skills/flow/compile.ts` from web would add a dependency direction
 *    this repo does not have, and the point of these cases is precisely that the
 *    mirror and the core agree on the CODE — writing the expectation down is
 *    what makes a drift visible when either side changes.
 *  - **Assertions are on the code, the attributed node and the de-duplication**
 *    (the decisions), not on the wording of a message.
 */
import { describe, expect, it } from 'vitest';
import type {
  FlowBranchNode,
  FlowFilterNode,
  FlowInputNode,
  FlowLlmNode,
  FlowOutputNode,
  FlowTemplateNode,
  FlowToolNode,
  FlowValidationError,
  SkillFlow,
  SkillFlowEdge,
  SkillFlowNode,
  SkillFlowNodeType,
} from '@partner/shared';
import {
  autoArrangeFlow,
  edgeLabel,
  flowArgsForm,
  flowNodeErrors,
  flowToolIds,
  isFlowPath,
  newEdgeId,
  newFlowNode,
  newNodeId,
  nodeDetailRows,
  nodeSummary,
  paletteFor,
  proposalDiffRows,
  structuralIssues,
} from '../src/lib/flow-helpers.js';

// ---------------------------------------------------------------------------
// Fixtures: one builder per node type, so a case reads as the graph it describes
// ---------------------------------------------------------------------------

const at = (x = 0, y = 0): { x: number; y: number } => ({ x, y });

function input(id: string, fields: FlowInputNode['data']['fields'] = []): FlowInputNode {
  return { id, type: 'input', position: at(), data: { fields } };
}
function output(id: string, shape: 'json' | 'text' = 'json'): FlowOutputNode {
  return { id, type: 'output', position: at(), data: { shape } };
}
function tool(id: string, toolId: string): FlowToolNode {
  return { id, type: 'tool', position: at(), data: { toolId, args: {} } };
}
function filter(id: string, path: string, op: FlowFilterNode['data']['op'] = 'exists', value?: unknown): FlowFilterNode {
  return {
    id,
    type: 'filter',
    position: at(),
    data: value === undefined ? { path, op } : { path, op, value },
  };
}
function branch(id: string, path: string, op: FlowBranchNode['data']['op'] = 'exists'): FlowBranchNode {
  return { id, type: 'branch', position: at(), data: { path, op } };
}
function template(id: string, text: string): FlowTemplateNode {
  return { id, type: 'template', position: at(), data: { text } };
}
function mapNode(id: string, select: Record<string, string>): SkillFlowNode {
  return { id, type: 'map', position: at(), data: { select } };
}
function mergeNode(id: string, shape: 'object' | 'array' = 'array'): SkillFlowNode {
  return { id, type: 'merge', position: at(), data: { shape, keys: [] } };
}
function llm(id: string): FlowLlmNode {
  return { id, type: 'llm', position: at(), data: { prompt: 'summarise {{text}}' } };
}
function flow(nodes: SkillFlowNode[], edges: SkillFlowEdge[] = []): SkillFlow {
  return { version: 1, nodes, edges };
}
function edge(id: string, source: string, target: string, sourceHandle: string | null = null): SkillFlowEdge {
  return { id, source, target, sourceHandle, targetHandle: null };
}

/** The agreed-with-core view of a result: which codes, on which nodes. */
function codes(issues: readonly FlowValidationError[]): string[] {
  return issues.map((issue) => issue.code);
}
function codesOn(issues: readonly FlowValidationError[], nodeId: string | null): string[] {
  return issues.filter((issue) => issue.nodeId === nodeId).map((issue) => issue.code);
}
const NO_LLM = { llmAvailable: false, toolIds: [] as readonly string[] };
const WITH_LLM = { llmAvailable: true, toolIds: [] as readonly string[] };

/** The palette's own composition: a fresh node re-id'd by the allocator. */
function add(existing: SkillFlow, type: SkillFlowNodeType): SkillFlowNode {
  return { ...newFlowNode(type, at()), id: newNodeId(existing) };
}

const CLEAN = flow([input('node-1'), output('node-2')], [edge('edge-1', 'node-1', 'node-2')]);

// ---------------------------------------------------------------------------
// Palette (D2 order, D9 gating)
// ---------------------------------------------------------------------------

describe('palette (D2 order, D9 capability gating)', () => {
  it('offers all ten node types in the vocabulary order', () => {
    const entries = paletteFor({ llmAvailable: true });
    expect(entries.map((entry) => entry.type)).toEqual([
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
    ]);
    // Every entry can be read on its own: a label and a line of what it does.
    expect(entries.every((entry) => entry.label !== '' && entry.hint !== '')).toBe(true);
  });

  it('omits the model node when this build has no model reach (D9)', () => {
    const gated = paletteFor({ llmAvailable: false });
    expect(gated.map((entry) => entry.type)).not.toContain('llm');
    expect(gated).toHaveLength(9);
    // The gate removes exactly one entry and reorders nothing.
    expect(gated.map((entry) => entry.type)).toEqual(
      paletteFor({ llmAvailable: true })
        .map((entry) => entry.type)
        .filter((type) => type !== 'llm'),
    );
  });
});

// ---------------------------------------------------------------------------
// The client-side structural mirror (agreement with the core's CODES)
// ---------------------------------------------------------------------------

describe('structuralIssues agrees with the core', () => {
  it('says nothing about a flow the core would compile', () => {
    expect(structuralIssues(CLEAN, WITH_LLM)).toEqual([]);
  });

  it('names a missing input and a missing output on the flow itself', () => {
    const issues = structuralIssues(flow([]), WITH_LLM);
    expect(codes(issues)).toEqual(['missing_input', 'missing_output']);
    expect(issues.map((issue) => issue.nodeId)).toEqual([null, null]);
  });

  it('refuses a second input per node (duplicate_input) and a second output (bad_node)', () => {
    const twoInputs = structuralIssues(flow([input('a'), input('b'), output('c')]), WITH_LLM);
    expect(codesOn(twoInputs, 'a')).toEqual(['duplicate_input']);
    expect(codesOn(twoInputs, 'b')).toEqual(['duplicate_input']);

    const twoOutputs = structuralIssues(flow([input('a'), output('b'), output('c')]), WITH_LLM);
    expect(codes(twoOutputs)).toEqual(['bad_node']);
    expect(twoOutputs[0]?.nodeId).toBe('c');
  });

  it('reports an edge whose endpoint is not in the document (dangling_edge, on the edge id)', () => {
    const issues = structuralIssues(flow([input('node-1'), output('node-2')], [edge('edge-9', 'node-1', 'node-9')]), WITH_LLM);
    expect(codes(issues)).toEqual(['dangling_edge']);
    expect(issues[0]?.nodeId).toBe('edge-9');
  });

  it('reports a tool id the registry does not have (unknown_tool)', () => {
    const issues = structuralIssues(flow([input('a'), tool('b', 'files.nope'), output('c')]), {
      llmAvailable: true,
      toolIds: ['files.read'],
    });
    expect(codes(issues)).toEqual(['unknown_tool']);
    expect(issues[0]?.nodeId).toBe('b');
  });

  it('reports a tool node with no tool chosen as bad_node, not unknown_tool', () => {
    const issues = structuralIssues(flow([input('a'), tool('b', ''), output('c')]), {
      llmAvailable: true,
      toolIds: ['files.read'],
    });
    expect(codesOn(issues, 'b')).toEqual(['bad_node']);
  });

  it('mirrors the path grammar and the operator whitelist (bad_path, bad_operator)', () => {
    expect(codesOn(structuralIssues(flow([input('a'), filter('b', '__proto__'), output('c')]), WITH_LLM), 'b')).toEqual([
      'bad_path',
    ]);
    expect(codesOn(structuralIssues(flow([input('a'), filter('b', ''), output('c')]), WITH_LLM), 'b')).toEqual([
      'bad_path',
    ]);
    // The core returns after an unknown operator, so no value complaint follows.
    const badOp = structuralIssues(flow([input('a'), filter('b', 'name', 'starts' as never), output('c')]), WITH_LLM);
    expect(codesOn(badOp, 'b')).toEqual(['bad_operator']);
    // A comparison without a value is the core's bad_node.
    expect(
      codesOn(structuralIssues(flow([input('a'), filter('b', 'name', 'eq'), output('c')]), WITH_LLM), 'b'),
    ).toEqual(['bad_node']);
  });

  it('validates template and prompt placeholders (bad_path)', () => {
    const bad = structuralIssues(flow([input('a'), template('b', 'hello {{a b}}'), output('c')]), WITH_LLM);
    expect(codesOn(bad, 'b')).toEqual(['bad_path']);
    const good = structuralIssues(flow([input('a'), template('b', 'hello {{name}}')]), WITH_LLM);
    expect(codesOn(good, 'b')).toEqual([]);
  });

  it('names a map node with no keys and a select value that is not a path', () => {
    const empty = flow([input('a'), mapNode('b', {}), output('c')]);
    expect(codesOn(structuralIssues(empty, WITH_LLM), 'b')).toEqual(['bad_node']);

    const badPath = flow([input('a'), mapNode('b', { name: 'a..b' }), output('c')]);
    expect(codesOn(structuralIssues(badPath, WITH_LLM), 'b')).toEqual(['bad_path']);
  });

  it('refuses an llm node when this build has no model reach (llm_not_available)', () => {
    const withLlm = flow([input('a'), llm('b'), output('c')]);
    expect(codesOn(structuralIssues(withLlm, NO_LLM), 'b')).toEqual(['llm_not_available']);
    expect(structuralIssues(withLlm, WITH_LLM)).toEqual([]);
  });

  it('calls an edge into a source node bad_node, on that node', () => {
    const issues = structuralIssues(
      flow([input('a'), template('c', 'x'), output('b')], [
        edge('edge-1', 'a', 'b'),
        edge('edge-2', 'c', 'a'),
      ]),
      WITH_LLM,
    );
    expect(codesOn(issues, 'a')).toEqual(['bad_node']);
  });

  it('allows one inbound edge only, except on a merge', () => {
    const two = flow([input('a'), template('b', 'pass-through'), template('c', 'x'), output('d')], [
      edge('edge-1', 'a', 'b'),
      edge('edge-2', 'c', 'b'),
    ]);
    expect(codesOn(structuralIssues(two, WITH_LLM), 'b')).toEqual(['bad_node']);

    const merged = flow([input('a'), mergeNode('b'), template('c', 'x'), output('d')], [
      edge('edge-1', 'a', 'b'),
      edge('edge-2', 'c', 'b'),
    ]);
    expect(codesOn(structuralIssues(merged, WITH_LLM), 'b')).toEqual([]);
  });

  it('attributes a named handle on a non-branch edge to the edge (bad_node)', () => {
    const issues = structuralIssues(
      flow([input('a'), output('b')], [edge('edge-1', 'a', 'b', 'then')]),
      WITH_LLM,
    );
    expect(codes(issues)).toEqual(['bad_node']);
    expect(issues[0]?.nodeId).toBe('edge-1');
  });

  it('names the cycle on a stable offender and stops there', () => {
    const cyclic = flow([input('a'), template('b', 'x'), template('c', 'y')], [
      edge('edge-1', 'b', 'c'),
      edge('edge-2', 'c', 'b'),
    ]);
    const issues = structuralIssues(cyclic, WITH_LLM);
    expect(codes(issues)).toEqual(['missing_output', 'cycle']);
    // The smallest id still holding an inbound edge — the core's own offender.
    expect(issues[1]?.nodeId).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// Derived facts
// ---------------------------------------------------------------------------

describe('args form and tool set', () => {
  it('reads the args form from the single input node, as a copy', () => {
    const f = flow([input('node-1', [{ name: 'text', type: 'string', required: true }]), output('node-2')]);
    const form = flowArgsForm(f);
    expect(form).toEqual([{ name: 'text', type: 'string', required: true }]);
    form[0]!.name = 'changed';
    expect((f.nodes[0] as FlowInputNode).data.fields[0]?.name).toBe('text');
    expect(flowArgsForm(flow([output('node-2')]))).toEqual([]);
  });

  it('lists the requested tool ids de-duplicated and sorted, ignoring an unchosen tool', () => {
    const f = flow([input('a'), tool('b', 'files.read'), tool('c', 'files.read'), tool('d', ''), output('e')]);
    expect(flowToolIds(f)).toEqual(['files.read']);
    const other = flow([input('a'), tool('b', 'notes.read'), tool('c', 'files.list'), output('e')]);
    expect(flowToolIds(other)).toEqual(['files.list', 'notes.read']);
  });
});

describe('auto-arrange (D10)', () => {
  it('fills only the nodes whose position is exactly {x: 0, y: 0}', () => {
    const dragged: SkillFlowNode = { ...output('dragged'), position: { x: 400, y: -120 } };
    const unset = { ...template('loose', ''), position: at(0, 0) };
    const arranged = autoArrangeFlow(flow([input('node-1'), dragged, unset], [edge('edge-1', 'node-1', 'dragged')]));
    const byId = new Map(arranged.nodes.map((node) => [node.id, node]));
    // The author's drag survives untouched.
    expect(byId.get('dragged')?.position).toEqual({ x: 400, y: -120 });
    // The unset nodes have to come OFF the origin, or auto-arrange changed
    // nothing; the shared layout then ranks them left of what they feed.
    expect(byId.get('node-1')?.position).not.toEqual({ x: 0, y: 0 });
    expect(byId.get('loose')?.position).not.toEqual({ x: 0, y: 0 });
    expect(byId.get('node-1')!.position.x).toBeLessThan(byId.get('dragged')!.position.x);
  });

  it('places a node one pixel off the origin only if the author put it there', () => {
    const nudged: SkillFlowNode = { ...template('nudged', ''), position: { x: 0, y: 4 } };
    const arranged = autoArrangeFlow(flow([nudged]));
    expect(arranged.nodes[0]?.position).toEqual({ x: 0, y: 4 });
  });

  it('is deterministic and keeps the document order', () => {
    const f = flow([input('node-1'), template('node-2', 'x'), output('node-3')], [edge('edge-1', 'node-1', 'node-2')]);
    const first = autoArrangeFlow(f);
    const second = autoArrangeFlow(f);
    expect(first).toEqual(second);
    expect(first.nodes.map((node) => node.id)).toEqual(['node-1', 'node-2', 'node-3']);
    // The same flow arranged twice (a reload) yields the same positions.
    expect(autoArrangeFlow(first)).toEqual(first);
  });
});

describe('new nodes and their ids', () => {
  it('builds a node of the shape each type declares', () => {
    expect(newFlowNode('input', at())).toMatchObject({ type: 'input', data: { fields: [] } });
    expect(newFlowNode('const', at())).toMatchObject({ type: 'const', data: { value: null } });
    expect(newFlowNode('template', at())).toMatchObject({ type: 'template', data: { text: '' } });
    expect(newFlowNode('map', at())).toMatchObject({ type: 'map', data: { select: {} } });
    expect(newFlowNode('merge', at())).toMatchObject({ type: 'merge', data: { shape: 'object', keys: [] } });
    expect(newFlowNode('output', at())).toMatchObject({ type: 'output', data: { shape: 'json' } });
    expect(newFlowNode('llm', at())).toMatchObject({ type: 'llm', data: { prompt: '' } });
    // The position is stored as given, which is what makes it draggable state.
    expect(newFlowNode('branch', at(12, 34)).position).toEqual({ x: 12, y: 34 });
  });

  /**
   * The three deliberately incomplete defaults: a value cannot be guessed, and a
   * guess would look configured. The mirror names the hole instead.
   */
  it('leaves a hole rather than inventing one, and the mirror names it', () => {
    const seed = flow([input('a'), output('d')]);
    const toolNode = add(seed, 'tool');
    const filterNode = add({ ...seed, nodes: [...seed.nodes, toolNode] }, 'filter');
    // The allocator composition cannot collide: two adds, two ids.
    expect(toolNode.id).not.toBe(filterNode.id);
    const unfinished = { ...seed, nodes: [...seed.nodes, toolNode, filterNode] };
    const issues = structuralIssues(unfinished, { llmAvailable: false, toolIds: ['files.read'] });
    expect(codesOn(issues, toolNode.id)).toEqual(['bad_node']);
    expect(codesOn(issues, filterNode.id)).toEqual(['bad_path']);
  });

  it('allocates ids one past the highest, never reusing a number after a delete', () => {
    expect(newNodeId(flow([]))).toBe('node-1');
    expect(newNodeId(flow([input('node-1'), output('node-2')]))).toBe('node-3');
    // node-2 was deleted: the next add does not take a number an edge may still
    // name (a hand-edited document can hold one). No counter, no timestamp.
    expect(newNodeId(flow([input('node-1')]))).toBe('node-2');
    expect(newNodeId(flow([input('node-7')]))).toBe('node-8');
    // An id the allocator did not write neither blocks nor advances the count.
    expect(newNodeId(flow([input('alpha')]))).toBe('node-1');
    expect(newEdgeId(flow([input('a')], [edge('edge-3', 'a', 'a')]))).toBe('edge-4');
    expect(newEdgeId(flow([]))).toBe('edge-1');
  });

  it('keeps the path grammar and the prototype refusals in step with the core', () => {
    expect(isFlowPath('a.b[0].c')).toBe(true);
    for (const bad of ['__proto__', 'constructor', 'prototype', 'a);x//', 'a[', 'a..b', '', 'a b']) {
      expect(isFlowPath(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Lines and rows the UI renders
// ---------------------------------------------------------------------------

describe('node summaries and detail rows', () => {
  it('summarises each type in the owner’s terms, and names an unfinished one', () => {
    expect(nodeSummary(input('a', [{ name: 'text', type: 'string', required: true }]))).toBe('Args: text');
    expect(nodeSummary(input('a'))).toBe('No arguments declared');
    expect(nodeSummary(tool('b', 'files.read'))).toBe('files.read');
    expect(nodeSummary(tool('b', ''))).toBe('No tool chosen');
    expect(nodeSummary(filter('c', 'name', 'eq', 'done'))).toContain('Keep items where name equals');
    expect(nodeSummary(filter('c', ''))).toBe('Needs a field path');
    expect(nodeSummary(branch('d', 'ok'))).toContain('Then/else on ok exists');
    expect(nodeSummary(output('e', 'text'))).toBe('Returns text');
    expect(nodeSummary(output('e'))).toBe('Returns JSON');
  });

  it('lists the declared facts of a node, including an unset one', () => {
    expect(nodeDetailRows(input('a', [{ name: 'text', type: 'string', required: true }]))).toEqual([
      { label: 'text', value: 'string · required' },
    ]);
    expect(nodeDetailRows(tool('b', ''))[0]).toEqual({ label: 'Tool', value: 'not chosen yet' });
    expect(nodeDetailRows(filter('c', 'name', 'eq', 3))).toEqual([
      { label: 'Field', value: 'name' },
      { label: 'Operator', value: 'equals' },
      { label: 'Value', value: '3' },
    ]);
    // `exists` compares against nothing, so there is no value row to read.
    expect(nodeDetailRows(filter('c', 'name', 'exists')).map((row) => row.label)).toEqual([
      'Field',
      'Operator',
    ]);
    expect(nodeDetailRows(output('e', 'text'))).toEqual([{ label: 'Shape', value: 'Text' }]);
  });

  it('groups issues by node and drops the ones that name no node', () => {
    const grouped = flowNodeErrors([
      { code: 'missing_output', nodeId: null, message: 'no output' },
      { code: 'bad_path', nodeId: 'b', message: 'bad' },
      { code: 'bad_node', nodeId: 'b', message: 'also bad' },
    ]);
    expect([...grouped.keys()]).toEqual(['b']);
    expect(grouped.get('b')?.map((issue) => issue.code)).toEqual(['bad_path', 'bad_node']);
  });

  it('reports a proposal diff as rows, one per non-empty bucket', () => {
    expect(
      proposalDiffRows({ nodesAdded: ['node-3'], nodesRemoved: [], nodesChanged: ['node-1'], edgesChanged: 2 }),
    ).toEqual([
      { label: 'Nodes added', detail: 'node-3' },
      { label: 'Nodes changed', detail: 'node-1' },
      { label: 'Edges changed', detail: '2' },
    ]);
    // A long bucket is summarised rather than spilling its whole list.
    const many = proposalDiffRows({
      nodesAdded: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'],
      nodesRemoved: [],
      nodesChanged: [],
      edgesChanged: 0,
    });
    expect(many).toEqual([{ label: 'Nodes added', detail: 'n1, n2, n3, n4, n5, n6 (+1 more)' }]);
    // Nothing changed is NO rows — the card says "no change", not "0 added".
    expect(proposalDiffRows({ nodesAdded: [], nodesRemoved: [], nodesChanged: [], edgesChanged: 0 })).toEqual([]);
  });

  it('names an edge by its endpoints and its port', () => {
    expect(edgeLabel(edge('edge-1', 'node-1', 'node-2'))).toBe('node-1 → node-2');
    expect(edgeLabel(edge('edge-2', 'node-1', 'node-2', 'then'))).toBe('node-1 (then) → node-2');
  });
});
