# Partner — demo webapp container

Runs the Partner **core + built SPA** in a container so the webapp is
usable from a browser on the host machine:

```bash
docker run -d --name partner-webapp-demo \
  -p 127.0.0.1:4390:4390 \
  partner-webapp-demo
# open http://127.0.0.1:4390 — pair via "Get demo pairing code"
```

Build the image with `./stage.sh` (Linux/macOS) or `.\stage.ps1`
(Windows) from this folder — each script builds the SPA, bundles the core
with esbuild (natives external), copies the static dist into the context,
then runs `docker build -t partner-webapp-demo .`. Stop with
`docker rm -f partner-webapp-demo`.

## What this proves

Same product the Tauri shell launches, minus the shell: pairing gate, chat,
personas, memory, notes/plans, skills, playbooks, theming — all against a
core inside the container (in-memory DB; state resets on restart).

## Security posture — read before using

- **Demo mode only, by design.** `DEMO_MODE=1` → in-memory DB, fake
  keychain, fake provider, no secrets, no file roots. The core allows a
  non-loopback bind (`HOST=0.0.0.0`) **only in demo mode** so a published
  port can reach it; live mode still refuses any non-loopback host
  (`core/src/config.ts`). Never run this image on a shared network.
- **One browser at a time in practice.** Session/origin allowlists stay
  loopback-derived, so the UI is reached as `127.0.0.1:4390` from the host
  machine. Exposing the webapp beyond one machine (LAN/remote core, real
  providers, keychain passthrough, file-root mounts) is deliberate
  security-model work — PLAN.md §3/§13 + the M10 hardening milestone — not
  a flag flip on this image.
- Native modules (`better-sqlite3`, `@napi-rs/keyring`) are installed
  fresh inside the image as linux-glibc prebuilds — never copied from a
  Windows/macOS build host.

## Layout

- `Dockerfile` — node:22-slim runtime (better-sqlite3-multiple-ciphers prebuilds cover node >= 22); expects `core-bundle.cjs` + `web/`
  in the build context (staged by the scripts, gitignored).
- `stage.sh` / `stage.ps1` — build web, bundle core, stage, `docker build`.
