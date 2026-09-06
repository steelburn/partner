# M2 — Tool broker, project roots & file tools (Partner)

Status: **spec** · Repo: `~/apps/partner` · Master plan: `PLAN.md` (§4.3, §4.4,
§12, §15 M2) · Style: TDD red → green, subagent writer lanes, same gates as
M0/M1 (typechecks, vitest, ux_audit, fresh-context review).

## Goal

The machinery that makes Partner's local capabilities safe: a **default-deny
tool broker** with declared manifests, a **grant store**, **project roots**
(the only paths the broker can see), a first file-tool set with
**write-preview/apply**, a user-facing **approval queue**, and audit for every
execution. This milestone builds the plumbing only — personas (M3) will be the
first callers of `POST /v1/tools/exec`; the web UI proves the flows directly.

## Security rules (from PLAN.md §4.3 — non-negotiable)

1. **Deny by default.** Nothing executes without a grant (tool, project root,
   source, optional expiry). Resolution order: user grant > deny.
2. **Risk tiers decide UX:** `low` runs under an existing grant;
   `medium` asks once per (tool, root) then remembers; `high` asks EVERY time
   unless an explicit "always allow" user grant exists.
3. **Project roots are the only visible filesystem.** Tools resolve paths
   against registered roots; `..` traversal, symlinks escaping a root, and
   absolute paths outside roots are rejected.
4. **Write preview/apply:** `files.edit` produces a preview (diff + original +
   proposed), NEVER mutates; the user approves from the UI; apply is a second
   tool call that re-checks the grant and performs atomic write + `.bak` +
   mtime restore.
5. Every execution writes an audit row: tool, params (redacted), grant id,
   result status, elapsed. Secrets never enter audit or responses.

## Data model (core SQLite schema v3 — additive, idempotent)

```sql
CREATE TABLE IF NOT EXISTS project_roots (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
  read_only INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, tool_id TEXT NOT NULL, project_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL,
  expires_at INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS pending_tools (
  id TEXT PRIMARY KEY, tool_id TEXT NOT NULL, project_id TEXT,
  params TEXT NOT NULL, risk TEXT NOT NULL, requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, decided_at INTEGER, decision TEXT,
  decided_by TEXT);
CREATE TABLE IF NOT EXISTS file_proposals (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL,
  original_mtime INTEGER NOT NULL, original_content TEXT,
  proposed_content TEXT NOT NULL, created_at INTEGER NOT NULL,
  applied_at INTEGER, discarded_at INTEGER);
```

`SCHEMA_VERSION` 2 → **3** in shared (meta row follows automatically).

## Tool manifests (v1 set — every tool declares itself)

| Tool | risk | confirm | Notes |
|---|---|---|---|
| `files.list` | low | once | list one dir under a root |
| `files.read` | low | once | read a file under a root (size cap) |
| `files.search` | low | once | ripgrep-style content search under a root (no binary) |
| `files.edit` | medium | once | propose an edit → returns `proposalId`; apply is a follow-up call |
| `files.apply` | high | always | applies a proposal (atomic write + .bak) |
| `files.delete` | high | always | delete under a root (trash-first: rename to `.partner-trash/`) |

`network: false` for all; scope = `{projectId}`.

## Core API (authed loopback)

- `GET /v1/roots` · `POST /v1/roots {label, path, readOnly?}` ·
  `DELETE /v1/roots/:id` (path must exist & be absolute; roots are stored
  canonicalized + symlink-resolved)
- `GET /v1/grants` · `POST /v1/grants {toolId, projectId, note?}` ·
  `DELETE /v1/grants/:id` (UI-visible "always allow" list)
- `POST /v1/tools/exec {tool, params}` → `{outcome:'executed', result}` |
  `{outcome:'needs_approval', pendingId}` | 403 `denied` | 404 unknown tool |
  400 bad params (validation per tool). Runs the broker: granted-low → run;
  medium/high without an explicit grant → enqueue pending, respond
  `needs_approval`.
- `GET /v1/tools/pending` · `POST /v1/tools/pending/:id {decision, note?}`
  (approve/deny; approve with `remember:true` creates the grant; deny just
  closes; the caller who owns the pending row can poll + re-exec)
- `GET /v1/tools/proposals/:id` (diff payload: original vs proposed +
  metadata) · `POST /v1/proposals/:id/apply` (goes through the broker as
  `files.apply` with projectId+proposalId params — risk high, always ask)
- `DELETE /v1/proposals/:id` (discard)

Broker internals (core/src/broker/): `toolManifests.ts` (registry),
`broker.ts` (authorize → execute | enqueue), `grants.ts` (manager over the
store), `pending.ts` (queue manager), path resolution helper
`core/src/files/paths.ts` (canonicalize, root-escape guard),
`core/src/files/tools.ts` (the six tool impls + validators + redacted param
logging). Wire in createCore via options `broker` (optional like
providerManager so M0/M1 harnesses compile unchanged; chat route untouched).

## Web (provisional, token-only)

- "Files" view with a **roots manager** (add/list/remove; show canonical path,
  read-only badge; validation error inline) and a **grants list** (tool ×
  root, revoke).
- **Approval queue** surface (live badge count on the view switch; poll
  `GET /v1/tools/pending`): shows tool name, params summary (rendered, never
  raw secrets), risk chip, Approve (optionally "remember for this tool+root")
  / Deny.
- A small **"Try a tool"** panel per root to prove the flow: choose
  `files.list`/`files.read`/`files.search` with a relative path → executes
  when granted or surfaces the approval prompt; and an **edit preview** flow:
  target file + proposed text → proposal row → rendered diff (original vs
  proposed, simple line diff) → Apply (high-risk confirm) or Discard.

## Tests (red → green)

Core: path resolver (canonicalize; traversal + symlink escape rejected;
absolute-outside rejected; root listing isolation); manifest registry; broker
resolution (deny-by-default; low-under-grant runs; medium asks once then
remembers; high always asks; explicit grant overrides); grants CRUD + expiry;
pending queue approve/deny/remember + ownership; file tools against a temp
root (list/read/search caps; edit → proposal; apply = atomic + .bak present +
mtime preserved; delete → trash path; size caps; redaction: no params leak
into audit); routes authz (401), 403 denied, proposal lifecycle, roots CRUD.
Web: lib functions for the new endpoints w/ mocked fetch (never echo params
payloads with keys), diff rendering helper unit tests. All pre-existing suites
stay green.

## Exit criteria (tick PLAN.md M2)

- [x] Broker + grants + roots + six tools with preview/apply, fully
      test-covered.
- [x] Approval queue + grants/roots UI usable end to end (provisional).
- [x] E2E over the spawned demo core: add a temp root → `files.edit` proposal
      → approve (high-risk) → apply → file changed on disk; audit shows no
      secret material.
- [x] UX audit passes on new CSS; typechecks; root + web suites green.
- [x] Packaged-app gate CLOSED (this line superseded): M10 W6 landed a green
      NSIS installer on the self-hosted Windows runner (env-free boot) and
      M11 F5 swept the packaged app headlessly. Surviving caveats are
      manual only: real-desktop interactive smoke + live-mode packaged-core
      boot (shell/src-tauri/README.md, docs/VERIFY-M10.md §F).

## Out of scope

Persona/independence use of the broker (M3), skills as tool callers (M8),
MCP adapter, network-capable tools, arbitrary exec/terminal tools.
