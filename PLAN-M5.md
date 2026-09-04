# M5 — Plans & notes (first-class stores)

Status: **spec** · Repo: `~/apps/partner` · Master plan: `PLAN.md` (§7, §15
M5) · Gates: same as M0–M4.

## Goal

First-class **notes** (markdown, wiki-links, tags, quick capture, search,
daily note) and **plans** (structured goals → milestones → tasks with status
and an optional owner persona), all local, editable, searchable — the stores
the partner keeps and maintains WITH the user.

## Documented deviations from PLAN §7

- Content lives in **SQLite (markdown text)** + FTS5, not separate files on
  disk (file export is deferred; a one-click `.md`/`.json` export ships here
  instead so content stays grep-able/portable). Search reuses the FTS5
  machinery from M4 via a second virtual table.
- "Plan execution with approved diffs" (a persona executing steps) is
  deferred to the playbook milestone (M9) — M5 provides the store, the
  status-change surface (user-driven, audited) and an **audit trail** on
  every change; persona-driven updates will flow through the same endpoints
  later.
- Wiki-links resolve/backlink within notes only.

## Data (core SQLite schema v6 — additive)

```sql
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
  tags TEXT, is_daily INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS note_links (from_note TEXT NOT NULL, to_note TEXT, to_title TEXT NOT NULL, PRIMARY KEY(from_note, to_title));
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  document TEXT NOT NULL, -- JSON: {milestones:[{id,title,tasks:[{id,title,status,ownerPersonaId?}]}]}
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(note_ref, plan_ref, content);
```
`SCHEMA_VERSION` 5 → **6**. FTS upserts keep in step with writes/deletes.

## Core API (authed)

Notes: `GET /v1/notes` (list w/ tags) · `POST /v1/notes` {title, content,
tags?, isDaily?} (wiki-links parsed on save; [[Title]] resolves case-
insensitively; dangling links stored w/ to_note NULL for later resolve) ·
`GET /v1/notes/:id` · `PUT /v1/notes/:id` (re-parse links) · `DELETE
/v1/notes/:id` · `POST /v1/notes/capture` {text} (quick capture → title from
first line, body rest) · `GET /v1/notes/daily` (today's daily note, creates
when missing) · `POST /v1/notes/daily/summarize` (provider summarises the
day's notes into the daily note body; demo/placeholder when no provider) ·
`GET /v1/notes/search?q=` (FTS notes) · `GET /v1/notes/:id/backlinks` ·
`GET /v1/tags` (tag → count).
Plans: `GET /v1/plans` · `POST /v1/plans` {title, description?} ·
`GET /v1/plans/:id` · `PUT /v1/plans/:id` (replace document — validate
shape) · `DELETE /v1/plans/:id` · `POST /v1/plans/:id/tasks/:taskId`
{status: open|done|blocked, note?} (validates task exists; audit +
updatedAt bump) · `POST /v1/plans/:id/export` → JSON `.partner-plan.json`
bundle (and notes export: `GET /v1/notes/export` JSON).

## Web (provisional, token-only)

New 'Notes' view with Notes | Plans segments:
- Notes: list (title, updated, tag chips, search box → results), editor
  (title + markdown textarea, live [[wiki]] suggestion chip when typing
  `[[`, tags input), quick-capture box, Daily button opens/creates today's
  note + Summarize (provider) action, delete w/ two-step, export JSON.
- Plans: list (title, description, progress n/m tasks, owner chips),
  planner (add milestone, add task w/ optional persona owner select,
  checkbox toggles status w/ note, delete milestone/task two-step), edit
  description/title inline.
- Everything content is the user's own — shown in the UI only; nothing in
  audit beyond ids/titles/lengths.

## Tests

Core: notes CRUD + tags + daily idempotent creation; wiki-link parse (self,
case-insensitive resolve, dangling, backlinks, deletes clean links); FTS
search; capture; export bundle; plans CRUD + document shape validation +
task status transitions (unknown task/id -> typed 404/400) + audit rows
(id/title-length only); summarize placeholder path; all M0–M4 suites stay
green. Web: api + pure-helper tests (link regex/tag parse/progress calc,
task flatten/validate). E2E (spawned demo core): create note w/ [[Other]]
+ create Other → backlinks show; daily exists; plan w/ 2 tasks → toggle one
→ progress updates → export JSON has it.

## Exit criteria (tick PLAN.md M5)

- [ ] Notes + plans stores, wiki-links/backlinks, tags, search, daily +
      export, task status + audit, all test-covered.
- [ ] Notes/Plans UI token-only, e2e over spawned core passes.
- [ ] Typechecks, root + web suites green, ux_audit passes.

## Out of scope

Persona-executed plan steps + diff-apply loops (M9 playbooks), file-on-disk
sync of notes, multi-note selection/bulk ops, calendar/rrule on plans,
semantic (vector) search (unchanged deferral).
