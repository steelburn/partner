# M14 — Scheduled & autonomous work (persona schedules)

Spec: PLAN.md §5.1 `autonomous`: *"Self-directed within the full configured
envelope, incl. scheduled work; always logs, always within budget caps;
instant pause."* The `persona.independence.schedule` slot in the sample
persona JSON (§5) is the design anchor: schedules are part of the persona's
declarative independence bundle.

## What this milestone ships

A persona may carry **schedule definitions** (when + what to work). The core
runs a **scheduler** that fires due schedules and drives each as an
**autonomous persona tool-loop run** — the same bounded engine playbooks use
(`core/src/playbooks/loop.ts`) — headlessly: no SSE consumer, no user at the
keyboard. Every run lands in a conversation (so results and approvals live in
the workspace), writes a `scheduled_runs` row, and is audited. When a run
needs a human (missing grant / high risk), it **queues an approval and
pauses**; deciding that approval from the Files queue or the in-chat card
**auto-resumes the run** in-process. Pausing the persona is an instant kill
switch for its schedules; the global pause header applies too.

## Rules (hard)

1. **Schedules belong to personas** (`independence.schedules[]`), round-trip
   in the persona JSON bundle (create/update/list/get/export), validated on
   every write. Cap: ≤ 20 per persona.
2. **A schedule fires only when**: the persona exists, is **not paused**,
   its independence level is `auto` or `autonomous` (the run envelope —
   `suggest`/`assist` schedules are skipped with an audit row, never
   silently executed), the schedule entry is `enabled`, and a provider can be
   resolved (`no_provider` = error row, mirroring playbooks).
3. **Runs are tool-loop runs with all existing gates**: independence level ×
   tool risk matrix, persona policy bans, broker grants (default-deny). A
   queued tool pauses the run (row status `queued` + `pendingId`); the
   persona's own envelope never grants itself anything — **autonomy never
   exceeds user grants** (§5.1).
4. **No catch-up storms**: a schedule fires at most once per window; the
   anchor for "next fire" is the run history row for that (persona, schedule).
5. **Paused personas refuse new runs AND refuse resume** (a paused persona
   cannot be woken by its own queued approvals).
6. **Content discipline**: run rows and audit rows carry ids, statuses,
   counts, timestamps, model — never schedule prompts, tool params, or
   transcript content. Conversation bodies are owner data served through the
   existing surfaces only.

## Wire model (`shared/src/schedules.ts`)

```ts
type ScheduleWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;      // 0 = Monday … 6 = Sunday
type ScheduleWhen =
  | { kind: 'daily';  hour: number; minute: number }    // wall-clock in tz
  | { kind: 'weekly'; weekday: ScheduleWeekday; hour: number; minute: number }
  | { kind: 'interval'; everyMinutes: number };         // 5 … 10080

interface PersonaSchedule {
  id: string;                 // stable, per-persona unique
  label: string;              // 1…80 chars (thread title, audit label)
  when: ScheduleWhen;
  prompt: string;             // the brief/task text (1…4000)
  tz?: string;                // IANA; default = core timezone (UTC in demo)
  enabled?: boolean;          // default true
  conversationId?: string;    // existing conversation target (optional)
  saveNote?: boolean;         // persist final answer as a note (title = label)
  maxRounds?: number;         // tool-loop bound 1…8 (default engine cap)
}
```

`PersonaIndependence` gains `schedules?: PersonaSchedule[]`.

## Engine semantics (`core/src/schedules/engine.ts`, pure)

- `nextFire(when, tz, afterEpochMs)`: the first occurrence strictly after
  `after`, computed on **civil wall-clock fields in `tz`** (DST-safe: fields
  are re-epoch'd, never shifted by adding 24h to an instant).
  - `daily`/`weekly`: next matching civil day at `hour:minute`;
  - `interval`: `after + everyMinutes`.
- `dueRuns(personas, tz, now)`: enabled schedules whose `nextFire` over the
  last-run anchor is `<= now`. Anchor = latest run row (started or finished)
  for that (personaId, scheduleId); a schedule that never ran anchors on the
  persona's `createdAt`, so a fresh "daily brief" fires on the first tick and
  then settles into its window.

## Scheduler (`core/src/schedules/manager.ts` + `driver`)

- `ScheduleRunStore` — new `scheduled_runs` table (schema v13, additive):
  `id, persona_id, schedule_id, label, status, conversation_id, pending_id,
  tool_calls, rounds, model, started_at, finished_at, error`.
  status: `running | done | queued | error | loop_exhausted`.
- `ScheduleManager`:
  - `tick(now?)`: resolve due schedules → for each, `startRun`.
  - `startRun({personaId, scheduleId}, reason)` — guards (level/pause/
    enabled/provider), ensures a target conversation (schedule's own, else the
    latest run's conversation if still alive, else auto-create bound to the
    persona in its home folder), persists the prompt as a user turn, composes
    messages (persona voice + directive grammar + prompt), and drives
    `ToolLoop.run` headless. Terminal bookkeeping mirrors the playbook
    manager: run row, assistant transcript on `done`, optional note, audit
    `schedule.run` (ids/counts only).
  - `tryResumeAfterDecision(pendingId)` — the decide hook: finds the run row
    `status='queued' AND pending_id=…`, re-checks pause/level, drives
    `ToolLoop.resume` headless, audits `schedule.resume`.
  - `listRuns` / `getRun` for the UI; persona/paused skip rows are NOT
    written (audit `schedule.skip` with coded reason only).
- Driver: `startServer` runs a `setInterval(tick)` (default 30 s, config
  `schedulerTickMs`), cleared on shutdown; `CoreBundle` exposes
  `schedules.start()/stop()/tick()` for tests and the CLI.

## API

- Persona routes unchanged — schedules ride `POST/PATCH /v1/personas`.
- `POST /v1/personas/:id/schedules/:scheduleId/run-now` → headless run
  (manual "run now"), 202 `{runId}`; 404 unknown persona/schedule; 423 paused;
  400 level below auto; 501 no provider.
- `GET /v1/schedules/runs?personaId=&status=&limit=` → run history (newest
  first, cap 100).
- `GET /v1/schedules/runs/:runId` → row detail.
- Decide route (`POST /v1/tools/pending/:id`) tail: after a persona-requested
  row is decided (broker OR external search), call
  `schedules.tryResumeAfterDecision(pendingId)` (no-op false when the row is
  not a scheduled run — every existing path stays byte-identical).

## Web UI (token-only, DESIGN.md)

- Persona Manager → independence section: **Schedules** list per persona
  (label, when summary, next fire, enabled toggle, edit/delete, **Run now**);
  schedule editor card (kind daily/weekly/interval, time/weekday, interval
  minutes, prompt, save-note toggle, maxRounds).
- **Runs** panel (per persona or global Activity): recent runs with status
  chips, time, linked conversation; queued rows still surface in the existing
  Files/in-chat approval queue.

## Security & privacy

No new privilege: schedules reuse broker grants, the gate matrix, persona
policy bans, the tool loop's round budget, provider routing/budget caps, and
the append-only audit. Schedules are owner data (persona JSON is already
owner-only); run/audit rows stay content-free.

## Slices + tests (TDD, red → green)

- **S1** shared types + pure validation (`shared/src/schedules.ts`) —
  `shared/test`/`core/test` unit tests (shape, caps, weekday bounds, tz
  reject, defaults).
- **S2** persona round-trip: `personas.schedules` JSON column (guarded,
  schema v13), row/store mapping, manager normalize (merge-on-patch like
  autoScopes) — `core/test/personas` unit tests + db-migrate coverage.
- **S3** engine `nextFire`/due math with fake clocks, tz `UTC` + a DST tz —
  pure unit tests.
- **S4** `scheduled_runs` store + manager with an injected fake loop
  (duck-typed to `ToolLoop`) — sequencing, guards (level/pause), finish/
  transcript/note/audit, queued→decide→auto-resume, no double-fire.
- **S5** wiring: `createCore` builds manager + driver; `CoreBundle` exposes
  tick; `startServer` interval lifecycle; HTTP routes; decide-hook tail —
  `core/test/http` route tests + `tests/` demo e2e (spawn real core, schedule
  on the default/demo persona via persona PATCH, run-now, poll runs, read the
  conversation transcript).
- **S6** web UI slice (Persona Manager schedules + runs) — token-only, state
  contract, `ux_audit` green.

## Exit criteria

core suite grows green (personas/schedules/engine/stores/http + e2e demo
walk), web suite green, typechecks 0, `ux_audit` green on the new schedule
editor + runs panel; manual live-mode walk documented in README; schema v13
migration verified by db-migrate tests.
