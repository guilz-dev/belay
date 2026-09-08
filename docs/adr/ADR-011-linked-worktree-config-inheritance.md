# ADR-011 — Linked worktree repository config inheritance

- Status: Accepted
- Date: 2026-09-08
- Related: [ADR-008](./ADR-008-cursor-hook-source-precedence.md),
  [ADR-010](./ADR-010-repository-config-trust.md)

## Context

Git linked worktrees share repository identity but keep separate checkout directories.
Each checkout may have its own `.cursor/belay.config.json`, hooks, runtime bundle, and
audit storage. Before this ADR, a linked worktree without a local config file fell back to
builtin defaults (`mode: enforce`) even when the primary checkout was in dogfood mode.
That produced environment skew: the same repository looked dogfooded from the primary
checkout but enforced from sibling worktrees opened in Cursor.

Automatic file propagation to every worktree was intentionally deferred because policy files
must not be copied without an explicit operator target and review.

## Decision

1. **Read-time inheritance, not file copy** — When a checkout has no local repository
   config file, Belay resolves policy from another linked worktree in the same Git
   worktree set. No config file is written into the recipient checkout automatically.

2. **Primary-first source selection** — Inheritance searches linked worktrees in this
   order: primary checkout (`.git` is a directory), then other linked checkouts in stable
   lexicographic order. The first readable config wins.

3. **Local config wins** — A present local config file always overrides inheritance,
   including explicit non-dogfood overrides.

4. **Unreadable local config fail-closed** — If the local config path exists but JSON is
   unreadable, config resolution throws and gates fail closed. Belay must not treat an
   unreadable local file as absent and inherit sibling policy (ADR-008/010 alignment).

5. **Trust follows the config source** — Repository config trust is checked against
   `configSourceRoot`, the checkout that owns the effective config bytes. Inherited policy
   requires the source checkout's trust record.

6. **Hooks and audit remain local** — Inheritance applies to repository policy config only.
   Hook shims, runtime bundles, integrity manifests, and audit files remain per checkout.
   Operators still run `belay upgrade` in each checkout Cursor may execute hooks from.
   Config inheritance does not substitute for hook routing health checks (ADR-008 §5).

7. **Provenance visibility** — Layered config provenance records an `inherited` layer pointing
   at the source config path. `belay doctor` notes the source checkout when policy is inherited.

## Consequences

- Linked worktrees without a local config inherit primary dogfood/enforce policy instead of
  builtin enforce defaults.
- Dogfood environment skew checks treat inherited dogfood policy as aligned.
- Malformed local config no longer silently falls back to sibling inheritance.
- Operators can still override one worktree by writing a local config file there.

## Limits

- Inheritance requires Git linked worktrees (`git worktree list`). Unrelated directories are
  unaffected.
- Non-primary siblings with config are used only when the primary checkout has no readable
  config.
- Separate checkouts still need their own hook/runtime install for project scope.

## Verification

- `src/__tests__/linked-worktree-config.test.ts`
- `src/__tests__/doctor.test.ts`
- `src/__tests__/dogfood.test.ts`
