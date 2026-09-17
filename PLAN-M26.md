# M26 — Skill authoring: build a skill by talking to the partner

Status: **spec** (not implemented) · Companion to `PLAN.md` §9, §15 (index) ·
Requires: `PLAN-M8.md` (the skills runtime this builds on) ·
Feeds: `PLAN-M27.md` (the two skill capabilities the *notes* and *MCP*
templates need).

## Goal

Today a skill can only be **installed from a checked-in catalog**
(`skills-catalog/*/manifest.json + entry.mjs`, M8). There is no way to *make*
one. M26 adds the missing half of the skills story:

> describe what you want in chat (or in a form) → the partner drafts a real
> skill bundle → you read the code and its permissions → you test-run it in
> the sandbox → you install it, from the chat card or from the Studio.

Three seams, one mechanism:

1. **Drafts** — an inert, editable, per-user staging area for a skill bundle
   (schema + store + routes). Nothing in a draft runs until the owner presses
   Run, and nothing installs without an explicit owner act.
2. **AI-assisted generation** — a *Skill Studio* surface: describe the skill,
   the configured model drafts `manifest.json` + `entry.mjs`, the core
   validates deterministically and shows every problem. Templates make the
   same surface work with **no provider configured**.
3. **Chat authoring** — the persona stages a draft from a conversation
   (`skills.draft`) and may **ask** for it to be installed
   (`skills.requestInstall`), which lands as an approval card in that same
   conversation. The owner's tap is what installs.

The line this milestone draws, in one sentence: **a model may write code and
ask, but only the owner's act makes it executable and installed.** Drafting is
inert, validation is deterministic (never executes), a dry-run is an explicit
owner action, and install is a `skill.install` act — from the Studio button or
from an approval card — never from a tool call.

## Decisions locked by the owner (2026-09-16)

| # | Question | Answer | What it changed in this spec |
|---|---|---|---|
| L1 | Install from chat, or Studio-only? | **Both**, and drafts can be opened in the Studio | Added the `skills.requestInstall` tool, the `pending_tools` install approval kind, the in-chat card, the Studio deep link and a `skills` attention badge. The model still cannot install; it can only ask. |
| L2 | May the chat model iterate on a draft across turns? | **Yes** (default) | `skills.draft` accepts an existing draft id and updates it; each iteration is an audited `skill.draft.update`, so a fix-the-lint-error loop is visible rather than silent. |
| L3 | Which templates ship? | **All** | Two ship **here** (pure · reads-files). The *notes* and *MCP* templates need capabilities no skill has today, so they ship in **`PLAN-M27.md`** — see the dependency note below. |
| L4 | Bundle export/import with signing? | **Build export/import now, defer signing** | Promoted from stretch to a real slice, unsigned. Safe by construction: an imported bundle lands as an **inert draft** (validated, dry-run, owner-installed), i.e. exactly the path a generated one takes — so signing can be added later without changing the trust model. |

## Why the M8 surface is not enough

| M8 fact (verified in this repo) | Consequence for authoring |
|---|---|
| `loadCatalogSkill()` reads a folder under `config.skillsCatalogDir`; install = `cpSync(dir → skillsDir/<id>)` + sha256 of the entry + one `skills` row (`source: 'local'`). | There is no "uninstalled bundle" concept in the DB at all. Authoring needs its own store, because the thing being authored does not exist on disk yet. |
| `validateManifestShape()` is a pure function over parsed JSON (`core/src/skills/catalog.ts`). | Reusable verbatim for drafts — a drafted manifest is held to the *install* bar, not a weaker one. |
| `SkillRunner` refuses to fork when the entry hash ≠ the recorded `sha256` (`integrity`), and already skips the check when `sha256` is empty. | A dry-run reuses that path instead of inventing a second launcher. |
| The worker must `export … run(args)` (default or named) or it `exit(1)`s and the parent reports a bare `crashed`. | A model-authored bundle with a syntax error would fail **silently** from the author's point of view. The dry-run must return the worker's own log lines, or chat iteration is impossible. |
| `AuditService.log(actor, action, target, details)`; M8 rows carry ids/versions/counts and never skill code or logs. | Draft code, the generation prompt and the description are user content: routes return them to the owner's UI, the audit gets a **length**. |
| `capabilityDenial()` gates the machine-power route groups; `skill.install` is desktop-only by construction. | Authoring is a new capability `skill.author`, desktop-only by the same table — not by a new rule. |
| The chat tool pass applies `capabilityDenial` to **broker** tools and dynamic MCP tools only; static external tools (search) are class-ungated (`core/src/chat/toolPass.ts`). | A write-shaped external tool must not inherit that gap: the external-provider seam gains an optional `capability`, applied before execute-vs-queue. |
| `POST /v1/tools/pending/:id` decides through `broker.decide`, which re-execs a **broker tool**. | An install approval cannot ride that path unchanged: the pending row needs a `kind`, the route needs a branch, and `broker.decide` must refuse a non-tool row rather than mis-execute one. |

## Decisions

| # | Decision | Consequence accepted |
|---|---|---|
| D1 | **A draft is data, not a directory.** `code` + `manifest_text` live in a `skill_drafts` row (same encrypted DB as everything else). No second source tree to keep honest. | Draft code is read back from the DB for every validate/run; a bundle is materialized into a temp dir only for a dry-run and wiped in a `finally`. |
| D2 | **Drafting never executes and never installs.** `POST /drafts` stages; `POST /drafts/:id/validate` is static-only; the dry-run and the install are separate, owner-initiated, capability-checked calls. | The chat tools can only reach stage + update + ask. A model cannot cause code execution or an install, structurally, not by prompt discipline. |
| D2b | **An install request is an approval, not an action** (L1). `skills.requestInstall` writes a `pending_tools` row of kind `skill_install`; the chat renders the existing approval card; **the owner's Approve** calls the same `drafts.promote()` the Studio button calls. | The model can ask for a skill to become executable, and the ask is visible in the queue that already exists. One code path installs, so the Studio and the chat cannot diverge. |
| D3 | **Generated code is validated deterministically, not trusted.** Force the slug (never the model's `id`), clamp `budget.timeMs` to the runner ceiling (`MAX_SKILL_TIME_MS`), drop unknown tool ids with an error, refuse `network: true` (`network_not_supported`), refuse an entry that exports no `run`. | A drafted manifest that would be refused at install is refused **at validate**, so the model can fix it in the next turn instead of the user discovering it later. |
| D4 | **An import lint, honestly labelled heuristic.** A draft whose entry contains a bare specifier other than `node:*` is a hard validation error (the sandbox resolves relative + builtins only). | It is a text scan, so it is presented as a lint and the dry-run remains the ground truth — no claim that the lint sandboxes anything. |
| D5 | **The dry-run returns the worker's logs.** `SkillInvokeContext` gains `logSink` + `dirOverride` + `record: false`; the draft route builds the temp dir (never the caller) and streams the redacted lines into the run response. | A load-time crash becomes a readable error in the Studio and in chat, instead of the opaque `crashed` code. Logs stay out of `skill_invocations` and out of the audit. |
| D6 | **Install of an authored draft is a second, explicit act with a consent diff.** New id → create; existing id → update, and a **widened** permission set (tools/risk/network/budget) is refused with `409 permission_change` unless the body carries `acknowledgePermissions: true`, in which case the UI has already shown the before→after table. Applies to BOTH install paths — the approval card shows the same table before it can be approved. | Editing a skill cannot silently acquire new powers. Matches M9's "breaking permission changes force a re-consent prompt". |
| D7 | **Drafts are visible only to the installing profile.** They live in the per-user partition's DB (`data/users/<id>/partner.db`), like installed skills. | No cross-user sharing, no exception to M20's partition rule. |
| D8 | **Chat authoring is advertised, not assumed.** The authoring contract is appended to the persona prompt *and* `skills.draft` / `skills.requestInstall` are advertised as native function tools only when: session class `desktop`, capability `skill.author`, persona independence ≥ `suggest`, and neither tool is banned by persona policy. | No advertisement when it cannot act (the M12/F2 search rule, reused). An `assist` persona gets neither. |
| D9 | **No new editor dependency.** The Studio code field is a token-styled monospace `<textarea>` with a Code/Validation segmented pill. | No Monaco/CodeMirror. A skill entry is ≤ 256 KiB of ES module; a textarea plus a validation panel is the honest tool. |
| D10 | **Generation is one bounded one-shot call**, like daily-summarize and auto-remember: collect the stream, abort past a 256 KiB reply cap or a 60 s timeout. It does **not** settle the chat spend ledger (those paths don't either — recorded, not silently ignored). | A runaway generation cannot fill the DB or the browser. Aligning all core-side model calls onto the ledger is a separate, larger decision. |
| D11 | **DEMO_MODE has a deterministic generator.** With no provider (or in demo), the templates and a canned generator still produce a valid draft, so the whole flow is walkable env-free. | Same convention as the demo provider: the product stays exercisable with no credentials. |
| D12 | **Export/import is unsigned and goes through the same door** (L4). `POST /v1/skills/drafts/:id/bundle` (export) and `POST /v1/skills/drafts/import` (import) move `{manifestText, code}` as JSON; an import **always** creates a draft and never installs. | Signing can be added later without touching the trust model, because a bundle has no privileged path — it is inert until the owner promotes it. The import route is capability-checked and size-capped like any draft write. |
| D13 | **No double counting in the badge.** `skills` joins `ATTENTION_VIEWS` with `drafts` = drafts that validate `ok` and are not installed; an install that is *already* an open approval is counted under `files` only. | The attention model's rule 1 (`web/src/lib/attention.ts`) is extended, not contradicted — one event, one badge — and the phone More sheet aggregates `skills` like any other hidden destination. |

## Dependency note (L3 — the two templates that cannot ship here)

A skill's only reach is `partner.tools.exec(id, params)` → the **broker**. Today
the broker registry is exactly the six `files.*` ids (`FILE_TOOL_MANIFESTS`),
because `broker.exec` requires a **project root** before the grant check
(`roots.getById(projectId)` → `unknown_project`). Therefore:

| Template | Needs | Ships in |
|---|---|---|
| **Pure skill** (args → value) | nothing | **M26** |
| **Reads files under a root** | `files.list/read/search` | **M26** |
| **Notes-shaped** | app-scoped broker tools (`notes.list/search/read`) because notes are not under a project root | `PLAN-M27.md` |
| **Uses an MCP server's tool** | an `mcp:<server>/<tool>` path from the runner (today MCP exists ONLY as a chat-side external tool, never in the broker registry) plus client-class propagation into the runner | `PLAN-M27.md` |

Both are small, well-contained capability additions with their own security
decisions, and both were already flagged as open questions by M20-B S4 ("neither
`core/src/skills/` nor `core/src/mcp/` consults the session's client class
today"). Keeping them in M27 means M26 can land and be walked end-to-end without
waiting on them; the Studio simply does not offer a template it cannot honour.

## Contracts (`shared/src/skills.ts`, `shared/src/tools.ts`)

Additive; every existing fixture keeps compiling.

```ts
/** Widen: an installed skill now records how it got here. */
export type SkillSource = 'local' | 'authored';

export type SkillDraftOrigin = 'generated' | 'template' | 'manual' | 'chat' | 'fork' | 'import';
export type SkillDraftStatus = 'draft' | 'installed';

/** Deterministic result of validating a draft. Never produced by running it. */
export interface SkillDraftValidation {
  ok: boolean;
  /** Manifest shape, unknown tools, missing entry, import lint, size caps. */
  errors: string[];
  /** Plain-language notes (what the declared tools let it do). */
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
  /** Open install-approval row, when the persona asked for one. */
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
}

export type SkillDraftRun =
  | { ok: true; result: unknown; logs: string[]; ms: number }
  | { ok: false; error: string; logs: string[]; ms: number };

export interface PermissionDiffEntry {
  field: 'tools' | 'risk' | 'network' | 'budget.timeMs';
  before: string;
  after: string;
}

export interface SkillDraftInstallResult {
  skill: SkillSummary;
  mode: 'created' | 'updated';
  /** Before → after for a changed permission field (empty on create). */
  permissionDiff: PermissionDiffEntry[];
}

/** POST /v1/skills/drafts/import body (D12): an unsigned bundle. */
export interface SkillBundle {
  version: 1;
  manifestText: string;
  code: string;
}
```

`SkillInvokeContext` (runner) gains:

```ts
{
  personaId?: string;
  signal?: AbortSignal;
  /** Core-owned bundle dir for a draft run (never caller-supplied). */
  dirOverride?: string;
  /** Per-invocation redacted log sink (default: the core console). */
  logSink?: (line: string) => void;
  /** false ⇒ write no skill_invocations row (a dry-run is not history). */
  record?: boolean;
}
```

`PendingToolCall` (`shared/src/tools.ts`) gains, additively:

```ts
  /** 'tool' (default) or a skill-install ask (M26 D2b). */
  kind?: 'tool' | 'skill_install';
  /** The draft an install ask refers to (kind 'skill_install' only). */
  draftId?: string | null;
```

## Data model (schema v20 → v21)

```sql
-- M26 skill authoring (PLAN-M26.md). One row per draft bundle; code and
-- manifest text are the owner's own content, stored in the same encrypted DB
-- as everything else. Nothing here is executable until installed.
CREATE TABLE IF NOT EXISTS skill_drafts (
  id TEXT PRIMARY KEY,              -- slug; a valid installed id or it cannot install
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,             -- 'draft' | 'installed'
  origin TEXT NOT NULL,             -- 'generated' | 'template' | 'manual' | 'chat' | 'fork' | 'import'
  manifest_json TEXT,               -- parsed+normalized manifest, NULL while invalid
  manifest_text TEXT NOT NULL,      -- exactly what the owner/model wrote (editable)
  code TEXT NOT NULL,               -- entry.mjs source
  prompt TEXT NOT NULL DEFAULT '',  -- the description it was generated from
  model TEXT,                       -- which model drafted it; NULL for manual/template
  validation_json TEXT NOT NULL,    -- SkillDraftValidation
  conversation_id TEXT,             -- set for chat-authored drafts
  persona_id TEXT,
  installed_version TEXT,           -- set on promote (audit trail of what shipped)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_drafts_status ON skill_drafts (status, updated_at DESC);
```

Plus two additive columns on `pending_tools` (guarded `ensureColumn`, the
existing v12/v20 pattern in `core/src/stores/db.ts`):

```sql
ALTER TABLE pending_tools ADD COLUMN kind TEXT NOT NULL DEFAULT 'tool';
ALTER TABLE pending_tools ADD COLUMN draft_id TEXT;
```

`SCHEMA_VERSION` 20 → **21**. No new column on `skills` (the authored/`local`
distinction is the `source` column M8 already has, now widened in the wire type).

`config.skillRunsDir` — a core-owned temp root for materialized draft runs:
`join(tmpdir(), 'partner-draft-runs')` in demo, `join(dirname(dbPath), 'skill-runs')`
when live, `SKILL_RUNS_DIR` override (mirrors `skillsDir`'s derivation and the
packaged-shell override). Wiped per run; never scanned for installable skills.

## Core API (authed, loopback)

All under the existing pairing/session gate. The capability column is the
**additional** gate; every route is 401 without a session and 501
`not_configured` when the drafts manager is absent (the M8 convention).

| Route | Capability | Notes |
|---|---|---|
| `GET /v1/skills/drafts` | — | Summaries only (no code). Newest first. |
| `POST /v1/skills/drafts` | `skill.author` | `{mode:'manual'\|'template'\|'generate', name, description, prompt?, template?, id?}`. `generate` calls the model; `template` scaffolds deterministically. Returns the full draft. |
| `GET /v1/skills/drafts/:id` | — | Full draft incl. `code` + `manifestText` (owner's content). |
| `PUT /v1/skills/drafts/:id` | `skill.author` | `{name?, description?, manifestText?, code?}` → re-validates, returns the updated draft. Refused with 409 once `status='installed'`. |
| `POST /v1/skills/drafts/:id/validate` | `skill.author` | Re-runs the deterministic validation. Never executes code. |
| `POST /v1/skills/drafts/:id/run` | `skill.author` | Dry-run in the sandbox: `{args?, timeoutMs?}` → `SkillDraftRun` incl. redacted logs. Writes one `skill.draft.run` audit row, no invocation row. |
| `POST /v1/skills/drafts/:id/install` | `skill.install` | Promote (Studio path): `{acknowledgePermissions?: boolean}` → `SkillDraftInstallResult`. 400 `invalid_input` when validation fails, 409 `permission_change` on a widened permission set without the ack. |
| `POST /v1/skills/drafts/:id/request-install` | `skill.author` | Persona-authorized ask (D2b): creates a `pending_tools` row (kind `skill_install`, `draft_id`, the conversation). Returns `{pendingId}`. **Creates nothing executable.** |
| `DELETE /v1/skills/drafts/:id` | `skill.author` | Discard: hard delete + close any open install ask for it. |
| `POST /v1/skills/drafts/:id/bundle` | `skill.author` | Export (D12): `{version:1, manifestText, code}` as JSON for the SPA to download. |
| `POST /v1/skills/drafts/import` | `skill.author` | Import (D12): same body → a **new inert draft** (slug de-duplicated), origin `import`. Never installs. |
| `POST /v1/skills/:id/fork` | `skill.author` | Copy an installed skill into a new draft (`<id>-copy`, name + " (copy)"), origin `fork`. 404 when not installed. |

Route ordering: `/v1/skills/drafts` (literal) must be registered **before**
`/v1/skills/:id`, exactly as `/v1/skills/catalog` already is (`server.ts:5594`).
The `:id` param cannot capture `drafts` if the literal routes come first.

`POST /v1/tools/pending/:id` gains a branch: `kind === 'skill_install'` →
`drafts.promote(draftId, {acknowledgePermissions})` instead of `broker.decide`,
returning the same `DecideResult`-ish shape (`{ok, executed, error?, result?}`)
so the existing chat approval card and `continueTurn` flow are unchanged.
`broker.decide` refuses a row whose `kind !== 'tool'` (typed `wrong_kind`) so a
future caller cannot execute a broker tool off the wrong queue.

Audit rows (ids/versions/counts/lengths only — never code, description,
prompt, args or results):

```
skill.draft.create    {origin, mode, hasModel}
skill.draft.update    {changed: ['code'|'manifest'|'name'|'description']}
skill.draft.validate  {ok, errorCount}
skill.draft.run       {ok, error, toolCalls, ms}
skill.draft.install   {mode: 'created'|'updated', version, acked, via: 'studio'|'approval'}
skill.draft.discard   {hasPending: boolean}
skill.draft.export    {version, codeBytes}   -- a LENGTH, never the code
skill.draft.import    {version, codeBytes}
skill.fork            {fromId, version}
```

## Core implementation

- **`core/src/skills/drafts.ts`** (new) — the draft manager: create/update/
  validate/discard/list/get/export/import, `materialize(draft, dir)`,
  `runDraft(...)`, `promote(...)` (the ONE install path both L1 surfaces call),
  `requestInstall(...)`. Everything fs-touching for a run happens here, so the
  routes stay thin.
- **`core/src/skills/manifest.ts`** (new, extracted) — `validateManifestShape`
  moves here from `catalog.ts` and gains `lintEntry(code)` (import lint +
  `export … run|default` presence + size cap). `catalog.ts` re-exports it so
  every existing import and test is untouched.
- **`core/src/skills/runtime.ts`** (new, pure) — the `run(args)` contract text,
  the tool/permission vocabulary and the `permissionSummary(manifest)` renderer
  shared by the authoring prompt, the chat instructions, the Studio helper and
  the approval card, so the four can never drift.
- **`core/src/skills/authoring.ts`** (new, pure) — `buildAuthoringPrompt({description,
  toolRegistry, templates})`, `parseAuthoringReply(text)` (fence stripping;
  first `{` → last `}`; `{manifest, code}` shape), `normalizeAuthoredBundle(raw,
  {slug, tools})` (D3's forcing/clamping/dropping), `templateBundle(template, name)`.
  No I/O, no model — unit-testable without a provider.
- **`core/src/skills/generate.ts`** (new) — the one-shot call: resolve
  provider/model through `resolveChatModel` + `providers.clientFor` (the
  `notes/index.ts` pattern), stream-collect with the reply cap + timeout,
  return `{manifestText, code, model}` or a typed failure. In demo mode it
  delegates to the deterministic generator.
- **`core/src/skills/tool.ts`** (new) — `authoringToolExternal(options)`: the
  two tools (`skills.draft`, `skills.requestInstall`) as one external provider
  (manifest, `allow()`, `exec()`), mirroring `core/src/search/tool.ts`.
- **`core/src/skills/manager.ts`** — add `installFromDraft(loaded, {mode})`
  (used by promote; reuses `removeTree`, hashing, and the row upsert) and
  `fork(id) → {manifest, code}` (reads the installed entry). `install(catalogId)`
  keeps its current behaviour and tests.
- **`core/src/skills/runner.ts`** — honour `ctx.dirOverride` / `ctx.logSink` /
  `ctx.record` (D5). Three small changes, each with a test.
- **`core/src/broker/pending.ts`** — carry `kind` + `draftId` through
  enqueue/list/get; `broker.decide` refuses `kind !== 'tool'`.
- **`core/src/chat/toolPass.ts`** — the external-provider shape gains an
  optional `capability?: Capability`; when set, `capabilityDenial(clientClass,
  provider.capability)` runs **before** execute-vs-queue, with
  `capability.denied` audited and a system note emitted (the existing pattern
  for broker tools). Applied to the authoring provider; `mcp.call` is left as
  it is so no working flow changes.
- **`core/src/chat/instructions.ts`** — `authoringInstructions(toolIds)`:
  the manifest contract, the `run(args)` + `partner` global contract, the exact
  allowed tool ids, the caps, "no network", and the two sentences *"you cannot
  install a skill; the user installs it — you may ask with
  `skills.requestInstall`"* and *"re-call `skills.draft` with the same id to fix
  validation errors"*. Appended only under D8's conditions.
- **`core/src/http/server.ts`** — the draft routes, the pending-route branch,
  the chat-tool advertisement (the `advertiseTools` block at `:2839` gains two
  more `tools.push`es, exactly like search at `:2856`), the tool-pass wiring
  (the `externalTools` array at `:2950` gains `authoringToolExternal(options)`),
  and the capability plumbing for the new route group.
- **`core/src/http/capabilities.ts`** — `skill.author` joins `CAPABILITIES`.
  Desktop gets it (desktop = the full vocabulary); mobile and extension do not,
  because they are allowlists. No other change, and a test asserts the denial.
- **`core/src/index.ts` / `config.ts`** — construct the drafts manager +
  generator, pass them on `CoreAppOptions`, add `skillRunsDir`.

## Chat authoring (the "build it from chat" flow)

1. The user says *"build me a skill that turns my scratch notes into a
   checklist"*.
2. Because D8 holds, the turn carries the authoring contract in the system
   prompt and both authoring tools in the advertised functions.
3. The model emits a native `skills.draft` call (the directive form
   `[[partner:tool skills.draft {…}]]` also works for models without native tool
   calls — both channels already exist and share one handler).
4. The tool pass validates + stages the draft. The system note is honest about
   what happened:

   > Drafted skill "scratch-to-checklist" (validation: 1 problem — `files.read`
   > is not a tool id; did you mean `files.search`?). Nothing has been
   > installed. Open **Skills ▸ Build** to review, test and install it.

5. The model may then fix and re-stage (L2) until validation is `ok`, and may
   call `skills.requestInstall`. That writes the approval row, and the chat
   renders the card:

   > **Install "scratch-to-checklist"?** It can read and search files under a
   > root you grant. It cannot reach the network. [Approve] [Review in Studio]
   > [Deny]

   *Approve* calls `promote()` — the same function the Studio button calls — and
   the existing `continueTurn` lets the persona answer in the same interaction.
   *Review in Studio* switches views with the draft focused. *Deny* closes the
   ask and keeps the draft.
6. The `skills` nav destination badges drafts that are validated and ready
   (D13).

Refusals are named, not silent: `assist` personas get no authoring (no
advertisement, no instructions); a banned `skills.draft` refuses at the gate; a
non-desktop session is refused by class with the existing "not available to this
device" note.

## Web

`web/src/SkillsView.tsx` already switches on `segment: 'installed' | 'catalog'`.
M26 adds `'studio'` as a third segment (`Build`), plus `web/src/SkillStudio.tsx`
for the work area (kept out of the 934-line view file), and the pieces the chat
card needs.

- **Deep link (L1).** `App.tsx` lifts `studioFocus: {draftId} | null`; the chat
  card's *Review in Studio* sets it and `setView('skills')`; `SkillsView` opens
  the Studio segment focused on that draft and clears the intent. No router
  dependency, matching the existing `onOpen={() => setView('notes')}` pattern.
- **Left rail — drafts.** Name, origin chip (`from chat` / `generated` /
  `template` / `fork` / `imported`), validation state (`ok` / `n problems`),
  updated time, and an `awaiting your approval` marker when a
  `pendingInstallId` is open. A chat-authored draft links to its conversation.
- **Empty state — invite action.** "Describe the skill you want" + the template
  picker (Pure skill · Reads files under a root). The picker lists only what the
  registry actually offers — M27 adds the other two when they exist.
- **Generate.** A description field → `POST /v1/skills/drafts {mode:'generate'}`
  → the draft opens; with no provider configured the button is replaced by the
  honest line "Connect a provider to generate, or start from a template".
- **Editor.** Manifest fields (id read-only after creation, name, description,
  version, tools multi-select from the registry, risk select, budget ms) + the
  entry `code` textarea (monospace, token-styled) + Code/Validation segmented
  pill. Unsaved edits are guarded by the existing two-step arming pattern.
- **Validation panel.** `ok` or the error list with the offending field named;
  warnings rendered as plain language ("this skill may read files under a root
  you grant; it cannot reach the network").
- **Test run.** Args JSON (64 KiB client-side guard), Run → result or the coded
  error **plus the worker's log lines** (D5), and the tool calls the run
  attempted. States: idle / running / ok / error, `aria-busy` while running.
- **Install.** Two-step: the confirmation shows name, version, the
  plain-language permission summary, the tool list, and — on an update — the
  before→after permission table (required for `acknowledgePermissions`). The
  approval card in chat shows the same summary via the shared renderer.
- **Export / Import** (D12): a download of the bundle JSON, and a file picker
  that lands as a new draft. Copy states the trust position plainly: *"Imported
  skills are drafts — nothing runs until you test and install them."*
- **Discard** with the existing two-step arming pattern.

Styling is token-only, reusing `.card`, `.btn`, `.field`, `.skill-chip*`,
`.segmented`, `--target-min`; no new shadow recipe and no new colour.

## Tests (TDD, red → green)

Core
- `core/test/skills/manifest.test.ts` — shape validation parity after the
  extraction (the M8 cases move, none weaken); `lintEntry` accepts
  `export function run` / `export default (…)`, `node:` + relative imports;
  refuses a bare specifier, a 300 KiB entry, and no-export source.
- `core/test/skills/authoring.test.ts` — the prompt embeds the **exact**
  registry ids and the caps; parsing handles fenced JSON, prose around JSON,
  and a malformed reply (typed failure); normalize forces the slug (a model
  that returns `id: "../../evil"` cannot escape), clamps `timeMs` to the
  runner ceiling, drops an unknown tool with an error, refuses `network: true`;
  the templates produce a bundle that validates `ok`.
- `core/test/skills/drafts.test.ts` — CRUD; validate reports shape/registry/lint
  errors and never executes (a draft whose code throws at import time still
  validates); materialize → dir contents → wiped after; discard deletes and
  closes an open ask.
- `core/test/skills/draftRun.test.ts` — the dry-run uses the sandbox (cwd inside
  the materialized dir, minimal env), returns redacted logs, honours the budget
  (`budget_exceeded`), the 1 MiB result cap (`caps_exceeded`), refuses a tool
  the manifest does not declare (`tool_denied`), writes **no** `skill_invocations`
  row, and one `skill.draft.run` audit row with counts only.
- `core/test/skills/promote.test.ts` — create installs with `source:'authored'`
  and a fresh sha256; a second install under the same id with an unchanged
  manifest updates in place; a widened tool set/risk returns
  `permission_change`, and with `acknowledgePermissions` installs and audits
  `acked: true`; an invalid draft is refused with no filesystem write; **the
  Studio path and the approval path produce byte-identical rows** (one install
  implementation, asserted).
- `core/test/skills/installApproval.test.ts` — `request-install` creates a
  pending row (kind `skill_install`, draftId, conversation) and **no** skill
  row; approving it promotes and returns the created skill; denying leaves the
  draft intact; `broker.decide` on that row returns `wrong_kind` and executes
  nothing; a `skill_install` row shows up in `GET /v1/tools/pending` with its
  draft name and NOT in the broker path.
- `core/test/skills/bundle.test.ts` — export → import round-trips into an inert
  draft with a de-duplicated slug; an import never creates an installed skill;
  a malformed or oversized bundle is refused; the audit rows carry a byte length
  and never the code (asserted).
- `core/test/skills/fork.test.ts` — fork copies the installed entry verbatim
  and asks for a new slug; unknown id 404s.
- `core/test/chat/skillAuthorTool.test.ts` — the contract + both tools appear
  only under D8 (desktop · capability · ≥ suggest · not banned); the tool stages
  a draft and returns validation errors; a bad id can be re-drafted to `ok` in a
  second call (L2); **the advertised id set contains no running or installing
  tool** (asserted); a mobile-class turn is refused by class with the device
  note; a refused/denied call is audited.
- `core/test/http/skillDraftsRoutes.test.ts` — 401 without a session, 501 with
  no manager, 400 on bad bodies, 404 on unknown draft, 409 on install of an
  installed draft / a widened permission set, and: **no audit row contains
  draft code, the description or the prompt** (the AGENTS.md rule, asserted).

Web
- `web/test/skills-drafts-api.test.ts` — every new client function against a
  fake fetch: envelope tolerance, coded-error mapping, 401 → session lost.
- `web/test/skill-studio-helpers.test.ts` — pure helpers: id slugging +
  de-duplication, the validation summary line, the permission-diff table rows,
  the install-confirm required-field set, args JSON guard.
- `web/test/skills-studio-view.test.tsx` — segment plumbing, the deep-link
  focus intent, empty vs loading vs error states, two-step install arming,
  generate-disabled-without-provider.
- `web/test/attention.test.ts` (extend) — the `skills` count, and **no double
  counting** with an open install approval (D13); the phone More aggregate
  includes it.

E2E (demo core, no credentials)
- `core/test/e2e/skillAuthoring.test.ts` — boot demo → create a draft from a
  template → validate → dry-run → install → `GET /v1/skills` lists it with
  `source:'authored'` → invoke → uninstall → the draft id is gone from the store.
- `core/test/e2e/skillAuthoringChat.test.ts` — a chat turn whose reply carries a
  `skills.draft` directive + `skills.requestInstall` stages the draft and opens
  the approval; approving installs; the persona's continuation answer lands.

Docs
- `docs/VERIFY-M26.md` — the measured record (suites, typechecks, build,
  `ux_audit` payload + result, the demo walks, and the env-gated real-endpoint
  generation walk).

*State:* **COMPLETE except the two templates that need M27** (2026-09-16).
Measured record: `docs/VERIFY-M26.md` — root **1468 passed / 5 env-gated skips** ·
shared **90** · web **851** · typechecks 0 · web build green · `ux_audit` PASSED
(16 token pairs, light + dark).

Landed: the drafts core + schema **v21** + the route surface, with
`permissions.mcpServers`/`llm` shape-validated but REFUSED until M27 wires them
(a `RuntimeCapabilities` gate, so a declaration that would do nothing is a named
error rather than a silent no-op) · `core/src/skills/manifest.ts` (the extracted
shape validator + `lintEntry`), `runtime.ts` (the shared reach vocabulary +
`permissionSummary`), `templates.ts` (pure + reads-files, capability-filtered),
`authoring.ts` (prompt/parse/normalize), `generate.ts` (one bounded call + a
deterministic demo fallback), `tool.ts` (the two inert chat tools),
`drafts.ts` (lifecycle, `slugifySkillId`, `permissionDiff`, the ONE `promote`,
`runDraft`, bundle export/import) · `manager.ts`
`installFromBundle`/`readEntrySource` · `broker/pending.ts` kind/draftId +
`wrong_kind`/`settleInstall` · the chat tool pass class gate + the install
approval branch · `skill.author` (desktop-only) · the Studio Build segment with
the editor, validation, dry-run, two-step install, fork/edit, export/import,
deep link and the `skills` attention badge.

**Remaining:** nothing in M26 itself. The *notes* and *MCP* templates that were
waiting on `PLAN-M27.md` S1/S2 **landed with M27 S4 (2026-09-17)**; the picker is
capability-filtered, so it offers only what this build can honour.
Env-gated and NOT run: a live-endpoint generation walk, and a packaged-app Studio
walk.

*Was:* cut A landed 2026-09-16.
Delivered: the `shared` draft contracts (`SkillSource` widened to
`'local' | 'authored'`; `permissions.mcpServers`/`llm` shape-validated but
REFUSED until M27 wires them, via a `RuntimeCapabilities` gate so a declaration
that would do nothing is a named error rather than a silent no-op);
`core/src/skills/manifest.ts` (the extracted shape validator + the new
`lintEntry` + the capability gate); `core/src/skills/runtime.ts` (the shared
reach vocabulary + `permissionSummary`); `core/src/skills/templates.ts`
(pure + reads-files, capability-filtered); `core/src/skills/drafts.ts`
(lifecycle, `slugifySkillId`, `permissionDiff`, the ONE `promote`);
`manager.ts` `installFromBundle`/`readEntrySource` (the only door into the
store); `broker/pending.ts` kind/draftId + `wrong_kind`;
`http/capabilities.ts` `skill.author`; schema **v21**; and the route surface
above. Remaining: **B** the generator + the other two templates (M27) · **C** the
chat tools + the install approval card · **D** the Studio UI · **E** the dry-run
and unsigned bundle export/import · **F** their verify record.

## Exit criteria

- [ ] Schema v21 (`skill_drafts` + two `pending_tools` columns), additive; an
      existing v20 DB opens unchanged (one test).
- [ ] Draft lifecycle green: create → validate → dry-run → install/update +
      re-consent → discard, plus fork, plus export/import.
- [ ] Deterministic validation covers shape, registry, import lint, caps;
      unknown tools and `network: true` are refused with named errors.
- [ ] Chat authoring: contract + both tools advertised only under D8; a chat
      turn stages a draft and can ask for install; approving the card installs
      through the same `promote()` as the Studio; **no tool runs or installs**.
- [ ] `skill.author` is desktop-only, asserted for mobile and extension; the
      class is propagated into the authoring external tools.
- [ ] Audit discipline asserted: no draft code, description, prompt, args,
      result, log line or bundle body in any audit row; lengths/counts only.
- [ ] Studio usable with **no provider** (templates) and with one (generate);
      the deep link from the chat card lands on the right draft; the `skills`
      badge counts ready drafts without double counting an open approval.
      Token-only; `ux_audit` PASSED on the composed stylesheet.
- [ ] Suites: root + Δ, web + Δ, shared + Δ, **zero regressions**; typechecks 0;
      web build green; both demo e2e walks green.
- Env-gated (recorded, not claimed): a real-endpoint generation walk against
  the user's own LiteLLM endpoint, and a packaged-app Studio walk.

*State:* **COMPLETE** (2026-09-16; the notes/MCP templates completed it on
2026-09-17 as `PLAN-M27.md` S4). Slices A drafts core (+ schema) · B generator ·
C chat authoring + install approval · D Studio + deep link + badge ·
E export/import · F docs/verify — all landed, and the Studio offers only the
templates this build can honour.

## Out of scope (v1)

- A hosted/signed gallery; publishing an authored skill to anyone else; bundle
  **signing** (L4 — export/import ships unsigned and unprivileged).
- Network-capable skills (`network: true` stays refused).
- Sandboxing the *generating* model's output beyond the deterministic gates +
  the existing worker sandbox (no AST analysis, no proof of purity).
- A skill marketplace, ratings, or sharing between users/partitions.
- Multi-file skill bundles (entry + assets): v1 authored bundles are exactly
  `manifest.json` + one `entry.mjs`. Assets are a follow-up (they already
  survive the *installed* copy path).
- Aligning core-side one-shot model calls onto the chat spend ledger (D10's
  recorded gap, not fixed here).
- The *notes* and *MCP* templates — landed with `PLAN-M27.md` S4 (they needed
  S1's app-scoped tools and S2's MCP reach first).
