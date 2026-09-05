# Partner webapp — demo container
#
# Runs the Partner core + built SPA in a container so the webapp is usable
# from a host browser (e.g. `docker run -p 127.0.0.1:4390:4390`).
#
# Security posture (by design, PLAN.md §3/§4):
#   * DEMO MODE ONLY — in-memory DB, fake keychain, fake provider, no
#     secrets, no file roots. Set DEMO_MODE=1 (default) and never deploy
#     this image to shared networks as-is.
#   * The core binds 0.0.0.0 inside the container (demo-only allowance) so
#     a published port can reach it; live mode still refuses non-loopback.
#   * Pairing still gates the UI; the demo auto-pair endpoint is demo-only.
#   * For a live core (keys/files), run the shell on the user's own machine
#     or follow the Ship playbook's reverse-proxy pattern on your infra —
#     never this image.
#
# Build artifacts expected next to this Dockerfile (produced by the repo's
# bundle step): core-bundle.cjs + web/ (built SPA). Native modules are
# installed fresh here for linux-glibc (better-sqlite3 + @napi-rs/keyring
# prebuilds), so the image is independent of the build host's OS.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Native runtime deps (linux prebuilds — never copied from the build host).
RUN npm install --no-save --no-audit --no-fund \
    better-sqlite3@npm:better-sqlite3-multiple-ciphers@^13.0.3 @napi-rs/keyring@2 \
  && rm -rf /root/.npm

COPY core-bundle.cjs /app/core-bundle.cjs
COPY web /app/web

ENV HOST=0.0.0.0
ENV PORT=4390
ENV DEMO_MODE=1
ENV STATIC_DIR=/app/web

EXPOSE 4390
CMD ["node", "core-bundle.cjs"]
