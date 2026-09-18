# Changelog

All notable changes to Partner. Newest first. One release per milestone or
review fixup (`v0.MINOR.PATCH`).

- **Milestone index** → `PLAN.md` §15
- **Per-milestone spec** → `PLAN-M<N>.md`
- **Verification records** (walks, measurements, "not verified") → `docs/VERIFY-*.md`
- **What is still open / env-gated** → `docs/UNFINISHED.md`
- **Full historical narrative** → `docs/HISTORY.md`

## [0.1.26] — 2026-09-19

M34–M37 — Folders as an Explorer, a session title you can name, and the Memory
display pass (responsive group cards).

### Added

- **M35 — Folders as an Explorer.** The Folders page is now a two-pane
  Explorer: a **navigation pane** (the folder tree — the same
  `ConversationRail` in a new folders-only `nav` mode, selectable, with every
  folder control unchanged) beside a **contents pane** listing the selected
  folder's subfolders and chats under Name · Type · Items · Modified, with an
  address bar (`↑ Up` + a breadcrumb where each crumb is a control + the item
  count) and one `+ New folder` / `+ New subfolder` action scoped to the open
  folder. Subfolders have been in the data model since M11 (`parentId`); they
  are now navigable, so "inside this folder" and "everything below it" are no
  longer the same picture. One definition of the tree
  (`web/src/lib/folder-tree.ts`, which also absorbs M17's `folderSubtreeIds` /
  `folderTreeRows`) and one definition per control (`FolderActions`,
  `ChatActions`), so the panes cannot drift from the rail. The selection is
  clamped against the live folder list, and the phone tier stacks the panes and
  drops the metadata columns. An **Assets** column sits beside Items: a chat row
  shows the assets saved in that session, a folder row sums its subtree, fed by
  `ConversationSummary.assetCount` (a derived per-list read of the assets table,
  `AssetStore.countsByConversation`). No schema change; one derived field on the
  `/v1/conversations` summary.
  *Fixed with it:* the armed folder-delete chip was `--accent-contrast` on a
  `--danger` fill — in dark mode **APCA Lc −17.3 / WCAG 1.32:1**, an unreadable
  confirm (found by the `ux_audit` run, fixed to `--danger` text on its own
  `--bg` ground plus a danger ring: Lc 80.9 light / 80.5 dark).
- **M34 — Folders as a first-class section, and a session title you can name or
  have suggested.** A chat session now has **two** organizations that do not
  touch each other: the persona that runs it (the tree under **Personas**) and
  the folder it is filed in — a **Folders** destination in the sidebar's
  Workspace group. The page renders the *same* `ConversationRail` in its
  embedded form, so the folder controls M32 lost (create / rename / delete,
  drag-to-move, the move select) have exactly one home and cannot drift from the
  phone overlay. Chat's top now carries the **session title**: rename in place,
  and **Suggest title** once the chat has a couple of turns behind it. A
  suggestion is a PROPOSAL — `POST /v1/conversations/:id/title-suggestion` runs
  one bounded model call and stores nothing; accepting it is the ordinary
  `PUT /v1/conversations/:id`, and with no model configured the core answers
  with the title derived from the opening message and labels it as such. Audit
  rows carry counts and the title length, never content. No schema change.
- **M33 — multi-persona memory scope.** `ProfileEntry.personaScopes: string[]`
  replaces the single `personaScope` (empty = every persona; one id = private;
  two or more = exactly those). Tailoring, auto-remember and
  `GET /v1/memory/profile?personaScope=` read it as membership. Schema **v24**
  adds `profile_entries.persona_scopes` and backfills each legacy row once.
  One `ScopePicker` checkbox set now backs the edit form, the add form and the
  suggestion re-scope; a removed persona stays ticked so opening a fact cannot
  widen it.

### Changed

- **M37 — Memory library as responsive group cards** (spec: `PLAN-M37.md`;
  record: `docs/VERIFY-M37.md`). The confirmed facts are now bucketed into one
  card per group — a head (name + count) over its rows in an `auto-fill
  minmax(320px, 1fr)` grid — with one `Kind ⇄ Persona` segmented pill to switch
  the bucketing, remembered as `partner.factGrouping`. `groupEntries` is a pure
  partition: every fact lands in exactly one card in either mode — by kind (chip
  order, empty kinds omitted) or by persona (`All personas`, then `Shared`, then
  each persona with facts, then `Removed persona`). A card head and its rows no
  longer repeat each other, and a card is deliberately not a third surface plane.
  The Suggestions inbox and Rejected panel stay status-first; episodes, search,
  the add form and the controls are unchanged. No schema or route change.

- **M36 — Memory view display pass** (spec: `PLAN-M36.md`; record:
  `docs/VERIFY-M36.md`). A review of the Memory screen, rendered light + dark at
  1440 and 390×844 with real entries, found it token-clean but noisy and partly
  unreachable. Five changes: a pending suggestion states three facts in one line
  instead of five tokens (one provenance item, no status chip restating the
  panel, and the **scope text itself is the disclosure** — `All personas ▾`
  replaces a `Change` label that named nothing); an episode summary is readable
  via **Show more/less** and offers **Open chat only when the shell actually has
  that conversation** (a deleted chat does not cascade to its summary, and an
  imported episode names a conversation from another machine); disabled controls
  state their reason in place (`No provider behind a demo summary`, `Pick a date
  to enable this.`); a **search hit is marked and actionable** (the match is
  highlighted, Edit opens the fact's editor, Show expands the episode, and the
  note gives the real hit count); and the add form's per-persona **Applies to**
  grid collapses behind one toggle for the common *All personas* answer, without
  changing M33's empty-set semantics. No schema, route or stored-data change.

### Fixed

- Folder **chat-count chips** and the rail's “N chats · M in folders” total now
  use `--text-muted`: on `--surface-2` the faint token measured APCA Lc 68.9
  (light) / 48.0 (dark), under the body floor — and the M34 Folders page is
  where those numbers are read.
- The conversation tree now renders **folders that have no chats yet**. It used
  to fall back to its empty note whenever the CONVERSATION list was empty, which
  hid the whole folder tree on the page whose job is folders.
- A folder row's own actions (add subfolder / rename / delete) are revealed on
  `(hover: none)` devices. They are `:hover`/`:focus-within`-revealed like the
  chat row's, so on a phone or tablet the tree was read-only — found by walking
  the new Folders page at a no-hover tier.

## [0.1.25] — 2026-09-18

M32 — persona-owned sessions, a resizable menu, a Catalog deck, and tracked
memory.

### Changed

- Chat sessions moved out of Chat and under **Personas**: each persona is a
  disclosure listing its chats; a chat whose persona is gone stays visible under
  **Unassigned**. Chat is a destination plus `New chat`; the phone keeps the
  floating `ConversationRail`.
- Skills **Catalog** is now a card deck whose card opens a detail drawer,
  reusing the persona deck/drawer classes.
- Memory ties a pending suggestion to a persona in one step and shows rejected
  facts in a collapsed **Rejected** panel with Restore; the extractor receives a
  same-scope `REJECTED` block alongside `ALREADY KNOWN`, so a declined fact is
  not re-asked even reworded.
- The chat transcript no longer flips a fenced HTML/CSS block into an inline
  sandboxed iframe (Notes and Assets keep previews).

### Added

- Drag-resizable left menu via the shared `ColumnDivider` (180–420px,
  `partner.sideWidth`; a dragged width applies only while expanded).

## [0.1.24] — 2026-09-18

M31 — Settings, persona cards, and a magazine Notes & Plans.

### Changed

- Sidebar IA: Providers, Themes, Audit and Members moved into a **Settings**
  group; Studio is personas/skills/playbooks and Tools is files/memory.
- Personas became a wall of business cards; the card face opens a slide-out
  editor drawer, while Pause (kill switch) and Delete stay on the card.
- Notes & Plans got a magazine layout (masthead, hairline rules, a 1200px
  measure, newest item as a full-width lead); the note editor and plan planner
  keep their card surface.

## [0.1.23] — 2026-09-18

M29 — the multi-user lifecycle.

### Added

- **Sign out** (`POST /v1/auth/signout`) revokes the session *and* closes the
  user's partition (scheduler stops, DB handle closes, key leaves memory).
- **Owner-minted invitations** from the Members view: `users.role`
  (`owner`/`member`), `users.key_access` (`own`/`shared`), an `invites` table
  storing only the code's SHA-256; redemption is one conditional update.
- **Shared AI access**: an owner publishes providers + search config
  (`shared_access`, `shared-*` keychain accounts); a `keyAccess:'shared'` member
  chats and searches without a key, and their own setup always wins.
- **Per-user file roots** (`<FIXED_ROOTS entry>/<userId>`), created at boot;
  the roots surface is read-only in login mode.
- **Note & asset sharing** as snapshot copies in the system DB (`shares`).
- Schema **v23** (additive).

## [0.1.22] — 2026-09-18

### Added

- A **sample set** in the Skills Catalog.
- A persona can **propose a skill update** the owner grants (approval card).

### Fixed

- Skill Studio review fixup: draft description editing, the `Edit in
  Studio`/`Fork` deep link, creating a draft when one already exists, and the
  failing dry-run reporting its actual reason.
- Deploy fixups it exposed (container skill worker harness, `stage.ps1` on
  Windows PowerShell, an upgraded account dropping the stale shared-root row).

## [0.1.21] — 2026-09-17

M28 — Skill Studio Flow (canvas).

### Added

- A React Flow canvas as the Studio's fourth surface: ten typed nodes
  (`input` · `const` · `tool` · `template` · `filter` · `map` · `branch` ·
  `merge` · `llm` · `output`).
- Four AI verbs — build from a description, refine a drawn graph as an
  accept/reject proposal, from-code, explain — none of which write until
  accepted.
- An equivalent **Nodes table** over the same document (keyboard reachable),
  since React Flow has no keyboard path to creating an edge.

### Changed

- A flow compiles deterministically to the same `entry.mjs` every other draft
  installs; expressions are a validated path grammar plus fixed operators, so an
  AI-written graph cannot inject code.

## [0.1.20] — 2026-09-17

M27 S2 + M28 B.

### Added

- **MCP reach from the skill sandbox**: a manifest may declare
  `permissions.mcpServers` and call `partner.tools.exec('mcp:<server>/<tool>',…)`.
  Reach is per **server**, requires at least `medium` risk, and every failure is
  a coded refusal with **no pending approval row**.
- **Flow routes** (`GET|PUT /v1/skills/drafts/:id/flow`,
  `POST …/flow/compile`), schema **v22**: a save touches no code, a compile is
  the only writer of code from a flow and rewrites `permissions.tools` **and**
  `permissions.llm`.

### Fixed

- MCP calls are attributed to the skill (or persona) that made them, not to an
  anonymous web request.

## [0.1.19] — 2026-09-17

M28 A — the Flow compiler.

### Added

- A pure, **total** compiler: cycle, dangling edge, missing `output`, duplicate
  `input`, unknown tool and `llm` without model reach are named errors emitted
  before any code. `permissions.tools`/`permissions.llm` are derived from the
  graph, so the consent summary cannot drift from the code.
- The Studio was split for the canvas work: the 2025-line `SkillStudio.tsx` is
  now a 468-line container plus `web/src/studio/*`, re-exported from the
  original module with no CSS change.

## [0.1.18] — 2026-09-17

M27 S1 — app-scoped notes reach.

### Added

- A skill can read your notes with **no project root**: `ToolScope` is
  `{kind:'project'} | {kind:'app'}`, three read-only tools
  (`notes.list`/`notes.search`/`notes.read`) resolve against `APP_SCOPE_ID`,
  and grants live in a new **App data** group beside your roots.

## [0.1.17] — 2026-09-16

M27 S3 + S5 — skill reach.

### Added

- **Model reach**: `permissions.llm` enables `partner.llm.complete`, the
  skill's own `budget.maxTokens` is finally enforced and ledger-charged, and a
  mid-run overrun fails `budget_exceeded` with the worker killed. `skill.llm` is
  desktop-only.

### Fixed

- The session **client class** now reaches the runner from the session row, so
  an already-granted write can no longer walk a phone through the capability
  envelope.

## [0.1.16] — 2026-09-16

M26 — skill authoring.

### Added

- A **draft** (`skill_drafts`, schema **v21**): an inert, editable bundle held
  in your own encrypted DB. Describe a skill in chat (`skills.draft`) or build
  it in the **Skill Studio** (AI-assisted, template, or by hand), then read it,
  dry-run it in the sandbox, and install it.
- `fork`, in-place `edit`, and unsigned-bundle export/import (an import always
  lands as a draft).

### Notes

- The line held: a model may write code and ask, but only the owner makes it
  executable. Drafting runs nothing, validation is deterministic, install is a
  single `promote()` that re-validates, and widened permissions force
  re-consent.

## [0.1.15] — 2026-09-16

### Added

- Extraction reviews existing memory and pending suggestions before proposing
  (`ALREADY KNOWN` listing), so an already-known fact is never re-proposed.
- Inline HTML code blocks render as a tabbed **Code | Preview** viewer in chat,
  the assets read view and the note editor, with the pane sized like a real
  screen.

## [0.1.14] — 2026-09-16

### Added

- **Reconfigure existing providers** (M25): rediscover an endpoint's models
  through the key the OS keychain already holds and reassign which models each
  purpose profile carries — no key re-entry, no delete-and-recreate.

### Fixed

- **Attached photos now reach the model** (M24): vision capability is
  *declared* per provider (`providers.vision_models`, schema **v20**) instead of
  guessed from the model id; images encode to the 3 MiB inline budget (published
  as `maxInlineImageBytes`) rather than the 8 MiB upload cap; a turn can carry
  several photos (`MAX_INLINE_IMAGES_PER_TURN` = 4), and an image that cannot
  ride is described to the model as NOT sent.

## [0.1.13] — 2026-09-15

### Added

- Inline HTML code-block previews in chat, assets and notes.
- Global auto-remember independent of each persona's private-memory toggle.

### Fixed

- The turn-model fallback, so extraction never silently no-ops when a persona's
  cheap resolver yields no model.

## [0.1.12] — 2026-09-15

### Added

- **Scorecard chat answers** (M23): `:::partner.scorecard` rates several named
  items on one shared `scale=2–10`, one radio group per item, submitted as a
  single labelled turn.
- Global auto-remember via scope-aware suggestions.
- Per-provider search keys and a two-card provider picker.

## [0.1.11] — 2026-09-15

### Fixed

- A taken port no longer boots a core that serves nobody: readiness comes from
  the `listening` event and failure from `error`; `PORT=0`/malformed values are
  refused instead of silently falling back to 4390.

## [0.1.10] — 2026-09-14

### Added

- **Hosted sign-up by invite** (M22): the operator mints a single-use 256-bit
  invite (`tools/signup-link.mjs`); `POST /v1/auth/signup` creates the account
  and returns **no session** — sign-in stays the only authority path. There is
  deliberately no `open` mode.

## [0.1.9] — 2026-09-14

### Added

- Tap outside a floating pane to dismiss it, with the pane sliding out to its
  own edge (reduced-motion safe).
- Sidebar minimize toggle for tablet **and** desktop; the rail is a state with
  one `--side-w` knob, and the attention badge survives collapse.

## [0.1.8] — 2026-09-13

The hosted shape.

### Added

- **M20.A — mobile/tablet/touch UI**: bottom tab bar + More sheet, overlay
  rails, keyboard-safe composer, a 44px touch floor, and attention badges.
- **M20.B — the server role** (through S7 + S9): per-user partitions, `users` +
  scrypt credentials in a second encrypted system DB, session rotation/revoke,
  the client-class capability envelope, the device registry, and the transport
  matrix (TLS + named `ALLOWED_HOSTS`).
- **M21 — container + Cloudflare Tunnel**: a `file` keychain kind, a non-root
  live image, a two-service compose with the tunnel in its own network
  namespace, and operator-shell pairing.
- **M22 — remote-hosted accounts**: `AUTH_MODE=login`, `FIXED_ROOTS`,
  llm-self-service removed, per-client rate limiting, upload/JSON caps, a
  verified backup tool.

## [0.1.7] — 2026-09-12

M19 — persona-scoped memory & automatic remember.

### Added

- Per-persona private memory (off by default; recalled only while chatting with
  that persona).
- Automatic remember: after a turn, the persona's cheap model extracts durable
  facts as global or persona-scoped suggestions for confirmation in Memory.

## [0.1.6] — 2026-09-11

### Added

- Chat multi-question **forms** (M18): `:::partner.form` renders one textarea
  per question and submits once as a single labelled user turn.
- **Note projects** (M17): notes join projects many-to-many (no membership =
  Inbox); scoped list/graph with one-hop ghost nodes; schema **v16**.

## [0.1.5] — 2026-09-11

### Added

- Graph connectors that create note links (drag to relate notes).
- Persona model overrides as tick-to-enable provider model pickers.

## [0.1.4] — 2026-09-11

### Changed

- Version bump across `CORE_VERSION`, `tauri.conf` and npm packages.

### Fixed

- Notes graph "Open" on a linked brainstorm opens the chat.
- Chat continues the turn after a tool outcome (no silent search stall).
- Headless provider replies join the full delta stream.

## [0.1.3] — 2026-09-10

### Added

- `windows-build` posts the NSIS installer to its GitHub Release.

### Fixed

- Notes graph renders nodes + edges; discuss metadata no longer leaks across
  chats.

## [0.1.2] — 2026-09-09

M16 — knowledge workspace.

### Added

- Notes relationship graph (React Flow), brainstorm from notes & captures,
  note/capture versioning with diff + restore, Discuss in Assets, desktop
  export, and CSV assets rendered as tables. Schema **v13 → v14**.

## [0.1.1] — 2026-09-07

### Added

- Purpose providers with model assignment and a per-turn model switch; photo →
  vision handoff (M13).
- Scheduled & autonomous work (M14).
- Live desktop mode — the packaged shell boots LIVE by default (M15).

### Fixed

- A pre-created empty conversation is titled from its first user message.

## [0.1.0] — 2026-09-05

First tagged build: **M0–M9** — scaffold + Tauri shell + security spine,
providers/gateway/key import, tool broker & files, chat + persona engine v1,
memory & profile, plans & notes, theming, extension bridge & search actuator,
skills runtime, capability playbooks. Schema **v10**.
