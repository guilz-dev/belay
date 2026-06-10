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

`pnpm test` runs `pnpm build` first because hook integration tests install the
esbuild-bundled Cursor runtime from `dist/bundle/cursor-runtime.mjs`.

## Architecture (v0.2+)

- `src/core/` — runtime-agnostic classification, config migration, approval helpers
- `src/adapters/cursor/` — Cursor hook runtime and adapter interface implementation
- `scripts/build-runtime.mjs` — bundles the Cursor runtime into `dist/bundle/`

When changing hook semantics, update core modules and tests first, then rebuild
so generated `.cursor/belay/runtime/core.mjs` artifacts pick up the bundle.

## Changes

When changing behavior, prefer updating:

- `README.md` for public-facing runtime and scope changes
- tests under `src/__tests__/` for observable behavior changes
- `skills/belay/SKILL.md` for the distributed skill content
- `docs/v0.2-plan.md` when scope or milestone decisions change

## Releases

For now, releases are manual. Before cutting a release, make sure:

1. `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all pass.
2. `README.md` matches the current adapter scope.
3. `dist/` has been rebuilt from the current sources.
4. `npx skills add guilz-dev/agent-belay --list` shows `belay` after push.
