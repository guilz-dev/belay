# Dogfood Enforce Readiness Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between corpus hard-gate accuracy and dogfood behavior by fixing cwd diagnostics, reviewing active-cohort harvest evidence, bounding audit storage, and replacing raw would-block readiness with reviewed benign evidence.

**Architecture:** Preserve EffectPlan and PolicyEngine as the only runtime authority. Build four connected but independently testable units: causal cwd signals, current-cohort harvest with a non-authoritative review ledger, compact rotated audit storage with streaming readers, and combined reviewed-traffic/corpus readiness.

**Tech Stack:** TypeScript 5.9, Node.js 22, Vitest 3, pnpm 10, Biome, NDJSON.

**Spec:** `docs/superpowers/specs/2026-09-07-dogfood-enforce-readiness-remediation-design.md`

## Global Constraints

- Do not add command, executable, prefix, fingerprint, or corpus allowlists to runtime policy.
- Do not infer dynamic cwd from positional parameters, loop variables, command substitution, or untrusted environment values.
- Corpus and harvest review state are evidence only and never authorize a gate decision.
- Preserve existing audit history and `*.legacy-*.ndjson` archives.
- Default audit bounds are `maxBytes: 33_554_432` and `maxFiles: 5`, including the active file.
- Final readiness requires at least 150 reviewed `provably-benign` events, at least three sessions, benign block rate below 2%, zero availability asks, and zero corpus hard-gate mismatches.
- `--force` behavior for `belay dogfood --enforce` remains unchanged.
- Each task gets one initial review; after fixes, re-review only the original findings and fix diff, following repository `AGENTS.md` limits.
- Keep the existing user changes in `docs/ops/releasing.md` and the untracked Cursor portability plan intact.

---

### Task 1: Record the immutable remediation baseline

**Files:**
- Create: `docs/ops/dogfood-readiness-baseline-2026-09-07.md`
- Modify: `docs/dogfood-audit-remediation-2026-08-22.ja.md`

**Interfaces:**
- Consumes: the operator-provided snapshot from 2026-09-07.
- Produces: baseline ID `belay-2026-09-07`, cutoff timestamp, cohort identity, and fixed counts used by later review tasks.

- [ ] **Step 1: Write the baseline document**

Record these values exactly and label them as a frozen snapshot rather than live output:

```text
audit size: 20.8 MB
records: 4,376
range: 2026-08-31 through 2026-09-07
schema: v3
all gate events: 1,748
active runtime: 0.10.1
active gate events: 176
active would-block: 58
active availability asks: 3 missing_trusted_cwd
active classifier-quality asks: 55
active classifier-quality rate: 31.25%
corpus: 79 cases, 100% accuracy
harvest: 35 candidates, 3 availability items
```

State that later local inspection appended additional allow events and must not rewrite this
baseline.

- [ ] **Step 2: Link the baseline from the remediation status table**

Add one row under the current status section linking `belay-2026-09-07` to the new document. Do not
replace the older 2026-08-22 evidence.

- [ ] **Step 3: Verify the document contains no raw payload or personal identifier**

Run:

```bash
rg -n "user_email|conversation_id|session_id|tool_use_id|Bearer |api[_-]?key" docs/ops/dogfood-readiness-baseline-2026-09-07.md
```

Expected: no matches.

- [ ] **Step 4: Commit the baseline**

```bash
git add docs/ops/dogfood-readiness-baseline-2026-09-07.md docs/dogfood-audit-remediation-2026-08-22.ja.md
git commit -m "docs: freeze dogfood readiness baseline"
```

---

### Task 2: Split dynamic cwd loss from missing action cwd

**Files:**
- Modify: `src/core/effect-ir/shell-lower/segment.ts`
- Modify: `src/core/effect-ir/shell-lower.ts`
- Modify: `src/core/verdict/verdict.ts`
- Modify: `src/core/audit-analysis.ts`
- Modify: `src/core/audit-types.ts`
- Modify: `src/core/harvest.ts`
- Modify: `src/commands/metrics.ts`
- Test: `src/__tests__/verdict/structural-suite.test.ts`
- Test: `src/__tests__/audit-metrics.test.ts`
- Test: `src/__tests__/harvest.test.ts`

**Interfaces:**
- Produces: `CdTransition` with causal unknown signal.
- Produces: audit reason `dynamic_cwd_transition` and signal `shell.cwd_dynamic_transition`.
- Produces: `AvailabilityAskCounts.dynamicCwdTransition: number`.
- Preserves: `missing_trusted_cwd` for genuinely untrusted initial action cwd.

- [ ] **Step 1: Add failing cwd-lowering tests**

Add assertions equivalent to:

```ts
it('identifies a dynamic cwd transition separately from a missing initial cwd', async () => {
  const result = await verdict('cd "$dir" && rm -rf build', context)
  expect(result.permission).toBe('ask')
  expect(result.reason).toBe('dynamic_cwd_transition')
  expect(result.signals).toContain('shell.cwd_dynamic_transition')
  expect(result.signals).not.toContain('missing_action_cwd')
})

it('keeps a literal absolute cd statically known', async () => {
  const result = await verdict('cd /tmp && rm -rf build', context)
  expect(result.reason).toBe('outside_repo_mutation')
  expect(result.signals).not.toContain('shell.cwd_dynamic_transition')
})
```

Add metrics and harvest fixtures proving `dynamic_cwd_transition` is an availability item and is
counted separately from `missing_trusted_cwd`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm vitest run src/__tests__/verdict/structural-suite.test.ts src/__tests__/audit-metrics.test.ts src/__tests__/harvest.test.ts
```

Expected: failures because dynamic transitions still map to `missing_trusted_cwd` and the new
counter does not exist.

- [ ] **Step 3: Return causal transition metadata**

Introduce this local type in `segment.ts`:

```ts
export type CdTransition =
  | { cwd: string; known: true }
  | { cwd: string; known: false; signal: 'shell.cwd_dynamic_transition' }
```

Return the unknown branch whenever the target is empty, `-`, contains `$`, or contains a backtick.
Track the signal in `lowerTopLevelSegments()` and attach it only to later requirements whose
`requiresKnownCwd()` result is true.

- [ ] **Step 4: Map the new signal through verdict and availability reports**

In `verdict.ts`, select `dynamic_cwd_transition` before the legacy `shell.cwd_unknown` mapping.
Extend `AvailabilitySignal` and `AvailabilityAskCounts`; update human-readable metrics with:

```text
- missing action/trusted cwd: N
- dynamic cwd transition: N
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run the command from Step 2.

Expected: all selected tests pass.

- [ ] **Step 6: Run structural and corpus gates**

```bash
pnpm test:structural
pnpm corpus
```

Expected: both pass; no MUST-ASK case becomes allow.

- [ ] **Step 7: Commit**

```bash
git add src/core/effect-ir/shell-lower/segment.ts src/core/effect-ir/shell-lower.ts src/core/verdict/verdict.ts src/core/audit-analysis.ts src/core/audit-types.ts src/core/harvest.ts src/commands/metrics.ts src/__tests__/verdict/structural-suite.test.ts src/__tests__/audit-metrics.test.ts src/__tests__/harvest.test.ts
git commit -m "fix: distinguish dynamic cwd transitions"
```

---

### Task 3: Make the dogfood upgrade workflow action-scoped

**Files:**
- Modify: `docs/ops/dogfood-install-targets.md`
- Modify: `docs/ops/dogfood-install-targets.ja.md`
- Modify: `docs/ops/releasing.md`
- Test: `src/__tests__/verdict/structural-suite.test.ts`

**Interfaces:**
- Consumes: `working_directory` precedence documented in `docs/CONTEXT.md` invariant 13.
- Produces: one-command-per-target release procedure with a literal `--target`.

- [ ] **Step 1: Add a structural regression fixture**

Add a test using a generic path, not maintainer-specific paths:

```ts
it('does not report cwd availability failure for an explicit target without dynamic cd', async () => {
  const result = await verdict(
    'node /workspace/belay/dist/cli.js doctor --target /workspace/target',
    context,
  )
  expect(result.reason).not.toBe('missing_trusted_cwd')
  expect(result.reason).not.toBe('dynamic_cwd_transition')
})
```

- [ ] **Step 2: Run the regression test**

```bash
pnpm vitest run src/__tests__/verdict/structural-suite.test.ts
```

Expected: pass on current semantics; this freezes the runbook contract.

- [ ] **Step 3: Replace loop examples with action-scoped instructions**

For every active target, document that the host Shell action must set the target repository as
`working_directory`, then run exactly one command such as:

```bash
npx -y @guilz-dev/belay@<version> upgrade --with-skill --target /absolute/target/path
```

Document `dogfood`, `doctor`, and `status` as separate actions. State explicitly that a shell
function or loop containing `cd "$dir"` or `cd "$wt"` is unsupported for readiness collection.

- [ ] **Step 4: Document expected intentional asks**

Explain that `npx -y`, package publishing, push, and control-plane mutation may still require exact
approval. These are classifier decisions, not cwd availability failures.

- [ ] **Step 5: Verify the runbook has no dynamic target loop**

```bash
rg -n 'cd "\$(dir|wt)"|for .*target|while .*worktree' docs/ops/dogfood-install-targets.md docs/ops/dogfood-install-targets.ja.md docs/ops/releasing.md
```

Expected: no executable upgrade example uses those forms.

- [ ] **Step 6: Commit**

Before staging, preserve and incorporate the existing user edit in `docs/ops/releasing.md`; do not
overwrite it.

```bash
git add docs/ops/dogfood-install-targets.md docs/ops/dogfood-install-targets.ja.md docs/ops/releasing.md src/__tests__/verdict/structural-suite.test.ts
git commit -m "docs: scope dogfood upgrades per target"
```

---

### Task 4: Scope harvest to the active cohort

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/commands/harvest.ts`
- Modify: `src/core/harvest.ts`
- Modify: `src/core/audit-types.ts`
- Modify: `src/types.ts`
- Test: `src/__tests__/harvest.test.ts`
- Test: `src/__tests__/cli-ops.test.ts`

**Interfaces:**
- Consumes: `resolveActiveAuditCohort(repoRoot, config)` and `matchesAuditCohort(record, cohort)`.
- Produces: `HarvestReport.schemaVersion = 2` with `cohort`, `matchingGateEvents`, and
  `excludedGateEvents`.
- Produces: `HarvestListOptions.allCohorts?: boolean` and CLI flag `--all-cohorts`.

- [ ] **Step 1: Add failing current-cohort tests**

Create fixtures with one old repeated ask and one current repeated ask. Assert:

```ts
expect(currentReport.candidates.map((entry) => entry.command)).toEqual(['current command'])
expect(currentReport.excludedGateEvents).toBe(2)
expect(allReport.candidates.map((entry) => entry.command)).toEqual([
  'current command',
  'old command',
])
```

Also assert that an unavailable active cohort returns no default candidates and an explanatory
note rather than falling back to all history.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm vitest run src/__tests__/harvest.test.ts src/__tests__/cli-ops.test.ts
```

Expected: failures because harvest currently reads all shell history.

- [ ] **Step 3: Add cohort metadata to the report**

Define:

```ts
interface HarvestReportV2 {
  schemaVersion: 2
  scope: 'shell'
  cohort: AuditCohortIdentity | null
  matchingGateEvents: number
  excludedGateEvents: number
  candidates: HarvestCandidate[]
  availabilityQueue: AvailabilityQueueItem[]
  notes: string[]
}
```

Keep `buildHarvestReport(records)` as a pure aggregator; filter records in
`harvestListProject()` after resolving the installed cohort.

- [ ] **Step 4: Parse and document `--all-cohorts`**

Default behavior is fail-closed current-cohort selection. `--all-cohorts` restores the current
forensic behavior and prints an explicit warning that mixed history must not be bulk-promoted.

- [ ] **Step 5: Run tests and verify GREEN**

Run the command from Step 2.

- [ ] **Step 6: Verify the captured stale-wrapper case is excluded after a runtime change**

Use fixture hashes rather than the live mutable log. The test must show that an old
`rtk git status --short` ask is excluded while a current allow record is not emitted as a harvest
candidate.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/commands/harvest.ts src/core/harvest.ts src/core/audit-types.ts src/types.ts src/__tests__/harvest.test.ts src/__tests__/cli-ops.test.ts
git commit -m "feat: scope harvest to active audit cohort"
```

---

### Task 5: Persist non-authoritative harvest reviews

**Files:**
- Create: `src/core/harvest-review.ts`
- Modify: `src/core/harvest.ts`
- Modify: `src/commands/harvest.ts`
- Modify: `src/cli.ts`
- Modify: `src/corpus/types.ts`
- Create: `src/__tests__/harvest-review.test.ts`
- Test: `src/__tests__/harvest.test.ts`
- Test: `src/__tests__/cli-ops.test.ts`

**Interfaces:**
- Produces: `HarvestReviewOutcome` including `must-ask`.
- Produces: `HarvestReviewLedgerV1`, `loadHarvestReviewLedger()`,
  `writeHarvestReviewLedgerAtomic()`, and `latestHarvestReviews()`.
- Stores: `<audit-directory>/harvest-reviews.json`.
- Consumes: active `boundaryProfile` and candidate fingerprint.
- Produces: `HarvestApplyOptions.allCohorts?: boolean`; CLI accepts `--all-cohorts` for explicit
  review of a frozen historical batch.

- [ ] **Step 1: Write failing ledger tests**

Cover all of these cases:

```ts
it('persists reject without storing the command or changing corpus')
it('persists must-ask and appends a deny_pending_approval corpus case')
it('uses the latest review for the same fingerprint and boundary profile')
it('does not hide a review from a different boundary profile')
it('writes atomically and leaves the previous ledger readable on rename failure')
it('does not expose reviews to PolicyEngine or grant loading')
```

For the security assertion, inspect serialized JSON and require that neither the exact command nor
payload fixture appears.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm vitest run src/__tests__/harvest-review.test.ts src/__tests__/harvest.test.ts src/__tests__/cli-ops.test.ts
```

Expected: failures because rejected reviews are not persisted and `must-ask` is not an outcome.

- [ ] **Step 3: Implement the ledger types and parser**

Use the exact v1 interfaces from the design spec. Reject malformed timestamps, fingerprints,
boundary profiles, and outcomes. Keep at most one latest normalized record per composite key when
writing.

- [ ] **Step 4: Implement atomic write**

Write a sibling temporary file with mode `0o600`, then rename it over the ledger. Clean up only the
known temporary file in `finally`; never recursively remove the audit directory.

- [ ] **Step 5: Extend `harvest apply`**

Resolve the exact candidate from the current-cohort report by command, persist the review, and then:

- `provably-benign`: append corpus `allow/read_only` expectation;
- `accepted-benign`: append corpus `allow_flagged` expectation;
- `must-ask`: append corpus `deny_pending_approval` expectation;
- `reject`: leave corpus unchanged.

Every appended case receives:

```ts
provenance: {
  source: 'harvest',
  sourceBatchId: 'belay-2026-09-07',
  sourceCaseId: fingerprint,
  reviewedAt,
}
```

Do not populate `reviewedBy` from host identity.

When `--all-cohorts` is supplied, resolve against the explicitly mixed forensic report and require
an exact command match. Without the flag, never fall back from the active cohort to historical
records.

- [ ] **Step 6: Hide reviewed candidates by default**

Add `--include-reviewed` for auditability. Default `harvest list` excludes candidates whose latest
review matches the active boundary profile.

- [ ] **Step 7: Run tests and verify GREEN**

Run the command from Step 2.

- [ ] **Step 8: Run corpus and type checks**

```bash
pnpm typecheck
pnpm corpus
```

- [ ] **Step 9: Commit**

```bash
git add src/core/harvest-review.ts src/core/harvest.ts src/commands/harvest.ts src/cli.ts src/corpus/types.ts src/__tests__/harvest-review.test.ts src/__tests__/harvest.test.ts src/__tests__/cli-ops.test.ts
git commit -m "feat: persist harvest review outcomes"
```

---

### Task 6: Review the captured 35-candidate batch

**Files:**
- Create: `docs/ops/dogfood-harvest-review-2026-09-07.md`
- Modify: `corpus/shell-commands.json`

**Interfaces:**
- Consumes: baseline ID `belay-2026-09-07`, current-cohort harvest v2, and review ledger v1.
- Produces: one disposition for all 35 captured fingerprints and a corpus draft limited to reviewed
  labels.

- [ ] **Step 1: Export the frozen candidate inventory**

Run against the preserved pre-implementation log or its explicit archive:

```bash
node dist/cli.js harvest list --all-cohorts --json > /tmp/belay-2026-09-07-harvest.json
```

Verify the frozen inventory contains 35 candidates and three availability items. If the live file
has changed, filter by the baseline cutoff recorded in Task 1 rather than substituting new counts.

- [ ] **Step 2: Build the review table**

For each candidate, record these columns without pasting full heredoc or source bodies:

```text
fingerprint | redacted first line | historical reason | current reason | semantic family |
effect evidence | review outcome | corpus action | implementation issue
```

Long bodies are represented by fingerprint and language only.

- [ ] **Step 3: Reclassify every candidate on the installed runtime**

Use `belay explain --json` with the original action cwd from `actionSnapshot`. Mark candidates that
now allow as `stale-currently-allow`; do not open an EffectPlan fix for them.

- [ ] **Step 4: Apply the mandatory family decisions**

Apply these minimum-safe outcomes:

- `npm publish`, push wrappers, and PR-creation wrappers: `must-ask`;
- executable Node/Python heredoc or `node -e`: `must-ask`;
- `make verify-parallel`: `accepted-benign` unless contained execution proves it;
- package test/build commands that resolve to `rm -rf dist` or generated output: not
  `provably-benign`;
- read-style prefixes containing loops, globbed user directories, or opaque wrappers: do not mark
  `provably-benign` from the prefix alone;
- current `read_only` results: `provably-benign` only after inspecting all resulting requirements.

- [ ] **Step 5: Persist all 35 reviews**

Use `harvest apply --all-cohorts` for each exact frozen candidate. Confirm
`harvest list --all-cohorts` returns zero unreviewed items for this batch and
`--all-cohorts --include-reviewed` still reports all dispositions.

- [ ] **Step 6: Validate the corpus draft before accepting it**

```bash
pnpm corpus
```

Expected: any newly added `provably-benign` or `must-ask` case passes. An accepted-benign mismatch
is recorded as soft evidence and must not be converted into a runtime allow rule.

- [ ] **Step 7: Commit the review evidence and passing corpus cases**

```bash
git add docs/ops/dogfood-harvest-review-2026-09-07.md corpus/shell-commands.json
git commit -m "test: review dogfood harvest batch"
```

---

### Task 7: Lower bounded argv delegates inside read-only compositions

**Files:**
- Modify: `src/core/effect-ir/shell-lower/argv-delegate-gate.ts`
- Modify: `src/core/effect-ir/shell-lower.ts`
- Modify: `src/core/effect-ir/argv-delegate.ts`
- Test: `src/__tests__/verdict/structural-suite.test.ts`
- Test: `src/__tests__/verdict/parser-xargs.test.ts`
- Modify: `corpus/shell-commands.json`

**Interfaces:**
- Produces: bounded recursive lowering for a one-token or nested argv-delegate payload when the
  inner EffectPlan is independently complete.
- Preserves: blocklist and recursive depth limit; wrapper identity never grants permission.

- [ ] **Step 1: Add failing benign/adversarial pairs**

Add cases equivalent to:

```ts
expect(await verdict('fictional-runner ls', context)).toMatchObject({
  permission: 'allow',
  reason: 'read_only',
})
expect(await verdict('cat hooks.json | fictional-runner rg -n belay', context)).toMatchObject({
  permission: 'allow',
  reason: 'read_only',
})
expect((await verdict('fictional-runner sh -c "rm -rf ."', context)).permission).toBe('ask')
expect((await verdict('cat x | fictional-runner node -e "mutate()"', context)).permission).toBe(
  'ask',
)
```

Use fictional wrapper names in structural tests; add real `rtk ls` and `cat ... | rtk rg ...` only
as corpus expectations.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm vitest run src/__tests__/verdict/structural-suite.test.ts src/__tests__/verdict/parser-xargs.test.ts
```

- [ ] **Step 3: Permit one-token inner lowering**

Change the delegate eligibility from `innerTokens.length >= 2` to `innerTokens.length >= 1`, while
keeping the outer and inner blocklists.

- [ ] **Step 4: Permit bounded nested composition**

Remove the unconditional `depth > 0` rejection. Permit one nested delegate level only when the
outer decode produced exactly grammar-unknown spawn + indeterminate requirements and the inner
lowering is complete. If the inner result remains partial, merge it and keep ask.

- [ ] **Step 5: Run focused tests and corpus**

```bash
pnpm vitest run src/__tests__/verdict/structural-suite.test.ts src/__tests__/verdict/parser-xargs.test.ts
pnpm corpus
```

- [ ] **Step 6: Commit**

```bash
git add src/core/effect-ir/shell-lower/argv-delegate-gate.ts src/core/effect-ir/shell-lower.ts src/core/effect-ir/argv-delegate.ts src/__tests__/verdict/structural-suite.test.ts src/__tests__/verdict/parser-xargs.test.ts corpus/shell-commands.json
git commit -m "fix: lower bounded argv delegate compositions"
```

---

### Task 8: Fix read-only Git range operands without weakening ref mutation

**Files:**
- Modify: `src/core/verdict/git-classifier.ts`
- Test: `src/__tests__/verdict/git-classifier.test.ts`
- Test: `src/__tests__/verdict/structural-suite.test.ts`
- Modify: `corpus/shell-commands.json`

**Interfaces:**
- Produces: explicit read-only recognition for revision/range operands accepted by `git log`,
  `git diff`, and `git merge-base`.
- Preserves: ref-writing and path-writing subcommands as mutations.

- [ ] **Step 1: Add failing range tests**

```ts
it.each([
  'git diff origin/main...HEAD',
  'git diff HEAD~3..HEAD',
  'git log --oneline origin/main..HEAD',
  'git merge-base origin/main HEAD',
])('%s is repository inspection', async (command) => {
  const result = await verdict(command, context)
  expect(result.permission).toBe('allow')
  expect(result.reason).toBe('read_only')
  expect(result.signals).not.toContain('git.grammar_incomplete')
})
```

Pair them with `git push origin/main:main`, `git update-ref`, and `git branch -D` cases that must not
silently allow.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm vitest run src/__tests__/verdict/git-classifier.test.ts src/__tests__/verdict/structural-suite.test.ts
```

- [ ] **Step 3: Separate revision operands from path operands**

Add a pure helper that recognizes `A..B`, `A...B`, `HEAD~N`, `HEAD^N`, and ordinary ref names only
for read-only Git subcommands. Do not reuse it for checkout, reset, push, update-ref, branch delete,
or worktree mutation.

- [ ] **Step 4: Verify the captured compound command**

Assert that the exact semantic shape below is read-only:

```text
git log ... && git merge-base origin/main HEAD && git diff --stat origin/main...HEAD && git diff origin/main...HEAD
```

- [ ] **Step 5: Run focused tests, structural suite, and corpus**

```bash
pnpm vitest run src/__tests__/verdict/git-classifier.test.ts src/__tests__/verdict/structural-suite.test.ts
pnpm test:structural
pnpm corpus
```

- [ ] **Step 6: Commit**

```bash
git add src/core/verdict/git-classifier.ts src/__tests__/verdict/git-classifier.test.ts src/__tests__/verdict/structural-suite.test.ts corpus/shell-commands.json
git commit -m "fix: classify read-only git ranges"
```

---

### Task 9: Normalize heredoc and Make control syntax without proving opaque execution

**Files:**
- Modify: `src/core/shell-tokenizer.ts`
- Modify: `src/core/effect-ir/shell-lower.ts`
- Modify: `src/core/verdict/makefile-expand.ts`
- Modify: `src/core/verdict/launcher-resolve.ts`
- Test: `src/__tests__/shell-tokenizer.test.ts`
- Test: `src/__tests__/verdict/makefile-expand.test.ts`
- Test: `src/__tests__/verdict/launcher-resolve.test.ts`
- Test: `src/__tests__/verdict/structural-suite.test.ts`
- Modify: `corpus/shell-commands.json`

**Interfaces:**
- Produces: heredoc token boundaries and normalized Make recipe control builtins.
- Preserves: indeterminate requirements for executable heredoc bodies and PID/background-dependent
  recipes.

- [ ] **Step 1: Add failing heredoc pairs**

Cover:

```text
cat <<'EOF'             no extra shell effect from literal body
python3 <<'PY'          indeterminate executable body
node <<'JS'             indeterminate executable body
cat <<EOF with $(...)   expansion effects retained; unknown expansion remains ask
```

Assert that `<<` never becomes an `fs.read` target named `<`.

- [ ] **Step 2: Add failing Make normalization tests**

Cover `@`, `-`, `+`, line continuation, standalone `set -e`, literal `exit 0`, and safe `wait`.
Retain ask for `(...) &`, `wait $!`, dynamic PID variables, and `make verify-parallel` as currently
written.

- [ ] **Step 3: Run tests and verify RED**

```bash
pnpm vitest run src/__tests__/shell-tokenizer.test.ts src/__tests__/verdict/makefile-expand.test.ts src/__tests__/verdict/launcher-resolve.test.ts src/__tests__/verdict/structural-suite.test.ts
```

- [ ] **Step 4: Implement boundary-aware heredoc tokenization**

Represent delimiter quoting and body span explicitly. Feed literal data bodies to stdin metadata,
not `lowerTopLevelSegments()`. Mark bodies passed to an executable interpreter as indeterminate.

- [ ] **Step 5: Implement safe Make builtin normalization**

Normalize only syntax with deterministic effects. Do not erase subshell, background, `wait $!`, or
dynamic `exit` requirements.

- [ ] **Step 6: Run focused and hard-gate verification**

```bash
pnpm vitest run src/__tests__/shell-tokenizer.test.ts src/__tests__/verdict/makefile-expand.test.ts src/__tests__/verdict/launcher-resolve.test.ts src/__tests__/verdict/structural-suite.test.ts
pnpm corpus
```

- [ ] **Step 7: Commit**

```bash
git add src/core/shell-tokenizer.ts src/core/effect-ir/shell-lower.ts src/core/verdict/makefile-expand.ts src/core/verdict/launcher-resolve.ts src/__tests__/shell-tokenizer.test.ts src/__tests__/verdict/makefile-expand.test.ts src/__tests__/verdict/launcher-resolve.test.ts src/__tests__/verdict/structural-suite.test.ts corpus/shell-commands.json
git commit -m "fix: normalize heredoc and make control syntax"
```

---

### Task 10: Add compact audit snapshots and telemetry

**Files:**
- Modify: `src/core/audit-replay-context.ts`
- Modify: `src/core/audit-types.ts`
- Modify: `src/core/audit-serialize.ts`
- Modify: `src/adapters/shared/gate-runtime.ts`
- Modify: `src/adapters/cursor/runtime-entry.ts`
- Modify: `src/adapters/claude/runtime-entry.ts`
- Modify: `src/adapters/codex/runtime-entry.ts`
- Modify: `src/core/reclassify.ts`
- Test: `src/__tests__/audit-io.test.ts`
- Create: `src/__tests__/audit-replay-context.test.ts`
- Test: `src/__tests__/audit-visibility.test.ts`
- Test: `src/__tests__/reclassify.test.ts`

**Interfaces:**
- Produces: `AuditActionSnapshotV2` discriminated union from the design spec.
- Produces: `CompactHostTelemetryV1` without tool input/output bodies.
- Reads: legacy action snapshot v1.
- Stops writing: `replayContext.payload`.

- [ ] **Step 1: Add failing data-minimization tests**

Create payloads containing unique source, prompt, patch, and tool-output markers. Serialize new gate
and post-tool records and assert none of those markers is present. Also assert correlation hashes,
tool name, operation, path, byte counts, and normalized failure status remain.

- [ ] **Step 2: Add v1/v2 compatibility tests**

Assert `parseAuditActionSnapshot()` reads both versions and returns a normalized internal action.
Assert a v2 tool snapshot without enough replay data is reported as non-replayable rather than
falling back to a full payload.

- [ ] **Step 3: Run tests and verify RED**

```bash
pnpm vitest run src/__tests__/audit-io.test.ts src/__tests__/audit-replay-context.test.ts src/__tests__/audit-visibility.test.ts src/__tests__/reclassify.test.ts
```

- [ ] **Step 4: Implement v2 snapshot builders and parsers**

Use the discriminated union from the spec. For tool paths, preserve only the normalized target path
and operation. For subagents, store a SHA-256 summary hash.

- [ ] **Step 5: Remove new full replay payload writes**

Keep the legacy parser for existing rows, but make `buildAuditReplayContext()` omit `payload`.
Update reclassification to prefer v2 snapshots and emit a typed non-replayable reason when
necessary.

- [ ] **Step 6: Compact host completion/failure telemetry**

Project adapter payloads to:

```ts
interface CompactHostTelemetryV1 {
  schemaVersion: 1
  event: string
  toolName?: string
  success?: boolean
  durationMs?: number
  cwdRelative?: string
  inputBytes?: number
  outputBytes?: number
  failureType?: string
  errorMessage?: string
  toolInvocationCorrelationId?: string
}
```

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the command from Step 3.

- [ ] **Step 8: Commit**

```bash
git add src/core/audit-replay-context.ts src/core/audit-types.ts src/core/audit-serialize.ts src/adapters/shared/gate-runtime.ts src/adapters/cursor/runtime-entry.ts src/adapters/claude/runtime-entry.ts src/adapters/codex/runtime-entry.ts src/core/reclassify.ts src/__tests__/audit-io.test.ts src/__tests__/audit-replay-context.test.ts src/__tests__/audit-visibility.test.ts src/__tests__/reclassify.test.ts
git commit -m "feat: minimize audit payload retention"
```

---

### Task 11: Add bounded audit configuration and rotation sink

**Files:**
- Create: `src/core/audit-storage.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/audit-serialize.ts`
- Modify: `src/core/audit-io.ts`
- Modify: `src/adapters/shared/gate-runtime.ts`
- Modify: `docs/config-schema.md`
- Create: `src/__tests__/audit-storage.test.ts`
- Test: `src/__tests__/audit-io.test.ts`
- Test: `src/__tests__/config.test.ts`

**Interfaces:**
- Produces: `BelayAuditConfig.maxBytes` and `.maxFiles`.
- Produces: `appendBoundedAuditLine(options): Promise<void>`.
- Produces: deterministic numbered generation paths.
- Consumes: one already serialized complete line.

- [ ] **Step 1: Add failing config tests**

Assert missing values normalize to `33_554_432` and `5`, fractional values floor, and non-positive
values fall back to defaults. Existing v1-v5 config fixtures must migrate without changes to their
stored version number.

- [ ] **Step 2: Add failing rotation tests**

Use a 128-byte limit and three files. Verify:

```text
append below limit -> active only
append crossing limit -> old active becomes .1
repeated rotation -> .1 newest, .2 oldest
fourth rotation -> only configured oldest is removed
single append -> exactly one newline-terminated JSON record
```

Add a parallel append test with at least 20 writers and assert every unique fingerprint appears
once and every retained line parses.

- [ ] **Step 3: Add symlink and lock-failure tests**

Reject a symlinked active audit path and a symlinked lock path. Simulate lock timeout and assert no
partial line or unrelated file deletion occurs.

- [ ] **Step 4: Run tests and verify RED**

```bash
pnpm vitest run src/__tests__/audit-storage.test.ts src/__tests__/audit-io.test.ts src/__tests__/config.test.ts
```

- [ ] **Step 5: Normalize bounded audit config**

Extract `BelayAuditConfig`, use it from `BelayConfigV2` and `BelayConfigV4`, and apply the exact
defaults from the spec. Do not include these display/storage fields in
`decisionConfigFingerprint`.

- [ ] **Step 6: Implement the locked rotation sink**

Use an exclusive sibling lock and a two-second bounded retry. Rotate numbered files by explicit
paths, never globs. Release the exact lock in `finally`. Preserve `*.legacy-*.ndjson` files.

- [ ] **Step 7: Route all appenders through the sink**

Pass the normalized audit bounds from CLI and gate writers into `appendAuditRecord()`. Keep
serialization separate from storage.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run the command from Step 4.

- [ ] **Step 9: Commit**

```bash
git add src/core/audit-storage.ts src/core/config.ts src/core/audit-serialize.ts src/core/audit-io.ts src/adapters/shared/gate-runtime.ts docs/config-schema.md src/__tests__/audit-storage.test.ts src/__tests__/audit-io.test.ts src/__tests__/config.test.ts
git commit -m "feat: bound and rotate audit storage"
```

---

### Task 12: Read retained audit generations incrementally

**Files:**
- Modify: `src/core/audit-storage.ts`
- Modify: `src/commands/audit.ts`
- Modify: `src/commands/metrics.ts`
- Modify: `src/commands/simulate.ts`
- Modify: `src/commands/harvest.ts`
- Modify: `src/commands/quality.ts`
- Modify: `src/commands/report.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `src/commands/dogfood-check.ts`
- Modify: `src/commands/recover.ts`
- Test: `src/__tests__/audit-storage.test.ts`
- Test: `src/__tests__/audit-query.test.ts`
- Test: `src/__tests__/audit-metrics.test.ts`
- Test: `src/__tests__/simulate.test.ts`
- Test: `src/__tests__/harvest.test.ts`
- Test: `src/__tests__/doctor.test.ts`

**Interfaces:**
- Produces: `iterateAuditRecords(options): AsyncGenerator<AuditRecord>`.
- Produces: `loadRetainedAuditRecords(options): Promise<AuditLoadResult>` compatibility collector.
- Produces: `AuditLoadDiagnostics` with file count, bytes, parsed records, malformed lines, and
  oversized lines.

- [ ] **Step 1: Add failing generation-order tests**

Create `.2`, `.1`, and active fixtures with chronological markers. Assert the iterator yields `.2`
then `.1` then active, skips blank/malformed lines, and reports diagnostics exactly.

- [ ] **Step 2: Add consumer integration tests**

Place ask, approval, and replay rows across generation boundaries. Verify round-trip joins,
current-cohort counts, harvest grouping, and simulate reclassification are unchanged.

- [ ] **Step 3: Run tests and verify RED**

```bash
pnpm vitest run src/__tests__/audit-storage.test.ts src/__tests__/audit-query.test.ts src/__tests__/audit-metrics.test.ts src/__tests__/simulate.test.ts src/__tests__/harvest.test.ts src/__tests__/doctor.test.ts
```

- [ ] **Step 4: Implement the async iterator**

Use `createReadStream()` plus `node:readline`. Resolve generation paths explicitly from
`maxFiles`; do not discover with a glob. Count malformed lines without retaining their contents.

- [ ] **Step 5: Replace direct whole-file reads**

Remove direct audit `readFile()` calls from metrics, audit, simulate, and shared consumers. Use the
compatibility collector initially where aggregation still requires an array; filtering occurs as
records stream into that bounded retained set.

- [ ] **Step 6: Surface storage diagnostics**

Add metrics/doctor output for retained file count, total bytes, malformed lines, and oversized
lines. Malformed or oversized current-cohort evidence cannot contribute to readiness.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the command from Step 3.

- [ ] **Step 8: Prove no command reader directly reads the audit path**

```bash
rg -n "readFile\(audit|readFile\(auditLogPath|parseAuditNdjson\(raw" src/commands
```

Expected: no production command matches.

- [ ] **Step 9: Commit**

```bash
git add src/core/audit-storage.ts src/commands/audit.ts src/commands/metrics.ts src/commands/simulate.ts src/commands/harvest.ts src/commands/quality.ts src/commands/report.ts src/commands/doctor.ts src/commands/dogfood-check.ts src/commands/recover.ts src/__tests__/audit-storage.test.ts src/__tests__/audit-query.test.ts src/__tests__/audit-metrics.test.ts src/__tests__/simulate.test.ts src/__tests__/harvest.test.ts src/__tests__/doctor.test.ts
git commit -m "refactor: stream retained audit generations"
```

---

### Task 13: Gate traffic readiness on reviewed benign evidence

**Files:**
- Modify: `src/core/audit-serialize.ts`
- Modify: `src/core/audit-types.ts`
- Modify: `src/adapters/shared/gate-runtime.ts`
- Modify: `src/core/audit-metrics.ts`
- Modify: `src/commands/metrics.ts`
- Modify: `src/commands/quality.ts`
- Modify: `src/commands/dogfood.ts`
- Modify: `src/operational-insights.ts`
- Modify: `src/types.ts`
- Test: `src/__tests__/audit-io.test.ts`
- Test: `src/__tests__/audit-metrics.test.ts`
- Test: `src/__tests__/quality.test.ts`
- Test: `src/__tests__/dogfood.test.ts`

**Interfaces:**
- Produces: `sessionCorrelationId(rawId): string` as 16 lowercase hex.
- Produces: `ReviewedTrafficReadiness` from the design spec.
- Defines: `MIN_REVIEWED_BENIGN_EVENTS = 150`, `MIN_REVIEWED_SESSIONS = 3`, and
  `MAX_BENIGN_BLOCK_RATE = 0.02`.
- Consumes: latest harvest reviews and active-cohort gate records.

- [ ] **Step 1: Add failing session-correlation tests**

Assert raw host session/conversation IDs are absent after serialization, stable equal IDs hash to
the same 16-hex value, and different IDs differ.

- [ ] **Step 2: Add failing traffic-readiness boundary tests**

Cover exactly:

```text
149 reviewed benign, 3 sessions, 0 blocks -> not ready
150 reviewed benign, 2 sessions, 0 blocks -> not ready
150 reviewed benign, 3 sessions, 2 blocks -> ready (1.33%)
150 reviewed benign, 3 sessions, 3 blocks -> not ready (2.00% is not below 2%)
150 reviewed benign, 3 sessions, 0 blocks, 1 availability ask -> not ready
150 accepted-benign only -> zero reviewed provably-benign samples
missing active cohort or review ledger -> not ready
```

- [ ] **Step 3: Add failing combined quality tests**

Prove traffic-ready plus one MUST-ASK corpus miss is not final-ready. Prove passing traffic and zero
hard-gate mismatches is final-ready. Prove `dogfood --enforce` reruns the combined check.

- [ ] **Step 4: Run tests and verify RED**

```bash
pnpm vitest run src/__tests__/audit-io.test.ts src/__tests__/audit-metrics.test.ts src/__tests__/quality.test.ts src/__tests__/dogfood.test.ts
```

- [ ] **Step 5: Add session correlation at adapter boundaries**

Hash the first validated adapter session identifier available from the action payload. Pass only
the hash into the serialized audit record. If none exists, omit the field.

- [ ] **Step 6: Compute reviewed traffic metrics**

Join active-cohort gate records to the latest review map by fingerprint, kind, and boundary
profile. Count only `provably-benign`. Keep raw would-block and classifier-quality rates as
diagnostics.

- [ ] **Step 7: Make quality the final readiness authority**

Add `trafficReadyForEnforce` and `readyForEnforce` separately to `QualityReport`. The final value is
true only when traffic readiness and corpus hard gates both pass. Update `dogfood --enforce` to call
the combined quality check immediately before config mutation.

- [ ] **Step 8: Update operator output**

Metrics must display sample count, blocked count/rate, session count, and availability count.
Quality and dogfood must explain the first failed gate without hiding the remaining failed gates.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run the command from Step 4.

- [ ] **Step 10: Run complete safety gates**

```bash
pnpm typecheck
pnpm lint
pnpm corpus
pnpm test
```

- [ ] **Step 11: Commit**

```bash
git add src/core/audit-serialize.ts src/core/audit-types.ts src/adapters/shared/gate-runtime.ts src/core/audit-metrics.ts src/commands/metrics.ts src/commands/quality.ts src/commands/dogfood.ts src/operational-insights.ts src/types.ts src/__tests__/audit-io.test.ts src/__tests__/audit-metrics.test.ts src/__tests__/quality.test.ts src/__tests__/dogfood.test.ts
git commit -m "feat: require reviewed evidence for enforce readiness"
```

---

### Task 14: Release and collect a clean dogfood cohort

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/ops/dogfood-install-targets.md`
- Modify: `docs/ops/dogfood-install-targets.ja.md`
- Modify: `docs/ops/dogfood-readiness-baseline-2026-09-07.md`

**Interfaces:**
- Consumes: Tasks 1-13 and the repository release workflow.
- Produces: a new runtime artifact cohort and enforce-trial evidence for every active dogfood target.

- [ ] **Step 1: Run repository verification**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm corpus
node dist/cli.js quality --target /Users/kaz/product/guilz/belay --json
```

Expected: all commands exit 0; corpus MUST-ASK and provably-benign mismatches are zero.

- [ ] **Step 2: Record the pre-release cutoff**

Use one ISO8601 cutoff for all active repositories. Record it in the release evidence before any
upgrade action.

- [ ] **Step 3: Upgrade each target with a separate host Shell action**

For each target listed in `docs/ops/dogfood-install-targets.md`, set that target as the host
`working_directory` and run `upgrade --target <literal-absolute-path>`. Do not invoke a shell loop.

- [ ] **Step 4: Verify installation and routing per target**

Run `doctor`, `status`, and `scripts/pre-release-dogfood-check.sh <target> <cutoff>` separately.
Expected for each target: runtime/config cohort matches, hook routing skew is zero, and availability
ask count after cutoff is zero.

- [ ] **Step 5: Collect reviewed benign evidence**

Keep dogfood mode enabled during normal work until each promoted boundary profile has at least 150
reviewed provably-benign events across at least three session correlation IDs.

- [ ] **Step 6: Review new residual candidates**

Run current-cohort `harvest list`, classify every residual item using Task 6 rules, and rerun corpus
for any new expectation. Do not reopen the frozen 35-item batch unless a recorded review was wrong.

- [ ] **Step 7: Evaluate enforce readiness**

For each target, run:

```bash
node dist/cli.js quality --target <target> --json
```

Expected:

```text
reviewed benign events >= 150
distinct sessions >= 3
benign block rate < 0.02
availability asks = 0
must-ask misses = 0
provably-benign corpus blocks = 0
readyForEnforce = true
```

- [ ] **Step 8: Begin the limited enforce trial**

Promote only targets whose own quality report passes. Do not infer readiness for one target from
another target's report. Keep `--force` unused in the evidence-backed path.

- [ ] **Step 9: Update release evidence and changelog**

Record the runtime artifact hash, decision config fingerprint, boundary profile, cutoff, per-target
quality summary, rotation diagnostics, and enforce decision. Do not paste raw audit rows.

- [ ] **Step 10: Commit the release evidence**

```bash
git add CHANGELOG.md docs/ops/dogfood-install-targets.md docs/ops/dogfood-install-targets.ja.md docs/ops/dogfood-readiness-baseline-2026-09-07.md
git commit -m "docs: record enforce readiness evidence"
```

---

## Final verification

Run after Task 14 and before claiming completion:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm corpus
rg -n "writeFile\(.*audit|appendFile\(.*audit|readFile\(audit|replayContext.*payload" src
git status --short
```

Expected:

- all quality commands pass;
- corpus hard-gate mismatches are zero;
- only the bounded audit sink writes audit NDJSON;
- no production reader loads the complete active audit file directly;
- new replay contexts do not persist payload objects;
- only intended task changes are staged or committed; pre-existing user changes remain intact.
