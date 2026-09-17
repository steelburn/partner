# VERIFY-M27 — skill reach: S3 (client class) + S5 (model reach) + S4 (templates)

Date: 2026-09-16, extended 2026-09-17 (S1, S2, S4, and the review fixup) · Spec:
`PLAN-M27.md` · Master index: `PLAN.md` §15 M27.

This document opened with S3 and S5 (two of M27's five slices). **S1** (app-scoped
notes tools), **S2** (MCP from the sandbox) and **S4** (the *notes*/*MCP* Studio
templates) landed afterwards on the same tree, so all five slices are now on it:
§S4 below is the slice this document's own *Not verified* list used to record as
unbuilt, and `PLAN-M27.md`'s State carries the per-slice record.

## Measured

| Gate | Command | Result |
|---|---|---|
| Root suite | `npx vitest run` | **179 files · 1651 passed · 5 skipped · 0 failed** (the 5 are the pre-existing `canCreateSymlinks()` Windows skips; 1495 at S3/S5, 1614 at S1+S2, 1628 at S4, 1645 after M28 B, 1651 after the 2026-09-17 review fixup below) |
| Web suite | `npx vitest run --root web` | **52 files · 858 passed · 0 failed** (851 at S3/S5; unchanged by S4 — the shared contracts did not move) |
| Typechecks | `npm run typecheck` | **shared · core · web · extension — 0 errors** |
| Web bundle | `npm run build -w web` | **green** |

New tests: `core/test/skills/classPropagation.test.ts` (8),
`core/test/skills/llmReach.test.ts` (19), `core/test/skills/templates.test.ts`
(13, S4), `core/test/skills/mcpReach.test.ts` (S2, 30 after the review fixup).

## Review fixup (2026-09-17, no version bump)

An independent review found four things about S2 that its own tests could not see.
All four are fixed on the tree and asserted:

1. **A refused MCP call wrote NO audit row.** The invocation SUCCEEDS when a skill
   catches the coded denial (both templates do), so `skill.invoke` records ok:true
   with toolCalls:1 — and a denial above the server lookup never reaches the
   manager's own `mcp.call` row. An attempted-and-refused reach was therefore
   invisible to anyone auditing "did this skill or phone try to reach MCP".
   `createMcpSkillReach(mcp, audit)` now writes exactly ONE `mcp.call.denied` row
   per denial — actor `skill`, the server id as target, `{code, tool}` as details,
   never tool arguments or the server command line — and the composition root
   passes the core's own `AuditService`. `mcpReach.test.ts` asserts a row per
   code (`capability_denied`, `mcp_not_declared`, `mcp_disabled`, `tool_denied`,
   `upstream`), the row's exact details shape ({code, tool}) with no argument
   content anywhere, and no row for a call that succeeded.
2. **D8's assertion could not fail.** `pendingManager.list()` returns OPEN rows
   only, so a regression that took the broker's enqueue-then-decide(deny) route
   would leave a CLOSED row it could not see. The MCP tests now count the WHOLE
   `pending_tools` table. The notes template's dry-run deliberately keeps the
   open-row check: that is the BROKER route, which closes its row by design.
3. **The result-cap test did not touch MCP.** It returned a blob from a skill that
   ignored its arguments, so it passed with the whole seam deleted. It now calls a
   real tool whose answer is far past the 1 MiB cap (the MCP client caps one text
   item at 200k chars, so the fixture returns several).
4. **The duplicated id regex was only half pinned.** A multi-segment
   `mcp:<server>/a/b` id driven through the RUNNER must answer
   `mcp_not_declared` (seam reached, server not declared) rather than
   `tool_denied` (fell through to the broker), which is what distinguishes the
   runner's copy of the regex from the seam's.

Attribution, same class as the S2 actor fix: the runner's own `skill.invoke` row
now names `persona` for a persona-driven or scheduled run (a `ctx.personaId`)
instead of the `web` default — `actor` is WHO ASKED; the skill id is the row's
target. Asserted in `core/test/skills/runner.test.ts`.

## S3 — the class reaches the runner (M20-B S4 closed)

`broker.exec` called from a skill passed no `clientClass`, which defaults to the
**desktop** envelope. That was unobservable while a skill could only reach
`files.*` and mobile may not invoke a skill at all — and a real hole the moment a
skill can reach more. Now `SkillInvokeContext.clientClass` is read from the
**session row** by both routes into the runner (`/v1/skills/:id/invoke` and the
draft dry-run `/v1/skills/drafts/:id/run`) and forwarded to `broker.exec`. An
absent class keeps its documented meaning: an internal caller (a persona or
scheduled run) is the desktop owner's agent.

**A premise in the implementation brief was wrong, and the correction matters.**
The brief asked for "a granted `files.read` + a mobile session → refused". That is
not what the shipped envelope says: `CLIENT_ENVELOPE.mobile` is
`['chat', 'file.read', 'browser']`, and `capabilityEnforcement.test.ts` already
asserts that mobile **executes** `files.read` through the broker — M27's own S1/D3
depends on that reach. Forcing a refusal would have meant weakening the mobile
envelope and breaking a passing test. So the M20-B S4 case is proven with
**`files.edit`**, which is exactly the case that note wrote down: *"its grant for
`files.edit` would walk the phone straight into a write."* `files.read` is kept as
a positive control, so the test proves the class is **per-capability**, not a
blanket deny.

What the test asserts for the write case: the grant is verified **present** in the
store first (otherwise the refusal would prove nothing), then `capability_denied`
at the runner, no pending row, no proposal, and an audit row carrying
`{clientClass: 'mobile', capability: 'file.write'}`. Plus: a request **body**
cannot set or raise the class, and the absent-class path keeps the desktop
envelope. The same assertions run against the dry-run route, since that is the
other way in.

## S5 — model reach, declared and bounded

A skill could not call a model at all: the worker's `partner` global was `log` and
`tools.exec`, nothing else. `partner.llm.complete({prompt, maxTokens?})` now
exists, and the gate order in the runner is **declaration → class → request shape
→ provider → ceiling**:

- `permissions.llm !== true` → `llm_not_declared` (absent means no model access at
  all — the only honest default);
- `capabilityDenial(clientClass ?? 'desktop', 'skill.llm')` → `capability_denied`.
  `skill.llm` is a new capability that is deliberately **not** in the mobile or
  extension allowlists, so a phone's skill run cannot send the user's data to a
  model provider;
- nothing usable configured → `no_provider`, matching the chat path;
- **the ceiling is enforced**: `budget.maxTokens` when declared, otherwise the
  documented `DEFAULT_SKILL_LLM_MAX_TOKENS` (4096) — never unbounded. Tokens
  accumulate across every call in one invocation; past the ceiling the invocation
  fails `budget_exceeded` **mid-run**, the worker is `SIGKILL`ed, and no partial
  success is returned.

**`SkillBudget.maxTokens` finally does something.** It has been declared in
`shared/src/skills.ts`, validated in `manifest.ts`, and never read since M8 —
`runner.ts` used only `timeMs`. It is now the token ceiling it always claimed to
be, and `permissionSummary` states the binding ceiling so the owner reads the
number before installing.

**The spend ledger is charged** (D13): one `spendLedger.charge({providerId, cents})`
per accounted call, with a byte/4 estimate when a stream reports no `usage`. It is
charged unconditionally when cents > 0, whereas the chat route only settles when a
provider declares a budget cap — deliberate, since D13 wants the ledger to be the
cumulative record and the cap check stays the route's job. A ledger write failure
never breaks a skill run.

**Content never leaves the audit.** One `skill.llm` audit row per accounted call
carries the model id, prompt/completion/total token counts, ms and cents — and
**neither the prompt nor the completion**, asserted by serializing the audit list.
The invocation meta row carries counts only.

**The authoring prompt now describes it.** With `capabilities.llm` true the prompt
documents the verb, the ceiling and its failure codes, and — in plain words —
that *anything the skill read can leave the machine*. Driven by the passed
capability object, not a constant, so the two states cannot drift.

The catalog door forwards the same capability object (`createSkillManager` and its
`catalog()`/`install()` call sites), so a checked-in bundle may declare `llm`.

## S4 — the *notes* and *MCP* Studio templates (2026-09-17)

The slice M27 existed for. `notes-checklist` and `mcp-call` live in
`core/src/skills/templates.ts` (the spec's S4 bullet named `authoring.ts`; that
module only delegates via `templateBundle`, and always did — the file is now the
only place a template's source exists). Neither adds a route, a schema field or a
capability name; what it adds is the two bundles, and the `requires` key each one
is gated on.

**Gating is one decision, read by every surface (D9).**
`availableTemplates(capabilities)` filters on `requires`, and the drafts door
(`POST /v1/skills/drafts` with `mode:'template'`) refuses a template whose key is
false with a named reason — so the picker cannot offer a bundle the sandbox would
refuse, and asking for one by name cannot bypass the picker. Both directions are
asserted, per template, with each capability key toggled: **offered exactly when
its own key is on**, and the picker's list is the four ids when all three reaches
are wired. Under the library default (`{mcp:false, llm:false, notes:false}`) the
list is still `pure, reads-files`.

**The notes template reaches app data with NO root.** It declares
`notes.list` / `notes.search` / `notes.read` and passes no `projectId`: the grant
is keyed on `APP_SCOPE_ID`, which is what the picker's **App data** group
consents to. Proven by a real dry-run through the real runner — the draft is
created from the template, then `runDraft` materializes the bundle, spawns the
sandbox and lets it call the real broker:

- **before the grant**: the entry reports `{ ok: false, reason: 'tool_denied' }`
  (it catches; the RUN does not fail) and the approval queue stays **empty** —
  a skill is never interactive, so the refusal is a code, not a pending row;
- **after** `grants.add('notes.read' | 'notes.list' | 'notes.search', APP_SCOPE_ID)`:
  exactly the two markdown task items of the seeded note come back, from both the
  list path and the search path, and a second note with no task items contributes
  **nothing** — no invented entry;
- the broker has **zero roots** at the end of it, which is the premise S1 was
  built on.

**The MCP template runs against a real stdio server.** `mcp-call` declares one
server and calls `mcp:<server>/<tool>` at the **`medium`** ceiling D6 requires;
the test spawns the same kind of inline Node MCP script S2's tests use (real
manager, real client, real seam, **no network**), enables it, installs the
template's CODE and asserts:

- a declared, enabled server's `echo` returns its text to the skill
  (`output_1` flattened, `contentItems: 1`);
- an **undeclared** server reports `mcp_not_declared` and a **disabled** one
  `mcp_disabled` — the codes the template's own docblock promises — with no
  pending row in either case.

The manifest the template ships declares `mcpServers: [MCP_TEMPLATE_SERVER_ID]`
— a **placeholder**, because server ids are `randomUUID()` when the owner adds a
server and no template can know one. That placeholder is what makes the manifest
a truthful example of the reach (D5's shape + D6's ceiling) instead of a
bundle that could never reach anything; the run test performs the same one-field
edit an author performs, rather than asserting something weaker.

## Deliberate test update (tripwire)

`core/test/http/capabilities.test.ts` pins the closed capability vocabulary and
the narrow per-class allowlists. It was updated **deliberately** for `skill.llm`,
with the reason recorded in the test: the name is added to the vocabulary and
deliberately *not* to the mobile/extension allowlists. The conservative library
default `DEFAULT_RUNTIME_CAPABILITIES` stays `{ mcp: false, llm: false, notes:
false }` — the core and the harness pass all three true explicitly where the
reaches exist, so `manifest.test.ts`'s "a capability the runtime cannot honour is
a named error" test still passes unchanged.

**S4 updated two tripwires of the same kind**, because the template palette grew:
`drafts.test.ts` asked for `notes-checklist` as an *unknown* template (it now asks
for a genuinely unknown id, and a new test pins the capability gate that replaced
that refusal), and `skillDraftsRoutes.test.ts` pinned the picker's list at two ids
(it is four when the reaches are wired). Neither assertion was weakened — each
one still refuses/offers exactly what it refused/offered before.

## Not verified (explicitly)

- **Live-model walk — VERIFIED 2026-09-17** (`docs/VERIFY-LIVE.md` (b)): S5's
  `partner.llm.complete` reached a local llama.cpp `gemma-4-E4B-it-Q4_K_M` server
  and the remote LiteLLM gateway (`deepseek-v4-flash`), returned text, FAILED the
  invocation `budget_exceeded` under `budget.maxTokens: 1`, and wrote `skill.llm`
  rows with model + token counts only (a whole-audit scan found no prompt or
  completion content). This supersedes the "no real endpoint was called" note.
- **No packaged-app walk — NOT RUN, and a REBUILD is required**
  (`docs/VERIFY-LIVE.md` (d)): the only installed artifact predates M26/M27, so it
  cannot contain the Studio. Rebuild, then walk with `:4390` free.
- **Live (third-party) MCP walk — NOT RUN** (`docs/VERIFY-LIVE.md` (c)):
  **no third-party MCP server is configured or available on this machine**
  (LM Studio MCP config, editor configs, repo/parent `.mcp.json`, `PATH`, the
  npx/pi caches and Python were all checked; the local stdio fixture was
  explicitly not substituted). S2 and S4 reach a REAL stdio server, but one
  written as a local script in the test — configuring and enabling a real server
  is the owner's act, and it has not been walked.
