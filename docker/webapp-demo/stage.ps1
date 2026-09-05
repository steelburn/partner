# Partner demo webapp container — stage + build (Windows).
# Usage: .\stage.ps1   (from this folder; repo root is one level up)
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..\..'

Push-Location $root
try {
  npm run build -w web
  npx --yes esbuild core/src/index.ts --bundle --platform=node --format=cjs `
    --target=node18 --external:better-sqlite3 --external:@napi-rs/keyring `
    --outfile=docker/webapp-demo/core-bundle.cjs
  # Stage the SPA: web/ in the context must contain index.html at its root.
  $stageWeb = Join-Path $root 'docker\webapp-demo\web'
  Remove-Item -Recurse -Force $stageWeb -ErrorAction SilentlyContinue
  New-Item -ItemType Directory $stageWeb | Out-Null
  Copy-Item (Join-Path $root 'web\dist\*') $stageWeb -Recurse -Force
} finally {
  Pop-Location
}

docker build -t partner-webapp-demo docker/webapp-demo
Write-Host 'Built partner-webapp-demo. Run:'
Write-Host '  docker run -d --name partner-webapp-demo -p 127.0.0.1:4390:4390 partner-webapp-demo'
