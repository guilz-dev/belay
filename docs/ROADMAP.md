# agent-belay Roadmap

## Released

| Version | Focus | Status |
|---------|-------|--------|
| **v0.1** | Cursor hook adapter, one-shot approval, basic heuristics | Shipped |
| **v0.2** | Testable core, stronger classifier, config v2, ops CLI | Shipped — see [v0.2-plan.md](./v0.2-plan.md) |

## v0.3 (shipped in 0.3.0)

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

## v0.4+ (planned)

- Second runtime adapter behind `BelayAdapter`
- Agent-side `Assessment` ingestion
- Optional policy bundles / team presets

## Principles

- **Fail closed with escape hatches** — breaking behavior ships with `overrides` and `explain`, never alone.
- **Dogfood in audit mode** — measure deny rates before flipping defaults.
- **Spike unknowns early** — control-plane filesystem access (OQ3) before large structural refactors.
- **Pure core, thin adapters** — schema and classifiers stay testable without hook I/O.
