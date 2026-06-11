# Semver policy (v1.0+)

agent-belay follows [Semantic Versioning](https://semver.org/) from **1.0.0**.

## Version components

| Bump | When |
|------|------|
| **MAJOR** | Breaking changes to documented adapter SDK exports, `GATE_CONTRACT_VERSION` incompatible change, breaking config v3 schema changes, removal of supported adapters |
| **MINOR** | New features, new policy rules, **L3 command-key list updates**, new conformance scenarios, new presets, new optional config fields with defaults |
| **PATCH** | Bug fixes, documentation, internal refactors with no observable behavior change |

## L3 classifier lists

Files such as `src/core/policy/command-keys.ts` and `src/core/policy/default-rules.ts`
maintain **noise-reduction caches** for the prediction layer (L3). They are **not**
security boundaries when L1/L2 are absent.

- Adding, removing, or reclassifying command keys ships in a **minor** release.
- Do **not** label routine list maintenance as a security advisory unless it fixes
  an actual enforcement bypass in L1/L2 or approval logic.
- Operators needing hard boundaries must enable **L1** (egress / sandbox) and/or **L2**
  (transactional) per [guarantee-table.md](./guarantee-table.md).

## Gate contract

`GATE_CONTRACT_VERSION` in `src/core/gate-contract.ts` is part of the public adapter
SDK. Incrementing it requires a **major** release and migration notes.

## Config schema

Config `version: 3` is stable for 1.x. New optional fields default safely in
`normalizeConfig`. Removing or renaming fields requires a **major** release and
migration code.

## Release checklist

1. `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
2. Ubuntu + macOS CI green
3. Update `CHANGELOG.md`
4. Verify conformance scenarios still match `docs/guarantee-table.md`
5. Rebuild `dist/` before publish
