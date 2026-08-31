# ADR-007: Global hook workspace resolution (Cursor)

## Status

Accepted (2026-08-31)

## Context

Cursor global installs place hook runners under `$HOME/.cursor/hooks` while per-repo policy
and approval state remain in each workspace's `.cursor/belay.config.json`. When Cursor omits
workspace fields from a hook payload, belay previously fell back to `process.cwd()`, which
often resolved to `$HOME` or `$HOME/.cursor` and caused wrong-repo policy loads, blocked
edits, and stuck approvals.

## Decision

1. **Payload-first cwd resolution** — Resolve action cwd in priority order:
   `tool_input.working_directory` → `cwd` → first non-empty `workspace_roots[]` → fallback.
   Non-Shell `preToolUse` events ignore nested `tool_input.working_directory` (Shell-only).

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

- Operators must run `belay upgrade --scope global` after upgrading belay to refresh global
  runtime artifacts.
- Payload-free global hook events are blocked until the workspace is opened or payload
  fields are restored by Cursor.
- In-flight pending approvals may need one retry after upgrade if runtime fingerprinting
  changes; approvals re-issue on the next denied action.
- Recovery from a runaway global install: `belay uninstall --scope global` from any
  initialized repo, then `belay doctor`.

## Verification

- `pnpm test -- src/__tests__/hooks-runtime.test.ts src/__tests__/repo-root.test.ts src/__tests__/approval-repo-lookup.test.ts src/__tests__/installer-scope.test.ts`
- Global install smoke: `Write` / `Shell` / `/belay-approve` reference the same repo state
  when `cwd` or `workspace_roots` are present in payloads.
- `belay uninstall --scope global` removes belay entries from `$HOME/.cursor/hooks.json`.
