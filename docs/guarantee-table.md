# Layer guarantee table (v1.0)

This table states what agent-belay guarantees **per configuration**. Adversarial
resistance is claimed **only** for the L1-full row when the external sandbox runtime
actually enforces deny-all (container / seatbelt / landlock / Cursor sandbox).

Machine-readable source: `src/conformance/guarantee-table.ts`.  
Conformance tests: `src/__tests__/conformance/layer-matrix.test.ts`,
`src/__tests__/conformance/guarantee-table.test.ts`.

| Configuration | Layers active | Cooperative agent | Adversarial same-OS-user | Tested scenarios |
|---------------|---------------|-------------------|---------------------------|------------------|
| Default (L3+L4) | Prediction + approval | Heuristic gates + human approval for high-risk actions | Not protected — control plane and hooks are detect-only | `l3-allow-readonly`, `l3-deny-external` |
| L1 partial (egress) | Egress proxy + L3+L4 | HTTP(S) observed at proxy; L3 external rules become hints while proxy runs | Not protected — proxy bypass / raw sockets remain | `l1p-allow-readonly`, `l1p-deny-external-without-proxy`, `l1p-demote-external-with-proxy` |
| L2 (transactional) | Observed diff + L3+L4 | Low-confidence local mutations observed in git worktree before commit | Not protected — snapshot-external effects remain | `l2-allow-readonly`, `l2-deny-external` |
| L1-full (sandbox + egress + isolation + signing) | Sandbox + egress broker + signed control plane + L3+L4 | External sends and outside-repo writes require approval; control plane tamper infeasible when isolation is correctly provisioned | Protected **only** when OS sandbox enforces FS/network deny-all and control plane is on a separate trust domain | `l1f-allow-readonly`, `l1f-deny-external`, `l1f-deny-outside-repo` |

## L1-full prerequisites

All must be true for `agent-belay sandbox status` to report `l1FullActive: true`:

1. `sandbox.enabled: true` with a real external sandbox runtime (`runtime` ≠ `none`)
2. `egress.enabled: true` and the egress proxy running for this repository
3. `controlPlane.isolation.mode` is `read-only-mount` or `separate-user`, verified by doctor
4. `approvalSigning.required: true`

Recommended starting point: `agent-belay init --preset l1-full-recommended`.

## Capability broker surfaces

| Capability | Broker mechanism | Approval command |
|------------|------------------|------------------|
| Egress (HTTP/S) | Egress proxy + domain allowlist | `agent-belay approve <id> --scope domain` |
| FS outside repo | Sandbox + fs-scope allowlist | `agent-belay approve <id> --scope path --path <abs-path>` |

## L3 classifier lists

Command-name lists are **noise-reduction caches** for the prediction layer (L3), not
security boundaries. See [semver-policy.md](./semver-policy.md).

## What is never guaranteed

- Covert channels (DNS tricks, raw sockets, IPC) without OS sandbox enforcement
- Agent compliance when hooks are disabled or bypassed outside the IDE
- Protection when config promises L1-full but the sandbox runtime is not actually engaged
