# Contributing

## Development

Install dependencies:

```bash
pnpm install
```

Run the local quality gates:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Current Adapter Boundary

`agent-belay` is intended as an agent-facing package, but the current v0.1
runtime adapter is implemented for Cursor-style hooks.

- Core ideas: approval state, fingerprinting, audit, runtime classification
- Current integration: `.cursor/` installer, hook runner, optional Skill files
- Future work: additional adapters for other agent runtimes

## Changes

When changing behavior, prefer updating:

- `README.md` for public-facing runtime and scope changes
- tests under `src/__tests__/` for observable behavior changes
- `skills/belay/SKILL.md` for the distributed skill content
- generated runtime template logic in `src/templates.ts` when hook semantics
  change

## Releases

For now, releases are manual. Before cutting a release, make sure:

1. `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all pass.
2. `README.md` matches the current adapter scope.
3. `dist/` has been rebuilt from the current sources.
4. `npx skills add guilz-dev/agent-belay --list` shows `belay` after push.
