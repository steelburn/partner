# M10 — Hardening & alpha (encryption, budgets, audit UI, degrade chat, packaging)

Status: **in progress** · Repo: `~/apps/partner` · Master plan: `PLAN.md` (§11, §15
M10, §17) · Gates: same as M0–M9, PLUS the whole matrix must stay green on
the self-hosted **verify** CI (`Linux` + `Windows` runners,
`.github/workflows/verify.yml`) — the milestone that finally has CI to
regress against.

## Progress (2026-09-05)

- [x] W2 redaction sweep (patterns + matrix + route guarantee + inventory doc)
- [x] W3 budgets that bind (spend ledger schema v11 + pre-turn refusal +
      settle-on-finish + remaining-budget UI)
- [x] W4 Audit tab (server filters + eleventh view + export + e2e; ux_audit
      PASSED)
- [x] W1 encryption at rest (spike recorded above: Decision A adopted and
      implemented — whole-file via the better-sqlite3-multiple-ciphers
      alias; keychain-held key; plaintext refusal; containers on node 22)
- [x] W5 session-only chat (direct endpoint client + PairGate entry +
      in-memory key; browser pass against a local CORS stub)
- [x] W6 packaging PREP (official icon set, bundle.resources restored,
      self-hosted Windows workflow stages resources) — AWAITING one green
      run on the self-hosted Windows runner (dispatch windows-build)
- [ ] W7 verification checklist written (`docs/VERIFY-M10.md`) — runner
      confirmations + fresh-context review + HANDOFF refresh + PLAN.md M10
      tick remain

## Goal

Turn the demo-ready M0–M9 product into a defensible single-user **alpha**:
secrets-protecting storage, a provably clean redaction boundary, budgets that
actually bind across turns, a user-visible audit trail, a usable no-core
fallback (session-only chat), and a real Windows installer produced on the
repo's self-hosted runner. Same product pillars; nothing here adds user-
facing features beyond the audit view + degrade chat — it hardens what ships.

## Environment gates (as before, unchanged)

Real provider keys, live OS-keychain crypto, LAN/remote core exposure, signed
updater artifacts, and anything needing the org infra stay environment-gated.
M10 exercises every loop it can headlessly and on the two verify runners;
the parts that need a live desktop shell or a code-signing certificate are
specified, wired, and marked in the manual checklist instead of being
pretended green.

---

## W1 — Encryption at rest (spike first, then decide)

PLAN §11/§17 Q3. The DB today is plaintext SQLite next to the keychain. An
ALPHA that holds chat transcripts, notes, plans and profile facts must not
write them in the clear when the threat model says *other processes and file
exfiltration are not trusted* (the OS account boundary and BitLocker/FileVault
are assumed present but not sufficient for the DB file itself).

### W1.0 — Spike (gate A vs B), mirrors M0 §17.1 style

Evaluate **better-sqlite3-multiple-ciphers** as a drop-in (same sync API,
`db.pragma("key = …")` for file DBs) on the exact runtime matrix:
win32/node22, linux-glibc (node:20-slim container), FTS5 probe
(`assertFts5`), WAL, `:memory:` DBs untouched (tests keep working with no
key), and prebuild availability for all three. Criteria to pass:
- all three runtime shapes boot and the whole root suite runs with a keyed
  file DB (add a keyed-DB test variant, `:memory:` suite unchanged);
- FTS5 note/episode search works under the cipher build;
- no >2× open/query regression on a 10k-row notes fixture.

**Decision A (preferred, if the spike passes): whole-file SQLCipher-style.**
Search keeps working (no per-row trade-offs); schema unchanged; key handling
is one pragma at open. Live-mode key: `Entry(service 'partner', account
'db-key')` in the OS keychain, HKDF-stretched to a 32-byte AES key;
`KEYCHAIN_KIND=fake` + a FILE DB is refused in live mode with a clear error
(no "demo key protects a real file" trap). Demo stays `:memory:`/fake and is
byte-identical. A pre-M10 plaintext file DB is detected (no `key` pragma →
cipher header check) and refused with a migration message: alpha provides
`core/src/tools/migrate-plaintext.mjs`-style export guidance (documented),
not silent re-encryption.

**Spike result — 2026-09-05 (recorded): Decision A adopted.**
`better-sqlite3` is aliased to `better-sqlite3-multiple-ciphers@^13.0.3`
(npm alias keeps every import site, bundle external, and the OS-level name
unchanged). Verified on win32/node22 AND linux-glibc/node:22-slim
(container): keyed file DB + WAL ok; the `assertFts5` probe passes under the
cipher build; 10k-row fixture opens/queries in <500ms; wrong key and
plaintext files both fail with a clean "file is not a database"; a 32-byte
hex key via `PRAGMA key = "x'…'"` skips the SQLCipher KDF. One ABI finding:
the fork's prebuilds cover node >= 22 only — node:20-slim SEGFAULTS on
load, so container bases must be node:22-slim (matches the repo engine
guard `>=22`); docker/webapp-demo + the Ship bundle template were bumped.
`KEYCHAIN_KIND=fake` with a FILE db is refused in live mode (config guard);
plaintext detection at keyed open refuses pre-M10 DBs with a migration
message. `:memory:`/demo paths are untouched.

**Decision B (fallback if the spike fails): app-level AES-GCM per row**
(256-bit, random 12-byte IV, AAD = table+id — the llm-self-service
precedent). Applied to the *non-indexed* sensitive families first:
`messages.content`, `profile_entries.value`, `episodes.summary`,
`conversations.title`; notes/plans content stays plaintext BECAUSE FTS +
wiki-links index them — recorded as a **known limitation row** with a
remediation note (encrypted FTS shadow or whole-file on a later SQLCipher
integration). The decision + spike results are recorded in this doc before
the implementation commit lands.

### W1 tests / exit

- keyed file DB round-trips (messages/notes/profile/episodes), wrong-key open
  fails clean, demo path untouched (`:memory:`), plaintext-file refusal
  message, spike log entry in this doc, suites green on both verify runners.
- Security claim added to PLAN §11 table ("storage at rest") with the chosen
  mechanism + key lifecycle.

## W2 — Redaction sweep (prove the boundary)

Redaction is centralized (`auditLog` → `redactJson`) and already strong. The
sweep is an *audit with teeth*:

1. Inventory every `audit.log(...)` callsite (server.ts, broker, playbooks,
   skills, providers, deploy) and every error message that can carry
   upstream/provider text (`provider errors.ts`, selfService import) and
   assert in tests that no secrets/keys/content cross. Extend the shared
   redaction patterns where the inventory finds gaps (e.g. PEM blocks,
   `key =`, `client_secret`, cookies in provider error echoes).
2. Add a **redaction test matrix** at the shared boundary: sk- keys,
   Authorization/bearer, passwords, PEM, nested JSON params, content strings
   that *look* like directives — asserted absent from audit rows and from
   server log output during a chat + playbook + skill + provider round.
3. `GET /v1/audit` response is redacted by construction (single
   serialization point) — add a route test proving a deliberately seeded
   secret detail never leaves the API.

Exit: inventory table in this doc (or `docs/redaction-inventory.md`),
matrix green, no gaps left unlabelled.

## W3 — Budgets that bind across turns

M1's `createBudgetTracker` caps a single response and documents that
cumulative spend is not tracked — that is the gap an alpha must close
(runaway multi-turn research against a metered key).

1. **Spend ledger** — additive schema **v11**: `spend_ledger (provider_id,
   window_start INTEGER, cents INTEGER, PRIMARY KEY (provider_id,
   window_start))` where `window_start` = start of the provider's budget
   window (default: rolling 30 days from first charge; window length a
   provider setting). Cumulative cap = existing `budget_cents` on the
   provider profile, enforced by the ledger *before* a turn starts (refuse
   `budget_reached`, no bytes streamed) and reconciled after each `usage`
   event (per-turn tracker stays for mid-stream hard stops).
2. **Surfacing** — chat usage line + providers list show remaining budget
   when a cap is set; a cap hit is an audit row (`provider.budget` with
   ids/cents only) and a `budget_reached` chat event (ChatStrip already
   renders it as a turn error — keep).
3. Demo mode has no providers → untouched. Ledger only exists for configured
   providers.

Tests: turn 1..N cumulative stop at the exact cent boundary; window roll;
unknown model priced conservatively (existing pricing fallback); audit rows
carry no content; web unit for the remaining-budget display helper; e2e on
the spawned core with a scripted provider that charges.

## W4 — Audit UI + export (web, eleventh tab)

`GET /v1/audit` exists; no surface shows it. New **Audit** tab:
- list newest-first, capped + paged (server gains `?limit&actor&action&q`
  filters — additive + tested);
- row: time · actor · action · target · redacted details (collapsed JSON,
  expandable, monospace);
- **Export** as JSON or Markdown (client-side blob download from the fetched
  page(s); no server export route needed — the whole log is small enough for
  alpha, cap documented);
- copy of the security note ("secrets are scrubbed before this ever reaches
  storage").
- Token-only CSS, all interaction states, ux_audit gate before merge.

Tests: web api client (filters/params), helper unit tests (row rendering,
export serialization), core route tests for the new filter params, spawned-
core e2e (actions appear after a chat/playbook round; export content has no
`demo:`/content bytes).

## W5 — Session-only chat (degrade mode)

PLAN §3: usable from a borrowed machine with no core. Shape: when the app
has no session and no reachable core (PairGate state), offer **"Session-only
chat"** instead of dead-ending:
- fields: endpoint URL (default `https://api.ne1.dev/v1`-style
  OpenAI-compatible base), pasted key, persona-less composer;
- the web client streams directly against that endpoint with the M1 header
  discipline (neutral UA, no x-stainless-*), key held **only in memory** for
  the tab (never localStorage/sessionStorage/URLs/logs); refresh = gone;
- no tools/memory/notes — a clear notice lists what is disabled and why;
- CORS failure surfaces as a readable hint ("this endpoint did not allow
  browser access — run the desktop core instead"), not a stack trace;
- one-shot multi-turn within the tab only (state in memory), text/stream
  rendering reuses the chat UI components.

Tests: web unit for the session-only client (SSE parse, header scrub, key
never in URL/logs, CORS/abort error mapping, no persistence — assert
storage untouched). No DOM e2e (node-only web suite): manual-checklist item
for the real browser pass.

## W6 — Alpha packaging on the self-hosted Windows runner

The desktop track that needs a Windows machine with Rust/MSVC — the repo has
one now (self-hosted Windows runner). Scope:

1. Point `.github/workflows/windows-build.yml` at `[self-hosted, Windows]`
   (adjusting icon/toolchain steps to whatever the runner proves), close the
   **RC.EXE** blocker with a real `npx tauri icon` generated set (or the
   runner-validated committed icons), and land a green **NSIS installer
   artifact**.
2. Close the **resources-embedding open item**
   (`shell/src-tauri/README-windows.md`): stage
   `shell/src-tauri/resources/{core-bundle.cjs,node_modules,web-dist}` before
   `cargo build`, restore the `resources` glob in `tauri.conf.json`, and
   confirm the build no longer warns — installer self-contained (no env vars).
3. **Signed updates** stay env-gated (needs the org code-signing cert +
   update server): wire the updater config + signature-verification code path
   so enabling it later is config-only, and mark it in the manual checklist.
4. shell README runbook updated with the runner-based flow.

Exit: green NSIS artifact on the self-hosted runner, runbook reflects reality.

## W7 — Verification checklist + docs + review close

- `docs/VERIFY-M10.md` — full manual alpha checklist (walk the demo webapp,
  add a live provider if available, exercise degrade chat in a browser,
  verify encryption refusal/migration messages on a file DB, audit export,
  budgets, Windows installer smoke on the runner). Modeled on the existing
  runbooks; every env-gated item explicit.
- README + HANDOFF refresh; PLAN §11 table updated by W1.
- Exit gate (same as M0–M9): fresh-context review with findings closed,
  root/web/extension suites green on the self-hosted Linux AND Windows
  verify runs, ux_audit PASSED on the Audit tab CSS, PLAN-M10 exit boxes +
  PLAN.md M10 ticked.

---

## Schema / API deltas

- schema **v10 → v11** (additive): `spend_ledger` (W3). No other new tables;
  W1 encryption changes no schema (whole-file) or only column encodings
  (fallback B: still TEXT columns, ciphertext+IV in one field — no DDL).
- `GET /v1/audit` gains optional `?limit&actor&action&q` (W4).
- No other public API additions; session-only chat is web-only (no core
  route).

## Out of scope (alpha)

Remote/LAN multi-device core + TLS (PLAN §13 "remote core later"), signed
updater delivery, remote skill gallery, multi-repo vibe-coding, anything that
needs the org infra beyond the env-gated notes. The desktop shell's live
sidecar continues to run from the repo bundle; installer embedding is W6.

## Order

W1 spike → W2/W3 (core, independent) → W4 (needs W2's audit guarantees) →
W5 (web, independent) → W6 (runner CI, can start any time) → W7. Core work
lands as its own commits; each workstream keeps the full matrix green.
