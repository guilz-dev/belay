# Execution boundary map

Status: **Active**  
Complements [grant-consumption-paths.md](./grant-consumption-paths.md) and [CONTEXT.md](./CONTEXT.md).

## Classification

Every gated action follows one of three execution classes:

| Class | Meaning | Runtime enforcement |
|-------|---------|---------------------|
| **prediction-only** | Belay classifies and returns allow/deny; the host agent executes | Policy only (`deniesUngrantedEffects: false` on host-integration) |
| **mediated execution** | Belay runs the command via `BoundaryDriver` before applying observed-safe diffs | Transactional shell path; container may enforce mount/network when attested |
| **approved replay** | Approved shell replay via CLI or hook auto-replay | Configured `BoundaryDriver`; one-shot grant claimed before execution |

## Paths

### prediction-only (default hook allow)

- Cursor / Claude / Codex shell, tool, subagent hooks → `evaluateGatedAction` → `permission: allow` → **host executes**
- Classification: `classifyShell` / `classifyToolUse` / `classifySubagent` → `PolicyEngine`
- Grants consumed at gate-runtime (`approved_once`, `capability_grant`); not verified at `BoundaryDriver.run`

### mediated execution

- Opt-in transactional shell: `runTransactionalExecution` → `runWithBoundaryRunnable` → `BoundaryDriver.run`
- Clean Git worktree backend; dirty/non-Git fail closed unless file_checkpoint (not implemented)
- Success returns `TRANSACTIONAL_ALREADY_APPLIED` with `permission: deny` to prevent double execution
- **Official mediated path** for shell commands in this foundation

### approved replay

- `belay approve --replay`, editor hook auto-replay → `runBoundaryAgentCommand` → `BoundaryDriver.run`
- The approved record is atomically removed before execution; failures and timeouts do not re-arm it
- `host-integration` remains L3 policy-only; use the container driver when runtime isolation is required

## Boundary drivers

| Driver | `deniesUngrantedEffects` | `materializesGrants` | Notes |
|--------|--------------------------|----------------------|-------|
| `host-integration` | `false` | `false` | L3 policy-only; direct `runShellCommand` |
| `container` | `true` | `true` | Docker mount RO/RW, network none or egress proxy |

Do not report host-integration paths as runtime-enforced sandboxing.

## EffectPlan ownership

| Stage | EffectPlan role |
|-------|-----------------|
| Build | `effect-ir` from shell parse + launcher decomposition |
| Authorize | `PolicyEngine` over flattened `CapabilityRequestV1[]` |
| Audit | `effectIRHash`, provenance, boundary enforcement status |
| Materialize | Container driver only; all bundle grants must match |

## Related files

- `src/adapters/shared/gate-runtime.ts` — gate decision and grant consumption
- `src/core/transactional/runner.ts` — mediated shell execution
- `src/core/capability/boundary-driver.ts` — driver attestation
- `src/core/approval-service.ts` — atomic replay claim
