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
- `DESIGN.md` — default design system (tokens live in `shared/src/theme.ts`).

## Layout

```
shell/      Tauri v2 app (tray, window, autostart, updater)   [M0 scaffold]
core/       Node core = Tauri sidecar (spine, gateway, broker…) [M0 build]
web/        SPA (Vite + React)                                  [M0 skeleton]
extension/  MV3 placeholder                                    [M7]
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

## Open follow-up (packaged app)

M0's packaged-Tauri-app boot is NOT yet verified: this machine has no Rust
toolchain. When ready: install rustup + `cargo install tauri-cli`, then follow
`shell/src-tauri/README.md` (`cargo check` / `tauri dev`) and tick the final
PLAN-M0.md exit item.
