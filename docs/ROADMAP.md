# agent-belay Roadmap

> Strategic context (north star, threat model narrative):
> [ROADMAP-strategic.md](./ROADMAP-strategic.md).

## Released

| Version | Focus | Status |
|---------|-------|--------|
| **v0.1** | Cursor hook adapter, one-shot approval, basic heuristics | Shipped |
| **v0.2** | Testable core, stronger classifier, config v2, ops CLI | Shipped — see [v0.2-plan.md](./v0.2-plan.md) |
| **v0.3** | Config v3, fail-closed shell, control plane, redaction | Shipped — see [SPEC-v0.3.md](./SPEC-v0.3.md) |
| **v0.3.1** | OQ1 dogfood metrics, OQ3 hook spike, orphan cleanup, substitution hardening | Shipped |
| **v0.3.2** | `dogfood` CLI, status/doctor OQ3 visibility, `init --dogfood`, closure checklist | Shipped |
| **v0.3.3** | OQ3 + minimum-sample gates on `dogfood --enforce` | Shipped |
| **v0.4** | Portable adapters, gate contract, Claude Code adapter, fail-closed defaults | Shipped — see [v0.4-plan.md](./v0.4-plan.md) |
| **v0.5** | Policy-as-code judgment, corpus metrics, confidence thresholds | Shipped — see [v0.5-plan.md](./v0.5-plan.md) |
| **v0.6** | Audit tooling, simulation, layered config, signed OOB approval | Shipped — see [v0.6-plan.md](./v0.6-plan.md) |
| **v0.7** | Egress chokepoint (L1), approval broker reuse, L3 external demotion | Shipped — see [v0.7-v1.0-plan.md](./v0.7-v1.0-plan.md) |
| **v0.8** | Transactional execution (L2), observed diff assessment, predicted vs observed audit | Shipped — see [v0.7-v1.0-plan.md](./v0.7-v1.0-plan.md) |
| **v0.9** | Capability broker, control-plane isolation, layer conformance matrix | Shipped — see [v0.7-v1.0-plan.md](./v0.7-v1.0-plan.md), [guarantee-table.md](./guarantee-table.md) |
| **v1.0** | Stable Belay — guarantee table tested per config, adapter SDK, semver policy, L1-full preset | Shipped — see [SPEC-v1.0.md](./SPEC-v1.0.md) |

## v0.3 (0.3.0)

**Theme:** Harden defaults, move control state out of the repo, prepare for multi-adapter.

Recommended implementation order (dependency-driven):

1. **Config v3 + migration** — `policy` / `overrides` / `redaction` / `controlPlane` schema, M1 mapping ([SPEC-v0.3.md](./SPEC-v0.3.md))
2. **OQ3 spike** — confirm `beforeSubmitPrompt` can read/write `~/.config/agent-belay/` from hook context
3. **Fail-closed + overrides (same PR)** — `unknown_local_effect` deny (OQ1), shell hardening R1–R4, overrides runtime R13, precedence T4
4. **Parallel** — realpath R5, redaction R10
5. **Control plane** — installer / runtime / doctor R6–R8, Write-tool path deny R8, e2e T3
6. **Docs** — SECURITY.md R9, README G7

### v0.3 deliverables

- Config v3 with automatic v1/v2 migration
- Fail-closed shell mode (opt-in via `policy.unknownLocalEffect`, default unchanged until dogfood)
- User-level control plane at `~/.config/agent-belay/`
- Extended audit redaction
- SECURITY.md threat model update

## v0.3.1 (shipped)

- **OQ1 dogfood** — `agent-belay metrics`, enriched audit fields (`wouldBlock`), audit mode without pending-approval noise
- **OQ3 validation** — `controlPlane.spikeOnPrompt` writes `oq3-spike-last.json` from `beforeSubmitPrompt`
- **Orphan cleanup** — `doctor --fix`, reverse migration on disable
- **Shell** — nested/multi command substitution parsing

## v0.3.2 (shipped)

- **`agent-belay dogfood`** — one-command OQ1 + OQ3 setup; `--enforce` promotes when metrics ready
- **`init --dogfood`** — new projects start in dogfood mode
- **status / doctor** — dogfood readiness and OQ3 spike visibility
- **Closure checklist** — [v0.3-remaining.md](./v0.3-remaining.md) (tag + operational validation)

## v0.4+ (planned)

- Flip `unknownLocalEffect` default to `deny` after dogfood metrics justify it (OQ1)
- Second runtime adapter behind `BelayAdapter`
- Agent-side `Assessment` ingestion
- Optional policy bundles / team presets

Per-milestone plans: [v0.3 remaining](./v0.3-remaining.md),
[v0.4](./v0.4-plan.md), [v0.5](./v0.5-plan.md), [v0.6](./v0.6-plan.md),
[v0.7–v1.0](./v0.7-v1.0-plan.md) (layered enforcement, per
[ADR-001](./ADR-001-layered-enforcement.md)).

## Principles

- **Fail closed with escape hatches** — breaking behavior ships with `overrides` and `explain`, never alone.
- **Dogfood in audit mode** — measure deny rates before flipping defaults.
- **Spike unknowns early** — control-plane filesystem access (OQ3) before large structural refactors.
- **Pure core, thin adapters** — schema and classifiers stay testable without hook I/O.
