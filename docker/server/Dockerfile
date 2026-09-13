# Partner — LIVE server container (M21)
#
# Runs the Partner core + built SPA headless, in LIVE mode (persistent encrypted
# database, real providers, real scheduling), and reaches the internet only
# through a Cloudflare Tunnel sidecar (see docker-compose.yml).
#
# Security posture:
#   * DEMO_MODE=0 — real keychain, real DB, no demo auto-pair seam.
#   * KEYCHAIN_KIND=file — the container/headless keychain kind, because there is
#     no OS keyring daemon in here. The JSON secrets file holds the database
#     cipher key: it must live on a volume and be treated as the crown jewel it
#     is (see docker/server/README.md).
#   * REMOTE_ACCESS=1 + TLS files + a NAMED ALLOWED_HOSTS — the S6 matrix. The
#     core refuses to boot in remote mode without all three, so a misconfigured
#     deployment fails loudly instead of serving plaintext.
#   * AUTH_MODE=login (M22) — this image is the REMOTE-HOSTED shape, so clients
#     authenticate with a user passphrase instead of the desktop pairing
#     ceremony, and the pairing routes are closed. Account management is the
#     operator CLI: `docker compose exec partner node tools/user.mjs add <name>`.
#   * FIXED_ROOTS=/files (M22) — the deployment owns what the file tools can
#     see. Mount a volume there; `/v1/roots` refuses add/remove.
#   * No published port: the compose file does not map 4390 to the host, so the
#     tunnel sidecar is the only way in. Adding `ports:` would expose the core
#     directly and would ALSO break pairing (see the README's topology note).
#   * Runs as the unprivileged `node` user.
#
# Build via ./stage.sh (Linux/macOS) or .\stage.ps1 (Windows): it builds the SPA,
# bundles the core, stages the static dist and generates an origin certificate.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Native runtime deps installed FRESH for linux-glibc (better-sqlite3 +
# @napi-rs/keyring prebuilds) — never copied from a Windows/macOS build host.
RUN npm install --no-save --no-audit --no-fund \
      better-sqlite3@npm:better-sqlite3-multiple-ciphers@^13.0.3 @napi-rs/keyring@2 \
  && rm -rf /root/.npm

COPY core-bundle.cjs /app/core-bundle.cjs
COPY web /app/web
COPY skills-catalog /app/skills-catalog
COPY tools /app/tools

# Runtime state: the encrypted DB, its cipher key, installed skills. Owned by
# the runtime user so a named volume inherits that ownership on first use.
RUN mkdir -p /data /files && chown -R node:node /data /files /app/tools
VOLUME ["/data", "/files"]

ENV HOST=0.0.0.0 \
    PORT=4390 \
    DEMO_MODE=0 \
    STATIC_DIR=/app/web \
    SKILLS_CATALOG_DIR=/app/skills-catalog \
    KEYCHAIN_KIND=file \
    KEYCHAIN_FILE=/data/keychain.json \
    DB_PATH=/data/partner.db \
    DATA_ROOT=/data \
    FIXED_ROOTS=/files \
    AUTH_MODE=login \
    REMOTE_ACCESS=1 \
    TLS_CERT_FILE=/certs/origin.crt \
    TLS_KEY_FILE=/certs/origin.key

EXPOSE 4390
USER node

# The healthcheck talks HTTPS to the loopback listener with the allowlisted host
# as SNI/Host — i.e. it proves the SAME path a tunnel request takes, including
# the host allowlist and the certificate. A misconfigured ALLOWED_HOSTS fails
# here rather than quietly 403-ing every browser request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "/app/tools/healthcheck.mjs"]

CMD ["node", "core-bundle.cjs"]
