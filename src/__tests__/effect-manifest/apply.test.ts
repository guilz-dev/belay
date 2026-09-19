import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { repoLocalStateDirFor } from '../../config-io.js'
import { mergeConfig } from '../../core/config.js'
import { collectRequirements } from '../../core/effect-ir/build.js'
import { unsupportedProcess } from '../../core/effect-ir/shell-lower/requirement.js'
import { lowerShellEffectPlan } from '../../core/effect-ir/shell-lower.js'
import { applyEffectManifest } from '../../core/effect-manifest/apply.js'
import { ruleFingerprint } from '../../core/effect-manifest/codec.js'
import { manifestFilePath } from '../../core/effect-manifest/paths.js'
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

const fixtureRule = manifestFixture.rules[0]
if (!fixtureRule) {
  throw new Error('manifest fixture rule missing')
}

describe('applyEffectManifest', () => {
  it('replaces grammar_unknown only for trusted rules on canonical role', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-'))
    await mkdir(path.dirname(manifestFilePath(repoRoot, 'unknown-cli')), { recursive: true })
    await writeFile(manifestFilePath(repoRoot, 'unknown-cli'), JSON.stringify(manifestFixture))
    const config = mergeConfig({})
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifestFixture, fixtureRule)
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
        trustedRules: [
          { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
        ],
      },
    )

    const base = unsupportedProcess('unknown-cli', 'unknown-cli status', 'process.grammar_unknown')
    const applied = applyEffectManifest({
      repoRoot,
      head: 'unknown-cli',
      argv: ['unknown-cli', 'status'],
      requirements: base,
      segmentCompleteness: 'complete',
      role: 'canonical',
      trustRecord: null,
    })
    expect(
      applied.requirements.some((entry) =>
        entry.evidence.signals.includes('process.grammar_unknown'),
      ),
    ).toBe(false)
    expect(applied.telemetrySignals).toContain('effect_manifest.matched')
  })

  it('does not replace requirements in telemetry-only role', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-telemetry-'))
    await mkdir(path.dirname(manifestFilePath(repoRoot, 'unknown-cli')), { recursive: true })
    await writeFile(manifestFilePath(repoRoot, 'unknown-cli'), JSON.stringify(manifestFixture))
    const config = mergeConfig({})
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifestFixture, fixtureRule)
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
        trustedRules: [
          { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
        ],
      },
    )
    const base = unsupportedProcess('unknown-cli', 'unknown-cli status', 'process.grammar_unknown')
    const applied = applyEffectManifest({
      repoRoot,
      head: 'unknown-cli',
      argv: ['unknown-cli', 'status'],
      requirements: base,
      segmentCompleteness: 'complete',
      role: 'telemetry-only',
      trustRecord: null,
    })
    expect(applied.requirements).toEqual(base)
    expect(applied.telemetrySignals).toContain('effect_manifest.shadow_candidate_matched')
  })

  it('does not replace parser.disagreement indeterminate', () => {
    const base = unsupportedProcess('unknown-cli', 'unknown-cli status', 'process.grammar_unknown')
    base.push({
      tag: 'indeterminate',
      action: 'indeterminate',
      resource: { kind: 'unknown' },
      evidence: {
        level: 'indeterminate',
        signals: ['parser.disagreement'],
        basis: ['shell_semantic_lowering'],
      },
      provenance: { segment: 'unknown-cli status' },
    })
    const applied = applyEffectManifest({
      repoRoot: '/repo',
      head: 'unknown-cli',
      argv: ['unknown-cli', 'status'],
      requirements: base,
      segmentCompleteness: 'complete',
      role: 'canonical',
      trustRecord: null,
    })
    expect(applied.requirements).toEqual(base)
  })
})

describe('effect manifest shell frontend modes', () => {
  it('keeps shadow canonical identical to legacy when manifest is absent', () => {
    const legacy = lowerShellEffectPlan({
      cwd: '/repo',
      repoRoot: '/repo',
      inputFingerprint: 'fp',
      command: 'unknown-cli status',
      shellFrontendMode: 'legacy',
    })
    const shadow = lowerShellEffectPlan({
      cwd: '/repo',
      repoRoot: '/repo',
      inputFingerprint: 'fp',
      command: 'unknown-cli status',
      shellFrontendMode: 'shadow',
    })
    expect(shadow).toEqual(legacy)
  })

  it('applies manifest in legacy mode lowering', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-legacy-'))
    await mkdir(path.dirname(manifestFilePath(repoRoot, 'unknown-cli')), { recursive: true })
    await writeFile(manifestFilePath(repoRoot, 'unknown-cli'), JSON.stringify(manifestFixture))
    const config = mergeConfig({})
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifestFixture, fixtureRule)
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
        trustedRules: [
          { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
        ],
      },
    )

    const plan = lowerShellEffectPlan({
      cwd: repoRoot,
      repoRoot,
      inputFingerprint: 'fp',
      command: 'unknown-cli status',
      shellFrontendMode: 'legacy',
    })
    const requirements = collectRequirements(plan.root)
    expect(
      requirements.some((entry) => entry.evidence.signals.includes('process.grammar_unknown')),
    ).toBe(false)
    expect(plan.signals).toContain('effect_manifest.matched')
  })
})
