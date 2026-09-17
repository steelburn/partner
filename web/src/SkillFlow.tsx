/**
 * M28 slice C — the Flow canvas (PLAN-M28.md D2/D9/D10).
 *
 * WHAT THIS FILE IS, and the four decisions its shape follows from:
 *
 *   1. **It fetches nothing.** The Studio container owns every request (load,
 *      save, compile, refine); this view renders the flow it is handed and
 *      reports every edit through `onChange`. A view that fetched would need the
 *      draft id, the token and the save semantics — none of which are its job.
 *   2. **Canvas and Nodes are two views of ONE document** (D9). React Flow has
 *      no keyboard path to creating an edge, so the table is the honest fix
 *      rather than a claim: every field, both edge endpoints, the handle a
 *      connection leaves from, and the add/remove of a node or an edge are real
 *      controls there. Both views write through the same `onChange`, and the
 *      per-type field editors are ONE component used by both (a second copy
 *      would drift).
 *   3. **The mirror is feedback, never authority.** `structuralIssues`
 *      (lib/flow-helpers.ts) names the core's codes so a problem appears while
 *      the author draws; `validateFlow`/`compileFlow` decide. The strip shows
 *      the core's list first (its wording wins) then the mirror's, de-duplicated
 *      by `code + node`, so one problem is never listed twice. A clean strip is
 *      never rendered as "this compiles".
 *   4. **No outer `ReactFlowProvider`** — unlike NotesGraph. `<ReactFlow>`
 *      creates its own store when there is none, and a provider above it is
 *      exactly what stops the canvas rendering under `renderToStaticMarkup`
 *      (the store is seeded from the `nodes` prop only when ReactFlow builds
 *      it). Nothing here uses a React Flow hook outside `<ReactFlow>`, so the
 *      provider would buy nothing.
 *
 * Also deliberate: **a `tool` node's `args` ARE editable, in both views** (the
 * follow-up to this slice's control list). D3 makes an arg value one of exactly
 * two things — a path reference (`items[0].status`) or a literal — and the
 * document's rule for which is that a STRING matching the path grammar IS a
 * reference, with a literal string that would be read as a path written in the
 * schema's `{"$literal": …}` escape. So the kind select is derived from the
 * stored value, and the escape is what makes "the literal text `items`"
 * expressible at all: without it, choosing Literal for a path-shaped word would
 * silently mean a reference to upstream data.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  FlowBranchNode,
  FlowFieldSpec,
  FlowFieldType,
  FlowFilterNode,
  FlowInputNode,
  FlowLlmNode,
  FlowMapNode,
  FlowMergeNode,
  FlowOutputNode,
  FlowPosition,
  FlowTemplateNode,
  FlowToolNode,
  FlowValidationError,
  SkillFlow,
  SkillFlowEdge,
  SkillFlowNode,
  SkillFlowNodeType,
} from '@partner/shared';
import {
  FLOW_FIELD_TYPES,
  FLOW_NODE_LABELS,
  FLOW_NODE_ORDER,
  FLOW_OPERATORS,
  autoArrangeFlow,
  edgeLabel,
  flowNodeErrors,
  flowToolIds,
  isFlowPath,
  newEdgeId,
  newFlowNode,
  newNodeId,
  nodeDetailRows,
  nodeSummary,
  operatorLabel,
  paletteFor,
  structuralIssues,
} from './lib/flow-helpers.js';

export interface SkillFlowViewProps {
  flow: SkillFlow;
  llmAvailable: boolean;
  toolIds: readonly string[];
  readOnly: boolean;
  disabled: boolean;
  errors: readonly FlowValidationError[];
  onChange: (flow: SkillFlow) => void;
  initialView?: 'canvas' | 'nodes';
}

type FlowView = 'canvas' | 'nodes';

// ---------------------------------------------------------------------------
// What the canvas carries, and how node components reach the current handlers
// ---------------------------------------------------------------------------

interface FlowCanvasNodeData extends Record<string, unknown> {
  nodeType: SkillFlowNodeType;
  typeLabel: string;
  summary: string;
  /** The first mirrored problem's CODE — the message lives in the strip. */
  issueCode: string | null;
}

type FlowCanvasNode = Node<FlowCanvasNodeData>;

interface FlowCanvasEdgeData extends Record<string, unknown> {
  label: string;
}

type FlowCanvasEdge = Edge<FlowCanvasEdgeData>;

/**
 * Node and edge components are rendered deep inside `<ReactFlow>`, so the
 * handlers reach them through context rather than through node `data`: `data`
 * stays pure content (which is what the rebuild key compares), and a handler can
 * never be a stale closure over an older document.
 */
interface FlowActions {
  locked: boolean;
  removeNode: (id: string) => void;
  removeEdge: (id: string) => void;
}

const FlowActionsContext = createContext<FlowActions>({
  locked: true,
  removeNode: () => undefined,
  removeEdge: () => undefined,
});

// ---------------------------------------------------------------------------
// The ten node types, one component: the type is DATA, so `nodeTypes` is a map
// of ten keys onto one view and React Flow never falls back to its own node.
// ---------------------------------------------------------------------------

function FlowNodeView({ id, data }: NodeProps<FlowCanvasNode>): React.JSX.Element {
  const actions = useContext(FlowActionsContext);
  const isBranch = data.nodeType === 'branch';
  return (
    <div className={data.issueCode === null ? 'flow-node' : 'flow-node flow-node-error'}>
      {/* Left = data in, right = data out, the .n-graph grammar (M16). React
       * Flow only draws an edge between two declared Handles. */}
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <span className="flow-node-type">{data.typeLabel}</span>
      <span className="flow-node-title">{data.summary}</span>
      {data.issueCode === null ? null : <span className="flow-issue">{data.issueCode}</span>}
      {actions.locked ? null : (
        <button
          type="button"
          className="btn btn-secondary btn-sm flow-node-remove nodrag"
          onClick={() => actions.removeNode(id)}
          aria-label={`Remove node ${id}`}
        >
          Remove
        </button>
      )}
      {isBranch ? (
        <>
          {/* A branch is the one node with two named outputs (D2): the author
           * picks 'then' or 'else' by dragging from the matching dot, and the
           * compiler reads that as `edge.sourceHandle`. */}
          <span className="flow-node-port flow-node-port-then">then</span>
          <Handle
            type="source"
            id="then"
            position={Position.Right}
            className="flow-handle flow-handle-then"
          />
          <span className="flow-node-port flow-node-port-else">else</span>
          <Handle
            type="source"
            id="else"
            position={Position.Right}
            className="flow-handle flow-handle-else"
          />
        </>
      ) : (
        <Handle type="source" position={Position.Right} className="flow-handle" />
      )}
    </div>
  );
}

/**
 * Edges are SVG paths, so React Flow has no place to put a button — except the
 * label renderer. That is where the Remove control lives, which is what makes
 * deleting an edge independent of the Delete key (which is off: `deleteKeyCode`
 * is null, as in NotesGraph).
 */
function FlowEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps<FlowCanvasEdge>): React.JSX.Element {
  const actions = useContext(FlowActionsContext);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className="flow-edge-label"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <span className="flow-edge-name">{data?.label ?? id}</span>
          {actions.locked ? null : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => actions.removeEdge(id)}
              aria-label={`Remove edge ${data?.label ?? id}`}
            >
              Remove
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/**
 * React Flow reserves the node-type names `default`, `input`, `output` and
 * `group`: its own stylesheet draws a 150px-wide card with a border and a
 * hover/selected shadow for those classes. Two of this vocabulary's types are
 * called `input` and `output`, so the React Flow side of the name is prefixed
 * and the DOCUMENT keeps D2's spelling. One component serves all ten; the type
 * travels in `data` for the label and the branch's two ports.
 *
 * A module constant on purpose: React Flow warns (and re-mounts nodes) when the
 * map's identity changes between renders.
 */
function rfNodeType(type: SkillFlowNodeType): string {
  return `flow-${type}`;
}

const nodeTypes: NodeTypes = {
  'flow-input': FlowNodeView,
  'flow-const': FlowNodeView,
  'flow-tool': FlowNodeView,
  'flow-template': FlowNodeView,
  'flow-filter': FlowNodeView,
  'flow-map': FlowNodeView,
  'flow-branch': FlowNodeView,
  'flow-merge': FlowNodeView,
  'flow-llm': FlowNodeView,
  'flow-output': FlowNodeView,
};

const edgeTypes: EdgeTypes = { flow: FlowEdgeView };

// ---------------------------------------------------------------------------
// Typed field editors — one implementation, used by the table rows AND the
// inspector (a second copy would drift, and component hygiene is a gate)
// ---------------------------------------------------------------------------

interface NodeFieldProps {
  disabled: boolean;
  /** Replace this node with a structurally-updated copy (a no-op when locked). */
  onPatch: (next: (node: SkillFlowNode) => SkillFlowNode) => void;
}

interface FieldProps extends NodeFieldProps {
  idPrefix: string;
}

/** The node's own id, held locally while the text is not a usable id yet. */
function NodeIdField({
  node,
  disabled,
  existingIds,
  onRename,
}: {
  node: SkillFlowNode;
  disabled: boolean;
  existingIds: readonly string[];
  onRename: (next: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState(node.id);
  const [error, setError] = useState<string | null>(null);
  // A different node in this slot must not inherit the previous one's text.
  useEffect(() => {
    setText(node.id);
    setError(null);
  }, [node.id]);
  const check = (value: string): string | null => {
    if (value === '') return 'An id cannot be empty — edges name nodes by it.';
    if (value.length > 64) return 'An id may be at most 64 characters.';
    if (value !== node.id && existingIds.includes(value)) {
      return `"${value}" is already used by another node.`;
    }
    return null;
  };
  return (
    <div className="flow-inspector-field">
      <label className="label" htmlFor={`flow-id-${node.id}`}>
        Id
      </label>
      <input
        id={`flow-id-${node.id}`}
        className="field"
        type="text"
        value={text}
        spellCheck={false}
        disabled={disabled}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          const problem = check(value);
          setError(problem);
          if (problem === null) onRename(value);
        }}
      />
      {error === null ? null : <p className="form-error">{error}</p>}
    </div>
  );
}

/**
 * A JSON value held as text. The document cannot store text that is not JSON, so
 * the field keeps its own copy and REFUSES to write while the text does not
 * parse: an invalid value that reached the flow would be silently repaired (or
 * refused) by the core, and the author would never see which keystroke was the
 * problem. The `lastCommitted` guard is what stops a valid edit from being
 * re-rendered into pretty-printed JSON under the cursor.
 */
function JsonValueField({
  idPrefix,
  field,
  label,
  value,
  hint,
  disabled,
  onCommit,
}: {
  idPrefix: string;
  field: string;
  label: string;
  value: unknown;
  hint: string;
  disabled: boolean;
  onCommit: (next: unknown) => void;
}): React.JSX.Element {
  const show = (raw: unknown): string => JSON.stringify(raw, null, 2) ?? '';
  const [text, setText] = useState(() => show(value));
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState(() => JSON.stringify(value) ?? '');
  const current = JSON.stringify(value) ?? '';
  useEffect(() => {
    // Only a change this field did not make may overwrite the text: a proposal
    // or another editor replacing the value must show up here.
    if (current === committed) return;
    setCommitted(current);
    setText(show(value));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  const fieldId = `${idPrefix}-${field}`;
  return (
    <div className="flow-inspector-field">
      <label className="label" htmlFor={fieldId}>
        {label}
      </label>
      <textarea
        id={fieldId}
        className="field flow-json"
        value={text}
        spellCheck={false}
        disabled={disabled}
        aria-invalid={error === null ? undefined : true}
        aria-describedby={`${fieldId}-hint`}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (next.trim() === '') {
            setError('A value is required here — write JSON, or remove the node.');
            return;
          }
          try {
            const parsed: unknown = JSON.parse(next);
            setError(null);
            setCommitted(JSON.stringify(parsed) ?? '');
            onCommit(parsed);
          } catch {
            setError('This is not valid JSON yet, so nothing is being saved.');
          }
        }}
      />
      {error === null ? (
        <p id={`${fieldId}-hint`} className="form-hint">
          {hint}
        </p>
      ) : (
        <p id={`${fieldId}-hint`} className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** `input` — the args declaration, one row per field (add/remove/edit). */
function InputFields({ node, disabled, onPatch }: { node: FlowInputNode } & NodeFieldProps): React.JSX.Element {
  const fields = node.data.fields;
  const setFields = (next: FlowFieldSpec[]): void =>
    onPatch((node) => (node.type === 'input' ? { ...node, data: { fields: next } } : node));
  return (
    <div className="flow-inspector-field">
      <span className="label">Arguments</span>
      {fields.length === 0 ? (
        <p className="form-hint">
          No arguments yet: this skill would run with none. Add one for each value the skill needs.
        </p>
      ) : null}
      {fields.map((field, index) => (
        <div className="flow-field-row" key={index}>
          <input
            className="field"
            type="text"
            value={field.name}
            spellCheck={false}
            placeholder="name"
            aria-label={`Argument ${index + 1} name`}
            disabled={disabled}
            onChange={(event) =>
              setFields(fields.map((current, at) => (at === index ? { ...current, name: event.target.value } : current)))
            }
          />
          <select
            className="field"
            value={field.type}
            aria-label={`Argument ${index + 1} type`}
            disabled={disabled}
            onChange={(event) =>
              setFields(
                fields.map((current, at) =>
                  at === index ? { ...current, type: event.target.value as FlowFieldType } : current,
                ),
              )
            }
          >
            {FLOW_FIELD_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <label className="check-label">
            <input
              type="checkbox"
              className="check"
              checked={field.required}
              disabled={disabled}
              aria-label={`Argument ${index + 1} required`}
              onChange={(event) =>
                setFields(
                  fields.map((current, at) =>
                    at === index ? { ...current, required: event.target.checked } : current,
                  ),
                )
              }
            />
            Required
          </label>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={disabled}
            onClick={() => setFields(fields.filter((_current, at) => at !== index))}
            aria-label={`Remove argument ${index + 1}`}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={disabled}
        onClick={() => setFields([...fields, { name: '', type: 'string', required: true }])}
      >
        Add argument
      </button>
    </div>
  );
}

/** `const` — a JSON literal, held as text until it parses. */
function ConstFields({ node, idPrefix, disabled, onPatch }: { node: Extract<SkillFlowNode, { type: 'const' }> } & FieldProps): React.JSX.Element {
  return (
    <JsonValueField
      idPrefix={idPrefix}
      field="value"
      label="Value"
      value={node.data.value}
      hint="Any JSON value: text, a number, a list, an object."
      disabled={disabled}
      onCommit={(next) => onPatch((node) => (node.type === 'const' ? { ...node, data: { value: next } } : node))}
    />
  );
}

/**
 * The `{"$literal": …}` escape key, spelled exactly as the schema spells it
 * (`FLOW_LITERAL_KEY` in `core/src/skills/flow/schema.ts`). A local constant on
 * purpose: this bundle cannot import core, and a second spelling of the key
 * would be a second rule about what an arg value means.
 */
const FLOW_LITERAL_KEY = '$literal';

/** The two shapes ONE `tool` arg value may have (D3). */
type ArgKind = 'path' | 'literal';

/**
 * Which shape a STORED arg value has, read back by the schema's own rule: a
 * string that matches the path grammar is a reference, and everything else is a
 * literal — including a `{"$literal": …}` escape, which is an object. The kind is
 * DERIVED from the value on every render and never held as field state, so the
 * document stays the single source of truth for what an argument means.
 */
function argKindOf(value: unknown): ArgKind {
  return typeof value === 'string' && isFlowPath(value) ? 'path' : 'literal';
}

/** A record that IS the escape — the ONE shape the compiler unwraps. */
function isLiteralEscape(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && FLOW_LITERAL_KEY in record;
}

/** The literal a stored value carries: the escape's payload, or the value itself. */
function argLiteralValue(value: unknown): unknown {
  if (!isLiteralEscape(value)) return value;
  return value[FLOW_LITERAL_KEY];
}

/**
 * What the value box shows: the path itself, or the literal as JSON. The escape
 * is a STORAGE form — the author edits the payload (`"read"`), not the wrapper
 * (`{"$literal": "read"}`) — and the write half below puts it back. The JSON is
 * compact because the box is ONE line: a pretty-printed object would come back
 * from the input with its newlines stripped, so the text on screen and the text
 * being edited would quietly differ.
 */
function argValueText(value: unknown): string {
  if (argKindOf(value) === 'path') return value as string;
  return JSON.stringify(argLiteralValue(value)) ?? '';
}

/**
 * The write half of the escape, and the exact trap the schema documents: the
 * compiler reads a STRING arg value as a path reference IFF it matches D3's
 * grammar, so the literal *text* `items` has to be stored `{"$literal":"items"}`
 * or the compiled skill would read upstream data where the author typed text.
 * The same misreading applies to an object that is nothing but the escape (the
 * compiler unwraps that too), so it is escaped as well — which is what keeps the
 * panel's round trip closed: write a value, read it back, write it again.
 */
function escapeArgLiteral(value: unknown): unknown {
  if (typeof value === 'string' && isFlowPath(value)) return { [FLOW_LITERAL_KEY]: value };
  if (isLiteralEscape(value)) return { [FLOW_LITERAL_KEY]: value };
  return value;
}

/**
 * Why a key cannot be stored yet, or null. An empty name and a duplicate are
 * both REFUSED rather than repaired: the args record is keyed by this very
 * string, so dropping a row would lose an argument and renaming it would
 * overwrite one. `current` is this row's own stored key, which is never a
 * duplicate of itself.
 */
function argKeyProblem(next: string, current: string, keys: readonly string[]): string | null {
  if (next === '') return 'An argument needs a name — args are stored as one key/value object.';
  if (next !== current && keys.includes(next)) return `"${next}" already names another argument.`;
  return null;
}

interface ToolArgRowProps {
  index: number;
  /** Unique per row within this node's editor, for the error text's ids. */
  idPrefix: string;
  argKey: string;
  value: unknown;
  /** Every stored key, so a rename can refuse a duplicate (this row's included). */
  keys: readonly string[];
  disabled: boolean;
  onChangeKey: (index: number, next: string) => void;
  onChangeValue: (index: number, next: unknown) => void;
  onRemove: (index: number) => void;
}

/**
 * ONE `tool` arg: its key, which of D3's two shapes its value has, and the value
 * itself. The row holds its own text while an edit is not yet storable — the
 * document cannot hold a malformed path or unparsable JSON, and writing an
 * approximation would be the silent repair this panel exists to prevent. The
 * inline error says nothing is being saved; the stored value stands until the
 * text is something the document can mean.
 */
function ToolArgRow({
  index,
  idPrefix,
  argKey,
  value,
  keys,
  disabled,
  onChangeKey,
  onChangeValue,
  onRemove,
}: ToolArgRowProps): React.JSX.Element {
  const storedKind = argKindOf(value);
  // Everything about the stored value, in one string, so ONE guard can tell "this
  // row wrote it" from "something else replaced it" (a proposal, a reload, a
  // removal that shifted this index onto another argument).
  const stored = `${storedKind}\u0000${JSON.stringify(value) ?? ''}`;
  const [keyText, setKeyText] = useState(argKey);
  const [kind, setKind] = useState<ArgKind>(storedKind);
  const [text, setText] = useState(() => argValueText(value));
  const [committed, setCommitted] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setKeyText(argKey);
  }, [argKey]);
  useEffect(() => {
    // Only a change this row did NOT make may overwrite its text and kind: a
    // commit below records the snapshot it writes, so the author keeps the text
    // they typed instead of watching it reformat under the cursor.
    if (stored === committed) return;
    setCommitted(stored);
    setKind(storedKind);
    setText(argValueText(value));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);
  // Derived, not held: an empty or duplicate name shows its error as soon as it
  // is typed (and for a name a hand-written document already holds).
  const keyProblem = argKeyProblem(keyText, argKey, keys);
  const badPath =
    'A field path is identifiers and list indexes only, e.g. items[0].status — nothing is saved until it is one.';

  /** Write `next` through, and record the snapshot so the row keeps its text. */
  const commit = (next: unknown, nextKind: ArgKind): void => {
    setCommitted(`${nextKind}\u0000${JSON.stringify(next) ?? ''}`);
    // A commit that changes nothing must not push a new document: `onChange` is
    // the save path, and a redundant write would mark the flow dirty.
    if (nextKind === storedKind && JSON.stringify(next) === JSON.stringify(value)) return;
    onChangeValue(index, next);
  };

  /**
   * The path is validated with `isFlowPath` — the ONE grammar the canvas and the
   * core share (D3), never a second regex — and an invalid one is not written:
   * the document cannot hold a path the compiler would refuse, and writing
   * nothing is what lets the author see which keystroke is not a path yet.
   */
  const changeValue = (raw: string): void => {
    setText(raw);
    if (kind === 'path') {
      if (!isFlowPath(raw)) {
        setError(badPath);
        return;
      }
      setError(null);
      // A reference IS the bare path string in the document: that short form is
      // exactly what the schema's `tool.args` rule reads back as a path.
      commit(raw, 'path');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setError('This is not valid JSON yet, so nothing is being saved.');
      return;
    }
    setError(null);
    // Through the escape: a literal string that reads as a path has to be stored
    // in the schema's wrapper, or the compiler would read data instead of text.
    commit(escapeArgLiteral(parsed), 'literal');
  };

  /**
   * Switching the shape carries the text across where it can. Reference →
   * literal writes the path's characters as a JSON string, ESCAPED when they
   * would read as a path again: without the escape the document cannot express
   * "the literal text `items`" at all, and the select would snap back to Path
   * reference on the next render. Literal → reference reuses a JSON string that
   * IS a path; anything else starts empty and UNSAVED, because a made-up path
   * would silently point at data the author never chose.
   */
  const changeKind = (next: ArgKind): void => {
    if (next === kind) return;
    setKind(next);
    setError(null);
    if (next === 'path') {
      const literal = argLiteralValue(value);
      if (typeof literal === 'string' && isFlowPath(literal)) {
        setText(literal);
        commit(literal, 'path');
        return;
      }
      setText('');
      setError(badPath);
      return;
    }
    const literal = escapeArgLiteral(argLiteralValue(value));
    setText(argValueText(literal));
    commit(literal, 'literal');
  };

  return (
    // The controls share one line (.flow-field-row); an error takes the line
    // BELOW them, because a message squeezed in beside a button reads as another
    // control. `.flow-inspector-field` is the existing column that does that.
    <div className="flow-inspector-field">
      <div className="flow-field-row">
        <input
          className="field"
          type="text"
          value={keyText}
          spellCheck={false}
          placeholder="name"
          aria-label={`Argument ${index + 1} name`}
          aria-invalid={keyProblem === null ? undefined : true}
          aria-describedby={keyProblem === null ? undefined : `${idPrefix}-name-error`}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            setKeyText(next);
            if (argKeyProblem(next, argKey, keys) !== null) return;
            onChangeKey(index, next);
          }}
        />
        <select
          className="field"
          value={kind}
          aria-label={`Argument ${index + 1} kind`}
          disabled={disabled}
          onChange={(event) => changeKind(event.target.value as ArgKind)}
        >
          <option value="path">Path reference</option>
          <option value="literal">Literal</option>
        </select>
        <input
          className="field flow-json"
          type="text"
          value={text}
          spellCheck={false}
          placeholder={kind === 'path' ? 'items[0].status' : '"text" or 42'}
          aria-label={`Argument ${index + 1} value`}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : `${idPrefix}-value-error`}
          disabled={disabled}
          onChange={(event) => changeValue(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={disabled}
          aria-label={`Remove argument ${index + 1}`}
          onClick={() => onRemove(index)}
        >
          Remove
        </button>
      </div>
      {keyProblem === null ? null : (
        <p id={`${idPrefix}-name-error`} className="form-error">
          {keyProblem}
        </p>
      )}
      {error === null ? null : (
        <p id={`${idPrefix}-value-error`} className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * `tool` — the tool id, limited to what the broker registry actually has, plus
 * D3's args: a key, a KIND (path reference or literal) and a value per row. An id
 * the build does not know is still SHOWN (the DraftEditor precedent): hiding it
 * would leave a node that names a tool the owner cannot see or remove.
 */
function ToolFields({ node, idPrefix, toolIds, disabled, onPatch }: { node: FlowToolNode; toolIds: readonly string[] } & FieldProps): React.JSX.Element {
  const known = node.data.toolId === '' || toolIds.includes(node.data.toolId);
  const options = known ? toolIds : [node.data.toolId, ...toolIds];
  const entries = Object.entries(node.data.args);
  const keys = entries.map(([key]) => key);
  const unnamed = keys.includes('');
  /**
   * Rebuild the args object from an entry LIST, position for position. Why not
   * `{ ...args, [next]: value }`: that appends, so a rename would jump to the
   * last row and this editor's row would appear to move while the author types.
   * The compiler sorts the keys when it emits the call, so the stored order
   * cannot affect the code either way.
   */
  const setArgs = (next: Array<[string, unknown]>): void => {
    const args: Record<string, unknown> = {};
    for (const [key, value] of next) args[key] = value;
    onPatch((node) => (node.type === 'tool' ? { ...node, data: { ...node.data, args } } : node));
  };
  const setKey = (at: number, next: string): void =>
    setArgs(entries.map((entry, index): [string, unknown] => (index === at ? [next, entry[1]] : entry)));
  const setValue = (at: number, next: unknown): void =>
    setArgs(entries.map((entry, index): [string, unknown] => (index === at ? [entry[0], next] : entry)));
  const removeAt = (at: number): void => setArgs(entries.filter((_entry, index) => index !== at));
  return (
    <>
      <div className="flow-inspector-field">
        <label className="label" htmlFor={`${idPrefix}-tool`}>
          Tool
        </label>
        <select
          id={`${idPrefix}-tool`}
          className="field"
          value={node.data.toolId}
          disabled={disabled}
          onChange={(event) =>
            onPatch((node) => (node.type === 'tool' ? { ...node, data: { ...node.data, toolId: event.target.value } } : node))
          }
        >
          <option value="">Choose a tool…</option>
          {options.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <p className="form-hint">
          A tool the skill requests has to be granted before it can run — the install declares exactly
          the tools this flow names.
        </p>
      </div>
      <div className="flow-inspector-field">
        <span className="label">Arguments</span>
        <p className="form-hint">
          An argument is either a path reference — data read from what arrives at this node — or a
          literal, written as JSON, where text needs its quotes. A literal whose text would read as a
          path is stored in the schema’s {'{"$literal": …}'} escape, so the compiler cannot mistake it
          for a reference.
        </p>
        {entries.length === 0 ? (
          <p className="form-hint">No arguments yet: this tool would be called with none.</p>
        ) : null}
        {entries.map(([key, value], index) => (
          // Position is a row's only identity: the args object is keyed by the
          // very string the author is editing, so a key-based React key would
          // remount the row on every keystroke and lose the caret.
          <ToolArgRow
            key={index}
            index={index}
            idPrefix={`${idPrefix}-arg-${index}`}
            argKey={key}
            value={value}
            keys={keys}
            disabled={disabled}
            onChangeKey={setKey}
            onChangeValue={setValue}
            onRemove={removeAt}
          />
        ))}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={disabled || unnamed}
          onClick={() => setArgs([...entries, ['', '']])}
        >
          Add argument
        </button>
        {unnamed ? (
          <p className="form-hint">
            Name the argument above first — args are one key/value object, so a second unnamed row
            cannot exist.
          </p>
        ) : null}
      </div>
    </>
  );
}

/** `template` / `llm` — free text, and `{{path}}` is the only substitution. */
function TextFields({ node, idPrefix, disabled, onPatch }: { node: FlowTemplateNode | FlowLlmNode } & FieldProps): React.JSX.Element {
  const isTemplate = node.type === 'template';
  const fieldId = `${idPrefix}-text`;
  return (
    <div className="flow-inspector-field">
      <label className="label" htmlFor={fieldId}>
        {isTemplate ? 'Text' : 'Prompt'}
      </label>
      <textarea
        id={fieldId}
        className="field flow-text"
        value={isTemplate ? node.data.text : node.data.prompt}
        spellCheck={false}
        disabled={disabled}
        aria-describedby={`${fieldId}-hint`}
        onChange={(event) => {
          const value = event.target.value;
          onPatch((node) =>
            node.type === 'template'
              ? { ...node, data: { text: value } }
              : node.type === 'llm'
                ? { ...node, data: { prompt: value } }
                : node,
          );
        }}
      />
      <p id={`${fieldId}-hint`} className="form-hint">
        {`{{path}}`} is the only substitution: it is filled from the data arriving at this node, and
        the path is validated before anything is written.
      </p>
    </div>
  );
}

/** `filter` / `branch` — a validated path, one of the eight operators, a value. */
function PredicateFields({ node, idPrefix, disabled, onPatch }: { node: FlowFilterNode | FlowBranchNode } & FieldProps): React.JSX.Element {
  const hasValue = node.data.op !== 'exists';
  const setData = (next: { path: string; op: FlowFilterNode['data']['op']; value?: unknown }): void => {
    const merged = { ...next } as { path: string; op: FlowFilterNode['data']['op']; value?: unknown };
    // Leaving the comparison value out entirely is what `exists` means, and is
    // what the core checks for; keeping a dead value would be invisible state.
    if (merged.op === 'exists') delete merged.value;
    onPatch((node) =>
      node.type === 'filter' || node.type === 'branch' ? { ...node, data: merged } : node,
    );
  };
  return (
    <>
      <div className="flow-inspector-field">
        <label className="label" htmlFor={`${idPrefix}-path`}>
          Field
        </label>
        <input
          id={`${idPrefix}-path`}
          className="field"
          type="text"
          value={node.data.path}
          spellCheck={false}
          placeholder="e.g. items[0].status"
          disabled={disabled}
          onChange={(event) => setData({ ...node.data, path: event.target.value })}
        />
        <p className="form-hint">
          A field path — identifiers and list indexes only. It is read from the data arriving here.
        </p>
      </div>
      <div className="flow-inspector-field">
        <label className="label" htmlFor={`${idPrefix}-op`}>
          Operator
        </label>
        <select
          id={`${idPrefix}-op`}
          className="field"
          value={node.data.op}
          disabled={disabled}
          onChange={(event) => {
            const op = event.target.value as FlowFilterNode['data']['op'];
            // Switching to a comparison operator writes a placeholder `null` so
            // the node is complete; `exists` drops the value instead.
            setData({ ...node.data, op, value: op === 'exists' ? undefined : (node.data.value ?? null) });
          }}
        >
          {FLOW_OPERATORS.map((op) => (
            <option key={op} value={op}>
              {operatorLabel(op)}
            </option>
          ))}
        </select>
      </div>
      {hasValue ? (
        <JsonValueField
          idPrefix={idPrefix}
          field="value"
          label="Value to compare"
          value={node.data.value}
          hint="Any JSON value. Text compares exactly, numbers and booleans by value."
          disabled={disabled}
          onCommit={(next) => setData({ ...node.data, value: next })}
        />
      ) : null}
    </>
  );
}

/** `map` — one projected key per row (`key ← path`). */
function MapFields({ node, disabled, onPatch }: { node: FlowMapNode } & NodeFieldProps): React.JSX.Element {
  const entries = Object.entries(node.data.select);
  const setSelect = (next: Array<[string, string]>): void => {
    const select: Record<string, string> = {};
    for (const [key, path] of next) select[key] = path;
    onPatch((node) => (node.type === 'map' ? { ...node, data: { select } } : node));
  };
  return (
    <div className="flow-inspector-field">
      <span className="label">Keys</span>
      {entries.length === 0 ? (
        <p className="form-hint">
          No keys yet: a map node has to project at least one, or it produces nothing.
        </p>
      ) : null}
      {entries.map(([key, path], index) => (
        <div className="flow-field-row" key={index}>
          <input
            className="field"
            type="text"
            value={key}
            spellCheck={false}
            placeholder="key"
            aria-label={`Key ${index + 1}`}
            disabled={disabled}
            onChange={(event) =>
              setSelect(entries.map((entry, at) => (at === index ? [event.target.value, entry[1]] : entry)))
            }
          />
          <input
            className="field"
            type="text"
            value={path}
            spellCheck={false}
            placeholder="item path"
            aria-label={`Path for key ${index + 1}`}
            disabled={disabled}
            onChange={(event) =>
              setSelect(entries.map((entry, at) => (at === index ? [entry[0], event.target.value] : entry)))
            }
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={disabled}
            aria-label={`Remove key ${index + 1}`}
            onClick={() => setSelect(entries.filter((_entry, at) => at !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={disabled}
        onClick={() => setSelect([...entries, ['key', '']])}
      >
        Add key
      </button>
    </div>
  );
}

/** `merge` — one object or one list, and the keys an object binds by. */
function MergeFields({ node, idPrefix, disabled, onPatch }: { node: FlowMergeNode } & FieldProps): React.JSX.Element {
  const keys = node.data.keys;
  const setKeys = (next: string[]): void =>
    onPatch((node) => (node.type === 'merge' ? { ...node, data: { ...node.data, keys: next } } : node));
  return (
    <>
      <div className="flow-inspector-field">
        <label className="label" htmlFor={`${idPrefix}-shape`}>
          Shape
        </label>
        <select
          id={`${idPrefix}-shape`}
          className="field"
          value={node.data.shape}
          disabled={disabled}
          onChange={(event) =>
            onPatch((node) =>
              node.type === 'merge'
                ? { ...node, data: { ...node.data, shape: event.target.value as 'object' | 'array' } }
                : node,
            )
          }
        >
          <option value="object">One object</option>
          <option value="array">One list</option>
        </select>
      </div>
      <div className="flow-inspector-field">
        <span className="label">Keys</span>
        <p className="form-hint">
          Each inbound edge lands on one key. An edge can name its own key; these are the declared
          ones it falls back to.
        </p>
        {keys.map((key, index) => (
          <div className="flow-field-row" key={index}>
            <input
              className="field"
              type="text"
              value={key}
              spellCheck={false}
              placeholder="key"
              aria-label={`Merge key ${index + 1}`}
              disabled={disabled}
              onChange={(event) => setKeys(keys.map((current, at) => (at === index ? event.target.value : current)))}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={disabled}
              aria-label={`Remove merge key ${index + 1}`}
              onClick={() => setKeys(keys.filter((_current, at) => at !== index))}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={disabled}
          onClick={() => setKeys([...keys, `in${keys.length}`])}
        >
          Add key
        </button>
      </div>
    </>
  );
}

/** `output` — what `run(args)` returns. */
function OutputFields({ node, idPrefix, disabled, onPatch }: { node: FlowOutputNode } & FieldProps): React.JSX.Element {
  return (
    <div className="flow-inspector-field">
      <label className="label" htmlFor={`${idPrefix}-shape`}>
        Returns
      </label>
      <select
        id={`${idPrefix}-shape`}
        className="field"
        value={node.data.shape}
        disabled={disabled}
        onChange={(event) =>
          onPatch((node) =>
            node.type === 'output'
              ? { ...node, data: { shape: event.target.value as 'json' | 'text' } }
              : node,
          )
        }
      >
        <option value="json">JSON</option>
        <option value="text">Text</option>
      </select>
      <p className="form-hint">
        A text output renders a value carrying text — a model reply — as that text.
      </p>
    </div>
  );
}

/** The per-type controls for one node — the ONE editor both views use. */
function NodeDataFields({
  node,
  idPrefix,
  toolIds,
  disabled,
  onPatch,
}: {
  node: SkillFlowNode;
  idPrefix: string;
  toolIds: readonly string[];
} & NodeFieldProps): React.JSX.Element {
  switch (node.type) {
    case 'input':
      return <InputFields node={node} disabled={disabled} onPatch={onPatch} />;
    case 'const':
      return <ConstFields node={node} idPrefix={idPrefix} disabled={disabled} onPatch={onPatch} />;
    case 'tool':
      return (
        <ToolFields
          node={node}
          idPrefix={idPrefix}
          toolIds={toolIds}
          disabled={disabled}
          onPatch={onPatch}
        />
      );
    case 'template':
    case 'llm':
      return <TextFields node={node} idPrefix={idPrefix} disabled={disabled} onPatch={onPatch} />;
    case 'filter':
    case 'branch':
      return <PredicateFields node={node} idPrefix={idPrefix} disabled={disabled} onPatch={onPatch} />;
    case 'map':
      return <MapFields node={node} disabled={disabled} onPatch={onPatch} />;
    case 'merge':
      return <MergeFields node={node} idPrefix={idPrefix} disabled={disabled} onPatch={onPatch} />;
    case 'output':
      return <OutputFields node={node} idPrefix={idPrefix} disabled={disabled} onPatch={onPatch} />;
  }
}

// ---------------------------------------------------------------------------
// The document → canvas mapping
// ---------------------------------------------------------------------------

function toCanvasNodes(
  flow: SkillFlow,
  nodeIssues: Map<string, FlowValidationError[]>,
  selectedId: string | null,
): FlowCanvasNode[] {
  return flow.nodes.map((node) => {
    const issue = (nodeIssues.get(node.id) ?? [])[0];
    return {
      id: node.id,
      // `flow-<type>` is the React Flow name; the document's own type travels in
      // `data` (see the nodeTypes comment above). React Flow falls back to its
      // built-in box for a type it does not know, which is why the two spellings
      // go through rfNodeType in one place.
      type: rfNodeType(node.type),
      position: { x: node.position.x, y: node.position.y },
      selected: node.id === selectedId,
      data: {
        nodeType: node.type,
        typeLabel: FLOW_NODE_LABELS[node.type],
        summary: nodeSummary(node),
        issueCode: issue === undefined ? null : issue.code,
      },
    };
  });
}

const EDGE_ARROW = {
  type: MarkerType.ArrowClosed,
  width: 16,
  height: 16,
  color: 'var(--flow-edge)',
};

function toCanvasEdges(flow: SkillFlow): FlowCanvasEdge[] {
  return flow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    type: 'flow',
    markerEnd: EDGE_ARROW,
    style: { stroke: 'var(--flow-edge)' },
    data: { label: edgeLabel(edge) },
  }));
}

/**
 * The rebuild key: everything about the document the canvas draws from, and the
 * lock state. Why a content key and not the `flow` identity — the canvas holds
 * its own drag state, and re-seeding it on every parent render would yank a node
 * out from under the pointer. Re-seeding on a CONTENT change is exactly right:
 * it happens when the document moved (this view's own commit, a Nodes-table
 * edit, an accepted proposal, a saved reload) and never otherwise.
 */
function canvasKey(flow: SkillFlow, nodes: FlowCanvasNode[]): string {
  const parts = nodes.map((node) => `${node.id}|${node.position.x},${node.position.y}|${node.data.summary}|${node.data.issueCode ?? ''}`);
  const edges = flow.edges.map(
    (edge) => `${edge.id}|${edge.source}|${edge.sourceHandle ?? ''}|${edge.target}|${edge.targetHandle ?? ''}`,
  );
  return `${parts.join(';')}\u0000${edges.join(';')}`;
}

// ---------------------------------------------------------------------------
// Small surfaces
// ---------------------------------------------------------------------------

function FlowPalette({
  entries,
  llmAvailable,
  disabled,
  onAdd,
}: {
  entries: ReturnType<typeof paletteFor>;
  llmAvailable: boolean;
  disabled: boolean;
  onAdd: (type: SkillFlowNodeType) => void;
}): React.JSX.Element {
  return (
    <div className="flow-palette" role="group" aria-label="Add a node">
      {entries.map((entry) => (
        <button
          key={entry.type}
          type="button"
          className="btn btn-secondary flow-palette-item"
          onClick={() => onAdd(entry.type)}
          disabled={disabled}
          title={entry.hint}
        >
          <span>{entry.label}</span>
          <span className="form-hint">{entry.hint}</span>
        </button>
      ))}
      {llmAvailable ? null : (
        <p className="form-hint">
          A model node needs model reach, which this build does not have — so it is not offered at
          all, rather than offered and then refused by the compiler.
        </p>
      )}
    </div>
  );
}

function FlowIssues({ issues }: { issues: readonly FlowValidationError[] }): React.JSX.Element {
  return (
    <div className="flow-issues" aria-label="Structural problems">
      <h3 className="sub-panel-title">
        {issues.length === 0
          ? 'No structural problems'
          : `${issues.length} structural problem${issues.length === 1 ? '' : 's'}`}
      </h3>
      {issues.length === 0 ? (
        <p className="form-hint">
          The canvas checks the shape of the graph as you draw. This is not a compile: the core
          validates and compiles, and only a compile proves the flow can become code.
        </p>
      ) : (
        <ul>
          {issues.map((issue, index) => (
            <li key={`${issue.code}:${issue.nodeId ?? ''}:${index}`} className="flow-issue">
              <code className="flow-issue-code">{issue.code}</code>
              <code className="flow-issue-code">{issue.nodeId ?? 'the flow'}</code>
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NodeFacts({ node }: { node: SkillFlowNode }): React.JSX.Element {
  const rows = nodeDetailRows(node);
  return (
    <div className="flow-inspector-field">
      <span className="label">What this node stores</span>
      <dl className="flow-facts">
        {rows.map((row, index) => (
          <div key={`${row.label}:${index}`} className="flow-fact">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function SkillFlowView({
  flow,
  llmAvailable,
  toolIds,
  readOnly,
  disabled,
  errors,
  onChange,
  initialView = 'canvas',
}: SkillFlowViewProps): React.JSX.Element {
  const [view, setView] = useState<FlowView>(initialView);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // readOnly is history: an installed draft's flow cannot be saved, so a control
  // that cannot do anything is not rendered at all. `disabled` is a locked
  // session, where the same controls exist and are switched off.
  const locked = readOnly || disabled;

  const entries = useMemo(() => paletteFor({ llmAvailable }), [llmAvailable]);

  /**
   * The core's list first — its wording is the authority — then the mirror's,
   * minus anything the core already named. De-duplicated by `code + node`, so a
   * problem both can see is listed once.
   */
  const issues = useMemo<FlowValidationError[]>(() => {
    const key = (error: FlowValidationError): string => `${error.code}\u0000${error.nodeId ?? ''}`;
    const seen = new Set(errors.map(key));
    return [
      ...errors,
      ...structuralIssues(flow, { llmAvailable, toolIds }).filter((error) => !seen.has(key(error))),
    ];
  }, [errors, flow, llmAvailable, toolIds]);
  const nodeIssues = useMemo(() => flowNodeErrors(issues), [issues]);

  const canvasNodes = useMemo(
    () => toCanvasNodes(flow, nodeIssues, selectedId),
    [flow, nodeIssues, selectedId],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowCanvasNode>(canvasNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowCanvasEdge>(toCanvasEdges(flow));
  // Rebuild only when the DOCUMENT (or the lock state) moved — see canvasKey.
  const rebuildKey = `${locked ? 'ro' : 'rw'}\u0000${canvasKey(flow, canvasNodes)}`;
  useEffect(() => {
    setNodes(canvasNodes);
    setEdges(toCanvasEdges(flow));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebuildKey]);

  // -------------------------------------------------------------------------
  // Document writes. Every one of them is a single `onChange` with a new flow.
  // -------------------------------------------------------------------------

  /**
   * Replace ONE node through a typed updater. The updater receives the node and
   * returns a node, so a call site narrows on the type it is editing and the
   * compiler (not a cast) checks the data it writes.
   */
  const patchNode = useCallback(
    (id: string, next: (node: SkillFlowNode) => SkillFlowNode): void => {
      if (locked) return;
      const nodes = flow.nodes.map((node) => (node.id === id ? next(node) : node)) as SkillFlow['nodes'];
      // An updater that changed nothing must not push a new document: `onChange`
      // is the save path, and a no-op edit would mark the flow dirty.
      if (nodes.every((node, index) => node === flow.nodes[index])) return;
      onChange({ ...flow, nodes });
    },
    [flow, locked, onChange],
  );

  const addNode = useCallback(
    (type: SkillFlowNodeType): void => {
      if (locked) return;
      // `newFlowNode` cannot see the document, so its seed id is re-issued here:
      // `newNodeId` is the only collision-free authority (and it is stable).
      const node: SkillFlowNode = { ...newFlowNode(type, { x: 0, y: 0 }), id: newNodeId(flow) };
      setSelectedId(node.id);
      onChange({ ...flow, nodes: [...flow.nodes, node] });
    },
    [flow, locked, onChange],
  );

  const removeNode = useCallback(
    (id: string): void => {
      if (locked) return;
      setSelectedId((current) => (current === id ? null : current));
      // The node's edges go with it: an edge to a node that is not there is a
      // `dangling_edge`, which the core refuses to save.
      onChange({
        ...flow,
        nodes: flow.nodes.filter((node) => node.id !== id),
        edges: flow.edges.filter((edge) => edge.source !== id && edge.target !== id),
      });
    },
    [flow, locked, onChange],
  );

  const removeEdge = useCallback(
    (id: string): void => {
      if (locked) return;
      onChange({ ...flow, edges: flow.edges.filter((edge) => edge.id !== id) });
    },
    [flow, locked, onChange],
  );

  const renameNode = useCallback(
    (id: string, nextId: string): void => {
      if (locked || nextId === '' || nextId === id) return;
      // Every edge that names the node is rewritten in the SAME change, so a
      // rename can never leave an edge pointing at an id that no longer exists.
      onChange({
        ...flow,
        nodes: flow.nodes.map((node) => (node.id === id ? ({ ...node, id: nextId } as SkillFlowNode) : node)),
        edges: flow.edges.map((edge) => ({
          ...edge,
          source: edge.source === id ? nextId : edge.source,
          target: edge.target === id ? nextId : edge.target,
        })),
      });
    },
    [flow, locked, onChange],
  );

  const changeNodeType = useCallback(
    (id: string, type: SkillFlowNodeType): void => {
      if (locked) return;
      // The id and the position are the author's; the DATA starts again as the
      // new type's shape, because the old data does not describe the new node.
      const previous = flow.nodes.find((node) => node.id === id);
      if (previous === undefined || previous.type === type) return;
      const replacement: SkillFlowNode = { ...newFlowNode(type, previous.position), id: previous.id };
      onChange({ ...flow, nodes: flow.nodes.map((node) => (node.id === id ? replacement : node)) });
    },
    [flow, locked, onChange],
  );

  const patchEdge = useCallback(
    (id: string, patch: Partial<Pick<SkillFlowEdge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>>): void => {
      if (locked) return;
      onChange({
        ...flow,
        edges: flow.edges.map((edge) => {
          if (edge.id !== id) return edge;
          const nextEdge: SkillFlowEdge = { ...edge, ...patch };
          // A handle only means something for the port it belongs to: a 'then'
          // edge that no longer leaves a branch would be `bad_node`, and a key
          // name that no longer points at a merge would be dead weight.
          const source = flow.nodes.find((node) => node.id === nextEdge.source);
          if (patch.source !== undefined) {
            const valid =
              source?.type === 'branch' &&
              (nextEdge.sourceHandle === 'then' || nextEdge.sourceHandle === 'else');
            nextEdge.sourceHandle = valid ? nextEdge.sourceHandle : null;
          }
          const target = flow.nodes.find((node) => node.id === nextEdge.target);
          if (patch.target !== undefined && target?.type !== 'merge') nextEdge.targetHandle = null;
          return nextEdge;
        }),
      });
    },
    [flow, locked, onChange],
  );

  const addEdge = useCallback(
    (source: string, target: string): void => {
      if (locked || source === '' || target === '' || source === target) return;
      // The canvas refuses an identical connection (isValidConnection); the
      // table must not be the loophole that creates the duplicate.
      if (flow.edges.some((edge) => edge.source === source && edge.target === target)) return;
      onChange({
        ...flow,
        edges: [...flow.edges, { id: newEdgeId(flow), source, target, sourceHandle: null, targetHandle: null }],
      });
    },
    [flow, locked, onChange],
  );

  // -------------------------------------------------------------------------
  // Canvas events
  // -------------------------------------------------------------------------

  const commitDrag = useCallback(
    (_event: unknown, node: FlowCanvasNode): void => {
      if (locked) return;
      if (!flow.nodes.some((current) => current.id === node.id)) return;
      const position: FlowPosition = {
        x: Math.round(node.position.x * 10) / 10,
        y: Math.round(node.position.y * 10) / 10,
      };
      onChange({
        ...flow,
        nodes: flow.nodes.map((current) =>
          current.id === node.id ? ({ ...current, position } as SkillFlowNode) : current,
        ),
      });
    },
    [flow, locked, onChange],
  );

  const connect = useCallback(
    (connection: Connection): void => {
      if (locked) return;
      const { source, target } = connection;
      if (source === null || target === null || source === target) return;
      if (!flow.nodes.some((node) => node.id === source)) return;
      if (!flow.nodes.some((node) => node.id === target)) return;
      const sourceHandle = connection.sourceHandle ?? null;
      // A second identical connection changes nothing the document can express,
      // so it is refused rather than added as a duplicate edge.
      const exists = flow.edges.some(
        (edge) =>
          edge.source === source && edge.target === target && (edge.sourceHandle ?? null) === sourceHandle,
      );
      if (exists) return;
      onChange({
        ...flow,
        edges: [
          ...flow.edges,
          { id: newEdgeId(flow), source, target, sourceHandle, targetHandle: connection.targetHandle ?? null },
        ],
      });
    },
    [flow, locked, onChange],
  );

  /**
   * Only a self-loop and an exact duplicate are refused. A second inbound edge,
   * an edge into a source node and a cycle are all DRAWN on purpose: the core
   * names them (`bad_node`, `cycle`) and the strip shows why, which teaches more
   * than a connection that silently does nothing.
   */
  const isValidConnection = useCallback(
    (connection: Edge | Connection): boolean => {
      if (locked) return false;
      const { source, target } = connection;
      if (source === null || target === null || source === target) return false;
      return !flow.edges.some(
        (edge) =>
          edge.source === source &&
          edge.target === target &&
          (edge.sourceHandle ?? null) === (connection.sourceHandle ?? null),
      );
    },
    [flow.edges, locked],
  );

  const actions = useMemo<FlowActions>(
    () => ({ locked, removeNode, removeEdge }),
    [locked, removeNode, removeEdge],
  );

  const selected = flow.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedIssues = selected === null ? [] : (nodeIssues.get(selected.id) ?? []);
  const requestedTools = flowToolIds(flow);

  return (
    <FlowActionsContext.Provider value={actions}>
      <div className="flow">
        <div className="seg-tabs flow-tabs" role="group" aria-label="Flow view">
          <button
            type="button"
            className="btn btn-secondary seg-tab"
            aria-pressed={view === 'canvas'}
            onClick={() => setView('canvas')}
            disabled={disabled}
          >
            Canvas
          </button>
          <button
            type="button"
            className="btn btn-secondary seg-tab"
            aria-pressed={view === 'nodes'}
            onClick={() => setView('nodes')}
            disabled={disabled}
          >
            Nodes
          </button>
        </div>

        {readOnly ? null : (
          <FlowPalette entries={entries} llmAvailable={llmAvailable} disabled={disabled} onAdd={addNode} />
        )}

        {view === 'canvas' ? (
          <div className="flow-canvas" aria-label="Skill flow canvas">
            {flow.nodes.length === 0 ? (
              <FlowEmpty readOnly={readOnly} />
            ) : (
              <ReactFlow<FlowCanvasNode, FlowCanvasEdge>
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={(_event, node) => setSelectedId(node.id)}
                onNodeDragStop={commitDrag}
                onConnect={connect}
                isValidConnection={isValidConnection}
                nodesDraggable={!locked}
                nodesConnectable={!locked}
                edgesReconnectable={false}
                deleteKeyCode={null}
                fitView
                minZoom={0.2}
                maxZoom={2.5}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
                <Controls showInteractive={false} />
              </ReactFlow>
            )}
          </div>
        ) : (
          <>
            <FlowNodesTable
              flow={flow}
              nodeIssues={nodeIssues}
              toolIds={toolIds}
              locked={locked}
              readOnly={readOnly}
              onPatch={patchNode}
              onRename={renameNode}
              onChangeType={changeNodeType}
              onRemove={removeNode}
            />
            <FlowEdgesTable flow={flow} locked={locked} readOnly={readOnly} onPatch={patchEdge} onAdd={addEdge} onRemove={removeEdge} />
          </>
        )}

        <div className="flow-actions">
          {readOnly ? null : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onChange(autoArrangeFlow(flow))}
              disabled={disabled || flow.nodes.length === 0}
            >
              Auto-arrange
            </button>
          )}
          <span className="form-hint">
            {requestedTools.length === 0
              ? 'This flow requests no tools.'
              : `This flow requests ${requestedTools.join(', ')} — the install declares exactly these.`}
          </span>
          <span className="form-hint">
            {view === 'canvas'
              ? 'Drag a node to place it. Drag from a node’s right dot to another’s left dot to connect them; a branch has a “then” and an “else” dot. Nodes you have dragged keep their place; Auto-arrange only places the ones you have not moved.'
              : 'Every field here edits the same flow as the canvas — no dragging, and every control is reachable from the keyboard.'}
          </span>
          {view === 'canvas' && selected === null && flow.nodes.length > 0 ? (
            <span className="form-hint">
              Select a node to edit it — click one on the canvas, or open Nodes for a list of every
              field.
            </span>
          ) : null}
        </div>

        {view === 'canvas' && selected !== null ? (
          <div className="flow-inspector" aria-label={`Node ${selected.id}`}>
            <div className="flow-inspector-head">
              <h3 className="sub-panel-title">{`${FLOW_NODE_LABELS[selected.type]} · ${selected.id}`}</h3>
              {readOnly ? null : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => removeNode(selected.id)}
                  disabled={disabled}
                >
                  Remove node
                </button>
              )}
            </div>
            {selectedIssues.length === 0 ? null : (
              <ul className="flow-inspector-issues">
                {selectedIssues.map((issue, index) => (
                  <li key={`${issue.code}:${index}`} className="flow-issue">
                    <code className="flow-issue-code">{issue.code}</code>
                    <span>{issue.message}</span>
                  </li>
                ))}
              </ul>
            )}
            <NodeDataFields
              node={selected}
              idPrefix={`flow-${selected.id}`}
              toolIds={toolIds}
              disabled={locked}
              onPatch={(next) => patchNode(selected.id, next)}
            />
            <NodeFacts node={selected} />
          </div>
        ) : null}

        <FlowIssues issues={issues} />
      </div>
    </FlowActionsContext.Provider>
  );
}

function FlowEmpty({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  return (
    <div className="flow-empty">
      {readOnly ? (
        <>
          <p className="card-copy">This draft has no flow, so there is nothing to draw.</p>
          <p className="form-hint">
            A flow is one way to author a skill; this draft&apos;s entry is written as code, and
            code remains the artifact that installs.
          </p>
        </>
      ) : (
        <>
          <p className="card-copy">This skill has no nodes yet, so there is nothing to compile.</p>
          <p className="form-hint">
            Start with an <strong>Input</strong> node — it declares the arguments the skill is given
            — and an <strong>Output</strong> node for what it returns. Drag from the input’s right
            dot to the output’s left dot and the flow is a skill.
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Nodes view: the same document as a table, every field editable
// ---------------------------------------------------------------------------

function FlowNodesTable({
  flow,
  nodeIssues,
  toolIds,
  locked,
  readOnly,
  onPatch,
  onRename,
  onChangeType,
  onRemove,
}: {
  flow: SkillFlow;
  nodeIssues: Map<string, FlowValidationError[]>;
  toolIds: readonly string[];
  locked: boolean;
  readOnly: boolean;
  onPatch: (id: string, next: (node: SkillFlowNode) => SkillFlowNode) => void;
  onRename: (id: string, next: string) => void;
  onChangeType: (id: string, type: SkillFlowNodeType) => void;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  const ids = flow.nodes.map((node) => node.id);
  return (
    <table className="flow-table">
      <caption className="flow-table-caption">Nodes</caption>
      <thead>
        <tr>
          <th scope="col">Id</th>
          <th scope="col">Type</th>
          <th scope="col">What it does</th>
          <th scope="col">Fields</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {flow.nodes.length === 0 ? (
          <tr>
            <td colSpan={5}>
              <p className="form-hint">No nodes yet — add one from the palette.</p>
            </td>
          </tr>
        ) : null}
        {flow.nodes.map((node) => {
          const problems = nodeIssues.get(node.id) ?? [];
          return (
            <tr key={node.id} className={problems.length === 0 ? '' : 'flow-row-error'}>
              <td>
                <NodeIdField
                  node={node}
                  disabled={locked}
                  existingIds={ids.filter((id) => id !== node.id)}
                  onRename={(next) => onRename(node.id, next)}
                />
              </td>
              <td>
                <div className="flow-inspector-field">
                  <label className="label" htmlFor={`flow-type-${node.id}`}>
                    Type
                  </label>
                  <select
                    id={`flow-type-${node.id}`}
                    className="field"
                    value={node.type}
                    disabled={locked}
                    onChange={(event) => onChangeType(node.id, event.target.value as SkillFlowNodeType)}
                  >
                    {FLOW_NODE_ORDER.map((type) => (
                      <option key={type} value={type}>
                        {FLOW_NODE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </div>
              </td>
              <td>
                <p>{nodeSummary(node)}</p>
                {problems.length === 0 ? null : (
                  <ul>
                    {problems.map((issue, index) => (
                      <li key={`${issue.code}:${index}`} className="flow-issue">
                        <code className="flow-issue-code">{issue.code}</code>
                        <span>{issue.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              <td>
                <NodeDataFields
                  node={node}
                  idPrefix={`flow-row-${node.id}`}
                  toolIds={toolIds}
                  disabled={locked}
                  onPatch={(next) => onPatch(node.id, next)}
                />
              </td>
              <td>
                {readOnly ? null : (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onRemove(node.id)}
                    disabled={locked}
                    aria-label={`Remove node ${node.id}`}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The handles a connection may leave from / land on for the chosen endpoints. */
function sourceHandleOptions(flow: SkillFlow, sourceId: string): string[] {
  const source = flow.nodes.find((node) => node.id === sourceId);
  return source?.type === 'branch' ? ['then', 'else'] : [];
}

function targetHandleOptions(flow: SkillFlow, targetId: string): string[] {
  const target = flow.nodes.find((node) => node.id === targetId);
  return target?.type === 'merge' ? target.data.keys : [];
}

function FlowEdgesTable({
  flow,
  locked,
  readOnly,
  onPatch,
  onAdd,
  onRemove,
}: {
  flow: SkillFlow;
  locked: boolean;
  readOnly: boolean;
  onPatch: (
    id: string,
    patch: Partial<Pick<SkillFlowEdge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>>,
  ) => void;
  onAdd: (source: string, target: string) => void;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const canAdd = source !== '' && target !== '' && source !== target;
  return (
    <table className="flow-table">
      <caption className="flow-table-caption">Edges</caption>
      <thead>
        <tr>
          <th scope="col">From</th>
          <th scope="col">Port</th>
          <th scope="col">To</th>
          <th scope="col">Port</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {flow.edges.map((edge) => (
          <tr key={edge.id}>
            <td>
              <select
                className="field"
                value={edge.source}
                disabled={locked}
                aria-label={`Source of ${edgeLabel(edge)}`}
                onChange={(event) => onPatch(edge.id, { source: event.target.value })}
              >
                {flow.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.id}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <select
                className="field"
                value={edge.sourceHandle ?? ''}
                disabled={locked}
                aria-label={`Port of ${edgeLabel(edge)}`}
                onChange={(event) =>
                  onPatch(edge.id, { sourceHandle: event.target.value === '' ? null : event.target.value })
                }
              >
                <option value="">(the value)</option>
                {sourceHandleOptions(flow, edge.source).map((handle) => (
                  <option key={handle} value={handle}>
                    {handle}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <select
                className="field"
                value={edge.target}
                disabled={locked}
                aria-label={`Target of ${edgeLabel(edge)}`}
                onChange={(event) => onPatch(edge.id, { target: event.target.value })}
              >
                {flow.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.id}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <select
                className="field"
                value={edge.targetHandle ?? ''}
                disabled={locked}
                aria-label={`Key of ${edgeLabel(edge)}`}
                onChange={(event) =>
                  onPatch(edge.id, { targetHandle: event.target.value === '' ? null : event.target.value })
                }
              >
                <option value="">(positional)</option>
                {targetHandleOptions(flow, edge.target).map((handle) => (
                  <option key={handle} value={handle}>
                    {handle}
                  </option>
                ))}
              </select>
            </td>
            <td>
              {readOnly ? null : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onRemove(edge.id)}
                  disabled={locked}
                  aria-label={`Remove edge ${edgeLabel(edge)}`}
                >
                  Remove
                </button>
              )}
            </td>
          </tr>
        ))}
        {flow.nodes.length < 2 ? (
          <tr>
            <td colSpan={5}>
              <p className="form-hint">
                An edge needs two nodes — add another node from the palette, or draw one on the
                canvas.
              </p>
            </td>
          </tr>
        ) : (
          <tr>
            <td>
              <select
                className="field"
                value={source}
                disabled={locked}
                aria-label="New edge source"
                onChange={(event) => setSource(event.target.value)}
              >
                <option value="">Choose…</option>
                {flow.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.id}
                  </option>
                ))}
              </select>
            </td>
            <td />
            <td>
              <select
                className="field"
                value={target}
                disabled={locked}
                aria-label="New edge target"
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">Choose…</option>
                {flow.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.id}
                  </option>
                ))}
              </select>
            </td>
            <td />
            <td>
              {readOnly ? null : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onAdd(source, target)}
                  disabled={locked || !canAdd}
                >
                  Add edge
                </button>
              )}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export default SkillFlowView;
