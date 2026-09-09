# Recent PR Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the outstanding readiness, harvest-boundary, audit-lock, documentation, and type-ownership findings from the six most recently merged pull requests.

**Architecture:** Keep authorization unchanged and harden only the evidence pipeline. Move readiness transition policy into a focused module, repair state from retained records inside the storage lock, carry boundary identity through harvest candidates, and make lock-file ownership recoverable only when the owner is proven absent.

**Tech Stack:** TypeScript 5.9, Node.js 22, Vitest 3, pnpm 10, Biome, NDJSON.

**Spec:** `docs/superpowers/specs/2026-09-09-recent-pr-review-remediation-design.md`

## Global Constraints

- EffectPlan and PolicyEngine remain the only runtime authorization authority.
- Harvest reviews and corpus entries never grant runtime permission.
- Missing, malformed, or unreadable readiness evidence must not become a trusted zero.
- The readiness sidecar remains content-free, schema v1, atomic, symlink-safe, and at most 4 KiB.
- Audit record lines remain bounded at 33,554,432 bytes; configured retention remains at most 100 files.
- Lock acquisition keeps the existing 2,000 ms deadline and fails closed for unproven owners.
- No new runtime dependency is added.
- No package publication, target upgrade, or enforce activation is performed.
- Every production behavior change follows RED, GREEN, then refactor.

---

### Task 1: Reconstruct readiness state from retained evidence

**Files:**
- Create: `src/core/audit-readiness-state.ts`
- Modify: `src/core/audit-types.ts`
- Modify: `src/core/audit-metrics.ts`
- Modify: `src/core/audit-serialize.ts`
- Modify: `src/core/audit-storage.ts`
- Modify: `src/__tests__/audit-storage.test.ts`
- Modify: `src/__tests__/quality.test.ts`

**Interfaces:**
- Produces: `DecisionCohortIdentity` in `audit-types.ts` with `runtimeArtifactHash`, `decisionConfigFingerprint`, and `boundaryProfile`.
- Produces: `AuditReadinessUpdate { cohort, availabilityCausedAsk, timestamp }` and all readiness state types from `audit-readiness-state.ts`.
- Produces: pure `buildAuditReadinessState(update, retainedEvidence?)` and cohort-match helpers used by storage and metrics.
- Preserves: `appendBoundedAuditLine()` and `loadRetainedAuditRecords()` public behavior and persisted sidecar schema v1.

- [ ] **Step 1: Add the missing-sidecar regression**

In `audit-storage.test.ts`, create retained same-cohort NDJSON whose oldest generation contains one
availability-caused gate ask and no readiness sidecar. Append a non-availability record through
`appendBoundedAuditLine()` with a small `maxBytes` that rotates the old ask. Then load retained data
and assert the sidecar is `valid`, `availabilityAskCount === 1`, and its first/last timestamps equal
the retained ask timestamp.

Use literal cohort values and an audit record equivalent to:

```ts
const cohort = {
  runtimeArtifactHash: 'a'.repeat(64),
  decisionConfigFingerprint: 'b'.repeat(64),
  boundaryProfile: 'l3-l4-only',
}
const retainedAsk = {
  event: 'beforeShellExecution',
  kind: 'shell',
  verdict: 'deny_pending_approval',
  wouldBlock: true,
  reason: 'missing_trusted_cwd',
  timestamp: '2026-09-08T00:00:00.000Z',
  ...cohort,
}
```

Add table cases for missing, malformed, and other-cohort sidecars. Add one malformed retained-line
case asserting append rejects and neither rotates nor appends.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run src/__tests__/audit-storage.test.ts src/__tests__/quality.test.ts
```

Expected: the missing/malformed/mismatched sidecar cases report zero or overwrite the historical
ask; malformed retained evidence does not prevent a zero repair.

- [ ] **Step 3: Introduce shared cohort and readiness types**

Add to `audit-types.ts`:

```ts
export interface DecisionCohortIdentity {
  runtimeArtifactHash: string
  decisionConfigFingerprint: string
  boundaryProfile: string
}
```

Make `AuditCohortIdentity` extend this interface. Move readiness constants, types, parsing,
validation, cohort hashing/comparison, and pure next-state construction from `audit-storage.ts` to
`audit-readiness-state.ts`. Keep filesystem I/O in storage.

- [ ] **Step 4: Reconstruct state under the writer lock**

Refactor the existing retained-snapshot opener into an unlocked helper used only from callers that
already hold `withAuditStorageLock()`. Before pruning/rotation, if the sidecar is not valid for the
incoming cohort, open the configured generations and active file, consume every bounded line, and:

```ts
interface RetainedAvailabilityEvidence {
  availabilityAskCount: number
  firstAvailabilityAt?: string
  lastAvailabilityAt?: string
}
```

Count only `isAvailabilityCausedAsk(record)` rows matching all three `DecisionCohortIdentity`
fields. Reject malformed, oversized, truncated, unreadable, or identity-changing retained files.
A confirmed empty snapshot yields count zero. Build the next sidecar from retained evidence plus
the incoming delta exactly once, write it atomically, then rotate and append.

- [ ] **Step 5: Verify GREEN and mutation coverage**

Run:

```bash
pnpm exec vitest run src/__tests__/audit-storage.test.ts src/__tests__/quality.test.ts src/__tests__/audit-metrics.test.ts src/__tests__/audit-sink.test.ts
pnpm typecheck
```

Confirm a mutation that replaces retained count with zero fails the new test, and a mutation that
counts a different cohort also fails.

- [ ] **Step 6: Commit**

```bash
git add src/core/audit-readiness-state.ts src/core/audit-types.ts src/core/audit-metrics.ts src/core/audit-serialize.ts src/core/audit-storage.ts src/__tests__/audit-storage.test.ts src/__tests__/quality.test.ts
git commit -m "fix: seed readiness state from retained audit evidence"
```

---

### Task 2: Bind harvest reviews to candidate boundaries

**Files:**
- Modify: `src/core/audit-types.ts`
- Modify: `src/core/audit-query.ts`
- Modify: `src/core/harvest.ts`
- Modify: `src/core/harvest-review.ts`
- Modify: `src/commands/harvest.ts`
- Modify: `src/cli.ts`
- Modify: `src/__tests__/harvest.test.ts`
- Modify: `src/__tests__/harvest-review.test.ts`

**Interfaces:**
- Consumes: `DecisionCohortIdentity` from Task 1.
- Produces: `HarvestCandidate.boundaryProfile: string | null`.
- Produces: optional `HarvestApplyOptions.boundaryProfile` and CLI `--boundary-profile <id>`.
- Preserves: harvest ledger schema v1 and exact review key `(fingerprint, kind, boundaryProfile)`.

- [ ] **Step 1: Add boundary-attribution regressions**

Add real audit fixtures covering:

1. The same command/fingerprint at `l3-l4-only` and `l1-attested-boundary` appears as two candidates
   in `harvest list --all-cohorts`.
2. Applying with `--all-cohorts --boundary-profile l1-attested-boundary` writes that boundary, even
   when the active cohort is `l3-l4-only`.
3. Without the selector, the two-boundary match fails and writes neither ledger nor corpus.
4. With no active cohort, an all-cohort candidate with a recorded boundary can still be reviewed.
5. A review at one boundary hides only that candidate; the other boundary remains visible.
6. A legacy mixed-history candidate with no boundary remains visible but apply fails closed.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run src/__tests__/harvest.test.ts src/__tests__/harvest-review.test.ts
```

Expected: candidates collapse by fingerprint, apply records the active boundary, or selection has
no `--boundary-profile` support.

- [ ] **Step 3: Preserve boundary through aggregation**

Add `boundaryProfile?: string` to `ApprovalRoundTrip` and set it from the deny gate record. Change
candidate map keys to `fingerprint + NUL + kind + NUL + boundaryProfile`. Partition repeated-ask
calculation by recorded boundary so counts never merge across boundaries. In active-cohort mode,
fill a missing legacy boundary from the selected active cohort; in all-cohort mode leave it null.

Expose one review-key helper from `harvest-review.ts` and use it to filter candidates by exact
fingerprint/kind/boundary rather than fingerprint alone.

- [ ] **Step 4: Select and persist the candidate boundary**

Parse `--boundary-profile` only for `harvest apply`. Filter candidates by command, optional
fingerprint, and optional boundary. If more than one full review key remains, return guidance to
pass both `--fingerprint` and `--boundary-profile`. Reject null-boundary candidates. Persist
`candidate.boundaryProfile`; remove the requirement that `report.cohort` be non-null.

- [ ] **Step 5: Verify GREEN and mutation coverage**

Run:

```bash
pnpm exec vitest run src/__tests__/harvest.test.ts src/__tests__/harvest-review.test.ts src/__tests__/audit-query.test.ts src/__tests__/audit-metrics.test.ts
pnpm typecheck
```

Confirm replacing the persisted candidate boundary with the active boundary fails, and removing
boundary from the aggregation key fails.

- [ ] **Step 6: Commit**

```bash
git add src/core/audit-types.ts src/core/audit-query.ts src/core/harvest.ts src/core/harvest-review.ts src/commands/harvest.ts src/cli.ts src/__tests__/harvest.test.ts src/__tests__/harvest-review.test.ts
git commit -m "fix: bind harvest reviews to source boundaries"
```

---

### Task 3: Recover locks owned by crashed audit writers

**Files:**
- Modify: `src/core/audit-storage.ts`
- Modify: `src/__tests__/audit-storage.test.ts`
- Modify: `src/__tests__/audit-sink.test.ts`

**Interfaces:**
- Produces: lock owner JSON schema v1 with `pid`, `ownerToken`, and `acquiredAt`.
- Produces: inode-bound recovery claim at `<auditPath>.lock.reclaim`.
- Preserves: `withAuditStorageLock()` signature and 2,000 ms acquisition deadline.

- [ ] **Step 1: Add crash-recovery regressions**

Add tests that exercise the real lock path:

1. A valid lock record whose PID is reported absent is reclaimed, append succeeds, and lock/claim
   files are gone.
2. A live-owner record times out without changing either lock contents or audit file.
3. Empty, malformed, symlinked, oversized, and invalid-token records time out/fail closed without
   removal.
4. Two concurrent appenders facing one dead lock both finish with two complete lines and no claim.
5. A stale claim hard-linked to a different inode is cleaned without deleting the current lock.
6. Release does not unlink a path replaced with a different inode or owner token.

Extend the existing storage operation seam only where deterministic PID-liveness simulation is
required; assertions remain on real lock/audit filesystem effects rather than mock call counts.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run src/__tests__/audit-storage.test.ts src/__tests__/audit-sink.test.ts
```

Expected: dead-owner locks time out and no owner metadata or claim protocol exists.

- [ ] **Step 3: Write and validate lock ownership**

Create the lock with `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW`, write one bounded JSON line, sync,
and retain the handle. Validate schema, positive safe PID, UUID owner token, ISO timestamp, regular
file shape, maximum 1 KiB size, and handle/path inode identity. Treat `process.kill(pid, 0)` success
or `EPERM` as alive, `ESRCH` as absent, and every other result as unknown.

- [ ] **Step 4: Add inode-bound reclaim**

On a proven absent owner, create `<lock>.reclaim` with `link(lockPath, claimPath)`. The winner opens
the claim no-follow, checks claim/open-lock/path identities and owner tokens, rechecks PID absence,
then unlinks only the matching lock inode. Remove the claim in `finally`. If an existing claim is a
different inode from the current lock, remove only the claim and retry; same-inode unverifiable
claims remain fail-closed until timeout.

Before normal release, reread the bounded owner record and require both inode and token equality.

- [ ] **Step 5: Verify GREEN and mutation coverage**

Run:

```bash
pnpm exec vitest run src/__tests__/audit-storage.test.ts src/__tests__/audit-sink.test.ts src/__tests__/audit-legacy-archive.test.ts
pnpm typecheck
```

Confirm removing the final PID recheck or token comparison fails a regression.

- [ ] **Step 6: Commit**

```bash
git add src/core/audit-storage.ts src/__tests__/audit-storage.test.ts src/__tests__/audit-sink.test.ts
git commit -m "fix: recover crashed audit writer locks safely"
```

---

### Task 4: Document public behavior and centralize provenance types

**Files:**
- Modify: `src/types.ts`
- Modify: `src/core/config-layers.ts`
- Modify: `README.md`
- Modify: `docs/ops/releasing.md`
- Modify: `docs/ops/pr-118-remaining-follow-ups.md`
- Modify: `docs/CONTEXT.md`
- Test: `src/__tests__/config-layers.test.ts`

**Interfaces:**
- Produces: one exported `ConfigLayerSource` type in `src/types.ts` used by config layering and
  doctor provenance.
- Documents: linked-worktree config inheritance, boundary-qualified harvest review, repaired
  readiness behavior, lock recovery posture, and post-publish target checks.

- [ ] **Step 1: Centralize config provenance type**

Move the union below to `src/types.ts` and import it into `config-layers.ts`:

```ts
export type ConfigLayerSource = 'builtin' | 'team' | 'repo' | 'inherited' | 'protected'
```

Type `ConfigProvenanceNote.source` with `ConfigLayerSource`. Run:

```bash
pnpm exec vitest run src/__tests__/config-layers.test.ts src/__tests__/doctor.test.ts
pnpm typecheck
```

- [ ] **Step 2: Document config inheritance and harvest**

Add concise README sections covering every item in spec section 4. Include complete command forms
for active and forensic listing/apply, explain when `--boundary-profile` is required, enumerate the
four review outcomes, and state that review state is evidence-only.

- [ ] **Step 3: Repair release ordering and close follow-ups**

Keep only the Belay source-build helper in the pre-release checklist. Move shared-cutoff selection,
authorized target upgrade, and `npx -y @guilz-dev/belay@<version> dogfood --check` into post-release
verification in that order. Require each result in the release PR. Mark PR #118 P0/P1 complete with
the implementing commit references while retaining the original problem statement.

- [ ] **Step 4: Update domain invariant and verify docs**

Extend `docs/CONTEXT.md` audit/readiness invariant with retained-evidence reconstruction and exact
boundary-qualified harvest review. Run:

```bash
pnpm lint
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/core/config-layers.ts README.md docs/ops/releasing.md docs/ops/pr-118-remaining-follow-ups.md docs/CONTEXT.md
git commit -m "docs: complete recent review remediation"
```

---

### Task 5: Run full quality gates and prepare the branch

**Files:**
- Modify only files required by failures caused by Tasks 1-4.

**Interfaces:**
- Consumes: all prior task commits.
- Produces: a reviewable branch with all repository gates green.

- [ ] **Step 1: Run full verification**

Run each command and retain its exact result in the task report:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:structural
pnpm corpus
pnpm probe:adversarial -- --strict
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Repair only introduced failures**

For any failure, identify the exact failing assertion or diagnostic, add or adjust the smallest
covering test when behavior changes, make the minimal fix, and rerun the failed command plus its
focused suite. Do not change authorization or weaken a hard gate.

- [ ] **Step 3: Commit verification-only fixes if any**

```bash
git add -u
git commit -m "fix: address remediation verification failures"
```

If no files changed, record that no verification-fix commit was needed.
