# Static shell-control lowering correction

Date: 2026-08-26

## Problem

Commit `e87dc00` made shell-control builtins and assignment-only segments
indeterminate inside statically parsed `sh -c` and Docker Compose shell bodies. The
change made approval-replay tests pass because their safe success/failure fixture used
`sh -c 'exit 0|1'`, but it changed production authorization semantics to satisfy test
setup.

That behavior conflicts with the restorability floor: a statically known `set`, `wait`,
valid `exit`, or assignment-only shell segment has no irreversible effect. Unknown or
dynamic operands must still remain indeterminate.

## Decision

- Apply shell-control and assignment-only lowering consistently whenever the shell body
  has been parsed statically, including recursive shells, Compose shell wrappers, and
  launcher recipes.
- Keep invalid or dynamic builtin operands indeterminate.
- Use `node -e 'process.exit(0|1)'` as the approval-replay success/failure fixture. The
  code-evaluation effect is genuinely indeterminate under the current model, while the
  executed fixture remains deterministic and side-effect free.
- Do not alter approval replay matching. Its fingerprint, cwd, repository, payload, and
  EffectPlan bindings remain the authority for exact replay.

## Verification contract

Paired tests must cover:

- **MUST-ALLOW:** static recursive-shell builtins, assignment-only segments, and Compose
  shell builtins produce complete plans without an `indeterminate` requirement.
- **MUST-ASK:** dynamic or invalid nested builtin operands remain partial and retain an
  `indeterminate` requirement.
- Approval replay succeeds and fails through its existing boundary tests without relying
  on a benign shell builtin being misclassified.

