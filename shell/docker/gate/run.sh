#!/usr/bin/env bash
# Packaged-app gate: stage Tauri resources -> build the shell -> boot the
# bundled core artifact headlessly -> real-sidecar webview smoke under Xvfb.
# Runs INSIDE the partner-gate container (repo mounted at /workspace).
set -euo pipefail
REPO=/workspace
SHELL_DIR="$REPO/shell"
TAURI_DIR="$SHELL_DIR/src-tauri"
ART="$SHELL_DIR/artifacts"
RES="$TAURI_DIR/resources"
TARGET=/target-cache
TRIPLE=x86_64-unknown-linux-gnu
mkdir -p "$ART" "$TARGET"
echo "[gate] rust: $(rustc --version)  node: $(node --version)"

# 1) Sidecar placeholder (node runtime binary) + staged resources BEFORE
#    cargo build so tauri-build embeds them from the resources glob.
cp "$(command -v node)" "$TAURI_DIR/binaries/partner-core-$TRIPLE"
chmod +x "$TAURI_DIR/binaries/partner-core-$TRIPLE"
rm -rf "$RES"; mkdir -p "$RES/node_modules" "$RES/skills-catalog"
cp "$ART/core-bundle.cjs" "$RES/"
cp -r "$ART/node_modules/." "$RES/node_modules/"
cp -r "$REPO/web/dist" "$RES/web-dist"
cp "$REPO/skills-catalog/hello-skill" -r "$RES/skills-catalog/" 2>/dev/null || true

echo "[gate] cargo build partner-shell (debug)…"
export CARGO_BUILD_JOBS=2
cd "$TAURI_DIR"
CARGO_TARGET_DIR="$TARGET" cargo build 2>&1 | tail -3
SHELL_BIN="$TARGET/debug/partner-shell"
ls -la "$SHELL_BIN"

# 2) Headless core-artifact boot (sanity for the bundled core itself).
echo "[gate] boot core artifact (headless)…"
cd "$ART"
PORT=4391 DEMO_MODE=1 HOST=127.0.0.1 STATIC_DIR="$REPO/web/dist" \
  SKILLS_CATALOG_DIR="$REPO/skills-catalog" SKILLS_DIR=/tmp/gate-skills \
  node core-bundle.cjs >"$ART/gate-core.log" 2>&1 &
CORE_PID=$!
trap 'kill $CORE_PID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf http://127.0.0.1:4391/v1/health >/dev/null 2>&1 && break; sleep 0.5; done
echo "[gate] artifact health: $(curl -s http://127.0.0.1:4391/v1/health)"
kill "$CORE_PID" 2>/dev/null || true
trap - EXIT

# 3) Real-sidecar webview smoke under Xvfb: the shell spawns the sidecar
#    itself (node + staged resources) — no PARTNER_NO_SIDECAR.
echo "[gate] webview smoke (Xvfb, real sidecar)…"
Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 1
export DISPLAY=:99
rm -f "$ART/gate-shell.log" "$ART/gate-gui-core.log"
PARTNER_CORE_BUNDLE="$RES/core-bundle.cjs" PARTNER_STATIC_DIR="$RES/web-dist" \
  "$SHELL_BIN" >"$ART/gate-shell.log" 2>&1 &
SHELL_PID=$!
for i in $(seq 1 80); do curl -sf http://127.0.0.1:4390/v1/health >/dev/null 2>&1 && break; sleep 0.5; done
sleep 8
echo "[gate] sidecar health: $(curl -s http://127.0.0.1:4390/v1/health)"
echo "[gate] sidecar GET / -> $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4390/)"
import -display :99 -window root "$ART/gate-shot.png" 2>/dev/null || \
  xwd -display :99 -root -out "$ART/gate-shot.xwd" 2>/dev/null || true
kill "$SHELL_PID" "$XVFB_PID" 2>/dev/null || true
ls -la "$ART/gate-shot.png" 2>/dev/null || echo "[gate] no screenshot captured"
echo "[gate] DONE"
