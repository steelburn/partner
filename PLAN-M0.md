# M0 — Scaffold, Tauri shell & security spine (Partner)

Status: **spec** · Repo: `~/apps/partner` · Master plan: `PLAN.md` ·
Style: TDD red → green (vitest), mirroring `~/apps/llm-self-service`.

## Decisions locked for this milestone

- **Desktop shell: Tauri v2** (PLAN §1.1). The TypeScript core ships as a
  **Tauri sidecar**; the M0 packaging spike picks the bundling mechanism
  (PLAN §17.1). Fallback if the spike fails: Electron (recorded, not
  preferred).
- Core stays **Node ≥ 22 + TypeScript (ESM, NodeNext)** with `better-sqlite3`
  + `sqlite-vec` and an Express-style loopback server — consistent with the
  org's llm-self-service conventions.
- Secret store = OS keychain behind a small interface; **fake in tests**.
- Monorepo via **npm workspaces** at `apps/partner/` root.

## Goal

A repo where `npm test` is green, the security spine is proven by tests, and
a packaged app boots: Tauri shell → spawns the core sidecar → core serves the
web UI on loopback → a browser pairs once and completes a demo chat round.

## Repo layout (created here)

```
apps/partner/
  package.json             # workspaces: ["shared","core","web","extension","shell"]
  tsconfig.base.json
  DESIGN.md                # default theme + component contracts (draft at M0, full in M6)
  PLAN.md  ·  PLAN-M0.md  ·  PLAN-M1.md
  shared/                  # types + pure helpers, zero runtime deps
    src/
      persona.ts theme.ts toolManifest.ts wire.ts redact.ts
      version.ts schemaVersion.ts
  core/                    # the Node sidecar
    src/ index.ts config.ts
      http/ server.ts pairing.ts session.ts rateLimit.ts
      keychain/ keychain.ts keychainNative.ts keychainFake.ts
      gateway/ providerClient.ts demoProvider.ts   # demo seam only (full in M1)
      stores/ db.ts
      services/ redaction.ts audit.ts
    test/  *.test.ts
    docs/ spike-sidecar.md # M0 packaging spike write-up + decision
  web/                     # Vite + React SPA (skeleton; chat UI is M3)
    src/main.tsx App.tsx theme/tokens.css pair/ PairGate.tsx
  extension/               # MV3 placeholder (real work is M7)
    src/manifest.ts
  shell/                   # Tauri v2 app
    src-tauri/ tauri.conf.json src/main.rs src/lib.rs
  tests/                   # cross-cutting integration (spawn core, pair, chat)
    e2e-demo.test.ts
```

## Module map (core)

| Module | Responsibility | Test focus |
|---|---|---|
| `config.ts` | Env + CLI: `PORT` (default **4390**), `DEMO_MODE`, `DB_PATH`, `DATA_DIR`, pairing TTLs. Mirrors llm-self-service's strictness (fail fast on missing secrets outside demo). | parse + secret rules |
| `keychain/` | `interface Keychain { get/set/delete/list }` over `service 'partner'`. Native impl via `@napi-rs/keyring` (macOS Keychain / Windows DPAPI / libsecret; Linux needs a keyring daemon — documented caveat). `keychainFake.ts` in-memory for tests. | round-trip, per-account isolation |
| `http/pairing.ts` | Pairing codes: 6 digits, TTL 2 min, single-use, hashed at rest; issue/verify/exchange. | single-use, expiry, wrong code |
| `http/session.ts` | Session tokens: 256-bit random, **stored hashed (sha256)**, bound to (kind: web\|native, origin/device), expiry 30d, revocable. | hashed-at-rest, origin binding, revoke |
| `http/server.ts` | Express app on `127.0.0.1` only. Host/origin allowlist check. Serves `web/` build statically. Auth middleware for `/v1/*`. | loopback-only bind, foreign Host rejected |
| `gateway/` | `ProviderClient` interface + `demoProvider` (canned SSE) so `/v1/chat` streams in demo before M1's real client. | demo echo stream |
| `services/redaction.ts` + `redact.ts` (shared) | Scrub `sk-…`, `Bearer …`, Authorization headers from logs/audit/UI transcripts. | no secret leakage in captured output |
| `stores/db.ts` | SQLite open/migrate (tables: `pairings`, `sessions`, `audit`, `settings`; providers/personas come M1/M3). | migrations idempotent |

## Security spine behaviour (spec of the acceptance tests)

- **Pairing:** UI (or extension) requests pairing → core displays a 6-digit
  code (tray notification / pairing page) valid 2 min, single use. Exchanging
  a wrong code three times locks that attempt for 5 min. Codes are random
  from a CSPRNG; only their hash is stored.
- **Sessions:** after exchange the client gets a token + HttpOnly cookie on
  the loopback origin. Every `/v1/*` call must pass auth **and** the
  Host/origin allowlist (`127.0.0.1:<port>`; extension native-messaging gets
  its own `native` session kind in M7). Revoking a session kills it
  immediately; sessions list is visible in settings (M3 UI; endpoint + tests
  now).
- **Loopback guard:** the server binds `127.0.0.1`; a request whose `Host` is
  not on the allowlist is rejected before any route logic. No CORS
  wildcards — the SPA is same-origin.
- **Secrets discipline:** the plaintext key never crosses any boundary that
  doesn't need it; no secret ever enters logs/audit (redaction layer is
  applied at the single serialization point, tested by scanning captured
  output for `sk-`/Bearer patterns).
- **Config:** outside demo mode, missing secrets fail startup (like
  llm-self-service). Demo mode in-memory only.

## M0 packaging spike (deliverable: `core/docs/spike-sidecar.md` + decision)

Evaluate three ways to ship the Node core as a Tauri sidecar, against a
`better-sqlite3` + `sqlite-vec` + `@napi-rs/keyring` hello-world:

1. **Node SEA** (single-executable application) — small, but native-module
   and snapshotting constraints are the risk.
2. **`bun build --compile`** — single file, fast; verify the three native
   modules load and sqlite-vec works under Bun.
3. **Bundled Node runtime** — ship the official Node binary as a resource and
   run a bundled JS entry; largest, but closest to dev behaviour.

Record per option: binary size, native-module support, updater impact (Tauri
updater signs one artifact), dev-mode parity. **Decision** gates `shell/`
config. Fallback (documented, not preferred): Electron.

## Web skeleton

Minimal but real: `PairGate` (shows pairing flow), an app shell that renders
`theme/tokens.css` (early token module — the actual theme studio is M6; the
skeleton only ever uses these tokens, keeping the no-raw-values discipline
from day one), and a demo chat strip wired to `/v1/chat` used by the e2e
test. No product UI is designed here — this is plumbing to prove the spine.

## TDD tests (red → green)

1. `config`: demo mode relaxes secret requirements; live mode fails fast with
   a clear message listing the missing var.
2. `keychainFake`: set/get/delete round-trip; per-account isolation (two
   accounts don't collide); delete returns null after.
3. `pairing`: issue returns 6 digits; verify ok once; second verify fails;
   expired code fails; wrong code ×3 locks the attempt bucket (429/423);
   stored value is a hash, not the code.
4. `session`: issue/validate/revoke; token stored as sha256 (raw never in
   DB); token bound to its origin fails for another origin; expired session
   rejected.
5. `server`: binds 127.0.0.1 (assert listen address); non-allowlisted Host
   header → 403 before routing; `/v1/*` without session → 401;
   `/v1/health` public.
6. `redact`: `sk-abc…` in a log line is scrubbed; `Authorization: Bearer
   …` scrubbed; audit JSON containing a key never contains `sk-` after
   serialization.
7. `db`: migrations run twice without error; tables exist.
8. `demoProvider`: `/v1/chat` in demo mode streams ≥1 chunk then `done`
   (supertest against the in-memory app).
9. `e2e-demo`: spawn the real core process (demo mode, temp DB) → fetch
   health → issue pairing (test hook reads the displayed code) → exchange →
   authed `/v1/chat` echo round (superagent/undici against loopback).
10. `shell` smoke (manual checklist, not automated in CI): packaged app
    opens, tray icon present, sidecar up, `http://127.0.0.1:4390` serves the
    UI, pair → demo chat works from the packaged artifact.

## Exit criteria (tick against PLAN.md M0)

- [x] Repo + workspaces + vitest green; shared types compile from all
      packages.
- [x] Keychain abstraction with fake + native impl behind one interface.
- [x] Pairing + session + origin allowlist + loopback bind, all test-covered.
      (Pairing codes stored keyed-HMAC, not offline-reversible SHA-256; live
      HOST is restricted to loopback by construction.)
- [x] Redaction layer at the single serialization point, proven by scan
      tests.
- [x] Demo `/v1/chat` streams through the spine; e2e pairs and chats against
      the real spawned process.
- [x] Spike decision recorded in `core/docs/spike-sidecar.md`; core serves
      the built SPA at `/` when a static dir is configured (stub, review-
      closed). **RESOLVED via `shell/docker/gate/` (container toolchain,
      Sep 2026):** `partner-shell` compiles (debug, Ubuntu 24.04 + webkit2gtk
      4.1); the bundled core artifact (single-file CJS + vendored natives)
      boots and serves `/v1/health` + the web UI (200); the shell runs under
      Xvfb and its webview paints the real Partner SPA (verified by exact
      design-token colors in the screenshot histogram). Remaining desktop
      caveats recorded in `shell/src-tauri/README.md`: run on a real display
      without `PARTNER_NO_SIDECAR`, and wire the real sidecar artifact
      (SEA/bundled-node) at bundle time on a desktop machine.
- [x] `DESIGN.md` draft exists (tokens module matches it; dark palette
      contrast-tuned; ux_audit passes on all asserted pairs).

## Out of scope here

Providers/gateway/key-import (M1), personas (M3), memory, plans, theming
studio (M6), extension real work (M7), skills (M8). M0 only proves: repo,
shell, spine, demo round-trip.
