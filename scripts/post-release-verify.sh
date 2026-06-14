#!/usr/bin/env bash
# Post-release verification per docs/ops/releasing.md
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: post-release-verify.sh <version>

Example:
  post-release-verify.sh 0.0.2
EOF
  exit 2
}

[[ $# -eq 1 ]] || usage

VERSION="$1"
TAG="v${VERSION}"
PKG="@guilz-dev/belay"

failures=0

check() {
  local label="$1"
  shift
  echo "==> ${label}"
  if "$@"; then
    echo "==> ${label}: OK"
  else
    echo "==> ${label}: FAILED" >&2
    failures=$((failures + 1))
  fi
  echo ""
}

check "npm registry version" bash -c "
  published=\$(npm view ${PKG} version 2>/dev/null) &&
  [[ \"\${published}\" == \"${VERSION}\" ]]
"

check "npx invocation" bash -c "
  out=\$(npx -y ${PKG}@${VERSION} --version 2>&1) &&
  [[ \"\${out}\" == *\"${VERSION}\"* ]]
"

if command -v gh >/dev/null 2>&1; then
  check "GitHub release exists" gh release view "${TAG}" >/dev/null 2>&1
else
  echo "==> GitHub release: SKIP (gh not installed)" >&2
fi

if [[ $failures -gt 0 ]]; then
  echo "post-release-verify: ${failures} check(s) failed" >&2
  exit 1
fi

echo "post-release-verify: all checks passed"
