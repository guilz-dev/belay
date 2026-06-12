# Structure

## Layout

```
src/
  cli.ts             # CLI entry (#!/usr/bin/env node): arg parsing, init/doctor commands
  index.ts           # Public package API (re-exports)
  installer.ts       # initProject: writes .cursor artifacts, merges hooks.json
  doctor.ts          # doctorProject + formatDoctorReport: verify an installation
  defaults.ts        # DEFAULT_CONFIG, managed hook event definitions, constants
  templates.ts       # render* fns producing the generated .mjs hook + runtime source
  node-resolution.ts # Resolve a Node binary; build POSIX + Windows runner scripts
  types.ts           # Shared type definitions (config, approvals, hooks, reports)
  __tests__/         # Vitest specs (installer, hooks-runtime)
skills/belay/        # Packaged Skill source shipped with the npm package
  SKILL.md
  belay-approve.md
dist/                # Build output (tsc); not edited by hand
```

## Module responsibilities

- **cli.ts**: thin orchestration only — parse args, dispatch to `initProject` / `doctorProject`,
  handle errors and exit codes. No business logic.
- **installer.ts**: the install pipeline. Owns directory creation, file writing helpers
  (`writeTextFile`, `writeJsonIfMissing`, `writeTextIfMissing`), and the `hooks.json` merge logic
  (`loadHooksFile`, `mergeHooksFile`). Managed hooks are inserted with prepend/append placement.
- **defaults.ts**: single source of truth for the default config and the set of managed hook
  events (with their runner commands, placement, and matchers). Platform-aware via `process.platform`.
- **templates.ts**: produces the runtime code that gets installed into consumer repos. The
  classifier and approval/audit logic live here as template strings, not as compiled TS.
- **node-resolution.ts**: finds Node across `process.execPath`, `PATH`, and managers (mise/fnm/nvm),
  and generates the shell/cmd runner wrappers that the hooks invoke.
- **doctor.ts**: read-only verification. Confirms config, generated files, managed hook entries,
  and Node resolution; reports `issues` and `notes`.

## Generated artifacts (in a consumer repo, not this repo)

`init` writes into the target repo's `.cursor/` directory:

- `belay.config.json`, `hooks.json` (merged)
- `hooks/belay-runner`, `hooks/belay-runner.cmd`, and the `belay-*.mjs` hook entrypoints
- `belay/runtime/core.mjs` (the classifier + approval/audit engine)
- `belay/pending-approvals.json`, `belay/approved-approvals.json`, `belay/audit.ndjson`

These are local runtime artifacts and should generally stay out of git in consumer repos.

## Where to make changes

- Change install behavior or file layout → `installer.ts` (+ update `doctor.ts` checks).
- Change default config or which events are gated → `defaults.ts`.
- Change runtime gating/classification behavior → `templates.ts` (`renderRuntimeCore` and the
  per-hook render functions).
- Add or change shared types → `types.ts`, then export from `index.ts` if public.
