#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ARTIFACT_DIR="$ROOT/artifacts/quality-loop"
REPORT_PATH=""
RUN_FULL=true
WITH_TESTS=false
VERIFY=false
PROBE_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  ./scripts/quality-loop-session.sh [--full] [--with-tests] [--verify] [-- <probe args>]
  ./scripts/quality-loop-session.sh --report <artifacts/quality-loop/iteration-*.json>

Modes:
  --full        Run evaluate + probe + diagnose (default)
  --with-tests  Also run `pnpm test` after structural suite (EVALUATE)
  --verify      Also run `pnpm test:stable` after diagnose (VERIFY)
  --report      Diagnose from an existing probe artifact only

Probe arguments (e.g. --strict --seed 42) pass through after `--`.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --report)
      REPORT_PATH="${2:-}"
      RUN_FULL=false
      shift 2
      ;;
    --full)
      RUN_FULL=true
      shift
      ;;
    --with-tests)
      WITH_TESTS=true
      shift
      ;;
    --verify)
      VERIFY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      PROBE_ARGS+=("$@")
      break
      ;;
    *)
      if [[ "$RUN_FULL" == true ]]; then
        PROBE_ARGS+=("$1")
      fi
      shift
      ;;
  esac
done

diagnose_report() {
  local report="$1"
  REPORT_PATH="$report" node <<'SCRIPT'
const fs = require('node:fs');
const reportPath = process.env.REPORT_PATH;
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

function pct(value) {
  return value === null || value === undefined ? 'n/a' : (value * 100).toFixed(1) + '%';
}

console.log('Probe summary:');
console.log('  batchId:', report.batchId);
console.log('  seed:', report.seed);
console.log('  fixSetFnRate:', pct(report.fixSetFnRate));
console.log('  firstPassFnRate:', pct(report.firstPassFnRate));
console.log('  firstPassFpRate:', pct(report.firstPassFpRate));
console.log('  holdoutFnRate:', report.holdoutFnRate === null || report.holdoutFnRate === undefined
  ? 'n/a (holdout empty)'
  : pct(report.holdoutFnRate));
console.log('  holdoutFixFnRateRatio:', report.holdoutFixFnRateRatio === null || report.holdoutFixFnRateRatio === undefined
  ? 'n/a'
  : report.holdoutFixFnRateRatio.toFixed(2));
console.log('  failures (FN):', report.failures.length);
console.log('  fpFailures:', (report.fpFailures || []).length);

for (const failure of (report.failures || []).slice(0, 20)) {
  console.log('  - FN', failure.mutatorId, JSON.stringify(failure.command), '=>', failure.actual, '(' + failure.reason + ')');
  console.log('    explain: belay explain --command', JSON.stringify(failure.command));
}

for (const failure of (report.fpFailures || []).slice(0, 10)) {
  console.log('  - FP', failure.mutatorId, JSON.stringify(failure.command), '=>', failure.actual, '(' + failure.reason + ')');
  console.log('    explain: belay explain --command', JSON.stringify(failure.command));
}

if (report.failures.length > 0) {
  console.log('');
  console.log('Next: fix classifier, re-run with holdout, then corpus-ratchet --dry-run.');
} else {
  console.log('');
  console.log('No FN failures. Dry-run ratchet with:');
  console.log('  pnpm corpus:ratchet -- --report', reportPath);
}
console.log('');
console.log('Simulate is triage-only (not a merge gate). See docs/quality-loop-playbook.ja.md');
SCRIPT
}

if [[ "$RUN_FULL" == false ]]; then
  if [[ -z "$REPORT_PATH" || ! -f "$REPORT_PATH" ]]; then
    echo "Missing or invalid --report path." >&2
    usage
    exit 1
  fi
  echo "== Quality loop session (diagnose from artifact) =="
  echo ""
  diagnose_report "$REPORT_PATH"
  exit 0
fi

echo "== Quality loop session (detect + diagnose) =="
echo ""

step=1
total=4
[[ "$WITH_TESTS" == true ]] && total=$((total + 1))
[[ "$VERIFY" == true ]] && total=$((total + 1))

echo "$step/$total Corpus evaluation"
pnpm corpus
step=$((step + 1))

echo ""
echo "$step/$total Structural suite"
pnpm test:structural
step=$((step + 1))

if [[ "$WITH_TESTS" == true ]]; then
  echo ""
  echo "$step/$total Full test suite"
  pnpm test
  step=$((step + 1))
fi

echo ""
echo "$step/$total Adversarial probe"
pnpm probe:adversarial "${PROBE_ARGS[@]}"
REPORT_PATH="$(ls -t "$ARTIFACT_DIR"/iteration-*.json 2>/dev/null | head -1 || true)"
step=$((step + 1))

echo ""
echo "$step/$total Diagnose"
if [[ -z "$REPORT_PATH" ]]; then
  echo "No probe artifact found."
else
  diagnose_report "$REPORT_PATH"
fi
step=$((step + 1))

if [[ "$VERIFY" == true ]]; then
  echo ""
  echo "$step/$total Verify (test:stable)"
  pnpm test:stable
fi
