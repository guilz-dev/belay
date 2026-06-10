import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuild from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(rootDir, 'dist', 'bundle')
const outFile = path.join(outDir, 'cursor-runtime.mjs')

await mkdir(outDir, { recursive: true })

await esbuild.build({
  entryPoints: [path.join(rootDir, 'src', 'adapters', 'cursor', 'runtime-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: outFile,
  banner: {
    js: '// agent-belay cursor runtime bundle',
  },
})

console.log(`Built ${outFile}`)
