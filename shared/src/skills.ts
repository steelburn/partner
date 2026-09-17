/**
 * M8 skill wire contracts (PLAN-M8.md).
 *
 * Skills are capability bundles: declarative manifest + one entrypoint that
 * runs in a worker and may ONLY request broker-mediated tools over IPC.
 * Installed skills are user-scoped (this core's profile). Manifest
 * permissions drive default-deny installs and the runtime ceiling.
 */
import type { ToolId, ToolRisk } from './tools.js';

export type SkillSource = 'local' | 'authored';

export type SkillStatus = 'installed' | 'disabled';

export interface SkillPermissions {
  /** Tools the skill may request (all are files.* in M8). */
  tools: ToolId[];
  /** Network capability is reserved (false in M8). */
  network: boolean;
  /** Whole-skill risk ceiling applied to every tool call. */
  risk: ToolRisk;
  /**
   * M27 S2: MCP servers whose tools this skill may call (`mcp:<server>/<tool>`
   * ids resolved at run time). Absent = none. Declaring a server is the unit of
   * consent — enabling it stays the user's default-deny act.
   */
  mcpServers?: string[];
  /**
   * M27 S5: model reach. Enables the `partner.llm.complete` worker verb; the
   * skill's own `budget.maxTokens` bounds the spend. Absent/false = no model
   * access at all, which is the only honest default.
   */
  llm?: boolean;
}

export interface SkillBudget {
  /** Worker wall-clock budget in ms (default 30s). */
  timeMs: number;
  /**
   * Token ceiling for tool-call charges (default off). M27 S5: this finally
   * has a runtime meaning — it is charged against `partner.llm.complete`
   * calls, and a skill that declares `llm` without a ceiling gets a default.
   */
  maxTokens?: number;
}

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  entrypoint: string;
  permissions: SkillPermissions;
  budget: SkillBudget;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  source: SkillSource;
  status: SkillStatus;
  sha256: string;
  installedAt: number;
  updatedAt: number;
}

export interface SkillDetail extends SkillSummary {
  manifest: SkillManifest;
}

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  permissions: SkillPermissions;
}

export interface SkillInvokeInput {
  /** Free-form JSON args for the skill (server caps size). */
  args?: unknown;
  personaId?: string;
}

export interface SkillInvocationMeta {
  id: string;
  skillId: string;
  personaId: string | null;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean;
  toolCalls: number;
  error: string | null;
  ms: number | null;
}

// ---------------------------------------------------------------------------
// M26 skill authoring (PLAN-M26.md)
//
// A draft is an INERT, editable bundle: manifest text + entry source + the
// deterministic result of validating them. Nothing in a draft runs until the
// owner asks for a dry-run, and nothing installs without an explicit,
// separately capability-checked act. Code/manifest/prompt are the owner's own
// content: they cross the loopback to the owner's UI and NEVER reach audit
// (which records ids/counts/lengths).
// ---------------------------------------------------------------------------

export type SkillDraftOrigin =
  | 'generated'
  | 'template'
  | 'manual'
  | 'chat'
  | 'fork'
  | 'edit'
  | 'import';

export type SkillDraftStatus = 'draft' | 'installed';

/** Deterministic validation result. NEVER produced by executing the draft. */
export interface SkillDraftValidation {
  ok: boolean;
  /** Manifest shape, unknown tools, missing entry, import lint, size caps. */
  errors: string[];
  /** Plain-language notes (what the declared permissions actually grant). */
  warnings: string[];
  checkedAt: number;
}

export interface SkillDraftSummary {
  id: string;
  name: string;
  description: string;
  status: SkillDraftStatus;
  origin: SkillDraftOrigin;
  /** Parsed when the manifest JSON parses; null otherwise (never invented). */
  manifest: SkillManifest | null;
  validation: SkillDraftValidation;
  /** Which model drafted it ('demo' in demo mode); no endpoint or key. */
  model: string | null;
  conversationId: string | null;
  personaId: string | null;
  /** Open install-approval row, when the persona asked for one (M26 D2b). */
  pendingInstallId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SkillDraft extends SkillDraftSummary {
  /** The editable entry source (owner's content; never audited). */
  code: string;
  /** The description the draft was generated from, verbatim (may be ''). */
  prompt: string;
  /** Raw manifest text while it does not parse. */
  manifestText: string;
  /** Set once the draft has been installed under this id. */
  installedVersion: string | null;
  /** M28: the flow document (null for a code-authored draft). */
  flow: SkillFlow | null;
  /** M28: hash of the code the flow last compiled to (null when no flow). */
  flowSha256: string | null;
  flowCompiledAt: number | null;
  /**
   * M28 D6: derived, not stored — true when `code` no longer matches what the
   * flow compiled to. A hand-edit that restores those exact bytes clears it.
   */
  flowStale: boolean;
}

/** One before → after row of a changed permission field (M26 D6 consent). */
export interface PermissionDiffEntry {
  field: 'tools' | 'mcpServers' | 'risk' | 'network' | 'llm' | 'budget.timeMs' | 'budget.maxTokens';
  before: string;
  after: string;
}

/** Outcome of promoting a draft (either install surface — M26 D2b). */
export interface SkillDraftInstallResult {
  skill: SkillSummary;
  mode: 'created' | 'updated';
  /** Before → after for a changed permission field (empty on create). */
  permissionDiff: PermissionDiffEntry[];
}

export type SkillDraftRun =
  | { ok: true; result: unknown; logs: string[]; ms: number }
  | { ok: false; error: string; logs: string[]; ms: number };

/** M26 D12: an UNSIGNED bundle — export and import move exactly these. */
export interface SkillBundle {
  version: 1;
  manifestText: string;
  code: string;
}

/** M26 create request. `generate`/`generate-flow` need a configured provider. */
export type SkillDraftCreateMode = 'manual' | 'template' | 'generate' | 'generate-flow';

export interface SkillDraftCreateInput {
  mode: SkillDraftCreateMode;
  name: string;
  description: string;
  /** The user's own words; the generation prompt is built from this. */
  prompt?: string;
  /** Template id for mode 'template' (see the template list). */
  template?: string;
  /** Optional requested slug; the core slugifies and de-duplicates it. */
  id?: string;
}

// ---------------------------------------------------------------------------
// M28 Skill Studio Flow (PLAN-M28.md)
//
// A flow is an AUTHORING surface, never a second artifact: it compiles
// deterministically to `entry.mjs`, and install always consumes that code. The
// vocabulary is deliberately not a programming language — expressions are a
// validated path grammar plus fixed operators, so an AI-written graph cannot
// emit arbitrary JavaScript.
// ---------------------------------------------------------------------------

/** A validated field path — the ONLY way a node reads upstream data. */
export type FlowPath = string;

export type FlowOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'exists';

export type FlowFieldType = 'string' | 'number' | 'boolean' | 'json';

export interface FlowFieldSpec {
  name: string;
  type: FlowFieldType;
  required: boolean;
}

export interface FlowPosition {
  x: number;
  y: number;
}

interface FlowNodeBase {
  id: string;
  position: FlowPosition;
}

/** `input` — declares the skill's args (also the Studio's test-run form). */
export interface FlowInputNode extends FlowNodeBase {
  type: 'input';
  data: { fields: FlowFieldSpec[] };
}

/** `const` — a JSON literal. */
export interface FlowConstNode extends FlowNodeBase {
  type: 'const';
  data: { value: unknown };
}

/** `tool` — one broker tool call; `args` values may be path references. */
export interface FlowToolNode extends FlowNodeBase {
  type: 'tool';
  data: { toolId: string; args: Record<string, FlowPath | unknown> };
}

/** `template` — literal text with `{{path}}` substitutions (escaped on emit). */
export interface FlowTemplateNode extends FlowNodeBase {
  type: 'template';
  data: { text: string };
}

/** `filter` — keeps items whose `path` satisfies `op` (`value` when binary). */
export interface FlowFilterNode extends FlowNodeBase {
  type: 'filter';
  data: { path: FlowPath; op: FlowOperator; value?: unknown };
}

/** `map` — projects each item to `{key: path}`. */
export interface FlowMapNode extends FlowNodeBase {
  type: 'map';
  data: { select: Record<string, FlowPath> };
}

/** `branch` — a predicate; emits one of two named outputs. */
export interface FlowBranchNode extends FlowNodeBase {
  type: 'branch';
  data: { path: FlowPath; op: FlowOperator; value?: unknown };
}

/** `merge` — combines the inputs into an object (by key) or an array. */
export interface FlowMergeNode extends FlowNodeBase {
  type: 'merge';
  data: { shape: 'object' | 'array'; keys: string[] };
}

/** `llm` — one model completion. Requires M27 S5 (`permissions.llm`). */
export interface FlowLlmNode extends FlowNodeBase {
  type: 'llm';
  data: { prompt: string };
}

/** `output` — what `run(args)` returns. */
export interface FlowOutputNode extends FlowNodeBase {
  type: 'output';
  data: { shape: 'json' | 'text' };
}

export type SkillFlowNode =
  | FlowInputNode
  | FlowConstNode
  | FlowToolNode
  | FlowTemplateNode
  | FlowFilterNode
  | FlowMapNode
  | FlowBranchNode
  | FlowMergeNode
  | FlowLlmNode
  | FlowOutputNode;

export type SkillFlowNodeType = SkillFlowNode['type'];

export interface SkillFlowEdge {
  id: string;
  source: string;
  target: string;
  /** 'then' | 'else' for a branch; null for a plain data edge. */
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface SkillFlow {
  version: 1;
  nodes: SkillFlowNode[];
  edges: SkillFlowEdge[];
}

/** Structural, per-node, so a canvas can decorate the offending node. */
export type FlowValidationCode =
  | 'cycle'
  | 'missing_input'
  | 'duplicate_input'
  | 'missing_output'
  | 'dangling_edge'
  | 'unknown_tool'
  | 'bad_path'
  | 'bad_operator'
  | 'tool_requires_medium'
  | 'llm_not_available'
  | 'unknown_node_type'
  /**
   * M28 slice A: a RECOGNISED node type whose `data` is malformed (a missing or
   * wrong-typed field, a duplicate node id, more than one inbound data edge on a
   * node that can only take one, an edge into a source node). The list above
   * names every *semantic* failure; without this one, a shape problem had no
   * code and would have had to borrow a name that means something else — which
   * is exactly the drift this vocabulary exists to prevent.
   */
  | 'bad_node';

export interface FlowValidationError {
  code: FlowValidationCode;
  nodeId: string | null;
  message: string;
}

export type SkillFlowValidation = {
  ok: true;
  flow: SkillFlow;
  warnings: FlowValidationError[];
} | {
  ok: false;
  errors: FlowValidationError[];
  warnings: FlowValidationError[];
};

export type SkillFlowCompileResult =
  | {
      ok: true;
      code: string;
      sha256: string;
      tools: string[];
      /**
       * M28 A: whether the graph uses an `llm` node. `permissions.llm` must be
       * derived from this the same way `tools` is derived from the graph —
       * otherwise a flow that compiles installs a manifest that refuses every
       * model call with `llm_not_declared`, which is a bundle that can never run.
       */
      usesLlm: boolean;
      argsForm: FlowFieldSpec[];
      warnings: FlowValidationError[];
    }
  | { ok: false; errors: FlowValidationError[]; warnings: FlowValidationError[] };

/**
 * M28 D6: the flow surface's read shape. `flowStale` is DERIVED on every read
 * (`sha256(code)` vs the hash the flow last compiled to) — it is never stored,
 * so a hand-edit that restores the compiled bytes clears it by itself.
 */
export interface SkillFlowState {
  flow: SkillFlow | null;
  flowCompiledAt: number | null;
  flowStale: boolean;
}

/**
 * `PUT /v1/skills/drafts/:id/flow` — the canvas save. A save is NOT a compile:
 * a malformed flow is refused with per-node errors (nothing is written), and a
 * valid one replaces the document without touching `code` (D1).
 */
export type SkillFlowSaveResult =
  | ({ ok: true } & SkillFlowState)
  | { ok: false; errors: FlowValidationError[]; warnings: FlowValidationError[] };

/**
 * `POST /v1/skills/drafts/:id/flow/compile` — D1's only writer of `code` from a
 * flow. On success the REWRITTEN draft rides along, because a compile is a
 * write: it replaces `code`, derives `permissions` from the graph (D5) and
 * re-runs the M26 validation; the caller must not have to guess at that state.
 * A flow that does not compile writes nothing and returns the error list.
 */
export type SkillFlowCompileResponse =
  | (Extract<SkillFlowCompileResult, { ok: true }> & { draft: SkillDraft })
  | Extract<SkillFlowCompileResult, { ok: false }>;

/** M28 D8: a refine returns a PROPOSAL — the user accepts or rejects it. */
export interface SkillFlowProposal {
  flow: SkillFlow;
  diff: {
    nodesAdded: string[];
    nodesRemoved: string[];
    nodesChanged: string[];
    edgesChanged: number;
  };
  model: string | null;
  warnings: FlowValidationError[];
}
