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
- `PLAN-M12.md` — M12 spec: UI readability & polish pass (current).
- `DESIGN.md` — default design system (tokens live in `shared/src/theme.ts`).

## Layout

```
shell/      Tauri v2 app (tray, window, autostart, updater)   [M0 · packaged M10/11]
core/       Node core = Tauri sidecar (spine → workspace)     [M0–M11]
web/        SPA (Vite + React)                                [M0–M11]
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

## Status (2026-09-06)

M0–M11 complete (PLAN.md §15): suites core 683 · web 440 · extension 57,
typechecks 0. The packaged app is verified two ways — the container
toolchain (`shell/docker/gate`) and a green NSIS installer on the
self-hosted Windows runner that boots env-free (demo, schema v12); the
packaged UI was swept headlessly with zero console errors. Remaining items
are manual / env-gated: the per-surface light/dark/custom theme walkthrough
(`docs/theme-conformance.md`), the `docs/VERIFY-M10.md` live-mode walk,
browser-actuator research capture (real Chrome + installed native host), and
the S0 companion API in `~/apps/llm-self-service`. Read
`HANDOFF-WINDOWS.md` first when picking up from a Windows machine.

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
