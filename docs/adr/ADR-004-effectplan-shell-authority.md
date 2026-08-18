# ADR-004 — EffectPlan authority for normalized shell actions

Status: Accepted  
Date: 2026-08-13  
Supersedes: ADR-003's blanket L3 network-read approval requirement  
Related: [ADR-005](./ADR-005-command-allowlist-prohibition.md)

## Decision

For a shell action that Belay can normalize, its canonical `EffectPlan` is the sole
authorization input. Shell command names select grammar decoders, but command-name
allow/deny lists, legacy `overrides.allow` / `overrides.external`, corpus catalogs, and
shell standing-allow records must not change the runtime decision.

Policy evaluates every normalized effect and applies the strictest disposition:

- payload-free network reads with no additional effect are `allow`;
- reversible repository/workspace-local mutations, including local Git ref updates, are
  `allow_flagged`;
- external mutation, explicit payload or file sends, secret payloads, high-stakes effects,
  destructive Git operations, and indeterminate/partial analysis require approval;
- `git fetch` and `git pull` combine a payload-free network read with a reversible local
  ref/worktree update and are therefore `allow_flagged`.
- download clients that create local files (for example bare `wget` or `curl -O`) combine
  a payload-free network read with `fs.write`; repository-local output is `allow_flagged`,
  while outside/high-stakes output still requires approval.

Exact one-shot approvals and resource-scoped grants remain supported. They are not
allowlists: they are bound to the exact action, normalized resource/request set,
fingerprint, expiry/use count, and, when present, EffectPlan/request hashes. Resource
exceptions enforced by an attested boundary (for example an egress domain or filesystem
scope) are also distinct from shell command lists.

Git worktrees that share the same canonical Git common directory have the same repository
identity. This identity, rather than path containment alone, makes linked and transactional
worktree effects workspace-local. A separate repository remains outside the workspace even
when nested under it.

## Rationale

Command lists conflate syntax with effects and create two inconsistent authorities. A
canonical plan retains all known effects, preserves uncertainty as an explicit
`indeterminate` requirement, and lets policy decide from operation, resource, payload, and
evidence instead of executable names.

Payload-free reads do not mutate the remote system or transmit an explicit request body.
Treating them as approval-worthy creates avoidable friction. Payload-bearing reads and
mutations remain approval-worthy because they can exfiltrate data or change external state.

## Consequences

- ADR-003's statement that all network reads require approval at L3 no longer applies to
  normalized shell actions. Its resource-scoped authorization and exact-grant decisions
  remain in force.
- Legacy list-shaped configuration remains parse-compatible but inert for shell
  authorization and is reported as forbidden ([ADR-005](./ADR-005-command-allowlist-prohibition.md)).
- Corpus labels are test expectations only; they never grant runtime authority.
- Tool/subagent adapters and L1 broker boundaries retain their own resource enforcement.
- Historical approvals and audit records remain readable under their existing compatibility
  contracts; newly classified shell actions use EffectPlan authority.

