# One-shot Approval Lifecycle Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract one-shot approval state transitions from the shared gate runtime into a pure, directly tested lifecycle module without changing authorization, persistence, audit, replay, or adapter behavior.

**Architecture:** `gate-runtime.ts` remains the host-facing application coordinator. `approval-service.ts` coordinates atomic persistence through the existing `ApprovalStore`, while `one-shot-approval-lifecycle.ts` computes deterministic state transitions from explicit state and time inputs. Standalone `CapabilityGrantV1` consumption remains a separate path and keeps its existing precedence after `approved_once`.

**Tech Stack:** TypeScript 5.9, Node.js 22, Vitest 3, pnpm 10, Biome 2

**Spec:** `docs/superpowers/specs/2026-09-09-one-shot-approval-lifecycle-refactor-design.md`

## Global Constraints

- Preserve `EffectPlan` and `PolicyDecision` authority exactly as documented by ADR-004.
- Preserve the pending and approved approval JSON schemas and their revision/locking behavior.
- Preserve all exports currently exposed through `src/core/approval-service.ts` and `src/core/index.ts`.
- Preserve audit fields, event ordering, notification ordering, approval IDs, user messages, agent messages, and adapter responses byte-for-byte unless an existing test normalizes them.
- Preserve `approved_once` precedence over standalone `capability_grant` consumption.
- Keep the new lifecycle module free of config I/O, adapters, commands, services, audit, notifications, Node filesystem, and process dependencies.
- Do not refactor config, contained execution, transactional execution, CLI parsing, doctor, or standalone capability-grant consumption.
- Follow strict red-green-refactor: every new production function is first referenced by a test that fails for the expected missing-function or missing-module reason.

---

### Task 1: Add deterministic approval compaction

**Files:**
- Modify: `src/core/approval.ts`
- Modify: `src/core/capability/grant-lease.ts`
- Modify: `src/__tests__/approval.test.ts`
- Modify: `src/__tests__/capability/grant-lease.test.ts`

**Interfaces:**
- Produces: `compactApprovalsAt(state: ApprovalStateFile, nowMs: number): ApprovalStateFile`
- Extends: `consumeApprovedRecordGrantBundle(approval, nowMs?: number)`
- Preserves: `compactApprovals(state: ApprovalStateFile): ApprovalStateFile`

- [ ] **Step 1: Write the failing fixed-time compaction test**

Add an import for `compactApprovalsAt` and a test using literal timestamps. The production change this catches is accidentally making lifecycle outcomes depend on wall-clock time.

```ts
it('compacts expiry and execution leases at an explicit instant', () => {
  const state: ApprovalStateFile = {
    version: 3,
    revision: 7,
    approvals: [
      approvalRecord({ approvalId: 'expired', expiresAt: '2026-09-09T00:00:00.000Z' }),
      approvalRecord({
        approvalId: 'lease-expired',
        expiresAt: '2026-09-11T00:00:00.000Z',
        executionLeaseExpiresAt: '2026-09-09T12:00:00.000Z',
      }),
      approvalRecord({ approvalId: 'active', expiresAt: '2026-09-11T00:00:00.000Z' }),
    ],
  }

  expect(compactApprovalsAt(state, Date.parse('2026-09-10T00:00:00.000Z'))).toEqual({
    version: 3,
    revision: 7,
    approvals: [approvalRecord({ approvalId: 'active', expiresAt: '2026-09-11T00:00:00.000Z' })],
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/approval.test.ts
```

Expected: FAIL because `compactApprovalsAt` is not exported.

- [ ] **Step 3: Implement explicit-time predicates and preserve the public wrapper**

Refactor the current predicates so production callers retain wall-clock behavior while the lifecycle can supply a fixed time.

```ts
function isExpiredAt(approval: ApprovalRecord, nowMs: number): boolean {
  const expiresAt = Date.parse(approval.expiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs
}

function isExecutionLeaseExpiredAt(approval: ApprovalRecord, nowMs: number): boolean {
  if (!approval.executionLeaseExpiresAt) return false
  const expiresAt = Date.parse(approval.executionLeaseExpiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs
}

export function compactApprovalsAt(
  state: ApprovalStateFile,
  nowMs: number,
): ApprovalStateFile {
  const compacted: ApprovalStateFile = {
    version: state.version,
    approvals: state.approvals.filter(
      (approval) =>
        !isExpiredAt(approval, nowMs) && !isExecutionLeaseExpiredAt(approval, nowMs),
    ),
  }
  if (state.revision !== undefined) compacted.revision = state.revision
  return compacted
}

export function compactApprovals(state: ApprovalStateFile): ApprovalStateFile {
  return compactApprovalsAt(state, Date.now())
}
```

Keep `isExpired()` and `isExecutionLeaseExpired()` as compatibility wrappers over the new private predicates.

- [ ] **Step 4: Make legacy bundle replay use the supplied clock**

Add a failing grant-lease test that passes an instant after a grant's expiry and asserts
`consumed: false`, without relying on the wall clock. Then add the optional parameter while
preserving every existing caller:

```ts
export function consumeApprovedRecordGrantBundle(
  approval: ApprovalRecord,
  now = Date.now(),
): { approval: ApprovalRecord; consumed: boolean }
```

Expected RED before the implementation: the expired fixed-time grant is consumed because the
second argument is ignored. Expected GREEN after the implementation: it is rejected.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run src/__tests__/approval.test.ts src/__tests__/capability/grant-lease.test.ts src/__tests__/approval-service.test.ts
```

Expected: both files PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/approval.ts src/core/capability/grant-lease.ts src/__tests__/approval.test.ts src/__tests__/capability/grant-lease.test.ts
git commit -m "refactor: make approval compaction deterministic"
```

### Task 2: Extract pending and recording transitions

**Files:**
- Create: `src/core/one-shot-approval-lifecycle.ts`
- Create: `src/__tests__/one-shot-approval-lifecycle.test.ts`

**Interfaces:**
- Consumes: `compactApprovalsAt`, `ApprovalRecord`, `ApprovalStateFile`
- Produces: `ensurePendingApprovalTransition(params): PendingApprovalTransition`
- Produces: `recordApprovalTransition(params): RecordedApprovalTransition | null`

- [ ] **Step 1: Write failing tests for pending deduplication and recording**

Create fixed record fixtures and verify literal outcomes. The tests must prove that duplicate pending records reuse the existing ID and that recording removes pending state before publishing exactly one approved grant.

```ts
const NOW = Date.parse('2026-09-09T00:00:00.000Z')
const APPROVED_AT = '2026-09-09T00:00:01.000Z'

it('reuses the existing pending approval for the same action identity', () => {
  const existing = approvalRecord({ approvalId: 'belay_existing' })
  const candidate = approvalRecord({ approvalId: 'belay_candidate' })
  const outcome = ensurePendingApprovalTransition({
    state: { version: 3, revision: 4, approvals: [existing] },
    candidate,
    nowMs: NOW,
  })

  expect(outcome.created).toBe(false)
  expect(outcome.approval.approvalId).toBe('belay_existing')
  expect(outcome.state.approvals).toHaveLength(1)
})

it('moves one matching pending approval into approved state', () => {
  const pendingRecord = approvalRecord({
    approvalId: 'belay_pending',
    capabilityRequests: [capabilityRequestFixture],
  })
  const outcome = recordApprovalTransition({
    pending: { version: 3, approvals: [pendingRecord] },
    approved: { version: 3, approvals: [] },
    approvalId: 'belay_pending',
    approvedAt: APPROVED_AT,
    nowMs: NOW,
  })

  expect(outcome?.pending.approvals).toEqual([])
  expect(outcome?.approved.approvals).toHaveLength(1)
  expect(outcome?.approval.approvedAt).toBe(APPROVED_AT)
  expect(outcome?.approval.grantBundleVersion).toBe(1)
})
```

Also cover: new pending insertion, same approved ID with mismatched identity returning `null`, already-approved idempotency, missing/expired pending returning `null`, and no mutation of input fixtures.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/one-shot-approval-lifecycle.test.ts
```

Expected: FAIL because `one-shot-approval-lifecycle.ts` does not exist.

- [ ] **Step 3: Implement the two pure transitions**

Use discriminated result types and the current match key exactly.

```ts
export interface PendingApprovalTransition {
  state: ApprovalStateFile
  approval: ApprovalRecord
  created: boolean
}

export function ensurePendingApprovalTransition(params: {
  state: ApprovalStateFile
  candidate: ApprovalRecord
  nowMs: number
}): PendingApprovalTransition

export interface RecordedApprovalTransition {
  pending: ApprovalStateFile
  approved: ApprovalStateFile
  approval: ApprovalRecord
}

export function recordApprovalTransition(params: {
  pending: ApprovalStateFile
  approved: ApprovalStateFile
  approvalId: string
  approvedAt: string
  nowMs: number
}): RecordedApprovalTransition | null
```

Implement with `compactApprovalsAt()` and `mintGrantForApprovedRecord()`. Clone arrays before splice/push so callers' fixtures and loaded state are not mutated.

- [ ] **Step 4: Run lifecycle tests and verify GREEN**

Run:

```bash
pnpm vitest run src/__tests__/one-shot-approval-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/one-shot-approval-lifecycle.ts src/__tests__/one-shot-approval-lifecycle.test.ts
git commit -m "refactor: extract one-shot approval state transitions"
```

### Task 3: Extract gate claim, replay claim, and discard transitions

**Files:**
- Modify: `src/core/one-shot-approval-lifecycle.ts`
- Modify: `src/__tests__/one-shot-approval-lifecycle.test.ts`

**Interfaces:**
- Produces: `claimApprovedForGateTransition(params): ApprovedGateClaimTransition`
- Produces: `claimApprovedForReplayTransition(params): ApprovedReplayClaimTransition`
- Produces: `discardApprovedTransition(params): DiscardApprovedTransition`

- [ ] **Step 1: Write failing gate-claim tests**

Add fixed tests for first execution, lease reuse, exhausted approval removal, and invalid exact bundle removal.

```ts
it('consumes the exact bundle once and establishes the supplied execution lease', () => {
  const approved = approvedRecordWithExactBundle({ usesRemaining: 1 })
  const outcome = claimApprovedForGateTransition({
    state: { version: 3, approvals: [approved] },
    kind: 'shell',
    fingerprint: approved.fingerprint,
    repoRoot: approved.repoRoot,
    requests: approved.capabilityRequests ?? [],
    executionLeaseExpiresAt: '2026-09-09T00:00:30.000Z',
    nowMs: NOW,
  })

  expect(outcome.result?.status).toBe('consumed')
  expect(outcome.result?.status === 'consumed' && outcome.result.firstExecution).toBe(true)
  expect(outcome.state.approvals[0]?.executionLeaseExpiresAt).toBe(
    '2026-09-09T00:00:30.000Z',
  )
})
```

For lease reuse, assert `firstExecution: false` and unchanged grant use count. For invalid bundle,
assert `status: 'invalid_bundle'` with the literal failure reason and an empty approved state.

- [ ] **Step 2: Write failing replay and discard tests**

```ts
it('removes an approved record before replay', () => {
  const approved = approvalRecord({ approvalId: 'belay_replay', approvedAt: APPROVED_AT })
  const outcome = claimApprovedForReplayTransition({
    state: { version: 3, approvals: [approved] },
    approvalId: 'belay_replay',
    nowMs: NOW,
  })

  expect(outcome.approval?.approvalId).toBe('belay_replay')
  expect(outcome.state.approvals).toEqual([])
})

it('discards only the rejected approved record', () => {
  const rejected = approvalRecord({ approvalId: 'belay_rejected', approvedAt: APPROVED_AT })
  const retained = approvalRecord({ approvalId: 'belay_retained', approvedAt: APPROVED_AT })
  const outcome = discardApprovedTransition({
    state: { version: 3, approvals: [rejected, retained] },
    approvalId: 'belay_rejected',
    nowMs: NOW,
  })

  expect(outcome.discarded).toBe(true)
  expect(outcome.state.approvals.map((entry) => entry.approvalId)).toEqual(['belay_retained'])
})
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/one-shot-approval-lifecycle.test.ts
```

Expected: FAIL because the three transition functions are not exported.

- [ ] **Step 4: Implement gate claim with existing grant helpers**

Preserve the existing outcome contract:

```ts
export type ApprovedGateClaim =
  | { status: 'consumed'; approval: ApprovalRecord; firstExecution: boolean }
  | {
      status: 'invalid_bundle'
      approval: ApprovalRecord
      reason: GrantBundleValidationFailureReason
    }
  | null

export interface ApprovedGateClaimTransition {
  state: ApprovalStateFile
  result: ApprovedGateClaim
}
```

Copy the current order exactly: match, validate active lease, remove exhausted record, validate and
consume v1 bundle, consume normalized legacy bundle, decrement legacy single grant, then attach the
supplied lease expiry. Pass `nowMs` to both exact validation helpers and
`consumeApprovedRecordGrantBundle`. Do not import standalone `consumeGrantLeasesForRequests`.

- [ ] **Step 5: Implement replay and discard transitions**

```ts
export function claimApprovedForReplayTransition(params: {
  state: ApprovalStateFile
  approvalId: string
  nowMs: number
}): { state: ApprovalStateFile; approval: ApprovalRecord | null }

export function discardApprovedTransition(params: {
  state: ApprovalStateFile
  approvalId: string
  nowMs: number
}): { state: ApprovalStateFile; discarded: boolean }
```

Both functions compact at `nowMs`, copy the approval array, and remove at most one exact ID.

- [ ] **Step 6: Run lifecycle tests and verify GREEN**

Run:

```bash
pnpm vitest run src/__tests__/one-shot-approval-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/one-shot-approval-lifecycle.ts src/__tests__/one-shot-approval-lifecycle.test.ts
git commit -m "refactor: model one-shot approval claims"
```

### Task 4: Route approval use cases through the lifecycle

**Files:**
- Modify: `src/core/approval-service.ts`
- Modify: `src/__tests__/approval-service.test.ts`

**Interfaces:**
- Consumes: all lifecycle transitions from Tasks 2 and 3
- Produces: `ensurePendingOneShotApproval(params)`
- Produces: `claimApprovedForGate(params)`
- Produces: `discardApprovedOneShotApproval(params)`
- Preserves: `recordApproval(params)` and `claimApprovedForReplay(params)` signatures

- [ ] **Step 1: Write failing service tests over the real in-memory store**

Add imports for the three new service functions. Verify observable persisted state, not calls on the
store double.

```ts
it('persists one pending approval for duplicate ensure requests', async () => {
  const pending: ApprovalStateFile = { version: 3, approvals: [] }
  const store = memoryStore(pending)
  const params = {
    candidate: approvalRecord({ approvalId: 'belay_candidate' }),
    store,
  }

  const first = await ensurePendingOneShotApproval(params)
  const second = await ensurePendingOneShotApproval({
    candidate: approvalRecord({ approvalId: 'belay_other' }),
    store,
  })

  expect(first.created).toBe(true)
  expect(second.created).toBe(false)
  expect(second.approval.approvalId).toBe('belay_candidate')
  expect(pending.approvals).toHaveLength(1)
})
```

Also test that `claimApprovedForGate` persists the execution lease and that
`discardApprovedOneShotApproval` removes only its target.

- [ ] **Step 2: Run approval-service tests and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/approval-service.test.ts
```

Expected: FAIL because the new service functions are not exported.

- [ ] **Step 3: Refactor existing service functions onto pure transitions**

Replace the mutation bodies inside `recordApproval` and `claimApprovedForReplay` with calls to
`recordApprovalTransition` and `claimApprovedForReplayTransition`. Capture one `nowMs` per use case
and derive `approvedAt` from it so one operation cannot observe multiple clocks.

- [ ] **Step 4: Implement pending, gate-claim, and discard use cases**

Use these signatures:

```ts
export async function ensurePendingOneShotApproval(params: {
  candidate: ApprovalRecord
  store: ApprovalStore
}): Promise<{ approval: ApprovalRecord; created: boolean }>

export async function claimApprovedForGate(params: {
  kind: ApprovalRecord['kind']
  fingerprint: string
  repoRoot: string
  requests: CapabilityRequestV1[]
  executionLeaseMs: number
  store: ApprovalStore
}): Promise<ApprovedGateClaim>

export async function discardApprovedOneShotApproval(params: {
  approvalId: string
  store: ApprovalStore
}): Promise<void>
```

`claimApprovedForGate` computes one `nowMs` and one ISO lease expiry. If the mutation helper returns
`null` because persistence could not commit, return `null` exactly as the current gate helper does.
`discardApprovedOneShotApproval` retains the current exception on failed persistence.

- [ ] **Step 5: Run service and replay suites and verify GREEN**

Run:

```bash
pnpm vitest run src/__tests__/approval-service.test.ts src/__tests__/approve-replay.test.ts src/__tests__/approval-prompt-replay-fallback.test.ts
```

Expected: all files PASS with unchanged messages and replay outcomes.

- [ ] **Step 6: Commit**

```bash
git add src/core/approval-service.ts src/__tests__/approval-service.test.ts
git commit -m "refactor: centralize one-shot approval use cases"
```

### Task 5: Remove one-shot approval transitions from gate runtime

**Files:**
- Modify: `src/adapters/shared/gate-runtime.ts`
- Create: `src/__tests__/one-shot-approval-boundary.test.ts`

**Interfaces:**
- Consumes: `ensurePendingOneShotApproval`, `claimApprovedForGate`, `discardApprovedOneShotApproval`
- Preserves: `evaluateGatedAction`, `processApprovalPrompt`, `GateRuntimeDeps`, and every host response mapper

- [ ] **Step 1: Write the failing architecture boundary test**

This fitness test catches a future production bug where gate orchestration starts mutating approval
state directly again.

```ts
it('keeps one-shot approval transition primitives outside the gate runtime', async () => {
  const gateRuntime = await readFile(
    path.join(REPO_ROOT, 'src/adapters/shared/gate-runtime.ts'),
    'utf8',
  )
  for (const forbidden of [
    /ApprovalConsumeMutationResult/,
    /approvalGrantBundleExhausted/,
    /consumeApprovedRecordGrantBundle/,
    /decrementApprovalLegacyGrant/,
    /validateAndConsumeGrantBundle/,
    /validateGrantBundleForLeaseReuse/,
  ]) {
    expect(gateRuntime, `one-shot transition primitive ${forbidden}`).not.toMatch(forbidden)
  }
})

it('keeps the pure lifecycle free of outer-layer dependencies', async () => {
  const lifecycle = await readFile(
    path.join(REPO_ROOT, 'src/core/one-shot-approval-lifecycle.ts'),
    'utf8',
  )
  for (const forbidden of [
    /node:(?:fs|process)/,
    /config-io/,
    /adapters\//,
    /commands\//,
    /services\//,
    /audit/,
    /notify/,
  ]) {
    expect(lifecycle, `forbidden dependency ${forbidden}`).not.toMatch(forbidden)
  }
})
```

- [ ] **Step 2: Run the boundary test and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/one-shot-approval-boundary.test.ts
```

Expected: the first test FAILS because `gate-runtime.ts` still owns the one-shot claim type and
grant-bundle transition helpers. The standalone `consumeCapabilityGrantIfUsed` mutation is allowed
to remain and must not be changed by this task.

- [ ] **Step 3: Replace pending persistence**

Keep candidate creation, approval ID generation, EffectPlan hashing, and scope-hint derivation in
the gate flow. Pass the candidate and `gateApprovalStoreFromDeps(...)` to
`ensurePendingOneShotApproval`. Run the gate runtime and conformance suites immediately.

```bash
pnpm vitest run src/__tests__/verdict/gate-runtime.test.ts src/__tests__/conformance/adapters.test.ts
```

- [ ] **Step 4: Replace approved claim and discard persistence**

Call `claimApprovedForGate` with the current kind, fingerprint, repository, capability requests,
and `getExecutionLeaseMs(ctx.config)`. Call `discardApprovedOneShotApproval` for replay-envelope,
EffectPlan, capability-request, and invalid-bundle rejection paths. Remove the superseded private
one-shot mutation helpers and grant-lease imports used only by those helpers. Retain
`mutateApprovalStateWithRetry`, `consumeGrantLeasesForRequests`, and `compactApprovals` while they
are still used by the separate standalone capability-grant path.

- [ ] **Step 5: Run the boundary and approval integration suites and verify GREEN**

Run:

```bash
pnpm vitest run src/__tests__/one-shot-approval-boundary.test.ts src/__tests__/capability-gate-runtime.test.ts src/__tests__/approval-prompt-replay-fallback.test.ts src/__tests__/conformance/adapters.test.ts src/__tests__/transactional-gate-runtime.test.ts
```

Expected: all files PASS. In particular, existing tests must retain `approved_once` precedence,
broker-active outside-repository denial, replay mismatch replacement, and consume-before-replay.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/shared/gate-runtime.ts src/__tests__/one-shot-approval-boundary.test.ts
git commit -m "refactor: delegate gate approval lifecycle"
```

### Task 6: Verify public compatibility and all safety gates

**Files:**
- Modify only if required by verification: `src/core/index.ts`
- Modify: `docs/superpowers/specs/2026-09-09-one-shot-approval-lifecycle-refactor-design.md`

**Interfaces:**
- Preserves: all pre-refactor public approval exports
- Verifies: full repository behavior and corpus decisions

- [ ] **Step 1: Confirm the stable export surface**

No lifecycle transition is exported publicly. Confirm these existing exports still compile:

```ts
import type { ApprovalStore } from './approval-service.js'
export {
  claimApprovedForReplay,
  consumeApprovedAfterCliReplay,
  createGateApprovalStore,
  gateApprovalStoreFromDeps,
  recordApproval,
} from './approval-service.js'
```

- [ ] **Step 2: Run formatting and static verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm build
```

Expected: exit 0 for all commands. Existing lint warnings may remain only if they are unchanged from
baseline; new warnings are failures.

- [ ] **Step 3: Run focused structural and corpus gates**

Run:

```bash
pnpm test:structural:run
pnpm corpus
```

Expected: exit 0 with no ASK-to-ALLOW corpus regression.

- [ ] **Step 4: Run the complete test suite**

Run:

```bash
pnpm test:run
```

Expected baseline: at least 194 test files pass, at least 2,876 tests pass, and only the two existing
tests are skipped. New lifecycle and boundary tests increase the passing counts.

- [ ] **Step 5: Inspect the final diff and requirements**

Run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short
```

Confirm every acceptance criterion from the spec maps to a passing test or an inspected unchanged
contract. Confirm no unrelated file changed.

- [ ] **Step 6: Commit final compatibility adjustments if any**

If Task 6 required tracked changes, commit only those files:

```bash
git add src/core/index.ts docs/superpowers/specs/2026-09-09-one-shot-approval-lifecycle-refactor-design.md
git commit -m "docs: record approval lifecycle verification baseline"
```
