# CONTEXT — Capability authorization vocabulary

This document records the normative terms for Belay's resource-scoped capability
authorization model. It complements
[ADR-003](./adr/ADR-003-resource-scoped-capability.md),
[ADR-004](./adr/ADR-004-effectplan-shell-authority.md), and
[ADR-005](./adr/ADR-005-command-allowlist-prohibition.md), and
[ADR-006](./adr/ADR-006-contained-unknown-execution.md).

## Core objects

- **CapabilityRequestV1** — A normalized authorization question: who (`principal`), what
  (`action`), on which resource (`resource`), with deterministic evidence (`evidence`).
- **PolicyEngine** — Synchronous, closed-world evaluator. Must not perform network I/O, LLM
  calls, or process spawn during `evaluate()`.
- **PolicyDecision** — `allow | require_approval | deny` plus reason, signals, and matched rule.
- **CapabilityGrantV1** — A scoped approval artifact bound to principal, action, resource,
  optional input fingerprint, expiry, and remaining uses. Broad grants (`network.connect` with
  `unknown` resource, etc.) are rejected.
- **BoundaryAttestation** — Evidence that a real runtime boundary (not config strings alone)
  probed successfully and can materialize grants.
- **Contained execution capability** — A separate, fresh signed Docker proof used only to run one
  eligible `unknown_local_effect` in a discarded copy-only workspace mirror. It is not a grant
  materialization or L1-full capability.

## Invariants

1. Hook gate decisions are **deterministic**. Sync LLM judge is not on the gate path.
2. **EffectPlan authority**: normalized shell actions are authorized only from their
   canonical effects. Legacy command lists, overrides, corpus entries, and shell
   standing-allow state are inert. Command allowlists are product-incompatible
   ([ADR-005](./adr/ADR-005-command-allowlist-prohibition.md)).
3. **Network**: payload-free reads allow. External mutation, explicit payload/file/secret
   sends, and ambiguous network effects require approval.
4. **agentAssessment** is audit evidence only; it cannot mint grants or attestations.
5. `deny_pending_approval` is never auto-approved; human escalation is mandatory.
6. **Contained unknown execution** (Docker-only and opt-in): EffectPlan remains the sole shell
   authority. In enforce mode, a verified contained route may mediate an eligible unknown local plan once, but
   executable names, prefixes, fingerprints, corpus membership, and framework identity never make
   it eligible. The original host command is denied after mediation; source changes are discarded.
   In audit mode, Belay performs no contained execution and returns ordinary host pass-through.
   Command
   allowlists remain prohibited ([ADR-006](./adr/ADR-006-contained-unknown-execution.md)).
7. A contained execution capability does not imply `materializesGrants`,
   `deniesUngrantedEffects`, a verified broker, or L1-full. Its Docker protections apply to its
   one declared container/mirror execution only.
8. **Recovery execution** (transactional; durable checkpoint backend is opt-in): when enabled,
   local mutations run only after an observed-safe git worktree proof. With
   `policy.transactional.checkpoint.enabled`, Belay persists repo-local pre-images before apply
   and exposes exact one-shot-approved restore through `belay recover apply`. Substrate,
   checkpoint, or observation failure
   maps to `recovery_substrate_unavailable`, `recovery_dirty_worktree`, or
   `recovery_execution_failed` — the host must not fall back to unproven execution. Belay-managed
   init artifacts under adapter state paths are excluded from dirty-worktree gating.
9. Linked worktrees are repository-local only when their canonical Git common directory
   matches the primary repository. Separate and malformed repositories fail closed.

## Policy precedence

```text
forbid (forgery / broad grant)
  → exact grant
  → verified boundary
  → built-in rules
  → default require_approval
```

## Hook contract (migration)

Existing `GateVerdict` fields remain stable. Optional extensions:

- `capabilityRequests`
- `authorizationDecision`
- `boundaryProfile`
- `wouldMediate` (audit-mode eligibility signal)
- `mediatedExecution` (scrubbed, bounded contained result; never a host replay authority)

## Completed migration work

- Approval state v3 migration and grant lease consumption at reference monitors
- Docker `BoundaryDriver` and transactional runner execution via `BoundaryDriver`
- Opt-in contained unknown execution via a separately attested, copy-only Docker route
- `belay session start` for boundary attestation
- Gate sync classification latency budgets (`gate-latency-budget.ts`) and quality-loop ratchet advisories (`sandbox advisories`; PLAN 100ms/500ms tightening is ongoing via floor ratchet)

## Out of scope (later phases)

- Cedar WASM policy backend
- Seatbelt / Landlock `BoundaryDriver` implementations (types only today)
- Legacy sync judge transport removal (after one release of shadow observation)
- Host `spawn(env: process.env)` removal from L3 `host-integration` driver

## Layer split (L1 vs L3)

| Layer | Network read (e.g. `curl` GET) | Notes |
|-------|----------------------------------|-------|
| **L3 hook gate** | `allow` when normalized as `mode: read`, `payload: none` | EffectPlan + PolicyEngine; ADR-004 supersedes ADR-003's blanket network-read ask |
| **L1 egress proxy** | `allow` when allowlisted / default read policy | `evaluateEgressConnect` in `egress/policy.ts` |

L1 resource scopes are boundary configuration, not shell command allowlists. They do not
replace the L3 EffectPlan projection.
