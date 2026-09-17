# UNFINISHED — the review list for the next session

Date: 2026-09-16 (written at `v0.1.17`) · Index: `PLAN.md` §15 · Specs:
`PLAN-M27.md`, `PLAN-M28.md` · Records: `docs/VERIFY-M26.md`, `docs/VERIFY-M27.md`.

This file exists because session context does not survive. It is a **review
list**, not a spec: each item says what is left, where it goes, what it depends
on, and what is already true. Read the spec for detail; read the verify docs for
what was measured.

State at the time of writing: `v0.1.17` released and pushed; the container is on
`v0.1.17 / schema v21`; tree clean; root **1495 passed** (5 env-gated skips),
shared **90**, web **851**, typechecks 0, web build green.

---

## 1. M27 — what a skill may reach (3 of 5 slices left)

M26 made a skill *authorable*. M27 decides what an authored or installed skill may
*touch*. **S3 and S5 are done**; S1, S2 and S4 are not, so the Studio still offers
only the *pure* and *reads-files* templates — deliberately, because the picker is
capability-filtered and will not offer a reach the sandbox lacks.

### S1 — app-scoped broker tools (`notes.list` / `notes.search` / `notes.read`)

**Why it exists:** every broker tool today requires a **project root**
(`broker.exec` step 4 calls `roots.getById(projectId)` → `unknown_project`), and
the user's notes are not a filesystem root. Without this, a "notes" skill is not
expressible.

What is left, in dependency order:

1. `shared/src/tools.ts`: `ToolScope = { kind: 'project' } | { kind: 'app' }`;
   `ToolId` gains the three ids; export `APP_SCOPE_ID = 'app'`.
2. `core/src/broker/toolManifests.ts`: three manifests, `scope: { kind: 'app' }`,
   `risk: 'low'`, `confirm: 'once'`, `network: false`.
3. `core/src/broker/broker.ts`: step 4 branches on the manifest's scope — the app
   path uses `APP_SCOPE_ID` for the grant check and for the pending row and
   **never calls `roots.getById`**. The `tools` option widens from `FileTools` to
   a record that can carry the app executors (the dispatch map is flat today).
4. `core/src/tools/notes.ts` (new): the executors over the notes manager, reusing
   its own result/hit caps, returning structural results only.
5. `TOOL_CAPABILITIES`: map all three to the **existing** `file.read` — do not
   invent a capability name. Mobile's envelope already includes `file.read` and
   the data plane is ungated by design; a new name is denied to mobile by
   construction and would silently narrow the product.
6. `core/src/skills/catalog.ts` `defaultToolRegistry()` must include the new ids,
   or a manifest declaring them is refused at install.
7. `core/src/http/server.ts`: `POST /v1/grants` accepts `projectId: 'app'` **only**
   for an app-scoped manifest (and must refuse it for `files.read`).
8. Web: an "App data" group beside the roots in the grant surface; the Studio's
   dry-run should say "not granted yet" rather than just failing.

Tests to write: a **zero-root** broker grants and runs `notes.read`; app tools
audit ids/counts/lengths only; `files.read` with `projectId: 'app'` is refused;
app tools resolve for mobile (positively — `file.read` is in its envelope).

### S2 — MCP from the sandbox

**Why it exists:** MCP is reachable **only** as a chat-side external tool
(`core/src/mcp/tool.ts`); it is not in the broker registry, so a skill declaring
it is refused at install and denied at run time.

What is left:

1. `permissions.mcpServers` is already **shape-validated** in
   `core/src/skills/manifest.ts`; flip `capabilities.mcp` to `true` at the call
   sites the way S5 did for `llm`.
2. A `mcp:` branch in `core/src/skills/runner.ts`'s `tools.exec` handling, reached
   only when the server is declared, **enabled**, the tool exists, and the
   manifest ceiling is ≥ `medium` (an MCP tool's own risk is unknowable in
   advance — this is D6).
3. **Coded denials, never a pending row** (`mcp_not_declared`, `mcp_disabled`,
   `upstream`) — skills are non-interactive, matching M8's rule.
4. `core/src/mcp/skillReach.ts` (new) so `skills/` does not import `mcp/` direct —
   mirror how `search/tool.ts` owns its own seam.
5. The class: S3 already put `clientClass` on the runner context — pass the same
   value into this seam. **D7's MCP half is NOT closed until this lands**;
   `capabilities.ts`' comment has been corrected to say so.

### S4 — the two templates that need S1/S2

`notes-checklist` and `mcp-call` in `core/src/skills/templates.ts`, each with a
`requires` key. **Blocker worth knowing before starting:** `RuntimeCapabilities`
is `{ mcp, llm }` today — there is no key for the notes reach, so a template
cannot express "needs app-scoped notes tools" until one is added (`notes`) and
threaded to every call site that already takes the object. Do that as part of S1.

### M27 gaps that are decision-shaped, not work-shaped

- **The spend ledger diverges.** The chat route settles only when a provider
  declares a budget cap; the skill runner charges **unconditionally** when cents
  > 0 (deliberate: D13 wants the ledger as the cumulative record). Decide whether
  to align them — this is the same recorded gap as M26's D10, and the honest
  options are "charge everywhere" or "settle-on-cap everywhere".
- **`budget.maxTokens` for non-llm calls.** A skill that only calls tools still
  has a `maxTokens` field that means nothing. Either document it as llm-only or
  remove it from the non-llm path.

---

## 2. M28 — the Studio Flow canvas (not started)

`PLAN-M28.md` is complete and reviewed as a spec; **no code exists**. Six slices:
A the pure flow compiler · B draft routes + staleness · C the canvas + Nodes
table · D AI build/refine/from-code · E the chat `flow` payload · F docs.

Its `llm` node prerequisite (`PLAN-M27.md` S5) **landed in v0.1.17**, so the node
is now expressible.

The load-bearing constraints are already decided and should not be re-litigated:
a flow **compiles deterministically to `entry.mjs`** (no second artifact, no
interpreter); the vocabulary is ten typed nodes and is deliberately **not** a
programming language; expressions are a validated path grammar plus fixed
operators, so an AI-written graph **cannot inject code**; `permissions.tools` is
**derived** from the graph's `tool` nodes; flow/code coherence is a **derived hash
comparison**, not a boolean; an AI refine is a **proposal** the owner accepts.

**A starting point that is not the canvas:** slice A (`core/src/skills/flow/
schema.ts` + `compile.ts`) is pure, has no UI, and is fully unit-testable —
determinism, totality (a cycle is a named error), the injection refusal, and the
derived tool set. It is walkable from the API before any React Flow work.

**Owner decision still open in that spec:** the `llm` node's admission is now
settled by S5 landing, so the palette is the full ten node types — but confirm
that the two *reach* templates (S1/S2) are worth building before the canvas, since
without them a flow can only reach files and the model.

---

## 3. Env-gated walks that were never run

Recorded in the verify docs as *not verified*; each needs the owner's own
endpoint or a packaged build.

| Walk | Milestone | What it proves |
|---|---|---|
| Live-endpoint generation | M26 | That a real LiteLLM/model reply parses and normalises into an installable draft (today: a fake `ProviderClient` and the demo generator). |
| Packaged-app Studio | M26 | That the Studio works in a packaged shell, not only in the dev SPA. |
| Live-model skill run | M27 S5 | That `partner.llm.complete` reaches a real provider with a real token ceiling. |
| Real MCP server from a skill | M27 S2 | Blocked until S2 exists. |

---

## 4. Smaller loose ends (worth a look, none blocking)

- **File sizes.** `web/src/SkillStudio.tsx` is ~2016 lines and
  `core/src/skills/drafts.ts` ~1270. Both are cohesive, but the Studio is the
  obvious next split (rail / editor / validation / install are separate concerns).
- **The two-kind approval queue has only unit coverage.** `pending_tools.kind`
  now carries `tool` and `skill_install`; the Files queue and the in-chat card
  render both. The chat-install card specifically has **no UI walk** — only route
  and manager tests.
- **Dependabot:** 1 moderate alert on `master` (pre-existing, not introduced by
  M26/M27). Not touched.
- **Bundle signing** stays deferred (`PLAN-M26.md` L4). Export/import is unsigned
  and unprivileged by construction — a bundle always lands as an inert draft — so
  signing can be added later without changing the trust model.
- **`docs/VERIFY-M26.md` / `VERIFY-M27.md`** each carry their own *Not verified*
  section; read those before claiming a milestone is fully proven.

---

## 5. How to re-verify from a clean checkout

```
npm test                                  # root: expect 1495 passed, 5 env-gated skips
npx vitest run shared/test                # 90
npx vitest run --root web                 # 851
npm run typecheck                         # 0 errors, all four workspaces
npm run build -w web                      # green
cd docker/server && ./stage.sh && docker compose up -d   # container refresh (needs openssl)
docker compose logs partner --tail 3      # expect "partner-core vX up ... schema=v21"
```

The seven pre-existing guard tests that M26 deliberately updated are the schema
version (six files pin `SCHEMA_VERSION`) and the closed capability vocabulary. If
one fires, that is the tripwire working — update it deliberately and say so.
