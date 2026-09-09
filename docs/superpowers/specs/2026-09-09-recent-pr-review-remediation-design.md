# Recent PR Review Remediation Design

## Status

- Date: 2026-09-09
- Scope: unresolved findings from merged PRs #116, #118, and #120
- Base: `origin/main` at merge commit `83d3c68` (PR #122)

## Problem

The last six merged pull requests pass CI, but review identified four remaining behavioral or
operational defects and three documentation/type-ownership gaps:

1. A missing, invalid, or mismatched readiness sidecar is rebuilt from only the incoming record.
   Same-cohort availability asks still present in retained audit generations can therefore be
   forgotten after rotation.
2. `harvest apply --all-cohorts` aggregates candidates without their source boundary and writes the
   review under the currently active boundary. Historical evidence can be attributed to the wrong
   boundary and affect current readiness.
3. A crashed audit writer leaves an exclusive lock file that every later writer times out on.
4. The release guide requires non-Belay repositories to execute the requested published package
   before that package is published.
5. Public harvest and linked-worktree configuration behavior is absent from `README.md`.
6. Decision-cohort and config-provenance domains are represented by duplicated loose fields.
7. Readiness state policy is embedded in the audit storage implementation.

## Goals

1. Reconstruct missing or unusable readiness state from the exact retained generations while the
   writer lock is held, before rotation can discard evidence.
2. Bind every harvest candidate and review to the boundary that produced it, including forensic
   all-cohort review when no active cohort is available.
3. Recover a lock left by a process that is proven absent without deleting a live writer's lock.
4. Make the release workflow executable and document the public behavior introduced by the recent
   PRs.
5. Give readiness/cohort/provenance concepts one named type and keep readiness transition policy in
   a focused module.

## Non-goals

- Do not change EffectPlan, PolicyEngine, grants, or runtime authorization.
- Do not allow harvest reviews to authorize runtime behavior.
- Do not infer that malformed or unreadable audit evidence represents zero availability asks.
- Do not automatically remove a lock whose owner cannot be parsed or proven absent.
- Do not publish a package, upgrade another repository, or enable enforce mode in this PR.
- Do not redesign the audit file format or harvest ledger schema.

## Chosen approach

Land one cohesive remediation PR. The safety fixes share the dogfood-readiness evidence pipeline,
and the documentation and type cleanup describe or support those fixes. Separate commits keep each
behavior independently reviewable.

Alternatives rejected:

- **Safety-only PR:** smaller, but leaves public commands undocumented and preserves the type drift
  that made the review harder.
- **One PR per finding:** reduces individual diff size, but leaves known unsafe intermediate states
  and contradicts the requested single remediation PR.
- **Third-party filesystem-lock dependency:** offers a packaged lease protocol but adds the first
  runtime dependency and native/filesystem compatibility risk to a small CLI. The local protocol
  below stays bounded and fail-closed.

## 1. Readiness repair from retained evidence

Move readiness schemas, cohort comparison, validation, and pure transition construction to
`src/core/audit-readiness-state.ts`. Introduce a shared `DecisionCohortIdentity` containing
`runtimeArtifactHash`, `decisionConfigFingerprint`, and `boundaryProfile`; `AuditCohortIdentity`
extends it with display/legacy provenance fields.

`AuditReadinessUpdate` carries `cohort: DecisionCohortIdentity` rather than three loose strings.
The persisted state continues to hash `boundaryProfile`, preserving the existing 4 KiB content-
free sidecar schema.

During append, under the existing audit writer lock:

1. Load and validate the sidecar.
2. If it is valid for the incoming cohort, retain it and do not scan history.
3. Otherwise open the exact configured retained generations and active file using the existing
   no-follow, identity-checked snapshot logic before any pruning or rotation.
4. Stream bounded records and reconstruct count, first timestamp, and last timestamp for
   availability-caused gate asks matching the incoming decision cohort.
5. If retained evidence is malformed in a way that prevents a trustworthy same-cohort result,
   fail the append/readiness update rather than manufacture zero.
6. Apply the incoming availability delta exactly once and atomically replace the sidecar.
7. Only then prune/rotate and append the incoming audit line.

A proven scan with no matching asks may seed zero; an entirely absent retained log is a complete
empty snapshot before the first append. Malformed, unreadable, truncated, or oversized retained
evidence cannot silently seed zero.

## 2. Boundary-qualified harvest reviews

Add `boundaryProfile: string | null` to `HarvestCandidate`. Candidate aggregation keys become
`(fingerprint, kind, boundaryProfile)` instead of fingerprint alone. Round-trip and repeated-ask
paths preserve the boundary from their gate record.

Active-cohort listing may use the selected active boundary for legacy records that matched through
legacy cohort fields. Mixed-history listing does not invent a boundary for legacy records; those
candidates remain visible but cannot be reviewed until scoped evidence identifies a boundary.

`harvest apply` behavior:

- Active-cohort apply defaults to the active candidate's boundary.
- `--all-cohorts` uses the selected candidate's boundary, never `report.cohort`.
- Add optional `--boundary-profile <id>` to disambiguate the same command/fingerprint appearing at
  multiple boundaries.
- If the selection is still ambiguous, or its boundary is unavailable, fail without writing the
  ledger or corpus.
- Filtering reviewed candidates uses the full review key so a review at one boundary does not hide
  another boundary's candidate.

The ledger stays version 1 because it already stores the required boundary-qualified key.

## 3. Recoverable audit lock ownership

The lock file becomes a bounded JSON owner record containing schema version, PID, random owner
token, and acquisition timestamp. The creator writes and syncs the record before entering the
critical section and keeps the file handle open.

On `EEXIST`, a contender opens the lock with no-follow semantics and verifies path/handle identity.
It treats `process.kill(pid, 0)` success or `EPERM` as alive and continues the existing bounded wait.
Only `ESRCH` proves the owner absent.

Recovery uses a fixed hard-link claim adjacent to the lock:

1. Atomically hard-link the observed lock inode to the claim path; only one reclaimer can own the
   claim.
2. Recheck that claim, open handle, and lock path still identify the same inode and owner token.
3. Recheck that the PID is absent immediately before unlinking the lock path.
4. Unlink only that proven inode, then remove the claim in `finally`.
5. A claim bound to a different inode is stale cleanup data and may be removed without touching the
   current lock. An unverifiable same-inode claim fails closed and is surfaced for operator repair.

Normal release continues to compare inode and owner token before unlinking. Malformed owner records,
PID reuse, permission-denied liveness checks, symlinks, and identity changes all fail closed. The
existing two-second acquisition deadline remains authoritative.

## 4. Documentation and release ordering

Update `README.md` with:

- linked-worktree config inheritance order, local override behavior, unreadable-local failure, and
  source-root trust;
- active-cohort harvest defaults, `--all-cohorts`, `--include-reviewed`, review outcomes,
  `--fingerprint`, and `--boundary-profile`;
- an explicit statement that review evidence never grants runtime authority.

Update `docs/ops/releasing.md` so pre-release runs only source-build checks against the Belay
checkout. After publish and authorized target upgrades, select one shared cutoff immediately before
the first upgrade, run each non-Belay check from its own trusted working directory, and record every
result in the release PR.

Update `docs/ops/pr-118-remaining-follow-ups.md` to mark the implemented P0/P1 items complete while
retaining the historical rationale and any genuinely remaining backlog.

## 5. Type and module ownership

- Define `ConfigLayerSource` once in `src/types.ts`; `config-layers.ts` and
  `ConfigProvenanceNote` use it.
- Define `DecisionCohortIdentity` once in `audit-types.ts`; runtime provenance, metrics,
  readiness, and harvest use it.
- Keep filesystem snapshot/rotation primitives in `audit-storage.ts`; move readiness schemas and
  transition rules to `audit-readiness-state.ts`.

## Failure behavior

- Retained audit scan cannot prove a complete result: audit append/readiness update fails closed.
  A confirmed empty retained file set is complete evidence, not a scan failure.
- Candidate has no boundary or multiple candidates remain after selectors: review apply fails with
  actionable selector guidance.
- Lock owner is alive, inaccessible, malformed, or identity changes: do not reclaim; time out.
- Proven dead lock owner: reclaim only through the inode-bound claim protocol.
- Documentation changes cause no external actions; publishing and cross-repository upgrades remain
  operator-authorized.

## Verification

- RED/GREEN integration test for a missing/invalid/mismatched sidecar with a retained same-cohort
  availability ask that would otherwise rotate away.
- RED/GREEN tests for mixed-boundary listing, selection, exact review-key filtering, no-active-cohort
  forensic apply, and ambiguity failure.
- RED/GREEN tests for dead-owner recovery, live-owner timeout, malformed-owner fail-closed behavior,
  concurrent reclaimers, claim cleanup, and release ownership checks.
- Focused suites: audit storage, quality, harvest, harvest review, audit metrics, and config layers.
- Full gates: lint, typecheck, test, structural suite, corpus, adversarial probe, and `git diff --check`.

## Rollout

1. Merge without enabling enforce mode.
2. Release a patch version in a separate authorized release workflow.
3. Upgrade dogfood targets using the corrected post-publish sequence.
4. Confirm repaired readiness state retains historical availability asks.
5. Consider enforce only after the ordinary readiness gates pass with the repaired evidence.
