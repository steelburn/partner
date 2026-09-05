# Partner — Windows CI handoff & project state

**Purpose:** everything an agent needs to continue from a **Windows machine,
cloning `github.com/steelburn/partner`**, plus a full project status snapshot
so no local-only context is lost. Refreshed 2026-09-05 (Windows CI green).

## TL;DR

- Product milestones **M0–M9 are complete and verified** (fresh-context
  reviews closed; exit checklists ticked). **M10 (Hardening & alpha) is
  implemented: W1 encryption-at-rest, W2 redaction sweep, W3 budgets, W4
  audit UI, W5 session-only chat, W6 packaging — all done and reviewed
  (findings F1–F9 closed).** Remaining M10: PLAN tick + this handoff.
- **Windows desktop CI is GREEN.** `verify` runs on the self-hosted Linux +
  Windows runners (`win-intel-i5-core-ultra`, label `[self-hosted, Windows]`)
  and passes end-to-end on both. `windows-build` produces the NSIS installer;
  the **installed app boots env-free** (core on `127.0.0.1:4390`,
  `demo=on schema=v11`).
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
                   audit log w/ redaction)
web/               React SPA (Vite; Audit tab, session-only chat, budget UI)
extension/         MV3 extension (native-messaging bridge) + README runbook
shared/src/        wire contracts (schema v11), theme tokens, redaction
tests/             cross-cutting e2e (spawn real demo core; audit, playbooks)
PLAN.md + PLAN-M0..M10.md             milestone specs (M10 = current)
skills-catalog/    local skills (hello-skill, note-echo, files-preview)
docker/webapp-demo/  demo container (node:22-alpine; core bundle + web/dist)
docs/              VERIFY-M10.md checklist, redaction-inventory, migrate-plaintext
```

## Verification commands (all green locally + on CI)

```bash
npx vitest run                 # root suite (~582 tests)
(cd web && npx vitest run)     # web suite (~422)
npx vitest run --config extension/vitest.config.ts   # (~54)
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
| M10 W6 packaging | ✅ windows-build green; NSIS installer boots env-free (demo=on, schema v11) |
| M10 W7 verify docs | ⚠️ VERIFY-M10.md written; PLAN-M10 final tick in progress |
| CI | 🟢 verify: linux + windows legs green on self-hosted runners; windows-build green (dispatch) |
| Env-gated by design | Chrome click-through (extension), live ship deploys, email/presentation sending, browser-driven research search, signed updater artifacts |

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
