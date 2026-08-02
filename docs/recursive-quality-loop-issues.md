# Recursive Quality Loop — Issue Breakdown

Status: **Implementation planning**
Related: [`recursive-quality-loop.md`](./recursive-quality-loop.md) · [`CONCEPT.md`](./CONCEPT.md) · [`ROADMAP.md`](./ROADMAP.md) · [`adr/ADR-002-concept-conformance.md`](./adr/ADR-002-concept-conformance.md)

This document breaks the recursive quality loop proposal into GitHub-ready issues.
The ordering is intentional:

1. Put the ground truth into code.
2. Enforce it in CI.
3. Measure the real distribution.
4. Use the measurements to remove repeat friction safely.
5. Add automation only after the hard gates exist.

## Tracking Order

| Priority | Type | Title | Relationship |
|---|---|---|---|
| P0 | Feature | Recursive quality loop: labeled benign/FN gates | tracking umbrella |
| P0 | Task | Extend corpus schema for `must-ask` / `provably-benign` / `accepted-benign` | tracked by Issue 0 |
| P0 | Task | Make corpus evaluation enforce `must-ask=0` and `provably-benign block=0` | tracked by Issue 0; depends on corpus schema |
| P1 | Task | Expand audit metrics for repeat asks and availability-caused asks | tracked by Issue 0; depends on corpus gates |
| P1 | Feature | Add standing-allow for already-benign fingerprints | tracked by Issue 0; depends on corpus schema and corpus gates |
| P1 | Task | Add harvest/review flow for `accepted-benign` candidates | tracked by Issue 0; depends on corpus schema and audit metrics |
| P2 | Task | Improve replay fidelity for `simulate` triage | tracked by Issue 0; depends on corpus schema |

---

## Issue 0

**Type:** Feature request  
**Title:** `[Feature]: Recursive quality loop with labeled benign corpus and hard FN/FP gates`  
**Area:** Shell classification / verdict engine

**Problem statement**

Today belay can record audits and evaluate a corpus, but it cannot represent the difference between:

- operations that are structurally/provably benign,
- operations that operators believe are benign but still require review, and
- operations that must always ask.

That makes recursive false-positive reduction unsafe: approvals and overrides can be over-interpreted as ground truth, and CI does not yet hard-gate the right invariants.

**Proposed solution**

Introduce a labeled corpus and execution loop where:

- `must-ask` remains the hard false-negative boundary,
- `provably-benign` becomes the hard false-positive boundary,
- `accepted-benign` captures review-needed benign candidates without polluting the hard gate,
- audit metrics and standing-allow build on top of those labels rather than on raw approvals.

**Why this fits belay**

This sharpens belay's narrowness instead of widening it into a permission fence. It preserves the invariant "stop only irreversible × catastrophic" while giving benign/recoverable cases a durable path to silence.

**Alternatives considered**

- Treat `deny→approve` as ground truth: unsafe; approval means "human accepts uncertainty this time," not "classifier was wrong."
- Add approval caching first: unsafe without a labeled benign set.

**Example scenarios**

- `gh pr list` should graduate into `provably-benign` and never regress.
- `make deploy` must remain `must-ask`.
- A timeout-caused ask should improve availability metrics, not silently become benign.

---

## Issue 1

**Type:** Task  
**Title:** `[Task]: Extend corpus schema for must-ask / provably-benign / accepted-benign`  
**Area:** Shell classification / verdict engine

**Task summary**

Extend the corpus data model so the test set can distinguish catastrophic cases from two classes of benign cases: hard-ground-truth benign and review-needed benign.

**Why this matters**

Without a schema-level distinction, later tasks have nowhere safe to store the difference between "provably benign" and "operator accepted benign." Everything downstream becomes heuristic and brittle.

**Scope**

- Update `corpus/shell-commands.json` case shape to carry explicit fields such as:
  - `kind` (initially `shell`; reserve the field so tool/subagent corpora can be added later without another schema break)
  - `category`
  - `must-ask`
  - `provably-benign`
  - `accepted-benign`
- Keep current `verdict` / `reason` expectations, but make the benign/catastrophic label explicit.
- Define how `provably-benign` cases become **runtime-matchable**:
  - store or derive a stable runtime-facing representation (for example fingerprint, normalized pattern, or catalog key) that standing-allow can reference later
  - document which parts are offline-only corpus fixtures vs which parts are meant to be consumed by runtime code
- Add docs/comments describing what belongs in each bucket.
- Seed a minimal initial split from the existing corpus.
- Keep the initial implementation **shell-only**, but make the schema extensible enough that tool/subagent support can be added without redesigning the labels.
- Update any tests or loaders that assume the old schema.

**Definition of done**

- Corpus cases can represent the three labels above.
- Corpus cases include a forward-compatible action kind field, even if only `shell` is populated initially.
- Existing evaluation/tests load the new schema successfully.
- A small initial set is classified into the new buckets with no ambiguity in the fixture format.
- `provably-benign` entries have a defined path to runtime matching, rather than existing only as offline test labels.
- Documentation explains that `accepted-benign` is not a hard-gate label.

**Additional context**

- Related: [`recursive-quality-loop.md`](./recursive-quality-loop.md)
- Follow-on: corpus evaluation hard gates, harvest flow, standing-allow

---

## Issue 2

**Type:** Task  
**Title:** `[Task]: Enforce hard corpus gates for must-ask and provably-benign`  
**Area:** Shell classification / verdict engine

**Task summary**

Update corpus evaluation and CI so belay hard-fails when a `must-ask` case is allowed or a `provably-benign` case is blocked.

**Why this matters**

This is the ratchet. Without it, improvements can regress silently and the recursive loop has no hard memory.

**Scope**

- Update [`src/corpus/evaluate.ts`](../src/corpus/evaluate.ts) to report:
  - miss rate for `must-ask`
  - benign block rate for `provably-benign`
  - separate reporting for `accepted-benign`
- Rename the current misnamed `falsePositiveRate` metric to something aligned with reality.
- Update [`scripts/corpus.mjs`](../scripts/corpus.mjs) to:
  - fail on any `must-ask` miss
  - fail on any `provably-benign` block
  - report `accepted-benign` separately as review-required or soft-gated
- Remove the current baseline tolerance that permits misses.
- Add/adjust tests around the new evaluation behavior.

**Definition of done**

- CI fails on `must-ask` misses.
- CI fails on `provably-benign` blocks.
- `accepted-benign` is reported separately and does not silently weaken the hard gate.
- Naming in evaluation output reflects actual semantics.

**Additional context**

- Depends on: corpus schema extension
- Related files: [`src/corpus/evaluate.ts`](../src/corpus/evaluate.ts), [`scripts/corpus.mjs`](../scripts/corpus.mjs), [`corpus/baseline.json`](../corpus/baseline.json)

---

## Issue 3

**Type:** Task  
**Title:** `[Task]: Expand audit metrics for repeat asks and availability-caused asks`  
**Area:** CLI

**Task summary**

Extend audit metrics so operators can see which asks are classifier-quality problems versus availability/infrastructure problems, and which asks repeat for the same fingerprint.

**Why this matters**

Recursive improvement needs targeting data. Aggregate would-block rate is not enough to tell whether to improve rules, availability, or caching.

**Scope**

- Extend audit metrics/reporting with:
  - reason-by-count deny summaries
  - reason-by-count approval ratios
  - fallback/timeout/cwd-missing ask counts
  - same-fingerprint repeat ask counts
- Keep "noisy rules" visible, but avoid treating approvals as ground truth.
- Surface the new metrics in `belay metrics`.
- Add tests for the new aggregations.

**Definition of done**

- `belay metrics` distinguishes repeat friction from availability-caused asks.
- Operators can identify top recurring ask reasons and repeated fingerprints.
- Tests cover the new counters/rollups.

**Additional context**

- Related files: [`src/core/audit-metrics.ts`](../src/core/audit-metrics.ts), [`src/commands/metrics.ts`](../src/commands/metrics.ts)

---

## Issue 4

**Type:** Feature request  
**Title:** `[Feature]: Standing-allow for already-benign fingerprints`  
**Area:** Shell classification / verdict engine

**Problem statement**

Today a one-shot approval becomes `approved_once`, but belay has no durable way to silence repeat asks for actions that are already known benign. Re-asking those cases creates the highest day-to-day friction.

**Proposed solution**

Add a separate standing-allow path for fingerprints/patterns that are already confirmed benign through labeled corpus or MUST-ALLOW catalog membership. Do not derive standing-allow directly from one-off approvals.

**Why this fits belay**

This narrows interruptions without weakening the catastrophe boundary. It removes repeated asks only for cases already justified as reversible/benign.

**Alternatives considered**

- Reuse `approved-approvals.json`: wrong semantics; that file represents one-shot human acceptance, not durable benign classification.
- Promote every approval to standing allow: unsafe.

**Example scenarios**

- `gh pr list` or `aws s3 ls` should stop asking after benign confirmation.
- `git push origin main` must never become standing-allowed through repeated approval.

**Scope**

- Introduce a separate state/store for standing-allow entries.
- Wire matching into gate runtime after classification and before prompting.
- Consume the runtime-matchable benign representation defined in Issue 1, rather than inventing a second benign catalog format here.
- Restrict eligibility to:
  - `provably-benign` corpus matches
  - explicit MUST-ALLOW catalog matches
  - availability-caused asks that were re-confirmed benign out of band
- Add TTL/revoke/audit behavior.
- Add tests proving that `approved_once` and standing-allow stay semantically separate.

**Definition of done**

- Repeat asks for eligible benign fingerprints are silenced.
- One-off approvals do not automatically create standing-allow.
- Tier0 `must-ask` paths cannot be standing-allowed through this feature.
- Audit trail and revoke path exist.

**Additional context**

- Related files: [`src/adapters/shared/gate-runtime.ts`](../src/adapters/shared/gate-runtime.ts), [`src/core/types.ts`](../src/core/types.ts), approval state I/O

---

## Issue 5

**Type:** Task  
**Title:** `[Task]: Add harvest and review flow for accepted-benign candidates`  
**Area:** CLI

**Task summary**

Build a review-oriented harvest flow that collects benign candidates from audit traces without treating approvals as automatic ground truth.
Initial scope is **shell audit traces**; the schema and labels should not preclude future tool/subagent expansion.

**Why this matters**

This is how the corpus grows from real work. Without a harvest path, the same over-blocks recur; without review discipline, the corpus becomes unsafe.

**Scope**

- Add a CLI/report flow that surfaces benign candidates from **shell** audit traces.
- Candidate sources may include:
  - repeated `deny→approve` patterns
  - later `overrides.allow` additions
  - read/describe/list/get-style static signals
- Keep fallback/timeout/cwd-missing asks in a separate availability queue.
- Support review outcomes such as:
  - promote to `provably-benign`
  - store as `accepted-benign`
  - reject / leave unclassified
- Add tests around candidate extraction and queue separation.

**Definition of done**

- Operators can generate a candidate list from shell audit traces.
- Approval-derived signals remain candidates only until reviewed.
- Availability-caused asks are not mixed into the benign corpus flow.
- Reviewed candidates can be persisted in the corpus using the new schema.
- The issue text and CLI behavior make the shell-only initial scope explicit.

**Additional context**

- Depends on: corpus schema, audit metrics
- Related files: audit parsing/query modules, future CLI command surface

---

## Issue 6

**Type:** Task  
**Title:** `[Task]: Improve replay fidelity for simulate triage`  
**Area:** Shell classification / verdict engine

**Task summary**

Upgrade audit/replay data so `belay simulate` can replay closer to the original action context and become a useful triage tool.

**Why this matters**

Current replay is lossy. It is useful directionally, but not strong enough to anchor regression reasoning for path-sensitive or tool-sensitive cases.

**Scope**

- Extend audit schema to retain the original:
  - `cwd`
  - tool name / action kind identity
  - scrubbed full payload or replay-safe equivalent
- Update reclassification to use those fields instead of reconstructing from summary only.
- Keep `simulate` positioned as triage, not as the hard safety gate.
- Add tests for fidelity improvements.

**Definition of done**

- Replay uses preserved original context where available.
- Tool and cwd-sensitive cases no longer collapse to generic `repoRoot` + `Shell`.
- Documentation and output make clear that corpus gates, not simulate counts, are the safety boundary.

**Additional context**

- Related files: [`src/core/reclassify.ts`](../src/core/reclassify.ts), [`src/commands/simulate.ts`](../src/commands/simulate.ts), audit schema/reporting
