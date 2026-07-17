#!/usr/bin/env bash
# Enable dogfood mode (audit + unknownLocalEffect deny) using the source-built CLI.
# Does not require `belay` on PATH.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

if ! grep -q '"name": "@guilz-dev/belay"' package.json 2>/dev/null; then
  echo "dev-dogfood: run from the belay repository root" >&2
  exit 1
fi

pnpm build

# Always use the freshly built local CLI to avoid version skew with global installs.
BELAY=(node dist/cli.js)

"${BELAY[@]}" dogfood
echo ""
"${BELAY[@]}" status

echo ""
echo "dev-dogfood: done"
echo "  next:     ${BELAY[*]} metrics          # after normal agent work"
echo "  enforce:  ${BELAY[*]} dogfood --enforce # when metrics recommend it"
