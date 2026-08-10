# Effect Runtime Enforcement Hardening Design

## Status

Approved for implementation from the review of the completed
`effect-runtime-foundation` plan. This design corrects the gap between the
current policy model and the runtime guarantees reported to operators.

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
explicit and fail closed on mediated paths.

## Design principles

- Authorization, enforcement, and observation are separate facts.
- A fresh boundary attestation describes available capabilities; it does not
  prove that a particular action ran through that boundary.
- `runtime_attested` requires an execution receipt bound to the plan and request
  hashes. Prediction-only host execution never receives that label.
- New approval records use exact one-to-one request/grant matching. Legacy
  records remain readable but are reported as legacy fingerprint authorization,
  not bundle enforcement.
- Unknown effects coexist with known effects as individual `indeterminate`
  requirements; they never replace or hide known requirements.
- Package acquisition resources describe the actual known endpoint or remain
  indeterminate. They never claim a default registry for an explicit different
  URL.

## Architecture

### Canonical action analysis

All normalized gated actions produce an `EffectPlan`, even when analysis is
partial. Shell analysis builds one node per top-level segment and preserves
redirects, wrappers, substitutions, and launcher provenance. Tool and subagent
analysis adapt their existing `CapabilityRequestV1` output into the same plan
model. When a construct cannot be resolved, the plan contains both the known
requirements and a separate `indeterminate` requirement.

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

Validation is atomic and requires:

- identical request and grant cardinality;
- a one-to-one exact match for principal, fingerprint, action, and resource;
- fresh expiry and positive use count for every grant;
- no broad, duplicate, missing, or extra grants.

Only after all checks succeed are all matched grants decremented in one state
mutation. New version-3 approvals always use this path. Records without request
and bundle metadata retain the pre-v3 fingerprint lease behavior and emit an
explicit `legacy_fingerprint_only` audit field.

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

BoundaryDriver.prepare(authorizedPlan, context)
  -> PreparedBoundaryExecution | UnsupportedRequirement

BoundaryDriver.run(preparedExecution, command, cwd, timeout)
  -> BoundaryExecutionReceipt
```

The receipt records the driver, plan hash, request hash, and enforcement result
for every requirement. Audit may report `runtime_attested` only when a receipt
exists and every requirement is covered. A driver may report narrower
capabilities such as workspace isolation or network isolation without claiming
generic `deniesUngrantedEffects`.

The current container implementation cannot enforce exact paths inside a
writable mount or exact executable identities. Those requirements are reported
as unsupported until the driver has a real mechanism. Read-only mounts and
network-none/internal-proxy isolation may be reported only for executions that
actually use them.

Default editor-hook allows remain prediction-only because the host executes the
action. Transactional execution and approved replay are the only candidates for
runtime receipts.

### PackageExec lowering

PackageExec parsing retains argv rather than rebuilding a shell recipe with
`join(' ')`. It records package spec separately from delegated executable argv.

- Explicit HTTP(S) package specs use the URL host as the network resource.
- Registry package specs use a registry host only when it is resolved from a
  trusted, deterministic configuration source.
- Git, shorthand, dynamic, or unresolved registry sources add an
  `indeterminate` requirement and fail closed.
- Package-cache writes use a resolved cache path when known; otherwise they are
  indeterminate rather than manager-wide pseudo-path grants.
- Local executable resolution remains constrained to a real file inside the
  repository. Its delegated argv is preserved for inner analysis.

## Audit contract

Audit records distinguish:

- `prediction_only`: classified by policy; host executes;
- `mediated_unattested`: Belay executed the action but cannot prove complete
  enforcement;
- `runtime_attested`: a receipt proves all EffectPlan requirements were
  enforced;
- `legacy_fingerprint_only`: a legacy approval authorized replay without an
  exact version-3 bundle.

An available boundary profile is recorded separately from the selected
execution route and receipt. No UI or metric may infer runtime enforcement from
profile or policy decision alone.

## Error handling

- Missing or mismatched new-format grants produce
  `capability_grant_unavailable` or `approval_replay_mismatch` without changing
  state.
- Unsupported mediated requirements stop execution before the command starts.
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
   approval records separately from exact version-3 bundles.
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

## Acceptance criteria

- Every shell, tool, and subagent classification has a non-empty EffectPlan or
  an explicit read-only plan.
- New approval bundles cannot execute unless every current request has exactly
  one matching active narrow grant and no extra grants exist.
- Default host hook execution is never reported as runtime-enforced.
- Runtime enforcement requires a matching receipt covering every requirement.
- Explicit remote package URLs never appear as `registry.npmjs.org` resources.
- Normalization preserves all provenance and allows known plus indeterminate
  requirements to coexist.
- The world tests execute the boundary interface rather than only testing
  policy/materialization helpers.
- Documentation has one canonical statement for each execution and grant path.
