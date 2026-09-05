# ADR-009 — Single Cursor shell gate

- Status: Accepted
- Date: 2026-09-05
- Related: [ADR-008](./ADR-008-cursor-hook-source-precedence.md)

## Context

Cursor integrations can surface shell-adjacent events through both `beforeShellExecution` and
`preToolUse` payloads. Source ownership and source precedence do not define whether these distinct
event kinds should be treated as one shell authority point or as two independent policy
evaluations.

Without an explicit invariant, a managed hook layout can regress into duplicate shell
classification, duplicated audits, or behavior that changes depending on hook entry shape rather
than policy mode.

## Decision

1. **Single shell authority point** — Cursor shell classification authority is
   `beforeShellExecution` only.
2. **No managed `preToolUse: Shell` matcher entry** — Managed Cursor hooks must not generate a
   `preToolUse` entry scoped with matcher `Shell`.
3. **Future unfiltered `preToolUse` compatibility** — If a managed unfiltered `preToolUse` hook is
   introduced, `tool_name: "Shell"` must return neutral allow and must not perform policy
   evaluation, approval state mutation, or audit append.
4. **Exact-match migration safety** — Upgrade and uninstall remove only exactly recognized legacy
   Belay `preToolUse: Shell` managed entries; unrelated third-party hooks remain untouched.
5. **ADR boundary clarity** — ADR-008 defines source owner selection across hook sources and does
   not collapse distinct host events into one event identity.

## Consequences

- A single shell action produces one shell gate decision and one shell gate audit append from the
  effective owner.
- Source ownership and shell-event cardinality are decoupled invariants and can be tested
  independently.
- Moving to an unfiltered `preToolUse` model for non-shell tool routing does not reintroduce shell
  double-evaluation.

## Verification

- `pnpm exec vitest run src/__tests__/cursor-hooks.test.ts src/__tests__/hooks-runtime.test.ts src/__tests__/cursor-hook-precedence.integration.test.ts`
