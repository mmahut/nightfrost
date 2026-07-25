#!/usr/bin/env bash
set -euo pipefail

# Production is Fedora/Linux x86_64. This must run on a native x86_64 Linux
# builder: the release build includes aws-lc-sys x86 assembly, which is not
# reliable under Docker's amd64-on-Apple-Silicon emulation.
repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "This build must run on native Linux x86_64." >&2
  echo "The aws-lc-sys release assembly cannot be compiled reliably under" >&2
  echo "Apple Silicon Docker emulation. Use the production host or another" >&2
  echo "native Linux x86_64 builder, then copy target/release/nightfrost here." >&2
  exit 1
fi

(cd "$repo_dir" && cargo build --release)

file "$repo_dir/target/release/nightfrost"
