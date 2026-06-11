# agent-belay v1.0 — Stable Belay (requirements)

Status: **Shipped** (v1.0.0).
Predecessor: v0.9 (layer conformance, capability broker).
Companion: [SPEC-v1.0.md](./SPEC-v1.0.md), [guarantee-table.md](./guarantee-table.md).

## 1. Goals

- G1. Publish a **per-configuration guarantee table** that states what each layer
  stack promises for cooperative vs adversarial agents.
- G2. **Test** every documented gate scenario per configuration profile.
- G3. Document **signed + isolated control plane** as the recommended adversarial
  stack without silently changing fresh-install defaults.
- G4. Document **L3 classifier lists** as noise-reduction caches with explicit
  semver rules (minor releases, not security patches).
- G5. Provide an **adapter SDK** document sufficient to implement a new adapter
  without reading implementation internals.
- G6. Ship **semver 1.0.0** with a stable documented export surface.
- G7. Align **README** and **SECURITY.md** with the layered model (no self-contradicting
  denylist narrative).

## 2. Acceptance criteria

| ID | Requirement | Verification |
|----|-------------|--------------|
| R1 | Guarantee table lists 4 configurations | `docs/guarantee-table.md` |
| R2 | Each profile has ≥2 gate scenarios with scenario IDs | `src/conformance/guarantee-table.ts` |
| R3 | Conformance tests run all scenarios | `src/__tests__/conformance/layer-matrix.test.ts` |
| R4 | Profile-specific layer behavior tested | `src/__tests__/conformance/guarantee-table.test.ts` |
| R5 | `l1-full-recommended` preset exists | `src/presets.ts`, `src/__tests__/presets.test.ts` |
| R6 | `init --preset` applies preset | `src/cli.ts`, installer |
| R7 | Semver policy document | `docs/semver-policy.md` |
| R8 | Adapter SDK document | `docs/adapter-sdk.md` |
| R9 | Config v3 stable reference | `docs/config-schema-v3.md` |
| R10 | Package version `1.0.0` | `package.json`, `src/version.ts` |
| R11 | Gate contract exported from package entry | `src/index.ts` |
| R12 | README scope describes L1–L4 layers | `README.md` |
| R13 | SECURITY.md states L3 list posture | `SECURITY.md` |

## 3. Non-goals (v1.0)

- NG1. Forcing `approvalSigning.required: true` on fresh install.
- NG2. Implementing OS sandbox runtimes (external provision only).
- NG3. Guaranteeing containment without L1-full prerequisites met.
- NG4. Replacing policy-as-code with a new policy language DSL.

## 4. Threat model alignment

Adversarial resistance is claimed **only** for the L1-full row when:

1. External sandbox enforces FS/network deny-all.
2. Egress proxy is running and honored.
3. Control plane is on a separate trust domain with signing required.

All other rows remain **cooperative-but-fallible** per [SECURITY.md](../SECURITY.md).
