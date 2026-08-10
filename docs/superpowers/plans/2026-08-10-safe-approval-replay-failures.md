# Safe Approval Replay Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent replay diagnostics from leaking raw output, report unconfirmed container cleanup accurately, and reject timed-out commands even when they exit with code zero.

**Architecture:** Keep bounded process output internal. Define a structural cleanup-error contract in the boundary layer, have the container driver throw it when cleanup cannot be confirmed, and let gate runtime convert only validated structured fields into agent-facing messages. Gate runtime treats success as zero exit plus no timeout and consumes the one-shot approval on every attempted replay.

**Tech Stack:** TypeScript 5.9, Node.js 22 child processes, Vitest 3, pnpm 10, Biome.

## Global Constraints

- Raw `stdout`, `stderr`, thrown exception messages, approval-store errors, and audit errors must never be copied into replay-lifecycle `user_message` values.
- Success requires `exitCode === 0 && timedOut === false`.
- Cleanup failure code is exactly `BOUNDARY_CLEANUP_UNCONFIRMED` and audit reason is exactly `approval_replay_cleanup_unconfirmed`.
- Only container identifiers matching `belay-run-<UUID>` may be displayed.
- One-shot approvals stay consumed after success, ordinary failure, timeout, startup failure, or cleanup failure.
- No new diagnostic persistence, credential-pattern catalog, dependency, or execution-policy change.

---

### Task 1: Boundary cleanup error contract

**Files:**
- Modify: `src/core/capability/boundary-run.ts`
- Modify: `src/core/capability/boundary-driver-container.ts`
- Test: `src/__tests__/capability/boundary-run.test.ts`
- Test: `src/__tests__/capability/boundary-driver-container.test.ts`

**Interfaces:**
- Produces: `BoundaryCleanupError`, `isBoundaryCleanupError(value: unknown)`, and `safeBoundaryCleanupResourceId(value: unknown): string | undefined`.
- Produces: container-driver rejection with `code === 'BOUNDARY_CLEANUP_UNCONFIRMED'` after a started timed-out container cannot be confirmed absent.

- [ ] **Step 1: Write failing contract tests**

Add tests that structurally recognize the cleanup error independently of `instanceof`, return `belay-run-123e4567-e89b-42d3-a456-426614174000` from the safe formatter, omit `attacker-controlled\ntext`, and still recognize the invalid-ID object as cleanup-unconfirmed.

```ts
const cleanup = {
  code: 'BOUNDARY_CLEANUP_UNCONFIRMED',
  resourceKind: 'container',
  resourceId: 'belay-run-123e4567-e89b-42d3-a456-426614174000',
  executionStarted: true,
  cleanupConfirmed: false,
}
expect(isBoundaryCleanupError(cleanup)).toBe(true)
expect(safeBoundaryCleanupResourceId(cleanup)).toBe(cleanup.resourceId)
expect(isBoundaryCleanupError({ ...cleanup, resourceId: 'attacker-controlled\ntext' })).toBe(true)
expect(safeBoundaryCleanupResourceId({ ...cleanup, resourceId: 'attacker-controlled\ntext' })).toBeUndefined()
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `pnpm exec vitest run src/__tests__/capability/boundary-run.test.ts`

Expected: FAIL because the three exported cleanup-contract symbols do not exist.

- [ ] **Step 3: Implement the minimal structural contract**

Add the error class and structural type guard to `boundary-run.ts`. The type guard checks discriminator, resource kind, and boolean state only; the formatter separately checks the exact lowercase UUID container-name pattern.

```ts
export class BoundaryCleanupError extends Error {
  readonly code = 'BOUNDARY_CLEANUP_UNCONFIRMED' as const
  readonly executionStarted = true as const
  readonly cleanupConfirmed = false as const

  constructor(
    readonly resourceKind: 'container',
    readonly resourceId: string,
  ) {
    super('Boundary cleanup could not be confirmed')
    this.name = 'BoundaryCleanupError'
  }
}
```

- [ ] **Step 4: Make the container driver throw the typed error**

Replace the generic cleanup error factory with `new BoundaryCleanupError('container', containerName)` and update the fake-Docker test to assert the structural fields instead of matching error prose.

- [ ] **Step 5: Run Task 1 tests and verify GREEN**

Run: `pnpm exec vitest run src/__tests__/capability/boundary-run.test.ts src/__tests__/capability/boundary-driver-container.test.ts`

Expected: PASS, with Docker-required tests allowed to remain skipped when Docker is unavailable.

---

### Task 2: Safe and accurate approval replay outcomes

**Files:**
- Modify: `src/adapters/shared/gate-runtime.ts`
- Test: `src/__tests__/approval-prompt-replay-fallback.test.ts`

**Interfaces:**
- Consumes: `isBoundaryCleanupError` and `safeBoundaryCleanupResourceId` from Task 1.
- Produces: agent-facing replay messages containing structured Belay facts only.

- [ ] **Step 1: Write failing output-confidentiality tests**

Change the replay-output test to use `remote rejected credential ghp_abcdefghijklmnopqrstuvwxyz0123456789AB` and assert the entire raw value and `Replay stderr:` are absent. Change the thrown-startup and audit-failure tests to assert their exception messages are absent while fixed guidance remains.

- [ ] **Step 2: Write failing timeout outcome test**

Inject `{ exitCode: 0, signal: null, timedOut: true }`; assert `continue === false`, the message says timed out and not succeeded, captured audits contain `approval_replay_failed` but not `approval_replay_succeeded`, and a recheck does not receive `approved_once`.

- [ ] **Step 3: Write failing cleanup outcome tests**

Throw a structural cleanup error with a valid generated ID and assert `continue === false`, execution-started and cleanup-unconfirmed guidance, the safe ID, `approval_replay_cleanup_unconfirmed`, and no one-shot reuse. Repeat with an invalid ID and assert the same classification without echoing the ID.

- [ ] **Step 4: Run approval tests and verify RED**

Run: `pnpm exec vitest run src/__tests__/approval-prompt-replay-fallback.test.ts`

Expected: FAIL because current code exposes scrubbed/raw diagnostics, treats timed-out zero exit as success, and reports cleanup errors as startup failures.

- [ ] **Step 5: Implement minimal gate-runtime branches**

Remove `replayFailureSummary` and its judge-scrubber import. Remove exception detail from claim, replay-start, and audit-failure messages. In the replay catch, detect cleanup errors first, write `approval_replay_cleanup_unconfirmed`, include only `safeBoundaryCleanupResourceId(error)`, and say the execution started and the container may still be running. Change success to:

```ts
if (replayResult.exitCode === 0 && !replayResult.timedOut) {
```

Wrap replay-outcome audit writes so an audit failure adds fixed local-inspection guidance without exception text.

- [ ] **Step 6: Run approval tests and verify GREEN**

Run: `pnpm exec vitest run src/__tests__/approval-prompt-replay-fallback.test.ts`

Expected: PASS.

---

### Task 3: Integration verification and implementation commit

**Files:**
- Verify all modified and new files shown by `git status --short`.
- Include: `src/core/process-runner.ts`, `src/core/transactional/git-worktree.ts`, container driver/tests, gate runtime/tests, and the existing Phase 3 deterministic transport-test stabilization.

**Interfaces:**
- Consumes: Task 1 and Task 2 production contracts.
- Produces: a buildable, tested implementation commit without staging unrelated files.

- [ ] **Step 1: Run formatting and static checks**

Run: `pnpm exec biome check src/core/process-runner.ts src/core/capability/boundary-run.ts src/core/capability/boundary-driver-container.ts src/core/transactional/git-worktree.ts src/adapters/shared/gate-runtime.ts src/__tests__/approval-prompt-replay-fallback.test.ts src/__tests__/capability/boundary-run.test.ts src/__tests__/capability/boundary-driver-container.test.ts`

Run: `pnpm typecheck`

Expected: both commands exit 0.

- [ ] **Step 2: Run the complete test suite**

Run: `pnpm test`

Expected: exit 0; Docker integration tests may be skipped only when Docker is unavailable.

- [ ] **Step 3: Inspect the final patch**

Run: `git diff --check`, `git status --short`, and focused `git diff` for every implementation file. Confirm raw replay output is not copied into `user_message`, timeout success checks `!timedOut`, cleanup errors use the stable code, and the untracked process runner is included.

- [ ] **Step 4: Commit the implementation**

Stage only the implementation and test files present in the reviewed uncommitted change set, then commit:

```bash
git commit -m "fix: harden approval replay failures"
```
