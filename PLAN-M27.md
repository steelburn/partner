# M27 — What a skill may reach: app-scoped tools + MCP from the sandbox

Status: **spec** (not implemented) · Companion to `PLAN.md` §9, §15 (index) ·
Builds on: `PLAN-M8.md` (skills runtime), `PLAN-M26.md` (authoring) ·
Unblocks: the *notes-shaped* and *uses-an-MCP-tool* Skill Studio templates (M26 L3).

## Goal

M26 lets a person author a skill. This milestone decides what an authored (or
installed) skill is allowed to *touch*, and it exists because two of the four
templates the owner asked for are not implementable on today's skill reach:

| Template | Blocked by | Fixed here by |
|---|---|---|
| Pure skill | — | (M26) |
| Reads files under a root | — | (M26) |
| **Notes-shaped** (search/read the user's notes) | The broker has no notes tools, and every broker tool requires a **project root** (`broker.exec` step 4: `roots.getById(projectId)` → `unknown_project`). Notes are not a filesystem root. | **App-scoped tools** (S1) |
| **Uses an MCP server's tool** | MCP exists only as a **chat-side external tool** (`core/src/mcp/tool.ts`); it is not in the broker registry, so a skill declaring it is refused at install ("declares unknown tool") and denied at run time. | **MCP from the runner** (S2) |

Both slices also close the gap M20-B S4 recorded against itself: *"neither
`core/src/skills/` nor `core/src/mcp/` consults the session's client class
today, so the class would NOT constrain what they do on mobile's behalf."* Once
a skill can read notes or call MCP, that propagation stops being a note and
becomes a control (S3).

## Why this is a separate milestone (and not "just two more templates")

The M26 spec deliberately ships without these, because each one widens the
capability surface rather than the authoring surface — and a widening that hides
inside a UI template is exactly the kind of change that should be reviewable on
its own. Three properties make that the right call:

- **Grants are keyed by `(toolId, projectId)`.** An app-scoped tool has no
  project. Either the broker learns a second scope kind, or the notes template
  is a lie.
- **A skill's risk ceiling is compared against the tool manifest's risk**
  (`RISK_RANK[tool.risk] > RISK_RANK[manifest.permissions.risk] → tool_denied`,
  `runner.ts`). An MCP tool's risk is only known per server, at run time — so
  the ceiling rule needs an explicit, documented answer rather than a default.
- **The runner is class-less.** `broker.exec` from a skill passes no
  `clientClass`, which defaults to the **desktop** envelope. That is currently
  unobservable (a skill can only reach `files.*`, and mobile may not
  `skill.invoke`), and it becomes a real hole the moment app-scoped reads or MCP
  calls exist.

## Decisions

| # | Decision | Consequence accepted |
|---|---|---|
| D1 | **A second scope kind, not a fake root.** `ToolScope` becomes `{kind:'project'} \| {kind:'app'}`; app-scoped tools resolve against a reserved `APP_SCOPE_ID = 'app'` instead of a project root. | `broker.exec` step 4 branches on the manifest's scope: app tools skip the root lookup and check `grants.hasGrant(tool, APP_SCOPE_ID)`. No schema change — `projectId` is already an opaque TEXT. |
| D2 | **Three app tools, all read-only, all `low` risk:** `notes.list`, `notes.search`, `notes.read`. Handlers call the existing notes manager; nothing new is written. | A skill can read notes and nothing else about the app. No `notes.write`, no memory access, no settings — the write path stays the files/tool broker's problem. |
| D3 | **App tools map to the existing `file.read` capability** — no new capability name. | The class envelope needs no edit and mobile keeps exactly the reach it already has through `/v1/notes` (the data plane is ungated by design). A new name would have been denied to mobile/extension by construction and silently narrowed the product. |
| D4 | **Granting an app tool is a first-class, rootless grant.** `POST /v1/grants` accepts `projectId: 'app'` for a manifest whose scope is `app` (and refuses it for a project-scoped tool), and the workspace UI gets an "App data" group beside the roots. | The user consents to "this skill may read my notes" once, in the same place they consent to a root. The Studio/dry-run states the consequence plainly when a declared app tool is not granted yet. |
| D5 | **MCP reach is declared as servers, not tool names.** `SkillPermissions` gains `mcpServers?: string[]` (server ids); the runner accepts a `tools.exec` id of `mcp:<server>/<tool>` when `<server>` is declared, the server is **enabled**, the tool exists, and the ceiling rule below holds. | A manifest cannot name a tool that does not exist yet (servers are configured later), and enabling a server is still the user's default-deny act — the same consent that governs chat MCP calls today. |
| D6 | **An MCP call requires a `medium`-or-higher manifest ceiling**, and the call is treated as `medium` for the ceiling comparison. | An MCP tool's own risk is unknowable in advance, so the skill must present itself as at least medium risk, which the owner sees at install. A `low` skill cannot call MCP; the validator says so at draft time rather than at run time. |
| D7 | **`mcp.call` gates the runner's MCP path too**, with the session class propagated: `SkillInvokeContext.clientClass` → runner → `broker.exec({requestedBy:'skill', clientClass})` and the MCP branch. | Closes M20-B S4's recorded gap. Desktop keeps its reach; a mobile or extension session that somehow reaches `skill.invoke` is refused before the grant check, at both the broker and the MCP path. |
| D8 | **MCP calls from a skill are never interactive.** A disabled server, an undeclared server, an unknown tool, or a failed class check returns a coded denial to the worker (`tool_denied` / `mcp_not_declared` / `mcp_disabled` / `upstream`) — no pending row is created. | Consistent with M8's skills-are-non-interactive rule (`runner.ts` closes a queued call as DENY). The user enables a server *before* invoking, exactly as they grant a root before invoking. |
| D9 | **The Studio's template list is derived from what exists.** The picker renders a template only when its capability is wired, so turning M27 off (or reverting it) cannot leave a template that produces a skill the sandbox will refuse. | One source of truth for "what can a skill reach", consumed by the authoring prompt, the validator, the Studio picker and the install summary. |
| D10 | **Validation and the dry-run answer the same question.** `validateManifestShape` checks declared ids against the registry **plus** the `mcp:*` pattern + `mcpServers` shape; a draft is never refused for a capability the runner would allow, and the dry-run is the ground truth for the rest. | No install-time surprise either way: a manifest that validates installs, and a manifest that would be denied at run time says so at validate (undeclared server, low ceiling). |
| D11 | **Model reach is declared and bounded, not ambient.** `SkillPermissions.llm?: boolean` (default `false`) enables a new worker verb `partner.llm.complete`; the skill's own `budget.maxTokens` is **finally enforced** (`runner.ts` reads only `timeMs` today — the ceiling has been declared and validated since M8 and never charged), and an absent ceiling means a hard default rather than unbounded. | A skill can spend the user's provider budget. The mitigation is a per-invocation ceiling, not a promise: past it the invocation fails `budget_exceeded`, and the usage is recorded. Stated plainly in the install summary: *"this skill can send the data it reads to your configured model provider"* — which is the honest cost of the capability, and the same trust the chat already has. |
| D12 | **`skill.llm` is a capability name**, checked in the runner against the class S3 propagates. | Desktop keeps its reach; a mobile or extension session never gets model reach through a skill. A persona or schedule run has no session, so it keeps the desktop envelope (the documented behaviour of `ExecContext.clientClass`) — a persona acting for the desktop owner is the owner's agent. |
| D13 | **The invocation's tokens land in the spend ledger** under a `skill:<id>` source. | Closes M26 D10's recorded gap for the one path where it actually bites: a skill runs repeatedly (personas, schedules), so an unbounded skill is a recurring charge, unlike a one-shot generation. Ledger rows carry model + token counts — never the prompt or the output. |

## Slices

### S1 — App-scoped broker tools (`notes.list` / `notes.search` / `notes.read`)

- `shared/src/tools.ts`: `ToolScope = {kind:'project'} | {kind:'app'}`;
  `ToolId` gains the three ids; `APP_SCOPE_ID = 'app'` exported (the reserved
  `projectId`); `GrantRecord`/`GrantInput` unchanged.
- `core/src/broker/toolManifests.ts`: three manifests, `scope:{kind:'app'}`,
  `risk:'low'`, `confirm:'once'`, `network:false`.
- `core/src/broker/broker.ts`: step 4 branches on `manifest.scope.kind`; the
  app path uses `APP_SCOPE_ID` for the grant check and for the pending row, and
  never calls `roots.getById`. `TOOL_CAPABILITIES` maps all three to
  `file.read` (D3).
- `core/src/tools/notes.ts` (new): the three executors over the notes manager
  (validate params → list/search/read), reusing the notes manager's own caps
  (result-size and hit caps), returning structural results only.
- `core/src/broker/broker.ts` `tools` option widens from `FileTools` to a
  `ToolImpls` record (or `FileTools & AppTools`) — the smallest change that
  keeps the flat dispatch map.
- `core/src/skills/catalog.ts`: `defaultToolRegistry()` includes the app tools,
  so a catalog or drafted skill may declare them.
- `core/src/http/server.ts`: the grants route accepts `projectId:'app'` only for
  an app-scoped manifest; the grants list surfaces `scope: 'app'`.
- Web: the Files/grants surface gains an **App data** group ("Your notes —
  read-only"), and the Studio/dry-run shows "not granted yet" with the same
  affordance.

### S2 — MCP from the runner

- `shared/src/skills.ts`: `SkillPermissions.mcpServers?: string[]`.
- `core/src/skills/manifest.ts`: validate `mcpServers` (string ids, ≤ a cap,
  de-duplicated, no `mcp:` prefix — the server id only) and the ceiling rule
  (D6) at validate time.
- `core/src/skills/runner.ts`: a `tools.exec` id matching `^mcp:([^/]+)/(.+)$`
  routes to an injected `mcp` dependency instead of `broker.exec`, applying
  D5+D6+D7+D8 and replying with the same `tools.exec` result protocol (so the
  worker needs no change at all).
- `core/src/skills/tool.ts` → the MCP-from-skill helper lives in
  `core/src/mcp/skillReach.ts` (new) so `skills/` does not import `mcp/`
  direct — mirroring how `search/tool.ts` owns its own seam.
- `core/src/skills/runtime.ts`: the reach vocabulary gains the `mcpServers`
  line, so the authoring prompt, the instructions, the validator and the
  install summary all describe it identically (D9).

### S3 — Class propagation (the M20-B S4 close-out)

- `SkillInvokeContext.clientClass` (M26 already threads `logSink`/`dirOverride`
  there) → the runner reads it from the **route's session row**, never a body
  field, and passes it to `broker.exec` and the MCP branch.
- `POST /v1/skills/:id/invoke` and `/v1/skills/drafts/:id/run` resolve the class
  from `res.locals.session` like every other guarded route.
- A test asserts the mobile path is refused at the broker **even with a grant
  present** — the exact case M20-B S4 wrote down as unproven.

### S4 — Templates + docs

- `core/src/skills/authoring.ts`: the two templates (`notes-checklist`,
  `mcp-call`), emitted only when S1/S2 are wired (D9).
- `docs/VERIFY-M27.md`; PLAN.md §9/§12/§13/§15 updates.

### S5 — Model reach (`partner.llm`) — *independent of S1–S4; can land as M27-B*

Exists because a skill cannot call a model at all today: the worker's `partner`
global is `log` + `tools.exec` only, so the single most useful thing a skill
could do ("read these notes and summarize them") is impossible. `PLAN-M28.md`'s
Flow canvas depends on this slice for its `llm` node, and a code-authored skill
gets the same reach for free.

- `core/src/skills/worker-runner.mjs`: `partner.llm.complete({prompt, maxTokens?})`
  → `{type:'llm.complete', nonce, prompt, maxTokens}`, answered by
  `{type:'llm.result', nonce, ok, text|error, usage}`. Same nonce/in-flight
  discipline as `tools.exec` (including the concurrency cap), so the worker
  gains no new failure mode.
- `core/src/skills/runner.ts`: the parent handles `llm.complete` — refuse with
  `llm_not_declared` when `permissions.llm !== true`; resolve the provider/model
  per invocation through the existing `resolveChatModel` + `providers.clientFor`
  (`no_provider` when nothing usable is configured, matching chat); accumulate
  `usage` against the skill's token ceiling and fail `budget_exceeded` past it
  (a default ceiling when the manifest declares none); charge the ledger (D13).
- `shared/src/skills.ts`: `SkillPermissions.llm?: boolean`.
- `core/src/skills/manifest.ts`: accept/validate `permissions.llm` (boolean,
  default false) and require a `budget.maxTokens` (or state the default) when
  `llm` is true.
- `core/src/http/capabilities.ts`: `skill.llm` in `CAPABILITIES` (desktop-only
  by the envelope table).
- `core/src/skills/runtime.ts`: the reach vocabulary describes model reach, so
  the authoring prompt, the chat instructions, the validator, the install
  summary and the Studio all say the same sentence.
- Audit: `skill.llm` per call with model + token counts + ms; never the prompt
  or the completion.

## Tests

- `core/test/broker/appScope.test.ts` — an app-scoped tool executes with a
  grant and `projectId:'app'`; without one it enqueues with
  `projectId:'app'` and **no root lookup happens** (a broker with zero roots
  still works); `POST /v1/grants {toolId:'notes.read', projectId:'app'}`
  succeeds while `{toolId:'files.read', projectId:'app'}` is refused; a
  project-scoped tool with `projectId:'app'` is still `unknown_project`.
- `core/test/broker/appScopeCapability.test.ts` — all three app tools map to
  `file.read`: desktop + mobile allowed by the envelope, extension allowed (its
  allowlist already carries `file.read`), unknown class denied.
- `core/test/tools/notes.test.ts` — list/search/read results are structural and
  size-capped; no note body appears in any audit row (lengths/counts only); a
  bad param is `bad_params`, not a queue entry.
- `core/test/skills/mcpReach.test.ts` — a declared+enabled server's tool
  executes; **undeclared** → `mcp_not_declared`; **disabled** → `mcp_disabled`;
  unknown tool → denied; a `low`-ceiling manifest is refused at validate (D6);
  no pending row is ever created (D8); the result cap and budget still apply.
- `core/test/skills/classPropagation.test.ts` — a mobile-class session invoking
  a granted skill is refused at the broker and at the MCP path; the class comes
  from the session row (a body field cannot set it).
- `core/test/skills/llmReach.test.ts` — a skill with `permissions.llm: true`
  completes a model call and gets text back; `llm: false` (and an absent field)
  refuses with `llm_not_declared`; past the declared token ceiling the
  invocation fails `budget_exceeded` **mid-run** and the worker is killed; an
  absent ceiling uses the default rather than running unbounded; no provider →
  `no_provider`; a mobile-class session is denied `skill.llm`; the ledger gains
  one `skill:<id>` row with token counts; neither the audit nor the meta row
  contains the prompt or the completion (asserted).
- `core/test/skills/authoring.test.ts` (extend) — the two new templates produce
  bundles that validate `ok` **and** that the runner accepts; the prompt lists
  the app tool ids and the `mcpServers` shape; the picker set matches what is
  wired (D9).
- Web: `web/test/skill-studio-helpers.test.ts` (extend) — template availability
  gating; the "not granted yet" state for an app tool.

## Exit criteria

- [ ] `ToolScope` widened; `broker.exec` resolves app-scoped tools against
      `APP_SCOPE_ID` with no root lookup; a zero-root broker can grant and run
      `notes.read`.
- [ ] `notes.list/search/read` are read-only, low-risk, `file.read`-mapped, and
      audit rows carry ids/counts/lengths only.
- [ ] Rootless app grants work end to end (route + UI group + Studio hint).
- [ ] `permissions.mcpServers` validates; the runner reaches an enabled server's
      tool and refuses undeclared/disabled/unknown/over-ceiling with coded
      denials and no pending rows.
- [ ] Session class propagates into the runner for broker **and** MCP calls; the
      mobile-with-a-grant case is refused and tested (M20-B S4 closed).
- [ ] Model reach (S5): declared, bounded by the skill's own token ceiling,
      ledger-charged, `skill.llm`-gated, and never logged; a skill without the
      declaration is refused `llm_not_declared`.
- [ ] The notes + MCP templates produce bundles that validate and run; the
      Studio offers a template only when its capability is wired.
- [ ] Suites root + Δ / web + Δ / shared + Δ, zero regressions; typechecks 0;
      web build green; a demo e2e walk runs the notes template against a seeded
      note and the MCP template against a stub stdio server.
- Env-gated: a real MCP server walk against a user-configured server.

*State:* spec only — no code written. Depends on M26 A+B (the drafts store and
the authoring prompt/validator). S1 and S2 are independent and can land in
either order; S3 should land with or before S2; **S5 is independent of S1–S4 and
can be its own landing (M27-B)** — `PLAN-M28.md` (Flow) needs it for its `llm`
node, so if S5 slips, M28 ships without that node.

## Out of scope

- Note **writes** from a skill (`notes.create`/`update`), memory access, asset
  or plan access: v1 skill reads are notes-only, read-only.
- Per-server MCP tool allowlists inside a manifest (declaring a server is the
  unit of consent here).
- MCP **resources/prompts** (only `tools/call` is reachable), MCP over HTTP/SSE
  (the client is stdio), and MCP servers configured *by* a skill.
- App-scoped tools for anything other than notes.
- Signed bundles (M26 L4 keeps that deferred).
- **Embeddings / vector search / streaming** from a skill (`partner.llm.complete`
  is one non-streaming completion); per-call model or provider selection by the
  skill (the persona/route decides); giving a skill the user's raw API key in
  any form.
