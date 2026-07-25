#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir/ops"

if [[ ! -x "$repo_dir/target/release/nightfrost" ]]; then
  echo "Missing target/release/nightfrost; run ops/build-linux.sh first." >&2
  exit 1
fi

binary_format=$(file -b "$repo_dir/target/release/nightfrost")
if [[ "$binary_format" != *"ELF 64-bit"* || "$binary_format" != *"x86-64"* ]]; then
  echo "Wrong binary format for production: $binary_format" >&2
  echo "Build a Linux x86_64 binary with ops/build-linux.sh." >&2
  exit 1
fi

if [[ ! -f "$repo_dir/examples/explorer/dist/index.html" ]]; then
  echo "Missing explorer build at examples/explorer/dist/index.html." >&2
  echo "Build it with ops/build-explorer.sh." >&2
  exit 1
fi

exec ansible-playbook playbooks/site.yml --ask-vault-pass "$@"
