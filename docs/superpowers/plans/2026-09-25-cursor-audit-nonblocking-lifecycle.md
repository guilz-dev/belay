# Cursor Audit Non-Blocking Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent any Belay startup failure from blocking Cursor and prevent lifecycle commands from producing or silently reviving a hook/artifact split-brain installation.

**Architecture:** Cursor's host-level entries become fail-open while Belay retains explicit denial after successful startup. A focused lifecycle module serializes owner mutations, persists uninstall intent, records writer identity, publishes JSON atomically, and verifies complete install or uninstall states.

**Tech Stack:** TypeScript 5.9, Node.js 22 filesystem APIs, Vitest 3.

**Spec:** `docs/superpowers/specs/2026-09-25-cursor-audit-nonblocking-lifecycle-design.md`

## Global Constraints

- All Belay-managed Cursor hooks use `failClosed: false`.
- Existing third-party Cursor hook entries and their order remain unchanged.
- A running enforce-mode hook may still explicitly deny an action.
- Uninstall intent survives artifact deletion and ordinary upgrades.
- Locks are bounded, stale-owner recovery is limited to dead PIDs, and multiple locks use canonical path order.
- No new runtime dependency is added.

## Review Focus

- A PID-reused or malformed lock owner must not be deleted as though proven stale; acquisition should time out safely.
- HOME-target project/global paths that resolve to one directory must acquire one lock and must not clean themselves.
- A failed reactivation must retain the tombstone and remove managed hook publication.
- A project upgrade must not refresh a tombstoned global owner.
- Concurrent commands must preserve unrelated hooks while converging to a complete installed or uninstalled state.

---

### Task 1: Make the host boundary non-blocking

**Files:**
- Modify: `src/defaults.ts`
- Modify: `src/adapters/cursor/hooks.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `src/__tests__/cursor-hooks.test.ts`
- Modify: `src/__tests__/doctor.test.ts`
- Modify: related fixture expectations under `src/__tests__`

**Interfaces:**
- Produces: `CursorManagedHookDefinition` with literal `failClosed: false` and matching doctor validation.
- Consumes: existing managed-entry matching, which intentionally ignores `failClosed` so prior entries migrate.

- [x] Write tests that expect every serialized managed Cursor entry to contain `failClosed: false`, expect doctor to reject `true` or missing values, and retain an existing runtime enforce denial assertion.
- [x] Run `pnpm exec vitest run src/__tests__/cursor-hooks.test.ts src/__tests__/doctor.test.ts src/__tests__/hooks-runtime.test.ts` and confirm the new assertions fail on `true`.
- [x] Change the managed definition literal, merge defaults, legacy constants, and doctor message/check to require `false`; update only expectations representing Belay-managed Cursor entries.
- [x] Re-run the focused tests and confirm they pass.

### Task 2: Add serialized, observable lifecycle state

**Files:**
- Create: `src/installer/cursor-lifecycle.ts`
- Create: `src/__tests__/cursor-lifecycle.test.ts`

**Interfaces:**
- Produces: `withCursorLifecycleLocks(paths, metadata, fn)`, `cursorLifecyclePaths(paths)`, `readCursorDisableMarker(paths)`, `writeCursorDisableMarker(paths, record)`, `clearCursorDisableMarker(paths)`, `appendCursorLifecycleEvent(paths, event)`, and `writeJsonAtomic(path, value)`.
- Consumes: `ScopedPaths` and canonical path helpers from layout code.

- [x] Write tests for canonical lock ordering/deduplication, contention timeout, dead-PID recovery, token-checked release, atomic tombstone read/write/clear, and persistent NDJSON start/result records.
- [x] Run `pnpm exec vitest run src/__tests__/cursor-lifecycle.test.ts` and confirm failure because the module/API does not exist.
- [x] Implement exclusive lock directories, bounded retry, conservative stale recovery, atomic JSON writes, tombstones, and append-only lifecycle records using Node built-ins.
- [x] Re-run the lifecycle tests and confirm they pass.

### Task 3: Enforce complete lifecycle outcomes

**Files:**
- Modify: `src/installer.ts`
- Modify: `src/types.ts`
- Modify: `src/__tests__/installer-scope.test.ts`
- Modify: `src/__tests__/where-uninstall.test.ts`

**Interfaces:**
- Consumes: Task 2 lifecycle APIs and Task 1 managed hook contract.
- Produces: `UpgradeOptions.reactivate?: boolean`, locked Cursor init/upgrade/uninstall, install/uninstall invariants, and safe rollback of managed hook publication.

- [x] Write tests that uninstall creates a tombstone, ordinary upgrade refuses, explicit init and `reactivate: true` upgrade clear it only after success, a tombstoned global owner is not refreshed from project upgrade, lifecycle logs identify writers, and install success requires regular runner/shim/core/dispatcher files.
- [x] Run `pnpm exec vitest run src/__tests__/installer-scope.test.ts src/__tests__/where-uninstall.test.ts` and confirm failures on missing tombstone/reactivation behavior.
- [x] Wrap Cursor mutations in canonical locks; publish hooks atomically after artifacts; record lifecycle start/result; implement tombstone precedence and invariant rollback; deduplicate HOME overlap owners.
- [x] Re-run the focused tests and confirm they pass.

### Task 4: Expose the recovery contract and document the incident

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/__tests__/cli-ops.test.ts`
- Modify: `README.md`
- Modify: `docs/adr/ADR-008-cursor-hook-source-precedence.md`
- Modify: `docs/CONTEXT.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/investigations/2026-09-25-cursor-global-belay-lifecycle-recurrence-rca.ja.md`

**Interfaces:**
- Consumes: `UpgradeOptions.reactivate` from Task 3.
- Produces: CLI `upgrade --reactivate` and an RCA that separates confirmed evidence from inference.

- [x] Write CLI tests that parse and document `upgrade --reactivate` and reject the flag for every other command.
- [x] Run `pnpm exec vitest run src/__tests__/cli-ops.test.ts` and confirm the new test fails.
- [x] Add CLI parsing/help/plumbing, then update user docs, ADR, context, changelog, and RCA with the proven concurrent-writer and 2026-09-22 HOME-overlap evidence.
- [x] Re-run CLI and focused documentation-related tests.

### Task 5: Verify the integrated change

**Files:**
- Inspect: all files changed by Tasks 1–4.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: release-ready evidence and a bounded final review record.

- [x] Run `pnpm typecheck` and resolve all errors.
- [x] Run `pnpm lint` and resolve all errors.
- [x] Run `pnpm test` and inspect the complete result.
- [x] Review the final diff once against the spec, focusing on host startup failure, lifecycle race interleavings, tombstone precedence, unrelated hook preservation, and audit-log survivability.
