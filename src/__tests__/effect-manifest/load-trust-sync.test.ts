import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { repoLocalStateDirFor } from '../../config-io.js'
import { mergeConfig } from '../../core/config.js'
import { unsupportedProcess } from '../../core/effect-ir/shell-lower/requirement.js'
import { applyEffectManifest } from '../../core/effect-manifest/apply.js'
import { ruleFingerprint } from '../../core/effect-manifest/codec.js'
import { commandIdentityFingerprint } from '../../core/effect-manifest/command-identity.js'
import { loadEffectManifestTrustSync } from '../../core/effect-manifest/load-trust-sync.js'
import { manifestFilePath } from '../../core/effect-manifest/paths.js'
import {
  effectManifestTrustRecordPath,
  saveEffectManifestTrustRecord,
} from '../../core/effect-manifest/trust-store.js'
import { bindManifestExecutableIdentity } from './test-executable.js'

const manifestFixture = {
  schemaVersion: 1 as const,
  command: {
    basename: 'unknown-cli',
    canonicalPath: '/usr/bin/unknown-cli',
    sha256: 'a'.repeat(64),
    kind: 'native' as const,
  },
  fallback: 'indeterminate' as const,
  rules: [
    {
      id: 'argv-test',
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

const fixtureRule = manifestFixture.rules[0]
if (!fixtureRule) {
  throw new Error('manifest fixture rule missing')
}

describe('loadEffectManifestTrustSync', () => {
  it('reads trust from the control-plane dir when enabled in repo config', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-trust-cp-'))
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-cp-state-'))
    const repoConfig = mergeConfig({
      controlPlane: { enabled: true, configDir: controlPlaneDir },
    })
    const defaultConfig = mergeConfig({})

    const bound = await bindManifestExecutableIdentity(repoRoot, manifestFixture)
    await mkdir(path.dirname(manifestFilePath(repoRoot, bound.command.basename)), {
      recursive: true,
    })
    await writeFile(manifestFilePath(repoRoot, bound.command.basename), JSON.stringify(bound))

    const ruleFp = ruleFingerprint(bound, fixtureRule)
    const recordPath = effectManifestTrustRecordPath(
      repoConfig,
      repoLocalStateDirFor(repoRoot, repoConfig),
      repoRoot,
      bound.command.canonicalPath,
    )
    await saveEffectManifestTrustRecord(recordPath, {
      schemaVersion: 1,
      repoRoot,
      manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
      commandIdentityFingerprint: commandIdentityFingerprint(bound.command),
      trustedRules: [
        { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
      ],
    })

    expect(
      loadEffectManifestTrustSync(repoRoot, bound.command.canonicalPath, repoConfig),
    ).not.toBeNull()
    expect(
      loadEffectManifestTrustSync(repoRoot, bound.command.canonicalPath, defaultConfig),
    ).toBeNull()

    const binDir = path.join(repoRoot, 'bin')
    const base = unsupportedProcess('unknown-cli', 'unknown-cli status', 'process.grammar_unknown')
    const withRepoConfig = applyEffectManifest({
      repoRoot,
      cwd: repoRoot,
      pathEnv: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      invocationHead: 'unknown-cli',
      decoderHead: 'unknown-cli',
      argv: ['unknown-cli', 'status'],
      requirements: base,
      segmentCompleteness: 'complete',
      role: 'canonical',
      trustRecord: null,
      gateConsumptionEnabled: true,
      belayConfig: repoConfig,
    })
    const withDefaultConfig = applyEffectManifest({
      repoRoot,
      cwd: repoRoot,
      pathEnv: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      invocationHead: 'unknown-cli',
      decoderHead: 'unknown-cli',
      argv: ['unknown-cli', 'status'],
      requirements: base,
      segmentCompleteness: 'complete',
      role: 'canonical',
      trustRecord: null,
      gateConsumptionEnabled: true,
      belayConfig: defaultConfig,
    })

    expect(withRepoConfig.matched).toBe(true)
    expect(withDefaultConfig.matched).toBe(false)
  })
})
