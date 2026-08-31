# ADR-007 — Global hook workspace resolution for Cursor

- Status: Accepted
- Date: 2026-08-31
- Related: [ADR-001](./ADR-001-layered-enforcement.md),
  [ADR-003](./ADR-003-resource-scoped-capability.md)

## Context

With `installScope: global`, Cursor hooks and runtime live under `~/.cursor`, while
`belay.config.json` remains repository-local at `<repoRoot>/.cursor/belay.config.json`.

Hook scripts run with a process cwd under `~/.cursor/hooks`, not the active workspace.
If runtime code derives `repoRoot` from `process.cwd()`, it can resolve to `$HOME` (because
`$HOME/.cursor` exists) and silently bypass the intended repository config. This can cause
`mode: audit` repositories to behave as enforce defaults, blocked edits, and stuck approvals.

## Decision

1. **Payload-first cwd resolution** — Resolve action cwd in priority order:
   `tool_input.working_directory` → `cwd` → first non-empty `workspace_roots[]` → fallback.
   Non-Shell `preToolUse` events ignore nested `tool_input.working_directory` (Shell-only).
   Applies to `beforeSubmitPrompt`, `preToolUse` / `subagentStart`, shell gates, and audit hooks.

2. **Fail closed for global hooks** — When the runtime bundle is loaded from
   `$HOME/.cursor/belay/runtime` and no payload field yields a workspace path, hooks deny
   (or `continue: false` for `beforeSubmitPrompt`) with an operator-facing message instead of
   using `process.cwd()`.

3. **Approval reverse lookup** — Approval-only prompts (`/belay-approve <id>`) may scan
   `workspace_roots` candidates when the first repo guess does not contain the approval.
   Multiple matches produce an explicit ambiguity error.

4. **Repo root markers** — Adapter markers `.cursor` / `.claude` / `.codex` require a belay
   config file at the expected path; bare agent directories (e.g. `$HOME/.cursor`) are not
   repo roots.

5. **Uninstall path** — `belay uninstall --scope global|project` removes managed hook
   entries and belay hook/runtime artifacts from the selected install scope.

## Consequences

- Global installs continue to use a repository-local `belay.config.json` as canonical policy.
- Hook install location no longer changes policy source selection.
- Operators must run `belay upgrade --scope global` after upgrading belay to refresh global
  runtime artifacts.
- Payload-free global hook events are blocked until the workspace is opened or payload
  fields are restored by Cursor.
- In-flight pending approvals may need one retry after upgrade if runtime fingerprinting
  changes; approvals re-issue on the next denied action.
- Recovery from a runaway global install: `belay uninstall --scope global` from any
  initialized repo, then `belay doctor`.

## Guardrails

`belay doctor` warns for Cursor global installs when the installed runtime bundle does not
contain payload-based workspace resolution markers. For Cursor global installs, `doctor` also
notes `belay uninstall --scope global` as the official stop path. Operators should run:

`belay upgrade --scope global`

from the latest package build.

## Verification

- `pnpm test -- src/__tests__/hooks-runtime.test.ts src/__tests__/repo-root.test.ts src/__tests__/approval-repo-lookup.test.ts src/__tests__/installer-scope.test.ts`
- Global install smoke: `Write` / `Shell` / `/belay-approve` reference the same repo state
  when `cwd` or `workspace_roots` are present in payloads.
- `belay uninstall --scope global` removes belay entries from `$HOME/.cursor/hooks.json`.
