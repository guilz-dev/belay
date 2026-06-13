import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuild from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, 'dist', 'bundle')

const adapters = [
  { name: 'cursor', entry: 'src/adapters/cursor/runtime-entry.ts' },
  { name: 'claude', entry: 'src/adapters/claude/runtime-entry.ts' },
  { name: 'codex', entry: 'src/adapters/codex/runtime-entry.ts' },
]

await mkdir(outDir, { recursive: true })

for (const adapter of adapters) {
  const outFile = path.join(outDir, `${adapter.name}-runtime.mjs`)
  await esbuild.build({
    entryPoints: [path.join(rootDir, adapter.entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: outFile,
    banner: {
      js: `// agent-belay ${adapter.name} runtime bundle`,
    },
  })
  console.log(`Built ${outFile}`)
}
