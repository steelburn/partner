# M8 — Skills runtime (local catalog, sandboxed runner, permissions)

Status: **spec** · Repo: `~/apps/partner` · Master plan: `PLAN.md` (§9, §15
M8) · Gates: same as M0–M7.

## Goal

Partner skills: installable capability bundles a persona/user can invoke.
Each skill declares a manifest; install is **default-deny** (permission
summary shown); every skill runs in its own **worker process** whose tool
requests go through the existing **broker** (risk tiers, grants, audit) with
no implicit network; invocation gets a budget + kill switch; one-click
uninstall wipes its store. Installed skills are **user-scoped** (per-core
profile).

## Documented deviations from PLAN §9

- Remote **gallery + package signing** deferred: v1 ships a **local catalog**
  (checked-in sample skills) + the registry protocol shape; the integrity
  check is a SHA-256 recorded at install from the local catalog (nothing
  remote). Update/consent flow works but only for local catalog editions.
- Worker sandbox = **child process + IPC** (no network by default, broker-
  mediated tools, budgets, kill); OS-level jail (seccomp/containers) later.

## Skill model (shared contracts)

Manifest: {id, name, description, author, version, entrypoint (single .mjs),
permissions: {tools: ToolId[] (all files.* etc.), roots: 'declared'|'none',
network: boolean (default false), risk: 'low'|'medium'|'high' (whole-skill
ceiling)}, budget: {timeMs, maxTokens?}}. Skill code runs in a worker that
may ONLY talk to the core over the skill IPC protocol: {op:'log'} and
{op:'tools.exec', toolId, params, nonce} (plus a 'ready' handshake). The
broker executes tool calls with `source:'skill'` grants — resolution:
user grant > skill-declared tool + root + risk ceiling > deny. Nothing the
skill does bypasses the broker; network-capable tools simply do not exist in
M8's tool set.

## Data (core SQLite schema v9)

```sql
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, author TEXT,
  version TEXT NOT NULL, entrypoint TEXT NOT NULL,  -- code path under the
                                                    -- per-core skill store
  manifest_json TEXT NOT NULL, sha256 TEXT NOT NULL, source TEXT NOT NULL
                                                    -- 'local'
  DEFAULT 'local', status TEXT NOT NULL DEFAULT 'installed', -- installed|disabled
  installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS skill_invocations (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, persona_id TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  ok INTEGER, tool_calls INTEGER, error TEXT, -- codes only, never content
  ms INTEGER);
```
`SCHEMA_VERSION` 8 → **9**. Skill code lives under `<data>/skills/<id>/`
(created on install from the catalog; wiped on uninstall).

## Core API (authed)

- `GET /v1/skills` (installed) · `POST /v1/skills/install {catalogId}`
  (validates manifest, copies code, records sha256) · `POST
  /v1/skills/:id/disable` / `/enable` · `DELETE /v1/skills/:id` (uninstall
  wipes store) · `GET /v1/skills/:id` (manifest + permissions summary)
- `POST /v1/skills/:id/invoke {args?, personaId?}` → runs the worker with
  budget; result is JSON-serializable; returns {result} or coded errors
  (`not_found`, `disabled`, `budget_exceeded`, `crashed`, `denied`,
  `tool_denied`).
- `GET /v1/skills/catalog` (local catalog listing, read-only) ·
  `GET /v1/skills/:id/invocations` (recent, metadata only)
- Audit: skill.install/update/uninstall/disable/invoke with ids/versions/
  counts — never skill logs/args/content.

## Runtime (core/src/skills/)

- manager (install/list/disable/remove + store hygiene), catalog reader
  (`skills-catalog/*/manifest.json + entry.mjs` samples), runner:
  `spawn` a small bundled runner script with `child_process.fork`, IPC:
  handshake, {log} → redacted console line, {tools.exec} → broker exec with
  source 'skill'; budget timer + kill; exit-code/timeout mapping; max
  invocation args size (64KB) and result size (1MB). Two sample skills in
  the catalog: `hello-skill` (returns args echo) and `note-dumper` (reads a
  note by id via files.read? needs roots/grant — instead demo uses
  `notes.get`? broker tools are files.* only; give note-dumper no tools:
  it returns a canned summary of its args to prove pure skills; add
  `files-preview` skill that uses files.read under a declared root and is
  refused until the user grants the root — proving broker enforcement).

## Web (Skills view — ninth tab, token-only)

Installed list (name/author/version, permissions summary chips incl. risk,
disable/enable, two-step uninstall), catalog tab (each skill: description +
permission summary + Install → becomes installed), Invoke console (pick
skill, args JSON, Run → result or coded error + invocation metadata),
recent invocations list. Token-only.

## Tests

Core: catalog read; install copies + records sha + manifest validation
rejects bad fields (missing entrypoint, tools not in registry, network
skill rejected in M8 with clear error); disable/enable/uninstall wipes
store; runner: hello skill returns echo; note-dumper runs; files-preview
invocation WITHOUT a user grant for its declared root → tool_denied; with
grant → executes (temp root harness); budget exceeded kills (skill that
loops); crashing skill → crashed error; logs never hit audit; args/result
caps. Routes 401/501. Web: api + helpers tests. E2E (spawned demo core):
install hello-skill from catalog → invoke → result; uninstall removes it.

## Exit criteria (tick PLAN.md M8)

- [ ] Local catalog + install/uninstall/disable + sandboxed runner through
      the broker with budgets/kill + user-scoped store + audit, all
      test-covered; two sample skills + a broker-denied demo skill.
- [ ] Skills view token-only; e2e install → invoke → uninstall passes.
- [ ] Remote gallery/signing flagged environment+later (documented).

## Out of scope

Remote gallery + signature verification + updates channel, network-capable
skills, OS-level sandbox (seccomp/containers), per-persona skill visibility
toggles, skills marketplace UI.
