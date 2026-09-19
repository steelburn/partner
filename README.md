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
scripts/    repo tooling (version.mjs — the one writer of the release version)
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

**M0–M37 implemented.** Latest release **v0.1.26**.

| | |
|---|---|
| Root suite | **1833 passed** (5 env-gated skips) |
| Shared / web suites | **90** / **1084** passed |
| Typecheck | 0 errors (`npm run typecheck`) |
| Web build | green (`npm run build -w web`) |
| Schema | **v24** (multi-persona memory scope; M35 changed no schema) |
| Hosted shape | `AUTH_MODE=login` — container + tunnel verified (`docs/VERIFY-M21.md`, `docs/VERIFY-M22.md`) |
| Partly open | M20.B S8 (Vault/Runner), M13/M14/M15/M24 live env-gated walks, and the M34/M35 folder open ends (no folder move gesture, the phone rail's asset count) — see `docs/UNFINISHED.md` |

Recent work (M30–M37) reshaped the shell and memory: conversations now live
under **Personas** with a resizable menu and an **Unassigned** group, and a
session is organized twice — by the persona that runs it and by the **Folders**
section that files it, which is now an Explorer (folder tree beside the open
folder's subfolders and chats, with a breadcrumb address bar); a chat's title
sits at the top of the session, renamed in place or proposed by **Suggest
title** once the chat has a few turns. The Skills **Catalog** is a card deck
with a detail drawer; Memory ties a pending suggestion to a persona in one step,
shows rejected facts, and supports **any set** of personas per fact
(`personaScopes`, schema v24). M36 then took a display pass over Memory: a
suggestion row reads in one line (one provenance item, and the scope text is its
own disclosure), episode summaries expand and only offer **Open chat** for a
conversation the shell really has, disabled controls say why in place, search
hits are highlighted and actionable, and the add form's persona grid collapses
for the usual *All personas* answer. M37 then turned that library into
**responsive group cards**: one card per bucket (by **Kind**, or by the
**Persona** that honors the fact) in an `auto-fill` grid, switched by one
segmented pill and remembered per browser.

Release-by-release detail is in `CHANGELOG.md`; per-milestone specs are
`PLAN-M<N>.md`; the compact index is `PLAN.md` §15.
