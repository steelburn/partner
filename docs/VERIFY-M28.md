# VERIFY-M28 — Skill Studio Flow, slices C–F (build a skill on a canvas)

Status: **implemented and locally green** (2026-09-17) · Spec: `PLAN-M28.md` ·
Index: `PLAN.md` §15 · Builds on `PLAN-M26.md` (drafts + Studio) and
`PLAN-M27.md` S5 (`partner.llm`)

This is the record for **C · D · E · F**. Slices A (the compiler) and B (the
routes, schema v22, derived staleness) landed earlier and are documented in
`PLAN-M28.md`; the review fixup that made D5's ceiling live also landed there.

Headline verification:

| Gate | Result |
|---|---|
| Root suite (`npm test` = shared + core + `tests/`) | **1724 passed**, 5 env-gated skips (was 1651) |
| Web suite (`npx vitest run --root web`) | **918 passed** (was 858) |
| Shared suite | **90 passed** |
| `npm run typecheck` (all workspaces) | **0 errors** |
| `npm run build -w web` | **green** (1.05 MB JS / 305 kB gzip — React Flow was already a dependency; **no new package**) |
| `ux_audit` (contrast + tokens + states + slop tells) | **PASSED** — see §5 |
| Demo e2e (`tests/e2e-skill-flow.test.ts`) | **green** — the whole lifecycle over a spawned core |
| Canvas frame, looked at | **yes** — §4 |

## 1. What shipped

| Slice | Deliverable | Files |
|---|---|---|
| **C** | The canvas: a React Flow graph of the ten typed nodes, a palette rail, a typed inspector, per-node error decoration, Auto-arrange, and a **Nodes table** over the same document (D9) | `web/src/SkillFlow.tsx`, `web/src/lib/flow-helpers.ts`, `web/test/flow-helpers.test.ts`, `web/test/skill-flow-view.test.tsx`, `web/src/app.css` (one appended block) |
| **C** | The tab strip becomes **Flow · Code · Validation** for a flow-backed draft, **Code · Validation** otherwise; the staleness banner with a two-step Recompile; the refine input and the Accept/Reject proposal diff; the declared-lossy from-code door (D7) | `web/src/studio/FlowPanel.tsx`, `web/src/studio/DraftEditor.tsx` |
| **D** | The four AI verbs: `mode:'generate-flow'`, `POST …/flow/refine`, `POST …/flow/from-code`, `POST …/flow/explain` — **both proposal routes write nothing** (D8) | `core/src/skills/flow/refine.ts` (pure prompts/parse/diff), `core/src/skills/flow/ai.ts` (the hook + the deterministic answers), `core/src/skills/model.ts`, `core/src/skills/drafts.ts`, `core/src/http/server.ts` |
| **E** | `skills.draft` accepts a `flow` payload **instead of** `code` — the same tool, not a third one — and the chat instructions teach the node vocabulary | `core/src/skills/tool.ts`, `core/src/skills/drafts.ts` (`stageFlowFromChat`), `core/src/chat/instructions.ts`, `core/src/skills/runtime.ts` (`flowContract`) |
| **F** | This record, the looked-at frames, the plan/README updates | `docs/VERIFY-M28.md`, `docs/m28/*.png`, `PLAN.md`, `PLAN-M28.md`, `README.md` |

## 2. The load-bearing properties, and how each is proven

- **A flow is not a second artifact.** `/compile` is the only writer of code from
  a flow; install consumes `code`. A flow authored by `generate-flow`, by chat,
  or by the canvas lands as the same `entry.mjs` + manifest, and the demo e2e
  installs it, runs it and uninstalls it
  (`tests/e2e-skill-flow.test.ts`).
- **The permission set is derived from the graph.** `permissions.tools` and
  `permissions.llm` come from the compiler for all three authoring doors
  (`/compile`, `mode:'generate-flow'`, `stageFlowFromChat`), and the manifest's
  risk tier is the **highest risk among the graph's tool nodes** — a choice
  recorded in §3, because it is what lets a `files.apply` graph compile instead
  of failing D5's own ceiling check.
- **The AI cannot inject code.** The path grammar + the eight operators are the
  only way a node reads data; `refine` and `from-code` replies go through
  `parseFlowReply` → `validateFlow`, and the emitted module is then held to the
  unmodified M26 gates. Proven in `flowSchema.test.ts` / `flowCompile.test.ts`
  (slice A) and, for the new reply paths, `flowAi.test.ts`.
- **A refine never writes.** The draft row is asserted **byte-identical** before
  and after, at both the manager level (`flowRefine.test.ts`) and over HTTP
  (`skillFlowRoutes.test.ts`). The audit row carries counts and a model name —
  never the graph, the code or the instruction.
- **The model reach works through a flow** (the M28 exit line for M27 S5):
  `llmReach.test.ts` compiles an `llm` node, installs it, and runs it — the
  prompt really arrives at the provider, the text output renders the model's
  `text`, and the manifest's `budget.maxTokens` **binds** the run
  (`budget_exceeded`, with the spend still accounted).
- **Keyboard reach without React Flow's missing edge path.** The Nodes table is
  the honest fix (D9): every field of every node is a real control, including a
  `tool` node's `args` (a key input, a Path-reference/Literal select and a value
  input).

## 3. Decisions fixed beyond the spec's letter

1. **Staleness is checked on BOTH sides of the last compile.** The spec's
   formula was `sha256(code) !== flow_sha256`. Walking the slice-D lifecycle
   found the hole: because a canvas SAVE never touches the code, a graph edited
   *after* a compile read **fresh** — the Studio would offer no Recompile, and a
   user who drew a change would install the previous graph's behaviour. A flow is
   now stale when either the code moved or the CURRENT graph does not compile to
   the recorded hash (and an uncompilable graph is stale too). Recompiling on
   read is affordable (pure, ≤200 nodes, one draft at a time) and is passed **no
   risk ceiling** — a ceiling decides whether a graph may be *installed*, never
   which bytes it emits. Asserted in `flowStale.test.ts`
   ("reads stale when the GRAPH moves after a compile").
2. **The bounded model call was extracted to `core/src/skills/model.ts`.** Four
   more calls would otherwise have meant four copies of the cap/timeout/stream
   plumbing, and M26's `generate.ts` now delegates to it (its own tests, unchanged
   in expectation, still pass). `no_model` (nothing configured → the deterministic
   answer) and `no_provider` (configured but unusable → reported) are different
   codes on purpose.
3. **The deterministic answers are honest about what they are.** With no model,
   `generate-flow` returns a pure args→template→text graph, `refine` returns the
   graph **unchanged** (inventing an edit would be a fabricated model reply),
   `from-code` returns a fixed passthrough graph declared lossy, and `explain`
   returns a walkthrough **derived** from the graph (every sentence is a fact
   about a node that exists). All report `model: 'demo'`.
4. **`llmAvailable` rides the flow read.** D9 requires the palette to omit a node
   type the build cannot compile, and only the core knows whether model reach is
   wired; `SkillFlowState` gained the boolean rather than the web guessing.
5. **`SkillDraftOrigin` gained `'flow'`.** "Generated" and "born as a flow" are
   different facts, and the Studio's tab strip is decided by exactly that
   distinction.
6. **`explain` audits nothing.** The milestone's audit vocabulary names four rows
   (save, compile, refine, fromCode); an explanation is the same graph said in
   words, so there is no state to record. Asserted (no new row).
7. **D7's tab question was resolved in favour of the tab-strip rule.** The spec
   says both "Flow · Code · Validation for a flow-backed draft and Code ·
   Validation otherwise" *and* "the Flow tab on a flow-less draft says exactly
   that". A flow-less draft therefore has **no** Flow tab; the no-decompiler
   sentence and both routes to a graph (start empty · build from code, lossy)
   live in the Code panel, so nothing is hidden behind an empty tab.
8. **`mode:'generate-flow'` is wired into the create route** (it was refused by
   name until D landed), and the refusal is still proven: a build with no flow
   model wired refuses it *by naming the flow model*, never by downgrading to
   `mode:'generate'`.

## 4. The looked-at frame (the acceptance for a visual surface)

The walk: dev core (`DEMO_MODE=1`, `DB_PATH=:memory:`, port 4391) + dev SPA on
5173 proxying to it; the page pairs through its **own** gate (the dev code is
fetched by the page, never echoed here); a flow-backed draft is seeded through
the real create route; a 7-node graph (input → tool → branch → two templates →
merge → output) is saved and compiled; the Studio is opened through the nav
(Skills → Build → the draft). Headless Chrome was driven over the DevTools
protocol by a throwaway script (`Page.captureScreenshot`), because the workspace's
managed browser is not installed and the repo has no automation dependency.

| Frame | What it shows |
|---|---|
| `docs/m28/flow-canvas.png` | The tab strip **Flow · Code · Validation** (Flow pressed), the **Canvas｜Nodes** toggle, the palette rail with all ten typed entries, and the graph drawn with React Flow — node type + summary per node, branch ports `then`/`else`, the Controls cluster. |
| `docs/m28/flow-canvas-selected.png` | The same canvas with a node selected (accent ring) and the inspector below it; the toolbar reads "This flow requests notes.read — the install declares exactly these." |
| `docs/m28/flow-nodes.png` | The **Nodes** view over the same document: Id · Type · What it does · Fields · Actions, with the `tool` node's args editor (a `Path reference` select and the value) and the branch's Field/Operator/Value controls inline — every field editable, keyboard reachable. |
| `docs/m28/flow-explain.png` | "No structural problems" with the canvas-mirror disclaimer, the Save graph / Compile to code / Explain this flow actions, the refine input, and the deterministic walkthrough (7 nodes, the tool, the branch, the merge keys). |

**Two defects the frames found and the fixes:**

1. **Every canvas node carried a full-size danger-toned Remove button** whose
   visual weight out-shouted the node's own type and summary (the primary content
   read second). Fixed in `app.css`: the control is muted at rest on the node's
   own well (`--text-muted` on `--surface-2`, Lc 81.4) and takes its own `--bg`
   ground with the `--danger` tone only on hover/focus — i.e. the M20.A rule is
   preserved (danger text never sits on a `--surface-2` well, where it measures
   Lc 69.5) rather than dropped.
2. **The Nodes table's Id column measured 88px** in the real layout (a 190px
   palette rail beside a 698px work column), which truncates an id like `decide`
   to two visible characters. Fixed with a 9rem floor on that column only; the
   frame now shows `decide` and `draft` in full.

## 5. The deterministic gate

`ux_audit` **PASSED**: Contrast (APCA) ✓ · Tokens ✓ · States ✓ · Slop tells ✓.

Sixteen explicitly-supplied pairs were checked (APCA is primary, the WCAG ratio a
sidecar), including the surface the new panel actually introduces — `--text` and
`--text-muted` on a `--surface-2` well (Lc 93.2 / 81.4 light, 91.1 / 76.7 dark),
`--danger` on its own `--bg` ground (Lc 80.9 light, 80.5 dark) and on a card
surface (75.4, the documented thin case), the primary button label (Lc 85.5),
and the 2px focus ring as a non-text graphic (Lc 74.9 ≥ 30). The one pair that
fails on purpose — `--danger` on a `--surface-2` well at Lc 69.5 — is the M20.A
trap the stylesheet deliberately avoids, so it is recorded here rather than
passed to the gate as a defect.

**Scope of that audit, stated plainly:** the gate was given the complete
**new-and-adjacent** stylesheet — the M28 Flow blocks (canvas + panel), the M26
Studio block they extend, and the primitive rules they consume (`.btn`, `.field`,
`.label`, `.form-*`, `.check`, `.seg-tabs`, `.card`) — with comments stripped, not
all 10,561 lines of `app.css`. The rest of the file is M0–M25 code that no new
selector touches, and a full-file pass would have meant emitting 234 kB of CSS
into the tool call. To cover "off-system values elsewhere" deterministically
without that, the whole file was scanned for the four slop/token tells:

- hardcoded hex/rgb outside `var()`: **none** (the only matches are inside
  comments, recording measurements);
- `backdrop-filter`, `radial-gradient`, `linear-gradient`, glow: **none**;
- `box-shadow` values: only the repo's token-coloured 2px **state rings**
  (`0 0 0 2px var(--focus|--accent|--danger)`, `inset 2px 0 0 var(--danger)`) —
  no invented elevation recipe, and `--elevation-sm` is the only named level the
  new surfaces use;
- every new interactive class declares `:focus-visible` **and** `:disabled`, and
  the one transitioned block ships a `prefers-reduced-motion` fallback.

## 6. Tests added

| File | What it pins |
|---|---|
| `core/test/skills/flowRefine.test.ts` | The prompts call `flowContract` verbatim (one vocabulary), teach no JavaScript, offer `llm` only where it exists; `parseFlowReply` accepts bare/enveloped/fenced/prose replies and refuses a non-flow; `diffFlows` counts what changed and not what only moved; **the manager half: a refine writes nothing, an unusable reply is refused with a sentence, the audit carries counts only** |
| `core/test/skills/flowAi.test.ts` | The deterministic answers validate **and compile**; a hostile description cannot reach the graph; a streamed reply is read through the schema door; a bad reply names its problem without echoing the reply; the cap and the timeout bind |
| `core/test/skills/flowStale.test.ts` | + the graph-side staleness case (an edited graph reads stale; recompiling clears it; an uncompilable graph is stale) |
| `core/test/skills/llmReach.test.ts` | + the M27 S5 path **through a flow**: the prompt reaches the provider and the manifest's token ceiling binds the run |
| `core/test/skills/drafts.test.ts` | `generate-flow` with no flow model refuses *by naming it*; with one, it creates a **compiled** flow-backed draft (`origin: 'flow'`, `flowStale: false`, derived permissions) and installs nothing |
| `core/test/skills/authoring.test.ts` | + the flow prompt is the vocabulary contract, `llm` gated by capability, and a **parsed model reply becomes an installable draft that really runs** |
| `core/test/http/skillFlowRoutes.test.ts` | + `refine`/`from-code`/`explain` 401/403/404/409; a refine proposal leaves the row byte-identical; an unusable reply answers `ok:false` writing nothing; from-code measures against the empty graph; explain audits nothing; `generate-flow` creates a compiled draft whose manifest carries `"llm": false` |
| `core/test/chat/skillAuthorTool.test.ts` | + the `flow` payload: advertised without a third tool, staged compiled with derived permissions, `flow` + `code` together refused by name, an unknown tool named for the fix loop, a re-call by id re-stages the graph; **and the same turn driven through the real chat route against a stubbed upstream** |
| `tests/e2e-skill-flow.test.ts` | The lifecycle over a spawned demo core: generate-flow → refine → save → compile → explain → dry-run → install → invoke → uninstall |
| `web/test/flow-helpers.test.ts` | Palette gating, the client-side structural mirror's codes, the unset-position rule (Auto-arrange never moves a dragged node), diff rows, id generation |
| `web/test/skill-flow-view.test.tsx` | Palette/Canvas/Nodes rendering, typed per-node editors (including the tool-args editor), error decoration, read-only |
| `web/test/skills-studio-view.test.tsx` | + the tab strip per draft kind, the from-code door's wording, and the source-level wiring of the tab to the draft kind |

## 7. What is NOT verified (and why that is stated here)

- **The live model round-trips.** No provider is configured in this workspace, so
  `generate-flow` / `refine` / `from-code` / `explain` were exercised through
  their **deterministic** answers (and, for the reply paths, with stubbed
  providers in the unit tests). A live walk needs a real endpoint + key.
- **The `llm` palette entry against a live core.** The gate is wired
  (`llmAvailable` on the flow read, asserted over HTTP as `true` in a demo build)
  and the palette behaviour is unit-tested both ways, but no screenshot shows the
  palette with `llm` present, because this build has no model reach configured
  for a *skill* run.
- **Canvas interactions by hand.** The frames are renders, not clicks: dragging a
  node, connecting an edge and the Nodes toggle were driven through the DOM
  (`click()`) where a screenshot needed them, and are otherwise asserted in the
  component tests plus source assertions. No pixel-diff or gesture replay.
- **Edge SVG in static markup.** React Flow does not render edges under
  `renderToStaticMarkup`, so "one edge per document edge" is asserted through the
  Nodes table and the pure mapper rather than the SVG — stated in the test file's
  header.
- **The packaged/desktop walk** (M10/M11 env-gated) is untouched by this
  milestone.

## 8. Residual risks / follow-ups

1. **`web/src/SkillFlow.tsx` is ~1,800 lines** (canvas + nodes table + ten typed
   editors). It is one coherent component and it is tested, but it is the largest
   file in `web/src` after `app.css`; splitting the per-type field editors into
   their own module is the obvious next refactor, not a correctness fix.
2. **A palette-added node lands at `{x: 0, y: 0}`**, which is the document's
   "unset position" sentinel (D10) — so several quick adds stack at the origin
   until dragged or Auto-arranged. Auto-arrange and the palette hint make it
   recoverable; a smarter drop point would mean inventing a second meaning for a
   position, which D10 deliberately does not have.
3. **The demo `from-code` answer is a fixed passthrough graph.** It is labelled
   lossy and demo-authored everywhere it surfaces, but it is not a reading of the
   code — there is no decompiler (D7) and no model in this build.
4. **`explain` has no audit row** by decision (§3.6); if a later milestone wants
   one, the vocabulary in `PLAN-M28.md` has to grow first.
5. **The staleness read compiles the stored graph.** Bounded and cheap at the
   documented caps (200 nodes, one draft at a time), but it is work on a GET; if
   a future surface ever lists flows in bulk, that is where to look first.
