#!/usr/bin/env bash
# Partner server container (M21) — stage + build.
#
# Usage (from this folder):
#   cp .env.example .env      # then set PARTNER_HOST + TUNNEL_TOKEN
#   ./stage.sh                # build SPA + core bundle, cert, image
#   docker compose up -d
#
# Idempotent: re-running rebuilds the artifacts but never regenerates an
# existing origin certificate (that would break every already-paired device).
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

# The public hostname decides the certificate SAN and the default core URL.
HOST="${PARTNER_HOST:-}"
if [ -z "$HOST" ] && [ -f docker/server/.env ]; then
  HOST="$(grep -E '^PARTNER_HOST=' docker/server/.env | tail -1 | cut -d= -f2- | tr -d '\r')"
fi
if [ -z "$HOST" ]; then
  echo "PARTNER_HOST is not set. Copy docker/server/.env.example to .env and set it," >&2
  echo "or run: PARTNER_HOST=partner.example.com ./stage.sh" >&2
  exit 1
fi

echo "==> web bundle (vite)"
npm run build -w web

echo "==> core bundle (esbuild, natives external)"
npx --yes esbuild core/src/index.ts --bundle --platform=node --format=cjs \
  --target=node22 --external:better-sqlite3 --external:@napi-rs/keyring \
  --outfile=docker/server/core-bundle.cjs

echo "==> static + catalog staging"
rm -rf docker/server/web
cp -R web/dist docker/server/web
rm -rf docker/server/skills-catalog
cp -R skills-catalog docker/server/skills-catalog

echo "==> origin certificate for ${HOST}"
mkdir -p docker/server/secrets
# Reuse the certificate ONLY when it already covers the current hostname. A
# stale cert for a previous host is worse than none: the core's SAN check then
# refuses to boot ("certificate does not cover allowlisted host(s)") and the
# operator sees a restart loop instead of a certificate problem.
CERT_COVERS_HOST=0
if [ -f docker/server/secrets/origin.crt ] && [ -f docker/server/secrets/origin.key ]; then
  if openssl x509 -in docker/server/secrets/origin.crt -noout -checkhost "${HOST}" >/dev/null 2>&1; then
    CERT_COVERS_HOST=1
  else
    echo "    existing certificate does not cover ${HOST} — regenerating"
  fi
fi
if [ "$CERT_COVERS_HOST" = "1" ]; then
  echo "    existing certificate kept (delete docker/server/secrets to regenerate)"
else
  # Self-signed, valid as its own CA, SAN = the public hostname. The core serves
  # it; cloudflared either accepts it via "No TLS Verify" or is given this file
  # as its CA pool. Replace it with a Cloudflare Origin CA certificate for the
  # verified path — see README "TLS at the origin".
  #
  # The subject/SAN come from a CONFIG FILE rather than -subj/-addext arguments:
  # on Windows, MSYS/Git-Bash rewrites a leading `/CN=…` into a Windows path
  # ("C:/Program Files/Git/CN=…"), which makes openssl fail with a confusing
  # "subject name is expected to be in the format" error. A config file has no
  # such argument to rewrite, so this works the same in every shell.
  TMP_CERT="$(mktemp -d)"
  cat > "$TMP_CERT/openssl.cnf" <<CNF
[req]
prompt = no
distinguished_name = dn
x509_extensions = v3_req
[dn]
CN = ${HOST}
[v3_req]
subjectAltName = DNS:${HOST}
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign
CNF
  if openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
      -keyout "$TMP_CERT/origin.key" -out "$TMP_CERT/origin.crt" \
      -config "$TMP_CERT/openssl.cnf" 2>/dev/null; then
    mv "$TMP_CERT/origin.key" docker/server/secrets/origin.key
    mv "$TMP_CERT/origin.crt" docker/server/secrets/origin.crt
    chmod 600 docker/server/secrets/origin.key
    echo "    generated docker/server/secrets/origin.{crt,key} for ${HOST}"
  else
    rm -rf "$TMP_CERT"
    echo "    openssl failed — is OpenSSL installed? (Git for Windows ships one)" >&2
    exit 1
  fi
  rm -rf "$TMP_CERT"
fi

echo "==> docker compose build"
docker compose -f docker/server/docker-compose.yml build

cat <<EOF

Built. Next:
  1. In Cloudflare: Networks -> Tunnels -> your tunnel -> Public Hostname
       Subdomain/domain : the host part(s) of ${HOST}
       Service          : https://partner:4390
       TLS -> No TLS Verify: ON   (self-signed origin cert; see README to switch to a Cloudflare Origin CA cert and leave this off)
       HTTP -> HTTP Host Header: ${HOST}
  2. docker compose -f docker/server/docker-compose.yml up -d
  3. docker compose -f docker/server/docker-compose.yml exec partner node tools/pair-link.mjs
     ...then open the printed link on your phone/laptop.
EOF
