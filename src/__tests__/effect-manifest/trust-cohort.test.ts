import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { repoLocalStateDirFor } from '../../config-io.js'
import { mergeConfig } from '../../core/config.js'
import {
  composeDecisionConfigFingerprint,
  hashDecisionConfig,
} from '../../core/decision-config-fingerprint.js'
import { ruleFingerprint } from '../../core/effect-manifest/codec.js'
import { manifestFilePath } from '../../core/effect-manifest/paths.js'
import { collectActiveEffectManifestRuleFingerprints } from '../../core/effect-manifest/trust-cohort.js'
import {
  effectManifestTrustRecordPath,
  saveEffectManifestTrustRecord,
} from '../../core/effect-manifest/trust-store.js'

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

describe('effect manifest trust cohort', () => {
  it('changes decision cohort fingerprint when trusted rules are present', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-cohort-'))
    const config = mergeConfig({})
    const baseline = composeDecisionConfigFingerprint(config, repoRoot)
    expect(baseline).toBe(hashDecisionConfig(config))

    await mkdir(path.dirname(manifestFilePath(repoRoot, 'unknown-cli')), { recursive: true })
    const rule = manifestFixture.rules[0]
    if (!rule) {
      throw new Error('fixture rule missing')
    }
    const ruleFp = ruleFingerprint(manifestFixture, rule)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(
        config,
        stateDir,
        repoRoot,
        manifestFixture.command.canonicalPath,
      ),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: 'test',
        trustedRules: [{ id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' }],
      },
    )

    expect(collectActiveEffectManifestRuleFingerprints(repoRoot, config)).toEqual([ruleFp])
    expect(composeDecisionConfigFingerprint(config, repoRoot)).not.toBe(baseline)
  })

  it('does not read trust records from another checkout root', async () => {
    const repoA = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-cohort-a-'))
    const repoB = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-cohort-b-'))
    const config = mergeConfig({})
    const rule = manifestFixture.rules[0]
    if (!rule) {
      throw new Error('fixture rule missing')
    }
    const ruleFp = ruleFingerprint(manifestFixture, rule)
    const stateDir = repoLocalStateDirFor(repoA, config)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoA, manifestFixture.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot: repoA,
        manifestPath: manifestFilePath(repoA, 'unknown-cli'),
        commandIdentityFingerprint: 'test',
        trustedRules: [{ id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' }],
      },
    )

    expect(collectActiveEffectManifestRuleFingerprints(repoB, config)).toEqual([])
    expect(composeDecisionConfigFingerprint(config, repoB)).toBe(hashDecisionConfig(config))
  })
})
