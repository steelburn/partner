# Partner on Windows — build, bundle & run the .exe

> Handoff & Windows runbook: `docs/HANDOFF-WINDOWS.md`.
> Verified on a real Windows 11 machine + self-hosted runner (2026-09-05):
> the NSIS installer builds green in CI and the installed `partner-shell.exe`
> boots the core sidecar with NO environment variables.

## Status

**Executed and verified end-to-end.** `.github/workflows/windows-build.yml`
(stages resources → `npm ci` native rebuild → esbuild core bundle → `tauri
build --bundles nsis`) is green on the self-hosted Windows runner
(`win-intel-i5-core-ultra`, label `[self-hosted, Windows]`). The uploaded
`partner-windows` artifact contains `partner-shell.exe`, the
`Partner_0.0.0_x64-setup.exe` NSIS installer, and the core bundle. Silent
install (`setup.exe /S`) then launching `partner-shell.exe` with an empty env
starts the core on `127.0.0.1:4390` (`demo=on schema=v11`).

## Prerequisites (one-time, per machine)

1. **VS Build Tools 2022** — workload **"Desktop development with C++"**
   (MSVC 14.4x + Windows SDK). Verified: vswhere must answer
   `-requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64`. `cl.exe` is
   NOT on PATH — node-gyp/cargo discover it via vswhere.
2. **Rust** — `stable-x86_64-pc-windows-msvc` (CI: `dtolnay/rust-toolchain`;
   locally: rustup).
3. **Node 22 + npm** (the SQLCipher-fork prebuilds need node ≥ 22).
4. **WebView2 Runtime** — preinstalled on Windows 10/11.
5. **Smart App Control OFF** (Windows Security → App & browser control).
   SAC blocks unsigned cargo build scripts (`os error 4551`) —
   intermittent, heuristic, and fatal for any native compile.
6. **Git for Windows first on PATH** for the runner. `bash`-using actions
   (e.g. `dtolnay/rust-toolchain`) otherwise resolve the WindowsApps WSL shim
   and die with `CreateProcessCommon: execvpe(/bin/bash) failed`.
   Restart the runner after changing PATH.

## Build (CI, from the repo root)

```powershell
# Self-hosted runner only. Dispatch: Actions -> windows-build
# (or `POST .../actions/workflows/windows-build.yml/dispatches`).
npm ci                              # rebuilds aliased better-sqlite3 (MSVC)
npm run build -w web                # web/dist
npx esbuild core/src/index.ts --bundle --platform=node --format=cjs `
  --target=node18 --external:better-sqlite3 --external:@napi-rs/keyring `
  --outfile=shell/artifacts/core-bundle.cjs
npm install --prefix shell/artifacts `
  better-sqlite3@npm:better-sqlite3-multiple-ciphers@^13.0.3 @napi-rs/keyring@2
rem Sidecar = bundled node, renamed per Tauri triple:
for /f "delims=" %i in ('where node') do copy /y "%i" `
  shell\src-tauri\binaries\partner-core-x86_64-pc-windows-msvc.exe
rem Stage the self-contained tree tauri embeds (see "resources" below):
xcopy /e /i /y shell\artifacts\core-bundle.cjs shell\src-tauri\resources\
xcopy /e /i /y shell\artifacts\node_modules  shell\src-tauri\resources\node_modules\
xcopy /e /i /y web\dist                  shell\src-tauri\resources\web-dist\
xcopy /e /i /y skills-catalog            shell\src-tauri\resources\skills-catalog\
cd shell
npx tauri build --bundles nsis
```

## Run (packaged)

Silent-install the NSIS output, then launch:

```powershell
.\Partner_0.0.0_x64-setup.exe /S
Start-Process "$env:LOCALAPPDATA\Partner\partner-shell.exe"
# Expect: core sidecar on 127.0.0.1:4390, "[shell] core is up",
# Tauri window at http://127.0.0.1:4390
```

`spawn_core` in `shell/src-tauri/src/lib.rs` resolves the staged tree from
`<resource_dir>/resources` (NSIS layout) **or** flat `resource_dir` (dev),
strips tauri's verbatim `\\?\` prefix (node's CJS loader cannot run a
`\\?\C:\...` main script — it lstat's `C:` and dies), then spawns the
`partner-core` sidecar with the bundle path + `PORT/HOST/STATIC_DIR/SKILLS_*`
env. Dev fallbacks `PARTNER_CORE_BUNDLE` / `PARTNER_STATIC_DIR` /
`PARTNER_NO_SIDECAR` still apply.

## resources: why it is a bare dir

`bundle.resources` in `tauri.conf.json` must be **`["resources"]`** (a bare
directory → tauri walks it), NOT `"resources/**"`: glob 0.3.4 matches
directories only for a trailing `/**`, so tauri-build reports
`glob pattern resources/** path not found or didn't match any files`
(GlobPathNotFound, zero *files*) even when the dir is full. NSIS then places
the walked tree under `<exe>/resources/…`, which is why `spawn_core` checks
both roots.

## Gotchas

- Windows Defender may flag the unsigned debug `.exe` — add an exclusion or
  sign later.
- Keyring on Windows = DPAPI via `@napi-rs/keyring` (works; first unlock is
  silent).
- The `partner-core` sidecar **is** the bundled Node runtime renamed per
  Tauri's per-triple convention (spike-sidecar.md) — it runs
  `resources/core-bundle.cjs`, which resolves `better-sqlite3` +
  `@napi-rs/keyring` from `resources/node_modules`.
- PowerShell execution policy is GPO-pinned on this machine — workflow steps
  use `shell: cmd`, not pwsh.
- `createUpdaterArtifacts` is `false` (no `tauri-plugin-updater` + no signing
  keys yet); signed updates are a post-M10 item.
