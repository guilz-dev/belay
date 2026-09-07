# Enforce Readiness Gap Remediation Design

## Goal

Close the gap between the labeled corpus and active dogfood traffic without weakening the
EffectPlan authorization boundary. The change removes avoidable availability asks, makes harvest
operate on the current decision cohort by default, and bounds audit-log storage.

## Constraints

- Keep `mode: audit` until the active cohort satisfies readiness.
- Do not interpret shell function arguments, loop variables, command substitution, or dynamic
  `cd` targets.
- Corpus entries are test expectations, never runtime authorization.
- Preserve every MUST-ASK result while reducing benign `unknown_local_effect` results.
- Keep existing legacy audit archives readable when explicitly selected.
- Do not modify the existing dirty
  `.worktrees/audit-log-bounded-storage-5454a26f-plan` worktree.

## Workstream 1: trusted dogfood upgrade invocations

The three `missing_trusted_cwd` records came from inline shell programs that changed repository
through function or loop variables. They are operational defects, not classifier defects.

The dogfood runbook and local update skill will require one host shell invocation per repository.
The host action working directory must be the target repository; the command must not contain a
variable-driven `cd`. Worktree discovery may be performed separately, but each discovered
worktree is upgraded in its own invocation.

The classifier continues to fail closed for mutation or process spawn after an opaque cwd
transition. Read-only commands retain their current behavior.

## Workstream 2: cohort-aware harvest and reviewed classifier corrections

`belay harvest list` currently combines every historical runtime and configuration. The observed
35-candidate backlog therefore includes fixed 0.9.2 behavior and correct MUST-ASK traffic.

Harvest will use the installed active audit cohort by default. `--all-cohorts` restores historical
analysis explicitly. The report states the selected scope and excluded-record count. Availability
records remain in `availabilityQueue` and are never promoted to corpus.

The 2026-09-07 backlog will be recorded as a review artifact with three outcomes:

1. already corrected by current EffectPlan behavior;
2. correct MUST-ASK or insufficiently proven, retained as deny expectations;
3. current benign gaps that receive a focused EffectPlan test and fix.

The first focused gap is a single-argument argv-delegate such as `rtk ls`. It is safe to recurse
because the inner command is still lowered normally; unknown or mutating inner commands remain
indeterminate or mutating. Arbitrary shell scripts, loops, and dynamic cwd evaluation remain out
of scope.

## Workstream 3: bounded audit storage

Audit storage gains `audit.retention.maxBytes` and `audit.retention.maxFiles`, defaulting to
33,554,432 bytes and 5 total files including the active file. Zero in either field disables
rotation for compatibility.

All writers use one audit sink. The sink serializes appends with an atomic repo-local lock,
rotates before an append would cross the configured size when the active file is non-empty, and
retains at most `maxFiles - 1` numbered archives. Readers process archives oldest-first followed
by the active file, one line at a time, and count malformed non-empty lines without failing the
entire report.

This change does not alter post-tool payload projection or remove full replay payloads; those
privacy/data-minimization changes remain a separate Phase C task.

## Verification

- Operational docs contain no multi-target dynamic-`cd` recipe.
- Current-cohort harvest excludes mismatched runtime/config/boundary records by default.
- `--all-cohorts` preserves historical review access.
- `rtk ls` is read-only while `rtk rm target` and wrapper options do not become silent allows.
- Corpus retains 100% MUST-ASK and benign expectations.
- Concurrent append/rotation produces complete NDJSON lines and never exceeds the file-count cap.
- `audit`, `metrics`, `report`, `simulate`, and recovery readers see rotated generations.
