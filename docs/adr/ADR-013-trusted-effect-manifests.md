# ADR-013 — Trusted effect manifests

Status: Accepted
Date: 2026-09-19
Related: [ADR-005](./ADR-005-command-allowlist-prohibition.md), [ADR-004](./ADR-004-effectplan-shell-authority.md), [ADR-010](./ADR-010-repository-config-trust.md)

## Context

Operators sometimes need to lower a **complete, structured effect upper bound** for a native
executable when the built-in shell decoder returns only `process.grammar_unknown`. That need is
not solved by command allowlists, standing shell lists, or one-shot approval reuse.

[ADR-005](./ADR-005-command-allowlist-prohibition.md) forbids command-name and command-text lists
as runtime authority. Effect manifests are **not** allowlists: they declare typed argv matchers,
fixed effect templates, and an explicit `complete-upper-bound` assertion that still flows through
EffectPlan and PolicyEngine.

## Decision

1. **Repository-local manifests** live at `.belay/manifests/<basename>.json` and bind to executable
   identity (canonical path + SHA-256), not to a bare command name.
   Gate-time application additionally requires a literal path-qualified invocation so a shell
   function or alias cannot shadow the verified executable.
2. **Trust is out-of-repo** in the control-plane `effect-manifest-trust/` store, keyed by checkout
   root and canonical executable path ([spec](../superpowers/specs/2026-09-19-effect-manifest-design.md)).
3. **Gate lowering** consults manifests only after the built-in decoder yields exact
   `process.grammar_unknown` on a complete segment, and only for trusted rules whose fingerprints
   match.
4. **CLI lifecycle** (`belay manifest infer|list|show|validate|trust|revoke`) is explicit and
   offline by default; `trust` and `revoke` are `control_plane.write` operations per ADR-010.
5. **Manifests cannot** remove parser disagreement, shell partial analysis, or comparator
   uncertainty; shadow/canary roles remain observational per the multi-frontend rollout.

## Consequences

- False positives from unknown local effects may be addressed with reviewed manifests instead of
  command lists, but PolicyEngine still evaluates every resulting requirement.
- Executable or rule semantic changes invalidate trust deterministically via fingerprints.
- Show, validate, explain, and doctor expose bounded manifest status; gate cohort fingerprints
  include active trusted rule hashes.

## One line

**Manifests assert structured complete upper bounds for trusted argv patterns — they are not command allowlists.**
