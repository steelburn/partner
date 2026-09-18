# Partner — a personal AI partner workspace

User-owned AI partner: your own LLM endpoints + keys, a local-first core, a
browser web UI and a browser extension. No vendor account, no telemetry.

## Docs

| File | What it is |
|---|---|
| `PLAN.md` | Master plan: vision, architecture, design sections (§1–§14) and the compact **milestone index** (§15). |
| `PLAN-M<N>.md` | Detailed spec for milestone `N` (e.g. `PLAN-M11.md`, `PLAN-M20.md`). |
| `CHANGELOG.md` | Release notes, newest first. |
| `docs/UNFINISHED.md` | What is left, the dependency order, and every env-gated walk that was never run. **Start here to pick up work.** |
| `docs/VERIFY-*.md` | Verification records: browser/container walks, measurements, and explicit "not verified" lists. |
| `docs/HISTORY.md` | Archived long-form status log (pre-2026-09-18 README + `PLAN.md` §15 detail). Read only when you need provenance. |
| `DESIGN.md` | Default design system (tokens live in `shared/src/theme.ts`). |
| `docs/HANDOFF-WINDOWS.md` | Windows onboarding + CI handoff. |
| `docs/` | `migrate-plaintext.md`, `redaction-inventory.md`, `theme-conformance.md`, and the `m28/` canvas frames. |

## Layout

```
shell/      Tauri v2 app (tray, window, autostart, updater)   [M0 · packaged M10/11]
core/       Node core = Tauri sidecar (spine → workspace)     [M0–M33]
web/        SPA (Vite + React)                                [M0–M33]
extension/  MV3 (native-messaging bridge, theme stream)       [M7–M11]
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

`dev:core` binds the desktop's own port. A packaged Partner window is owned by
its core: it mints a per-boot nonce, hands it to the sidecar it spawns, and
requires the listener on :4390 to echo it (`GET /v1/boot`) before treating it as
its own — so a leftover dev core cannot hijack the app invisibly. Stop the dev
core (Ctrl-C) before launching the desktop app; if it shows “already serving …”,
something else still holds :4390.

Container/hosted way in: see `PLAN-M21.md` (image + Cloudflare Tunnel) and
`PLAN-M22.md` (`AUTH_MODE=login`, `FIXED_ROOTS`, invite-based sign-up).

## Status (2026-09-18)

**M0–M33 implemented.** Latest release **v0.1.25**.

| | |
|---|---|
| Root suite | **1783 passed** (5 env-gated skips) |
| Shared / web suites | **90** / **999** passed |
| Typecheck | 0 errors (`npm run typecheck`) |
| Web build | green (`npm run build -w web`) |
| Schema | **v24** (multi-persona memory scope) |
| Hosted shape | `AUTH_MODE=login` — container + tunnel verified (`docs/VERIFY-M21.md`, `docs/VERIFY-M22.md`) |
| Partly open | M20.B S8 (Vault/Runner), M13/M14/M15/M24 live env-gated walks — see `docs/UNFINISHED.md` |

Recent work (M30–M33) reshaped the shell and memory: conversations now live
under **Personas** with a resizable menu and an **Unassigned** group; the Skills
**Catalog** is a card deck with a detail drawer; Memory ties a pending
suggestion to a persona in one step, shows rejected facts, and supports **any
set** of personas per fact (`personaScopes`, schema v24).

Release-by-release detail is in `CHANGELOG.md`; per-milestone specs are
`PLAN-M<N>.md`; the compact index is `PLAN.md` §15.
