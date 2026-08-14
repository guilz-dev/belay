import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../../..')

describe('shell EffectPlan authority structure', () => {
  it('has no generated standing catalog build or runtime dependency', async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const runtimeSources = await Promise.all(
      [
        'src/core/standing-allow.ts',
        'src/adapters/shared/gate-runtime.ts',
        'src/core/verdict/verdict.ts',
      ].map((relativePath) => readFile(path.join(repoRoot, relativePath), 'utf8')),
    )

    expect(packageJson.scripts?.build).not.toContain('generate-standing-allow-catalog')
    expect(existsSync(path.join(repoRoot, 'scripts/generate-standing-allow-catalog.mjs'))).toBe(
      false,
    )
    expect(existsSync(path.join(repoRoot, 'src/corpus/standing-allow-catalog.generated.ts'))).toBe(
      false,
    )
    expect(runtimeSources.join('\n')).not.toContain('standing-allow-catalog.generated')
  })

  it('does not retain the legacy parallel shell classifier', async () => {
    const source = await readFile(path.join(repoRoot, 'src/core/verdict/verdict.ts'), 'utf8')

    expect(source).not.toContain('evaluateSegment(')
    expect(source).not.toContain('TIER0_EXTERNAL_HEADS')
    expect(source).not.toContain("'./overrides.js'")
    expect(source).not.toContain("'./shell-policy.js'")
  })
})
