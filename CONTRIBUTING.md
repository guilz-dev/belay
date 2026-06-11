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

## Architecture (v1.0)

- `src/core/` — runtime-agnostic classification, config migration, approval helpers
- `src/adapters/` — Cursor and Claude adapters; see [docs/adapter-sdk.md](docs/adapter-sdk.md)
- `src/conformance/` — layer guarantee table scenarios and profile configs
- `scripts/build-runtime.mjs` — bundles hook runtimes into `dist/bundle/`

When changing hook semantics, update core modules and tests first, then rebuild
so generated `.cursor/belay/runtime/core.mjs` artifacts pick up the bundle.

## Changes

When changing behavior, prefer updating:

- `README.md` for public-facing runtime and scope changes
- tests under `src/__tests__/` for observable behavior changes
- `skills/belay/SKILL.md` for the distributed skill content
- `docs/v0.2-plan.md` when scope or milestone decisions change

## Releases

Releases follow [docs/semver-policy.md](docs/semver-policy.md). Before cutting a release:

1. `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all pass (Ubuntu + macOS CI).
2. Conformance scenarios match [docs/guarantee-table.md](docs/guarantee-table.md).
3. `README.md` and [docs/SPEC-v1.0.md](docs/SPEC-v1.0.md) match the release.
4. `dist/` has been rebuilt from the current sources.
5. `npx skills add guilz-dev/agent-belay --list` shows `belay` after push.
