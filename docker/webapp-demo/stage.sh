#!/usr/bin/env bash
# Partner demo webapp container — stage + build (Linux/macOS).
# Usage: ./stage.sh   (from this folder; repo root is one level up)
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

npm run build -w web
npx --yes esbuild core/src/index.ts --bundle --platform=node --format=cjs \
  --target=node18 --external:better-sqlite3 --external:@napi-rs/keyring \
  --outfile=docker/webapp-demo/core-bundle.cjs
rm -rf docker/webapp-demo/web
cp -R web/dist docker/webapp-demo/web

docker build -t partner-webapp-demo docker/webapp-demo
echo "Built partner-webapp-demo. Run:"
echo "  docker run -d --name partner-webapp-demo -p 127.0.0.1:4390:4390 partner-webapp-demo"
