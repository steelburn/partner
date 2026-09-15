# M11 — Chat as the workspace (feature details — reviewed, decisions locked)

Status: **complete — implemented & verified 2026-09-06** (remaining items
are manual / env-gated only) · Repo: `partner` (this checkout) · Master plan: `PLAN.md` (§3–§15) · Gates: same as M0–M10
(TDD red→green, token-only UI + `ux_audit` gate, redaction boundary, demo
mode parity, CI `verify` green on Linux + Windows legs).

## What this is

Feature-detail plan for the next product step after M10, built from the
user's eleven-point feature list plus a code-preview follow-up (F12). It
turns **chat into the center of the
workspace**: rich input (attachments, file references), rich execution
(tools, MCP, internet search inside a turn), rich output (HTML rendering,
auto-follow, clickable choices, copyable/convertible **Assets**), plus
governance (per-persona skill/tool policy, purpose-based providers) and
information architecture (Projects/Folders, Notes promoted to first class,
themes that demonstrably work everywhere).

Each section below anchors to the current code so reviewers can verify the
"status quo" claims. Where a feature needs a product decision, the doc gives
a recommended default and lists it in **§D — Decision log** (mirrors
PLAN.md §17).

---

## 0. Feature map

| # | Feature (user wording) | Work package | Core deltas | UI deltas | Depends on |
|---|---|---|---|---|---|
| 1 | Chat attachments & file references | F1 | schema v12, blobs, parts | composer attach UI, mention picker, attachment chips | C1, C2 |
| 2 | Tool calls, MCP, internet search in chat | F2 | tool catalog, chat tool loop, MCP client, search tool | tool activity cards, MCP server settings, search consent | C2, C3 |
| 3 | Persona default skills / skill ban / tool ban | F3 | persona policy columns, gate + invoke enforcement | persona policy editor | F2 |
| 4 | Purpose-based providers | F4 | provider `purpose`, resolver | provider form/table column, routing meta | — |
| 5 | Themes actually work | F5 | conformance fixes (core where needed) | sweep + gate | — |
| 6 | Notes prominent / first class | F6 | — (API exists) | IA rework, quick capture | F11 |
| 7 | Markdown response → HTML | F7 | — | `<Markdown>` renderer | C3 |
| 8 | Follow latest text by default | F8 | — | ChatStrip scroll manager | — |
| 9 | Clickable single/multi options | F9 | guidance injection, no new storage | choice block renderer + submit | C3, F7 |
| 10 | Copy / convert responses → Assets | F10 | assets store + extraction | message toolbar, assets panel, promote-to-note | C1, F7 |
| 11 | Chats into Projects/Folders | F11 | folders store + conversation binding | ConversationRail grouping | C1 |
| 12 | Code files (HTML/CSS) previewable — review follow-up | F12 | attachment content route | sandboxed `CodePreview` viewer | F1, F10 |

## Execution ledger (auto-execution pass, tests green)

Implemented + tested (core 624 / web 439 tests, all typechecks green, web
production build green):

- [x] **C1** schema v12 + `ensureColumn` migration helper (db-migrate tests)
- [x] **C3** `:::partner.*` container parser in shared/ + deterministic chat
      guidance injection (unit tests; persona system messages now carry the
      grammar suffix)
- [x] **F4** purpose-based providers (wire, resolver preference order,
      Providers UI purpose select/badges/filter)
- [x] **F11** folders for chats (core tree semantics + CRUD routes + rail
      tree UI with Inbox, nesting, rename/delete/move controls)
- [x] **F7** markdown→HTML renderer (`PartnerMarkdown` + GFM + sanitize;
      partner-file chips; server-render tests)
- [x] **F8** follow-latest transcript (pin at bottom, release on scroll-up,
      “↓ Latest” jump button)
- [x] **F9** clickable single/multi choices (`ChoiceCard`; confirm sends one
      normal user turn)
- [x] **F1 (uploads)** chat attachments: blob-deduped store, staged→bound on
      turn, text extraction into model context, conversation-scoped content
      route, chips + image thumbs + attach UI. Transport is the **raw request
      body** (content type = mime, `x-attachment-name` = the name, capped by
      `MAX_UPLOAD_BYTES`) — no multipart dep, and no base64 envelope: the
      envelope cost a third of the bytes and put every upload under the JSON
      body cap (M22/R7, `docs/VERIFY-M22.md`). iPhone **HEIC/HEIF is converted
      to JPEG in the SPA** before upload (`web/src/lib/image-convert.ts`)
- [x] **F12** hardened sandbox preview for HTML/CSS attachments (srcdoc +
      CSP + scripts-off default, external-ref strip/report; builder unit
      tests)
- [x] **F10** assets: typed store + manager + routes (list/save/promote) +
      candidate extractor, save dialog, drawer with copy/promote/delete;
      promote creates a Note with provenance (F6 bridge)
- [x] **F3** persona policy (defaults/bans for skills+tools): wire + storage
      + validation, gate refusal `tool_banned_by_persona`, skill-ban 423 at
      invoke, default-skill announcement in chat, editor UI
- [x] **F6 (core of it)** Notes promoted: Notes tab second, “＋ Note” header
      action + Ctrl+K quick capture (opens capture composer), NotesMini lane
      beside the chat transcript (three-zone workspace per D7)
- [x] **F5 (deterministic gates)** theme-conformance checklist
      (`docs/theme-conformance.md`) + APCA audit on the token pairs;
      token purity re-verified (single intentional exception)

- [x] **F2 (slice 1 — chat-directive tool pass)** plain-chat tool execution:
      `runChatToolPass` (core/src/chat/toolPass.ts) authorizes every
      `[[partner:tool …]]` directive a persona reply carries with the M9 gate
      (+ F3 policy bans) and routes through the broker — executed → result
      note; queued → persona approval row + note; refused → note — persisted
      as system messages for the next turn. Directive lines are hidden in the
      rendered bubble. MCP client, native function_calls, and the search
      backends remain later slices.

- [x] **F2 (slice 2 — MCP client + config API + UI)** stdio MCP client
      (JSON-RPC 2.0, initialize handshake, tools/list, tools/call;
      spawn/timeout/budget/kill guardrails), `mcp_servers` store +
      manager (default-deny OFF, enable/disable, validation, per-invocation
      sessions), `/v1/mcp/servers` CRUD + `/tools` + `/call` routes, audit
      hygiene, MCP panel under Providers (add/enable/tools/remove). Tests
      run against a real spawned fake stdio server + route tests.
      Remaining F2: native `tool_calls`, broker-integrated persona MCP
      auto-calls, search backends.

- [x] **F1 file references** `partner-file://` mentions: scoped
      autocomplete route (`GET /v1/files/refs` — walks ONLY roots with an
      active files.read grant; no filename leaks), composer `@`-mention
      popup (debounced search, keyboard nav, inserts the link), and the
      chat turn enriches model context by reading granted referenced files
      (capped, failures skipped) — parse + excerpt unit tests, route test
      with a real temp root/grant.

- [x] **F2 slice-1 route integration** (chatToolPass.integration): real chat
      turns against a directive-emitting fake upstream — granted read
      executes and persists the result note; assist persona refuses with no
      file leak.
- [x] **Live UI smoke (F5 partial)** against demo core + vite: paired;
      header order (Chat, Notes, ＋ Note…), Providers purpose filter chips,
      MCP panel, theme toggle, real chat turn with rendered assistant bubble
      incl. Copy / Save-to-Assets actions, conversation history reload.
      Notes: Ctrl+K capture is intentionally inert while the composer has
      focus (typing hijack guard); the rail “+ New folder” flow needs a
      follow-up visual pass.

- [x] **Rail “+ New folder” footer fix** — the create form now renders
      whether or not folders exist yet (the earlier empty-rail branch hid it;
      surfaced by the live smoke).

- [x] **F2 slice 3 (native tool_calls, gated)** — `POST /v1/chat
      {tools:true}` advertises the broker file tools; the OpenAI-compatible
      adapter now aggregates streaming `tool_calls` deltas into one
      end-of-turn `tool_calls` event (and reads full tool_calls from
      non-streaming JSON); the chat route executes native calls through the
      same gate/broker as directives (grant + persona independence + F3
      bans) and persists outcome notes. The client stream never carries the
      machinery event; everything stays byte-identical when tools:true is
      absent (assist personas are never advertised tools). Multi-round
      auto-continuation is intentionally still next-turn-history based (no
      hidden replay).

- [x] **F2 search backend (API-key, user-initiated)** — shared wire types,
      `core/src/search` manager (Tavily/Brave adapters over injectable fetch,
      default-deny OFF until enabled + keychain-held key, http-only-loopback
      endpoints, timeouts, audit = query LENGTH + hits only), `/v1/search/*`
      routes (config/key lifecycle, user-initiated query), wired through
      core + harness, plus `searchToolExternal` (the chat-tool seam kept for
      the next chat-search slice). Tests run against fake loopback upstreams
      + route tests. Chat-integration of the search tool itself and a UI
      panel remain for a later slice.

- [x] **F2 search IN CHAT** — the tool pass became async with an
      external-executor seam; dispatch is fixed to EXTERNAL manifests only
      (the earlier draft bug that routed broker tools through the search
      executor is root-caused + corrected), so `search` directives/native
      calls run against the enabled backend (auto+ personas; disabled
      backend = default-deny `external_disabled` note) while broker tools
      stay on broker.exec. Results are flattened so the summarizer keeps
      titles/urls/snippets in the persisted note. Route-integration tests
      cover enabled-execute and disabled-refuse.

- [x] **F2 search UI panel** — Providers gains an Internet-search section
      with **two provider cards** (Tavily/Brave). Each card carries its own
      keychain key (store/remove) and its own optional endpoint override;
      a **radio on the card selects the active provider** and saves
      immediately. Enabling (top row) unlocks the chat `search` tool at
      auto+ personas; an inline test search with result list stays below
      (client `lib/search.ts`, token-styled). State is per provider:
      keys live at `search:tavily`/`search:brave`, overrides in
      `SearchConfig.endpoints: {tavily, brave}`, and the config response
      carries `keys: {tavily, brave}` plus `hasKey` for the active
      provider. `PUT /v1/search/key` takes an optional `provider`,
      `DELETE /v1/search/key?provider=` targets one, and
      `PUT /v1/search/config` accepts `endpoints` patches. A legacy shared
      `search` key is migrated onto the configured provider and a legacy
      single `endpoint` is read as that provider's override.

- [x] **Persona MCP auto-calls (F2)** — the tool-pass external seam now
      takes an ARRAY of providers; `mcp:<serverId>/<tool>` ids resolve
      dynamically via `match` for ENABLED servers (default-deny; disabled
      servers and wrong formats refuse), medium-risk gated (auto+ personas),
      executed through the MCP manager (one stdio session per call) with
      flattened text outputs; broker tools are provably never routed to an
      external executor (regression-guard test). Directive grammar widened to
      allow `:` and `/` in tool ids. Unit + multi-provider dispatch tests;
      suites: core 670, web 440.

- [x] **Multimodal image parts (F1/C2, managed path)** — bound image
      attachments ride the newest user turn as an OpenAI content array
      (data URL image_url) ONLY when the resolved model is image-capable
      (vision-family hint util + inlineable-mime check, 3 MB cap); plain-text
      turns stay byte-identical. Persistence unchanged. Adapter + helper +
      route-integration tests (capable model inlines; non-capable stays
      text); suites: core 676, web 440.

- [x] **D10 persona home folder** — optional `homeFolderId` on personas
      (guarded `home_folder` column): new chats for that persona — created
      via POST /v1/conversations or auto-created by chat — land in its home
      folder when it still exists (explicit folderId wins; Inbox otherwise);
      folder deletion already clears chat placements. Persona editor gains a
      home-folder select. Tests: manager round-trip + route placement.

- [x] **D6 conversation-level themes** — per-conversation theme override
      (settings key `theme:conversation:<id>`); resolution order is now
      conversation -> persona -> global -> preset (`/v1/theme/active?personaId=&conversationId=`);
      `POST /v1/conversations/:id/theme {themeId|null}` binds/clears (validates
      conversation + theme). ChatStrip gains a per-conversation Theme select
      (Auto = persona/global); App refetches on persona/conversation change.
      Manager + route tests; suites: core 680, web 440.

- [x] **Drag-to-move chats** (rail) — drag a chat row's handle onto a folder
      row (or Inbox) to move it; highlight on drag-over, opacity feedback on
      the dragged item, HTML5 DnD guarded by the rail lock. The per-row
      move select remains as the accessible fallback.

- [x] **F5 live sweep (this auto pass)** — demo core + Vite, headless browser:
      paired; chat turn rendered with Copy / Save-to-Assets actions; Notes
      quick-capture opens via ＋ Note; Providers show MCP + Internet-search
      panels; Themes studio renders. **Zero console errors**; proof
      screenshots captured. (Purpose filter chips correctly only appear once
      providers exist; light/dark toggle verified in an earlier session.)
      Remaining manual polish: per-surface light/dark/custom walkthrough on
      the packaged app (checklist in docs/theme-conformance.md).
- [x] **Post-review deferrals — all closed in this same pass** (see the
      ledger entries below): extension-chrome theme stream, A/B persona
      studio, and the drag-to-move keyboard alternative (the per-row move
      select serves as the accessible fallback).

- [x] **A/B persona studio** — Personas view gains a compare card: pick two
      personas, one prompt, side-by-side live streams with model + token meta
      and per-side Copy. Runs via `/v1/chat {noPersist:true}` (new opt-out
      keeps comparisons off the rail; SSE has no done_meta and nothing is
      persisted — verified live: conversations count unchanged, zero console
      errors). Server + client tests; suites: core 681, web 440.

- [x] **F5 packaged-app sweep (current changes)** — rebuilt the NSIS
      desktop resources (web build + core bundle staged, incremental tauri
      release) and swept the PACKAGED app headlessly: Personas shows the A/B
      compare panel, Providers shows the MCP + Internet-search panels, Themes
      studio renders — zero console errors, proof screenshots. The
      home-folder select lives in the persona editor (opens on New/Edit),
      per the editor design.

- [x] **Extension-chrome theme stream** — core native session gains a
      `theme.active` command (returns the resolved ActiveTheme; `themes` dep
      optional — unknown_command when unwired); the MV3 popup requests it on
      open and applies light/dark tokens to its chrome CSS vars (neutral
      fallbacks offline). Core + extension tests; suites: core 683, web 440,
      extension 57.

Close-out (2026-09-06): the block that stood here was a mid-execution
snapshot and is superseded — every item on it shipped later in this file's
ledger (native `tool_calls`, MCP stdio client + persona auto-calls, wired
API-key search in chat + UI panel, `@`-mention file refs, multimodal image
parts, persona home folder, drag-to-move chats, extension-chrome theme
stream, A/B persona studio, D6 conversation-level themes). MCP **server**
exposure stays a documented non-goal (PLAN §16). §Z's ordering and release
slices are historical — all four slices shipped.

---

## C1 — Schema v12 & idempotent column migrations

**Status quo.** `core/src/stores/db.ts` applies `SCHEMA_SQL` with
`CREATE TABLE IF NOT EXISTS` only — additive tables are free, but **no
existing table has ever gained a column** and there is no ALTER path. The
`schema_version` key lives in `meta`, stamped from `SCHEMA_VERSION`
(`shared/src/contracts.ts`, currently `11`). Managers/rows in
`core/src/stores/types.ts` mirror columns 1:1.

**Design.** Introduce one helper and keep the additive philosophy:

- `ensureColumn(db, table, column, ddl)` — checks `PRAGMA table_info(table)`
  and runs `ALTER TABLE … ADD COLUMN …` when the column is missing. Safe
  when opening twice; only ever adds nullable/defaulted columns.
- Bump `SCHEMA_VERSION` to `12` (single shared bump; config/health already
  surface it).
- New tables (all via `CREATE TABLE IF NOT EXISTS`, additive): `chat_blobs`,
  `attachments`, `assets`, `folders`, `mcp_servers` (exact DDL per F1/F10/
  F11/F2).
- Guarded columns added to existing tables:
  - `messages` + `content_type TEXT NOT NULL DEFAULT 'text'` (F1/C2),
  - `personas` + `policy TEXT` (JSON, F3),
  - `providers` + `purpose TEXT NOT NULL DEFAULT 'general'` (F4),
  - `conversations` + `folder_id TEXT` (nullable FK, F11).
- Storage note: attachment/asset **payloads live inside SQLite rows** (small,
  whole-file encrypted at rest via the M10 SQLCipher build — no plaintext
  side files). Hard caps per blob (§F1) keep DB growth bounded.

**Tests.** New `core/test/stores/db-migrate.test.ts`: (a) fresh DB opens at
v12; (b) a DB opened at v11 (fixture created by applying v11 `SCHEMA_SQL`)
upgrades in place and keeps rows; (c) `ensureColumn` is idempotent across
double-open. **Exit:** migration green on `:memory:` and file DBs (live
mode), suite otherwise unchanged.

---

## C2 — Message content parts (multimodal seam)

**Status quo.** `ChatMessage.content` and persisted `messages.content` are a
single string; `ConversationMessage.content` is the wire/persist shape;
SSE delivers `delta` text only; the OpenAI-compatible adapter
(`core/src/gateway/openaiCompatible.ts`) maps one text message to the API.

**Design.** Widen *without breaking* the v1 wire:

- `shared/src/contracts.ts`: `content: string | ContentPart[]` where
  `ContentPart = { kind:'text'; text } | { kind:'image'; mime; b64 } |
  { kind:'fileRef'; refId }` (refId resolves server-side to an attachment
  or a root-granted file — see F1).
- Persistence: `messages` keep `content` as the canonical markdown text
  (`content_type='text'` rows unchanged; `'parts'` rows store text joined
  from parts + payloads live in `attachments`/`chat_blobs` — never inline
  base64 in the row). History rehydrates to parts for the UI and to the
  adapter only when multimodal is needed.
- Adapters: `openaiCompatible.ts` maps parts → OpenAI content array
  (`text` + `image_url` data URL) only for models that accept images
  (resolver decides via task class/model allowlist — demo provider accepts
  parts and echoes text, so demo mode exercises the path headlessly).
- Guardrails: image part size cap (default 4 MB, count cap per message),
  mime allowlist (`image/png|jpeg|webp|gif`), re-encode down if needed
  (web side before upload); no executable/archive types in v1.

**Tests.** `core/test/gateway`: adapter maps parts and rejects oversized
images; demo provider echoes parts. **Exit:** a `/v1/chat` turn carrying an
image part reaches a fake vision-capable provider; history round-trips.

---

## C3 — Structured-response protocol (markers, guidance, parsing)

**Status quo.** The only structured channel out of chat today is the M9 tool
directive `[[partner:tool id {…}]]` parsed line-wise by
`core/src/playbooks/directives.ts` and consumed by `loop.ts`. Assistant
content is otherwise free markdown rendered as plain text (§F7). There is no
place where core appends behaviour guidance to a persona's system prompt
today (persona `systemPrompt` is user text).

**Design.** A single, model-agnostic container syntax for structured UI
blocks, chosen so plain chat still works with any model and unparsed
markers degrade to readable text:

- **Markers** (fenced, GFM-style custom containers, emitted by the model,
  produced under guidance):
  - `:::partner.choice mode=single|multi` + title + bullet options → clickable
    choices (§F9);
  - `:::partner.asset kind=… title=…` + body (markdown) → asset payload
    (§F10);
  - `:::partner.result …` (tool execution cards, §F2) — reused for skill/
    search results so every side effect renders as a distinct card instead
    of inline JSON.
- `shared/src/structured.ts` (new, zero-dep): the single parser for these
  containers + JSON args; used by the web renderer (streaming-tolerant:
  materialize a block only when its closing fence arrives) and by the core
  when it needs to consume them (assets indexer §F10).
- **Guidance injection point**: new `core/src/chat/instructions.ts` that
  builds a deterministic, feature-flagged suffix appended to the effective
  system prompt per turn (which containers are available, when to use them,
  size rules). Turned on per conversation once the persona's model is known
  to comply; off for session-only chat defaults. The suffix is owner data
  and never enters audit.
- Renderer rules: unknown `:::` containers render as their text content,
  never raw; all content sanitized (§F7).

**Tests.** Parser unit tests (single/multi, malformed, nested, streaming
prefixes); instructions module tests assert the suffix is deterministic and
redaction-clean. **Exit:** a demo persona whose system prompt asks for
`:::partner.choice` emits a block; the UI renders it as chips (§F9) and the
raw markdown stays the persisted truth.

---

## F1 — Chat attachments & file references

**Status quo.** No upload/attachment surface anywhere: the composer is one
textarea (`ChatStrip`), `/v1/chat` accepts `messages/model/personaId/
conversationId/taskClass` only, and there is no multipart route. Local files
are reachable only through project-root **file tools**
(`core/src/files/tools.ts`, broker-gated) and the M2 proposals flow. Notes
are markdown text; nothing references "the file behind an answer".

**Goal.** (a) Attach files to a chat turn (image + text) with type/size
caps; (b) reference a local file inside a granted project root by mention,
so the persona sees it (allowed) and future turns carry the reference.

**Design.**

1. **Tables** (C1): `chat_blobs(id, sha256, mime, size, data BLOB, created_at)`
   + `attachments(id, conversation_id, message_id NULL, kind 'upload'|
   'ref', name, mime, size, sha256, blob_id NULL | root_path JSON NULL,
   extract_text NULL, created_at)`. Uploads before a turn is sent are
   staged rows with `message_id NULL`, bound to the conversation on send.
2. **API**:
   - `POST /v1/conversations/:id/attachments` (multipart, staged draft row;
     caps + allowlist enforced; returns `{attachmentId, name, mime, size}`);
   - `DELETE /v1/conversations/:id/attachments/:attId` (abort a staged
     attach; deleting a bound attachment removes its blob and nulls refs);
   - `POST /v1/chat` gains `attachmentIds?: string[]` on the newest user
     turn — the core binds staged rows, resolves them to parts (text:
     inline excerpt/`fileRef`; image: `image` part to a vision-capable
     model; see C2) and persists the turn;
   - `GET /v1/files/refs?q=` — mention autocomplete **inside granted
     roots only**, returning `{rootId, path, kind}` (server-side scoped
     list; the web UI never walks paths itself).
3. **Mention syntax**: `@path/within-root` in the composer → chip; resolves
   client-side via the refs endpoint into a `fileRef` part on send.
   Assistant replies may cite a file as `[name](partner-file://<rootId>/<path>)`
   which renders as a chip that opens the file in Files/RootTryTool when a
   grant exists (root check enforced at render/link-open time, default-deny).
4. **Extraction**: text files (txt/md/csv/json/code) are read inline for
   context; images are passed as image parts (not OCR'd in v1); PDF/DOCX/
   XLSX extraction is **D2** (off by default — needs an extraction worker;
   until then they upload as opaque references the persona may not read).
5. **Security**: content is owner data (never in audit/logs/errors — same
   rule as notes §M5); blob access requires the conversation's session;
   attachments are per-conversation, never shared across chats; delete
   conversation cascades attachments (mirror messages cascade).
6. **UI**: composer gains an attach button + drag-drop zone (type/size
   feedback), staged chips with remove; mention autocomplete popover
   (keyboard accessible); assistant file chips render with open affordance. HTML/CSS attachments
   additionally offer **Preview** (F12).
   All styles token-only (DIS discipline: focus-visible/disabled states).

**Tests.** Route tests (supertest): upload caps/allowlist, staged→bound on
chat, cascade delete, refs endpoint only lists grant-covered paths, refs
deny outside roots. Adapter tests per C2. **Exit:** end-to-end — attach an
image + mention a root file, demo vision persona replies referencing both,
history reload shows chips not raw text.

---

## F2 — Tools, MCP and internet search inside chat

**Status quo.** Tool execution today happens **outside the plain chat turn**:
(a) M9 playbook tool loop (`core/src/playbooks/loop.ts` +
`gate.ts`/`directives.ts`) runs only when a playbook drives the reply and
only via the text directive `[[partner:tool …]]`; (b) broker tools are the
closed set `files.*` (`shared/src/tools.ts` union) acting in project roots;
(c) approvals queue `/v1/tools/pending` + FilesView badge poll; (d) skills
run as separate workers (`/v1/skills/:id/invoke`) not reachable from chat;
(e) internet: per-site browser scopes exist (`core/src/browser/scopes.ts`),
the extension actuator is env-gated, and there is **no search tool** wired
to chat (the §6.2 API-key adapter is not present in core).

**Goal.** Any chat turn may transparently use: broker file tools, MCP
server tools, skill entrypoints, and internet search — each behind
default-deny authorization, with visible activity in the transcript.

**Design.**

1. **Open tool catalog** (`core/src/tools/registry.ts`): one runtime map of
   `ToolSpec { id: string; description; inputSchema: JSON Schema; risk;
   network: boolean; confirm; origin: 'builtin'|'mcp'|'skill'|'search' }`.
   `ToolId` widens from the closed union to `string` (`shared/src/tools.ts`),
   with a keep-list registry so unknown ids still fail closed. Builtin
   `files.*` specs move here unchanged.
2. **Native function-calling in chat**: new `core/src/chat/loop.ts` reuses
   the M9 loop's authorization/resume machinery (`authorizeTool`,
   `summarizeToolResult`, broker decide) but drives the model's native
   `tools`/`tool_calls` when the provider supports it (OpenAI-compatible
   `tools` array + `tool_calls` round); the legacy directive path stays for
   providers without native support. Loop bounds (`LOOP_MAX_ROUNDS`) and
   `no_provider` semantics carry over. Tool events stream over SSE as new
   `ChatEvent` variants `tool.started` / `tool.result` / `tool.waiting`
   (approval) so the transcript can render cards (§C3) instead of only the
   Files badge.
3. **MCP client**: `mcp_servers` table (C1): `{id, name, transport
   'stdio'|'http', command/args/env | url, headers JSON (secret refs only),
   enabled, addedAt}`. `core/src/mcp/client.ts` connects on demand, lists
   tools (`listTools` → catalog entries `mcp:<server>:<tool>`), and executes
   through the broker with manifest-derived risk. Default-deny: a server is
   off until the user enables it; every tool needs a broker grant (scope
   kind `'mcp-server'`); stdio children get a wall-clock budget + kill
   (mirror skills runner); http transport refuses loopback targets by
   default and stores headers only as keychain refs (redaction discipline).
   MCP **server** exposure stays a non-goal (PLAN §16) — this is client-only.
4. **Internet search tool**: single `search` tool id with two backends under
   `core/src/search/`: `browser` (sends capture intents to the extension
   bridge, §4.5/§6.2, site-scope gated, engine blocklist) and `apikey`
   (user-configured Tavily/Brave-class adapter; secret in keychain). A
   backend is present only when configured/enabled; risk `medium`,
   `network: true`, confirm `once` per backend (reuse broker risk UX). This
   is the §6.2 "toggle, not a rewrite" landing in chat.
5. **Skills in chat**: catalog exposes installed skills as `skill:<id>` tool
   specs (invoke args = skill input JSON) so a chat persona can call them
   under the same gate; the dedicated `/v1/skills/:id/invoke` surface stays.
6. **Security**: every execution writes audit (`chat.tool` rows: ids,
   decisions, elapsed — never params/results/content, matching
   `playbook.tool`); F3 bans apply before the broker; grants remain
   revocable per tool+scope; kill switch unchanged.

**UI.** Tool activity cards in transcript (started → result excerpt/
waiting-for-approval, open approval inline or via Files badge);
`MCP servers` panel under Providers (enable/disable, add stdio/http,
per-server tool list + grant state); search backend consent chip first use.

**Tests.** Chat loop: native tool_calls round with fake provider; directive
fallback parity; approval pause/resume. MCP: fake stdio server listTools/
callTools end-to-end; default-deny matrix; budget kill. Search: fake API-key
backend; browser backend returns 501-not-configured when extension absent.
**Exit:** one turn = persona reads a root file via native tool call, then
searches via API-key backend, and cites both — all visible as cards, all
audited id-only, no unapproved execution.

---

## F3 — Persona default skills / skill ban / tool ban

**Status quo.** Personas (`shared/src/persona.ts`, `personas` table) carry
no skills list and no tool policy: capability comes only from
`independence.level`, `requireHumanFor`, `autoScopes`, and the playbook the
persona runs (M9's gate refuses `tool_not_in_playbook`). Persona Studio
(`PersonaManagerView`) edits character/model/independence/memory/theme only.

**Goal.** A persona declares **which skills it has by default**, **which
skills it may never use**, and **which tools it may never call** — enforced
server-side everywhere a persona acts (chat loop, playbook loop, skill
invoke), overridable by the user editing the persona, never per-call.

**Design.**

1. **Model** — `Persona.policy` (new optional field, JSON column `policy`):
   ```ts
   interface PersonaPolicy {
     skills?: { default?: string[]; banned?: string[] };
     tools?: { banned?: string[]; allowed?: string[] }; // allowed = allowlist override
   }
   ```
   Defaults come from `settings` (global skill/tool bans) so the user can
   lock capabilities app-wide; a persona may tighten but not loosen a global
   ban (D3: bans are intersectional — persona policy ∧ global policy).
2. **Semantics**: `default skills` load into any new conversation's context
   for that persona (system guidance + available `skill:` tools, F2) and
   drive playbook suggestions; `banned skills` refuse `/v1/skills/:id/invoke`
   with `personaId` (423 `skill_banned`) and remove any `skill:` catalog
   entry; `banned tools` are filtered from the catalog for that persona and
   blocked in `authorizeTool` (new refuse reason `tool_banned_by_persona`)
   even when an `autoScope` would allow — bans beat the independence
   envelope; a persona `allowed` list is a strict allowlist when present.
   Explicit **user** (web) actions are not persona actions — they keep
   broker rules (D4).
3. **UI**: persona editor gains a Policy section: searchable skill catalog +
   installed tool list with three states per row (default/allow / neutral /
   ban) and plain-language summary ("Maya can research + code, never
   deploys, never calls shell:…"). Global policy editor lives in Settings
   (new small view or under Personas).
4. **Audit**: policy changes audit as `persona.policy` with id/actor only;
   every ban-refusal audits (`skill_banned`/`tool_banned_by_persona`) so
   "why didn't it do that" is answerable.

**Tests.** Unit: policy intersection, ban-vs-default precedence, allowlist
mode, invoke refusal codes. Route: persona policy CRUD; chat turn against a
persona whose policy bans the tool its playbook requests → refusal note in
transcript and audit row. **Exit:** matrix of (skill default/ban × tool
ban/allow × independence level) behaves as specified with no bypass via
playbook or invoke paths.

---

## F4 — Purpose-based providers

**Status quo.** Providers are single-purpose-free: `ProviderSummary` =
name/kind/endpoint/defaultModels/enabled/budget/health
(`shared/src/provider.ts`); a persona pins `providerId` or the resolver
picks the first enabled provider, then maps taskClass → model on it
(`core/src/gateway/resolver.ts`, `resolveChatModel`). "Which provider suits
this job" is invisible to the UI and routing.

**Goal.** Tag each provider with a **purpose**; routing prefers the provider
whose purpose matches the task class; the chat meta line and Providers view
make the choice legible.

**Design.**

1. **Model**: `purpose: ProviderPurpose` where
   `'general' | 'cheap' | 'deep' | 'coding' | 'vision' | 'research'`
   (mirrors `TaskClass` + research), default `'general'`. Stored in the
   existing `default_models` JSON column? No — new guarded column `purpose`
   (C1). Imported llm-self-service providers default to `general`.
2. **Resolver change** (`resolver.ts`): resolution order becomes
   (a) persona/model/requested explicit provider → (b) best enabled
   provider matching the task class's purpose (`chat`→general, `cheap`→
   cheap, `deep`→deep or general, `coding`→coding or general, `vision`→
   vision, research flows → research or general) → (c) first enabled. Model
   fallback chain unchanged.
3. **Capability honesty**: the Providers view shows purpose + health + known
   models; when purpose `vision`/`coding` is selected the UI prompts to pin
   the model ids used for that purpose (defaults from `/v1/models`);
   demo provider advertises `general` and stays the fallback in demo mode.
4. **UI**: purpose dropdown on create/edit; purpose column + filter chips on
   the list; chat meta line already shows model → extend with provider
   purpose when the resolved provider isn't general ("gpt-4.1-mini · Cheap
   Provider · cheap"). Persona taskClass model pickers group models by the
   provider they come from + its purpose.
5. **Session-only chat** (M10 W5) gets an optional purpose selection too.

**Tests.** Resolver matrix (taskClass × purposes × availability) with
disabled-provider and no-match cases; provider CRUD round-trip keeps
purpose; demo/import defaults. **Exit:** persona set to `cheap` task model
resolves to the cheap-purpose provider when enabled, general otherwise —
verified by route test and visible meta.

---

## F5 — Make themes work everywhere

**Status quo.** Theming is largely built and clean: token-only components
(zero raw hex in `web/src/app.css`), `theme/v1` schema, presets, Theme
Studio (`ThemeStudio.tsx`), save gate (lint + APCA/WCAG), persona binding
(`/v1/personas/:id/theme`), active-theme resolution persona → global →
preset (`theming/manager.ts`), mode toggle, and first-paint cache
(`web/src/theme/apply.ts` `bootApply`). "Work" here is therefore a
**conformance question**, not a build question.

**Goal (D5 — confirm scope in a 30-minute triage first):** every surface the
user sees honors the active theme + mode and saves/persists what the user
expects. Presumed gaps to verify, in order:

1. **Surfaces audit**: session-only chat (`SessionChat.tsx`), Notes/Plans
   editors, Memory/Audit/Files views, Playbooks/Deploy flows, PairGate,
   scrollbars/selection/`color-scheme` — all consume `var(--…)` only;
   anything pinned to base tokens is a bug. Automated: extend the token
   grep to include all `web/src/**` and flag non-`var()` colors outside
   ThemeStudio inputs (already the only current offender).
2. **Per-persona theming in practice**: pick a persona → its theme applies
   while that persona is active in chat (persona picker switch already
   refetches active theme — verify no flash / stale cache on rapid
   switching); conversation-level override stays a later option (D6).
3. **Persistence**: active theme id + mode survive reload (cache exists —
   verify global active theme re-asserts after pairing, not just the cached
   pair); un-activating a theme restores the preset.
4. **Contrast honesty**: user-saved themes are re-gated on load (a theme
   that fails the gate after a token schema change is flagged, not silently
   applied); Theme Studio surfaces warnings inline (mostly exists — verify
   warning rows for marginal pairs).
5. **Extension chrome**: extension consumes the core's active theme stream
   (M6 intent). Extension UI is currently minimal/env-gated — wire the
   theme endpoint and apply vars there or record the deferral in the doc.
6. **Regression gate**: run `ux_audit` (contrast pairs across presets +
   focus/disabled state coverage) on every view touched by M11; the audit
   tool is part of the UI gate, as in M10 W4.

**Exit.** Theme conformance checklist (`docs/theme-conformance.md`) passes:
every listed surface honors active theme + mode under light/dark, per-
persona binding switches without flash, reload restores exactly, and
`ux_audit` is green on the touched views.

---

## F6 — Notes promoted to first class

**Status quo.** Notes & Plans live behind a mid-list header tab
(`NotesView`/`NotesSegment`/`PlansSegment`), equal to Audit/Skills; the chat
view has no notes presence; quick capture exists only inside the Notes view
(`/v1/notes/capture`); there is no global "new note" affordance.

**Goal.** Notes become a primary surface of the app — reachable in one
click from anywhere, cheap to write into, and clearly connected to chat
(which is where most notes will start, via F10 promotion and F1 file refs).

**Design (D7 — decided: Candidate A adopted):**

1. **Nav + command surface**: reorder header views: Chat · **Notes** ·
   Plans? · Personas · … (Notes second). Keyboard path: `/`-style command
   palette or `Ctrl+N` new note / `Ctrl+K` quick capture (existing brand
   has no palette — add a minimal one scoped to notes + chat actions).
2. **Three-zone chat workspace (Candidate A — adopted)**: the chat view
   gains a slim notes rail between the conversation rail and the transcript
   (recents + daily note + "new"), so notes and chat coexist; the Notes tab
   remains for the full browser. Candidate B (global Library lane nesting
   folders under Chats | Notes | Plans | Assets) is shelved unless folders
   mature.
3. **Global Quick Capture**: a persistent header button (and palette
   action) opens an inline capture composer with daily-note default
   (`/v1/notes/capture`, daily summarize stays), one hotkey away.

**Connections.** Chat → note: F10 asset promote ("Save as
note" adds provenance header + backlink); note → chat: "Ask partner about
this note" sends the note body/ref into a conversation; assistant file chips
(F1) link granted files into notes.

**Exit.** One click + one hotkey create a note from anywhere; daily capture
visible without opening Notes tab; chat→note promotion (F10) lands in
Notes with provenance; ux_audit green on the reworked shell.

---

## F7 — Markdown responses render as HTML

**Status quo.** `ChatStrip` renders message text as raw text nodes
(`row.text` in a div) — no markdown, no HTML, no styling; the repo has zero
markdown dependencies; notes/plans/memory/playbook UIs also render bodies as
plain text. Core never renders (correct).

**Goal.** A token-styled, sanitized markdown → HTML renderer used by chat
assistant messages and progressively by every body surface (notes/plans
preview, memory episodes, playbook transcripts).

**Design.**

1. Add `react-markdown` (+ `remark-gfm`) to `web` — the only markdown dep,
   ESM-friendly in Vite. **No raw HTML is ever rendered**: react-markdown's
   default skips raw HTML; add `rehype-sanitize` with an allowlist as
   belt-and-braces. Links render `target=_blank rel="noopener noreferrer"`;
   `partner-file://` links (F1) are intercepted, never opened raw.
2. `web/src/Markdown.tsx`: styled with tokens only — headings use the
   modular scale, inline code/`code blocks` get copy buttons, tables wrap,
   lists/blockquote follow DESIGN.md; supports the structured containers
   from C3 (choice/asset/result) as registered components.
3. Streaming: re-parse per delta is wasteful — memoize parsing at the block
   level; a message is re-rendered only on closed blocks during stream
   (full parse on turn end). Keep caret/live-region behavior sane
   (`aria-live` + follow-latest §F8).
4. Progressive rollout: chat first; all markdown surfaces follow (the
   assets read view reuses the same renderer). Notes now has a live
   preview toggle beside the textarea (edit stays plain textarea until a
   proper editor milestone); Plans is untouched.

**Tests.** Component tests: sanitization (raw `<script>`, event-handler
attrs stripped), GFM tables/code/links, partner-file interception,
structured containers. **Exit:** a hostile markdown payload from the demo
provider renders inert; tables and code blocks copyable; everything token-
styled (ux_audit contrast pass).

---

## F8 — Follow the latest text by default

**Status quo.** `.chat-transcript` is a plain overflow container; the user
must scroll down to follow a stream; no scroll-lock affordance, no
"new messages" cue.

**Goal.** While a turn streams (and on history load), the transcript
**stays pinned to the newest text**; if the user scrolls up to read, the
pin releases and a floating "Latest ↓" affordance (with count of new
content while away) returns them.

**Design (all in `ChatStrip`):**

1. Scroll manager (`useChatScroll` hook in `web/src/lib/`): pinned =
   user is at/near bottom (within 48 px) **or** hasn't scrolled up this
   conversation since mount/load; on content change while pinned →
   `scrollIntoView` (block end) via rAF, one scroll per batch of deltas, no
   per-keystroke thrash; history load always pins; streaming start pins.
2. Unpin on any upward scroll (`onScroll`), with a 24px "stickiness"
   tolerance so accidental tiny scrolls don't fight the pin.
3. Affordance: floating button bottom-right of transcript ("Jump to latest",
   icon ↓), visible only when unpinned and content arrived while away; badge
   counts lines/blocks added while away; click → pin + scroll.
4. `prefers-reduced-motion`: instant scroll, no smooth animation.
5. The composer stays visible and out of the stream's way (existing layout).

**Tests.** Component tests with a fake scroll container: pin on load, pin
during stream, unpin on user scroll, badge count, reduced-motion. **Exit:**
during a demo stream the newest line stays visible without input; scrolling
up mid-stream keeps position and the affordance returns the user to latest.

---

## F9 — Clickable options (single and multiple choice)

**Status quo.** There is no structured interaction in chat: when the model
asks a question with options ("reply 1, 2 or 3"), the user retypes.

**Goal.** When a persona asks a question whose answer is a choice, the
options render as **clickable controls** — radio for single choice, check
boxes for multiple — and answering is one click (+ Enter), producing a
normal, persisted user message so nothing about the conversation model
changes.

**Design.**

1. **Grammar** (C3): a `:::partner.choice mode=single|multi` container with
   a title and markdown bullets; options are the bullets. Anything not in a
   container stays plain prose (heuristic fallback is **not** in scope —
   D8).
2. **Renderer**: within the assistant bubble, containers render as
   fieldset+legend (title), radios or checkboxes per `mode` (token-styled,
   full keyboard/focus-visible support), and a single primary **Confirm**
   button (disabled until a selection). Escaping: "None of these" free-text
   affordance appends an input; keyboard: arrows select, Enter confirms.
3. **Submit semantics**: confirming appends a **user** message to the
   transcript of the form `Answer: <chosen labels>` (or the free text) and
   sends it as the next turn through the normal `/v1/chat` path — persisted,
   honest, replayable, works with every model. No client-only state that
   the model can't see.
4. **Multi-choice** sends one combined answer message (labels, comma/
   semicolon separated) so it reads naturally in history.
5. Guidance (C3) tells capable personas to emit containers for choices; the
   model keeps full control of option text and mode.

**Tests.** Parser unit tests per C3; component tests for both modes incl.
keyboard + disabled states; route-level test that confirm sends exactly one
user message and the model's next turn uses it. **Exit:** demo persona asks
a two-option question; both single and multi flows complete with one click;
history shows the answer as a plain user message.

---

## F10 — Response → copy & Assets

**Status quo.** Assistant messages are plain text with no per-message
actions; nothing is copyable in one action; there is no "save this output"
path except manually pasting into Notes; no reference/tracking of what a
document derives from.

**Goal.** Every assistant response can be (a) **copied** (markdown and/or
rendered HTML), and (b) **converted into Assets** — first-class, stored,
typed artifacts (see taxonomy below) that live with the conversation, can be
copied, exported, and promoted into Notes with provenance.

**Asset taxonomy (extensible; suggested additions marked ★):** document
(heading section), table, code, reference list (links with context — from
research/web results and local `partner-file:` refs), image (markdown image
refs / rendered images), deduction (reasoning/claim chain), decision ★,
action item / todo ★, definition ★, draft (email/doc/slide/design spec) ★,
data table → chart ★, quote/excerpt ★. Unknown → `custom` with a title +
body (freeform markdown). Kinds are an open union; the taxonomy is the v1
curated set + a schema-validated custom path (the user asked us to suggest
more kinds — the ★ set is our proposal).

**Design.**

1. **Message toolbar** (per assistant message): Copy (markdown) · Copy as
   HTML (rendered DOM, sanitized) · Save to Assets · selection-aware:
   selecting a text range offers "Save selection as asset".
2. **Extraction** — two routes, both non-destructive:
   - *Heuristic* (instant, local): tables → `table`; fenced code → `code`;
     `:::partner.asset` containers → their kind; link lists with context →
     `reference list`; heading sections → `document` candidates.
   - *Explicit*: `:::partner.asset kind=… title=…` emitted under C3
     guidance when the persona produced a deliberate artifact (deduction,
     decision, draft…). Explicit wins over heuristic.
   - Save flow opens a lightbox: extracted candidates listed with editable
     title/kind before commit; nothing is written until the user confirms.
3. **Store** — `assets` table (C1): `{id, conversation_id, message_id,
   kind, title, body TEXT (markdown), meta JSON (source refs, model,
   extraction mode), tags, created_at}`; payload bodies are owner data (same
   boundary as notes; never in audit). `schema v12`. Assets survive
   conversation rename; deleting a conversation asks about its assets.
4. **Surfaces**: Assets panel for the open conversation (right-hand pane
   toggle or collapsible strip below the rail); each asset: Copy (md),
   Open in Notes (promote: creates a note whose body = asset + provenance
   header "From chat …, via persona …, refs …" and a backlink), Export
   (`.md`), Delete. Code assets in `html`/`css` add **Preview** (F12).
   Global assets view under Notes (aggregate, per F6).
5. **Promote-to-note** is the F6 handshake: provenance block links back to
   the conversation + message id (deep link into chat).

**Tests.** Extraction units (heuristic + explicit precedence); assets route
CRUD + cascade rules; promote-to-note creates note with provenance header
and backlink; copy-as-HTML contains sanitized DOM. **Exit:** a research
turn with a table, a code fence, and citations saves as 3 typed assets in
one flow; each promotes to a note with working backlink to the source
message.

---

## F11 — Chats organized into Projects/Folders

**Status quo.** `conversations` is a flat list (ConversationRail, no
grouping); nothing organizes chats; files already own the "project root"
concept (`ProjectRoot`), which we must not overload.

**Goal.** A **folder tree** for conversations (name per the user's
"Projects/Folder"; D9 settles the label) with arbitrary depth, collapsible
grouping in the rail, move/create/rename/delete, plus an always-present
"All chats / Inbox" home.

**Design.**

1. **Model**: `folders` table (C1): `{id, name, parent_id NULL, position,
   created_at, updated_at}` (cycle-guarded tree — one parent, no cycles);
   `conversations.folder_id` (guarded column, nullable, ON DELETE SET NULL
   semantics handled in manager, not FK cascade). Naming: entity is
   **folder**; a folder whose chats share a goal may later grow project
   metadata (decision D9) without rework.
2. **API**: `GET/POST /v1/folders`, `PUT /v1/folders/:id`
   (rename/move), `DELETE /v1/folders/:id` (children reparent to parent or
   root; conversations → inbox); `PUT /v1/conversations/:id` gains
   `{folderId}` (move); `GET /v1/conversations?folderId=` filter; summary
   payloads include `folderId` + `folderPath[]`.
3. **Auto-placement**: new conversations land in Inbox unless the rail
   context or a persona default folder says otherwise (persona-level
   "home folder" is a later option — D10).
4. **UI (ConversationRail)**: tree with disclosure triangles, count badges,
   hover actions (rename/delete/move), "New folder", drag-to-move chats
   (keyboard alternative: move menu) — token-styled; persists open/closed
   state per session; deep-linkable `#/folder/<id>` later.
5. Folders are chat-scoped in this milestone; Notes/Plans keep tags +
   wiki-links (their own first-class structure, F6); Assets live with their
   conversation.

**Tests.** Tree CRUD + cycle rejection + delete reparent; move
conversation; list filter; cascade inbox semantics. Component tests for
grouping/aria (tree role, expand/collapse keys). **Exit:** a fresh
conversation created inside "Projects/Alpha" shows under that folder after
reload; deleting a folder empties gracefully.

---

## F12 — Previewable code files (HTML/CSS) — added at review

**Status quo.** Nothing renders an HTML/CSS file today: file bodies live
behind broker tools/proposals, attachments are new (F1), code assets (F10)
are text — "partner, write me a page" ends in copy-paste into a browser.

**Goal.** Code surfaced anywhere in the product — an attached `.html`/
`.css` file (F1), a `kind=code` asset holding HTML/CSS (F10), or a granted
project file from Files — can be **previewed as a rendered document**
inside a hardened sandbox; the content never leaves the machine.

**Design.**

1. **One component, three targets**: `web/src/CodePreview.tsx` +
   `web/src/lib/preview.ts` serve F1 attachment chips, F10 code assets
   (`html`/`css`), and Files view rows for granted `.html`/`.css`.
2. **Sandbox**: render via iframe `srcdoc` with `sandbox="allow-scripts?"`
   where scripts are OFF by default (D13) and **`allow-same-origin` is never
   granted**; `allow-forms`/`allow-popups`/`allow-top-navigation` absent; a
   CSP meta in the doc (`default-src 'none'; img-src data:; style-src
   'unsafe-inline'`) blocks network even after the per-preview, opt-in
   "Enable scripts" toggle (default off; visibly armed; resets on
   conversation/file switch). A warning line states "Preview is sandboxed —
   external resources and network are blocked".
3. **Single-file v1 (D14)**: inline `<style>` renders; `<link rel=stylesheet>`
   refs to sibling attachments in the same conversation resolve and inline
   at preview time (client reads each blob via the content route below);
   all other external refs are stripped and reported ("3 external resources
   blocked"). `data:` images render; external `http(s)` images blocked.
4. **Core**: `GET /v1/conversations/:id/attachments/:attId/content`
   (conversation-scoped, text-mime allowlist, audit ids only) feeds the
   preview builder. Attachment allowlist (F1) gains `text/html`/`text/css`
   as *previewable* kinds — still never executed outside the sandbox.
   `srcdoc` capped (~1 MB); beyond it Preview offers the code view only.
5. The preview canvas is deliberately **outside the token system** (it is
   the user's document — a browser viewport, not app chrome); the toolbar,
   toggles and code view around it are token-only.
6. **Inline code-block preview (follow-up)**: a fenced ```html block in any
   markdown surface (chat transcript, saved-asset read view, Note-editor
   preview) renders the code AND an inline sandboxed iframe of its result by
   default, so the reader compares source and render without leaving the
   message. Same sandbox policy as above (scripts OFF with a per-block
   opt-in; never `allow-same-origin`). `web/src/CodeBlock.tsx` +
   `codeBlockPreview()` in `lib/code-assets.ts` accept an `html`/`htm` tag
   or an untagged fence whose text reads as HTML; css alone is *not*
   previewed inline (a lone stylesheet renders a blank page). The F12
   overlay keeps serving attachments and `kind=code` containers.

**Tests.** `preview.ts`: link-inlining with sibling map, external strip +
notice, data: images kept, size-cap fallback. Component: sandbox attrs
(scripts off by default; opt-in adds only `allow-scripts`; never
`allow-same-origin`), CSP meta present, toggle resets on switch.
`codeBlockPreview`: html/htm + `language-` prefix, untagged HTML, css/js
refused. `PartnerMarkdown`: an `html` fence renders both the escaped source
and a sandboxed `srcDoc` iframe; a `js` fence stays a plain `md-pre`. Route:
content endpoint access control + text-only allowlist. **Exit:** attach
`index.html` + `styles.css` → preview renders the styled page, network
blocked, scripts off; opting in runs scripts in an opaque origin with no
fetch; a model-generated HTML code asset previews identically; Files view
previews a granted `.html`.

---

## Z — Sequencing, slicing and delivery order

Hard ordering: **C1 → C2/C3 → F7/F8** (foundation + quick chat wins) →
**F1/F9/F10/F12** (chat I/O richness + code preview; all depend on C2/C3)
→ **F2/F3** (execution + governance; F3 needs F2's catalog) → **F4**
(independent) → **F11/F6** (IA; F6 leans on F10 promotion) → **F5**
(conformance sweep; triage early, fix through the milestone). Suggested
release slices:

- **Slice 1 — Chat feel**: C1, C2, C3, F7, F8, F9 (HTML rendering,
  follow-latest, clickable choices, message parts foundation).
- **Slice 2 — Chat richness**: F1 (attachments/refs), F10 (assets/copy),
  F12 (code preview), F11 (folders) — schema v12 already open.
- **Slice 3 — Capability & routing**: F2 (tools/MCP/search), F3 (persona
  policy), F4 (purpose providers).
- **Slice 4 — Product finish**: F6 (Notes IA), F5 (theme conformance).

Each slice keeps demo mode + full test suite green and ends with a
fresh-context review like M9/M10.

---

## D — Decision log (✓ = locked at review; unmarked = adopted default, open to challenge)

| # | Question | Decision |
|---|---|---|
| D1 | PDF/DOCX/XLSX content extraction in v1? | No — text + images only; office/PDF arrive as opaque refs until an extraction worker milestone |
| D2 | MCP transport scope | **stdio client shipped in M11** (default-deny, spawn/timeout/budget guardrails); `http` (SSE) transport NOT built — open, low priority; no MCP server; loopback-http denied by default |
| D3 | Global vs persona bans | Intersectional: persona can tighten, never loosen a global ban |
| D4 | Do persona tool bans block explicit user (web) calls? | No — bans govern persona-initiated calls; user actions keep broker rules |
| D5 | "Make themes work" = conformance sweep (not new features)? | Yes — triage 30 min first, then fix + checklist (F5) |
| D6 | Conversation-level theme override | **Implemented in M11** — resolution conversation → persona → global → preset; binds via `POST /v1/conversations/:id/theme` |
| D7 | Notes IA layout | **✓ Decided:** Candidate A — three-zone chat workspace (F6); B shelved unless folders mature |
| D8 | Heuristic "make this clickable" fallback for plain questions | **✓ Decided:** none — only `:::partner.choice` containers render clickable (F9) |
| D9 | Label: "Folders" vs "Projects" | **Folders** (avoids colliding with file project roots); project metadata later |
| D10 | Persona home folder | **Implemented in M11** — optional `homeFolderId` on personas; new chats auto-land there (explicit folderId wins) |
| D11 | Asset payload storage | Inside SQLite (encrypted at rest, cap sizes); no plaintext side files |
| D12 | Structured container syntax | **✓ Decided:** `:::partner.*` fences (C3) — plain-text degradable, single parser |
| D13 | HTML/CSS preview script policy | Scripts OFF by default; per-preview opt-in; never `allow-same-origin`; CSP blocks network (F12) |
| D14 | Multi-file HTML/CSS page bundles in preview | Deferred — v1 previews single-file HTML; sibling CSS attachments inline at preview time (F12) |

---

## Environment gates (unchanged from M0–M10)

Real provider keys, live OS-keychain crypto, the browser extension search
actuator, signed artifacts and org infra stay environment-gated. Every new
loop is exercised with demo fakes + fake MCP/search servers headlessly; the
extension-actuator search path is specified, wired, and marked in the manual
checklist rather than pretended green.

## Review outcomes (first review pass, locked)

- **1 — Asset taxonomy:** extended set stands (base kinds + decision, action
  item, definition, draft, data→chart, quote).
- **2 — Slicing:** §Z order (1 chat feel → 2 richness → 3 capability → 4
  finish) adopted as written.
- **3 — F9:** deterministic containers only; plain questions stay plain prose.
- **4 — F6:** Candidate A (three-zone chat workspace) adopted.
- **6 — Code preview:** new **F12**; `.html`/`.css` attachments, code assets
  and granted project files are previewable in a hardened sandbox; rides
  with F1/F10 (Slice 2).
- **Q5 — extra urgent attachment types:** none added; v1 stays text + image
  plus previewable `.html`/`.css` (D1 PDF/office extraction still deferred).

Superseded status line (written pre-execution): the locked/accepted D-rows
shipped — D6 + D10 (implemented in M11), D9 "Folders", D11 payloads in
SQLite, D12 `:::partner.*` syntax, D13 script-off preview default, D14
single-file HTML v1, D1, D3/D4, D7/D8. Still open: D2's `http` MCP
client transport (stdio shipped; http unbuilt and default-deny).

## Final report (2026-09-06)

All twelve work packages (C1–C3, F1–F12) landed during the auto-execution
pass on schema v12 (ledger above). Gates green on this checkout: typechecks
0; core/shared/e2e **683** · web **440** · extension **57**; web prod build
clean; NSIS packaged app boots env-free (demo, schema v12) and the packaged
UI was swept headlessly with zero console errors. PLAN.md §15 M11 ticked;
M11 scope folded into PLAN.md §12/§13/§16.

Remaining — manual / env-gated only, no code:

- `docs/theme-conformance.md` — headless per-surface sweep COMPLETED
  2026-09-06 (light + dark + custom-theme-active over all ten views,
  real-provider chat, chips/preview/assets/markdown exercised, zero console
  errors — evidence in that doc). Only the real-desktop visual walk of the
  packaged app remains (drag interactions, OS file-picker staging, alt-
  palette custom theme via the studio save gate, F9 choice round against a
  `:::partner.choice`-capable model).
- `docs/VERIFY-M10.md` manual walk — live-mode packaged-core boot, real
  keyring, charged-provider budget, NSIS install on a Windows desktop.
- Browser-actuator research capture end-to-end (real Chrome + installed
  native host; PLAN §16 follow-up).
