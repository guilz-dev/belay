# ADR-001: From prediction-based classification to layered enforcement

**Status:** Proposed
**Date:** 2026-06-11
**Deciders:** kaz (maintainer)
**Related:** [`ROADMAP.md`](../ROADMAP.md), [`SECURITY.md`](../../SECURITY.md)

> English translation of [`ADR-001-layered-enforcement.ja.md`](./ADR-001-layered-enforcement.ja.md). The Japanese file is authoritative if the two diverge.

## Context (forces at play)

agent-belay's design thesis is "static denylists are broken — a list can't read
context" (README). But that critique is symmetric: **it applies with equal force
to whitelists**. The v0.3.x code audit actually found whitelist-side bugs of the
same shape: putting `find` on the read-only list made `find -exec rm` resolve to
allow; `curl -H "Authorization: …"` ended up more permissive than plain `curl`,
and so on.

The root cause is architectural, not list quality. The current gate is built to
**predict the effect of a command from its text**, and:

1. Fully deciding the effect of arbitrary code ahead of time is impossible in
   principle (Rice's theorem). As long as the gate is predictive, a knowledge
   structure (a list) is mandatory, and gaps will always remain.
2. LLM assistance (the v0.5 plan) is just a swap to an "implicit learned list" —
   it does not escape this limit.
3. In the current structure, a gap in the list *is* a gap in safety (and that
   stays true after going fail-closed: the prediction layer still carries the
   boundary).

Meanwhile the roadmap's defining question is "guardrail or boundary?", and v1.0
targets "a guarantee the user can put their weight on." There is no boundary at
the end of the prediction road.

## Decision

Restructure enforcement into four layers and **move the safety boundary from
"prediction" to "containment (choke points) and observation."**

```
L1 Containment — egress control, sandbox, OS permissions. deny-all is the boundary. No list needed.
L2 Observation — execute on a snapshot and judge the actually observed effect (diff).
L3 Prediction  — the current classifier. Not a boundary; a noise-reduction cache that keeps L4 quiet.
L4 Approval    — the final catch-all for residual uncertainty (existing one-shot approval loop).
```

- **External effects** (irreversible, non-rollbackable) are handled at L1: not by
  predicting command names, but by allowing/denying/approving the *observed
  connection request* at a network choke point.
- **Local destructive effects** are handled at L2: execute on a snapshot
  (worktree / CoW), judge the actual change diff, and only then commit.
- The L3 command lists stay, but are demoted from being the final basis of a
  verdict to "waving through the obviously safe" and "early warning before the
  choke point is reached."
- belay's core asset is not the classifier but the **approval loop + audit +
  ops CLI**, repositioned as an "approval broker" in front of L1/L2.

### Does the whitelist become unnecessary? (answered explicitly)

**No — but its role changes.** Three kinds of list remain:

1. **Effect-category policy** (writes outside the repo / network sends / deletes
   / control-plane changes) — small, closed, stable.
2. **Approval cache** — the accumulation of destinations and operations a human
   approved. Not a list written at design time, but one that grows from human
   judgment during operation.
3. **L3 prediction lists** — retained only as a latency/noise optimization.

The decisive change is the consequence outside the list. As long as the choke
point is deny-all, **a miss in the whitelist is friction (ask a human), not a
breach.** List quality drives UX but no longer drives safety. This is what makes
the README's denylist critique stop being self-contradictory.

## Options Considered

### Option A: Better prediction (extend the current path)

Keep raising prediction accuracy with bigger lists + argument parsing + LLM
assistance.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium (incremental but never-ending) |
| Cost | Low (keeps the existing structure) |
| Reachable guarantee | Guardrail at best. "List gap = safety gap" becomes permanent |
| Platform dependence | None |

**Pros:** Extension of existing code. Install experience unchanged.
**Cons:** Low theoretical ceiling. A perpetual bypass-discovery → patch race.
Stays self-contradictory with the product's central claim (the denylist critique).

### Option B: Pure OS sandbox (dismantle belay)

Isolate the agent in a container / separate user and stop being a gate product.

| Dimension | Assessment |
|-----------|------------|
| Complexity | High (becoming an infra product) |
| Cost | High (abandons most existing assets) |
| Reachable guarantee | Boundary (including adversarial) |
| Platform dependence | Large |

**Pros:** Strongest guarantee. The decidability problem itself disappears.
**Cons:** deny-all goes unused without an approval UX. The fine-grained "allow
this once" operation (belay's strength) is lost. Existing hook adapters,
approval loop, and audit assets get thrown away.

### Option C: Layered (L1–L4) — turn belay into an approval broker (adopted)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium–High (can be introduced in stages) |
| Cost | Medium (all L3/L4 assets reused) |
| Reachable guarantee | A boundary that can be stated per layer (L1/L2) + guardrail (L3) |
| Platform dependence | Only the L2 backend (absorbed by abstraction) |

**Pros:** The approval loop, audit, and adapter assets carry over directly as the
UX layer for L1/L2. Opt-in, staged adoption; each layer has independent value.
Guarantees can be described honestly, layer by layer.
**Cons:** The install experience changes (proxy / sandbox integration).
Maintaining platform differences. A latency budget must be managed.

## Trade-off Analysis

- **A vs C**: A has rising marginal cost (list maintenance never ends), whereas C
  makes the "enumerate every external effect" problem disappear with just L1
  egress control. External effects are the most important and the hardest to
  enumerate among the things belay denies, so choke-pointing them has the highest
  cost-effectiveness.
- **B vs C**: B's deny-all gets disabled in the field without an approval
  experience (the "a noisy gate gets turned off" principle). C connects belay's
  approval UX to B's enforcement strength — division of labor, not opposition.
- **Residual risk**: covert channels (e.g. exfiltration via DNS) remain even with
  L1. An adversarial same-OS-user agent is out of scope until the v0.9
  control-plane separation. Both are documented as per-layer guarantees in
  SECURITY.md.

## Consequences

- Becomes easier: explaining guarantees (a per-layer guarantee table). Covering
  external effects (enumerate → observe). Making reversibility / blast radius
  measured rather than guessed (the L2 diff). Aligning the README's philosophy
  with the implementation.
- Becomes harder: cross-platform maintenance (the L2 backend), staged install
  (L1 assumes infrastructure), latency-budget management.
- Needs revisiting: the priority of the v0.5 "better prediction" items (since L3
  is no longer the boundary, keep corpus measurement but the investment can
  shrink). The threat-model wording in `SECURITY.md`. The meaning of the
  fail-closed default (v0.4) — after L1 lands it becomes "the fallback for
  environments where L1 is not configured."

## Action Items

1. [ ] Review this ADR and move it to Accepted.
2. [ ] Confirm the milestone wording in `ROADMAP.md`.
3. [x] Reflect into `ROADMAP.md` (done in this commit).
4. [ ] Re-scope the L3-hardening items in the v0.5 plan (keep corpus measurement).
5. [ ] Add a per-layer guarantee section to SECURITY.md (at v0.7 ship).
