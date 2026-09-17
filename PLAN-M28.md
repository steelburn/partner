# M28 — Skill Studio Flow: build a skill on a canvas, with the model as a collaborator

Status: **implemented (C–F landed 2026-09-17; A + B earlier)** — see *State* at the
bottom · verification record: `docs/VERIFY-M28.md` ·
Companion to `PLAN.md` §9, §15 (index) ·
Builds on: `PLAN-M26.md` (drafts + Studio) · Uses: `PLAN-M27.md` S5
(`partner.llm`) for its `llm` node · Reuses: `@xyflow/react` ^12.11.6 (already a
web dependency, used by `NotesGraph.tsx`) and `web/src/lib/graph-layout.ts`.

## Goal

M26 gives a skill draft three surfaces: **Code**, **Validation**, and a dry-run.
M28 adds a fourth — **Flow** — a React Flow canvas where a skill is a graph of
typed nodes, and where the model can build the graph, the user can draw it, and
the model can refine what the user drew.

Three properties fix what "Flow" means here, and all three are constraints
rather than features:

1. **A flow is not a second kind of skill.** It **compiles deterministically to
   `entry.mjs`** — the same single artifact M8 installs, the same sandbox runs,
   the same hash is verified. There is no flow interpreter, no `flow.json` at
   install time, and nothing new for the runner to trust. The Flow tab is an
   authoring *view*; **Code is the artifact.**
2. **The vocabulary is small and typed, and the compiler is total.** Ten node
   types, JSON-schema'd per type, no loops, no arbitrary expressions, no
   imports. Every flow either compiles or reports a named structural error; the
   compiler has no "emit whatever the user typed" path.
3. **An AI-built graph is untrusted input that becomes code.** So the compiler
   is the security boundary: identifier generation, field-path grammar and
   template escaping are all validated, and generated code is then held to the
   *unmodified* M26 gates (`lintEntry`, `validateManifestShape`, the dry-run,
   the owner's install).

**Why a graph is the better AI surface, not just a nicer one.** A model writing
free-form JavaScript has unbounded failure modes; a model filling a typed
10-node vocabulary has a small, checkable one. Two consequences fall out for
free: the declared `permissions.tools` is **derived from the graph's `tool`
nodes**, so the install summary provably matches the code; and the emitted code
has a predictable shape (one linear `const` chain in one `run()`), so it is
reviewable by someone who does not want to read arbitrary JS.

## The one thing a valuable flow needs, and where it lives

A skill **cannot call a model today** — the worker's `partner` global is `log`
and `tools.exec`, nothing else (verified in `worker-runner.mjs`). The most
useful skills people ask for are model-shaped ("turn my scratch notes into a
checklist"), so the `llm` node is what makes Flow worth building — and it is a
**reach** decision, not an authoring one. It ships in `PLAN-M27.md` **S5**
(`permissions.llm` + `partner.llm.complete` + the skill's own `budget.maxTokens`
ceiling, declared since M8 and finally enforced + a ledger charge).

So M28 has a declared dependency and a declared fallback:

| | With M27 S5 | Without M27 S5 |
|---|---|---|
| Node palette | 10 types incl. `llm` | 9 types; the palette omits `llm` (D9's "only offer what exists" rule, reused) |
| Flow usefulness | model-shaped skills are expressible | data-and-tools only: read → filter → map → template → return |

## Decisions

| # | Decision | Consequence accepted |
|---|---|---|
| D1 | **The flow compiles to `entry.mjs`; install always consumes `code`** (goal 1). `POST /drafts/:id/flow/compile` is the only writer of code from a flow, and it is deterministic (same flow → byte-identical code + hash, asserted). | One artifact, one sandbox, one trust path, and the M26 install/consent/permission-diff machinery needs no change. There is no way to install a flow that does not compile. |
| D2 | **Ten node types, and no general-purpose language:** `input` · `const` · `tool` · `template` · `filter` · `map` · `branch` · `merge` · `llm` · `output`. | "Filter rows where `status != done`" is expressible; "loop with a mutable accumulator and a regex callback" is not. That is the deliberate ceiling — it is what makes the compiler total and the AI path reliable. Compilation is sequential `await`s only. |
| D3 | **Expressions are a validated path grammar plus fixed operators — never emitted text.** A field path is matched against `^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$` and compiled to an optional-chained accessor; predicates are `eq/neq/gt/gte/lt/lte/contains/exists`; templates substitute `{{path}}` into an escaped template literal. | `__proto__`, `constructor`, `a); process.exit(1);//` and a backtick/`${` in literal text are all refused or escaped, with tests. An AI-written graph cannot inject code, which is the whole reason the compiler is allowed to generate any. |
| D4 | **The compiler is total and deterministic.** Topological order is sorted by `(rank, nodeId)` rather than edge-iteration order; cycles are a validation error *before* emission; every node type has an emitter. | The same flow always produces the same bytes — which is what makes D6's staleness check derivable and the compile auditable (a hash, not a blob). |
| D5 | **`permissions.tools` is derived from the graph.** A `tool` node can only pick an id from the broker registry (files.* plus M27's app tools), and compile writes the union of the graph's tool nodes into the manifest. | The permission summary cannot drift from the code. A manifest that declares a tool the graph does not use is a validation **warning** (an unused permission is a smell, not an error). |
| D6 | **Flow/code coherence is derived, not flagged.** The draft stores `flow_json` + `flow_sha256` (the hash of the code the flow last compiled to). The Studio computes `flow_stale` from **both sides** of that comparison: the code no longer hashing to the recorded value, **or** the CURRENT graph no longer compiling to it. *(Slice C/D strengthened the second side: because a canvas SAVE never touches `code`, the one-sided formula left an edited graph reading fresh — the Studio offered no Recompile and an install shipped the previous graph's behaviour. `docs/VERIFY-M28.md` §3.1.)* | A hand-edit that *restores* the compiled bytes clears staleness by itself, and there is no boolean to get out of sync. A stale flow is a **UI honesty** state, never a security one: install re-validates and runs the code, which is what installs. |
| D7 | **No decompiler.** A code-authored draft has no flow. Offering "generate a flow from the code" is an *AI-assisted, lossy, declared* action, never a deterministic promise. | No fragile JS parser, no silent misreading of hand-written code. The Flow tab on a flow-less draft says exactly that and offers the lossy route by name. |
| D8 | **AI refine is a proposal, never a write.** `POST /drafts/:id/flow/refine {instruction}` returns `{flow, diff}`; the Studio renders an accept/reject diff (nodes and edges added/removed/changed) and only Accept PUTs the flow. | The model cannot restructure the user's graph behind their back. Audited as counts (`nodesAdded`, `nodesRemoved`, `edgesChanged`) — never the flow body or the instruction text. |
| D9 | **Canvas-only is not acceptable.** The Flow tab has two equivalent views — **Canvas** and **Nodes** (a table of the same graph, every field editable, keyboard-navigable) — and they are the same document. The palette omits a node type whose capability is not wired. | React Flow has no keyboard path to creating an edge; a list view is the honest fix rather than a claim. And `llm` cannot appear in a palette whose compile would fail. |
| D10 | **Node positions live in the flow document** (not a side table like `note_graph`), and Auto-arrange reuses `web/src/lib/graph-layout.ts` for unset positions only — user-dragged nodes are never moved. | One source of truth for the graph, one fewer table, and the existing layout helper (pure, already tested) stays the only layout code in the repo. |

## Contracts (`shared/src/skills.ts`)

```ts
export type SkillFlowNodeType =
  | 'input' | 'const' | 'tool' | 'template' | 'filter'
  | 'map' | 'branch' | 'merge' | 'llm' | 'output';

/** A validated field path — the ONLY way a node reads upstream data (D3). */
export type FlowPath = string; // ^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$
export type FlowOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists';

export interface FlowFieldSpec { name: string; type: 'string' | 'number' | 'boolean' | 'json'; required: boolean }

interface FlowNodeBase { id: string; position: { x: number; y: number } }

export type SkillFlowNode =
  | (FlowNodeBase & { type: 'input';    data: { fields: FlowFieldSpec[] } })
  | (FlowNodeBase & { type: 'const';    data: { value: unknown } })
  | (FlowNodeBase & { type: 'tool';     data: { toolId: string; args: Record<string, FlowPath | unknown> } })
  | (FlowNodeBase & { type: 'template'; data: { text: string } })                 // {{path}} placeholders
  | (FlowNodeBase & { type: 'filter';   data: { path: FlowPath; op: FlowOperator; value?: unknown } })
  | (FlowNodeBase & { type: 'map';      data: { select: Record<string, FlowPath> } })
  | (FlowNodeBase & { type: 'branch';   data: { path: FlowPath; op: FlowOperator; value?: unknown } })
  | (FlowNodeBase & { type: 'merge';    data: { shape: 'object' | 'array'; keys: string[] } })
  | (FlowNodeBase & { type: 'llm';      data: { prompt: string } })               // requires M27 S5
  | (FlowNodeBase & { type: 'output';   data: { shape: 'json' | 'text' } });

export interface SkillFlowEdge {
  id: string; source: string; target: string;
  /** 'then' | 'else' for a branch; named ports elsewhere. */
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface SkillFlow { version: 1; nodes: SkillFlowNode[]; edges: SkillFlowEdge[] }

/** Compile output (D1/D4). `sha256` is what D6 compares against the draft code. */
export interface SkillFlowCompileResult {
  ok: true; code: string; sha256: string; tools: string[]; argsForm: FlowFieldSpec[];
} | { ok: false; errors: FlowValidationError[]; warnings: FlowValidationError[] };

/** Structural, per-node, so the canvas can decorate the offender (not just list it). */
export interface FlowValidationError {
  code: 'cycle' | 'missing_input' | 'dangling_edge' | 'unknown_tool'
      | 'bad_path' | 'bad_operator' | 'missing_output' | 'duplicate_input'
      | 'tool_requires_medium' | 'llm_not_available' | 'unknown_node_type';
  nodeId: string | null;
  message: string;
}

/** D8: a refine returns a proposal the user accepts or rejects. */
export interface SkillFlowProposal {
  flow: SkillFlow;
  diff: { nodesAdded: string[]; nodesRemoved: string[]; nodesChanged: string[]; edgesChanged: number };
  model: string | null;
}
```

Schema v21 → **v22** (additive, `ensureColumn` — the v12/v20/v21 pattern; landed
with slice B), three columns on `skill_drafts`:

```sql
ALTER TABLE skill_drafts ADD COLUMN flow_json TEXT;        -- SkillFlow | NULL
ALTER TABLE skill_drafts ADD COLUMN flow_sha256 TEXT;      -- code hash the flow last compiled to
ALTER TABLE skill_drafts ADD COLUMN flow_compiled_at INTEGER;
```

No new table (D10) and no new column on `skills`: an installed skill is still
just code + manifest.

## Core API (added to M26's drafts surface)

| Route | Capability | Notes |
|---|---|---|
| `GET /v1/skills/drafts/:id/flow` | — | **Landed (B).** The flow, the derived `flowStale`, and `flowCompiledAt`. |
| `PUT /v1/skills/drafts/:id/flow` | `skill.author` | **Landed (B).** Replace the flow (the canvas save). Validates structurally; **does not** touch `code` (a save is not a compile). |
| `POST /v1/skills/drafts/:id/flow/compile` | `skill.author` | **Landed (B).** D1: emit `code`, write `flow_sha256` + `flow_compiled_at`, derive `permissions.tools` **and** `permissions.llm` (D5), re-run the M26 validation. Returns `{ok, code, sha256, tools, usesLlm, argsForm, warnings, draft}` or `{ok:false, errors, warnings}` having written nothing. |
| `POST /v1/skills/drafts/:id/flow/refine` | `skill.author` | **Landed (C/D).** D8: `{instruction}` → `SkillFlowProposal`. **Writes nothing** (the draft row is byte-identical after it); an unusable reply answers 200 `ok:false` with a sentence, plus the named per-node errors when the reply was a flow. |
| `POST /v1/skills/drafts/:id/flow/from-code` | `skill.author` | **Landed (C/D).** D7's declared-lossy conversion: the model proposes a flow that reproduces the code's intent, returned as a proposal (never auto-applied), diffed against the draft's current graph (the empty graph when it has none). |
| `POST /v1/skills/drafts/:id/flow/explain` | `skill.author` | **Landed (C/D).** A plain-language walkthrough for the UI. Returns text to the owner only, writes nothing and audits nothing. |
| `POST /v1/skills/drafts {mode:'generate-flow', description}` | `skill.author` | **Landed (C/D).** M26's create route gained the mode: the model returns a **flow** (not code), which the core validates, compiles, and turns into a manifest whose permissions are derived from the graph (`origin: 'flow'`). A build with no flow model wired refuses it **by naming the flow model**, never by downgrading to `mode:'generate'`. |

Audit (counts/ids only — never the flow body, the code, or the instruction):

```
skill.flow.save     {nodes, edges, stale: boolean}
skill.flow.compile  {ok, nodes, edges, tools, errorCount, codeBytes}
skill.flow.refine   {ok, nodesAdded, nodesRemoved, nodesChanged, edgesChanged, model}
skill.flow.fromCode {ok, nodes, edges, model}
```

## Implementation

- **`core/src/skills/flow/schema.ts`** (new, pure) — the node/edge types as
  runtime validators (`validateFlow(raw) → {flow} | {errors}`), the path grammar
  and operator whitelist (D3). Mirrors the TS union above; a mismatch is a test.
- **`core/src/skills/flow/compile.ts`** (new, pure) — `compileFlow(flow, {registry})
  → SkillFlowCompileResult`: structural checks, deterministic topological order
  (D4), per-node emitters, identifier generation, tool collection (D5), and the
  `argsForm` the Studio's test-run uses. Emits no imports (so `lintEntry`
  passes by construction) and nothing but declared tool ids.
- **`core/src/skills/flow/refine.ts`** (new) — `buildRefinePrompt({flow,
  instruction, registry})` + `parseFlowReply(text)` (the fence-strip/first-`{`
  discipline M26's authoring parser already establishes) + `diffFlows(a, b)`
  (pure, so the diff card is testable without a UI).
- **`core/src/skills/drafts.ts`** — flow get/save/compile/refine/from-code on the
  draft manager; `flowStale` derived (D6); `generate-flow` folded into create.
- **`core/src/skills/runtime.ts`** — the node vocabulary joins the shared reach
  vocabulary, so the authoring prompt, the chat instructions, the Studio palette
  and the docs describe one thing.
- **`core/src/skills/tool.ts`** — `skills.draft` accepts a `flow` payload
  instead of `code` (same tool, no third authoring tool): a persona can build a
  flow from chat, and the Studio opens it on the canvas.
- **`web/src/SkillFlow.tsx`** (new) — the React Flow canvas: `nodeTypes` per
  node type, handles left/right like `NotesGraph.tsx`, `Controls` +
  `Background` (no new visual language), a palette rail, an inspector panel, a
  validation strip that decorates offending nodes, Auto-arrange via
  `lib/graph-layout.ts`, and a Canvas/Nodes toggle (D9).
- **`web/src/lib/flow-helpers.ts`** (new, pure) — node labels, palette
  availability (capability-gated), a client-side structural mirror for instant
  feedback, the diff summary rows, `argsForm → test-run args` seeding, and the
  layout adapter. All node-only testable, matching the web suite's constraints.
- **`web/src/SkillStudio.tsx`** — the tab strip becomes **Flow · Code ·
  Validation** for a flow-backed draft and **Code · Validation** otherwise, plus
  the staleness banner ("the code changed since this flow was compiled —
  Recompile (overwrites code) · Keep code (the flow becomes a sketch)"), the
  refine input, and the proposal diff with Accept/Reject.

Styling is token-only: `.flow-node`, `.flow-node-error`, `.flow-handle`,
`.flow-palette`, `.flow-inspector`, `.flow-tabs` built from the existing
`--surface-*`, `--accent`, one named elevation and `--target-min`; no new shadow
recipe, no new colour, and the canvas keeps the existing `.n-graph-*` visual
grammar rather than inventing a second one.

## Tests

Core
- `core/test/skills/flowSchema.test.ts` — every node type round-trips; an
  unknown type, a missing field and a wrong-typed field are named errors; the
  path grammar accepts `a.b[0].c` and refuses `__proto__`, `constructor`,
  `a);x//`, `a[` and `a..b`; operators are whitelisted.
- `core/test/skills/flowCompile.test.ts` — every node type emits runnable code;
  **determinism** (same flow → byte-identical code and hash, and a shuffled
  edge/node array order does not change the output); a cycle is a `cycle` error
  and nothing is emitted; a dangling edge, a missing `output` and a duplicate
  `input` are named errors; an unknown tool id is `unknown_tool`; the emitted
  code passes `lintEntry`; **`permissions.tools` equals exactly the graph's
  `tool` node ids** (D5, asserted both ways — no unused declaration, no
  undeclared use); template escaping survives a literal backtick, `${` and a
  quote; a `tool` node with an injected path cannot escape the accessor (D3).
- `core/test/skills/flowRun.test.ts` — compile → materialize → dry-run in the
  real sandbox → the result matches the graph's intent; a `tool` node without a
  grant → `tool_denied`; a graph that compiles but throws at run time returns
  the coded error **with the worker's log lines** (M26 D5's seam, reused).
- `core/test/skills/flowRefine.test.ts` — refine returns a proposal and writes
  nothing (draft row byte-identical before/after); `diffFlows` reports
  added/removed/changed node ids and an edge-changed count; a refine reply that
  is not a valid flow is refused with errors and no partial write; the audit row
  carries counts and never the flow body or instruction.
- `core/test/skills/flowStale.test.ts` **(landed, B)** — a flow-backed draft
  compiles, then a hand-edit of `code` marks `flowStale`; restoring the compiled
  bytes clears it (D6); install works from a **stale** draft because install
  consumes `code` (asserted explicitly, so nobody later "helpfully" blocks it).
  B added to the same file: a save does not touch the code, a never-compiled
  flow reads stale, a malformed save writes nothing, and a compile derives
  `permissions.tools` AND `permissions.llm`. The review fixup added D5's
  ceiling in the same file: a `files.edit` (medium) node under the `low`
  starter manifest fails `tool_requires_medium` and writes nothing, and the
  SAME graph compiles once the manifest declares `medium`.
- `core/test/http/skillFlowRoutes.test.ts` **(get/put/compile landed, B)** —
  401/404/409-on-installed/501; `skill.author` enforced; mobile and extension
  classes refused; a PUT does not touch `code`; a compile rewrites
  `permissions.tools` and `permissions.llm`; a stale draft installs AND runs.
  *D landed:* `refine` / `from-code` / `explain` and `generate-flow` (the create
  route's deterministic generator when no model is configured) are covered here,
  including that a proposal leaves the draft row byte-identical and that an
  unusable reply answers `ok:false` writing nothing. The refusal of
  `mode:'generate-flow'` when no flow model is wired is asserted in
  `core/test/skills/drafts.test.ts` (it names the FLOW model, never downgrading to
  `mode:'generate'`).
- `core/test/skills/authoring.test.ts` (extend) — the authoring prompt teaches
  the node vocabulary **and not JavaScript**; it lists exactly the available
  node types (no `llm` when M27 S5 is absent) and the registry's tool ids; a
  model reply containing a valid flow is parsed and compiled into an installable
  draft.

Web
- `web/test/flow-helpers.test.ts` — palette gating (`llm` absent without the
  capability); client-side structural validation agrees with the core's codes
  for the shared cases; diff summary rows; args-form seeding; the layout
  adapter leaves dragged nodes alone (the unset-only rule already asserted in
  `web/test/m16-lib.test.ts`).
- `web/test/skill-flow-view.test.tsx` — tab strip per draft kind; the staleness
  banner and its two-step Recompile arming; the proposal diff Accept/Reject
  (Reject leaves the flow untouched); the Nodes table view edits the same
  document as the canvas; error decoration on the offending node.
- `web/test/skills-studio-view.test.tsx` (extend) — Flow · Code · Validation
  ordering, the deep link opening a flow-backed draft on the canvas.

E2E (demo core)
- `core/test/e2e/skillFlow.test.ts` — **built as `tests/e2e-skill-flow.test.ts`**,
  the repo's actual home for spawned-core e2e: create with `mode:'generate-flow'`
  → refine → save → compile → `flowStale` false → dry-run → install → invoke →
  uninstall. (The malformed-reply half of this sketch cannot be driven from a
  demo core — the demo generator has no malformed mode — so it is asserted where
  it IS deterministic: `flowAi.test.ts` with a stubbed provider, and the
  manager's second validation in `flowRefine.test.ts`.)
- `core/test/e2e/skillFlowChat.test.ts` — **built as a route-level test in
  `core/test/chat/skillAuthorTool.test.ts`**: a real chat turn against a stubbed
  upstream whose native tool call carries a `flow`; the draft lands flow-backed
  and compiled, the conversation keeps the note the Studio's deep link is built
  from, and nothing installs. A second spawned core would need a fake provider
  over HTTP to test the same thing.

Docs
- `docs/VERIFY-M28.md`; a rendered canvas screenshot recorded in the verify doc
  (the Studio is a **visual** surface, so a passing `ux_audit` on the new CSS is
  the floor, not the evidence — the acceptance is a looked-at frame).

## Exit criteria

- [x] Schema v22 additive (a v21 DB opens unchanged) with `flow_json`,
      `flow_sha256`, `flow_compiled_at` (slice B, 2026-09-17): the guarded
      `ensureColumn` pattern, with `core/test/stores/db-migrate.test.ts` dropping
      the three columns and re-opening to prove a v21 row survives untouched.
- [x] **The compiler is total and deterministic** (slice A, 2026-09-17): every
      node type, cycle/dangling/missing-output/duplicate-input/unknown-tool named
      errors, byte-identical output for one flow (asserted against shuffled
      `nodes`/`edges` arrays), and the emitted code passes the unmodified M26
      `lintEntry`. *The "and installs" half lands with B; `flowRun.test.ts`
      already runs the compiled module in the real sandbox.*
- [x] **D3's boundary is proven** (slice A): path grammar, operator whitelist and
      template escaping refuse injection with tests, so an AI-written graph
      cannot emit arbitrary JS — and `__proto__`/`constructor` are refused as
      path segments on top of the grammar, because they are a prototype reach
      even though the grammar allows them.
- [x] **`permissions.tools` is derived from the graph** and asserted equal to
      the graph's `tool` node ids, de-duplicated and sorted — including the empty
      case (no tool node => no declared tool). Slice A also derives `usesLlm`,
      which the spec did not call for: without it a flow with an `llm` node
      installs a manifest that refuses every model call. **Slice B writes BOTH
      into the manifest** (`/flow/compile`), so the installed summary provably
      matches the emitted code, and the wiring is asserted over HTTP.
- [x] Flow/code staleness is derived from the hash (D6) — `sha256(code) !==
      flow_sha256`, computed on every read and never stored, so a hand-edit that
      restores the compiled bytes clears it by itself — and install from a stale
      draft is allowed and documented (install consumes code). Slice B asserts
      the stale install **and the stale RUN**, so a later "helpful" block fails
      a test instead of silently redefining install.
- [x] AI paths (slice D): `generate-flow` produces a compiling draft;
      `refine` returns a proposal that writes nothing until accepted;
      `from-code` is offered as explicitly lossy; audits carry counts only.
      *Both proposal routes are asserted byte-identical-no-write at the manager
      level AND over HTTP; the deterministic (no-provider) answers are honest
      about what they are — see `docs/VERIFY-M28.md` §3.3.*
- [x] `llm` appears in the palette **only** when M27 S5 is wired, and the
      `skill.llm`/token-ceiling path is exercised through a flow end to end.
      *The palette gate is `llmAvailable` on the flow read (asserted over the
      wire) plus `paletteFor`; the reach is a compiled `llm` node that really
      reaches a provider and is bounded by the manifest ceiling
      (`llmReach.test.ts`). A LIVE walk needs a real endpoint — §7 of the record.*
- [x] Canvas **and** Nodes views edit one document; both are keyboard-reachable;
      `ux_audit` PASSED on the new token-only styles and a canvas frame reviewed
      by eye. *The Nodes table edits every field, including a `tool` node's
      `args`; the frames are in `docs/m28/` and the two defects they found are
      recorded in `docs/VERIFY-M28.md` §4.*
- [x] Suites root + Δ, web + Δ, shared + Δ, zero regressions; typechecks 0; web
      build green (React Flow is already a dependency — **no new package**);
      both demo e2e flows green. *Root **1724** (5 env-gated skips) · shared
      **90** · web **918** · typechecks 0 · web build green. The flow lifecycle
      e2e is `tests/e2e-skill-flow.test.ts`; the chat half runs through the real
      chat route against a stubbed upstream in
      `core/test/chat/skillAuthorTool.test.ts` — this repo has no
      `core/test/e2e/` directory, and a second spawned core would add nothing
      that test does not already cover.*

**Slices A + B landed 2026-09-17** (`core/src/skills/flow/schema.ts` +
`flow/compile.ts`, both pure — no fs, db or routes — plus the flow lifecycle in
`core/src/skills/drafts.ts`). What is true now:
`validateFlow(raw)` is the runtime door (the shared TS union cannot check a value
that arrived as JSON), `compileFlow(flow, {registry, llmAvailable?, riskCeiling?,
riskOf?})` returns `{code, sha256, tools, usesLlm, argsForm, warnings}` or a named
error list, and the emitted module is EXECUTED in tests — against a fake `partner`
and, in `flowRun.test.ts`, inside the real M8 sandbox. Determinism is asserted by
shuffling the `nodes`/`edges` arrays, not by calling twice. Two documented
extensions to the spec's letter: `FlowValidationCode` gained `bad_node` (a
recognised node type with malformed `data` had no code of its own), and the
result gained `usesLlm` because `permissions.tools` alone leaves an `llm` flow
installing a manifest that refuses every model call. Semantics fixed here: a
node's scope is its single inbound value (else `args`); **a node whose scope is
`undefined` does nothing**, which is what gives `branch` meaning under D2's
sequential-await ceiling; `filter`/`map` paths are item-relative; an object `merge`
binds each input's key by `targetHandle` (positional fallback), and `output text`
renders a value carrying a `.text` string (an `llm` result) as that text.

**Slice B landed 2026-09-17** — schema **v22** (three additive columns on
`skill_drafts` via the v12/v20/v21 guarded `ensureColumn` pattern, so a v21 DB
opens unchanged and pre-v22 rows read `NULL` = "no flow") plus the three routes
under the existing M26 drafts surface: `GET|PUT /v1/skills/drafts/:id/flow` and
`POST /v1/skills/drafts/:id/flow/compile`. The lifecycle lives in
`core/src/skills/drafts.ts` (`getFlow` / `saveFlow` / `compileFlow`) so the HTTP
surface stays a translator. Decisions fixed here, beyond the spec's letter:

- **A save is not a compile.** `PUT` validates the graph with slice A's
  `validateFlow` (a malformed body is 400 `invalid_input` with every offender in
  `flowErrors`, and nothing is written) and then touches NOTHING but the flow:
  `code`, `manifest_text` and therefore the derived permissions are untouched.
  A half-drawn graph still saves — structural shape, not compilability, is the
  save's bar.
- **`flowStale` is derived on every read** (`sha256(code) !== flow_sha256`) and
  is never stored. Two edges are deliberately chosen: a draft with NO flow is
  never stale, and **a flow that has never compiled IS stale**, because its code
  cannot be that flow's output — which is what makes the Studio offer Recompile
  on a freshly drawn graph.
- **`/compile` is the only writer of code from a flow**, and it writes the code,
  `flow_sha256` and `flow_compiled_at` together, rewrites the manifest's derived
  permissions from the graph (**`tools` AND `llm`** — a graph with no `llm` node
  writes `llm: false`, so an earlier compile cannot leave model reach behind),
  then re-runs the M26 validation. A flow that does not compile answers **200
  with `ok:false` and the named error list and writes nothing**, matching the
  `/validate` convention (the request succeeded in determining the answer).
- **The compile response carries the rewritten draft** (`{ok, code, sha256,
  tools, usesLlm, argsForm, warnings, draft}`): a compile IS a write, so the
  caller must not have to guess at the new `code`, permissions and validation.
  A `PUT` answers with the flow state. Three shared wire types were added for
  this (`SkillFlowState`, `SkillFlowSaveResult`, `SkillFlowCompileResponse`) —
  the spec named the fields but no shapes.
- **`PUT` accepts the bare flow document, and `{flow: …}` too** — the body IS
  the representation at that URL, but every other draft write is a named-field
  object, and a one-line tolerant reader costs nothing.
- **Audit carries counts and ids only**: `skill.flow.save {nodes, edges, stale}`
  and `skill.flow.compile {ok, nodes, edges, tools, errorCount, codeBytes}` —
  never the graph, the code or the manifest text (asserted).
- **No web helper was added**: slice B has no web consumer yet (the canvas is
  slice C), and an unused API client would be scaffolding.

**The Studio split also landed** (owner decision: before slices C/D, so the canvas
does not inherit a 2000-line file): `web/src/SkillStudio.tsx` is now a 468-line
container, with rail / empty state / editor / validation / run / install+confirm /
actions in `web/src/studio/*`, re-exported from the original module so no importer
or test moved. No CSS changed.

**Review fixup (2026-09-17, no version bump).** Independent review found that
D5's ceiling was dead on the only path that matters: `compileFlow` in
`core/src/skills/drafts.ts` called the compiler with `{registry, llmAvailable}`
and never supplied `riskCeiling`/`riskOf`, so a `low` manifest whose graph
held a `files.edit` node compiled silently, wrote
`permissions.tools:['files.edit']`, re-validated ok and INSTALLED — a bundle
guaranteed to refuse the moment a run reached that node (the same class
`llm_not_available` exists to prevent). The draft manager now takes the
registry's risks (`riskOf`, a REQUIRED option so it cannot go dead again) and
the compile path parses the manifest BEFORE compiling, passing the manifest's own
tier as `riskCeiling`; the same compile also covers `mode:'generate-flow'`
(above). Test counts: root **1651** (5 env-gated skips) · shared **90** · web
**858** · typechecks 0 · web build green.

*State:* **A–F landed; nothing outstanding.** Depends on M26 A+B (drafts, Studio,
dry-run) and on **M27 S5** for the `llm` node — which landed, so the vocabulary
is the full ten types. Slices: **A** flow schema + compiler (pure, no UI) ·
**B** draft routes + staleness (schema v22) · **C** canvas + nodes table +
palette/inspector (`web/src/SkillFlow.tsx`, `web/src/lib/flow-helpers.ts`, the
Flow tab in `web/src/studio/*`) · **D** AI build/refine/from-code + proposal diff
(`core/src/skills/flow/refine.ts` pure, `flow/ai.ts` for the model seam,
`core/src/skills/model.ts` for the one bounded call, the three routes) ·
**E** chat `flow` payload (`skills.draft`, the same tool) · **F** docs/verify.
A hook may author a flow end to end today: `generate-flow` → refine (proposal) →
save → compile → dry-run → install → invoke, over HTTP or from the canvas.
The verification record — including what is NOT verified (a live model walk) — is
`docs/VERIFY-M28.md`.

**Slices C–F landed 2026-09-17.** The canvas is `web/src/SkillFlow.tsx` (React
Flow; the ten node types register under prefixed React Flow ids because
`input`/`output`/`default`/`group` are reserved by the library, while the
DOCUMENT keeps D2's spelling), and every edit flows through one `onChange` so the
panel around it owns the writes. Decisions fixed during C–F, all recorded in the
verification doc: staleness checks **both** sides of the last compile (an edited
graph used to read fresh); the bounded model call was extracted to
`core/src/skills/model.ts` so five callers share one cap and one timeout;
`SkillDraftOrigin` gained `'flow'`; `llmAvailable` rides the flow read so the
palette can omit what the build cannot compile; `explain` audits nothing; and
the spec's two statements about the Flow tab on a flow-less draft were resolved
in favour of the tab-strip rule (the no-decompiler sentence and both routes to a
graph live in the Code panel). Two defects were found by LOOKING at the rendered
canvas — a full-size danger-toned Remove button on every node, and an 88px Id
column in the Nodes table — and both are fixed and re-framed.

## Out of scope

- **General-purpose visual programming**: loops, mutable accumulators, arbitrary
  expressions or user-authored JS fragments, sub-flows/functions, and any node
  that emits raw code. The vocabulary is the point.
- **A flow decompiler** (D7) — `from-code` is model-assisted and declared lossy.
- **A second runtime**: no flow interpreter, no `flow.json` shipped or trusted,
  no change to what the sandbox loads.
- Multi-flow drafts, flow libraries/snippets, sharing or exporting flows (M26's
  bundle export moves the *code*, not the flow), and flow-level versioning.
- Streaming tokens out of an `llm` node; multiple providers/models per node.
- Node types for anything M27 does not wire (no `http`, `shell`, `email`,
  `deploy` nodes) — the palette is a list of capabilities, not a wish list.
