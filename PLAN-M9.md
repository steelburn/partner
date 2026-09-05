# M9 — Capability playbooks (persona tool loop, deploy targets, text playbooks)

Status: **spec** · Repo: `~/apps/partner` · Master plan: `PLAN.md` (§6, §15
M9) + `PLAN-M1.md` §6.1 · Gates: same as M0–M8.

## Goal

Turn personas into doers: a persona can **use broker tools** (the loop M3
deferred), orchestrated through **playbooks** (research, vibe-code, docgen,
email, presentation, analysis, design-prototype, ship). Two headline pieces:

1. **Persona tool loop** — a provider reply may contain a `[[partner:tool …]]`
   directive; the core parses it, authorizes via the personа's independence
   level + the broker (missing grant → approval queue tagged `persona`), feeds
   the result back, and loops (≤4 rounds) to a final answer. Everything is
   audited; assist-level personas never execute tools.
2. **Playbooks + ship** — a registry of named flows (declarative: allowed
   tools, input schema, persona defaults) with a generic run endpoint, plus
   **deploy-target profiles** (CRUD + validation) and a **package** step that
   produces a deployable bundle locally (real push/deploy stays
   environment-gated; documented).

## Documented environment gates (unchanged)

Research search via the browser extension, email/presentation *sending*, and
live `ship` deploys to the org infrastructure remain gated (Chrome +
infra creds) — the loops that feed them (capture→analyze, draft, bundle,
validate) ship here and are e2e-tested at the protocol level.

## Persona tool directive protocol

Provider reply text may contain, on its own line:
`[[partner:tool <toolId> <json-args>]]` (json-args single-line). The core:

1. extracts the LAST directive (allow chained by looping),
2. checks the persona independence level: `assist` → refused in-reply;
   `suggest+` → tool must be within the persona's playbook/auto scopes
   (level enforcement table below),
3. calls broker.exec with `requestedBy:'persona'`, personaId on the audit
   row; missing grant → pending approval row tagged `requestedBy:'persona'`
   (existing queue; human approves; the approval executes once),
4. appends the tool result (or code) as a `system` message and calls the
   provider again (bounded ≤4 loops, total token/step caps), ending with the
   final reply; every step streams as its own event with a `loop` marker.

Level enforcement (over broker risk):
| level | low tools | medium | high | asks |
|---|---|---|---|---|
| assist | no tools at all | no | no | never proposes |
| suggest | yes under grant | propose (queue) | queue | auto-proposes medium/high to the queue |
| auto | yes | yes under grant | queue | auto-asks only high |
| autonomous | yes | yes | yes under grant | nothing (still logs every call) |

## Data (core SQLite schema v10)

```sql
CREATE TABLE IF NOT EXISTS deploy_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'docker-ssh',
  host TEXT NOT NULL, username TEXT, port INTEGER DEFAULT 22,
  remote_base_dir TEXT, env_extra TEXT,   -- JSON map (no secrets values allowed)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS playbook_runs (
  id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, persona_id TEXT,
  conversation_id TEXT, status TEXT NOT NULL, -- running|done|error|loop_exhausted
  tool_calls INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL,
  finished_at INTEGER, error TEXT);
```
`SCHEMA_VERSION` 9 → **10**.

## Core API (authed)

- `GET /v1/playbooks` (registry metadata: id, name, area, allowed tools,
  persona defaults, input schema summary)
- `POST /v1/playbooks/:id/run {personaId?, conversationId?, inputs, note?}`
  → starts/streams a playbook run: SSE like chat (deltas, `loop` markers,
  `tool` events with queue hints, final `done_meta`) and persists into the
  conversation + a playbook_runs row. Text playbooks: research (summarize
  inputs/sources → structured note), docgen, email draft, presentation
  outline, analysis (CSV pasted or note), design-prototype (token spec →
  HTML in a note/proposal). Vibe-code playbook = persona tool loop over a
  project root (propose diffs via broker; human applies — M2 flow).
- Deploy: `GET/POST /v1/deploy-profiles`, `DELETE /v1/deploy-profiles/:id`
  (validate: kind docker-ssh, host non-empty, secret-free env values) ·
  `POST /v1/deploy-profiles/:id/package {projectDir, outDir}` → builds the
  deployable bundle (container-ready: Dockerfile + core bundle + web dist +
  README) into a folder under a granted project root; returns paths.
- Audit: playbook.run/package/deploy-profile CRUD with ids/names/counts.

## Web (Playbooks view — tenth tab)

- Playbooks list (area chips, description, persona default, inputs hint) →
  Run panel: pick persona, optional conversation target, inputs JSON/form →
  streamed transcript with loop/tool markers and a "waiting on your approval
  in the queue" hint when a persona tool needs it; Save-as-note shortcut.
- Deploy Profiles list + add (name/host/user/port/base dir) + package
  action (choose project root via roots picker, out dir) → shows built paths.
- Approval queue now tags persona-requested rows ("Builder · files.read").

## Tests

Core: directive parser (single/multi-line, JSON errors, only-last, cap);
level gate (assist never executes; suggest queues medium/high; auto runs
low/medium under grants; autonomous runs high under grant); loop engine
(fake provider that emits a directive then a final answer; ≤4 rounds;
loop_exhausted; tool result fed as system; audit rows per tool call with
personaId, no content); text playbooks against demo provider (deterministic
outputs; save-to-note writes a note via the notes manager); vibe-code path
uses the real broker (proposal flows unchanged); deploy profiles CRUD +
secret-free validation + package step writes a Dockerfile+bundle into a
temp project root; routes 401/501; M0–M8 suites stay green. Web: api +
helpers (input schema validation, run transcript marker rendering), e2e
(spawned demo core): run a text playbook end-to-end → conversation persists;
create a deploy profile → package under a temp root → files exist.

## Exit criteria (tick PLAN.md M9)

- [ ] Persona tool loop (levels + queue tagging + bounded looping) and text
      playbooks + vibe-code via broker, test-covered; deploy profiles CRUD +
      package; playbook_runs audit.
- [ ] Playbooks view + queue persona tags, token-only.
- [ ] Typechecks, root + web suites green; env gates documented (search/send/
      live ship).

## Out of scope

Live deploys to the org infra (profile + package ship; execution needs
credentials/infra — next), browser-driven research capture wiring (needs
Chrome host), autonomous scheduled playbooks (M5+ autonomy), skill-provided
playbooks (M8 registry extension later).
