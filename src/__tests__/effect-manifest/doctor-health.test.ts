import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { mergeConfig } from '../../core/config.js'
import { diagnoseEffectManifestHealth } from '../../core/effect-manifest/doctor-health.js'
import { manifestFilePath } from '../../core/effect-manifest/paths.js'
import { bindManifestExecutableIdentity } from './test-executable.js'

const manifestTemplate = {
  schemaVersion: 1 as const,
  command: {
    basename: 'demo-tool',
    canonicalPath: '/tmp/demo-tool',
    sha256: 'a'.repeat(64),
    kind: 'native' as const,
  },
  fallback: 'indeterminate' as const,
  rules: [],
}

describe('diagnoseEffectManifestHealth', () => {
  it('flags stale executable identity on disk', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-doctor-'))
    const bound = await bindManifestExecutableIdentity(repoRoot, manifestTemplate)
    await mkdir(path.dirname(manifestFilePath(repoRoot, 'demo-tool')), { recursive: true })
    await writeFile(manifestFilePath(repoRoot, 'demo-tool'), JSON.stringify(bound))
    const config = mergeConfig({})
    const healthy = diagnoseEffectManifestHealth(repoRoot, config)
    expect(healthy.issues).toHaveLength(0)

    await writeFile(bound.command.canonicalPath, 'changed contents\n')
    const stale = diagnoseEffectManifestHealth(repoRoot, config)
    expect(stale.issues.some((issue) => issue.includes('stale'))).toBe(true)
  })
})
