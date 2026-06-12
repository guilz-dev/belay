# Tech

## Stack

- **Language**: TypeScript (strict), compiled to ESM
- **Runtime**: Node.js >= 22, ESM-only (`"type": "module"`)
- **Package manager**: pnpm (pinned via `packageManager`, currently pnpm@10)
- **Test runner**: Vitest
- **Lint/format**: Biome
- **Build**: `tsc` via `tsconfig.build.json`

## Distribution

- Published as the `agent-belay` npm package with a single bin: `agent-belay` → `dist/cli.js`
- Public API is re-exported from `src/index.ts`
- Generated hook artifacts ship as ESM (`.mjs`) and are written into the target repo's `.cursor/`
  directory at `init` time

## Common commands

```bash
pnpm build      # tsc -p tsconfig.build.json
pnpm test       # vitest run
pnpm lint       # biome check on src + root config/doc files
pnpm typecheck  # tsc --noEmit
```

CLI usage (the product itself):

```bash
npx agent-belay init               # install hook runtime into the current repo
npx agent-belay init --with-skill  # also install Skill + command artifacts
npx agent-belay doctor             # verify installation (add --json for machine output)
```

## Conventions

- Use Node built-ins via the `node:` prefix (e.g. `node:fs/promises`, `node:path`, `node:crypto`).
- Import paths within `src` use explicit `.js` extensions (ESM + bundler resolution requires it).
- Formatting (enforced by Biome): 2-space indent, 100-char line width, single quotes,
  semicolons only as needed. Run `pnpm lint` before considering work done.
- `strict`, `noUnusedLocals`, and `noUnusedParameters` are on — keep code clean of unused symbols.
- Prefer named exports; avoid default exports.

## Notes on generated runtime

- The runtime hook code lives as template strings in `src/templates.ts` and is emitted into the
  consumer repo (it is not part of the compiled `dist` directly). When changing runtime behavior,
  edit the template strings, and remember escaping rules apply (backslashes, regex literals).
- Re-running `init` rewrites managed config and hook files but preserves existing non-Belay hook
  entries in `hooks.json`. State files (approvals, audit log) are created only if missing.
