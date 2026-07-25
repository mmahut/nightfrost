#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
explorer_dir="$repo_dir/examples/explorer"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to build the Nightfrost explorer." >&2
  exit 1
fi

cd "$explorer_dir"
npm ci

VITE_NETWORKS='[{"name":"Preview","apiUrl":"https://preview.nightfrost.dev","color":"#f0b429"},{"name":"Mainnet","apiUrl":"https://mainnet.nightfrost.dev","color":"#34d399"},{"name":"Preprod","apiUrl":"https://preprod.nightfrost.dev","color":"#8fd0e4"}]' \
  npm run build

if [[ ! -f "$explorer_dir/dist/index.html" ]]; then
  echo "Explorer build did not produce examples/explorer/dist/index.html." >&2
  exit 1
fi

echo "Explorer build ready at $explorer_dir/dist"
