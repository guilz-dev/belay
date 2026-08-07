# Grant consumption paths

How one-shot approvals are consumed at the gate runtime layer. Complements
[CONTEXT.md](./CONTEXT.md) and [ADR-003](./adr/ADR-003-resource-scoped-capability.md).

## Two gate-runtime paths

`gateDecisionToVerdict` in `src/adapters/shared/gate-runtime.ts` evaluates approvals in this order:

```text
classifyGatedActionAsync
  → gateDecisionToVerdict
    → fingerprint match? → approved_once (+ execution lease)
    → verdict allow? → capability_grant (consumeGrantLease)
```

| Path | Function | Match condition |
|------|----------|-----------------|
| `approved_once` | `consumeApprovedApproval` | `kind` + `fingerprint` + `repoRoot` on approved record |
| `capability_grant` | `consumeCapabilityGrantIfUsed` | PolicyEngine `grant.exact` + `capabilityRequests` on classify result |

`approved_once` runs **before** grant consumption. When fingerprints match, the approval lease
path wins even if the classify result also carries `capability_grant`.

For outside-repo shell mutations, the verdict layer may surface `repo_outside_local_mutation` when
`authorizationDecision.matchedRule` is `grant.exact` (hook reason differs from policy `capability_grant`).

Grant lease mechanics (`findMatchingGrant`, `consumeGrantLease`) are tested in
`src/__tests__/capability/grant-lease.test.ts`. Gate-runtime integration is in
`src/__tests__/capability-gate-runtime.test.ts`.

## Broker demotion interaction

When the capability broker is active (`sandbox.enabled` with container runtime), outside-repo
reasons skip the `approved_once` path:

- `shouldSkipBrokerApprovedOnce(brokerActive, reason)` — skips lease consumption for
  `outside_repo_mutation` / `outside_repo_redirect` classify reasons.
- `shouldSkipBrokerApprovedRecord(brokerActive, approvalReason)` — skips approved records whose
  stored reason is an FS-scope reason.

Broker inactive repos use `approved_once` for fingerprint matches on any reason, including
outside-repo mutations.

## Container `run()` does not verify grants

`BoundaryDriver.run()` (container driver) enforces mount and network isolation only. It does
not read or consume `CapabilityGrantV1`. Grant verification happens at:

1. **Classify** — PolicyEngine matches grants → `capability_grant` reason.
2. **Gate runtime** — `consumeCapabilityGrantIfUsed` decrements `usesRemaining` on the approved
   record.

Transactional runner and session attestation use `resolveBoundaryDriverContext` for consistent
proxy detection; grant consumption remains in gate-runtime, not in the driver.

## Effect-typed proposal mapping

The effect-typed capability proposal's Step 0 “execution boundary map” is covered by this
document plus the BoundaryDriver notes in [CONTEXT.md](./CONTEXT.md). A separate
`execution-boundary-map.ja.md` is not required.
