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
`mode: audit` repositories to behave as enforce defaults.

## Decision

Cursor hook runtime MUST resolve action cwd from hook payload before calling `findRepoRoot`.
For shell actions, the required priority order is:

1. `payload.tool_input.working_directory`
2. `payload.cwd`
3. first non-empty `payload.workspace_roots[]`
4. fallback to hook process cwd

For non-shell actions, nested `tool_input` cwd fields are not authoritative; runtime uses
`payload.cwd`, then `workspace_roots`, then process cwd fallback.

This resolution rule applies to all Cursor runtime entry points:

- `beforeSubmitPrompt`
- `preToolUse` / `subagentStart`
- `postToolUse` audit path
- shell gate entry points

## Consequences

- Global installs continue to use a repository-local `belay.config.json` as canonical policy.
- Hook install location no longer changes policy source selection.
- Dogfood/audit mode remains consistent across shell, tool, subagent, and audit hooks.
- Runtime diagnostics MUST detect old global bundles that still depend on hook process cwd.

## Guardrails

`belay doctor` warns for Cursor global installs when the installed runtime bundle does not
contain payload-based workspace resolution markers. Operators should run:

`belay upgrade --scope global`

from the latest package build.
