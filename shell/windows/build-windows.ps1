# Partner for Windows — one-shot build/run helper.
# Prereqs: Rust (MSVC), VS Build Tools (C++ workload), Node >= 20, WebView2.
# Usage (repo root):  powershell -ExecutionPolicy Bypass -File shell/windows/build-windows.ps1 [-Run]
param([switch]$Run)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)  # repo root
Set-Location $root

Write-Host "==> npm install" -ForegroundColor Cyan
npm install
npm install -D @tauri-apps/cli

Write-Host "==> real icons" -ForegroundColor Cyan
Push-Location shell
npx tauri icon .\src-tauri\icons\icon-src.png
Pop-Location

Write-Host "==> bundle core artifact" -ForegroundColor Cyan
New-Item -ItemType Directory -Force shell/artifacts | Out-Null
node node_modules/esbuild/bin/esbuild core/src/index.ts --bundle `
  --platform=node --format=cjs --target=node18 `
  --external:better-sqlite3 --external:@napi-rs/keyring `
  --outfile=shell/artifacts/core-bundle.cjs
npm install --prefix shell/artifacts better-sqlite3@12.2.0 @napi-rs/keyring@2 | Out-Null

Write-Host "==> build web UI" -ForegroundColor Cyan
npm run build -w web

Write-Host "==> sidecar placeholder (renamed node)" -ForegroundColor Cyan
$node = (Get-Command node).Source
$trip = 'x86_64-pc-windows-msvc'
New-Item -ItemType Directory -Force "shell/src-tauri/binaries" | Out-Null
Copy-Item $node "shell/src-tauri/binaries/partner-core-$trip.exe" -Force

Write-Host "==> cargo build (shell)" -ForegroundColor Cyan
Set-Location shell/src-tauri
cargo build
$exe = "target/debug/partner-shell.exe"

if ($Run) {
  Write-Host "==> run (two terminals expected: this starts the shell; start the core bundle first in another terminal)" -ForegroundColor Cyan
  $env:PARTNER_CORE_BUNDLE = "$root/shell/artifacts/core-bundle.cjs"
  $env:PARTNER_STATIC_DIR  = "$root/web/dist"
  Write-Host "Start the core first:" -ForegroundColor Yellow
  Write-Host "  cd $root; `$env:PORT='4390'; `$env:DEMO_MODE='1'; node shell/artifacts/core-bundle.cjs"
  Write-Host "Launching shell..."
  & $exe
} else {
  Write-Host "Built: $exe" -ForegroundColor Green
  Write-Host "Run it with: powershell -File $($MyInvocation.MyCommand.Path) -Run"
}
