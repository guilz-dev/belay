# PR #118 Readiness Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR #118 mergeable on current `main` and close the two remaining Important readiness/release findings.

**Architecture:** Merge `origin/main` without rewriting the published PR branch, retain the stricter bounded `audit-storage` implementation as the single authority, and preserve the main-branch audit APIs as thin compatibility modules when needed. Seed a missing or repaired cohort watermark from the exact retained generation snapshot while holding the audit writer lock, then move cross-repository verification to the post-publish/post-upgrade phase.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, pnpm, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-09-07-dogfood-enforce-readiness-remediation-design.md`

## Global Constraints

- Runtime authority remains EffectPlan and PolicyEngine; audit and harvest evidence never grants permission.
- Same-cohort availability failures must not be forgotten by rotation, migration, or sidecar repair.
- Audit state must remain bounded, atomic, symlink-safe, and free of commands, cwd values, and payload bodies.
- Missing or unreadable evidence fails closed.
- Do not publish a package, create a release/tag, upgrade another repository, or enable enforce.
- Preserve the original checkout's operator-authored changes.

---

### Task 1: Reconcile PR #118 with current main

**Files:**

- Merge: `origin/main`
- Preserve/resolve: `src/core/audit-storage.ts`, `src/core/audit-sink.ts`, `src/core/audit-reader.ts`
- Preserve/resolve: `src/core/audit-serialize.ts`, `src/core/config.ts`, affected commands and tests

**Interfaces:**

- Consumes: main's `AuditSinkAppendOptions`, `readAuditRecordsFromPath()`, `statAuditStorage()` compatibility surfaces.
- Produces: one merge commit whose tree keeps PR #118 behavior while retaining current-main compatibility modules without duplicate write authority.

- [ ] **Step 1: Merge current main without committing**

```bash
git merge --no-commit --no-ff origin/main
```

Expected: overlapping audit/config/docs files may conflict; no remote history is rewritten.

- [ ] **Step 2: Resolve conflicts by behavior**

Keep `appendBoundedAuditLine()` and `loadRetainedAuditRecords()` as the canonical storage paths. Where main APIs remain imported or tested, implement thin adapters to those canonical paths instead of retaining an independent writer/reader.

- [ ] **Step 3: Verify the reconciled tree**

```bash
pnpm typecheck
pnpm vitest run src/__tests__/audit-sink.test.ts src/__tests__/audit-storage.test.ts src/__tests__/audit-query.test.ts
```

Expected: PASS; no direct unlocked append path is restored.

- [ ] **Step 4: Commit the main reconciliation**

```bash
git add -u
git commit
```

---

### Task 2: Seed repaired availability watermarks from retained evidence

**Files:**

- Modify: `src/core/audit-storage.ts`
- Modify if required: `src/core/audit-serialize.ts`
- Test: `src/__tests__/audit-storage.test.ts`
- Test: `src/__tests__/quality.test.ts`

**Interfaces:**

- Consumes: `AuditReadinessUpdate`, exact retained generation paths, `isAvailabilityCausedAsk()` and cohort identity fields.
- Produces: sidecar initialization/repair that carries forward retained current-cohort availability counts before the incoming update is applied.

- [ ] **Step 1: Write the migration regression test**

Create legacy current-cohort NDJSON with an availability ask but no sidecar, append a non-availability event through the real sink, rotate the legacy ask out, add 150 reviewed benign events across three sessions, and assert `quality.readyForEnforce === false` with sticky availability count `>= 1`.

- [ ] **Step 2: Verify RED**

```bash
pnpm vitest run src/__tests__/quality.test.ts -t "seeds a missing watermark from retained availability evidence"
```

Expected: FAIL because the current implementation initializes the sidecar at zero.

- [ ] **Step 3: Add focused storage tests**

Cover missing, invalid, and same-cohort repair. Assert the stored JSON stays under 4096 bytes and contains only cohort hashes, counts, timestamps, and schema fields.

- [ ] **Step 4: Verify focused RED**

```bash
pnpm vitest run src/__tests__/audit-storage.test.ts -t "seeds|repairs"
```

Expected: FAIL on a zero or unknown seed.

- [ ] **Step 5: Implement retained-evidence seeding**

Under the existing audit writer lock, open the exact retained generations before rotation, stream only bounded records, select the incoming update's cohort, calculate availability counts/timestamps, and atomically write the sidecar with `retained count + incoming availability delta`. A valid sidecar for another proven cohort may reset on the incoming cohort transition; missing or malformed evidence must never silently become a trusted zero.

- [ ] **Step 6: Verify GREEN**

```bash
pnpm vitest run src/__tests__/audit-storage.test.ts src/__tests__/quality.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the sticky-state migration fix**

```bash
git add src/core/audit-storage.ts src/core/audit-serialize.ts src/__tests__/audit-storage.test.ts src/__tests__/quality.test.ts
git commit -m "fix: seed readiness state from retained audit evidence"
```

---

### Task 3: Put cross-repository checks after publish and upgrade

**Files:**

- Modify: `docs/ops/releasing.md`
- Cross-check: `docs/ops/dogfood-install-targets.md`
- Cross-check: `docs/ops/dogfood-install-targets.ja.md`

**Interfaces:**

- Consumes: published release version, one shared cutoff selected immediately before the first authorized target upgrade, target-scoped host Shell actions.
- Produces: an executable release sequence that never requests an unpublished npm version.

- [ ] **Step 1: Capture the failing documentation invariant**

```bash
rg -n "published package at the release version|Before tagging or publishing|Post-release verification" docs/ops/releasing.md
```

Expected: published-package target checks appear in the pre-release section.

- [ ] **Step 2: Move the workflow**

Keep the Belay source-build helper in pre-release checks for the Belay checkout only. Move non-Belay published-package checks into post-release verification after npm availability; select the shared cutoff immediately before the first authorized target upgrade, perform each upgrade/check as a separate target-cwd action, and require literal absolute `--target` paths.

- [ ] **Step 3: Verify the documentation sequence**

```bash
rg -n "Belay product checkout only|Post-release verification|npx -y @guilz-dev/belay@<version>|working_directory|--target" docs/ops/releasing.md docs/ops/dogfood-install-targets.md docs/ops/dogfood-install-targets.ja.md
```

Expected: helper usage is Belay-only; published-package commands occur after publish and match target cwd.

- [ ] **Step 4: Commit the release sequence fix**

```bash
git add docs/ops/releasing.md
git commit -m "docs: run target readiness checks after publish"
```

---

### Task 4: Verify and update Draft PR #118

**Files:**

- Update: PR #118 body/checklist through `gh` after local verification.

- [ ] **Step 1: Run complete verification**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm corpus
pnpm test:structural
pnpm probe:adversarial
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Push normally**

```bash
git push origin agent/dogfood-enforce-readiness-remediation
```

Expected: no force push.

- [ ] **Step 3: Update PR #118**

Remove the two resolved Important items, retain overlap notes for #115/#116/#117, record fresh verification, and leave the PR as draft until GitHub required checks complete.
