# VERIFY-M27 — skill reach: S3 (client class) + S5 (model reach)

Date: 2026-09-16 · Spec: `PLAN-M27.md` · Master index: `PLAN.md` §15 M27.

Two of M27's five slices have landed. **S3** closes a gap M20-B S4 recorded
against itself; **S5** gives a skill model access — declared, bounded, and gated.
S1 (app-scoped notes tools), S2 (MCP from the sandbox) and S4 (the *notes*/*MCP*
Studio templates) are **not built**, so the Studio still offers only the *pure*
and *reads-files* templates.

## Measured

| Gate | Command | Result |
|---|---|---|
| Root suite | `npx vitest run` | **170 files · 1495 passed · 5 skipped · 0 failed** (the 5 are the pre-existing `canCreateSymlinks()` Windows skips) |
| Web suite | `npx vitest run --root web` | **52 files · 851 passed · 0 failed** (untouched by this slice — the shared contracts did not change) |
| Typechecks | `npm run typecheck` | **shared · core · web · extension — 0 errors** |
| Web bundle | `npm run build -w web` | **green** |

New tests: `core/test/skills/classPropagation.test.ts` (8),
`core/test/skills/llmReach.test.ts` (19).

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

## Deliberate test update (tripwire)

`core/test/http/capabilities.test.ts` pins the closed capability vocabulary and
the narrow per-class allowlists. It was updated **deliberately** for `skill.llm`,
with the reason recorded in the test: the name is added to the vocabulary and
deliberately *not* to the mobile/extension allowlists. The conservative library
default `DEFAULT_RUNTIME_CAPABILITIES` stays `{ mcp: false, llm: false }` —
the core and the harness pass `{ mcp: false, llm: true }` explicitly where the
reach exists, so `manifest.test.ts`'s "a capability the runtime cannot honour is a
named error" test still passes unchanged.

## Not verified (explicitly)

- **No live-model walk.** The reach is exercised through a fake `ProviderClient`;
  no real endpoint was called. A live walk against the user's own gateway is
  env-gated and outstanding.
- **No packaged-app walk.**
- **MCP is still unreachable from a skill** (S2 unwired): the runner has no `mcp:`
  branch, so D7's MCP half is not closed — `clientClass` now sits on the runner
  context, so S2 only needs to pass the same value into its own seam.
- **S1 and S4 are not built**, so the *notes* template does not exist and the
  Studio template picker is unchanged.
