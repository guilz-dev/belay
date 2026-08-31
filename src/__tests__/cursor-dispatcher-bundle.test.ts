import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('Cursor dispatcher dependency surface', () => {
  it('does not bundle policy, audit, config defaults, or the full Cursor layout', async () => {
    const result = await esbuild.build({
      entryPoints: [path.join(repoRoot, 'src/adapters/cursor/hook-dispatch-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      write: false,
      metafile: true,
    })

    const inputs = Object.keys(result.metafile.inputs).map((input) =>
      path.relative(repoRoot, path.resolve(input)).split(path.sep).join('/'),
    )
    const forbiddenInputs = inputs.filter(
      (input) =>
        input.startsWith('src/core/') ||
        input.startsWith('src/audit') ||
        input === 'src/defaults.ts' ||
        input === 'src/config-io.ts' ||
        input === 'src/adapters/layouts/cursor.ts',
    )

    expect(forbiddenInputs).toEqual([])
  })
})
