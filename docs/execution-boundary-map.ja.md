# Execution boundary map

Status: **Active**  
Complements [grant-consumption-paths.md](./grant-consumption-paths.md) and [CONTEXT.md](./CONTEXT.md).

## Classification

Every gated action follows one of four execution classes:

| Class | Meaning | Runtime enforcement |
|-------|---------|---------------------|
| **prediction-only** | Belay classifies and returns allow/deny; the host agent executes | Policy only (`deniesUngrantedEffects: false` on host-integration) |
| **mediated execution** | Belay runs the command via `BoundaryDriver` before applying observed-safe diffs | Transactional shell path; container may enforce mount/network when attested |
| **contained unknown execution** | Belay runs one eligible `unknown_local_effect` in a disposable copy-only Docker mirror and then denies the original host invocation | Opt-in Docker-only route; never applies a diff or materializes a grant |
| **approved replay** | Approved shell replay via CLI or hook auto-replay | Configured `BoundaryDriver`; one-shot grant claimed before execution |

## Paths

### prediction-only (default hook allow)

- Cursor / Claude / Codex shell, tool, subagent hooks → `evaluateGatedAction` → `permission: allow` → **host executes**
- Classification: normalized shell は canonical `EffectPlan` → `PolicyEngine` projection。
  tool/subagent は各 adapter → `PolicyEngine`
- Grants consumed at gate-runtime (`approved_once`, `capability_grant`); not verified at `BoundaryDriver.run`

### mediated execution

- Opt-in transactional shell: `runTransactionalExecution` → `runWithBoundaryRunnable` → `BoundaryDriver.run`
- Clean Git worktree backend; dirty Git can use the opt-in attested `file_checkpoint`
  backend. Unsupported/non-attested substrates fail closed.
- Success returns `TRANSACTIONAL_ALREADY_APPLIED` with `permission: deny` to prevent double execution
- **Official mediated path** for shell commands in this foundation

### contained unknown execution (opt-in Docker-only)

- Eligibility is effect-based after canonical classification: an `unknown_local_effect` must be a
  repository-local shell plan with only the contained local subset. Executable names, prefixes,
  fingerprints, corpus membership, and Rails/RSpec identity are never authority.
- Audit mode reports `wouldMediate: true` and executes nothing in the contained route: no
  attestation read, mirror preparation, container create, or container start.
- Enforce mode copies the current workspace into a metadata-free bounded `file_copy` mirror,
  excluding `.git`, the Belay control plane, protected adapter state, and escaping symlinks. It
  mounts only that mirror at the original absolute guest workspace path and runs one command.
- The original host command is always denied. The mirror is discarded on every terminal path;
  there is no diff, apply, recovery checkpoint, or host replay.
- This is deliberately distinct from transactional apply. The reviewed copy-only backend
  supersedes the initial detached Git worktree idea: it works from clean, dirty, and non-Git
  current state without exposing host Git hooks, filters, fsmonitor, common-directory metadata,
  or source files to the guest.
- Only typed Docker substrate/daemon unavailability before a start falls back to the ordinary
  approval route. Capability/image/mirror/lease/create/inspect/start/timeout/cleanup failures
  fail closed.

### approved replay

- `belay approve --replay`, editor hook auto-replay → `runBoundaryAgentCommand` → `BoundaryDriver.run`
- The approved record is atomically removed before execution; failures and timeouts do not re-arm it
- `host-integration` remains L3 policy-only; use the container driver when runtime isolation is required

## Boundary drivers

| Driver | `deniesUngrantedEffects` | `materializesGrants` | Notes |
|--------|--------------------------|----------------------|-------|
| `host-integration` | `false` | `false` | L3 policy-only; direct `runShellCommand` |
| `container` | `true` | `true` | Docker mount RO/RW, network none or egress proxy |
| contained-execution capability | `false` | `false` | One Docker-only copy mirror execution; no grant materialization and not L1-full |

Do not report host-integration paths as runtime-enforced sandboxing.

## EffectPlan ownership

| Stage | EffectPlan role |
|-------|-----------------|
| Build | `effect-ir` from shell parse + launcher decomposition |
| Authorize | Effect requirements are evaluated directly and projected by strictest disposition; flattened `CapabilityRequestV1[]` binds exact grants |
| Audit | `effectIRHash`, provenance, boundary enforcement status |
| Materialize | Container driver only; all bundle grants must match |
| Contain unknown | Uses the already-authoritative plan only to select the route; never changes the plan's authorization projection |

## Related files

- `src/adapters/shared/gate-runtime.ts` — gate decision and grant consumption
- `src/core/transactional/runner.ts` — mediated shell execution
- `src/core/contained-execution/mirror.ts` — copy-only disposable mirror
- `src/core/contained-execution/docker.ts` — contained Docker probe and one-run executor
- `src/core/capability/boundary-driver.ts` — driver attestation
- `src/core/approval-service.ts` — atomic replay claim
