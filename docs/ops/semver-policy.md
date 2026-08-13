# Semver policy (v1.0+)

`belay` follows [Semantic Versioning](https://semver.org/) from **1.0.0**.

## Version components

| Bump | When |
|------|------|
| **MAJOR** | Breaking changes to documented adapter SDK exports, `GATE_CONTRACT_VERSION` incompatible change, breaking config v3 schema changes, removal of supported adapters |
| **MINOR** | New features, new EffectPlan semantic decoders/policy rules, new conformance scenarios, new presets, new optional config fields with defaults |
| **PATCH** | Bug fixes, documentation, internal refactors with no observable behavior change |

## L3 shell classification

Normalized shell authorization is based on canonical EffectPlan semantics, not command-key
allow/deny lists. Legacy list-shaped config remains parse-compatible but inert.

- Adding or changing a semantic decoder, effect policy rule, or documented conformance
  scenario ships in a **minor** release.
- A correction that closes an EffectPlan, boundary, or approval bypass may be
  security-relevant even when the public schema does not change.
- Operators needing hard boundaries must enable **L1** (egress / sandbox) and/or **L2**
  (transactional) per [guarantee-table.md](../guarantee-table.md).

## Gate contract

`GATE_CONTRACT_VERSION` in `src/core/gate-contract.ts` is part of the public adapter
SDK. Incrementing it requires a **major** release and migration notes.

## Config schema

Config `version: 4` is stable for 2.x. New optional fields default safely in
`normalizeConfig`. Removing or renaming fields requires a **major** release and
migration code.

Stable CLI surface (semver applies): `init`, `upgrade`, `doctor`, `explain`, `status`,
`report`, `recover`, `approve`, `metrics`, `audit`, and config schema v4.
