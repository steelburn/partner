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
- `PLAN-M14.md` — M14 spec: scheduled & autonomous work (current).
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

## Status (2026-09-07)

M0–M14 implemented and verified (PLAN.md §15): schema v13; current root
suite **773 passed · 5 env-gated skips** · typechecks 0 · web build green.
The packaged app is verified two ways — the container toolchain
(`shell/docker/gate`) and a green NSIS installer on the self-hosted Windows
runner (boot verified env-free through schema v12 under M11). Remaining
items are manual / env-gated: the M14 packaged-app boot walk at schema v13,
the per-surface light/dark/custom theme walkthrough
(`docs/theme-conformance.md`), the `docs/VERIFY-M10.md` live-mode walk,
browser-actuator research capture (real Chrome + installed native host), and
the S0 companion API in `~/apps/llm-self-service`. Read
`HANDOFF-WINDOWS.md` first when picking up from a Windows machine.

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
