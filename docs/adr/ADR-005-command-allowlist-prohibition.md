# ADR-005 — Command allowlist prohibition

Status: Accepted  
Date: 2026-08-18  
Related: [ADR-002](./ADR-002-concept-conformance.md), [ADR-004](./ADR-004-effectplan-shell-authority.md)

## Context

Belay's differentiator is the **restorability floor**: stop only actions that are
**irreversible × catastrophic**, not commands that look unfamiliar. A command
allowlist — including legacy `overrides.allow` / `overrides.external` and any
new standing shell list — collapses belay into the same category as static
denylists and permission fences belay was designed to replace.

This incident pattern has recurred in product guidance and operator workflows:
when benign commands are misclassified, the proposed fix is often "add them to
an allowlist." That path removes belay's unique value. If belay ever relies on
command allowlists as its primary way to pass safe work, the product should
close rather than ship that design.

ADR-004 already made EffectPlan the sole shell authority and deprecated legacy
override lists. Documentation and operator guidance did not consistently enforce
that boundary.

## Decision

1. **Command allowlists are product-incompatible.**
   - Shell authorization must not use command-name lists, segment-head lists,
     command-text fingerprints, corpus catalogs, or config override lists as
     runtime authority.
   - Legacy `overrides.allow` / `overrides.external` remain parse-compatible
     only; they are **forbidden for use** and must not appear in operator
     guidance as a remediation path.

2. **Permitted alternatives (not allowlists):**
   - **EffectPlan improvement** — extend grammar decoders and policy so
     read-only semantics are structurally recognized (`process.exec` with
     `operation: inspect`, payload-free reads, etc.).
   - **Exact one-shot approval** — authorize the precise denied action once;
     no standing pass for a command name or prefix.
   - **Resource-scoped grants** — egress domains, filesystem scopes, trusted
     workspace roots after explicit approval; these authorize **resources**,
     not shell syntax.

3. **Enforcement:**
   - `belay doctor` **fails** when `overrides.allow` or `overrides.external`
     is non-empty.
   - CI quality gates fail when user-facing docs/skills recommend command
     allowlists or legacy override lists.
   - Gate changes that introduce list-shaped shell authority are rejected in
     review regardless of ADR prose.

## Consequences

- Operators who still have legacy override lists must remove them; `doctor --fix`
  does not auto-populate allowlists as a workaround.
- False positives from unknown local effects must be fixed via EffectPlan /
  policy semantics or one-shot approval — not list expansion.
- Resource boundary allowlists (egress domain, fs-scope, judge provider
  allowlist) remain valid; ADR-005 applies to **shell command** allowlists only.
- CONTRIBUTING, CONCEPT, README, and skills must route contributors and agents
  away from allowlist remediation.

## One line

**If the fix is "add it to a command list," the fix is wrong.**
