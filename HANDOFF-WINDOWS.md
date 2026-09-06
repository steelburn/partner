# Partner — Windows CI handoff & project state

**Purpose:** everything an agent needs to continue from a **Windows machine,
cloning `github.com/steelburn/partner`**, plus a full project status snapshot
so no local-only context is lost. Refreshed 2026-09-06 (M11 complete).

## TL;DR

- Product milestones **M0–M10 are complete and verified** (fresh-context
  reviews closed; exit checklists ticked). **M11 (Chat as the workspace) is
  implemented and verified**: schema v12, all work packages C1–C3 + F1–F12
  shipped — attachments/file refs, chat tool calls + MCP stdio client +
  wired API-key search, persona skill/tool policy, purpose-based providers,
  HTML rendering, follow-latest, clickable choices, Assets, chat folders +
  drag-to-move + persona home folders, per-conversation themes + extension-
  chrome theme stream, Notes promoted, A/B persona studio, sandboxed
  HTML/CSS preview. Suites green: core 683 · web 440 · extension 57,
  typechecks 0; PLAN.md §15 M11 ticked; PLAN-M11 final report written.
- **Windows desktop CI is GREEN.** `verify` runs on the self-hosted Linux +
  Windows runners (`win-intel-i5-core-ultra`, label `[self-hosted, Windows]`)
  and passes end-to-end on both. `windows-build` produces the NSIS installer;
  the **installed app boots env-free** (core on `127.0.0.1:4390`,
  `demo=on schema=v12`) and the packaged UI was swept headlessly with zero
  console errors.
- Remaining is **manual / env-gated only**: per-surface light/dark/custom
  theme walkthrough on a real desktop (`docs/theme-conformance.md`),
  live-mode packaged-core boot + real-keyring/charged-provider items
  (`docs/VERIFY-M10.md`), Chrome click-through + native-host install
  (extension), S0 companion API in `~/apps/llm-self-service`.
- Repo: `github.com/steelburn/partner` (private), default branch `master`,
  pushed direct. `verify` auto-triggers on push; `windows-build` triggers on
  workflow_dispatch / `v*` tags.

## Machine prerequisites (this runner/dev box)

1. **VS Build Tools 2022, workload "Desktop development with C++"** (MSVC
   14.44 + Windows SDK 10.0.26100 verified). Needed by npm ci (node-gyp
   rebuild of the aliased `better-sqlite3`) AND cargo/NSIS.
2. **Rust stable-msvc** (CI installs via dtolnay; ~/.rustup on this box).
3. **Node 22** (SQLCipher-fork prebuilds need node ≥ 22).
4. **Smart App Control OFF** (Windows Security). SAC blocks unsigned cargo
   build scripts intermittently (`os error 4551`) — must be off for any
   native compile.
5. **Git for Windows first on PATH** — bash-using actions
   (`dtolnay/rust-toolchain`, …) resolve WindowsApps' WSL shim otherwise.
   Restart the runner after PATH changes.
6. **PowerShell execution policy is GPO-pinned** — workflow steps use
   `shell: cmd` (pwsh unusable; node-gyp's PS discovery also blocked, so
   node-gyp falls back to vswhere — works with the workload installed).

## Repo map

```
.github/workflows/verify.yml          CI: linux+windows legs, all suites
.github/workflows/windows-build.yml   Desktop build: stage → npm ci → bundle → tauri build nsis
shell/             Tauri v2 app (src-tauri; icons; resources gitignored, staged by CI)
shell/src-tauri/README-windows.md     Windows runbook (verified state + resources rationale)
core/              Node core (loopback API, broker, personas, memory, notes,
                   theming, NM mode, skills, playbooks, encrypted DB, budgets,
                   audit w/ redaction, chat tool pass, MCP client, search)
web/               React SPA (Vite; attachments/assets, folders, markdown,
                   choices, MCP + search panels, theme studio, Audit,
                   session-only chat, budget UI)
extension/         MV3 extension (native-messaging bridge, theme stream) + README runbook
shared/src/        wire contracts (schema v12), theme tokens, redaction
tests/             cross-cutting e2e (spawn real demo core; audit, playbooks)
PLAN.md + PLAN-M0..M11.md             milestone specs (M11 = latest)
skills-catalog/    local skills (hello-skill, note-echo, files-preview)
docker/webapp-demo/  demo container (node:22-slim; core bundle + web/dist)
docs/              VERIFY-M10.md, theme-conformance.md, redaction-inventory,
                   migrate-plaintext
```

## Verification commands (all green locally + on CI)

```bash
npx vitest run                 # root suite (683 passed; 5 Windows symlink skips)
(cd web && npx vitest run)     # web suite (440)
(cd extension && npx vitest run)  # extension suite (57)
npm run typecheck              # workspaces
```

Windows leg skips 5 env-gated symlink tests (no Developer Mode) — expected.

## Windows build (CI path — no local Rust/MSVC needed)

1. Stage happens inside the workflow: web build → esbuild core bundle →
   vendor natives (`shell/artifacts`) → sidecar placeholder (node renamed to
   `binaries/partner-core-x86_64-pc-windows-msvc.exe`) → copy all four into
   `shell/src-tauri/resources/` → `tauri build --bundles nsis`.
2. Artifact `partner-windows` (36 MB): `partner-shell.exe` + NSIS setup +
   `core-bundle.cjs`.
3. NSIS embeds the staged tree at `<exe>/resources/…`; `spawn_core`
   (`shell/src-tauri/src/lib.rs`) resolves staged files from
   `<resource_dir>/resources` or flat `resource_dir`, **strips the `\\?\`
   verbatim prefix** (node's CJS loader dies on `\\?\C:\…` main scripts),
   spawns the sidecar, waits for the port. Dev fallbacks
   `PARTNER_CORE_BUNDLE`/`PARTNER_STATIC_DIR`/`PARTNER_NO_SIDECAR` remain.

### Resources gotcha (fixed, documented in README-windows.md)

`bundle.resources` must be `["resources"]` (bare dir → walk). `"resources/**"`
matches **directories only** in glob 0.3.4, so tauri-build fails with
`glob pattern resources/** path not found or didn't match any files` even
when the dir is full of files.

## State ledger

| Area | State |
|---|---|
| M0 spine → M9 playbooks | ✅ verified + reviewed (closed) |
| M10 W1 encryption-at-rest | ✅ SQLCipher-style whole-file (Decision A); OS-keychain key; live mode refuses plaintext (docs/migrate-plaintext.md) |
| M10 W2 redaction sweep | ✅ single serialization point; seeded-secret audit test; docs/redaction-inventory.md |
| M10 W3 budgets | ✅ spend ledger (rolling 30-day window), chat pre-turn refusal, provider budget audit |
| M10 W4 audit UI | ✅ Audit tab (11th), filters, JSON/Markdown export, e2e |
| M10 W5 session-only chat | ✅ direct OpenAI-compatible streaming; key memory-only; PairGate entry |
| M10 W6 packaging | ✅ windows-build green; NSIS installer boots env-free (demo=on; rebuilt under M11 for schema v12) |
| M10 W7 verify docs | ✅ VERIFY-M10.md written; PLAN-M10 tick done |
| M11 chat-as-workspace | ✅ C1–C3 + F1–F12 implemented (schema v12); suites core 683 · web 440 · ext 57; typechecks 0; NSIS packaged app boots env-free (demo, schema v12); packaged UI swept headlessly — zero console errors; PLAN.md §15 M11 ticked; PLAN-M11 final report |
| M11 F5 manual theme walkthrough | ⚠️ docs/theme-conformance.md "Surfaces" checklist — packaged-app light/dark/custom walk on a real desktop (manual) |
| VERIFY-M10 manual walk | ⚠️ live-mode packaged-core boot (DEMO_MODE=0 + native keychain in-shell), real keyring, charged-provider budget, NSIS install on a desktop — env/manual |
| CI | 🟢 verify: linux + windows legs green on self-hosted runners; windows-build green (dispatch) |
| Env-gated by design | Chrome click-through (extension), browser-actuator research capture, live ship deploys, email/presentation sending, signed updater artifacts |

## Local-only artifacts (NOT on GitHub)

- `shell/artifacts/` (core-bundle.cjs + vendored node_modules) — gitignored,
  regenerated by CI steps / stage scripts.
- Demo container `partner-webapp-demo` (rebuilt w/ node:22; verified then
  removed) — rebuild from `docker/webapp-demo/` if needed.
- Local demo core script `/tmp/partner-webapp.sh`; demo core was on
  `127.0.0.1:4390` serving `web/dist` (stopped during packaging smoke tests;
  restart via the script if needed).
- `~/.cargo` rustup toolchain + registry on this box (runner shares it).
- GitHub token for API/curl at `$TMP/gh-token.txt` (scopes repo+workflow;
  NOT `read:org`, so `gh auth login` validation fails — use curl).
