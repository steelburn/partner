# UNFINISHED — the review list for the next session

Date: 2026-09-19 (updated at `v0.1.26`) · Index: `PLAN.md` §15 · Specs:
`PLAN-M34.md`, `PLAN-M35.md`, `PLAN-M36.md`, `PLAN-M37.md` · Records:
`docs/VERIFY-M34.md`, `docs/VERIFY-M35.md`, `docs/VERIFY-M36.md`,
`docs/VERIFY-M37.md`.

This file exists because session context does not survive. It is a **review
list**, not a spec: each item says what is left, where it goes, what it depends
on, and what is already true. Read the spec for detail; read the verify docs for
what was measured.

State at the time of writing: `v0.1.26` released, with **M29–M37 on `master`**
(the parent owns releases); schema **v24**; root **1812 passed** (5 env-gated
skips), shared **90**, web **1084**, typechecks 0, web build green. Zero open
Dependabot alerts. (Earlier states: `v0.1.25` released with M34/M35 on `master`
and root 1812/shared 90/web 1048; `v0.1.23` with M29 and root 1766/shared 90/web
944 — §0-M29–M33 below record what those added. The §0-M32 folder open end was
closed by M34, and the M34 phone open end by M35.)

---

## 0-M35. M35 — Folders as an Explorer

Landed 2026-09-18 on top of M34; **no schema change, no core route change**. What
is true (all with tests): the Folders page is an Explorer — a navigation pane
(the same `ConversationRail` in a new folders-only `nav` mode: selectable rows, a
selectable `All folders` root, every folder control unchanged) beside a contents
pane (`FolderContents`: the open folder's subfolders then chats, columns
Name · Type · Items · Modified, the shared `FolderActions` / `ChatActions` on each
row), with an address bar (`↑ Up`, a breadcrumb of controls, item count) and one
Create action scoped to the open folder. One tree definition
(`web/src/lib/folder-tree.ts` — it now owns `folderSubtreeIds` / `folderTreeRows`,
which `note-helpers.ts` re-exports for its callers) backs both panes. The
selection is clamped against the live folder list, and the phone tier stacks the
panes and drops the metadata columns.

**Also fixed:** `.folder-action-confirm` (armed delete) was `--accent-contrast` on
a `--danger` fill — dark mode measured **APCA Lc −17.3 / WCAG 1.32:1**, an
unreadable confirm. It now takes its own `--bg` ground with `--danger` text and a
2px danger ring (Lc 80.9 light / 80.5 dark).

**Open ends:**

1. **Items is a subtree number, the rail badge is not.** Contents rows count a
   folder plus everything under it; the rail's per-folder badge keeps M34's
   direct-child meaning (open end 2 above, still true). Both are documented in
   `lib/folder-tree.ts`; they are deliberately different, but a reader comparing
   the two surfaces can still be surprised.
2. **`All folders` shows every chat, not the Inbox bucket.** The root row's badge
   counts all chats (a drive that read "0" while holding subfolders contradicted
   the pane beside it). The Inbox count now lives only in the rail's non-`nav`
   tree and in the page's stats line.
3. **No folder *move* in the UI.** You can create, rename and delete a folder, and
   file chats into it, but re-parenting an existing folder (`PUT /v1/folders/:id
   {parentId}`) still has no control — the core supports it and the manager
   cycle-guards it. That would be a new gesture (a folder-row drag), not a fix.
4. **`assetCount` is per-request, not cached.** `ConversationManager.list()` runs
   one grouped count per call (the same shape `messageCount` already uses), so a
   long list pays one extra query — measured as negligible at demo scale, but it
   is a query per refresh rather than a stored column. A stored counter would
   need a schema version, a backfill and an invalidation rule for every asset
   create/delete; the derived read was chosen deliberately.
5. **The phone overlay does not show assets.** The Conversations rail (phone
   tier) still renders `4 msgs · 5m ago` in a chat row; the asset count lives on
   the Folders page, where the owner asked for it. Adding it to the rail's meta
   line is a separate decision about that surface's density.

---

## 0-M34. M34 — Folders as a first-class section, and a session title you can
name or have suggested

Landed 2026-09-18 on top of M33; **no schema change**. What is true (all with
tests): a chat session has **two independent organizations** — the persona that
runs it (the tree under Personas, M32) and the folder it is filed in (the new
**Folders** destination in the sidebar's Workspace group, reachable on a phone
from the More sheet). `FoldersView` owns only page chrome and renders the SAME
`ConversationRail` in its `embedded` form, so the folder controls M32 orphaned
(create / rename / delete, drag-to-move, the move select) are back on desktop
with exactly one definition. The chat's top now shows the **session title**
(editable in place: Save / Cancel / Escape, clamped to 120 chars) plus **Suggest
title**, enabled from the second user turn. A suggestion is a PROPOSAL:
`POST /v1/conversations/:id/title-suggestion` runs ONE bounded model call
(`runBoundedModelCall` — the shared 256 KiB / 60 s bound), stores nothing, and
answers 200 with either `{ok:true,title,model,source,userTurns,messageCount}` or
`{ok:false,code,message}`. Accepting it goes through the ordinary
`PUT /v1/conversations/:id`. Audit rows carry counts + the title LENGTH, never
content.

**Open ends:**

1. **The phone tier was not re-measured.** Folders reaches the phone through the
   More sheet, the embedded rail is content-height there, and the folder row's
   actions are now revealed on `(hover: none)` — but no 360–430px walk of the
   Folders page was run. The desktop walk (1440, light + dark) is recorded in
   `docs/VERIFY-M34.md`, together with the two defects it found and the fixes.
   **Closed by M35** (`docs/VERIFY-M35.md`): the page was measured at 390×844 —
   no horizontal overflow, no target under 44px, panes stacked, metadata columns
   dropped.
2. **Folder counts are direct-child only.** `Folder.chatCount` counts chats
   filed *directly* in a folder (its own doc says so), and `folderStats` on the
   page counts the same way — so a parent folder with only nested children reads
   a count that does not include them. Deliberate for now (the tree shows the
   children), but it is the one number on the page that could mislead.
3. **A suggestion does not auto-offer.** After a few turns the user presses
   **Suggest title**; nothing prompts on its own. An automatic inline hint at
   the threshold would be a new decision, not a fix.
4. **Re-filing a chat on touch still has no drag.** `(hover: none)` hides the
   drag handle and reveals the move `<select>` instead, so touch re-filing works
   but through a select rather than a gesture. That was already true before M34
   (the M20.A addendum); the Folders page just makes it more visible.

---

## 0-M32. M32 — persona-owned sessions, resizable menu, Catalog deck, tracked memory

Landed 2026-09-18 on top of M30/M31; no schema change. What is true (all with
tests): the session tree nests under **Personas** (`PersonaChatTree`, pure
`groupConversations`, an explicit **Unassigned** group); the Skills **Catalog**
is a Personas-style card deck with a slide-out `CatalogDrawer`; the sidebar is
drag-resizable 180–420px through the shared `ColumnDivider`
(`partner.sideWidth`, session-only); Memory ties a pending suggestion to a
persona in one step, shows rejected facts in a **Rejected** panel with Restore,
and the extractor now receives a `REJECTED` block as well as `ALREADY KNOWN`; and
the chat transcript renders a fenced HTML/CSS block as code, not an inline
sandboxed iframe (`allowInlineCodePreview` is off in Chat only).

**Open ends:**

1. ~~**Folder management lost its desktop home.**~~ **RESOLVED in M34** — the
   owner chose the "dedicated Folders section" option. Folders is now a
   Workspace destination rendering the same embedded `ConversationRail`, so
   create/rename/delete and drag-to-move are live on desktop again and the
   `embedded` prop is used rather than dead. See §0-M34 above.
2. **The phone tier was not re-measured.** The persona tree is bounded and
   scrolls, and the disclosure keeps the tablet `--target-min` floor, but no
   360–430px walk of the new tree was run.
3. **The Memory rejected panel / suggestion scope select have unit coverage but
   no live walk.** The extractor change is directly tested; the two new UI
   affordances were looked at once at 1440.

---

## 0-M29. M29 — the multi-user lifecycle (do not redo; the open ends)

Landed 2026-09-18, schema v23. Spec `PLAN-M29.md`, record `docs/VERIFY-M29.md`.

**What is now true** (all with tests): sign out closes the partition, not just
the session (`POST /v1/auth/signout` → `rails.close` + vault lock); an owner
mints/lists/revokes single-use invitations from the Members view (roles +
`key_access`, code hash only, conditional consume, no escalation, shape errors
and taken names refused before the invite is spent); a `keyAccess:'shared'`
member rides the owner's published provider + search configuration while they
have none of their own; each account's file root is `<volume>/<userId>` (or
`<partition>/files`) with `rootsFixed: true` in login mode; and notes/assets
share as snapshot copies in the system DB (read/import/refresh/revoke, no
cross-partition read).

**Open ends, in the order I would take them:**

1. **A live model turn through shared access is NOT verified.** The published
   provider's config and key resolution are tested, but no real endpoint was
   called with it (no endpoint in this workspace). Same for shared search.
2. **A second real container account has not been provisioned and signed in.**
   Two users are proven in-process; the container was refreshed, not multi-user
   walked.
3. **`FIXED_ROOTS` migration is manual.** Files sitting at the volume root are
   invisible after this change; `docker/server/README.md` documents the one-line
   `mv` into `/files/<userId>`. An operator must run it once.
4. **No per-user quota or shared-spend cap.** A member riding shared access
   spends against the OWNER's provider budget (`budgets` are per provider row).
   A hosted multi-user core wants an operator-level cap keyed by user — this is
   the M22 "R11" item, still open.
5. **Asset sharing has no Assets-pane action.** A share is created from the
   Shared view; the note/asset itself has no "Share" button where you are
   reading it. Deliberate scope, but the natural next UI.
6. **Invitation redemptions do not notify the owner.** The list shows `used by
   <id>` on the next load; there is no push/badge.
7. **The M29 views were not measured at the phone tier.** They render at desktop
   width and are reachable from the More sheet; the 360–430px geometry was not
   re-measured for these two pages.

---

## 0. What landed on master since v0.1.19 — do not redo

### The 2026-09-18 sample set + the update ask (catalog, templates, chat)

Two additive changes on top of the Studio fixups; neither moves a schema or a
route signature.

1. **A reference set in the catalog, mirrored by one template.** Three new
   checked-in bundles — `file-inventory` (`files.list` only), `content-audit`
   (`files.search` only) and `notes-digest` (`notes.list|search|read`) — plus
   `skills-catalog/README.md` stating the three rules they follow (narrowest
   declared reach; a refusal reported as a CODE, never an empty result; bounds
   with an explicit `truncated`). `content-audit` exists a second time as the
   Studio template `content-audit`, so "install from the Catalog" and "start
   from a template" are two doors onto one worked example. Both halves are held
to a real run: `core/test/skills/catalogSet.test.ts` installs and INVOKES all
   three through the real sandbox (including the no-grant `tool_denied` refusal),
   and `templates.test.ts` dry-runs the template against a granted root. The
   template + catalog lists in four tests were updated deliberately (that is the
   house rule for a picker list).
2. **A persona can propose an UPDATE to an installed skill, and the owner can
   grant it where the ask appears.** `skills.draft` gained an optional `skillId`
   (`SkillDraftManager.openUpdate()` opens the skill's `edit` draft, bound to the
   installed id; the tool result reports `mode:'update'`, the installed version
   and the before→after `changes`, and says plainly when it WIDENS). The gap it
   closes was one-directional: a persona could create a NEW skill and ask to
   install it, but had no way to propose a change to one the user already has.
   On the web side `web/src/SkillInstallCard.tsx` renders the ask (chat + Files
   queue) with the draft's permission summary, the version it moves from → to,
   and the change table for a widening — and sends `acknowledgePermissions` only
   when that table is on screen (the same rule the Studio applies;
   `skillInstallDecision()` is the whole rule). A `permission_change` refusal is
   rendered as the next step AND re-reads the draft, so the table it asks about is
   actually displayed rather than promised. Walked live end to end: a widened
   update was refused unacknowledged, the card showed the table, the confirm
   applied it in place (v0.1.0 → v0.2.0, one skill), and the queue emptied.

**What this does NOT change:** a skill still cannot install or run itself, the
`skill.author`/`skill.install` class gates still apply, a widening still cannot
be approved without the acknowledgement, and `permissions.network: true` is
still refused (see the previous answer's §0 for what a network/exec reach would
actually need — that decision is untouched).

### The 2026-09-18 deploy fixup — the container could never run a skill

Refreshing the live container found two deployment defects. Both are fixed and
measured; **do not re-open them, and do not "simplify" either away**:

1. **The image shipped no skill worker harness.** `runner.ts` forks
   `worker-runner.mjs` as its own process; in a bundled CJS artifact
   `import.meta.url` is empty, so the fallback is
   `join(process.cwd(), 'worker-runner.mjs')` — `/app/worker-runner.mjs` under the
   image's `WORKDIR /app`, a file the Dockerfile never copied. Every skill
   invocation and Studio dry-run in the container failed `no_worker`, and the
   suite could not see it (no test builds the image). The Dockerfile COPYs it,
   both stage scripts stage it from `core/src/skills/`, and `.gitignore` covers
   the staged copy. Proof: a real forked invocation inside the container
   (`ready` → `invoke` → `result ok:true`).
2. **`stage.ps1` did not parse on Windows PowerShell 5.1.** A UTF-8 em dash in a
   double-quoted string is read as a smart quote under the ANSI code page, so the
   string closed early and the script never ran (recorded as "not executed on
   Windows" in `docs/VERIFY-M21.md`). It is ASCII-only now — keep it that way, or
   give the file a BOM — and `shell/windows/build-windows.ps1` had the same
   one-line hazard, fixed too. Run end to end on Windows on 2026-09-18: build →
   staging → cert reuse → image → container recreated healthy; the public host
   answers 200 and the `/data` volume (account, DB, keychain) is intact.

The live deployment (`partner.teliti.app`, `partner-server:local`) was refreshed
with this image and is `demo=off`, `authMode=login`, schema v22, `hasUsers=true`.

### The 2026-09-18 Studio fixup — four review findings (M26 D / M28 C surfaces)

A live walk of the Build segment (real browser, demo core: template create →
edit → dry-run → install → update → discard → uninstall) found four defects. All
four are fixed, each with a test that fails without the fix. **Do not re-open
these as "possible issues", and do not re-fix them the other way round:**

1. **Draft description (two fields, one name).** `SkillDraft.description` is the
   ROW's ("what the draft was generated from", `''` for template/blank) and
   `manifest.description` is the skill's own. The editor seeded its Description
   field from the row and wrote the field into the manifest, so the first save
   of a template or blank draft replaced a real description with `''` and the
   draft failed `description is required` — with the field then unable to fix it
   (a manifest that does not parse is edited as raw JSON). Fix: the field is
   seeded from the MANIFEST (`draftDescription()`, and the dirty check uses the
   same seed), and `create()`/`stageFromChat()` write the manifest's description
   into the row (`rowDescriptionOf()`) so they cannot start out different.
   Tests: `core/test/skills/drafts.test.ts` (row == manifest for template/blank/
   typed) and the `Description field` describe in
   `web/test/skills-studio-view.test.tsx` (the field renders the manifest's value
   for a row whose description is `''`).
2. **The deep-link intent was resolved against a stale rail.** `Edit in Studio`
   and `Fork` create the draft server-side, and the Studio's rail only reloads
   when the Skills VIEW becomes active — so the intent named a draft the loaded
   list did not have, `resolveSelectedDraft` fell through to `drafts[0]`, and the
   owner was shown an unrelated read-only draft (the rail also disagreed with the
   nav badge until a reload). Fix: `pendingFocusId` holds the intent until its
   detail has loaded (cleared on success or on an explicit row pick), and
   `SkillsView` bumps a `reloadToken` when Edit/Fork creates a draft. The rule
   `resolveSelectedDraft` implements is unchanged.
3. **A draft could not be created once one existed.** `DraftEmptyState` — the
   only caller of `createDraft` — renders at `drafts.length === 0`, so the moment
   an owner had one draft, generate / start-blank / create-from-template were
   gone and the only way back was to discard everything. Fix: the rail header
   offers **New draft** (`.studio-pane-head` + `.btn .btn-secondary .btn-sm`; no
   CSS added) and the form moved to `web/src/studio/DraftComposer.tsx`, mounted
   by the empty state AND the new action. The empty state keeps the invitation
   copy and the numbered guide.
4. **A thrown run reported a code and nothing else.** `skill_error` with an
   empty Worker log is the opaque answer the dry-run exists to remove. Fix:
   `finalizeError()` (and the un-serializable-result path) in
   `core/src/skills/worker-runner.mjs` emit the cause as an ordinary log line —
   `skill error (skill_error): Error: …`, redacted by the parent like any other
   log. Test: `core/test/skills/draftRun.test.ts` (message present, secret
   redacted, `run.logs` still empty on the success path).

**Not walked after the fixup:** the chat card's "Review in Studio" (the other
producer of the same intent — it reloads on view activation, so it was never the
broken path, but it is unproven), live-model generation, and the packaged
Studio.

### M28 slice B — the flow routes + derived staleness (schema v22)

`core/src/skills/drafts.ts` (`getFlow` / `saveFlow` / `compileFlow`), the three
routes, the three `skill_drafts` columns and the shared wire types. §2 below has
the decisions a later slice must not undo; the tests are
`core/test/skills/flowStale.test.ts` and
`core/test/http/skillFlowRoutes.test.ts`. **Do not redo it, and do not add a
web client for it yet** (slice C adds the helpers where they are used).

### M27 S4 — the notes + MCP Studio templates (last slice)

`notes-checklist` and `mcp-call` exist in `core/src/skills/templates.ts`, each
with the `requires` key the picker gates on (`notes` / `mcp`). Nothing else
moved: no route, no schema, no capability name.

Two details worth knowing before touching them:

- **The notes template reaches app data with no root.** It declares
  `notes.list` / `notes.search` / `notes.read` and passes **no `projectId`** —
  the broker keys the grant on `APP_SCOPE_ID`. Its refusal before the grant is a
  reported `tool_denied` (the entry catches it), never a thrown run, and never a
  queued row.
- **The MCP template's manifest carries a PLACEHOLDER server id.** MCP server
  ids are `randomUUID()` at `mcp.create()`, so no template can name the owner's
  server. `MCP_TEMPLATE_SERVER_ID` (`'your-mcp-server'`) is the one field an
  author replaces before installing; the run test performs that same edit against
  a local stdio fixture rather than asserting a weaker thing.

The tests are `core/test/skills/templates.test.ts` (gating in both directions,
manifest validation under the wired capability object, a real Studio dry-run for
the notes template, a real stdio run for the MCP one) plus the capability gate at
`core/test/skills/drafts.test.ts` and the picker's list at
`core/test/http/skillDraftsRoutes.test.ts` (both updated deliberately — they used
to assert `notes-checklist` was *unoffered*, which is now false).

### M27 S2 — MCP reach from the sandbox

`permissions.mcpServers` (server ids, de-duplicated, capped at 8) is now a real
reach: the entry calls `partner.tools.exec('mcp:<server>/<tool>', args)`.
`core/src/mcp/skillReach.ts` (new) owns every rule; the runner takes a
`SkillMcpReach` by INJECTION (`SkillRunnerOptions.mcp`) and never imports `mcp/`.

Gates, in the order the seam applies them (this order is the control):

1. id shape (`mcp:<server>/<tool>`);
2. **class envelope `mcp.call` FIRST** — above the declaration, so a session that
   may not call MCP learns nothing about what is behind it (D7's MCP half closed);
3. the server is in `permissions.mcpServers`;
4. the manifest presents at least **medium** (D6);
5. the server is configured AND enabled — else `mcp_disabled`.

Codes: `capability_denied` / `mcp_not_declared` / `mcp_disabled` / `tool_denied` /
`upstream`. **No pending row is ever created** (there is no enqueue path here at
all) — asserted as the WHOLE `pending_tools` count, not just the open rows, since
`pendingManager.list()` cannot see a row that was enqueued and then closed.
`RuntimeCapabilities.mcp` is `true` in `createCore` and in
`core/test/helpers.ts`.

Four things worth knowing before touching it:

- **Every refusal is AUDITED (fixed 2026-09-17).** The invocation SUCCEEDS when a
  skill catches a coded denial — the MCP template does exactly that, so
  `skill.invoke` records ok:true with toolCalls:1 — and a denial above the server
  lookup never reaches the manager's own `mcp.call` row. So an
  attempted-and-refused reach used to leave NO trace anywhere.
  `createMcpSkillReach(mcp, audit)` now writes exactly ONE `mcp.call.denied`
  row per denial: actor `skill`, the server id as the target, `{code, tool}` as
  details — never tool arguments, never the server command line. The composition
  root passes the core's own `AuditService`, and `mcpReach.test.ts` asserts one
  row per code.
- **The D6 ceiling is enforced at VALIDATE time too** (`core/src/skills/manifest.ts`):
  a `low`-risk manifest declaring `mcpServers` is refused when the draft
  validates, and the seam re-checks at run time so a manifest installed before
  the rule is not a loophole. If you add a test fixture with `mcpServers`, give it
  `risk: 'medium'` or higher.
- **The authoring surfaces are now capability-driven.** `entryContract` takes
  `{llm, mcp}`; `buildAuthoringPrompt` passes `capabilities`; and
  `authoringInstructions(toolIds, capabilities?)` — threaded from
  `CoreAppOptions.skillCapabilities` — also gained the `llm` description it had
  been missing since S5. Passing no capabilities keeps the old text exactly.
- **The audit row names the truthful actor.** `McpManager.call()` had the
  actor hardcoded as `web`, so an MCP call made by a skill read as a web request
  nobody made. It now takes an OPTIONAL third argument (default `web`, so the
  HTTP route is untouched): `core/src/mcp/skillReach.ts` passes `skill` and
  `core/src/mcp/tool.ts` (the persona auto-call) passes `persona`. If you add a
  caller of `mcp.call()`, pass the actor — the default is right only for the
  user's own session. Details are unchanged: ids/counts, never the command line
  and never tool arguments. The RUNNER's own `skill.invoke` row follows the same
  rule since 2026-09-17: `actor` is WHO ASKED, so a persona-driven or scheduled
  run (a `ctx.personaId`) says `persona` and only a session-less/web run says
  `web` — the skill is the row's SUBJECT (its id is the target), not the actor.

### M28 slice A — the Flow compiler (pure, no UI, no route of its own)

`core/src/skills/flow/schema.ts` (`validateFlow`) + `flow/compile.ts`
(`compileFlow`). Both exported from `core/src/index.ts`. Read these before
planning slices C/D/E, because five semantics were DECIDED here and the rest of
the milestone has to live with them (slice B's HTTP surface, below, only decides
WHAT to write with them):

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
   (`llm_not_declared`). **Slice B writes BOTH derived fields** into the manifest
   at `/flow/compile` (`core/src/skills/drafts.ts` `compileFlow`), and writes
   `llm: false` for a graph with no `llm` node, so an earlier compile cannot
   leave model reach behind.

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

Two slices remained in M27; **the S4 blocker was cleared by S1/S2** and S4 has
since landed (see §1).

## 1. M27 — what a skill may reach (all five slices landed; one walk left)

**S2 — DONE (2026-09-17).** Read §0 for the semantics it fixed; the short version
is `permissions.mcpServers` + a coded, class-gated, ceiling-checked reach through
an injected seam, with no pending row ever. **D7's MCP half is closed.**

**S4 — DONE (2026-09-17).** The two templates (`notes-checklist` and `mcp-call`)
in `core/src/skills/templates.ts`, each with its `requires` key. Both capability
dependencies existed (S1 `notes`, S2 `mcp`), so there was no blocker left on the
slice. Note the file: the templates live in `core/src/skills/templates.ts`, and
`authoring.ts` only delegates to it (`templateBundle`) — S4's own bullet in
`PLAN-M27.md` named `authoring.ts`, which was wrong; the spec is now corrected.
Both bundles VALIDATE **and** RUN (a Studio dry-run for the notes one, a local
stdio server for the MCP one).

**What is left in M27:** nothing but the env-gated walk — a real MCP server the
owner configures (§3). No code item remains.

### M27 gaps that are decision-shaped, not work-shaped

- **The spend ledger diverges — PARKED PERMANENTLY by the owner
  (decision (b), 2026-09-17): change nothing. Do not "fix" any of the three
  paths without the owner reversing that decision.** Three paths behave three
  ways, and they still do: the **chat route's budget gate** (in the
  `POST /v1/chat` handler, beside the `provider.budget` audit row) hard-blocks
  BEFORE the turn streams when a declared `budgetCents` cap is reached and
  writes NO ledger row at all when the provider has no cap; the **skill
  runner's `account()`** (`core/src/skills/runner.ts`) charges the provider's
  rolling window unconditionally and **reads no cap at all**; and the **M26
  one-shot calls** (workshop generation, daily-summarize, auto-remember) never
  settle (D10's recorded gap). So an uncapped provider is invisible to the
  ledger, and a skill can silently spend past a capped provider's rolling
  window. The owner was asked plainly: (a) actually disable the ledger — which
  also removes the chat route's cap gate, a cost control — or (b) park the
  divergence and change nothing. **The answer is (b): park it, change nothing.**
  Aligning the three is therefore a deliberate **non-goal for now**, not an
  oversight; the divergence stays documented here so it is a known state rather
  than a surprise.
- **`budget.maxTokens` for non-llm calls — SETTLED (2026-09-17).** The install
  summary printed "may spend at most N model tokens" for a tool-only skill that
  has no model reach. The line is now gated on `permissions.llm === true`
  (`core/src/skills/runtime.ts`), with a test pinning the `llm:false` +
  `maxTokens` case. The field itself stays accepted on any manifest (it is shared
  and validated whenever present); only the **consent text** was the lie.

---

## 2. M28 — the Studio Flow surface (A + B + split done; C–F left)

**Slice A landed in v0.1.19** (`core/src/skills/flow/schema.ts` +
`flow/compile.ts`, 1246 lines together, plus three test files:
`flowSchema.test.ts`, `flowCompile.test.ts`, `flowRun.test.ts`). Read §0 above for
the five semantics it fixed and the two additions beyond the spec (`bad_node`,
`usesLlm`) — those are what B has to honour.

**Slice B landed (schema v22).** Three additive columns on `skill_drafts`
(`flow_json`, `flow_sha256`, `flow_compiled_at`, guarded `ensureColumn`; a v21 DB
opens unchanged and pre-v22 rows read NULL = no flow), and three routes on the
M26 drafts surface: `GET|PUT /v1/skills/drafts/:id/flow` and
`POST /v1/skills/drafts/:id/flow/compile`. The lifecycle is in
`core/src/skills/drafts.ts` (`getFlow` / `saveFlow` / `compileFlow`). Decisions a
later slice must not undo:

- **A save is not a compile.** `PUT` validates structurally (`validateFlow`, 400
  with every offender in `flowErrors` otherwise, writing nothing) and changes
  only the graph — never `code`, never the derived permissions. A half-drawn
  graph saves: structural shape is the save's bar, not compilability.
- **`flowStale` is recomputed on every read** (`sha256(code) !== flow_sha256`).
  A draft with no flow is never stale; **a flow that has never compiled IS
  stale** (its code cannot be that flow's output) — that is why the Studio can
  offer Recompile on a freshly drawn graph. Nothing stores the flag.
- **`/compile` is the only writer of code from a flow**, and it writes `code` +
  `flow_sha256` + `flow_compiled_at` together, rewrites the manifest's permissions
  from the graph (**`tools` AND `llm`**), then re-runs the M26 validation. A flow
  that cannot compile answers **200 with `ok:false` + the named errors and writes
  nothing** (the `/validate` convention), and its response carries the rewritten
  `draft` because a compile IS a write.
- **Install from a stale draft is allowed** and asserted (manager AND HTTP: the
  stale draft is installed and RUN, and the run shows the hand-edited
  behaviour). Do not add a precondition — install consumes `code`.
- Audit: `skill.flow.save {nodes, edges, stale}` /
  `skill.flow.compile {ok, nodes, edges, tools, errorCount, codeBytes}` — counts
  and tool ids only, never the graph, the code or the manifest text.
- **No web helper was added** (slice B has no web consumer); the canvas (C) adds
  them where they are used.
- **The compile door enforces the manifest's OWN ceiling** (fixed 2026-09-17).
  `compileFlow` used to call the compiler with `{registry, llmAvailable}` and
  never supplied `riskCeiling`/`riskOf`, so D5's `tool_requires_medium` was
  dead in production: a `low` manifest whose graph held a `files.edit` node
  compiled, wrote `permissions.tools:['files.edit']`, re-validated ok and
  INSTALLED — a bundle that can never do what the graph says. The draft manager
  now takes the registry's risks (`SkillDraftManagerOptions.riskOf`, REQUIRED so
  it cannot go dead again — wire it from the broker's manifests) and the compile
  path parses the manifest BEFORE compiling and passes its tier as `riskCeiling`.
  A manifest whose risk is missing/unreadable gets the strictest ceiling (`low`),
  the same default the validator applies.
- **`mode:'generate-flow'` is REFUSED BY NAME until slice D.** The wire type
  (`SkillDraftCreateMode`) still advertises it and the route still accepts the
  field, but `create` answers `invalid_input` naming the mode instead of falling
  into the `generate` branch — which had handed a caller asking for a graph a
  CODE bundle with `flow: null` and no error. Do NOT narrow the shared union
  (that is a wire change); slice D replaces the refusal with the real path.

**Remaining slices:**

- **C — the canvas + Nodes table + palette/inspector.** Goes in `web/src/studio/`
  (the folder the split created), with the client-side grammar mirrored from
  `FLOW_PATH_RE` / `FLOW_OPERATORS` rather than copied. It should read/write the
  schema v22 routes above and add the thin fetch helpers to `web/src/lib/skills.ts`.
- **D — AI build/refine/from-code + the proposal diff.** `refine.ts` is specified
  but unbuilt (`refine` / `from-code` / `explain` and `mode:'generate-flow'`).
- **E — the chat `flow` payload** on the existing `skills.draft` tool.
- **F — docs/verify** (`docs/VERIFY-M28.md`, and a *looked-at* canvas frame: a
  passing `ux_audit` is the floor for a visual surface, not the evidence).

Its `llm` node prerequisite (`PLAN-M27.md` S5) **landed in v0.1.17**, and slice A
already compiles an `llm` node when the caller passes `llmAvailable: true`.

### Studio split — DONE (v0.1.19)

`web/src/SkillStudio.tsx` went 2025 -> 468 lines; the panels are in
`web/src/studio/*` and are re-exported from the original module, so no importer or
test moved. No CSS changed. **Canvas and AI panels belong in that folder.**

## 3. Env-gated walks — attempted for real (2026-09-17)

**Read `docs/VERIFY-LIVE.md` first: it is the measured record of the four walks
this section used to list as "never run".** They were attempted against a scratch
LIVE core on :4399 with the machine's own model targets — a local llama.cpp
`gemma-4-E4B-it-Q4_K_M` server (CUDA) and the remote LiteLLM gateway
(`deepseek-v4-flash`). Two are now **VERIFIED**, two remain **NOT RUN**, each
with its reason. Do not restate this table as "verified" wholesale.

| Walk | Milestone | Status | Evidence / reason |
|---|---|---|---|
| Live-endpoint generation | M26 | **VERIFIED** | Both targets: a real model reply parsed, normalised, validated and **installed** (model ids `gemma-4-E4B-it-Q4_K_M` / `deepseek-v4-flash`, not `demo`). `docs/VERIFY-LIVE.md` (a). |
| Live-model skill run | M27 S5 | **VERIFIED** | `partner.llm.complete` reached both targets and returned text; with `budget.maxTokens: 1` the invocation **failed `budget_exceeded`** with no partial result; the `skill.llm` rows carried model + token counts only (a whole-audit scan found no content). `docs/VERIFY-LIVE.md` (b). |
| Real (third-party) MCP server from a skill | M27 S2 | **NOT RUN** | **No third-party MCP server is configured or available on this machine** (LM Studio MCP config, editor configs, repo/parent `.mcp.json`, `PATH`, the npx/pi caches and Python all checked empty). The local stdio fixture was explicitly **not** substituted. Owner action first: configure AND enable a real server, then walk it. The S2/S4 tests prove the seam itself; this walk is the only thing that would prove a third-party server. |
| Packaged-app Studio | M26 | **NOT RUN** | **The installed artifact PREDATES M26/M27, so it cannot contain the screen: a REBUILD is required.** The 2026-09-06 build (`%LOCALAPPDATA%\Partner`, `resources/core-bundle.cjs`) has **zero** hits for `v1/skills/drafts`, `v1/skills/templates` and `skill.author` while the pre-M26 `v1/skills/catalog` route is present; the web bundle has zero hits for `SkillStudio`. Rebuild (`npm run build -w web` + a fresh `tauri build`), then launch with `:4390` free and walk generate → validate → install as in the live walk. |

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
  section, and both now point at **`docs/VERIFY-LIVE.md`** — the measured record
  of the 2026-09-17 live walks (two VERIFIED, two NOT RUN with their reasons).
  Read those three before claiming a milestone is fully proven.

---

## 5. How to re-verify from a clean checkout

```
npm test                                  # root: expect 1766 passed, 5 env-gated skips
npx vitest run shared/test                # 90
npx vitest run --root web                 # 944
npm run typecheck                         # 0 errors, all four workspaces
npm run build -w web                      # green
cd docker/server && ./stage.sh && docker compose up -d   # container refresh (needs openssl)
docker compose logs partner --tail 3      # expect "partner-core vX up ... schema=v23"
```

Guard tests that M26/M27 deliberately updated are the schema version (six files
pin `SCHEMA_VERSION`) and the closed capability vocabulary. **S1 updated three
more**, all tripwires working as intended: `core/test/chat/skillAuthorTool.test.ts`
and `core/test/http/skillDraftsRoutes.test.ts` (both asserted `notes.read` was
*undeliverable* — they now assert the same guarantee with `files.write`, which
has never existed), and `core/test/skills/manifest.test.ts` +
`web/test/skill-studio-helpers.test.ts` (vocabulary shape). **S4 updated two**
more of the same kind: `core/test/skills/drafts.test.ts` (it asked for
`notes-checklist` as an *unknown* template — now it asks for a genuinely unknown
id, and a new test pins the capability gate that took its place) and
`core/test/http/skillDraftsRoutes.test.ts` (the picker list is four ids now).
**M28 B bumped the six schema tripwires to 22** (`db-migrate`, `m4Stores`,
`m5Stores`, `m6Stores`, `m8Stores`, `m9Stores`) and added the v21 → v22 upgrade
case to `db-migrate.test.ts` (drop the three flow columns, re-open, assert the
row survives and the columns read NULL).
If one fires, update it deliberately and say so.
