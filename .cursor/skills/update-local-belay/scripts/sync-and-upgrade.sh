#!/usr/bin/env bash
# Sync origin/main and refresh project-local belay install from a source build.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if ! grep -q '"name": "@guilz-dev/belay"' package.json 2>/dev/null; then
  echo "sync-and-upgrade: not in the belay repository (package.json name mismatch)" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "sync-and-upgrade: working tree has uncommitted changes; resolve or stash before pulling main" >&2
  git status --short >&2
  exit 1
fi

OLD_SHA="$(git rev-parse HEAD)"

git fetch origin
git checkout main
git pull origin main

NEW_SHA="$(git rev-parse HEAD)"
if [ "$OLD_SHA" = "$NEW_SHA" ]; then
  echo "sync-and-upgrade: main already up to date ($NEW_SHA)"
else
  echo "sync-and-upgrade: main updated $OLD_SHA -> $NEW_SHA"
fi

pnpm install
pnpm build

if command -v belay >/dev/null 2>&1; then
  BELAY=(belay)
else
  BELAY=(node dist/cli.js)
fi

"${BELAY[@]}" upgrade --with-skill
"${BELAY[@]}" doctor
"${BELAY[@]}" --version

echo "sync-and-upgrade: done"
