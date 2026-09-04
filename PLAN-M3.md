# M3 — Persona engine v1, conversations & routing (Partner)

Status: **spec** · Repo: `~/apps/partner` · Master plan: `PLAN.md` (§5, §15
M3) · Style: same gates as M0–M2.

## Goal

The product's identity layer: **personas** (declarative character bundles),
**conversations** (persisted multi-turn chat), and **model routing per
persona** with the user-configurable **independence level** + pause/kill.
Chat moves from the M0/M1 stateless demo strip to real conversations under an
active persona.

## Scope (explicit)

IN: persona CRUD + defaults + starter personas; conversation + message
persistence (SQLite); per-persona model routing (task-class resolver +
fallback) wired into `/v1/chat`; independence levels stored + surfaced with a
pause/kill switch; web: conversation sidebar, persona picker/manager
(provisional persona studio), typing + streaming states, "persona paused"
banner.

DEFERRED (documented, later milestones): personas *driving* the tool broker
(persona→queue tool calls; M9 playbooks), memory/profile (M4), scheduled
autonomy (M5+), skills as persona skills (M8). M3 only enforces that a paused
persona refuses chat/tools and that persona autonomy flags exist and round-trip.

## Persona model (shared wire types — declarative, per PLAN §5)

```ts
interface Persona {
  id, name, tagline, avatar?,
  character: { voice: string; language: string; systemPrompt: string; temperature: number },
  model: { taskClasses: { chat?: string; deep?: string; coding?: string; vision?: string; cheap?: string };
           fallback?: string; providerId?: string },
  independence: { level: 'assist'|'suggest'|'auto'|'autonomous';
                  requireHumanFor?: 'high'[],   // default ['high']
                  autoScopes?: string[] },        // M3: stored, enforced later
  memory: { userProfile: 'read'|'none'; episodes: 'read+write'|'none' },  // flags only (M4)
  colorTheme?: string, isDefault: boolean, paused: boolean, createdAt, updatedAt
}
```
Defaults: `assist` (chat-only), `requireHumanFor: ['high']`, `paused:false`.
Starter personas seeded on first run: Researcher (suggest), Builder (auto),
Studio (assist), Scribe (assist), Presenter (assist), Analyst (assist),
Note-taker (assist), Default partner (assist, default). A paused persona
returns 423 on chat.

## Data (core SQLite schema v4 — additive, idempotent)

```sql
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tagline TEXT, avatar TEXT,
  voice TEXT, language TEXT, system_prompt TEXT, temperature REAL,
  task_classes TEXT, fallback_model TEXT, provider_id TEXT,
  independence_level TEXT NOT NULL DEFAULT 'assist',
  require_human TEXT, memory_flags TEXT, is_default INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, persona_id TEXT, title TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
  persona_id TEXT, content TEXT NOT NULL, model TEXT, latency_ms INTEGER,
  created_at INTEGER NOT NULL);
```
`SCHEMA_VERSION` 3 → **4**.

## Core API additions (authed)

- `GET /v1/personas` · `POST /v1/personas` · `PUT /v1/personas/:id` ·
  `DELETE /v1/personas/:id` (last default can't be deleted) ·
  `POST /v1/personas/:id/pause` / `POST /v1/personas/:id/resume` (pause =
  kill switch: chat + any persona tool intent refused 423)
- `GET /v1/conversations` (recent, titles + updatedAt + message count) ·
  `POST /v1/conversations {personaId?, title?}` · `GET /v1/conversations/:id`
  (messages ascending) · `DELETE /v1/conversations/:id`
- `POST /v1/chat` extended: `{conversationId?, personaId?, model?, messages}`
  — persists the user turn + streamed assistant turn (content, model,
  latency) into the conversation (auto-creates one when conversationId
  absent); persona selection resolves routing; paused persona → 423; unknown
  persona → 404. Demo fallback still works when no persona/provider is
  configured (byte-compatible with M0/M1 tests). SSE events unchanged plus a
  trailing `done` carrying `{messageId, conversationId}`.
- Resolver: persona.model.taskClasses[taskClass] → provider (persona
  providerId or first enabled) model; fallback chain per PLAN §4.2; provider
  default when no persona mapping. Chat task class defaults to `chat`.

## Web

- Conversation list in a sidebar (or top strip): New chat, titles (first
  user message truncated), delete; selecting loads history from the core.
- Persona picker (header select or switcher modal): shows name/tagline/level
  badge/paused state; picking a persona switches the active persona for new
  messages in the current conversation.
- Persona manager view (provisional): list + create (name, voice, system
  prompt, temperature, task-class model overrides, independence level select
  w/ explainer per level, default toggle) + edit/delete + **Pause/Resume**
  per row (paused rows show banner everywhere).
- ChatStrip upgrade: streams into the current conversation, keeps messages in
  state after reload, shows persona name + model in the meta line, a paused
  persona banner, and a "persona is typing" indicator already exists.
- Token-only styling; states on every new control; ux_audit must pass.

## Tests

Core: persona store CRUD + seed-on-first-run idempotent; pause→chat 423 /
resume restores; default-persona invariants; conversations create/append/
list/delete + message ordering; routing resolver (taskClasses, provider
fallback, unknown providerId → first enabled, no providers → demo);
chat persistence (turn stored; done carries ids); all M0–M2 suites stay
green. Web: lib api tests for the new endpoints (mocked fetch, 204/200/423
paths), persona helper pure functions (level labels/explainers), conversation
ordering helpers. E2E (spawned demo core): create persona → new conversation
→ chat under it persists (list shows the conversation, messages retrievable)
→ pause persona → chat 423 → resume works.

## Exit criteria (tick PLAN.md M3)

- [ ] Personas + conversations persisted; routing per persona with fallback;
      pause/kill + default invariants, all test-covered.
- [ ] Web: conversation history + persona picker/manager + pause UI, token-only.
- [ ] E2E persists a real conversation under a persona over the spawned core.
- [ ] Typechecks, root + web suites green, ux_audit passes on new CSS.
- [ ] Packaged-app (Rust) gate still open (unchanged).

## Out of scope (this milestone)

Persona-driven tool execution (M9 playbooks; broker + queue already ready —
`requestedBy: 'persona'` will flow then), memory/profile (M4), scheduled
autonomy (M5+), skills-as-persona-skills (M8), multi-model A/B chat (later).
