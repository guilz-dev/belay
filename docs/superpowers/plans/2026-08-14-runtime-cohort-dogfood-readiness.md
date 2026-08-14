# Runtime-Cohort Dogfood Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dogfood enforce readiness depend only on audit evidence produced by the active installed runtime build and active configuration.

**Architecture:** Add one installed-runtime provenance helper, pass its active cohort identity into the existing metrics core, and retain the current top-level aggregates as all-time history. Add a separate `currentCohort` aggregate and make only dogfood readiness consumers use it.

**Tech Stack:** TypeScript 5.9, Node.js 22, Vitest 3, pnpm 10, Biome.

## Global Constraints

- Preserve all historical audit records and existing top-level all-time metrics.
- Match a readiness event only when both `runtimeBuildStamp` and `configFingerprint` equal the active installation.
- Missing installed provenance, legacy records, and partial identity matches must fail closed.
- Keep `--force` behavior unchanged.
- Do not change EffectPlan semantics or readiness thresholds.
- Do not automatically promote scheduling-editor to enforce mode.

---

### Task 1: Active Cohort Metrics

**Files:**
- Create: `src/runtime-provenance.ts`
- Modify: `src/core/audit-metrics.ts`
- Modify: `src/commands/metrics.ts`
- Test: `src/__tests__/audit-metrics.test.ts`

**Interfaces:**
- Produces: `AuditCohortIdentity { runtimeBuildStamp: string; configFingerprint: string }`.
- Produces: `readInstalledRuntimeProvenance(corePath): Promise<{ stamp?: string; version?: string }>`.
- Produces: `resolveActiveAuditCohort(repoRoot, config): Promise<AuditCohortIdentity | null>`.
- Produces: `AuditMetricsReport.currentCohort` with identity, availability, event counts, and rates.
- Consumes: `runtimeCorePath`, `resolveAdapterName`, `canonicalStringify`, and `hashValue`.

- [x] **Step 1: Write failing core regression tests**

Add literal fixtures proving that old clean events cannot authorize an empty
current cohort, old noisy events do not contaminate twenty current clean
events, a mismatched config fingerprint is excluded, and a current-cohort
availability ask withholds readiness. Assert both all-time and cohort counts.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run src/__tests__/audit-metrics.test.ts`

Expected: FAIL because `currentCohort` and `activeCohort` do not exist and the
old implementation still derives readiness from all records.

- [x] **Step 3: Implement the metrics core minimally**

Extend `computeAuditMetrics` options with:

```ts
activeCohort?: AuditCohortIdentity | null
```

Filter only gate and approval records matching both active identity fields for
cohort counters. Keep existing top-level counters all-time. Drive
`dogfood.readyForEnforce` and its notes from the cohort counters, with an empty
or unavailable cohort returning `false` and an explanatory note.

- [x] **Step 4: Add installed provenance resolution**

Read `RUNTIME_PACKAGE_VERSION` and `RUNTIME_BUILD_STAMP` from the active
adapter's installed `core.mjs`. Compute the current config fingerprint with:

```ts
hashValue(canonicalStringify(config))
```

Return `null` when the runtime stamp cannot be read. Pass the result from
`metricsProject` into `computeAuditMetrics`.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm vitest run src/__tests__/audit-metrics.test.ts`

Expected: all audit-metrics tests pass.

---

### Task 2: Readiness Consumers and Output

**Files:**
- Modify: `src/commands/metrics.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `src/operational-insights.ts`
- Modify: `src/commands/status.ts`
- Modify: `src/types.ts`
- Modify: `src/__tests__/dogfood.test.ts`
- Modify: `src/__tests__/audit-metrics.test.ts`

**Interfaces:**
- Consumes: `AuditMetricsReport.currentCohort` from Task 1.
- Produces: `DogfoodStatus` values sourced from the current cohort plus `excludedGateEvents` and optional cohort identity.

- [x] **Step 1: Write failing integration/output tests**

Update the dogfood seed helper to write events with the installed runtime stamp
and active config fingerprint. Add a test with twenty old clean events and no
current events that confirms `dogfoodProject({ enforce: true })` refuses
promotion. Add output assertions for labeled all-time and current-cohort
metrics.

- [x] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run src/__tests__/dogfood.test.ts src/__tests__/audit-metrics.test.ts`

Expected: FAIL because consumers still expose all-time counts and the formatter
does not label the active cohort.

- [x] **Step 3: Update consumers minimally**

Use `currentCohort` for doctor/status dogfood event counts and rates. Keep the
general report and top-level metrics all-time. Format metrics with an explicit
`Current readiness cohort` block, including matching and excluded gate events.
Reuse the shared installed-runtime reader in doctor instead of its local parser.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run src/__tests__/dogfood.test.ts src/__tests__/audit-metrics.test.ts src/__tests__/doctor.test.ts src/__tests__/audit-visibility.test.ts`

Expected: all selected tests pass.

---

### Task 3: Documentation, Full Verification, and Cutover

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-08-14-runtime-cohort-dogfood-readiness-design.md` only if implementation details require clarification.
- Verify externally without mutation: `/Users/kaz/product/drivex/scheduling-editor/.cursor/belay/audit.ndjson`

**Interfaces:**
- Consumes: the verified active-cohort behavior from Tasks 1 and 2.
- Produces: verified scheduling-editor cohort metrics while preserving its complete audit history.

- [x] **Step 1: Document the behavior change**

Add an Unreleased changelog entry explaining that dogfood readiness ignores
legacy and mismatched runtime/config evidence while retaining it in all-time
metrics.

- [x] **Step 2: Run repository verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

Expected: every command exits 0 with no test failures.

- [x] **Step 3: Commit and push the implementation**

Stage only the plan, source, tests, changelog, and any clarified design file.
Commit with `fix: scope dogfood readiness to active runtime` and push the
existing `agent/runtime-cohort-dogfood-readiness` branch.

- [x] **Step 4: Verify scheduling-editor without rotating its log**

Run the built CLI against scheduling-editor and confirm the current cohort uses
the installed 0.8.0 build stamp and config fingerprint, while pre-0.8 events
appear only in the excluded count. Preserve `audit.ndjson` in place so current
0.8 evidence and historical auditability are not split.

- [x] **Step 5: Update draft PR #61**

Update the PR body with implementation details, the red-green regression
evidence, full verification commands, and the non-destructive scheduling-editor
cutover result.
