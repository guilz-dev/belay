#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: scripts/pre-release-dogfood-check.sh <target-dir> <since-iso>" >&2
  exit 1
fi

target_dir="$1"
since_iso="$2"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

pnpm build
node dist/cli.js dogfood --check --target "$target_dir" --since "$since_iso"
