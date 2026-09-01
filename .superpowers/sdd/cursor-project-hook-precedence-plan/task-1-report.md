# Task 1 report — Pure Cursor Hook Ownership Router

## Delivered

- Added `src/adapters/cursor/hook-router.ts` with the requested ownership types and pure
  `routeCursorHook` interface.
- The router resolves a canonical action repo from payload cwd sources, honours Shell-only
  nested working directories, rejects relative/payload-free context without falling back to
  `process.cwd()`, and returns execute, neutral, or fail-closed routes.
- Project ownership requires matching canonical project origin, `installScope: project`, and
  the current event script, runner, and runtime. Global ownership requires `installScope:
  global` and global origin. Symlink paths canonicalize to one owner.

## RED/GREEN evidence

1. **RED:** `pnpm vitest run src/__tests__/cursor-hook-router.test.ts` failed because the new
   router module did not exist. **GREEN:** matching complete project shell install passed.
2. **RED:** global config + global origin returned `neutral` instead of `execute`.
   **GREEN:** global origin now executes while project origin remains neutral.
3. **RED:** complete project `tool-gate` returned `neutral`. **GREEN:** current event hook
   selection now supports all four hook kinds.
4. **RED:** Shell nested `tool_input.working_directory` lost to a conflicting `cwd`.
   **GREEN:** payload-first source precedence determines the action owner.
5. **RED:** before-submit incorrectly ignored its payload nested working directory.
   **GREEN:** only non-Shell `preToolUse` / audit routing strips it.
6. **RED:** relative global-hook `cwd: '.'` used process cwd and returned `neutral`.
   **GREEN:** relative context returns a fail-closed workspace diagnostic.

## Verification

- `pnpm vitest run src/__tests__/cursor-hook-router.test.ts` — 16 passed.
- `pnpm typecheck` — passed.
- `pnpm exec biome check src/__tests__/cursor-hook-router.test.ts src/adapters/cursor/hook-router.ts` — passed.
- `git diff --check` — passed.
- Full `pnpm lint` was attempted; it remains blocked by pre-existing errors/warnings in unrelated
  `src/core/*` and `src/commands/judge.ts` files. The two Task 1 files are clean under scoped
  Biome checking.
