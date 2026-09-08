# Dogfood Enforce Readiness Remediation Design

## Status

- Date: 2026-09-07
- Scope: `guilz-dev/belay` dogfood evidence and the product paths that produce it
- Baseline: the operator snapshot captured before this design was written
- Related design: [`../../dogfood-audit-remediation-2026-08-22.ja.md`](../../dogfood-audit-remediation-2026-08-22.ja.md)

## Problem

The current runtime passes all 79 corpus hard-gate cases, but the captured active cohort contains
176 gate events and 58 would-block events (33%). Three of those would-blocks are
`missing_trusted_cwd`; the remaining 55 are classifier-quality asks, or 31.25% of the cohort.
Consequently, removing the three availability asks is necessary but cannot by itself make the
cohort ready for enforce.

The evidence pipeline also has three structural weaknesses:

1. `missing_trusted_cwd` conflates a missing host action directory with a directory that became
   unknowable after `cd "$dir"` or `cd "$wt"`.
2. `harvest list` reads all history and exposes 35 candidates without showing whether the current
   runtime still blocks them. In the captured set, 34 are `unknown_local_effect`, one is a correct
   `external_effect`, and none was approved after deny. A candidate is therefore not a benign
   label.
3. The audit writer appends unbounded NDJSON, saves large scrubbed payload containers, and readers
   load the whole file. The captured file is already 20.8 MB.

Raw would-block rate is also the wrong final readiness metric because correct MUST-ASK decisions
are counted with false-positive blocks.

## Goals

1. Eliminate availability asks caused by the dogfood upgrade workflow without weakening dynamic
   shell safety.
2. Make harvest current-cohort-first and persist every human review outcome without granting
   runtime authority.
3. Convert only `provably-benign` findings into paired corpus tests and EffectPlan fixes; preserve
   correct asks for opaque code and external mutation.
4. Bound audit storage and stop retaining ordinary full tool payloads.
5. Gate enforce promotion on reviewed benign traffic, corpus hard gates, availability, and session
   diversity rather than raw would-block rate.
6. Preserve historical audit evidence across rotation and runtime upgrades.

## Non-goals

- Do not introduce command, executable, prefix, fingerprint, or corpus allowlists at runtime.
- Do not infer a dynamic `cd` target from positional parameters, loop variables, command
  substitution, or untrusted environment values.
- Do not auto-promote deny-then-approve events to benign.
- Do not make `accepted-benign` a silent-pass requirement.
- Do not make a rolling window forget availability failures inside the same runtime artifact.
- Do not delete the existing audit log to manufacture a clean cohort.
- Do not redesign contained execution or recovery.

## Design decisions

### 1. CWD causality is explicit

EffectPlan lowering will distinguish these cases:

```text
missing_action_cwd
  Host payload did not provide a usable action directory.

dynamic_cwd_transition
  The action started with a trusted cwd, then a shell segment such as
  cd "$dir" made subsequent path resolution unknowable.
```

`resolveCdTransition()` will return the causal signal for an unknown transition. The lowerer will
attach `shell.cwd_dynamic_transition` to later cwd-dependent requirements. `verdict()` will map it
to `dynamic_cwd_transition`; `missing_trusted_cwd` remains a compatibility reason for genuinely
untrusted initial cwd paths.

The classifier will continue to resolve a literal absolute `cd` and the host-provided Shell
`working_directory`. It will not evaluate functions or loops to recover dynamic cwd state.

The operator workflow will issue one host Shell action per repository. Each action sets the target
repository as `working_directory`; a literal absolute `--target` is added as defense in depth. A
single Shell action must not contain the multi-repository function or worktree loop.

### 2. Harvest is a review queue, scoped to current evidence

`belay harvest list` will default to the active runtime/config/boundary cohort. Forensics across
cohorts requires `--all-cohorts`. Output schema v2 will report the active cohort identity, matching
gate events, and excluded events.

Review outcomes become:

```ts
type HarvestReviewOutcome =
  | 'provably-benign'
  | 'accepted-benign'
  | 'must-ask'
  | 'reject'
```

Every review is persisted in a non-authoritative ledger adjacent to the audit log. The ledger
stores hashes and labels, not commands or payload bodies:

```ts
interface HarvestReviewRecordV1 {
  fingerprint: string
  kind: 'shell'
  boundaryProfile: string
  outcome: HarvestReviewOutcome
  reason?: string
  reviewedAt: string
}

interface HarvestReviewLedgerV1 {
  version: 1
  reviews: HarvestReviewRecordV1[]
}
```

The latest review for `(fingerprint, kind, boundaryProfile)` wins. `harvest list` omits reviewed
items unless `--include-reviewed` is passed. The ledger never participates in policy evaluation,
grant loading, or gate decisions.

`provably-benign`, `accepted-benign`, and `must-ask` may add a corpus case with harvest provenance.
`reject` only closes the local review item. Corpus entries remain CI expectations; EffectPlan and
PolicyEngine remain the sole shell authority.

### 3. The captured 35-candidate batch is reviewed before tuning

The batch receives a stable ID, `belay-2026-09-07`, and a tracked review report containing each
fingerprint, current-runtime result, semantic family, outcome, and evidence.

The first-pass families are:

| Family | Initial treatment |
|---|---|
| `rtk git status/diff` already allowed by current runtime | stale historical candidate; reject from remediation queue and add regression variants only if absent |
| read-only compound Git command | candidate for Git ref/range lowering fix |
| `cat/ls/tail` piped through an argv delegate | candidate for bounded recursive wrapper lowering |
| `npm`/`pnpm test`, build, runtime builder | accepted local mutation or must-ask; not provably benign |
| `make verify-parallel` | preserve indeterminate PID/background effects unless contained |
| heredoc, `node -e`, `python3 -` | must-ask when body executes arbitrary code |
| push, PR creation, publish | must-ask external mutation |
| dynamic diagnostic loops over user/global files | reject or must-ask; read-style prefix is insufficient |

No classifier change begins until the representative command still reproduces on the installed
runtime and its intended effect has been reviewed.

### 4. Audit records are compact before they are rotated

The normalized audit configuration gains bounded-storage settings:

```ts
interface BelayAuditConfig {
  logPath: string
  includeAssessment: boolean
  maxBytes: number // default 33_554_432
  maxFiles: number // default 5, including the active file
}
```

The ordinary audit stream retains decision, approval, recovery, boundary, and compact host outcome
events. It does not retain ordinary full tool input/output payloads.

`AuditActionSnapshot` becomes a v2 discriminated union:

```ts
type AuditActionSnapshotV2 =
  | {
      schemaVersion: 2
      kind: 'shell'
      cwd: string
      normalizedAction: string
    }
  | {
      schemaVersion: 2
      kind: 'tool'
      cwd: string
      toolName: string
      operation?: string
      path?: string
      payloadHash?: string
    }
  | {
      schemaVersion: 2
      kind: 'subagent'
      cwd: string
      toolName?: string
      summaryHash: string
    }
```

Legacy v1 snapshots remain readable. New `replayContext` records omit `payload`; simulation uses
the v2 normalized projection. If the projection cannot replay an action, simulation reports it as
non-replayable instead of retaining the full object.

Post-tool telemetry stores only event, timestamp, tool name, success/failure, duration, repo-
relative cwd, byte counts, normalized failure metadata, and correlation hashes.

### 5. Rotation is serialized and readers span generations

`appendAuditRecord()` will delegate to a storage sink that:

1. serializes and bounds one complete NDJSON line;
2. acquires an exclusive repo-local lock adjacent to the audit path;
3. rotates before append when `currentSize + lineSize > maxBytes`;
4. renames generations from oldest to newest and removes only the configured oldest generation;
5. appends the complete line and releases the lock in `finally`.

Generation names are deterministic:

```text
audit.ndjson       active
audit.ndjson.1     newest rotated generation
audit.ndjson.2
audit.ndjson.3
audit.ndjson.4     oldest when maxFiles = 5
```

Legacy `audit.ndjson.legacy-*.ndjson` archives are preserved but are not part of automatic
retention. Readers expose an async iterator that reads retained numbered generations oldest first,
then the active file, one line at a time. Malformed and oversized lines are counted and skipped.

### 6. Readiness uses reviewed benign evidence

New audit records carry a one-way `sessionCorrelationId` derived from an adapter session or
conversation identifier. The raw identifier is never stored.

Traffic readiness is calculated from active-cohort gate records joined to the review ledger:

```ts
interface ReviewedTrafficReadiness {
  reviewedBenignEvents: number
  reviewedBenignBlocked: number
  benignBlockRate: number
  distinctSessions: number
  availabilityAsks: number
  ready: boolean
}
```

Only `provably-benign` reviews enter the benign denominator. `accepted-benign`, `must-ask`, and
`reject` remain visible but do not affect the rate.

The traffic gate requires:

- at least 150 reviewed benign events;
- at least three distinct valid session correlation IDs;
- benign block rate below 2%;
- zero active-cohort availability asks;
- a known active cohort identity.

`belay quality` combines traffic readiness with corpus hard gates. Final readiness requires both
MUST-ASK false negatives = 0 and provably-benign corpus blocks = 0. `belay dogfood --enforce`
reruns this combined quality check immediately before changing config. `--force` remains an
explicit operator override.

Raw current-cohort would-block rate remains a diagnostic, but it is not the promotion criterion.

## Data flow

```text
host action
  -> action cwd resolution
  -> EffectPlan + PolicyEngine
  -> compact audit sink
  -> retained NDJSON generations
  -> active-cohort harvest groups
  -> human review ledger
  -> corpus expectation + semantic fix when justified
  -> reviewed traffic metrics + corpus hard gates
  -> dogfood enforce decision
```

## Failure behavior

- Missing or malformed active cohort identity: readiness false.
- Missing review ledger: zero reviewed benign samples, readiness false.
- Missing session IDs: those events do not contribute to the three-session requirement.
- Lock timeout or audit append failure: preserve the existing gate failure behavior and emit a
  bounded stderr diagnostic; never write a partial line.
- Rotation interruption: either the pre-rotation or post-rename generation set remains readable;
  readers tolerate a missing active file.
- Malformed lines: skip, count, and surface in doctor/metrics.
- Corpus hard-gate failure: `dogfood --enforce` refuses promotion.

## Security invariants

1. Review labels and corpus entries never grant runtime authority.
2. Dynamic cwd remains unknown unless the transition is statically literal.
3. External mutation, arbitrary code bodies, and unresolved wrappers remain ask.
4. Raw approval, tool-use, session, and conversation IDs are not persisted.
5. Rotation never follows a symlinked audit path or lock path outside the configured audit
   directory.
6. Existing legacy archives are not silently deleted by normal retention.

## Rollout

1. Capture the baseline report and review batch.
2. Ship cwd causality and the per-target runbook.
3. Ship current-cohort harvest and the review ledger.
4. Review the 35-candidate batch and land only evidence-backed EffectPlan changes.
5. Ship compact snapshots, rotation, and multi-generation readers.
6. Ship reviewed-traffic readiness and combined quality enforcement.
7. Release a new runtime artifact; do not reuse the 0.10.1 readiness cohort.
8. Upgrade each active dogfood repository in a separate Shell action.
9. Collect at least 150 reviewed benign events across at least three sessions.
10. Begin a limited enforce trial only after all gates pass.

## Acceptance criteria

- The two causes previously reported as `missing_trusted_cwd` are distinguishable in explain,
  metrics, and harvest.
- The multi-repository upgrade workflow generates zero availability asks in the new cohort.
- All 35 captured candidates have a persisted disposition and evidence; zero are bulk-promoted.
- Current-cohort harvest no longer returns stale `rtk git status/diff` asks already fixed by the
  installed runtime.
- Corpus hard gates remain at 100%, including zero MUST-ASK false negatives.
- Default audit storage is bounded to five files of approximately 32 MiB each.
- New ordinary tool records contain no full payload or content body.
- Metrics, report, simulate, quality, harvest, doctor, and dogfood checks read retained generations.
- Final readiness uses 150 reviewed benign events, three sessions, less than 2% benign block rate,
  zero availability asks, and passing corpus hard gates.
- Existing audit history remains available as retained or explicit legacy archives.
