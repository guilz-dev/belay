# Effect Runtime Enforcement Hardening Design

## Status

Proposed. This revision incorporates the review of the completed
`effect-runtime-foundation` plan and corrects the gap between the current policy
model and the runtime guarantees reported to operators.

## Goal

Make every gated action produce a canonical `EffectPlan`, require an exact and
atomic grant bundle for approval replay, and report runtime enforcement only
when the selected execution boundary returns evidence that every requirement
was actually enforced.

## Scope

This change covers five connected contracts:

1. enforcement reporting and boundary receipts;
2. exact grant-bundle validation and consumption;
3. complete EffectPlan construction for shell, tool, and subagent actions;
4. resource-correct PackageExec lowering;
5. proof tests and canonical documentation.

It does not attempt to implement per-executable Linux policy, a complete shell
interpreter, or static effect typing. Unsupported runtime enforcement remains
explicit. Existing best-effort mediated paths continue as
`mediated_unattested`; callers that explicitly require enforcement fail closed
before execution.

## Design principles

- Authorization, enforcement, and observation are separate facts.
- A fresh boundary attestation describes available capabilities; it does not
  prove that a particular action ran through that boundary.
- `runtime_attested` requires an execution receipt bound to the plan and request
  hashes. Prediction-only host execution never receives that label.
- New approval records use exact one-to-one request/grant matching. Legacy
  records remain readable but are reported as legacy fingerprint authorization,
  not bundle enforcement.
- `grantBundleVersion: 1` identifies records produced under the exact-bundle
  contract. Existing version-3 records without that marker remain legacy even
  when they already contain request or grant arrays.
- Unknown effects coexist with known effects as individual `indeterminate`
  requirements; they never replace or hide known requirements.
- Package acquisition resources describe the actual known endpoint or remain
  indeterminate. They never claim a default registry for an explicit different
  URL.

## Architecture

### Canonical action analysis

All successfully normalized, enabled gated actions produce an `EffectPlan`, even
when analysis is partial. Gate-disabled actions and payloads that fail
normalization remain outside the EffectPlan contract. Shell analysis builds one
node per top-level segment and preserves redirects, wrappers, substitutions,
and launcher provenance. Tool and subagent analysis adapt their existing
`CapabilityRequestV1` output into the same plan model. When a construct cannot
be resolved, the plan contains both the known requirements and a separate
`indeterminate` requirement.

The plan carries explicit disposition and completeness fields:

```ts
type EffectPlanDisposition = 'effects' | 'effect_free'
type AnalysisCompleteness = 'complete' | 'partial'
```

The following invariants prevent an empty plan from being mistaken for complete
analysis:

- `effects` contains at least one canonical requirement;
- `effect_free` may contain no requirements, but must be `complete` and retain
  evidence and provenance for the effect-free conclusion;
- `partial` contains at least one `indeterminate` requirement alongside every
  known requirement;
- an `effect_free` plan is never `partial`.

`EffectPlan` exposes a canonical requirement set. Deduplication merges evidence
and accumulates `provenances[]`; it does not discard the source of a repeated
effect. Legacy `VerdictEffect`, location, opacity, and reason remain projections
for gate contract v1.

The rollout begins in differential mode: existing classification remains the
behavioral baseline while tests assert that EffectPlan projections and existing
capability requests agree. The plan becomes authoritative only after all action
kinds pass the completeness gate.

### Exact approval bundles

A single validator handles both `approved_once` and `capability_grant` paths:

```text
validateAndConsumeGrantBundle(approval, currentRequests, now)
  -> { ok: true, approval }
  |  { ok: false, reason }
```

Validation runs over the deduplicated canonical request set and is atomic. It
requires:

- identical request and grant cardinality;
- a one-to-one exact match for principal, fingerprint, action, and resource;
- fresh expiry and positive use count for every grant;
- no broad, duplicate, missing, or extra grants.

Only after all checks succeed are all matched grants decremented in one state
mutation. Newly created approvals write `grantBundleVersion: 1` and always use
this path. Any existing record without that marker retains the pre-hardening
fingerprint lease behavior, regardless of whether it already has
`capabilityRequests`, `grant`, or `grants`. This avoids interpreting old
version-3 data under a stronger contract than the producer provided. Old
readers ignore the additive marker during rollback.

### Boundary execution and receipts

Policy evaluation no longer materializes ephemeral boundary grants. The
selected mediated execution path receives an authorized plan:

```text
AuthorizedEffectPlan {
  planHash
  requestHash
  plan
  requests
  grants
}

PreparedBoundaryExecution {
  authorizedPlan
  action: { inputKind, normalizedInput, cwd, inputFingerprint }
  requestedGuarantee: 'observe' | 'enforce'
  enforceableRequirements
  unsupportedRequirements
}

BoundaryDriver.prepare(authorizedPlan, action, context)
  -> PreparedBoundaryExecution | UnsupportedRequirement

BoundaryDriver.run(preparedExecution, timeout)
  -> BoundaryExecutionReceipt
```

The prepared object owns the exact normalized input and cwd; `run` does not
accept a second raw command that could diverge from the authorized action. Its
input fingerprint must match the plan and all requests before execution. The
receipt records the driver, input fingerprint, plan hash, request hash, and
enforcement result for every requirement. Audit may report `runtime_attested`
only when a receipt exists and every identity and requirement is covered. A
driver may report narrower capabilities such as workspace isolation or network
isolation without claiming generic `deniesUngrantedEffects`. `prepare` returns
`UnsupportedRequirement` only for an `enforce` request; an `observe` request
returns a prepared execution carrying its unsupported-requirement list.

The current container implementation cannot enforce exact paths inside a
writable mount or exact executable identities. Those requirements are reported
as unsupported until the driver has a real mechanism. Read-only mounts and
network-none/internal-proxy isolation may be reported only for executions that
actually use them. An `observe` caller may still execute and receive
`mediated_unattested`; an `enforce` caller is rejected during preparation when
any requirement is unsupported.

Default editor-hook allows remain prediction-only because the host executes the
action. Transactional execution and approved replay are the only candidates for
runtime receipts. Existing transactional and replay behavior uses `observe` to
preserve compatibility. A future or explicitly configured enforcement-required
route uses `enforce`; this design does not silently change existing callers to
that mode.

### PackageExec lowering

PackageExec parsing retains argv rather than rebuilding a shell recipe with
`join(' ')`. It records package spec separately from delegated executable argv.

- Explicit HTTP(S) package specs use the canonical URL origin as the network
  resource.
- Ordinary registry package specs remain `indeterminate` during host-side
  prediction. Project/user `.npmrc`, inherited environment variables, and user
  home configuration are not trusted as deterministic endpoint evidence.
- A registry origin becomes `certain` only when a mediated boundary fixes both
  the package-manager configuration and environment to that canonical origin.
- Git, shorthand, dynamic, or otherwise unresolved sources add an
  `indeterminate` requirement and fail closed in policy.
- Package-cache writes use a resolved cache path when known; otherwise they are
  indeterminate rather than manager-wide pseudo-path grants.
- Local executable resolution remains constrained to a real file inside the
  repository. Its delegated argv is preserved for inner analysis.

Consequently, a new exact-bundle approval cannot make an unresolved host-side
registry acquisition executable. The operator must use a mediated route that
fixes the registry origin or remove the ambiguity. This is an intentional
fail-closed compatibility change for newly marked bundles; legacy approvals
retain their explicitly labelled legacy behavior during migration.

## Audit contract

Authorization, routing, and enforcement are orthogonal audit fields:

| Field | Values |
|-------|--------|
| `authorizationMode` | `builtin_policy`, `exact_bundle`, `legacy_fingerprint` |
| `executionRoute` | `host`, `transactional`, `approved_replay` |
| `enforcementStatus` | `prediction_only`, `mediated_unattested`, `runtime_attested` |

This allows a legacy fingerprint approval executed through a container replay
to remain `authorizationMode: legacy_fingerprint` while its actual boundary
result is recorded independently. `runtime_attested` means a receipt proves all
EffectPlan requirements; `mediated_unattested` means Belay executed the action
but cannot prove complete enforcement.

An available boundary profile is recorded separately from the selected
execution route and receipt. No UI or metric may infer runtime enforcement from
profile or policy decision alone.

## Error handling

- Missing or mismatched new-format grants produce
  `capability_grant_unavailable` or `approval_replay_mismatch` without changing
  state.
- Unsupported mediated requirements stop execution before the command starts
  only when `requestedGuarantee` is `enforce`; `observe` records
  `mediated_unattested` and preserves existing execution behavior.
- Receipt hash mismatch is an invariant failure and is audited as deny.
- Analysis failures add an `indeterminate` requirement and require approval;
  they do not drop already-known requirements.
- Legacy records remain usable under the old one-shot behavior during the
  migration window and are never upgraded implicitly during consumption.

## Testing strategy

Each behavior is introduced test-first.

1. Unit tests prove exact bundle cardinality, one-to-one matching, rejection of
   broad/extra/missing grants, and atomic non-consumption on failure.
2. EffectPlan tests prove every shell/tool/subagent action has a plan, known and
   indeterminate effects coexist, and all provenance survives normalization.
3. PackageExec tests cover explicit URL hosts, unresolved registry sources,
   scoped packages, package flags, and quoted argv preservation.
4. Gate-runtime tests prove default hook execution always audits
   `prediction_only`, even with a fresh container attestation.
5. Boundary contract tests run the same authorized plan against record,
   rejecting, and container drivers. Docker-dependent tests skip only when
   Docker is unavailable and otherwise verify actual filesystem/network
   behavior.
6. Compatibility tests keep gate contract v1 stable and exercise legacy
   approval records separately from records marked `grantBundleVersion: 1`.
7. Typecheck, lint, unit/integration tests, corpus, and latency ratchets remain
   required release gates.

## Rollout

1. Correct audit terminology and disable unsupported enforcement claims.
2. Land exact bundle validation for new records while preserving legacy reads.
3. Populate EffectPlan for every action in differential/audit mode.
4. Correct PackageExec resource resolution and corpus expectations.
5. Add authorized boundary preparation and execution receipts.
6. Enable EffectPlan-authoritative decisions only after completeness,
   compatibility, and latency gates pass.

Rollback never requires interpreting new fields: old readers may ignore plans,
receipts, and bundles, while new readers label the resulting authorization as
legacy rather than exact enforcement.

## Implementation decomposition

This umbrella design is delivered through four sequential implementation plans,
each independently reviewable and releasable:

1. **Audit and approval safety:** split audit axes, add
   `grantBundleVersion: 1`, and introduce exact atomic consumption without
   changing boundary execution.
2. **Canonical EffectPlan coverage:** add disposition/completeness invariants,
   retain all provenance, cover shell/tool/subagent actions, and correct
   PackageExec resources in differential mode.
3. **Prepared boundary execution:** bind normalized input to authorized plans,
   add observe/enforce preparation and receipts, and remove policy-time boundary
   grant materialization.
4. **Authority cutover and documentation:** enable EffectPlan-authoritative
   decisions after compatibility, corpus, proof, and latency gates pass; then
   reconcile the boundary and grant-path documentation.

## Acceptance criteria

- Every successfully normalized, enabled shell, tool, and subagent
  classification has an EffectPlan satisfying the disposition/completeness
  invariants.
- Approval records marked `grantBundleVersion: 1` cannot execute unless every
  canonical current request has exactly one matching active narrow grant and no
  extra grants exist.
- Default host hook execution is never reported as runtime-enforced.
- Runtime enforcement requires a receipt matching the input fingerprint, plan
  hash, and request hash and covering every requirement.
- Existing transactional and replay routes retain behavior under `observe` and
  report `mediated_unattested` when coverage is incomplete; `enforce` rejects
  unsupported requirements before execution.
- Explicit remote package URLs never appear as `registry.npmjs.org` resources.
- Normalization preserves all provenance and allows known plus indeterminate
  requirements to coexist.
- The world tests execute the boundary interface rather than only testing
  policy/materialization helpers.
- Documentation has one canonical statement for each execution and grant path.
