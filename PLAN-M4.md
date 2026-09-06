# M4 — Memory & the user model (Partner)

Status: **spec** · Repo: `~/apps/partner` · Master plan: `PLAN.md` (§8, §15
M4) · Gates: same as M0–M3.

## Goal

The partner's explicit, transparent memory: **Profile facts** (user-confirmed
preferences/identity that drive tailoring), **Episode summaries** (condensed
past conversations per persona), retrieval across notes/episodes/profile, and
**forgetting + export**. Tailoring = injecting confirmed Profile entries into
the persona system prompt at chat time.

## Documented deviation from PLAN §8

Semantic (vector) indexing is DEFERRED: no embeddings endpoint is pinned yet,
and sqlite-vec was not installed at M0. M4 retrieval = SQLite **FTS5**
full-text over profile/episodes (and later notes) + keyword scoring — offline
and provider-free. Vectors arrive with an embeddings-capable provider
(open question §8). FTS5 availability is asserted at db open with a clear
error if the bundled SQLite lacks it (tests will confirm).

## Data (core SQLite schema v5 — additive)

```sql
CREATE TABLE IF NOT EXISTS profile_entries (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, -- preference|identity|rule|style
  key TEXT, value TEXT NOT NULL, evidence TEXT, source TEXT NOT NULL, -- 'user'|'partner_suggestion'
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed|suggested|rejected
  persona_scope TEXT, -- null = global, else persona id
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY, conversation_id TEXT UNIQUE, persona_id TEXT,
  title TEXT, summary TEXT NOT NULL, model TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(episode_ref, profile_ref, content);
```
`SCHEMA_VERSION` 4 → **5**. After each episode/profile write the row's
searchable text is upserted into `memory_fts` (delete+insert per ref).

## Core API (authed)

- `GET /v1/memory/profile` (confirmed + suggested) · `POST
  /v1/memory/profile` (user adds/confirms an entry) · `PUT
  /v1/memory/profile/:id` (confirm/suggest/reject/update, scope) ·
  `DELETE /v1/memory/profile/:id`
- `GET /v1/memory/episodes` · `POST /v1/memory/episodes/:conversationId`
  (summarize a conversation NOW via the chat provider — demo mode writes a
  deterministic placeholder summary) · `DELETE /v1/memory/episodes/:id`
- `GET /v1/memory/search?q=` (FTS over episodes+profile, ranked, caps 50)
- `POST /v1/memory/forget` `{what:'entry'|'episode'|'all', id?, before?}`
- `GET /v1/memory/export` → JSON bundle (profile+episodes) · `POST
  /v1/memory/import` {bundle} (additive; conflicts = new ids)
- Chat-time tailoring: chat route (persist path) injects confirmed GLOBAL
  profile entries (max ~8, trimmed to 240 chars each) as a system prelude
  when a persona routes through a provider; demo path unchanged. Injected
  text is visible in the transcript? No — system prelude only, but each
  injected entry is tagged and visible via the profile UI ("in use").

## Web (provisional, token-only)

Memory view: Profile list (confirmed with evidence + "in use" tag; suggested
cards with Confirm/Edit/Reject; add-entry form; delete) · Episodes list
(conversation title, persona, summary, re-summarize) · Search box (hits →
jump placeholders) · Forget controls + Export (downloads JSON) / Import ·
Note text explaining everything is local + editable. Full states.

## Tests

Core: profile CRUD + status flow + scoping; episodes summarize (fake provider
double returns deterministic summary; demo placeholder), dedupe per
conversation; FTS search finds profile + episode text and ranks caps at 50;
forget variants + before-date; export/import round-trip (new ids); tailoring
injection appears in the provider request when persona routes (server-side
capture), absent for demo/one-shot; all M0–M3 suites stay green. Web: api +
pure-helper tests. E2E (spawned demo core): add profile entry → confirm →
search finds it → export has it → forget → gone.

## Exit criteria (tick PLAN.md M4)

- [x] Profile + episodes + FTS retrieval + forgetting + export/import +
      chat-time tailoring, all test-covered.
- [x] Web memory view token-only; e2e over the spawned core passes.
- [x] Typechecks, root + web suites green, ux_audit passes on new CSS.

## Out of scope

Vectors/semantic search (deferred), notes-store retrieval (M5), auto
suggestion of profile entries (tailoring loop — later milestone after
episodes accumulate), per-persona episode isolation beyond a stored scope id.
