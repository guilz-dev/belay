# Layer guarantee table (v0.9)

This table states what agent-belay guarantees **per configuration**. Adversarial
resistance is claimed **only** for the L1-full row when the external sandbox runtime
actually enforces deny-all (container / seatbelt / landlock / Cursor sandbox).

| Configuration | Layers active | Cooperative agent | Adversarial same-OS-user |
|---------------|---------------|-------------------|---------------------------|
| Default (L3+L4) | Prediction + approval | Heuristic gates + human approval for high-risk actions | Not protected — control plane and hooks are detect-only |
| L1 partial (egress) | Egress proxy + L3+L4 | HTTP(S) observed at proxy; L3 external rules become hints while proxy runs | Not protected — proxy bypass / raw sockets remain |
| L2 (transactional) | Observed diff + L3+L4 | Low-confidence local mutations observed in git worktree before commit | Not protected — snapshot-external effects remain |
| L1-full (sandbox + egress + isolation + signing) | Sandbox + egress broker + signed control plane + L3+L4 | External sends and outside-repo writes require approval; control plane tamper infeasible when isolation is correctly provisioned | Protected **only** when OS sandbox enforces FS/network deny-all and control plane is on a separate trust domain |

## L1-full prerequisites

All must be true for `agent-belay sandbox status` to report `l1FullActive: true`:

1. `sandbox.enabled: true` with a real external sandbox runtime (`runtime` ≠ `none`)
2. `egress.enabled: true` and the egress proxy running for this repository
3. `controlPlane.isolation.mode` is `read-only-mount` or `separate-user`, verified by doctor
4. `approvalSigning.required: true`

## Capability broker surfaces

| Capability | Broker mechanism | Approval command |
|------------|------------------|------------------|
| Egress (HTTP/S) | Egress proxy + domain allowlist | `agent-belay approve <id> --scope domain` |
| FS outside repo | Sandbox + fs-scope allowlist | `agent-belay approve <id> --scope path --path <abs-path>` |

## What is never guaranteed

- Covert channels (DNS tricks, raw sockets, IPC) without OS sandbox enforcement
- Agent compliance when hooks are disabled or bypassed outside the IDE
- Protection when config promises L1-full but the sandbox runtime is not actually engaged
