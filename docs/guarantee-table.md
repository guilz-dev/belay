# Layer guarantee table (v1.0)

This table states what belay guarantees **per configuration**. Adversarial
resistance is claimed **only** for the L1-full row when the external sandbox runtime
actually enforces deny-all (container / seatbelt / landlock / Cursor sandbox).

Machine-readable source: `src/conformance/guarantee-table.ts`.  
Conformance tests: `src/__tests__/conformance/layer-matrix.test.ts`,
`src/__tests__/conformance/guarantee-table.test.ts`.

| Configuration | Layers active | Cooperative agent | Adversarial same-OS-user | Tested scenarios |
|---------------|---------------|-------------------|---------------------------|------------------|
| Default (L3+L4) | Prediction + approval | Heuristic gates + human approval for high-risk actions | Not protected — control plane and hooks are detect-only | `l3-allow-readonly`, `l3-allow-read-egress` |
| L1 partial (egress) | Egress proxy + L3+L4 | Read-only egress passes; mutate/exfil still requires approval | Not protected — proxy bypass / raw sockets remain | `l1p-allow-readonly`, `l1p-allow-read-egress`, `l1p-deny-write-egress` |
| L2 (transactional) | Observed diff + L3+L4 | Low-confidence local mutations observed in git worktree before commit | Not protected — snapshot-external effects remain | `l2-allow-readonly`, `l2-allow-read-egress` |
| L1-full (sandbox + egress + isolation + signing) | Sandbox + egress broker + signed control plane + L3+L4 | Read-only egress passes; external sends and outside-repo writes require approval when the outer boundary can see them | Protected **only** when OS sandbox enforces FS/network deny-all and control plane is on a separate trust domain | `l1f-allow-readonly`, `l1f-allow-read-egress`, `l1f-deny-write-egress`, `l1f-deny-outside-repo` |

## L1-full prerequisites

All must be true for `belay sandbox status` to report `l1FullActive: true`:

1. `sandbox.enabled: true` with a real external sandbox runtime (`runtime` ≠ `none`)
2. `egress.enabled: true` and the egress proxy running for this repository
3. `controlPlane.isolation.mode` is `read-only-mount` or `separate-user`, verified by doctor
4. `approvalSigning.required: true`

Recommended starting point: `belay init --preset l1-full-recommended`.

## Capability broker surfaces

| Capability | Broker mechanism | Approval command |
|------------|------------------|------------------|
| Egress (HTTP/S) | Egress proxy + domain allowlist | `belay approve <id> --scope domain` |
| FS outside repo | Sandbox + fs-scope allowlist | `belay approve <id> --scope path --path <abs-path>` |

## L3 classifier lists

Command-name lists are **noise-reduction caches** for the prediction layer (L3), not
security boundaries. See [semver-policy.md](./ops/semver-policy.md).

## What is never guaranteed

- Covert channels (DNS tricks, raw sockets, IPC) without OS sandbox enforcement
- Agent compliance when hooks are disabled or bypassed outside the IDE
- Protection when config promises L1-full but the sandbox runtime is not actually engaged

## Skill intelligence layer (v2.3, advisory only)

`belay report` and `belay recover` are **read-only advisory** commands. They do
not change hook verdicts, auto-execute shell, or bypass the enforcement floor (ADR-002).

| Surface | Behavior | Security note |
|---------|----------|---------------|
| `report` | Aggregates redacted `audit.ndjson` | No new classification; cannot widen allow |
| `recover` | Suggests undo steps; does not run them | Advice is partial — based on hook-visible audit only |
| `recover --command` | Re-runs shell classification for the given text | May invoke Tier1 judge (egress to Ollama/cloud); classification only |

Recovery suggestions are intentionally conservative: irreversible undo patterns (e.g.
`git reset --hard`) are never recommended. Operators must verify steps manually; recovery
commands themselves are subject to the same hooks if executed.
