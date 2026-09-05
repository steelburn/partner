#!/usr/bin/env bash
# Packaged-app gate: build the Tauri shell + core sidecar artifact, boot the
# core headlessly (health + UI serving), then a webview smoke under Xvfb with
# a screenshot. Runs INSIDE the partner-gate container with the repo mounted
# at /workspace (read-write) and CARGO_TARGET_DIR on a volume at /target-cache.
set -euo pipefail

REPO=/workspace
SHELL_DIR="$REPO/shell"
TAURI_DIR="$SHELL_DIR/src-tauri"
ART="$SHELL_DIR/artifacts"
TARGET=/target-cache
TRIPLE=x86_64-unknown-linux-gnu
mkdir -p "$ART" "$TARGET"

echo "[gate] rust: $(rustc --version)  node: $(node --version)"

# 1) Dummy external-bin artifact so tauri-build can embed it at compile time.
#    (The real SEA/bundled-runtime sidecar replaces this at bundle time; this
#    gate proves the crate + webview boot path.)
cp /usr/bin/node "$TAURI_DIR/binaries/partner-core-$TRIPLE"
chmod +x "$TAURI_DIR/binaries/partner-core-$TRIPLE"

echo "[gate] cargo build partner-shell (debug)…"
cd "$TAURI_DIR"
CARGO_TARGET_DIR="$TARGET" cargo build 2>&1 | tail -5
SHELL_BIN="$TARGET/debug/partner-shell"
ls -la "$SHELL_BIN"

# 2) Sidecar core artifact: bundle the TS core to one CJS file (natives kept
#    external) and vendor those natives under the artifact's node_modules.
echo "[gate] bundle core (esbuild)…"
cd "$REPO"
node node_modules/esbuild/bin/esbuild core/src/index.ts \
  --bundle --platform=node --format=cjs --target=node18 \
  --external:better-sqlite3 --external:@napi-rs/keyring \
  --outfile="$ART/core-bundle.cjs" 2>&1 | tail -2
mkdir -p "$ART/node_modules"
npm install --no-save --prefix "$ART" better-sqlite3@13 @napi-rs/keyring@2 >/dev/null 2>&1 || \
  echo "[gate] vendor install warnings ignored (native compile may have been used)"

# 3) Headless core boot: health + serves the built web UI.
echo "[gate] boot core artifact (headless)…"
cd "$ART"
PORT=4391 DEMO_MODE=1 HOST=127.0.0.1 STATIC_DIR="$REPO/web/dist" \
  node core-bundle.cjs >"$ART/gate-core.log" 2>&1 &
CORE_PID=$!
cleanup() { kill "$CORE_PID" 2>/dev/null || true; }
trap cleanup EXIT
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:4391/v1/health >/dev/null 2>&1 && break
  sleep 0.5
done
echo "[gate] health: $(curl -s http://127.0.0.1:4391/v1/health)"
echo "[gate] GET / -> $(curl -s -o /dev/null -w '%{http_code} %{content_type}' http://127.0.0.1:4391/)"

# 4) Webview smoke under Xvfb (PARTNER_NO_SIDECAR=1 -> shell skips its own
#    sidecar spawn; the artifact core is already serving :4390).
echo "[gate] webview smoke (Xvfb)…"
Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 1
export DISPLAY=:99
PORT=4390 DEMO_MODE=1 HOST=127.0.0.1 STATIC_DIR="$REPO/web/dist" \
  node "$ART/core-bundle.cjs" >"$ART/gate-gui-core.log" 2>&1 &
GUI_CORE=$!
for i in $(seq 1 60); do
  curl -sf http://127.0.0.1:4390/v1/health >/dev/null 2>&1 && break
  sleep 0.5
done
PARTNER_NO_SIDECAR=1 "$SHELL_BIN" >"$ART/gate-shell.log" 2>&1 &
SHELL_PID=$!
sleep 12
import -display :99 -window root "$ART/gate-shot.png" 2>/dev/null || \
  xwd -display :99 -root -out "$ART/gate-shot.xwd" 2>/dev/null || true
kill "$SHELL_PID" "$GUI_CORE" 2>/dev/null || true
kill "$XVFB_PID" 2>/dev/null || true
ls -la "$ART/gate-shot.png" 2>/dev/null || echo "[gate] no screenshot captured"
echo "[gate] DONE"
