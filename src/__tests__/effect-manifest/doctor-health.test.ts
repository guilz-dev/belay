import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { repoLocalStateDirFor } from '../../config-io.js'
import { mergeConfig } from '../../core/config.js'
import { ruleFingerprint } from '../../core/effect-manifest/codec.js'
import { diagnoseEffectManifestHealth } from '../../core/effect-manifest/doctor-health.js'
import { manifestFilePath } from '../../core/effect-manifest/paths.js'
import {
  effectManifestTrustRecordPath,
  saveEffectManifestTrustRecord,
} from '../../core/effect-manifest/trust-store.js'
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
  rules: [
    {
      id: 'r1',
      matcher: { argv: [{ kind: 'literal' as const, value: 'status' }] },
      contract: { processOperation: 'inspect' as const, effects: [] },
      assertion: 'complete-upper-bound' as const,
      inference: {
        method: 'manual' as const,
        generatedAt: '2026-09-19T00:00:00.000Z',
        generatorVersion: 'test',
        evidence: [],
        warnings: [],
      },
    },
  ],
}

const fixtureRule = manifestTemplate.rules[0]
if (!fixtureRule) {
  throw new Error('fixture rule missing')
}

function manifestConfig(repoRoot: string) {
  return mergeConfig({
    controlPlane: {
      enabled: false,
      configDir: path.join(os.tmpdir(), 'belay-test-control-plane', path.basename(repoRoot)),
    },
  })
}

describe('diagnoseEffectManifestHealth', () => {
  it('flags stale executable identity on disk', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-doctor-'))
    const bound = await bindManifestExecutableIdentity(repoRoot, manifestTemplate)
    await mkdir(path.dirname(manifestFilePath(repoRoot, 'demo-tool')), { recursive: true })
    await writeFile(manifestFilePath(repoRoot, 'demo-tool'), JSON.stringify(bound))
    const config = manifestConfig(repoRoot)
    const healthy = diagnoseEffectManifestHealth(repoRoot, config)
    expect(healthy.issues).toHaveLength(0)

    await writeFile(bound.command.canonicalPath, 'changed contents\n')
    const stale = diagnoseEffectManifestHealth(repoRoot, config)
    expect(stale.issues.some((issue) => issue.includes('stale'))).toBe(true)
  })

  it('flags stale command identity on trust records', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-doctor-trust-'))
    const bound = await bindManifestExecutableIdentity(repoRoot, manifestTemplate)
    await mkdir(path.dirname(manifestFilePath(repoRoot, 'demo-tool')), { recursive: true })
    await writeFile(manifestFilePath(repoRoot, 'demo-tool'), JSON.stringify(bound))
    const config = manifestConfig(repoRoot)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(bound, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, bound.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'demo-tool'),
        commandIdentityFingerprint: 'b'.repeat(64),
        trustedRules: [{ id: 'r1', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' }],
      },
    )

    const report = diagnoseEffectManifestHealth(repoRoot, config)
    expect(report.issues.some((issue) => issue.includes('executable identity is stale'))).toBe(true)
  })
})
