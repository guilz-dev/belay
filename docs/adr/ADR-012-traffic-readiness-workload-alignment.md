# ADR-012 — Traffic readiness workload alignment

- Status: Accepted
- Date: 2026-09-17
- Related: [ADR-005](./ADR-005-command-allowlist-prohibition.md),
  [dogfood-install-targets.ja.md](../ops/dogfood-install-targets.ja.md),
  [2026-09-17 traffic readiness design](../superpowers/specs/2026-09-17-traffic-readiness-workload-alignment-design.md)

## Context

Dogfood traffic readiness requires reviewed `provably-benign` events (currently 150 across three
valid session correlations), a benign block rate below 2%, zero active-cohort availability asks,
and passing corpus hard gates. Install targets frequently show `reviewedBenignEvents: 0` even when
gate traffic is substantial.

Two separate mechanisms must not be conflated:

### Layer A — readiness gate (`audit-metrics`)

[`src/core/audit-metrics.ts`](../../src/core/audit-metrics.ts) counts **all active-cohort gate
records** whose `(fingerprint, kind, boundaryProfile)` matches a ledger entry with outcome
`provably-benign`. This is **not** limited to gate-time `allow` verdicts. **Blocked events are
included** in both `reviewedBenignEvents` and `reviewedBenignBlocked`.

Therefore “only allow-time reads count toward 150” is **incorrect**. The gate can count reviewed
traffic once ledger entries exist.

### Layer B — evidence collection (`harvest`)

[`src/core/harvest.ts`](../../src/core/harvest.ts) currently extracts candidates from **shell**
records using ask-centric sources (`deny_then_approve`, `repeated_ask`, `read_style_signal`).
Normally **allowed** read traffic — including Tool Read — does **not** become a harvest candidate.
Harvest scope is shell-only today.

The primary operational gap is therefore **collection bias**, not gate reachability. Claims such as
“150 events can never be reached in one year” are **not proven** by current snapshots alone and must
not drive policy changes without post-fix measurement.

### Dilution risk when Tool traffic is added

If Tool Read events are admitted into the readiness denominator without per-kind guardrails, a
fleet could pass while Shell misclassification remains high (for example 1,000 allowed Tool reads
and 10 blocked Shell events → ~1% combined benign block rate).

## Decision

1. **Separate diagnosis from policy change** — Phase 0–1 fixes collection and reporting bias
   first. Threshold changes (for example 150 → 100), tier definitions, and limited enforce trials
   are decided only after per-target post-fix metrics. No calendar sunset (for example six months)
   as a substitute for measurement.

2. **Per-target evidence** — `readyForEnforce === true` is required **per repository**. Evidence
   from guilz-trace does not authorize enforce on scheduling-editor or any other target.

3. **Per-kind metrics (Phase 1)** — `metrics` / `quality` expose `reviewedBenignEvents`,
   `reviewedBenignBlocked`, and `benignBlockRate` **by kind** (`shell`, `tool`). Traffic readiness
   also requires a **minimum Shell reviewed-benign count** once Phase 1 measurement sets `N`.

4. **Harvest collection expansion (Phase 1)** — Harvest lists **allowed read** candidates
   (`allowed_read`) in addition to ask-centric sources. Candidates require a complete
   `actionSnapshot`; summary-only reconstruction is insufficient for automated review.

5. **Tool harvest apply is ledger-only** — `harvest apply` for `kind: tool` writes the review
   ledger only. It does **not** append to `corpus/shell-commands.json`. Shell harvest apply keeps
   ledger + corpus behavior.

6. **Blocked read review path** — Automated `provably-benign` promotion applies only to gate-time
   `allow` + `read_only` (or equivalent read disposition). Blocked reads remain in manual review
   queues and stay in blocked numerators when reviewed.

7. **`--force` limits** — `dogfood --enforce --force` may override the reviewed-traffic count
   threshold only when **corpus hard gates pass** and **active-cohort availability asks = 0**.
   `--force` does not waive corpus or availability requirements.

8. **Enforce rollback is not `dogfood --check`** — [`dogfood-check.ts`](../../src/commands/dogfood-check.ts)
   reports `dogfood_inactive` when mode is enforce; it does not revert config. Return to audit mode
   with `belay dogfood --target <repo>` ([`dogfood.ts`](../../src/commands/dogfood.ts)).

9. **Argv-delegate success criteria** — `rtk git status` / `rtk git diff` style delegation must
   preserve inner read effects. **`rtk vitest` is not a read-only success target**; test runners
   may mutate, reach the network, or execute arbitrary code. Vitest cases belong in
   `accepted-benign` / mutation expectations, not `read_only + allow` corpus goals.

10. **Event-based escalation** — Per-target escalation triggers (E1–E4 in the design spec) require
    policy review when collection fixes fail to produce reviewed traffic. A 30-day cap triggers a
    scheduled review, not a waiting period.

## Consequences

- Operators distinguish “no ledger reviews yet” from “gate cannot count reviews.”
- Phase 1 implementation is required before Tool traffic materially affects readiness numerators.
- Enforce trials document rollback via `belay dogfood --target <repo>`, not `dogfood --check`.
- Cross-repository enforce migration remains forbidden.

## Out of scope (this ADR)

- Lowering MUST-ASK shell constructs (loops, opaque wrappers, executable heredocs).
- npm publish or release tagging.
- Pre-committing threshold 150 → 100 without post-Phase-1 data.
