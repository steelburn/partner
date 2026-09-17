# Partner server container (M21) — stage + build (Windows).
#
# Usage (from this folder):
#   Copy-Item .env.example .env   # then set PARTNER_HOST + TUNNEL_TOKEN
#   .\stage.ps1
#   docker compose up -d
#
# Idempotent: re-running rebuilds the artifacts but never regenerates an
# existing origin certificate (that would break every already-paired device).
# Certificate generation needs OpenSSL on PATH (Git for Windows ships one).
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

$partnerHost = $env:PARTNER_HOST
$envFile = Join-Path $PSScriptRoot '.env'
if (-not $partnerHost -and (Test-Path $envFile)) {
  $line = Get-Content $envFile | Where-Object { $_ -match '^PARTNER_HOST=' } | Select-Object -Last 1
  if ($line) { $partnerHost = ($line -split '=', 2)[1].Trim() }
}
if (-not $partnerHost) {
  throw 'PARTNER_HOST is not set. Copy docker\server\.env.example to .env and set it, or run: $env:PARTNER_HOST="partner.example.com"; .\stage.ps1'
}

Write-Host '==> web bundle (vite)'
npm run build -w web

Write-Host '==> core bundle (esbuild, natives external)'
npx --yes esbuild core/src/index.ts --bundle --platform=node --format=cjs `
  --target=node22 --external:better-sqlite3 --external:@napi-rs/keyring `
  --outfile=docker/server/core-bundle.cjs

Write-Host '==> static + catalog staging'
Remove-Item -Recurse -Force docker/server/web -ErrorAction SilentlyContinue
Copy-Item -Recurse web/dist docker/server/web
Remove-Item -Recurse -Force docker/server/skills-catalog -ErrorAction SilentlyContinue
Copy-Item -Recurse skills-catalog docker/server/skills-catalog

# The skill worker harness is forked as its own process, so it is STAGED next to
# the bundle rather than bundled: in a bundled CJS artifact `import.meta.url` is
# empty and the runner resolves it as `$PWD/worker-runner.mjs` (WORKDIR /app).
Copy-Item core/src/skills/worker-runner.mjs docker/server/worker-runner.mjs -Force

Write-Host "==> origin certificate for $partnerHost"
$secrets = Join-Path $PSScriptRoot 'secrets'
New-Item -ItemType Directory -Force -Path $secrets | Out-Null
$crt = Join-Path $secrets 'origin.crt'
$key = Join-Path $secrets 'origin.key'
# Reuse the certificate ONLY when it covers the current hostname: a stale cert
# makes the core refuse to boot ("certificate does not cover allowlisted host(s)")
# and the operator sees a restart loop instead of a certificate problem.
$covers = $false
if ((Test-Path $crt) -and (Test-Path $key)) {
  openssl x509 -in $crt -noout -checkhost $partnerHost *> $null
  $covers = ($LASTEXITCODE -eq 0)
  if (-not $covers) { Write-Host "    existing certificate does not cover $partnerHost - regenerating" }
}
if ($covers) {
  Write-Host '    existing certificate kept (delete docker\server\secrets to regenerate)'
} else {
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 `
    -keyout $key -out $crt `
    -subj "/CN=$partnerHost" `
    -addext "subjectAltName=DNS:$partnerHost" `
    -addext "basicConstraints=critical,CA:TRUE" `
    -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign"
  # Best effort: Windows ACLs are inherited from the parent directory.
  try { icacls $key /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null } catch {}
  Write-Host "    generated docker\server\secrets\origin.{crt,key} for $partnerHost"
}

Write-Host '==> docker compose build'
docker compose -f docker/server/docker-compose.yml build

Write-Host @"

Built. Next:
  1. In Cloudflare: Networks -> Tunnels -> your tunnel -> Public Hostname
       Service          : https://partner:4390
       TLS -> No TLS Verify: ON   (self-signed origin cert; see README to switch to a Cloudflare Origin CA cert)
       HTTP -> HTTP Host Header: $partnerHost
  2. docker compose -f docker/server/docker-compose.yml up -d
  3. docker compose -f docker/server/docker-compose.yml exec partner node tools/pair-link.mjs
     ...then open the printed link on your phone/laptop.
"@
