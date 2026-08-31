# Task 4 report — Multi-Root Integration and Documentation

## Delivered

- Added `src/__tests__/cursor-hook-precedence.integration.test.ts`, which installs generated Cursor
  hooks into an isolated temporary home and two temporary Project repositories, then executes the
  actual commands from all three `hooks.json` sources with one action-repository payload.
- The primary reproduction asserts literal neutral responses for both non-owners, one Project owner
  core import, and one gate audit record.
- Added process coverage for Project-only, global-only, uninitialized/no-config neutral,
  incomplete selected Project fail-closed, canonical symlink identity, and separate
  `beforeShellExecution` / `preToolUse: Shell` executions.
- Core imports are observed through temporary executable marker side effects. Non-owner assertions
  do not inspect generated source or mock the dispatcher/core boundary.
- Added ADR-008 and updated the domain context, README, config schema documentation, and changelog
  with Project-over-User precedence, multi-root action selection, neutral/fail-closed behavior,
  pre-router migration/doctor guidance, and the explicit source-precedence limits.
- No runtime, policy, EffectPlan, config, approval, control-plane, or audit schema changed.

## RED/GREEN evidence

The Task 1–3 branch already contained the routing implementation, so the first complete process
reproduction passed against the post-fix baseline. To verify the new regression test could detect
the original break, the router was temporarily mutated to let the global source execute for a
Project-scoped action, the dispatcher was rebuilt, and the focused reproduction was run:

`pnpm build && pnpm vitest run src/__tests__/cursor-hook-precedence.integration.test.ts -t 'runs one effective gate when Cursor invokes global and two project sources'`

**RED:** failed as expected because the observed core imports were `['global', 'project-a']`
instead of the literal `['project-a']`. The audit assertion would also have observed the duplicate
effective execution after the marker assertion.

The mutation was removed with no production diff retained, artifacts were rebuilt, and the whole
integration file was run:

`pnpm build && pnpm vitest run src/__tests__/cursor-hook-precedence.integration.test.ts`

**GREEN:** 7 tests passed. After the cross-platform temporary-home cleanup refactor, a fresh focused
run again passed all 7 tests.

## Full verification

- `pnpm lint` — exit 0 across 476 files. Biome reported 10 warnings and one informational finding
  in pre-existing judge/config and approval lookup files; no Task 4 file had a finding.
- `pnpm typecheck` — passed.
- `pnpm test` — passed: 178 files, 2450 tests passed, 2 skipped (2452 total), including a fresh
  build of all runtime bundles and the Cursor dispatcher.
- `pnpm exec biome check src/__tests__/cursor-hook-precedence.integration.test.ts` — passed.
- `pnpm vitest run src/__tests__/cursor-hook-precedence.integration.test.ts` — passed: 7 tests.
- `git diff --check` — passed.

## Self-review

- The integration test reads and runs installed hook commands rather than calling the router
  directly, so runner, shim, dispatcher, dynamic core import, policy evaluation, and audit append
  participate in the primary path.
- Both `HOME` and Windows `USERPROFILE` are redirected to and restored from temporary locations;
  tests never write external Cursor settings or logs.
- Expected ownership and marker values are literal and hand-derived. The real audit file is
  truncated after installation and parsed after hook execution, so the one-record assertion cannot
  be satisfied by installer state.
- The multi-root payload deliberately lists the non-owner Project first while top-level/action
  working-directory data selects Project A. Symlink coverage verifies canonical identity.
- The incomplete-owner case removes the selected Project core and proves global/nonmatching sources
  stay neutral while the matching Project dispatcher denies without any core import or audit write.
- Separate canonical Shell events intentionally produce two core imports and two audit records;
  the documentation does not claim event-id deduplication or repeated-delivery suppression.
- No unrelated warnings were fixed and no product schema or authorization behavior was changed.
