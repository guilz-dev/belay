# agent-belay SPEC v1.0 — Stable Belay

> Full requirements and acceptance criteria:
> [SPEC-v1.0-requirements.md](./SPEC-v1.0-requirements.md).
> Layer guarantees: [guarantee-table.md](./guarantee-table.md).
> Strategic context: [ROADMAP-strategic.md](./ROADMAP-strategic.md) § v1.0.

## Summary

v1.0 commits to **layered, testable guarantees** and a **stable public surface** for
adapters and configuration. Belay v0.7–v0.9 shipped containment (L1), observed
effects (L2), and capability brokering; v1.0 documents what each configuration
promises, how semver applies to heuristic lists, and how to build a new adapter
without reading the whole codebase.

**Package version:** `1.0.0` — semver applies to the adapter SDK exports documented
in [adapter-sdk.md](./adapter-sdk.md).

## Layer guarantee table (normative)

The authoritative per-configuration matrix lives in
[guarantee-table.md](./guarantee-table.md). Each row is backed by conformance
scenarios in `src/conformance/guarantee-table.ts` and tests under
`src/__tests__/conformance/`.

| Configuration | Layers | Adversarial claim |
|---------------|--------|-------------------|
| Default (L3+L4) | Prediction + approval | None — cooperative model only |
| L1 partial (egress) | Egress proxy + L3+L4 | None — proxy-respecting clients only |
| L2 (transactional) | Observed diff + L3+L4 | None — git-worktree partial L2 |
| L1-full | Sandbox + egress + signed isolated control plane + L3+L4 | **Only** when OS sandbox enforces deny-all |

Classifier command lists (L3) are **noise-reduction caches**, not security
boundaries. See [semver-policy.md](./semver-policy.md).

## Recommended production configuration

v1.0 does **not** change fresh-install code defaults (`approvalSigning.required`
remains `false`, `controlPlane.isolation.mode` remains `none`). Instead, operators
targeting adversarial same-OS-user resistance should use the **`l1-full-recommended`**
preset:

```bash
agent-belay init --preset l1-full-recommended
```

`init --dogfood` runs **after** `--preset` and sets `mode: audit` (overriding a preset's
`enforce` mode). Use `--preset` without `--dogfood` when you want production enforce
settings immediately; combine them only when you intend an audit-first rollout on top of
preset policy fields (sandbox, egress, signing, isolation).

Preset contents (see `src/presets.ts`):

- `sandbox.enabled` + `runtime: container`
- `egress.enabled` + `demoteL3External: true`
- `approvalSigning.required: true`
- `controlPlane.isolation.mode: separate-user`
- fail-closed `policy` for unknown / unparseable shell

Verify with:

```bash
agent-belay sandbox status
agent-belay doctor
```

External sandbox runtime and egress proxy must be provisioned separately; belay
brokers capability widening and documents prerequisites.

## Stable config schema

Config **v3** is the stable schema for v1.0. v1/v2 configs migrate automatically.
Field reference: [config-schema-v3.md](./config-schema-v3.md).

Breaking config schema changes require a **major** release.

## Adapter SDK (stable exports)

Documented public surface for third-party adapters:

| Export | Stability |
|--------|-----------|
| `BelayAdapter`, `getAdapter`, `listAdapters` | Stable |
| `GATE_CONTRACT_VERSION`, `GateVerdict`, `GatedAction` | Stable (version field bumps = major) |
| `classifyShell`, `classifyToolUse`, `classifySubagent` | Stable |
| `DEFAULT_CONFIG_V3`, `mergeConfig`, `migrateConfig` | Stable |
| `CONFIG_PRESETS`, `applyConfigPreset` | Stable |
| `PACKAGE_VERSION` | Stable |

Authoring guide: [adapter-sdk.md](./adapter-sdk.md).

Conformance: pass `src/__tests__/conformance/adapters.test.ts` for your adapter.

## Semver policy (summary)

- **Major** — breaking adapter contract, breaking config schema, removal of documented exports.
- **Minor** — new features, L3 command-key / policy rule updates, new conformance scenarios.
- **Patch** — bug fixes, docs, non-behavioral changes.

L3 list updates are **minor**, not security-patch exceptions, because lists are not
boundaries. Full rules: [semver-policy.md](./semver-policy.md).

## CLI additions (v1.0)

```bash
agent-belay init [--preset strict|standard|audit-first|l1-full-recommended]
```

## Migration from v0.x

- No config migration required for v1.0.0.
- Run `agent-belay upgrade` to refresh runtime bundles and integrity manifest.
- Read [guarantee-table.md](./guarantee-table.md) to choose a layer profile; use
  `explain` and `sandbox status` to validate active demotion / L1-full prerequisites.

## Related documents

- [ADR-001](./ADR-001-layered-enforcement.md) — layered enforcement rationale
- [SECURITY.md](../SECURITY.md) — threat model and layer limits
- [v0.7-v1.0-plan.md](./v0.7-v1.0-plan.md) — milestone history
