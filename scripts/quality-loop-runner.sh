#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FROM_ARTIFACT=""
WORKTREE_PATH=""
BASE_REF="HEAD"
BRANCH_NAME=""
BELAY_CONFIG_REL="configs/quality-loop/belay.config.json"
WORKFLOW_ROUTING_REL=".planetz/orbit/workflow-routing.yaml"
WORKFLOW_NAME="quality-loop-fix"
REQUIRED_SAFETY_TIER="sandboxed-write"
SKIP_WORKFLOW_SAFETY_CHECK=false
SANDBOX_RUNTIME="auto"
KEEP_ON_FAILURE=false
RUN_VERIFY=false
WORKFLOW_COMMAND=""
WORKTREE_CREATED=false
BRANCH_CREATED=false
WORKTREE_ABS=""
AUDIT_LOG_REL=".cursor/belay/audit-quality-loop.ndjson"
PAUSE_EXIT_CODE=42

usage() {
  cat <<'EOF'
Usage:
  ./scripts/quality-loop-runner.sh --from-artifact <path> [options]

Options:
  --from-artifact <path>  Required. Probe artifact JSON path.
  --worktree <path>       Optional. Target worktree path.
  --base-ref <ref>        Optional. Base ref for branch creation (default: HEAD).
  --branch <name>         Optional. Branch name (default: quality-loop/<batchId>).
  --belay-config <path>   Optional. Repo-relative config path (default: configs/quality-loop/belay.config.json).
  --routing-file <path>   Optional. Repo-relative workflow-routing path (default: .planetz/orbit/workflow-routing.yaml).
  --workflow-name <name>  Optional. Workflow name to validate (default: quality-loop-fix).
  --required-safety-tier <tier>
                           Optional. Required safetyTier (default: sandboxed-write).
  --skip-workflow-safety-check
                           Optional. Skip workflow safetyTier validation.
  --workflow-command <cmd> Optional. Run workflow command in worktree (bash -lc).
                           Receives QUALITY_LOOP_ARTIFACT, QUALITY_LOOP_WORKFLOW, BELAY_CONFIG_PATH.
  --sandbox-runtime <id>  Optional. sandbox.runtime (auto|container|seatbelt|landlock). Default: auto.
  --keep-on-failure       Optional. Keep worktree and branch when verification fails.
  --run-verify            Optional. Run full verify session in the worktree.
  -h, --help              Show this help.
EOF
}

resolve_abs_path() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s\n' "$path"
    return
  fi
  printf '%s\n' "$ROOT/$path"
}

detect_sandbox_runtime() {
  case "$(uname -s)" in
    Darwin)
      printf '%s\n' "seatbelt"
      ;;
    Linux)
      printf '%s\n' "landlock"
      ;;
    *)
      printf '%s\n' "container"
      ;;
  esac
}

resolve_sandbox_runtime() {
  local requested="$1"
  local runtime="$requested"
  if [[ "$requested" == "auto" ]]; then
    runtime="$(detect_sandbox_runtime)"
  fi
  case "$runtime" in
    container|seatbelt|landlock)
      printf '%s\n' "$runtime"
      ;;
    *)
      echo "Unsupported sandbox runtime: $runtime" >&2
      echo "Supported values: auto, container, seatbelt, landlock" >&2
      exit 1
      ;;
  esac
}

cleanup_failure_artifacts() {
  set +e
  if [[ "$WORKTREE_CREATED" == true ]] && [[ -n "$WORKTREE_ABS" ]]; then
    git worktree remove --force "$WORKTREE_ABS" >/dev/null 2>&1
  fi
  if [[ "$BRANCH_CREATED" == true ]] && [[ -n "$BRANCH_NAME" ]]; then
    git branch -D "$BRANCH_NAME" >/dev/null 2>&1
  fi
  set -e
}

exit_with_failure() {
  local exit_code="$1"
  if [[ "$KEEP_ON_FAILURE" == false ]]; then
    cleanup_failure_artifacts
  fi
  exit "$exit_code"
}

handle_failure() {
  local exit_code="$?"
  exit_with_failure "$exit_code"
}

trap 'handle_failure' ERR

check_workflow_safety_contract() {
  local routing_file="$1"
  local workflow_name="$2"
  local required_safety_tier="$3"

  ROUTING_FILE="$routing_file" WORKFLOW_NAME="$workflow_name" REQUIRED_SAFETY_TIER="$required_safety_tier" node <<'NODE'
const fs = require('node:fs');

const routingFile = process.env.ROUTING_FILE;
const workflowName = process.env.WORKFLOW_NAME;
const requiredSafetyTier = process.env.REQUIRED_SAFETY_TIER;

if (!routingFile || !workflowName || !requiredSafetyTier) {
  throw new Error('ROUTING_FILE, WORKFLOW_NAME, and REQUIRED_SAFETY_TIER are required');
}

const content = fs.readFileSync(routingFile, 'utf8');
const lines = content.split(/\r?\n/);
let inTargetBlock = false;
let foundTarget = false;
let foundSafetyTier = '';

for (const line of lines) {
  const nameMatch = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
  if (nameMatch) {
    inTargetBlock = nameMatch[1] === workflowName;
    if (inTargetBlock) {
      foundTarget = true;
      foundSafetyTier = '';
    }
    continue;
  }

  if (!inTargetBlock) {
    continue;
  }

  const safetyMatch = line.match(/^\s*safetyTier:\s*(.+?)\s*$/);
  if (!safetyMatch) {
    continue;
  }

  const normalized = safetyMatch[1].split('#')[0].trim();
  foundSafetyTier = normalized;
  break;
}

if (!foundTarget) {
  console.error(`Workflow entry not found in routing file: ${workflowName}`);
  process.exit(2);
}

if (!foundSafetyTier) {
  console.error(`safetyTier not found for workflow: ${workflowName}`);
  process.exit(3);
}

if (foundSafetyTier !== requiredSafetyTier) {
  console.error(
    `safetyTier mismatch for ${workflowName}: expected "${requiredSafetyTier}", actual "${foundSafetyTier}"`,
  );
  process.exit(4);
}
NODE
}

resolve_audit_log_rel() {
  local config_path="$1"
  CONFIG_PATH="$config_path" node <<'NODE'
const fs = require('node:fs');

const configPath = process.env.CONFIG_PATH;
if (!configPath) {
  throw new Error('CONFIG_PATH is required');
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const value = config?.audit?.logPath;
if (typeof value === 'string' && value.trim().length > 0) {
  process.stdout.write(value.trim());
} else {
  process.stdout.write('.cursor/belay/audit-quality-loop.ndjson');
}
NODE
}

audit_has_pending_approval() {
  local audit_log_path="$1"
  if [[ ! -f "$audit_log_path" ]]; then
    return 1
  fi

  AUDIT_LOG_PATH="$audit_log_path" node <<'NODE'
const fs = require('node:fs');

const auditLogPath = process.env.AUDIT_LOG_PATH;
if (!auditLogPath) {
  process.exit(1);
}

const lines = fs.readFileSync(auditLogPath, 'utf8').split(/\r?\n/);
for (const line of lines) {
  if (!line) {
    continue;
  }
  if (line.includes('"deny_pending_approval"')) {
    process.exit(0);
  }
}
process.exit(1);
NODE
}

write_paused_report() {
  local output_path="$1"
  local audit_log_path="$2"
  local artifact_copy="$3"
  cat <<EOF >"$output_path"
# Quality Loop Paused

## Reason
detected \`deny_pending_approval\` during unattended verification.

## Evidence
- audit log: \`$audit_log_path\`
- artifact: \`$artifact_copy\`

## Required human actions
1. Review the denied action(s) in the audit log.
2. Decide whether to approve manually or adjust rules/config.
3. Re-run the workflow after human decision.
EOF
}

run_step_with_pause_detection() {
  local step_label="$1"
  local command="$2"
  local worktree_abs="$3"
  local belay_config_path="$4"
  local artifact_copy="$5"
  local workflow_name="$6"
  local audit_log_path="$7"
  local safe_batch_id="$8"

  trap - ERR
  set +e
  (
    cd "$worktree_abs"
    QUALITY_LOOP_ARTIFACT="$artifact_copy" \
      QUALITY_LOOP_WORKFLOW="$workflow_name" \
      BELAY_CONFIG_PATH="$belay_config_path" \
      bash -lc "$command"
  )
  local step_exit="$?"
  set -e
  trap 'handle_failure' ERR

  if audit_has_pending_approval "$audit_log_path"; then
    local paused_report_path="$worktree_abs/artifacts/quality-loop/paused-${safe_batch_id}.md"
    mkdir -p "$(dirname "$paused_report_path")"
    write_paused_report "$paused_report_path" "$audit_log_path" "$artifact_copy"
    echo
    echo "Paused during ${step_label} due to deny_pending_approval. Report: $paused_report_path" >&2
    KEEP_ON_FAILURE=true
    exit_with_failure "$PAUSE_EXIT_CODE"
  fi

  if [[ "$step_exit" -ne 0 ]]; then
    exit_with_failure "$step_exit"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-artifact)
      FROM_ARTIFACT="${2:-}"
      shift 2
      ;;
    --worktree)
      WORKTREE_PATH="${2:-}"
      shift 2
      ;;
    --base-ref)
      BASE_REF="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH_NAME="${2:-}"
      shift 2
      ;;
    --belay-config)
      BELAY_CONFIG_REL="${2:-}"
      shift 2
      ;;
    --routing-file)
      WORKFLOW_ROUTING_REL="${2:-}"
      shift 2
      ;;
    --workflow-name)
      WORKFLOW_NAME="${2:-}"
      shift 2
      ;;
    --required-safety-tier)
      REQUIRED_SAFETY_TIER="${2:-}"
      shift 2
      ;;
    --skip-workflow-safety-check)
      SKIP_WORKFLOW_SAFETY_CHECK=true
      shift
      ;;
    --workflow-command)
      WORKFLOW_COMMAND="${2:-}"
      shift 2
      ;;
    --sandbox-runtime)
      SANDBOX_RUNTIME="${2:-}"
      shift 2
      ;;
    --keep-on-failure)
      KEEP_ON_FAILURE=true
      shift
      ;;
    --run-verify)
      RUN_VERIFY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$FROM_ARTIFACT" ]]; then
  echo "--from-artifact is required." >&2
  usage >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This script must run inside a git repository." >&2
  exit 1
fi

ARTIFACT_ABS="$(resolve_abs_path "$FROM_ARTIFACT")"
if [[ ! -f "$ARTIFACT_ABS" ]]; then
  echo "Artifact not found: $ARTIFACT_ABS" >&2
  exit 1
fi

BELAY_CONFIG_SOURCE="$(resolve_abs_path "$BELAY_CONFIG_REL")"
if [[ ! -f "$BELAY_CONFIG_SOURCE" ]]; then
  echo "Belay config not found: $BELAY_CONFIG_SOURCE" >&2
  exit 1
fi

WORKFLOW_ROUTING_ABS="$(resolve_abs_path "$WORKFLOW_ROUTING_REL")"
if [[ "$SKIP_WORKFLOW_SAFETY_CHECK" == false ]] && [[ ! -f "$WORKFLOW_ROUTING_ABS" ]]; then
  echo "Workflow routing file not found: $WORKFLOW_ROUTING_ABS" >&2
  exit 1
fi

if [[ "$SKIP_WORKFLOW_SAFETY_CHECK" == false ]]; then
  check_workflow_safety_contract "$WORKFLOW_ROUTING_ABS" "$WORKFLOW_NAME" "$REQUIRED_SAFETY_TIER"
fi

BATCH_ID="$(ARTIFACT_ABS="$ARTIFACT_ABS" node <<'NODE'
const fs = require('node:fs');
const artifactPath = process.env.ARTIFACT_ABS;
const raw = fs.readFileSync(artifactPath, 'utf8');
const parsed = JSON.parse(raw);
const value = typeof parsed.batchId === 'string' ? parsed.batchId : '';
process.stdout.write(value);
NODE
)"

if [[ -z "$BATCH_ID" ]]; then
  BATCH_ID="$(date +%Y%m%d-%H%M%S)"
fi

SAFE_BATCH_ID="$(printf '%s' "$BATCH_ID" | tr -c '[:alnum:]._-' '-')"

if [[ -z "$BRANCH_NAME" ]]; then
  BRANCH_NAME="quality-loop/${SAFE_BATCH_ID}"
fi

if [[ -z "$WORKTREE_PATH" ]]; then
  WORKTREE_PATH="../belay-quality-loop-${SAFE_BATCH_ID}"
fi

WORKTREE_ABS="$(resolve_abs_path "$WORKTREE_PATH")"

if [[ -e "$WORKTREE_ABS" ]]; then
  echo "Worktree path already exists: $WORKTREE_ABS" >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  echo "Branch already exists locally: $BRANCH_NAME" >&2
  exit 1
fi

git worktree add "$WORKTREE_ABS" -b "$BRANCH_NAME" "$BASE_REF"
WORKTREE_CREATED=true
BRANCH_CREATED=true

ARTIFACT_DEST_DIR="$WORKTREE_ABS/artifacts/quality-loop/input"
mkdir -p "$ARTIFACT_DEST_DIR"
ARTIFACT_COPY="$ARTIFACT_DEST_DIR/$(basename "$ARTIFACT_ABS")"
cp "$ARTIFACT_ABS" "$ARTIFACT_COPY"

mkdir -p "$WORKTREE_ABS/$(dirname "$BELAY_CONFIG_REL")"
cp "$BELAY_CONFIG_SOURCE" "$WORKTREE_ABS/$BELAY_CONFIG_REL"

RESOLVED_SANDBOX_RUNTIME="$(resolve_sandbox_runtime "$SANDBOX_RUNTIME")"
CONFIG_PATH="$WORKTREE_ABS/$BELAY_CONFIG_REL"
CONFIG_PATH="$CONFIG_PATH" SANDBOX_RUNTIME="$RESOLVED_SANDBOX_RUNTIME" node <<'NODE'
const fs = require('node:fs');

const configPath = process.env.CONFIG_PATH;
const runtime = process.env.SANDBOX_RUNTIME;

if (!configPath || !runtime) {
  throw new Error('CONFIG_PATH and SANDBOX_RUNTIME are required');
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.sandbox || typeof config.sandbox !== 'object') {
  throw new Error('sandbox configuration is required');
}

config.sandbox.enabled = true;
config.sandbox.runtime = runtime;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
NODE
AUDIT_LOG_REL="$(resolve_audit_log_rel "$CONFIG_PATH")"
AUDIT_LOG_PATH="$WORKTREE_ABS/$AUDIT_LOG_REL"

echo "Created worktree: $WORKTREE_ABS"
echo "Created branch:   $BRANCH_NAME"
echo "Artifact copy:    $ARTIFACT_COPY"
echo "Sandbox runtime:  $RESOLVED_SANDBOX_RUNTIME"
echo
echo "Next commands:"
echo "  cd \"$WORKTREE_ABS\""
if [[ -n "$WORKFLOW_COMMAND" ]]; then
  echo "  QUALITY_LOOP_ARTIFACT=\"$ARTIFACT_COPY\" BELAY_CONFIG_PATH=\"$WORKTREE_ABS/$BELAY_CONFIG_REL\" bash -lc \"$WORKFLOW_COMMAND\""
else
  echo "  # (optional) run workflow engine command here"
  echo "  # example: QUALITY_LOOP_ARTIFACT=\"$ARTIFACT_COPY\" BELAY_CONFIG_PATH=\"$WORKTREE_ABS/$BELAY_CONFIG_REL\" <orbit-engine-cli> run $WORKFLOW_NAME --context \"$ARTIFACT_COPY\""
fi
echo "  BELAY_CONFIG_PATH=\"$WORKTREE_ABS/$BELAY_CONFIG_REL\" ./scripts/quality-loop-session.sh --report \"$ARTIFACT_COPY\""

if [[ -n "$WORKFLOW_COMMAND" ]]; then
  echo
  echo "Running workflow command in worktree..."
  run_step_with_pause_detection \
    "workflow-command" \
    "$WORKFLOW_COMMAND" \
    "$WORKTREE_ABS" \
    "$WORKTREE_ABS/$BELAY_CONFIG_REL" \
    "$ARTIFACT_COPY" \
    "$WORKFLOW_NAME" \
    "$AUDIT_LOG_PATH" \
    "$SAFE_BATCH_ID"
fi

if [[ "$RUN_VERIFY" == true ]]; then
  echo
  echo "Running verify session in worktree..."
  run_step_with_pause_detection \
    "verify-session" \
    "./scripts/quality-loop-session.sh --full --with-tests --verify" \
    "$WORKTREE_ABS" \
    "$WORKTREE_ABS/$BELAY_CONFIG_REL" \
    "$ARTIFACT_COPY" \
    "$WORKFLOW_NAME" \
    "$AUDIT_LOG_PATH" \
    "$SAFE_BATCH_ID"
fi

trap - ERR
