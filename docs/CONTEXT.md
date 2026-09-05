# CONTEXT — Capability authorization vocabulary

This document records the normative terms for Belay's resource-scoped capability
authorization model. It complements
[ADR-003](./adr/ADR-003-resource-scoped-capability.md),
[ADR-004](./adr/ADR-004-effectplan-shell-authority.md),
[ADR-005](./adr/ADR-005-command-allowlist-prohibition.md),
[ADR-006](./adr/ADR-006-contained-unknown-execution.md), and
[ADR-008](./adr/ADR-008-cursor-hook-source-precedence.md),
[ADR-009](./adr/ADR-009-single-cursor-shell-gate.md), and
[ADR-010](./adr/ADR-010-repository-config-trust.md).

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
- **Benign probe core** — A test-only command fixture used to generate false-positive probes and
  structural availability expectations. It never grants runtime authority; only the resulting
  `EffectPlan` and PolicyEngine projection can authorize a shell action.

## Invariants

1. Hook gate decisions are **deterministic**. Sync LLM judge is not on the gate path.
2. **EffectPlan authority**: normalized shell actions are authorized only from their
   canonical effects. Legacy command lists, overrides, corpus entries, and standing-allow
   state (shell, tool, subagent) are inert at runtime. Command allowlists are
   product-incompatible
   ([ADR-005](./adr/ADR-005-command-allowlist-prohibition.md)).
3. **Network**: payload-free reads allow. External mutation, explicit payload/file/secret
   sends, and ambiguous network effects require approval.
4. **agentAssessment** is audit evidence only; it cannot mint grants or attestations.
5. `deny_pending_approval` is never auto-approved; human escalation is mandatory.
6. **Contained unknown execution** (Docker-only and opt-in): EffectPlan remains the sole shell
   authority. In enforce mode, a verified contained route may mediate an eligible unknown local
   plan once, but executable names, prefixes, fingerprints, corpus membership, and framework
   identity never make it eligible. The original host command is denied after mediation; source
   changes are discarded, and guest output uses mandatory credential scrubbing before its bounded
   tails regardless of ordinary audit-redaction settings. In audit mode, Belay performs no
   contained execution and returns ordinary host pass-through. Command allowlists remain prohibited
   ([ADR-006](./adr/ADR-006-contained-unknown-execution.md)).
7. A contained execution capability does not imply `materializesGrants`,
   `deniesUngrantedEffects`, a verified broker, or L1-full. Its Docker protections apply to its
   one declared container/mirror execution only.
8. **Recovery execution** (transactional; durable checkpoint backend is opt-in): when enabled,
   local mutations run only after an observed-safe proof in a git worktree or file-checkpoint
   mirror. Clean Git uses `git_worktree`; dirty Git and non-Git directories use
   `file_checkpoint` when separately enabled (`policy.transactional.fileCheckpoint.enabled` and,
   for non-Git roots, `allowNonGit: true`) with durable checkpointing and an attested
   workspace-isolating boundary. With `policy.transactional.checkpoint.enabled`, Belay persists
   repo-local pre-images before apply and exposes exact one-shot-approved restore through
   `belay recover apply`. Substrate, checkpoint, or observation failure maps to
   `recovery_substrate_unavailable`, `recovery_dirty_worktree`, or `recovery_execution_failed`
   — the host must not fall back to unproven execution. `belay metrics` schema v4 aggregates
   snapshot and restore outcomes for operational evidence without affecting authorization.
9. Linked worktrees are repository-local only when their canonical Git common directory
   matches the primary repository. Separate and malformed repositories fail closed.
10. **Audit log schema v3**: gate writers preserve ISO timestamps, 64-hex fingerprints, and
    `approvalCorrelationId` / `toolInvocationCorrelationId` through field-aware serialization.
    Tool invocation correlation is a one-way hash; raw host `tool_use_id` values are not audit or
    replay data. Scrub placeholders in correlation fields invalidate metrics joins; legacy
    placeholder logs should be archived before trusting dogfood readiness
    ([dogfood audit remediation §P0-1](./dogfood-audit-remediation-2026-08-22.ja.md)).
11. **Dogfood cohort identity** separates runtime bundle hash (`runtimeArtifactHash`),
    authorization-relevant config hash (`decisionConfigFingerprint`), and `boundaryProfile`.
    `mode` and audit display settings do not reset the decision cohort. Readiness still uses a
    minimum gate-event count today; stricter reviewed-benign thresholds are planned (same doc §6).
12. **Host execution policy is a separate decision boundary**: an editor or agent host may deny an
    invocation after Belay returned `permission: allow`. A correlated host
    `permission_denied` is operational evidence, not a Belay ask and not a reason to mint a Belay
    approval. Status/report expose this distinction without changing EffectPlan authority. In
    Belay audit mode, retain the host protection or approve only the exact host prompt; do not
    weaken the host globally on the strength of an audit-only Belay decision.
13. **Action working directory and Make authority**: an action's working directory comes from the
    host action payload, not the hook process working directory. Cursor treats
    `tool_input.working_directory` as an action directory only for `preToolUse: Shell`; arbitrary
    nested arguments from other tools cannot select repository policy or state. For `make`, every
    statically known prerequisite recipe participates in the `EffectPlan` before the requested
    target's recipe. `.PHONY` declarations and `_`-prefixed target names have no policy meaning;
    policy evaluates the resulting effects, not Make target names.
14. **Cursor hook source ownership**: Cursor may spawn User/global and multiple Project sources for
    one canonical event, but exactly one Belay source may evaluate it. The matching initialized
    Project owner takes precedence over User/global and nonmatching projects; a repository
    configured for global scope selects User/global. Selection uses the canonical payload-derived
    action repository, and the Project origin persisted in shims is canonical rather than the
    lexical install path. Omitted scope means Project; only a missing config is neutral, while a
    present broken config remains Project-owned and fails closed in config loading. Scope changes
    stage the new owner before publishing the selection. Non-owners are neutral and cannot import
    the heavy core or touch approval, control-plane, or audit state. Managed Cursor entries set the
    host's `failClosed` option, but post-action events cannot undo completed effects and
    `sessionEnd` is fire-and-forget. This is source precedence only: distinct canonical events and
    repeated effective-owner deliveries remain separate hook processes
    ([ADR-008](./adr/ADR-008-cursor-hook-source-precedence.md)).
15. **Single Cursor shell classification**: `beforeShellExecution` is the only Belay-managed Cursor
    shell authority point. Managed hooks must not classify shell actions again via
    `preToolUse: Shell`; if unfiltered `preToolUse` routing is present, `tool_name: "Shell"` is
    neutral allow with no policy evaluation, approval mutation, or shell audit append
    ([ADR-009](./adr/ADR-009-single-cursor-shell-gate.md)).
16. **Repository config authority requires explicit trust**: repository config cannot influence
    policy layering until its canonicalized parsed content matches an explicit trust record for the
    canonical repository root and adapter. Missing, malformed, identity-mismatched, or
    fingerprint-mismatched records fail closed before policy evaluation. Belay-managed writes
    refresh trust atomically; manual edits require explicit re-trust through
    `belay config trust`. Agent-shell invocations of trust and approval-authority commands are
    control-plane writes that require separate human approval
    ([ADR-010](./adr/ADR-010-repository-config-trust.md)).

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
- Audit NDJSON schema v3, content-addressed dogfood cohort fields, Cursor shell hook dedupe, and
  action-aware control-plane read vs mutation policy ([dogfood audit remediation Phase A](./dogfood-audit-remediation-2026-08-22.ja.md))

## Out of scope (later phases)

- Cedar WASM policy backend
- Seatbelt / Landlock `BoundaryDriver` implementations (types only today)
- Legacy sync judge transport removal (after one release of shadow observation)
- Host `spawn(env: process.env)` removal from L3 `host-integration` driver
- Bounded audit storage, compact post-tool telemetry, and readiness threshold revision (Phase C/D
  in [dogfood audit remediation](./dogfood-audit-remediation-2026-08-22.ja.md))
- Active dogfood install roster: [docs/ops/dogfood-install-targets.md](./ops/dogfood-install-targets.md)

## Layer split (L1 vs L3)

| Layer | Network read (e.g. `curl` GET) | Notes |
|-------|----------------------------------|-------|
| **L3 hook gate** | `allow` when normalized as `mode: read`, `payload: none` | EffectPlan + PolicyEngine; ADR-004 supersedes ADR-003's blanket network-read ask |
| **L1 egress proxy** | `allow` when allowlisted / default read policy | `evaluateEgressConnect` in `egress/policy.ts` |

L1 resource scopes are boundary configuration, not shell command allowlists. They do not
replace the L3 EffectPlan projection.
