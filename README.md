# Partner — a personal AI partner workspace

User-owned AI partner: your own LLM endpoints + keys (see
`~/apps/llm-self-service`), local-first core, browser web UI, browser
extension. See the plans:

- `PLAN.md` — master plan (vision, personas, memory, skills, theming,
  security, milestones).
- `PLAN-M0.md` — M0 spec: scaffold, Tauri shell + sidecar spike, security
  spine.
- `HANDOFF-WINDOWS.md` — Windows CI handoff + full project state (read this
  first if picking up from GitHub on a Windows machine).
- `PLAN-M1.md` — M1 spec: providers, model gateway, integrated key import.
- `PLAN-M11.md` — M11 spec: chat as the workspace.
- `PLAN-M12.md` — M12 spec: UI readability & polish pass.
- `PLAN-M13.md` — M13 spec: purpose providers & in-session model switch.
- `PLAN-M14.md` — M14 spec: scheduled & autonomous work.
- `PLAN-M15.md` — M15 spec: live desktop mode (exit demo).
- `PLAN-M16.md` — M16 spec: knowledge workspace — notes graph,
  brainstorming, versioning & asset depth (**planned**).
- `DESIGN.md` — default design system (tokens live in `shared/src/theme.ts`).

## Layout

```
shell/      Tauri v2 app (tray, window, autostart, updater)   [M0 · packaged M10/11]
core/       Node core = Tauri sidecar (spine → workspace)     [M0–M13]
web/        SPA (Vite + React)                                [M0–M13]
extension/  MV3 (native-messaging bridge, theme stream)      [M7–M11]
shared/     types: tokens, contracts, redaction (no runtime deps)
tests/      cross-cutting integration tests
```

## Dev

```bash
npm install          # workspaces at repo root
npm test             # vitest (TDD)
npm run typecheck    # tsc per package
npm run dev:core     # core on http://127.0.0.1:4390 (demo mode by default)
npm run dev:web      # SPA dev server on :5173 (standalone dev)
```

`dev:core` binds the desktop's own port. A packaged Partner window is now
owned by its core: it mints a per-boot nonce, hands it to the sidecar it
spawns, and requires the listener on :4390 to echo it (`GET /v1/boot`) before
the window treats it as its own. So a leftover dev core no longer hijacks the
app invisibly — the desktop reports the conflict and refuses to use it. Stop
the dev core (Ctrl-C) before launching the desktop app; if the desktop shows
“already serving …”, something else still holds :4390.

## Status (2026-09-12)

M0–M19 implemented and verified (PLAN.md §15): schema v16; current root
suite **893 passed** (5 env-gated skips) · web **541 passed** · typechecks 0 ·
web build green. Latest release: **v0.1.7** (persona-scoped memory +
automatic remember; note projects; chat multi-question forms).

**M15 — Live desktop mode (exit demo).** The packaged shell now boots the
core LIVE by default: persistent whole-file-encrypted DB + OS-keychain key
and skills under the per-user app-local data dir (`%LOCALAPPDATA%\dev.ne1.partner`
on Windows), a per-boot device secret enables the header-guarded
`GET /v1/pair/device` code channel, and the **tray** (Show pairing code… /
Open Partner / Quit) surfaces the live pairing code for the web PairGate
(now health-aware: live copy, no demo button). The core exits itself when
its shell dies by any path (stdin parent-watch). `PARTNER_DEMO_MODE=1`
keeps the historical in-memory demo boot. Remaining items are manual /
env-gated: the packaged live-boot walk on this desktop is executed in
PLAN-M15; per-surface theme walkthrough (`docs/theme-conformance.md`); the
`docs/VERIFY-M10.md` live-mode walk details; browser-actuator research
capture; S0 companion API in `~/apps/llm-self-service`. Read
`HANDOFF-WINDOWS.md` first when picking up from a Windows machine.

### M19 — persona-scoped memory & automatic remember (2026-09-12, implemented)

Personas gain **private memory**: a per-persona tick
(`memory.personaMemory = on|off`, off by default) makes a persona keep its
OWN facts about the user and recall them **only in chats with it** — the
interactive `/v1/chat` route. A persona-scoped entry is never injected into a
different persona's prelude, and the headless playbook/schedule/brainstorm
loops never see it. Global confirmed facts still tailor every persona (M4).

**Automatic remember.** When private memory is on, the core asks the
persona's cheap-task-class model (out of band, AFTER the client's response has
ended, so the turn never waits) whether the finished exchange holds anything
durable about the user. Findings are filed as `partner_suggestion` /
`suggested` entries scoped to that persona for the user to confirm, edit or
reject in the Memory view — alongside the existing explicit add-a-fact path.
The extractor prompt is fixed and never user-derived; parsing is defensive
(fence/JSON guard, kind whitelist, caps, obvious-secret filter); dedupe covers
global + same-scope entries, rejected included, so a rejected fact is never
re-suggested; demo/no-provider turns skip; audit rows carry ids/counts/model
only. No schema change (M4's `profile_entries.persona_scope`/`source` and the
`personas.memory_flags` JSON were enough). Web: a Memory fieldset in the
persona editor, a persona-aware “in use” marker, and an “Auto-detected”
provenance chip. Suites after the pass: core **893 passed** (5 env-gated
skips) · web **541 passed** · typechecks 0 · web build green · `ux_audit`
green. Spec: `PLAN-M19.md`.

### M18 — chat multi-question forms (2026-09-11, implemented)

When a persona has **more than one open-ended question**, it now emits a
`:::partner.form` container instead of a prose list. Each question renders in
its own textarea and the user submits **once**; the answers become a single
labelled user turn through the normal chat path (nothing client-only, the
persisted text is unchanged). The parser shares the `:::partner.*` grammar
(`shared/src/structured.ts`): one question per bullet line, a title from the
`title=` attr / fence tail / lead line, closed-container-only materialization
so streaming stays safe, and malformed or unclosed blocks degrade to plain
prose. Pending drafts survive switching conversations (client-side
per-conversation UI memory). The `forms` guidance ships in the default
structured feature set alongside choices and assets; styles are token-only.

### M17 — note projects (2026-09-11, implemented)

Notes gain an organizational layer on the existing Projects/Folders tree
(shared with chats; many-to-many, no membership = Inbox). A single membership
write path (`setFolders`) backs both create-time `folderIds` and re-filing;
`list()`/`graph()` scope by folder subtree or Inbox; a scoped graph returns
one-hop, both-direction **ghost** nodes for out-of-scope references (marked
external, never persisted). Deleting a folder clears membership (notes
survive); deleting a note cascades its membership rows. New routes:
`GET /v1/notes?folderId=<id|none>`, `GET /v1/notes/graph?folderId=…`,
`PUT /v1/notes/:id/folders` (501 when folders are unwired). The Notes list
and graph get project scope selectors, project chips, an editor Projects
multi-select, dimmed ghost nodes + an "other projects" toggle, drag-to-ghost
and a "Link to note…" picker. Schema v15 → v16 (`note_folders`); audit stays
membership counts only.

### M16 — knowledge workspace (2026-09-09, implemented)

`PLAN-M16.md` ships six features (implemented; packaged walk env-gated): a
React Flow notes relationship graph (edges follow who references whom; mutual
refs render bidirectional; drag positions persist), **Brainstorm from notes &
captures**
activating a seed-on-demand **Brainstorming** persona (`p-brainstorm`),
**versioning for notes & captures** (history, diff, undoable restore),
**Discuss in Assets** (branch/thread of the asset's own discussion, or fork
into a new one — schema v14 adds `conversations.parent_id` +
`source_asset_id`), **Assets → Export working in the packaged desktop app**
(native save-dialog path in the Tauri shell; blob fallback in browsers), and
**CSV assets rendered as tables** (pure shared parser). Schema v13 → v14.
Root suites: shared 51 · core 837 (2 pre-existing env cipher failures) ·
web 486 · typechecks 0 · web build green · `ux_audit` green.

**M16 follow-up — linked, reopenable brainstorms (schema v14 → v15).** A
brainstorm conversation is linked back to its source note/capture nodes
(`brainstorm_sessions` keyed by the deterministic source set + a
`brainstorm_sources` join); the graph badges those nodes and lists their
sessions. Clicking **Brainstorm (N)** over a set that already has an ACTIVE
session reopens it instead of starting a duplicate; once a path is
**concluded** a fresh brainstorm starts, and the concluded one stays listed in
the graph with **Reopen** to continue it. The open brainstorm chat also
carries a `Brainstorm active|concluded` chip with **Conclude**/**Reopen** in
its action bar. Owner actions, ids/counts only.

### M14 — scheduled & autonomous work (2026-09-06, core engine green)

Personas carry **schedule definitions** inside their independence bundle
(`independence.schedules[]` — daily/weekly wall-clock or a rolling interval,
prompt, optional IANA tz, per-run round bound, save-note flag). The core's
scheduler wakes on a heartbeat (`SCHEDULER_TICK_MS`, default 30 s;
`SCHEDULER_TZ` overrides the machine-local default; UTC in demo) and fires
due schedules for **unpaused auto/autonomous personas only**. Each fire is a
**headless bounded persona tool-loop run** on the same engine playbooks use:
the brief lands as a user turn in the schedule's own conversation thread
(auto-created, persona-bound, home-folder aware, reused across runs); tool
use keeps every existing gate (independence × risk matrix, persona bans,
default-deny broker grants); a queued tool pauses the run (row status
`queued` + `pendingId`); deciding that approval from the Files queue or the
in-chat card **auto-resumes the run in-process** — no UI click needed to
continue; the final answer appends to the thread on done (+ optional
save-note); every attempt writes a `scheduled_runs` row and audit
`schedule.run`/`schedule.resume`/`schedule.skip` rows (ids/counts only —
prompts and transcript text never cross audit). Pausing the persona is an
instant kill switch for its schedules (new runs AND resume). Missed windows
fire at most one catch-up run; windows never storm. Schedules are edited
through the existing persona surface; new routes: `POST
/v1/personas/:id/schedules/:scheduleId/run-now` (headless), `GET
/v1/schedules/runs` + `/v1/schedules/runs/:runId`. Schema v13 (additive:
`personas.schedules`, `scheduled_runs`). Spec: `PLAN-M14.md`. Web slice
(schedule editor + runs panel) is done: web/src/SchedulesSection.tsx renders in the persona
editor — list with enabled toggles, add/edit/remove, daily/weekly/interval fields,
timezone + round-cap, Run now for persisted schedules with inline errors, and a
Recent runs mini-panel (status dots, model, queued-approval hint, auto-refresh
after run-now). Token-only, ux_audit green, web build + typechecks 0.
live manual walk (env-gated) only; the decide-hook is now proven end-to-end
(core/test/http/schedulesApproval.test.ts — real broker loop, approve + deny, headless
auto-resume, transcript + audit assertions).
Live walk executed 2026-09-07 against https://api.ne1.dev/v1 (deepseek-v4-flash) +
Brave search: purpose provider healthy (1063 ms, 4 models), real Brave results returned,
scheduled run paused on a queued approval and auto-resumed headlessly to done, final
brief persisted in the conversation thread and as a note, audit rows content-free,
core log clean of key material. Walk bug found + fixed: resume-completed runs now
save-note (the resume path carried schedule=null) — covered by a manager unit test.
Remaining: packaged-app walk (shell/NSIS) only.

### M13 — purpose providers & in-session model switch (2026-09-06)

Providers can be set up **by purpose** (General · Cheap · Deep · Coding ·
Vision · Research) from one endpoint + key: discover the endpoint's models,
**assign which model(s) each purpose uses** (first = default), optionally cap
spend per profile, then
`POST /v1/providers/purposes` creates one profile per purpose with those
pins (no pins = heuristic: vision keeps image-capable models, others the
full list); the single key lands in each profile's keychain item. The
standalone single-provider add form is gone — the purpose card is the only
add surface (the single-provider create route stays for API clients and the
llm-self-service import). Chat
has a **per-message model picker** (Auto = persona routing, or any
provider's models grouped by purpose, vision-marked), backed by a per-turn
`providerId` pin that wins over persona pinning and purpose routing.
Attached photos now reach a vision model: an implicit turn whose model
can't see images is rerouted to the best vision-capable model
(`chat.vision_reroute` audit), an explicit pick is never overridden, and
vision capability lives in one shared module (`shared/src/vision.ts`)
used by core and web alike. Spec: `PLAN-M13.md`.
Suites after the pass: core 681 (5 env-gated skips) · web 470 · typechecks
0 · ux_audit green on the new picker + bundle card.

### M12 capability pass — personas can actually use web search (2026-09-06)

Chat personas now know what they may do: every persona turn declares its
independence level, and when the internet-search backend is enabled
(Providers → Internet search) the persona is told the tool exists with the
exact directive grammar to call it:

- **auto / autonomous** — run `search` directly (the enabled backend is the
  consent); results land as a system note for the next turn.
- **suggest** — every search request queues an approval in the Files queue
  (tagged with the persona, showing the truncated query); **Approve** runs
  the search once and posts the result note into the conversation, **Deny**
  posts a denial note. No grant is ever created (external tools have no
  project root).
- **assist** — chat/proposals only; never offered the tool and never asked
  to approve (approvals start at Suggest).

### M12.6 — approvals live where the ask happened + the chat continues (2026-09-06)

Suggest-level asks now surface **on the chat screen itself**: pending rows
carry their `conversationId`, and while the active conversation has one, an
"Approval needed" card (Approve / Deny) renders above the composer with the
same row detail as the Files queue (tool, risk, truncated query, persona).

- **Approve / Deny in the card** decides the row exactly like the Files
  queue (search runs once / denial note) **and then continues the turn**: a
  new `/v1/chat` mode (`continueTurn: true`, conversation only, no user
  message) streams the persona's next round against the outcome note the
  decision just posted — no phantom user turns, no navigating away.
- The Files queue stays the global queue (badge count unchanged); decisions
  made there post their notes and the chat transcript refreshes when you
  return to the Chat view.
- Guarded: `continueTurn` requires a conversation, refuses request messages
  and `noPersist`, and every existing turn path is byte-identical unless the
  flag is sent. Audit stays query-free.

Suites after the pass: core 673 passed (5 env-gated skips) · web 461
passed — typechecks 0, `ux_audit` green on the new chat-approval card.

Persona tool bans are respected everywhere; disabled/assist personas are
never even told the tool exists (default-deny). Audit rows stay query-free
(query length + hit count only). Suites after the pass: core 657 passed
(5 env-gated skips) · web 460 passed.

Dev note: `npm run dev:core` runs demo mode by default — an **in-memory
DB + fake keychain**, so personas/config/search keys reset on every restart.
Use `DEMO_MODE=0` (with a `DB_PATH`) for a persistent setup.
