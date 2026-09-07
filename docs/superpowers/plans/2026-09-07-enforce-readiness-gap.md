# Enforce Readiness Gap Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove avoidable dogfood availability asks, make harvest evidence cohort-correct, and bound audit-log storage without weakening MUST-ASK behavior.

**Architecture:** Operational guidance supplies trusted cwd at the host boundary. Harvest filters through the existing runtime provenance identity before candidate extraction. A shared locked audit sink and streaming multi-generation reader replace direct append/full-file reads.

**Tech Stack:** TypeScript 5.9, Node.js 22 filesystem APIs, Vitest, Bash, NDJSON

**Spec:** `docs/superpowers/specs/2026-09-07-enforce-readiness-gap-design.md`

## Global Constraints

- Do not evaluate dynamic shell variables or relax `missing_trusted_cwd`.
- Corpus remains CI evidence only and cannot grant runtime authority.
- Preserve exact EffectPlan/resource decisions for all MUST-ASK cases.
- Audit defaults are 33,554,432 bytes and 5 total files.
- Leave `.worktrees/audit-log-bounded-storage-5454a26f-plan` unchanged.

---

### Task 1: Trusted per-target dogfood upgrade contract

**Files:**
- Modify: `docs/ops/dogfood-install-targets.md`
- Modify: `docs/ops/dogfood-install-targets.ja.md`
- Modify: `.cursor/skills/update-local-belay/SKILL.md`
- Create: `docs/ops/harvest-review-2026-09-07.md`

**Interfaces:**
- Consumes: host-provided shell working directory
- Produces: one-target-per-invocation operator contract and reviewed backlog record

- [x] **Step 1: Record the observed backlog without raw secrets or full payloads**

  Document the snapshot count, active-cohort count, availability count, and grouped review
  outcomes. Record fingerprints only as 12-character prefixes.

- [x] **Step 2: Replace multi-target inline recipes**

  State that every target and discovered linked worktree is a separate host invocation whose
  working directory is that target. Explicitly prohibit function/loop-variable `cd` recipes.

- [x] **Step 3: Verify the documents and skill are internally consistent**

  Run: `rg -n "working directory|作業ディレクトリ|dynamic|変数" docs/ops/dogfood-install-targets* .cursor/skills/update-local-belay/SKILL.md`

  Expected: both languages and the skill describe the same per-target contract.

### Task 2: Active-cohort harvest by default

**Files:**
- Modify: `src/core/harvest.ts`
- Modify: `src/commands/harvest.ts`
- Modify: `src/cli.ts`
- Modify: `src/__tests__/harvest.test.ts`

**Interfaces:**
- Consumes: `resolveActiveAuditCohort()` and `matchesAuditCohort()`
- Produces: `HarvestReport.cohortScope`, `HarvestReport.excludedRecords`, and `HarvestListOptions.allCohorts`

- [x] **Step 1: Write failing cohort-selection tests**

  Add fixtures with matching and mismatched runtime artifact, decision config fingerprint, and
  boundary profile. Assert that default list contains only the matching candidate and that
  `allCohorts: true` contains both.

- [x] **Step 2: Run the focused tests and observe the expected failure**

  Run: `pnpm exec vitest run src/__tests__/harvest.test.ts`

  Expected: FAIL because harvest currently has no cohort scope or exclusion count.

- [x] **Step 3: Implement cohort selection**

  Resolve the installed cohort in `harvestListProject`; filter records with
  `matchesAuditCohort`; expose excluded count. If identity is unavailable, return an empty active
  report rather than treating historical records as current. Add `--all-cohorts` to parsing/help.

- [x] **Step 4: Run focused tests**

  Run: `pnpm exec vitest run src/__tests__/harvest.test.ts src/__tests__/cli-ops.test.ts`

  Expected: PASS.

### Task 3: Focused argv-delegate and corpus corrections

**Files:**
- Modify: `src/core/effect-ir/shell-lower/argv-delegate-gate.ts`
- Modify: `src/__tests__/effect-ir/argv-delegate-lower.test.ts`
- Modify: `corpus/shell-commands.json`

**Interfaces:**
- Consumes: `shouldApplyArgvDelegate(head, innerTokens, depth)`
- Produces: safe one-token inner lowering with unchanged nested policy projection

- [x] **Step 1: Write failing safety-paired tests**

  Assert `rtk ls` matches direct `ls`, `rtk rm target` remains a local mutation, and
  `rtk --network ls` remains indeterminate. Add literal corpus cases for the reviewed `rtk git
  status` variants, `rtk git diff`, and `rtk vitest` variants.

- [x] **Step 2: Run the focused tests and observe `rtk ls` fail**

  Run: `pnpm exec vitest run src/__tests__/effect-ir/argv-delegate-lower.test.ts src/__tests__/corpus.test.ts`

  Expected: FAIL only on the one-token delegate expectation.

- [x] **Step 3: Permit one-token delegates through normal nested lowering**

  Change the delegate gate from `innerTokens.length >= 2` to `innerTokens.length >= 1`; do not add
  an executable allowlist or special-case `rtk`.

- [x] **Step 4: Run EffectPlan and corpus gates**

  Run: `pnpm exec vitest run src/__tests__/effect-ir/argv-delegate-lower.test.ts src/__tests__/effect-ir/recursive-wrapper-monotonic.test.ts src/__tests__/corpus.test.ts`

  Expected: PASS with MUST-ASK mismatches equal to zero.

### Task 4: Audit retention configuration

**Files:**
- Modify: `src/core/config.ts`
- Modify: `docs/config-schema.md`
- Modify: `src/__tests__/config.test.ts`

**Interfaces:**
- Produces: `AuditRetentionConfig`, `DEFAULT_AUDIT_RETENTION`, and normalized `audit.retention`

- [x] **Step 1: Write failing default/migration/validation tests**

  Assert defaults of 33,554,432 and 5, preservation through v2-v4 migration, flooring of numeric
  input, and fallback for negative/non-numeric input.

- [x] **Step 2: Run the config tests and observe failure**

  Run: `pnpm exec vitest run src/__tests__/config.test.ts`

  Expected: FAIL because `audit.retention` is absent.

- [x] **Step 3: Implement and document the config**

  Add the interface/default/normalizer and thread it through every config normalization path.

- [x] **Step 4: Run config tests**

  Run: `pnpm exec vitest run src/__tests__/config.test.ts`

  Expected: PASS.

### Task 5: Locked rotating sink and streaming reader

**Files:**
- Modify: `src/core/audit-sink.ts`
- Modify: `src/core/audit-reader.ts`
- Modify: `src/__tests__/audit-sink.test.ts`
- Modify: `src/core/audit-io.ts`
- Modify: `src/core/audit-serialize.ts`

**Interfaces:**
- Hardens: `appendAuditLine(options)`, `maybeRotateAuditLog(path, retention, incomingBytes)`,
  `resolveAuditLogFiles(path, retention)`, and `readAuditRecordsFromPath(path, retention)`
- Consumes: `serializeAuditRecordV3()` and `parseAuditNdjsonLine()`

- [x] **Step 1: Write failing behavior tests**

  Cover pre-append rotation, a total-file cap, oldest-first reads, malformed-line counting,
  disabled rotation, oversized single records, and concurrent appends producing valid NDJSON.

- [x] **Step 2: Run tests and observe module-not-found failure**

  Run: `pnpm exec vitest run src/__tests__/audit-sink.test.ts`

  Expected: FAIL on pre-append rotation, concurrent writes, reduced retention, and disabled-reader
  generation visibility in the implementation that landed on `main` via PR #115.

- [x] **Step 3: Implement the minimal sink and reader**

  Use an exclusive lock file around size check, generation renames, and append. Retain archives
  `.1` through `.${maxFiles - 1}` and stream them in reverse generation order before the active
  file.

- [x] **Step 4: Run sink tests**

  Run: `pnpm exec vitest run src/__tests__/audit-sink.test.ts src/__tests__/audit-io.test.ts`

  Expected: PASS.

### Task 6: Route all writers and readers through bounded storage

**Files:**
- Modify: `src/adapters/shared/gate-runtime.ts`
- Modify: `src/egress-daemon.ts`
- Modify: `src/commands/audit.ts`
- Modify: `src/commands/metrics.ts`
- Modify: `src/commands/simulate.ts`
- Modify: `src/__tests__/audit-query.test.ts`

**Interfaces:**
- Consumes: Task 5 sink/reader and Task 4 retention config
- Produces: consistent rotated-generation behavior across CLI and runtime

- [x] **Step 1: Write failing integration tests**

  Place relevant records in a rotated generation and the active file. Assert the shared audit
  loader sees both in chronological order. Metrics, report, simulate, harvest, quality, doctor,
  dogfood, and recovery consume that loader.

- [x] **Step 2: Run the focused integration tests and observe missing archive records**

  Run: `pnpm exec vitest run src/__tests__/audit-query.test.ts src/__tests__/audit-metrics.test.ts src/__tests__/audit-visibility.test.ts src/__tests__/simulate.test.ts src/__tests__/recover.test.ts`

  Expected: FAIL because readers currently call `readFile()` on only the active file.

- [x] **Step 3: Replace direct append/read paths**

  Pass `config.audit.retention` to the shared sink and reader. Preserve explicit legacy archive
  reads as single-file operations.

- [x] **Step 4: Run all focused storage tests**

  Run: `pnpm exec vitest run src/__tests__/audit-sink.test.ts src/__tests__/audit-io.test.ts src/__tests__/audit-query.test.ts src/__tests__/audit-metrics.test.ts src/__tests__/audit-visibility.test.ts src/__tests__/simulate.test.ts src/__tests__/recover.test.ts`

  Expected: PASS.

### Task 7: Full verification

**Files:**
- Modify: `CHANGELOG.md`
- Verify: all changed files

**Interfaces:**
- Consumes: all prior tasks
- Produces: release-ready evidence without enabling enforce mode

- [x] **Step 1: Run formatting, lint, types, corpus, and tests**

  Run: `pnpm lint && pnpm typecheck && pnpm corpus && pnpm test`

  Expected: all commands exit 0; corpus MUST-ASK and provably-benign mismatches are zero; Vitest
  reports zero failed tests.

- [x] **Step 2: Inspect the branch diff**

  Run: `git diff --check && git status --short && git diff --stat origin/main...HEAD`

  Expected: no whitespace errors and only planned files changed.
