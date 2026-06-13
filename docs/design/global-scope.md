# Global install scope — design (SPEC v2.2 R-S5)

## Summary

`--scope project|global` controls where **hooks, runtime, and skill** artifacts are written.
**Config, approval state, and audit** always remain **per-repository** (project-relative).

The chosen scope is persisted in `belay.config.json` as `installScope`. Subsequent
`upgrade` runs use the saved value unless `--scope` is passed explicitly.

## Path matrix

| Artifact | `project` (default) | `global` |
| --- | --- | --- |
| hooks / runner scripts | `<repo>/.cursor\|.claude\|.codex/hooks/` | `~/.cursor\|.claude\|.codex/hooks/` |
| runtime (`core.mjs`) | `<repo>/.*/belay/runtime/` | `~/.*/belay/runtime/` |
| skill (`SKILL.md`) | `<repo>/.*/skills/belay/` | `~/.*/skills/belay/` |
| Cursor commands | `<repo>/.cursor/commands/` | `~/.cursor/commands/` |
| **belay.config.json** | `<repo>/.*/belay.config.json` | **same (project)** |
| **pending/approved approvals** | `<repo>/.*/belay/` | **same (project)** |
| **audit.ndjson** | `<repo>/.*/belay/audit.ndjson` | **same (project)** |

## Runner command paths

- **project**: repo-relative `./.cursor/hooks/belay-runner` (cwd = repo root).
- **global**: absolute path to `~/.cursor/hooks/belay-runner` (hooks live outside repo).

Generated via `buildRunnerInvocation(hooksDir, repoRoot)` in [`src/adapters/layouts/scope.ts`](../../src/adapters/layouts/scope.ts).

## Integrity manifest

`integrity-manifest.json` tracks **project-scoped files only** when hooks are global:
- Always: `belay.config.json`, manifest itself.
- When hooks are under repo: hooks settings, hook scripts, `core.mjs`.

Global hook files are verified by `doctor` existence checks (using `installScope` from config), not the manifest.

## Managed scope

`/etc/codex/managed_config.toml` — **not implemented in v2.2**. `--scope managed` returns an explicit error.

## Codex skill path

`init --with-skill` writes to `.codex/skills/belay/SKILL.md` (project) or `~/.codex/skills/belay/SKILL.md` (global).

`npx skills add -a codex` may use `.agents/skills/` — separate distribution channel.

## Global install caveats

- **Cursor / Claude / Codex global hooks** apply user-wide (all workspaces that load the global agent config).
- Switching scope (`upgrade --scope project` after a global install) does not remove prior global artifacts; clean up manually if needed.
