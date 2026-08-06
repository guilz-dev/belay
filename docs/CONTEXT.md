# CONTEXT — Capability authorization vocabulary

This document records the normative terms for Belay's resource-scoped capability
authorization model. It complements [ADR-003](./adr/ADR-003-resource-scoped-capability.md).

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

## Invariants

1. Hook gate decisions are **deterministic**. Sync LLM judge is not on the gate path.
2. **Default deny**: unknown actions/resources and stale attestations fail closed to
   `require_approval`.
3. **Network** includes read-only HTTP (GET). Query strings may carry secrets; egress is never
   silently allowed at L3.
4. **agentAssessment** is audit evidence only; it cannot mint grants or attestations.
5. `deny_pending_approval` is never auto-approved; human escalation is mandatory.

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

## Out of scope (later phases)

- Approval state v3 migration and grant lease consumption at reference monitors
- Docker `BoundaryDriver` and host `spawn` removal from transactional runner
- Cedar WASM policy backend
- p95 latency ratchet for full corpus (tracked separately in quality loop)

## Layer split (L1 vs L3)

| Layer | Network read (e.g. `curl` GET) | Notes |
|-------|----------------------------------|-------|
| **L3 hook gate** | `require_approval` (`network.connect`) | PolicyEngine; ADR-003 supersedes ADR-002 for this path |
| **L1 egress proxy** | `allow` when allowlisted / default read policy | `evaluateEgressConnect` in `egress/policy.ts` |

Do not assume hook verdict and egress-proxy verdict match for the same command string.
