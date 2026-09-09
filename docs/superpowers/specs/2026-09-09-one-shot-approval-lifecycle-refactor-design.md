# One-shot Approval Lifecycle Refactor Design

Date: 2026-09-09
Status: Approved for implementation planning

## Purpose

Reduce regression risk in the shared gate runtime by moving one-shot approval state transitions
behind an explicit, testable boundary. This is a behavior-preserving refactor: it does not change
authorization policy, public APIs, persisted schemas, audit events, operator messages, or host
adapter responses.

The refactor is deliberately narrower than a general reorganization of `src/core`,
`src/adapters`, and `src/services`. Belay does not yet enforce a software-layer dependency model,
so introducing a partial directory hierarchy for Domain/Application/Infrastructure would create a
second, competing structure. The first step is to establish a clean logical boundary that can be
moved later without changing behavior.

## Architectural context

ADR-001 defines L1 through L4 as **enforcement layers**: where Belay obtains a security guarantee.
They are independent of the software architecture layers that may later organize code and
dependencies.

| Axis | Question answered |
| --- | --- |
| L1–L4 enforcement | Where and how is an action constrained or approved? |
| Domain/Application/Infrastructure | Which code owns rules, orchestration, and external I/O? |

This refactor must preserve the existing L4 approval behavior and its interactions with L1/L2
boundary execution and L3 prediction. It must not reinterpret an `EffectPlan`, a `PolicyDecision`,
or a `CapabilityGrantV1`.

## Domain language

The canonical term for this scope is **one-shot approval**, not generic approval. A one-shot
approval authorizes one exact, previously denied action. It is separate from a
`CapabilityGrantV1`, which authorizes a normalized principal/action/resource request under its own
scope, expiry, and use-count contract.

An **execution lease** is the short-lived marker used when an approved action is claimed for host
execution. A retry within the lease must not spend the same approval twice. A replay claim removes
the approved record before execution and never re-arms it after failure.

Belay remains a single documented authorization context for this refactor. The one-shot approval
lifecycle is a module within that context, not a new bounded context.

## Current problem

`src/adapters/shared/gate-runtime.ts` currently owns all of the following:

- gate classification orchestration;
- pending approval creation and deduplication;
- approved record matching and execution leasing;
- grant-bundle validation during an approved retry;
- invalid or mismatched approval removal;
- capability-grant consumption ordering;
- audit construction, notification, user messages, and host response mapping;
- approval-prompt replay orchestration.

The state-transition rules are interleaved with host-facing application flow. A change to approval
storage or leasing therefore requires editing the same function that preserves EffectPlan
authority, capability-grant precedence, audit semantics, and fail-closed responses.

There is already a useful seam: `src/core/approval-service.ts` defines `ApprovalStore` and owns
pending-to-approved recording and replay claims. The refactor completes that seam instead of
creating a second approval abstraction.

## Goals

1. Express one-shot approval state transitions as pure functions.
2. Keep persistence orchestration behind the existing `ApprovalStore` port.
3. Make `gate-runtime.ts` consume explicit lifecycle outcomes instead of mutating approval files.
4. Preserve the documented ordering in `docs/grant-consumption-paths.md`: an exact
   `approved_once` match is considered before `capability_grant` consumption.
5. Establish a dependency ratchet for the new lifecycle module without reorganizing unrelated
   code.
6. Make each transition directly testable without filesystem, adapter, audit, or process mocks.

## Non-goals

- Changing `EffectPlan`, `PolicyEngine`, policy reasons, or classification order.
- Combining one-shot approvals with `CapabilityGrantV1`.
- Changing pending or approved JSON schemas or paths.
- Renaming or removing stable exports from `src/core/index.ts`.
- Changing audit records, notification ordering, approval IDs, retry instructions, or host-facing
  messages.
- Moving all of `src/core` into new Domain/Application/Infrastructure directories.
- Introducing a new bounded context, repository framework, dependency-injection container, or
  class hierarchy.
- Refactoring contained execution, transactional execution, config, doctor, or CLI parsing.

## Responsibility boundary

The target collaboration is:

```text
Gate Runtime
  - classify and preserve EffectPlan authority
  - choose audit, notification, and host response
              |
              v
Approval Service
  - orchestrate one-shot approval use cases through ApprovalStore
       |                         |
       v                         v
One-shot Approval Lifecycle   ApprovalStore
  - compute deterministic      - load and atomically persist
    state transitions            existing approval state
    and typed outcomes
```

`CapabilityGrantV1` remains a parallel authorization path. The lifecycle module may validate the
exact grant bundle embedded in an approved one-shot record because that validation is part of
claiming that record. It must not consume standalone capability-grant leases; that remains the
separate `capability_grant` path described in `docs/grant-consumption-paths.md`.

## Components

### `src/core/one-shot-approval-lifecycle.ts`

This new module owns deterministic transitions over `ApprovalStateFile`. It has no imports from
`config-io`, `adapters`, `commands`, `services`, audit modules, notification modules, or Node file
APIs.

It receives time-dependent values such as `approvedAt` and `executionLeaseExpiresAt` as inputs.
It does not call `Date.now()` or generate approval IDs internally.

The module exposes transition functions for:

- ensuring a unique pending approval from an already-created candidate;
- recording a matching pending approval into approved state;
- claiming a matching approved record for gate execution;
- claiming an approved record for replay before execution starts;
- discarding an invalid or mismatched approved record.

Each transition returns the next state plus a discriminated outcome. Expected domain outcomes are
represented as values such as `not_found`, `consumed`, or `invalid_bundle`; exceptions are reserved
for violated programming or persistence contracts.

### `src/core/approval-service.ts`

This remains the application-facing approval service and compatibility surface. It:

- keeps the existing `ApprovalStore` interface and exported function signatures;
- invokes atomic store mutation helpers;
- delegates mutation callbacks to the pure lifecycle module;
- performs signed-token verification and constructs existing approval-recorded messages;
- supplies timestamps and execution-lease expiry values;
- converts failed persistence into the existing fail-closed results or exceptions.

The existing file-backed store factory remains in this file for this refactor. Moving it would add
directory churn without reducing gate regression risk. The lifecycle rules themselves remain
independent of that implementation, leaving a later move possible.

### `src/adapters/shared/gate-runtime.ts`

The gate runtime continues to own:

- classification and EffectPlan completion;
- broker-active skip rules;
- replay-envelope and exact-request validation flow;
- audit event construction and ordering;
- notifications;
- operator and agent messages;
- mapping lifecycle outcomes to `GateVerdict`;
- capability-grant consumption after the one-shot path;
- approval-prompt replay and boundary execution.

It no longer owns one-shot approval-state mutation callbacks. Existing private helpers for pending
creation, approved claim, and discard are replaced by approval-service calls. The separate
standalone capability-grant consumption callback remains in the gate runtime for this scope.
Scope-hint derivation remains in the gate runtime because it is derived from classifier and adapter
payload context, not approval state.

### Compatibility exports

`src/core/index.ts` keeps all existing approval exports. No new lifecycle primitive needs to be
publicly exported from the package. The pure transition module is an internal implementation seam.

## State transitions and invariants

```text
denied action
    -> pending (deduplicated by kind + fingerprint + repository)
    -> approved (human approval; exact record preserved)
    -> gate claim (execution lease established)
       or replay claim (record removed before execution)

invalid bundle / replay mismatch
    -> rejected approved record removed
    -> replacement pending approval created

expired / exhausted / missing
    -> no authorization
    -> ordinary fail-closed path
```

The following invariants are mandatory:

1. Pending creation is idempotent for the existing match key.
2. Pending-to-approved recording is atomic across both state files.
3. A replay claim spends the one-shot approval before execution begins.
4. Replay failure, timeout, or unconfirmed cleanup never re-arms the approval.
5. A first gate claim consumes the exact embedded grant bundle and establishes an execution lease.
6. A retry within the execution lease reports `firstExecution: false` and does not consume again.
7. An invalid exact bundle removes the rejected approved record before a replacement is requested.
8. Replay-envelope, capability-request, and EffectPlan mismatches preserve the current discard and
   replacement behavior.
9. Broker-active outside-repository rules continue to bypass `approved_once` where currently
   required.
10. Audit mode does not create pending approvals.
11. `approved_once` remains ahead of standalone `capability_grant` consumption.
12. Persistence ambiguity or failure remains fail-closed.

## SOLID alignment

- **Single Responsibility:** the lifecycle computes state changes; the service coordinates
  persistence; the gate runtime handles authorization flow and presentation.
- **Open/Closed:** a new one-shot state outcome can be added in the lifecycle without rewriting
  classifier or adapter normalization code.
- **Liskov Substitution:** production and in-memory `ApprovalStore` implementations must produce
  identical lifecycle behavior.
- **Interface Segregation:** the existing narrow approval-state port is retained; no broad runtime
  dependency object is passed into the lifecycle.
- **Dependency Inversion:** lifecycle rules depend only on approval state types. Store-driven use
  cases depend on `ApprovalStore`, not on gate-runtime dependencies. The compatibility file-store
  factory remains an explicitly documented infrastructure coupling in `approval-service.ts` until
  a repository-wide software-layer migration defines its permanent location.

## Regression-prevention strategy

### Characterization before movement

Before removing logic from `gate-runtime.ts`, tests must lock the observable behavior for:

- pending deduplication and stable approval ID reuse;
- exact approved-record precedence over standalone capability grants;
- first execution versus execution-lease retry;
- invalid grant bundle removal and replacement pending creation;
- capability-request, EffectPlan, and replay-envelope mismatch replacement;
- broker-active outside-repository skip behavior;
- audit-mode pass-through without pending persistence;
- replay claim before process start and no re-arm on every failure class;
- unchanged audit reason, permission, approval ID, and user/agent messages.

Existing assertions should be reused where they already prove an item. New tests should be added
only for uncovered observations.

### Direct lifecycle tests

`src/__tests__/one-shot-approval-lifecycle.test.ts` tests every pure transition using fixed approval
records and timestamps. It covers happy paths, stale state, exhausted grants, invalid bundles,
duplicate pending records, and lease reuse without filesystem or runtime mocks.

### Integration gates

After each wiring step, run the smallest relevant suites. The final verification requires:

```text
pnpm typecheck
pnpm lint
pnpm test:run
pnpm test:structural:run
pnpm corpus
```

The full test baseline at design time is 194 passing test files and 2,876 passing tests with two
skipped tests. Any changed snapshot, approval message, audit reason, or corpus decision is a
regression unless separately authorized.

The implementation verification baseline is 196 passing test files and 2,901 passing tests with
the same two skipped tests. The corpus remains 96/96 with zero must-ask misses and zero
provably-benign over-stops.

### Dependency ratchet

A structural test scans imports from `src/core/one-shot-approval-lifecycle.ts` and fails if it
depends on adapters, commands, services, config I/O, audit, notifications, or Node filesystem and
process modules. The ratchet is intentionally scoped to the new module; imposing a repository-wide
layer rule would fail on existing dependencies and expand this refactor into an architecture
migration.

## Implementation sequence

1. Add only missing characterization assertions around the current gate behavior.
2. Add pure lifecycle transitions and direct unit tests without wiring production callers.
3. Refactor existing `recordApproval` and replay claim behavior to use the pure transitions.
4. Add approval-service use cases for pending creation, gate claim, and discard.
5. Replace the corresponding mutation callbacks in `gate-runtime.ts` one path at a time.
6. Remove the superseded private gate-runtime helpers.
7. Add the scoped dependency ratchet and run all verification gates.

Each step must preserve a passing targeted suite. No step combines file movement with behavior
changes.

## Error handling

- Domain absence, expiry, exhaustion, and invalid bundles are typed outcomes.
- Invalid programming inputs may throw before persistence.
- Store mutation failure retains the current fail-closed behavior.
- Audit or notification behavior remains owned by the gate runtime and is not hidden inside the
  lifecycle service.
- Approval replay continues to consume before execution and to distinguish not-started,
  execution-failed, timeout, and cleanup-unconfirmed outcomes.

## Alternatives considered

### Split all gate-runtime responsibilities now

Rejected because it would combine approval, contained execution, transactional execution, audit,
and host response changes in one review surface. The regression risk outweighs the reduction in
file size.

### Introduce full Domain/Application/Infrastructure directories now

Rejected for this scope because current repository dependencies do not yet follow those layers. A
partial hierarchy would imply guarantees that are not enforced and create ambiguous placement for
existing modules.

### Refactor config or doctor first

Config has broad impact and doctor has lower security leverage. The one-shot approval seam already
exists, has strong integration coverage, and removes state mutation from the highest-churn runtime
without changing classification.

### Move code without pure transitions

Rejected because moving imperative callbacks to another file would reduce file size but not coupling
or testability.

## Future architecture direction

After this refactor, a separate architecture initiative may define and ratchet the repository-wide
dependency direction:

```text
CLI / Host Adapters -> Application Use Cases -> Authorization Domain
Infrastructure ---------------- implements Application Ports
```

That initiative should first map actual domain boundaries, decide whether Belay still has one
authorization context or several bounded contexts, and record the dependency rule in a dedicated
ADR. Only then should modules move into physical Domain/Application/Infrastructure directories.

The pure one-shot lifecycle and its store port are designed to move into that structure without
changing callers or behavior.

## Acceptance criteria

- One-shot approval state transitions are absent from `gate-runtime.ts`.
- Pure lifecycle tests cover every terminal outcome and invariant in this design.
- Existing public exports and JSON state formats are unchanged.
- Exact `approved_once` precedence and all broker skip rules remain unchanged.
- Audit events, approval messages, replay behavior, and adapter responses are unchanged.
- The lifecycle module passes its dependency ratchet.
- Typecheck, lint, full tests, structural suite, and corpus gate pass.
