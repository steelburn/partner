# Partner on Windows — build & run the .exe

Status: **runbook (toolchain is Windows-only; verified-equivalent on Linux via
`shell/docker/gate`)**. The desktop shell (`partner-shell`) is plain Tauri v2
Rust and the core is pure Node ≥ 18, so Windows is fully supported. Nothing
here has been executed on a real Windows machine yet — treat it as the
canonical steps + the places that will need one tweak each.

## Prerequisites (one-time)

1. **Rust (MSVC):** install from <https://rustup.rs> with the default
   `stable-x86_64-pc-windows-msvc` toolchain.
2. **VS Build Tools 2022** — Workload "Desktop development with C++" (Tauri
   links against MSVC; MinGW is not supported).
3. **WebView2 Runtime** — preinstalled on Windows 10/11.
4. Node.js ≥ 20 (LTS) + npm.

## Build steps (PowerShell, repo root)

```powershell
# 0) Install deps + the Tauri CLI (prebuilt binary, used for icons/build)
npm install
npm install -D @tauri-apps/cli            # adds it to shell toolchain only

# 1) Real icons (the checked-in ones are Linux gate placeholders)
npx tauri icon .\src-tauri\icons\icon-src.png
#    ^ run from shell/ — regenerates icons/ incl. a real .ico for Windows

# 2) Build the core sidecar artifact (native deps must be Windows builds —
#    installing on Windows fetches win32-x64 prebuilds automatically)
node node_modules/esbuild/bin/esbuild core/src/index.ts --bundle `
  --platform=node --format=cjs --target=node18 `
  --external:better-sqlite3 --external:@napi-rs/keyring `
  --outfile=shell/artifacts/core-bundle.cjs
npm install --prefix shell/artifacts better-sqlite3@13 @napi-rs/keyring@2

# 3) Build the web UI (served by the core)
npm run build -w web

# 4) Sidecar placeholder (the node runtime binary, renamed per Tauri triple)
Copy-Item (Get-Command node).Source `
  shell/src-tauri/binaries/partner-core-x86_64-pc-windows-msvc.exe

# 5) Compile the shell
cd shell/src-tauri
cargo build
```

## Run (two-process dev, like the Linux gate)

```powershell
# T1 — core artifact on :4390 (demo)
$env:PORT='4390'; $env:DEMO_MODE='1'
node ..\..\shell\artifacts\core-bundle.cjs

# T2 — the shell (it spawns the sidecar itself with the env below)
$env:PARTNER_CORE_BUNDLE = '..\..\shell\artifacts\core-bundle.cjs'
$env:PARTNER_STATIC_DIR  = '..\..\web\dist'
.\target\debug\partner-shell.exe
```

`partner-shell.exe` opens the Partner UI (core already bound by the bundle —
the shell only verifies the port and paints the webview). A standalone
single-file installer that embeds the core needs the Tauri **resources
embedding** step resolved first (see "Open item" below).

## Installer (`.msi` / `.exe` setup)

```powershell
npx tauri build          # run from shell/ — produces target/release/partner-shell.exe
                         # plus NSIS .exe / MSI installers under target/release/bundle/
```

**Open item before the installer is self-contained:** `bundle.resources` was
removed because tauri-build's glob base could not be resolved headlessly in
the Linux gate container. On the Windows machine, stage
`src-tauri/resources/{core-bundle.cjs, node_modules, web-dist}` **before**
`cargo build` and restore `"resources": ["resources/**"]` in `tauri.conf.json`
— then confirm the build script stops warning (`glob pattern … not found`) and
that `partner-shell.exe` runs **without** the `PARTNER_CORE_BUNDLE` env. That
is the one remaining packaging task; everything else in this file is expected
to work as written.

## Gotchas

- Windows Defender may flag the unsigned debug `.exe` — add an exclusion or
  sign later.
- Keyring on Windows = DPAPI via `@napi-rs/keyring` (works; first unlock is
  silent).
- The dummy sidecar `partner-core-x86_64-pc-windows-msvc.exe` is just `node`
  renamed — fine for dev; the real SEA/bundled core replaces it for release.
- `shell/docker/gate` is Linux-only (container toolchain); on Windows use the
  steps above natively.
