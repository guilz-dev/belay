# Traffic Readiness Workload Alignment Design

## Goal

Align dogfood traffic readiness with real agent workloads (Shell + Tool Read) without weakening
EffectPlan authority. Fix evidence **collection bias** and **per-kind reporting** before changing
thresholds, tiers, or enforce rollout.

## Non-goals

- Command-name allowlists or runtime harvest authority (ADR-005).
- npm publish or release tagging in this workstream.
- Pre-committing threshold 150 → 100 or six-month calendar sunsets without post-fix metrics.
- Treating `rtk vitest` as `read_only + allow` argv-delegate success.

## Problem statement

### Layer A — gate definition (accurate)

`computeReviewedTrafficReadiness` in [`audit-metrics.ts`](../../../src/core/audit-metrics.ts):

- Joins active-cohort gate records to the harvest review ledger on
  `(fingerprint, kind, boundaryProfile)`.
- Counts records with outcome `provably-benign` regardless of gate-time allow/deny.
- Includes blocked events in `reviewedBenignBlocked` and the benign block rate denominator.

### Layer B — harvest collection (primary gap)

[`harvest.ts`](../../../src/core/harvest.ts) today:

- `filterRecordsForHarvest` — shell gate rows + approval events only.
- `extractHarvestCandidates` — ask-centric sources on shell records; allowed reads are omitted.

Therefore `reviewedBenignEvents: 0` usually means **no ledger entries**, not that the gate cannot
count reviews. Independent re-count of install-target snapshots is required before calendar
estimates (“one year”, “7,900 events”, etc.) are treated as facts.

### Dilution when Tool traffic enters

Adding Tool Read to the readiness numerator without per-kind guardrails can mask Shell
misclassification. Mitigation: per-kind block rates plus a minimum Shell reviewed-benign count.

## Workstream 1 — Harvest collection (Phase 1)

### Candidate sources

| Source | When | Notes |
| --- | --- | --- |
| `deny_then_approve` | existing | approval round-trip |
| `repeated_ask` | existing | classifier would-block repeats |
| `read_style_signal` | existing | shell would-block matching read-style pattern |
| `allowed_read` | **new** | `inferWouldBlock === false` and read disposition |

### Requirements

- Include tool gate rows in harvest filtering.
- `HarvestCandidate.kind: 'shell' | 'tool'`.
- Require `actionSnapshot` for automated review; drop incomplete projections.
- Do not reconstruct explain inputs from summary alone in batch tooling.

### `harvest apply` behavior

| kind | ledger | corpus |
| --- | --- | --- |
| shell | write | append `corpus/shell-commands.json` when promoted |
| tool | write | **no corpus write** |

`--command` remains required for fingerprint binding.

## Workstream 2 — Metrics and quality (Phase 1)

Expose per active cohort:

```ts
reviewedTraffic.byKind: {
  shell: { reviewedBenignEvents, reviewedBenignBlocked, benignBlockRate }
  tool:  { reviewedBenignEvents, reviewedBenignBlocked, benignBlockRate }
}
```

Traffic readiness adds:

- existing global thresholds (150 events, 3 sessions, 2% block rate, availability asks = 0);
- **shell minimum reviewed-benign count** `N` (value set after Phase 1 measurement, recorded in
  ADR-012 addendum).

`quality.harvest.scope` becomes `shell+tool` when tool candidates are enabled.

## Workstream 3 — Batch review tooling fixes

[`harvest-review-batch.mjs`](../../../.cursor/skills/dogfood-audit-rollup/scripts/harvest-review-batch.mjs)
must:

| defect | fix |
| --- | --- |
| reads `explain.reason` | use `explain.result.reason` and `explain.result.effectPlanProjection.permission` |
| missing `--command` on apply | pass `candidate.command` always |
| stdout noise | parse JSON from structured output only; use exit codes |

Automated `provably-benign` only when gate-time allow + read disposition. Blocked reads → manual
queue.

Add CLI integration test: `harvest list` → `explain` → `harvest apply`.

## Workstream 4 — Shell lowering (Phase 2, after measurement)

Priority corpus targets:

| Priority | pattern | success |
| --- | --- | --- |
| P0 | `rtk git status/diff/log` | inner git read preserved → `read_only` + `allow` |
| P0 | `rtk ls` | argv delegate read |
| P1 | `pnpm ci:local` | resolved script effects; no forced read_only |
| — | `rtk vitest` | **not** read_only success; keep mutation / `accepted-benign` |

## Workstream 5 — Enforce rollout (Phase 3)

### Per-target migration

```text
quality --target <repo> --json → readyForEnforce === true
```

No cross-repo evidence transfer.

### Limited enforce trial

| field | value |
| --- | --- |
| scope | one repo at a time (first candidate: scheduling-editor) |
| entry | `readyForEnforce` or Phase-2-approved `--force` |
| duration | ~1 week (recorded in runbook) |
| abort | benign block rate ≥ 2%, availability ask, corpus regression |
| rollback | `belay dogfood --target <repo>` (audit mode) |
| not rollback | `dogfood --check` (reports `dogfood_inactive` under enforce) |

### `--force` rules

May waive reviewed-traffic **count** only when:

- corpus hard gates pass;
- active-cohort availability asks = 0.

Never waive corpus or availability.

## Escalation (event-based, not calendar sunset)

Per-target triggers — any fires → policy review within one week:

| ID | condition |
| --- | --- |
| E1 | post-Phase-1 upgrade: `gateEvents ≥ 500` and `reviewedBenignEvents = 0` after batch review |
| E2 | 14 days post-upgrade: `gateEvents ≥ 200` and `reviewedBenignEvents < 10` |
| E3 | `harvest candidates > 0` but batch apply 0 twice consecutively (weekly rollup) |
| E4 | per-kind shell minimum or tool `benignBlockRate ≥ 2%` unchanged for 4 weeks |

**30-day cap:** scheduled policy review if no trigger fired — not a waiting period.

**Rejected:** six-month “sunset then decide” without measurement.

## Phase 1 exit criteria (not enforce migration)

- [ ] harvest lists tool + allowed shell read candidates
- [ ] tool `harvest apply` ledger-only
- [ ] per-kind metrics exposed
- [ ] batch script fixes + CLI integration test pass
- [ ] per-target verification documented

**Not** included: `reviewedBenignEvents ≥ 150`.

## Phase 3 exit criteria (per target)

- [ ] `readyForEnforce === true` on that repo's active cohort
- [ ] limited trial completed with monitoring record
- [ ] audit rollback path verified

## Verification commands

Per target (separate host Shell actions, literal `--target`):

```bash
node /absolute/path/to/belay/dist/cli.js harvest list --target <repo> --json
node /absolute/path/to/belay/dist/cli.js metrics --target <repo> --json
node /absolute/path/to/belay/dist/cli.js quality --target <repo> --json
```

After runtime upgrade, metrics apply to the **new cohort** only.
