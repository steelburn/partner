# shell/src-tauri — Tauri v2 app (source scaffold)

M0 scaffold — verify with cargo check once Rust is installed.
**NOT YET BUILDABLE HERE — parent verified toolchain absence** (no `cargo`,
no `rustup`, no `bun` on this machine; installs are out of scope for M0).

## What this is

A source-only Tauri v2 shell that hosts the Partner core sidecar:

- `src/main.rs` + `src/lib.rs` — on startup the shell spawns the core sidecar
  (`partner-core`, spawned via `tauri-plugin-shell`), waits for its loopback
  HTTP server, and shows a webview pointed at `http://127.0.0.1:4390`. The
  core child is killed on app exit. Real lifecycle/restart policy is M1+.
- `tauri.conf.json` — v2 schema; window targets the core-served loopback URL;
  `bundle.externalBin: ["binaries/partner-core"]` registers the sidecar;
  `createUpdaterArtifacts: true` prepares signed updater archives (the updater
  plugin itself is a later milestone).
- `capabilities/default.json` — minimal v2 capability for the main window.
- `binaries/README.md` — where the per-triple core binary must be dropped.
- `static-dist/` — vestigial placeholder so `tauri-build` can embed assets
  (the real frontend is served by core, not by Tauri).

## Toolchain steps (exact, for a machine with the toolchain)

```bash
# 1. Rust (if absent)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup toolchain install stable --profile minimal   # then: source "$HOME/.cargo/env"

# 2. Tauri CLI
cargo install tauri-cli --version "^2" --locked

# 3. Linux build deps (Debian/Ubuntu) — webkit2gtk 4.1, etc.
#    sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
#      libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# 4. Icons (required before check/build): drop a source PNG and run
cargo tauri icon path/to/app-icon.png        # writes src-tauri/icons/

# 5. Core sidecar binary (packaging per core/docs/spike-sidecar.md):
#    place the bundled-runtime artifact at
#    binaries/partner-core-$(rustc -vV | sed -n 's/host: //p')

# 6. Dev run (core must already be listening on 4390 — run it first):
npm run dev -w core        # terminal A (from repo root)
cargo tauri dev            # terminal B (from shell/src-tauri)

# 7. Validate the skeleton compiles:
cargo check                # from shell/src-tauri

# 8. Packaged build:
cargo tauri build          # emits installer + updater artifacts per target
```

## Open items for the cargo machine

- `cargo check` on this exact tree (first real validation of the scaffold).
- Race note: the config window may navigate before the sidecar binds; if the
  packaged app flashes a connection error, gate window creation behind
  `wait_for_core` (`WebviewWindowBuilder` after health, `windows: []` in
  config) — see `lib.rs`.
- Resource wiring for the bundled runtime: node binary as the sidecar +
  bundled JS / pruned `node_modules` under `bundle.resources`.

## Desktop run (after the container gate)

The gate container proves compile + webview boot headlessly. On a real
desktop (with a display), the full path is:

```bash
# 1. system deps once (Ubuntu 24.04)
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev \
  libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# 2. build the core sidecar artifact + run the shell (two terminals)
npm run dev:core                              # core on :4390 (demo)
# OR run the headless gate: shell/docker/gate/run.sh inside partner-gate

# 3. build & run the shell WITHOUT its own sidecar spawn (core is up)
cd src-tauri && CARGO_TARGET_DIR=/tmp/pt cargo build
PARTNER_NO_SIDECAR=1 /tmp/pt/debug/partner-shell

# Real sidecar wiring (packaged app): replace the dummy
# binaries/partner-core-<triple> with the SEA/bundled-node artifact, drop
# PARTNER_NO_SIDECAR, then `cargo tauri build` on the desktop machine.
```
Caveats recorded by the gate run: bundle-safe `import.meta` handling in the
core (entry guard, catalog dir, worker path); strict-JSON tauri config +
capabilities; icons required by tauri-build.
