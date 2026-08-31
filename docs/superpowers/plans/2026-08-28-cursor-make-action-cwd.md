# Cursor Action Cwd and Make Prerequisite Implementation Plan

> **For implementers:** Use `superpowers:test-driven-development` for each behavior change and `superpowers:verification-before-completion` before claiming completion.

**Goal:** Classify Cursor Shell actions from their actual working directory and make every known Make prerequisite recipe visible to EffectPlan.

**Scope:** This is an incident fix only. It does not add native execution, tickets, Seatbelt, Docker behavior, configuration, or host-denial telemetry.

**Tech Stack:** TypeScript 5.9, Node.js 24, pnpm 10.29.3, Vitest 3

---

### Task 0: Make the repository’s CI Node version discoverable locally

**Files:**

- Create: `.node-version`
- Modify: `src/__tests__/quality.test.ts`

- [ ] Add a failing quality assertion that `.node-version` exists and equals the Node major configured in `.github/workflows/ci.yml`.
- [ ] Run `pnpm exec vitest run src/__tests__/quality.test.ts` and verify RED.
- [ ] Add `.node-version` containing `24` followed by one newline.
- [ ] Run the same test and verify GREEN.
- [ ] Commit only `.node-version` and the quality assertion as `chore: declare the local Node version`.

This removes the current installation blocker in fresh worktrees without changing the published `engines.node >=22` contract.

---

### Task 1: Resolve Cursor Shell cwd from the action payload

**Files:**

- Modify: `src/adapters/cursor/runtime-entry.ts`
- Modify: `src/__tests__/hooks-runtime.test.ts`

**New test seam:**

```ts
export function resolveCursorActionCwd(
  payload: Record<string, unknown>,
  fallback: string,
): string
```

Resolution order:

1. `payload.tool_input.working_directory` for `preToolUse: Shell`.
2. Top-level `payload.cwd`.
3. First non-empty string in `payload.workspace_roots`.
4. The supplied fallback (`process.cwd()` in production).

Normalize the selected value with `path.resolve`. Ignore empty strings and non-string values.

- [ ] Add table-driven unit cases for all four sources, malformed nested input, empty strings, and precedence when all sources differ.
- [ ] Add an integration fixture with two linked workspace directories containing different Make targets. Start the generated hook process from the parent directory, pass the child via `tool_input.working_directory`, and assert the child target is resolved.
- [ ] Add the paired MUST-ASK case: the parent Makefile looks harmless, but the child target contains a known external/container-affecting prerequisite; assert `permission: deny` from the adapter response and a pending exact approval in audit/state.
- [ ] Run `pnpm exec vitest run src/__tests__/hooks-runtime.test.ts` and verify RED.
- [ ] Use `resolveCursorActionCwd(payload, process.cwd())` in `runToolGateHook` before `loadRuntimeContext` and before constructing the `GatedAction`.
- [ ] Keep `runShellGateHook` on the same resolver so `beforeShellExecution` and `preToolUse` cannot disagree about cwd.
- [ ] Use the resolved action cwd to find `repoRoot`, config, and audit state. Do not fall back to a config from the hook process repository when the action belongs to a different Git resource.
- [ ] Run the focused test and verify GREEN.

The official payload examples for these fields are at <https://prod.cursor.com/docs/hooks>.

---

### Task 2: Include all known Make prerequisite recipes

**Files:**

- Modify: `src/core/verdict/launcher-resolve.ts`
- Modify: `src/__tests__/verdict/launcher-resolve.test.ts`
- Modify: `src/__tests__/verdict/freelance-grammar.test.ts`
- Modify: `src/__tests__/fixtures/makefiles/freelance-test-fast/Makefile`

- [ ] Update the freelance fixture so `_start_test_deps` contains the real Docker-start loop and `test-fast` depends on it.
- [ ] Replace the existing grammar expectation that `make test-fast ...` is complete/non-unknown with the safety expectation: EffectPlan contains the prerequisite effect and the verdict requires approval.
- [ ] Add a paired benign fixture in `launcher-resolve.test.ts` where a `.PHONY` or `_`-prefixed prerequisite writes only inside the repo; assert both prerequisite and requested-target recipes are returned in dependency order and resolution is not opaque.
- [ ] Add cases for multiple prerequisites, a shared prerequisite, a cycle, a missing prerequisite target, and dynamic prerequisite syntax. Known recipes must be retained even when the unresolved portion makes `opaque: true`.
- [ ] Run:

```bash
pnpm exec vitest run \
  src/__tests__/verdict/launcher-resolve.test.ts \
  src/__tests__/verdict/freelance-grammar.test.ts
```

Expected: RED because `collect()` currently skips prerequisite recipes based on `.PHONY` and `_` naming.

- [ ] Delete the `skipPhonyPrerequisiteRecipes` branch and append every visited target’s recipe after its prerequisites.
- [ ] Remove the now-unused `parsePhonyTargets` import. Do not replace it with target-name policy; Make naming has no authorization semantics.
- [ ] Preserve cycle detection and partial evidence. A cycle or dynamic fragment sets `opaque: true` but does not erase recipes already collected.
- [ ] Run the focused tests and verify GREEN.
- [ ] Commit Tasks 1–2 as `fix: classify Make from the Cursor action workspace`.

---

### Task 3: Record the conformance rule and verify the incident

**Files:**

- Modify: `docs/CONTEXT.md`
- Modify: `docs/adapter-sdk.md`
- Modify: `src/__tests__/quality.test.ts`

- [ ] Add domain text stating that action cwd comes from the host payload and that all statically known Make prerequisite recipes participate in EffectPlan; `.PHONY` and `_` have no policy meaning.
- [ ] Add adapter guidance that action cwd and hook process cwd are distinct inputs.
- [ ] Add structural assertions for those statements, verify RED, write the docs, then verify GREEN.
- [ ] Run the exact regression command through the fixture and assert the Docker prerequisite is visible and approval is required:

```text
make test-fast ARGS="spec/requests/api/v1/project_spec.rb:74"
```

- [ ] Run final verification:

```bash
pnpm lint
pnpm typecheck
pnpm exec vitest run \
  src/__tests__/quality.test.ts \
  src/__tests__/hooks-runtime.test.ts \
  src/__tests__/verdict/launcher-resolve.test.ts \
  src/__tests__/verdict/freelance-grammar.test.ts \
  src/__tests__/effect-ir
pnpm build
git diff --check
```

- [ ] Commit documentation and any final test adjustment as `docs: define action cwd and Make prerequisite authority`.

**Definition of done:** The incident command is no longer misclassified because of the hook process directory or a skipped prerequisite, and a benign prerequisite remains usable without a name-based false positive.
