# UNFINISHED — the review list for the next session

Date: 2026-09-17 (updated at `v0.1.19`) · Index: `PLAN.md` §15 · Specs:
`PLAN-M27.md`, `PLAN-M28.md` · Records: `docs/VERIFY-M26.md`, `docs/VERIFY-M27.md`.

This file exists because session context does not survive. It is a **review
list**, not a spec: each item says what is left, where it goes, what it depends
on, and what is already true. Read the spec for detail; read the verify docs for
what was measured.

State at the time of writing: `v0.1.19` released; the container is on
`v0.1.19 / schema v21`; tree clean; root **1582 passed** (5 env-gated skips),
shared **90**, web **858**, typechecks 0, web build green. Zero open Dependabot
alerts.

---

## 0. What landed in v0.1.19 — do not redo

### M28 slice A — the Flow compiler (pure, no UI, no route)

`core/src/skills/flow/schema.ts` (`validateFlow`) + `flow/compile.ts`
(`compileFlow`). Both exported from `core/src/index.ts`. Read these before
planning slices B/C, because five semantics were DECIDED here and the rest of the
milestone has to live with them:

- A node's **scope** is its single inbound data edge; with none it reads `args`
  (so a `tool` node wired straight from args needs no edge).
- **A node whose scope is `undefined` does nothing.** That is what gives `branch`
  meaning under D2's "sequential awaits only" ceiling: a non-taken port yields
  `undefined`, so the nodes behind it skip their tool and model calls. Both ports
  are still *evaluated*, but only one does I/O.
- `filter`/`map` paths are **item-relative**; every other path is scope-relative.
- An object **`merge` binds each input's key by `targetHandle`** (positional
  fallback in `(rank, source id)` order, with a warning when the produced keys
  differ from `data.keys`). Without the handle the positional order is
  deterministic but NOT what an author drew — that is why the handle wins.
- **`output text` renders a value carrying a `.text` string as that text**, so
  `llm -> output(text)` returns the model's answer instead of
  `[object Object]` (`partner.llm.complete` resolves `{text, usage}`).

Two additions beyond the spec's letter, both deliberate:

1. `FlowValidationCode` gained **`bad_node`** — a recognised node type with
   malformed `data` (or a duplicate id, or >1 inbound edge on a non-merge, or an
   edge into a source node) had no code of its own, and borrowing a semantic name
   for a shape problem is exactly the drift the vocabulary prevents.
2. The compile result gained **`usesLlm`** — `permissions.tools` alone leaves a
   flow with an `llm` node installing a manifest that refuses every model call
   (`llm_not_declared`). Slice B must write BOTH derived fields.

### The Studio split (owner decision: before M28 C/D)

`web/src/SkillStudio.tsx` went 2025 -> 468 lines, with the panels in
`web/src/studio/*` (rail, empty state, editor, validation, run, install+confirm,
actions) and `studio/shared.ts` for the four shared helpers. **All of them are
re-exported from `SkillStudio.tsx`**, so no importer and no test moved. No CSS
changed (`app.css` byte-identical), so the UX gates are untouched by the split.
**The canvas (C) and the AI panels (D) belong in this folder, not back in the
container.**

### M27 S1 — app-scoped notes reach (v0.1.18)

M27 **S1** (app-scoped notes reach) is complete and tested. Read this before
planning S2/S4, because three things changed shape:

- `ToolScope = {kind:'project'} | {kind:'app'}` and `APP_SCOPE_ID = 'app'`
  (`shared/src/tools.ts`). The broker branches on the **manifest's scope**; the
  app path keys the grant and the pending row on `APP_SCOPE_ID` and **never
  calls `roots.getById`**, so an app tool works with ZERO roots registered.
- `core/src/tools/notes.ts` (new) holds the executors; `TOOL_MANIFESTS` is the
  whole registry and `defaultToolRegistry()` is now **derived** from it — the
  installer's registry and the broker's dispatch map cannot drift.
- The three ids map to the **existing** `file.read` capability on purpose. A new
  `notes.read` name would be absent from mobile's allowlist and would deny a
  phone its own notes **by construction**. Do not "fix" this.

Two slices remain in M27, and the **S4 blocker is now half-cleared**:
`RuntimeCapabilities` has a `notes` key, so a template can express "needs
app-scoped notes reach". S2 still needs its own key decision (see §1).

## 1. M27 — what a skill may reach (2 of 5 slices left)

**S2 — MCP from the sandbox.** MCP is reachable only as a chat-side external tool
(`core/src/mcp/tool.ts`); it is not in the broker registry, so a skill declaring
it is refused at install and denied at run time.

What is left:

1. `permissions.mcpServers` is already **shape-validated** in
   `core/src/skills/manifest.ts`; flip `capabilities.mcp` to `true` at the call
   sites the way S5 did for `llm` **and S1 did for `notes`**.
2. A `mcp:` branch in `core/src/skills/runner.ts`'s `tools.exec` handling,
   reached only when the server is declared, **enabled**, the tool exists, and
   the manifest ceiling is ≥ `medium` (an MCP tool's own risk is unknowable in
   advance — this is D6).
3. **Coded denials, never a pending row** (`mcp_not_declared`, `mcp_disabled`,
   `upstream`) — skills are non-interactive, matching M8's rule.
4. `core/src/mcp/skillReach.ts` (new) so `skills/` does not import `mcp/` direct —
   mirror how `search/tool.ts` owns its own seam.
5. The class: S3 already put `clientClass` on the runner context — pass the same
   value into this seam. **D7's MCP half is NOT closed until this lands.**

**S4 — the two templates that need S2.** `notes-checklist` and `mcp-call` in
`core/src/skills/templates.ts`, each with a `requires` key. The `notes` key now
exists, so **`notes-checklist` can be built as soon as S2 or independently**;
`mcp-call` waits on S2.

### M27 gaps that are decision-shaped, not work-shaped

- **The spend ledger diverges — PARKED, awaiting an owner decision (do not act
  without one).** Three paths behave three ways: **chat**
  (`server.ts:2872`) hard-blocks at a declared cap and writes NO ledger row at
  all when the provider has no `budgetCents`; the **skill runner**
  (`runner.ts:610`) charges unconditionally and **never checks the rolling cap**;
  the **M26 one-shot calls** (workshop generation, daily-summarize,
  auto-remember) never settle (D10's recorded gap). So an uncapped provider is
  invisible to the ledger, and a skill can silently spend past a capped
  provider's rolling window. The owner said "disable this for now" without
  specifying which of the two readings was meant, and one of them (turning the
  ledger off) also removes the chat route's budget block — a cost control — so
  it was **not** done. Ask: (a) actually disable the ledger (and accept losing
  the chat cap gate), or (b) park the divergence and change nothing?
- **`budget.maxTokens` for non-llm calls — SETTLED (2026-09-17).** The install
  summary printed "may spend at most N model tokens" for a tool-only skill that
  has no model reach. The line is now gated on `permissions.llm === true`
  (`core/src/skills/runtime.ts`), with a test pinning the `llm:false` +
  `maxTokens` case. The field itself stays accepted on any manifest (it is shared
  and validated whenever present); only the **consent text** was the lie.

---

## 2. M28 — the Studio Flow surface (A + split done; B–F left)

**Slice A landed in v0.1.19** (`core/src/skills/flow/schema.ts` +
`flow/compile.ts`, 1246 lines together, plus three test files:
`flowSchema.test.ts`, `flowCompile.test.ts`, `flowRun.test.ts`). Read §0 above for
the five semantics it fixed and the two additions beyond the spec (`bad_node`,
`usesLlm`) — those are what B has to honour.

**Remaining slices:**

- **B — draft routes + staleness (schema v22).** Three additive columns on
  `skill_drafts` (`flow_json`, `flow_sha256`, `flow_compiled_at`), the six routes
  under `/v1/skills/drafts/:id/flow`, and `flowStale` derived from
  `sha256(code) !== flow_sha256`. **Do this next**: it is the API half of the same
  work, needs no canvas, and makes the whole feature walkable. When writing
  `permissions` on compile, remember **both** derived fields (`tools` AND
  `usesLlm`).
- **C — the canvas + Nodes table + palette/inspector.** Goes in `web/src/studio/`
  (the folder the split created), with the client-side grammar mirrored from
  `FLOW_PATH_RE` / `FLOW_OPERATORS` rather than copied.
- **D — AI build/refine/from-code + the proposal diff.** `refine.ts` is specified
  but unbuilt.
- **E — the chat `flow` payload** on the existing `skills.draft` tool.
- **F — docs/verify** (`docs/VERIFY-M28.md`, and a *looked-at* canvas frame: a
  passing `ux_audit` is the floor for a visual surface, not the evidence).

Its `llm` node prerequisite (`PLAN-M27.md` S5) **landed in v0.1.17**, and slice A
already compiles an `llm` node when the caller passes `llmAvailable: true`.

### Studio split — DONE (v0.1.19)

`web/src/SkillStudio.tsx` went 2025 -> 468 lines; the panels are in
`web/src/studio/*` and are re-exported from the original module, so no importer or
test moved. No CSS changed. **Canvas and AI panels belong in that folder.**

## 3. Env-gated walks that were never run

Recorded in the verify docs as *not verified*; each needs a live endpoint or a
packaged build. The owner pointed at **pi settings** for a live LiteLLM endpoint
— use that for the two model walks rather than a fake client.

| Walk | Milestone | What it proves |
|---|---|---|
| Live-endpoint generation | M26 | That a real LiteLLM/model reply parses and normalises into an installable draft (today: a fake `ProviderClient` and the demo generator). |
| Packaged-app Studio | M26 | That the Studio works in a packaged shell, not only in the dev SPA. |
| Live-model skill run | M27 S5 | That `partner.llm.complete` reaches a real provider with a real token ceiling. |
| Real MCP server from a skill | M27 S2 | Blocked until S2 exists. |

---

## 4. Smaller loose ends

- **Dependabot alert #1 — CLOSED (dismissed 2026-09-17, reason `not_used`).**
  The alert was Rust, not npm: `glib` (RUSTSEC-2024-0429, medium) in
  `shell/src-tauri/Cargo.lock`. Evidence: `glib` is reachable only through
  `tauri-runtime-wry`'s `gtk` dependency, which crates.io reports as gated to
  `cfg(any(target_os = "linux", "dragonfly", "freebsd", "openbsd", "netbsd"))`;
  the Tauri shell is built **only** for Windows/MSVC
  (`.github/workflows/windows-build.yml`) and `verify.yml` runs **no cargo
  build**, so the crate is never compiled in CI or in a shipped artifact. No fix
  existed in the supported line either (tauri 2.11.5 is the latest stable and
  still resolves glib 0.18.5; the patch needs gtk 0.20, which Tauri 2.x does not
  use and 3.0 is alpha only). `npm audit` reports 0 vulnerabilities. **Re-check
  when a stable Tauri moves to gtk 0.20.**
- **The two-kind approval queue has only unit coverage.** `pending_tools.kind`
  carries `tool` and `skill_install`; the Files queue and the in-chat card
  render both. The chat-install card has **no UI walk** — only route and manager
  tests.
- **Bundle signing** stays deferred (`PLAN-M26.md` L4). Export/import is unsigned
  and unprivileged by construction — a bundle always lands as an inert draft —
  so signing can be added later without changing the trust model.
- **`docs/VERIFY-M26.md` / `VERIFY-M27.md`** each carry their own *Not verified*
  section; read those before claiming a milestone is fully proven.

---

## 5. How to re-verify from a clean checkout

```
npm test                                  # root: expect 1582 passed, 5 env-gated skips
npx vitest run shared/test                # 90
npx vitest run --root web                 # 858
npm run typecheck                         # 0 errors, all four workspaces
npm run build -w web                      # green
cd docker/server && ./stage.sh && docker compose up -d   # container refresh (needs openssl)
docker compose logs partner --tail 3      # expect "partner-core vX up ... schema=v21"
```

Guard tests that M26/M27 deliberately updated are the schema version (six files
pin `SCHEMA_VERSION`) and the closed capability vocabulary. **S1 updated three
more**, all tripwires working as intended: `core/test/chat/skillAuthorTool.test.ts`
and `core/test/http/skillDraftsRoutes.test.ts` (both asserted `notes.read` was
*undeliverable* — they now assert the same guarantee with `files.write`, which
has never existed), and `core/test/skills/manifest.test.ts` +
`web/test/skill-studio-helpers.test.ts` (vocabulary shape). If one fires, update
it deliberately and say so.
