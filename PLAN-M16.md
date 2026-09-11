# PLAN-M16 — Knowledge workspace: notes graph, brainstorming, versioning & asset depth

**Status: implemented + verified 2026-09-09 (shared + core + web, incl. the
F7 Files browse add-on; shell
slice compiles on the windows-build workflow — no local Rust toolchain;
packaged live walk env-gated, like M13/M15).** Master plan: `PLAN.md` §7,
§15.
Depends on M11 (Assets taxonomy F10, Notes promote + wiki-links, chat parts
`content_type`), M14 (persona schedules/conversation creation), M15 (live
packaged shell). Style: TDD red → green (suites green at exit). Schema
bump v13 → v14 (additive).

Six features, one arc: turn the notes/asset stores into a **knowledge
workspace** — a visible relationship graph over notes, a brainstorming flow
that runs on a dedicated persona from selected notes & captures, per-note
versioning, the ability to **discuss an asset** inside (or forked from) the
discussion it came from, working **Export in the packaged desktop app**, and
**CSV assets rendered as tables** instead of raw text.

## 0. Grounding (as built today)

- Notes are SQLite rows only (`core/src/stores/db.ts:298-306` —
  `notes(id, title, content, tags, is_daily, created_at, updated_at)`); no
  markdown files on disk. `[[Title]]` wiki-links are parsed on every save
  (`parseWikiLinks`, `core/src/notes/manager.ts:65-80`), resolved to ids,
  and persisted in `note_links(from_note, to_note NULL|id, to_title)`
  (`db.ts:308-314`). Backlinks exist per note (`backlinks()`
  `manager.ts:342-352`, `GET /v1/notes/:id/backlinks`). There is **no graph
  representation**, no graph UI, no revision history (only `updated_at`),
  and no note-level `kind`/folder columns ("capture" is not a kind).
- "Captures" today = **quick captures stored as ordinary notes**
  (`manager.capture()` splits the first line into a title, `manager.ts:445`);
  plus notes written by asset promote, playbook save-as-note, and schedule
  save-note. Browser page capture (`core/src/native/index.ts:254`) returns
  text to the extension and never writes a note (research-capture-to-note is
  an env-gated follow-up). Versioning notes therefore covers captures by
  construction — one choke point.
- Assets (`shared/src/assets.ts`) are children of a conversation
  (`conversation_id`, optional `message_id`); kinds include table/code/
  reference-list/deduction/…; actions today are Copy · Open in Notes
  (promote) · Export (.md) · Delete (M11 F10). **Export is fully
  client-side**: `web/src/lib/assets-export.ts` → `downloadTextFile`
  (`web/src/lib/download.ts:10-20`) = Blob + `<a download>`. The Tauri shell
  has **no download handling at all** (no fs/dialog-save wiring; `tauri.conf.json`
  has no `withGlobalTauri`), so the blob download silently does nothing in
  WebView2 — that is the desktop Export bug.
- No "Discuss" action, no conversation fork/thread/branch entity exists.
  Conversations have no lineage or asset/note context columns. Personas are
  seeded from `STARTER_SEEDS` (`core/src/personas/manager.ts:115-186`,
  eight starters) **only when the table is empty** — there is no
  "Brainstorming" persona and no seed-on-demand path. Skills referenced by a
  persona are free-form names (enforced at `core/src/http/server.ts:4014`).
- No CSV parser anywhere in the repo; no graph library in `web/package.json`
  (markdown tables render via remark-gfm only).
- Schema/migration mechanics: version constant
  `SCHEMA_VERSION` in `shared/src/contracts.ts:118`; `applySchema`
  (`db.ts:703-713`) re-runs idempotent `CREATE TABLE IF NOT EXISTS`
  (`SCHEMA_SQL`) + guarded `ALTER TABLE ADD COLUMN` via `ensureColumn`
  driven by `M11_GUARDED_COLUMNS` (`db.ts:667-701`). Migration tests pin the
  version string (`core/test/stores/db-migrate.test.ts`, `core/test/db.test.ts`).

## 1. F1 — Notes relationship graph

**Requirement.** Be able to view notes *and* their relationships. Link-flow
direction follows **who references whom**: note A containing a link to note B
is an edge A→B; when two notes refer to each other the edge is rendered
**bidirectional**. Reference for affordances:
https://reactflow.dev/showcase (node canvas, pan/zoom, minimap, drag).
Later the same graph feeds brainstorming (F2) and doc building (roadmap).

### Decisions (D1)

1. **Edges = resolved wiki-link relationships** from `note_links`
   (`to_note NOT NULL`). Direction: the *referencing* note is the source,
   the *referenced* note is the target. Mutual references collapse to **one
   edge with arrows at both ends** (React Flow `markerStart` + `markerEnd`).
   Dangling links (`to_note NULL`) are excluded from edges; a note with
   only dangling links still appears as an isolated node.
2. **Nodes = all notes** (normal + daily; daily is smaller/dimmer to reduce
   noise, still selectable). Node label = title; tags shown as chips on
   selection.
3. **API delivers structure, not layout.** `GET /v1/notes/graph` returns
   `{nodes: [{id,title,tags,isDaily,x?,y?}], edges: [{source,target,bidirectional:boolean}]}`.
   User positions persist per note in a `note_graph(note_id PK, x, y)`
   table (a dedicated table rather than guarded note columns — zero churn on
   the note row type/insert path); `PUT /v1/notes/graph/positions` saves
   dragged positions.
4. **Layout is deterministic and dependency-free.** A small pure layered
   layout util (rank = longest path from source-side roots, cycles folded
   into one rank, topo order within rank by title) in `web/src/lib/graph-layout.ts`,
   unit-tested. "Auto-arrange" re-runs it; drag updates stored positions.
   No dagre/elk dependency.
5. **Rendering via `@xyflow/react`** (the only new runtime dependency in the
   web app). Nodes open the note in the Notes editor on click/double-click;
   a per-node menu offers *Open note · Brainstorm from here* (F2). Edge
   click opens the target note.
6. **Out of scope (roadmap):** asset→note and chat→note edges, export of
   the graph as a document (the "build documentation later" path reuses the
   same node/edge JSON), clusters/subgraphs, search-inside-graph.

### API

- `GET /v1/notes/graph` → `{nodes, edges}` (session-gated; resolved links
  only; single SQL join over `notes` + `note_links`).
- `PUT /v1/notes/graph/positions` `{positions: [{noteId,x,y}]}` → 204.

## 2. F2 — Brainstorm from notes & captures

**Requirement.** Start a brainstorm from a selection of notes & captures.
Brainstorming activates the **Brainstorming persona**; create the persona if
it does not exist yet.

### Decisions (D2)

1. **New seed persona `p-brainstorm` ("Brainstorming")** added to
   `STARTER_SEEDS`: divergent voice, high temperature, `independence:
   assist` (suggests; never executes tools unprompted), no default skills,
   memory read. Starter names list in PLAN.md §5.2 gains it.
2. **Seed-on-demand.** Because `STARTER_SEEDS` only seeds an empty table, an
   existing user (table non-empty) would never get the persona. Add an
   idempotent `manager.ensureSeed(p-brainstorm)` invoked by the brainstorm
   flow — if the persona is missing it is created from the seed definition
   (user edits to an existing Brainstorming persona are respected: only
   create when absent). This satisfies "create the persona if we don't have
   it yet" at runtime.
3. **Context = the selected notes & captures.** Both live in `notes`;
   selection is by note id. Caps: ≤ 20 notes, excerpt ≤ 6 000 chars per
   note, ~60 000 total; beyond caps the excerpt is truncated with an
   explicit `… (truncated)` marker and the response reports
   `{truncated: count}`.
4. **The brainstorm is a conversation, not a special mode.** Core endpoint
   creates (or reuses an existing empty draft) a conversation bound to
   persona `p-brainstorm` in its home folder, seeds the first user turn with
   a brainstorm directive (divergent generation → converge → what to keep →
   open questions) + the bundled excerpts, each preceded by its note title +
   id so answers can cite `[[Note Title]]`. Returns `{conversationId}`; the
   UI opens that chat. The persona's character prompt supplies the voice;
   the directive grammar steers the turn structure (playbook-style
   `core/src/playbooks/` precedent).
5. **No new tool privilege.** v1 brainstorm is context + conversation only;
   if the persona is later granted search etc., those grants already apply
   through the normal broker. Nothing writes notes without the user saving
   via the existing Save-to-Assets / promote / save-note paths.
6. **Entry points:** multi-select in the Notes list, selection in the graph
   (F1), and "Brainstorm from here" on a single note/graph node. Roadmap:
   selecting assets/captures and prior brainstorm outputs (same bundle
   mechanism), doc-building out of the results.

### API

- `POST /v1/notes/brainstorm` `{noteIds: string[], title?}` →
  202 `{conversationId, personaId: 'p-brainstorm', used: number, truncated:
  number}`. Guards: 400 empty/too many ids; 404 any id unknown; 501 no
  provider (mirrors schedule/playbook runs). Persona ensure happens here
  (audit `persona.seed` once when created).

## 3. F3 — Versioning for notes & captures

**Requirement.** Notes and captures keep version history — see what
changed, view old versions, restore.

### Decisions (D3)

1. **One choke point.** Version snapshots are written by the notes store on
   every content mutation regardless of entry path: `notes.create`,
   `notes.update`, `manager.capture()` (first version), asset promote,
   playbook/schedule save-note, daily summarize rewrites, and restore
   itself. Implemented inside `core/src/notes/manager.ts` so captures and
   all synthetic writers are covered by construction.
2. **Storage.** New table `note_versions(id TEXT PK, note_id TEXT NOT NULL,
   seq INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags
   TEXT, writer TEXT, created_at TEXT, UNIQUE(note_id, seq))`. `seq` is
   1-based per note; the live `notes` row is never the source of truth for
   history — each mutation first snapshots the *current* row (when the note
   already exists), then applies the change. Writer tags the origin:
   `user | capture | promote | playbook | schedule | summarize | restore |
   brainstorm`.
3. **Retention.** Keep the most recent 100 versions per note; prune oldest
   on insert. Owner data (same storage/encryption boundary as notes; never
   in audit).
4. **Restore is undoable.** `POST /v1/notes/:id/restore` snapshots the
   current state (`writer: restore`) and then copies the target version's
   title/content/tags onto the note row, bumping `updated_at`.
5. **Diff is client-side and pure.** A small LCS line-diff util in
   `shared/src/diff.ts` (zero runtime deps, following the `shared/src/vision.ts`
   convention) renders additions/removals in the History panel. Server
   serves snapshots; it never diffs.

### API

- `GET /v1/notes/:id/versions` → `{versions: [{id, seq, createdAt, writer,
  titleChanged: boolean}]}` (summaries only — no bodies in the list).
- `GET /v1/notes/:id/versions/:versionId` → `{version: {id, seq, createdAt,
  writer, title, content, tags}}` (full snapshot for diff/read).
- `POST /v1/notes/:id/restore` `{versionId}` → 200 `{note}`. 404 unknown
  note/version. Audit `note.restore` (ids + seq only).

## 4. F4 — Discuss an asset (thread of the same discussion, or fork)

**Requirement.** Add **Discuss** to Assets. Discussing an asset becomes a
branch/thread of the same discussion (the conversation the asset came from);
optionally it can **fork into a new discussion**.

### Decisions (D4)

1. **Discussions are conversations; lineage is first-class.** Two guarded
   columns on `conversations` (schema v14): `parent_id TEXT NULL` (the
   discussion this one branches from; `ON DELETE SET NULL`) and
   `source_asset_id TEXT NULL` (the asset that sparked it). Assets keep
   their existing `conversation_id` provenance; nothing else in the asset
   model changes.
2. **"Discuss" action** (asset menu, both the per-conversation AssetsPanel
   and the global AssetsLane) opens a small chooser:
   - **Continue / branch of the same discussion** (default when the asset's
     origin conversation still exists): open the **origin conversation** and
     drop the asset into the composer as a context part (`content_type`
     asset-ref, following M11's granted-file-reference part pattern) with
     provenance text `Discussing asset "<title>" (kind)`. The user types
     their prompt and sends — new turns land in the *same* thread, so the
     discussion literally continues where the asset was born. If the origin
     conversation no longer exists, this option degrades to Fork (below).
   - **Fork into a new discussion** (always offered): core creates a new
     conversation with `parent_id = origin conversation id` (when it still
     exists, else NULL), `source_asset_id = asset id`, in the origin's
     folder (else the default persona home), bound to the origin
     conversation's persona (continuity) or the user's default persona. The
     composer opens with the asset as the same context part; on send the
     model sees the full asset body + provenance.
3. **Fork surfacing.** A fork/thread conversation carries a header chip:
   "Forked from *origin title* · Asset *asset title*" with jump-back links
   to the origin conversation and to the asset (deep links degrade
   gracefully when targets were deleted). The conversation rail nests
   threaded children (parent_id set) indented under their origin, mirroring
   the folder nesting conventions already in the rail.
4. **Semantics are explicit, not magic.** No implicit message is sent; the
   user always composes the first turn (asset context is prefilled, prompt
   is theirs). Deleting a conversation nulls children's `parent_id` (they
   become standalone forks) — lineage links are best-effort.
5. Out of scope: conversation *trees* in the rail beyond one level of
   nesting, chat-level "fork this conversation" (no asset involved), merging
   threads.

### API

- `POST /v1/conversations/:id/assets/:assetId/discuss`
  `{mode: 'continue' | 'fork'}` → 200 `{conversationId, mode, assetId}`.
  `continue` requires the target conversation (`:id` = origin) to be the
  asset's own conversation; otherwise 400 → use `fork`. `fork` may be
  called from any conversation context (even a global assets view, where
  the "continue" target is the asset's origin conversation). Audit
  `asset.discuss` (ids + mode only).

## 5. F5 — Make Assets → Export work in the desktop app

**Requirement.** Export works in the packaged desktop app. (It already works
in a plain browser via blob download.)

### Root cause

`downloadTextFile` (Blob + `<a download>`) is the only export path; the
Tauri shell wires **no** download handling for its WebView2 window
(no fs plugin, no dialog-save, no `withGlobalTauri`), so the click does
nothing packaged.

### Decisions (D5)

1. **Native save path in the shell; blob fallback elsewhere.** The shell
   gains one Rust command `save_text_file { default_name, content }` that
   shows the **native save dialog** (`tauri-plugin-dialog` save) and writes
   the text with `std::fs` to the user-chosen path; returns `{saved:
   boolean, path?}`. Web detects the shell at runtime and routes export
   through it; the existing blob path stays for pure-browser/dev/extension
   use. No core route needed for text exports (body is already client-side).
2. **Bridge wiring.** `tauri.conf.json` sets `app.withGlobalTauri: true`
   so the loopback-served web app sees `window.__TAURI__`; capabilities gain
   the dialog-save permission. Verify at build time that the injected global
   is present on the `http://127.0.0.1:4390` webview (the M15 tray code
   already proves webview IPC feasibility); if it is not, fall back to an
   init-script shim injected from `lib.rs` exposing the same function
   surface to the web app. Detection util in `web/src/lib/download.ts`:
   `isPartnerShell()` + `saveTextFileNative(...)`.
3. **Scope = every text export.** `downloadTextFile` is the shared choke
   point — Assets → Export (.md) and Notes export (JSON) both route through
   it, so one change fixes all text downloads in the desktop app. Binary
   attachment downloads keep their existing object-URL path (separate
   surface, unchanged).
4. **Safety.** The shell writes only to a path the user picked in the native
   dialog; it never receives a directory or a forced path. Content stays in
   the webview memory until the dialog is confirmed. Non-text sizes are
   bounded (dialog-write command rejects > 50 MB).
5. Out of scope: drag-to-desktop, bulk export folder pickers, export of
   binary assets through the shell.

### Files

- `shell/src-tauri/Cargo.toml` — `tauri-plugin-dialog` save feature already
  present (pairing dialog uses it); add `serde_json` if not present.
- `shell/src-tauri/src/lib.rs` — `save_text_file` command + handler
  registration.
- `shell/src-tauri/tauri.conf.json` + `capabilities/default.json` —
  `withGlobalTauri`, dialog save permission.
- `web/src/lib/download.ts` — bridge detection + native call + tests.

## 6. F6 — CSV assets rendered as tables

**Requirement.** When an asset's content is CSV, present it as a table so it
is legible (instead of raw text).

### Decisions (D6)

1. **Detection.** An asset renders as CSV when (a) kind is `table` and the
   body smells tabular, or (b) kind is `custom`/`document` and the body
   **sniffs** as CSV: ≥ 2 lines, ≥ 2 columns on the first two lines
   (comma or tab), consistent column counts — sniffing function is pure and
   unit-tested. A "View as table / raw" toggle is always available on
   qualifying assets.
2. **Parsing.** `shared/src/csv.ts`: RFC-4180-style parser (quoted fields,
   embedded separators/newlines/escaped quotes, CRLF tolerant), first row =
   header. Pure, zero runtime deps (same convention as `shared/src/vision.ts`).
3. **Rendering.** Token-only table (DESIGN.md): header row distinct via
   token surface, right-aligned `font-variant-numeric: tabular-nums` numeric
   cells, row hover on background token, capped at **500 rows + 100
   columns** with a "first N rows shown" note; empty/one-row edge cases show
   a caption instead of a blank table. CSV table reuses the markdown table
   styles where they exist (remark-gfm `.md-table`) — component hygiene gate.
4. **Copy stays honest.** Copy action copies the raw CSV body (existing
   behavior unchanged); the table view is a presentation only.
5. Out of scope: editing cells, type inference/charts, CSV *attachments*
   (only assets per the requirement), large-file streaming.

## 7. Shared / schema changes (all milestones)

- `shared/src/contracts.ts` — `SCHEMA_VERSION` 13 → **14**.
- `core/src/stores/db.ts` — schema v14: new tables `note_versions` and
  `note_graph` in `SCHEMA_SQL`; guarded columns `conversations.parent_id
  TEXT NULL` + `conversations.source_asset_id TEXT NULL`
  (`M11_GUARDED_COLUMNS` + `ensureColumn`). Foreign keys are advisory
  (SQLite pragma off in this codebase) — nulling semantics are handled in
  the managers.
- `core/test/stores/db-migrate.test.ts` / `core/test/db.test.ts` — pinned
  version assertions 13 → 14; legacy-DB upgrade test gains the new guarded
  columns (drop → re-apply → rows survive).
- New pure modules: `shared/src/csv.ts`, `shared/src/diff.ts` (exported
  from `shared/src/index.ts`), `web/src/lib/graph-layout.ts`.

## 8. New dependencies

- `web`: `@xyflow/react` (React Flow v12 — graph rendering; the only new
  runtime dependency). Everything else is pure code in `shared/`/`web/` and
  existing plugins (dialog) in the shell.

## 9. Web UI surfaces (token-only, DESIGN.md, ux_audit gate)

- **Notes view**: view toggle *List | Graph*; multi-select mode (checkbox)
  with a **Brainstorm** action (count badge) in the notes list; graph canvas
  (pan/zoom/minimap, drag, Auto-arrange, node → open / brainstorm-from-here);
  NoteEditor gains a **History** tab (version list, diff view old→new,
  Restore with confirm).
- **Assets (conversation panel + global lane)**: asset row/menu gains
  **Discuss…** (Continue in discussion / Fork into new discussion) and the
  CSV table rendering for qualifying assets; Export unchanged visually but
  now functional in the packaged app.
- **Chat**: composer context part for an asset being discussed (rendered as
  a quoted asset chip, content included on send); fork/thread header chip
  with jump-back; rail nests threaded conversations.
- **Persona manager**: Brainstorming appears in the starter set (and is
  auto-created on first brainstorm if absent).

## 10. Slices + tests (TDD, red → green)

- **S1** schema v14 + pure modules: `SCHEMA_VERSION` bump, `note_versions`
  table, guarded columns, `shared/src/csv.ts`, `shared/src/diff.ts`,
  `web/src/lib/graph-layout.ts` — `core/test/stores/db-migrate.test.ts`
  update, `shared/test`/`web/test` unit tests (CSV matrix: quoting, CRLF,
  tabs, sniff negatives; diff: insert/delete/replace; layout: ranks,
  bidirectional fold, determinism).
- **S2** note versions (core): store + manager snapshot-on-mutation at the
  choke point (create/update/capture/promote/summarize/restore), retention
  cap, list/get/restore routes + audit row — `core/test/notes` unit +
  `core/test/http/notesPlansRoutes.test.ts` additions.
- **S3** graph (core): graph query over `notes`+`note_links` (direction,
  bidirectional flag, isolated notes), positions persistence + routes —
  `core/test/http` route tests.
- **S4** brainstorm (core): `p-brainstorm` seed + `ensureSeed` +
  `POST /v1/notes/brainstorm` (guards, caps, truncation report, persona
  auto-create, conversation bound to persona, first user turn bundle,
  provider 501) — unit + route + demo e2e (`tests/`, real core, brainstorm
  turn lands in a conversation on the Brainstorming persona).
- **S5** discuss/fork (core): `conversations.parent_id`/`source_asset_id`
  guarded columns, discuss route (`continue`/`fork` semantics, origin-deleted
  degradation), rail lineage query — `core/test/http/assetsRoutes.test.ts`
  + conversations route tests.
- **S6** shell export bridge: `save_text_file` command + dialog,
  `withGlobalTauri` + capability; windows-build green (Rust compiles).
- **S7** web downloads util: `isPartnerShell`/`saveTextFileNative` +
  `downloadTextFile` routing — `web/test` unit tests (fake bridge + fake
  DOM blob path).
- **S8** web notes UI: Graph view (React Flow, layout, selection, drag
  persist, brainstorm-from-selection wiring), History panel + diff + restore,
  multi-select brainstorm entry — token-only, state contract, `ux_audit`
  green on new components.
- **S9** web assets UI: Discuss… chooser + composer asset context part +
  fork chip/rail nesting; CSV table renderer — `web/test` client fn tests +
  `ux_audit` green.
- **S10** cross-cutting: full suites green, typechecks 0, web production
  build (graph dep), demo e2e extensions, manual walk script.

## 11. Security & privacy

No new privilege anywhere. Notes versions, graph positions, and lineage
columns are owner data under the existing storage boundary (encrypted at
rest in live mode; never in audit rows — version/audit rows carry ids and
counts only). Brainstorm context is sent only to the user's own configured
endpoints, bounded by the existing caps; the persona runs at `assist`
autonomy. The shell save command writes only to a user-confirmed native
dialog path, bounded size, no forced directories. `withGlobalTauri` exposes
the invoke surface to the same loopback origin that already holds the
session token — no new trust boundary.

## 12. Open confirmations (flip during S0/S1 without scope change)

1. **Discuss default**: branch-of-same-discussion = *continue typing in the
   origin conversation*; "Fork" = new child conversation (D4). If the
   intent was that the *fork itself* is the default "same discussion"
   thread (new conversation nested under origin), the flip is one default
   swap — model/columns unchanged.
2. Graph node set includes daily notes (dimmer) — exclude instead if noise
   dominates at first render.
3. CSV row/column caps (500/100) and "first row = header" — tune after a
   real-world sample.

## 13. Exit criteria

- [x] A. Core suite green with S1–S5 additions (versions, graph, brainstorm,
      discuss, schema v14 migrate); db-migrate + db tests assert v14. Root
      run: shared 51 · core 786 → **837 passed** — the only 2 failures are
      `core/test/stores/encryptedDb.test.ts` cipher cases that ALSO fail at
      HEAD (verified via `git stash`) = environment (better-sqlite3 cipher
      build), not M16.
- [x] B. Shared/web suites green (csv, diff, graph-layout, download bridge,
      assets/notes clients): shared 51 · web 486 (30 new); typechecks 0
      across all workspaces; production web build green with
      `@xyflow/react`.
- [ ] C. Shell windows-build green (save_text_file + `withGlobalTauri`).
      Code shipped (`shell/src-tauri/src/lib.rs`,
      `tauri.conf.json`); no local Rust toolchain — compiles on the
      self-hosted windows-build workflow (env-gated, like M15's tray).
- [x] D. `ux_audit` green on the new UI CSS (graph, history/diff,
      brainstorm entry, discuss chooser + fork chip, CSV table) in light +
      dark — tokens only, states declared, no slop tells.
- [ ] E. **Manual walk (env-gated, queued)**: graph shows notes with
      directed and bidirectional edges, drag positions survive reload,
      Auto-arrange converges; brainstorm from 3 notes creates the
      Brainstorming persona on first use and opens its conversation; note
      edit history shows versions with a working diff + undoable restore;
      Discuss from an asset continues the origin discussion and Fork opens a
      nested conversation with jump-back; Assets → Export writes a .md via
      the native save dialog in the packaged app (and still downloads in a
      plain browser); a CSV asset renders as a table with a raw toggle.
- [ ] F. Docs: PLAN.md §15 M16 box + README updated for the implemented
      state (done); HANDOFF-WINDOWS.md table row deferred to the close-out
      after the packaged walk (repo convention).

## 14. F7 — Files → Absolute path browser (2026-09-09 add-on)

**Requirement.** Under Files → *Absolute path* (the add-root form field), let
the user browse the filesystem to set the path instead of typing it.

**Design.** The paired owner browses directories one level at a time
(directory names only — never file contents, never other files), with Up
navigation, an inline breadcrumb, and “Use this folder” filling the path
field; the form still validates + canonicalizes on Add root. This is an
owner UI action, not a persona tool: loopback + pairing + audit, same
surface as the roots routes, and it works with or without the broker wired.

- `core/src/files/browse.ts` — pure `browseDirectory(raw)`:
  directories-only listing (symlink dirs resolve), alphabetical, capped at
  500 + truncated flag; typed errors (`invalid_path` 400 / `not_found` 404 /
  `denied` 403); NUL bytes refused; Windows drive enumeration from the
  start screen (`''` → drives on win32, `/` on POSIX).
- `core/src/http/server.ts` — `GET /v1/files/browse?path=…`
  (session-gated, audit `files.browse` with path + entry counts).
- `web/src/lib/tools.ts` — `browseDirectories` client + `parseBrowseResult`.
- `web/src/FilesView.tsx` — **Browse…** toggle beside the Absolute path
  input + `FilesBrowser` (path readout, Up, folder list, Use this folder).
- CSS: token-only `.files-browse*` block in `app.css` (`ux_audit` green).

**Tests.** `core/test/http/browseRoutes.test.ts` (list home, Up navigation,
400/404 guards + unauth) · web `parseBrowseResult`/client cases in
`web/test/m16-lib.test.ts`. Exit: shared+core+web suites green ·
typechecks 0 · web build green · `ux_audit` green (light+dark). The
packaged live walk (E) extends to cover the browser picker; the drive-list
path is exercised on the Windows CI build.

## 15. Implementation notes & deltas (vs the design above)


- **Version snapshots are POST-state** (each version = the note as it was
  after the write) — history reads naturally and `titleChanged` compares
  stored titles; restore first snapshots current state (`writer: restore`)
  so restores are undoable.
- **Graph positions live in a `note_graph` table**, not guarded note columns
  (same API; less churn on `NoteRow`/insert paths).
- **Brainstorm truncated ⊆ used**: a cap-cut note IS bundled (used) AND
  counted as truncated. The core generates the persona's FIRST reply
  headlessly (provider seam, deterministic demo placeholder) so the
  conversation opens already kicked off.
- **Asset Discuss quotes the asset into the composer as editable text**
  (provenance header + body ≤ 12k chars) instead of a new `content_type`
  part — same "model sees the body on send, nothing sent implicitly"
  contract with far less plumbing; the fork lineage columns carry the
  thread/parent + asset provenance and the rail nests forks one level under
  their parent.
- **Desktop export = web detection util + shell `save_text_file` command**
  (native save dialog, writes only the user-picked path; blob fallback for
  plain browsers). Both Notes export and Assets → Export route through the
  one util.
- The packaged core bundle (`shell/src-tauri/resources/core-bundle.cjs`) is
  re-staged from `core/src/index.ts` by the windows-build workflow, so the
  packaged app picks up the new routes on the next CI build; local
  `PARTNER_CORE_BUNDLE`/dev mode already run the live source.

## 16. Follow-up — linked, reopenable brainstorms (2026-09-10, schema v15)

**Requirement.** A brainstorm is linked back to the nodes it came from and is
viewable in the graph; clicking **Brainstorm (N)** over a set that already has
a session opens that session instead of starting a new one — unless the
session was **concluded**, in which case a fresh one starts and the concluded
one can be **reopened** to continue that path.

**Design.**

1. **Linkage tables (schema v14 → v15).** `brainstorm_sessions(conversation_id
   PK, set_key, concluded, used, truncated, created_at, updated_at)` +
   `brainstorm_sources(conversation_id, note_id)` (PK both, index on note_id).
   `set_key` = `brainstormSetKey(noteIds)` (unique ids sorted asc, NUL-joined)
   so order/duplicates never fork a session. Additive `CREATE TABLE IF NOT
   EXISTS`; no guarded columns.
2. **Find-or-create.** `POST /v1/notes/brainstorm` validates every source
   first, then returns the newest **active** session for the exact set
   (`reused: true`) or creates a new conversation/provider reply and links it
   (`reused: false`). A concluded session never short-circuits a start.
3. **Conclude / reopen.** `POST /v1/notes/brainstorm/:id/conclude` and
   `.../reopen` flip owner state (audited `brainstorm.conclude` /
   `brainstorm.reopen`); `GET /v1/notes/brainstorm[?noteId=]` lists sessions.
4. **Graph linkage.** `GET /v1/notes/graph` carries `brainstorms` (sessions
   with their source ids); the canvas badges each linked node, lists the
   selected note's sessions, and opens/concludes/reopens them. The
   Brainstorm button reads **Open brainstorm (N)** when the selection already
   has an active session in both the graph and list multi-select.
5. **Chat header.** `GET /v1/notes/brainstorm?conversationId=` resolves one
   open conversation's session; the chat bar shows
   `Brainstorm active|concluded` with **Conclude**/**Reopen** in place
   (toggled, audited, busy/error states).
6. **Lifecycle.** Deleting a conversation prunes its session lazily on the
   next read. Owner data: ids, titles, counts only — note bodies stay in the
   conversation, never in audit.

**Tests.** `core/test/notes/brainstorm.test.ts` (reuse, conclude→new,
reopen, 404, dangling prune, byConversation) · `core/test/http/m16Routes.test.ts`
(reuse + graph passthrough + list + by-conversation + conclude/reopen 404) ·
db-migrate asserts v15 + both tables · web `m16-lib.test.ts` client cases.

## 17. Follow-up — graph connectors create note links (2026-09-11)

**Requirement.** Drag a connector between two nodes on the Notes graph to
establish a relationship: the drag writes it and the edge appears (and
survives a reload).

**Design.**

1. **No new edge store.** Edges are note wiki-links (D1.1), so a connector
   writes `[[Target title]]` into the note the drag started from — source =
   the referencing note, matching the arrow. Backlinks, search, export and
   the canvas all follow from the one write; removing a relationship stays
   "edit the link out of the note" (or restore a version).
2. **Pure edit helpers** (`web/src/lib/note-relate.ts`): `isLinkableTitle`
   (non-empty, no `]`), `hasWikiLink` (case-insensitive, idempotent),
   `appendWikiLink` (own trailing paragraph, empty body handled) and
   `isLinkedAlready` (same arrow OR a bidirectional edge = already linked;
   a lone reverse arrow is a real edit, rendered mutually by the core).
3. **Canvas.** `onConnect` optimistically draws the edge, then GETs the live
   source body, PUTs the augmented content and reloads the graph from core —
   a failed write reverts instead of leaving a phantom arrow. Refusals
   (self-loop, unlinkable title, duplicate) surface in a status/error line;
   `nodesConnectable` is off while a write is in flight, and edge
   reconnect/delete are disabled because an edge is derived data.
4. **Refresh.** `onNoteMutated` bumps the NotesSegment reload tick so the
   list freshness and any open editor refresh from the same write.
5. **Affordance.** Handles get a crosshair cursor and an accent fill on
   hover/connect; the in-flight connection line rides `--accent`; hint and
   foot copy state that the link lands in the source note. Token-only, no
   new dependency.

**Verification.** `web/test/m16-lib.test.ts` (append / idempotence /
linkability / already-linked) · live browser run: pair → two notes → Graph →
drag Alpha → Beta → edge drawn + confirmation → opening Alpha shows
`Alpha body text.` then `[[Beta research]]`.
