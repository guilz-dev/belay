# ADR-003 — Resource-scoped capability authorization

Status: Accepted  
Date: 2026-08-06  
Context: capability migration plan (sync PolicyEngine + async shadow), [CONTEXT.md](../CONTEXT.md)

## Decision

Belay hook gates adopt **resource-scoped capability authorization** with a synchronous
TypeScript `PolicyEngine` instead of effect-type languages or sync LLM Tier1 judge.

- Requests use `CapabilityRequestV1` (principal / action / resource / context / evidence).
- Decisions use `PolicyDecision` (`allow | require_approval | deny`) with default-deny.
- Grants (`CapabilityGrantV1`) bind principal, action, normalized resource, fingerprint, TTL,
  and use count — never action-only wildcards.
- LLM judge remains **async shadow only** (`judge.mode: shadow | off`); it does not block hooks.

## Rationale

1. Agent shell/tool payloads are runtime strings; static effect types cannot close the gate.
2. Cedar-style principal/action/resource/context maps cleanly onto Belay's existing path, egress,
   and fingerprint machinery without new runtime dependencies.
3. Separating sync policy from async shadow preserves deterministic hooks and enables corpus
   comparison without gate latency regressions.

## Consequences

- `VerdictContext` no longer carries `Tier1Judge`; classification imports `prescan.ts` instead
  of `judge.ts` / `judge-factory.ts`.
- Network read commands require approval at L3 (policy `builtin.network`). This supersedes
  ADR-002 §1 read-egress MUST-ALLOW examples for the hook gate path only; L1 egress proxy
  retains GET allow semantics (`docs/CONTEXT.md`).
- Doctor reports judge health as **shadow advisory**, not gate failure.
- Boundary drivers, approval v3, and container reference monitors are follow-on work; config
  strings alone do not attest L1.

## Non-goals

- Replacing TypeScript with Jacquard/Flix/Koka.
- Treating capability tokens or effect tags as security boundaries without real sandbox/egress
  enforcement.

English summary: see [CONTEXT.md](../CONTEXT.md). Japanese ADR copy may be added when the
team localizes ADR-003.
