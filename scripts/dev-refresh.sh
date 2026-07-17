#!/usr/bin/env bash
# Rebuild, refresh project-local hooks/runtime from source, and enable dogfood mode.
# Does not pull main — use .cursor/skills/update-local-belay/scripts/sync-and-upgrade.sh for that.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

if ! grep -q '"name": "@guilz-dev/belay"' package.json 2>/dev/null; then
  echo "dev-refresh: run from the belay repository root" >&2
  exit 1
fi

pnpm install
pnpm build

# Always use the freshly built local CLI to avoid version skew with global installs.
BELAY=(node dist/cli.js)

"${BELAY[@]}" upgrade --with-skill
"${BELAY[@]}" dogfood
echo ""
"${BELAY[@]}" doctor
echo ""
"${BELAY[@]}" status

echo ""
echo "dev-refresh: done"
echo "  sync main: .cursor/skills/update-local-belay/scripts/sync-and-upgrade.sh"
