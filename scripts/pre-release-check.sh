#!/usr/bin/env bash
# Pre-release verification per docs/ops/releasing.md
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

run_step() {
  local label="$1"
  shift
  echo "==> ${label}"
  "$@"
  echo "==> ${label}: OK"
}

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "pre-release-check: working tree is not clean" >&2
  echo "  Commit or stash changes before release verification." >&2
  git status --short >&2
  exit 1
fi

run_step "sync package version" node scripts/sync-version.mjs

pkg_version="$(node -p "require('./package.json').version")"
src_version="$(node --input-type=module -e "import { PACKAGE_VERSION } from './src/version.ts'; console.log(PACKAGE_VERSION)")"
if [[ "${pkg_version}" != "${src_version}" ]]; then
  echo "pre-release-check: package.json version (${pkg_version}) != src/version.ts (${src_version})" >&2
  exit 1
fi

run_step "pnpm lint" pnpm lint
run_step "pnpm typecheck" pnpm typecheck
run_step "pnpm test:stable" pnpm test:stable
run_step "pnpm corpus" pnpm corpus
run_step "pnpm build" pnpm build
run_step "check CLI version" node scripts/check-cli-version.mjs
run_step "npm pack --dry-run" npm pack --dry-run

echo ""
echo "pre-release-check: all steps passed"
