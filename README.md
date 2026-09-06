# Partner — a personal AI partner workspace

User-owned AI partner: your own LLM endpoints + keys (see
`~/apps/llm-self-service`), local-first core, browser web UI, browser
extension. See the plans:

- `PLAN.md` — master plan (vision, personas, memory, skills, theming,
  security, milestones).
- `PLAN-M0.md` — M0 spec: scaffold, Tauri shell + sidecar spike, security
  spine.
- `HANDOFF-WINDOWS.md` — Windows CI handoff + full project state (read this
  first if picking up from GitHub on a Windows machine).
- `PLAN-M1.md` — M1 spec: providers, model gateway, integrated key import.
- `PLAN-M11.md` — M11 spec: chat as the workspace.
- `PLAN-M12.md` — M12 spec: UI readability & polish pass (current).
- `DESIGN.md` — default design system (tokens live in `shared/src/theme.ts`).

## Layout

```
shell/      Tauri v2 app (tray, window, autostart, updater)   [M0 · packaged M10/11]
core/       Node core = Tauri sidecar (spine → workspace)     [M0–M11]
web/        SPA (Vite + React)                                [M0–M11]
extension/  MV3 (native-messaging bridge, theme stream)      [M7–M11]
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

## Status (2026-09-06)

M0–M11 complete (PLAN.md §15): suites core 683 · web 440 · extension 57,
typechecks 0. The packaged app is verified two ways — the container
toolchain (`shell/docker/gate`) and a green NSIS installer on the
self-hosted Windows runner that boots env-free (demo, schema v12); the
packaged UI was swept headlessly with zero console errors. Remaining items
are manual / env-gated: the per-surface light/dark/custom theme walkthrough
(`docs/theme-conformance.md`), the `docs/VERIFY-M10.md` live-mode walk,
browser-actuator research capture (real Chrome + installed native host), and
the S0 companion API in `~/apps/llm-self-service`. Read
`HANDOFF-WINDOWS.md` first when picking up from a Windows machine.
