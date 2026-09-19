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

async function writeBoundManifest(
  repoRoot: string,
  manifest: typeof manifestFixture = manifestFixture,
) {
  const bound = await bindManifestExecutableIdentity(repoRoot, manifest)
  await mkdir(path.dirname(manifestFilePath(repoRoot, bound.command.basename)), { recursive: true })
  await writeFile(manifestFilePath(repoRoot, bound.command.basename), JSON.stringify(bound))
  return bound
}

async function withBinOnPath<T>(repoRoot: string, run: () => Promise<T> | T): Promise<T> {
  const binDir = path.join(repoRoot, 'bin')
  const previous = process.env.PATH
  process.env.PATH = `${binDir}${path.delimiter}${previous ?? ''}`
  try {
    return await run()
  } finally {
    process.env.PATH = previous
  }
}

function manifestGateParams(
  repoRoot: string,
  params: Omit<
    Parameters<typeof applyEffectManifest>[0],
    'repoRoot' | 'cwd' | 'pathEnv' | 'gateConsumptionEnabled'
  > & { gateConsumptionEnabled?: boolean },
) {
  const binDir = path.join(repoRoot, 'bin')
  return {
    repoRoot,
    cwd: repoRoot,
    pathEnv: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    gateConsumptionEnabled: params.gateConsumptionEnabled ?? true,
    ...params,
  }
}

function lowerWithManifestGate(
  repoRoot: string,
  params: Parameters<typeof lowerShellEffectPlan>[0],
) {
  return lowerShellEffectPlan({
    ...params,
    cwd: params.cwd ?? repoRoot,
    effectManifestGateConsumptionEnabled: true,
  })
}

describe('applyEffectManifest', () => {
  it('replaces grammar_unknown only for trusted rules on canonical role', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = mergeConfig({})
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
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
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        head: 'unknown-cli',
        argv: ['unknown-cli', 'status'],
        requirements: base,
        segmentCompleteness: 'complete',
        role: 'canonical',
        trustRecord: null,
      }),
    )
    expect(
      applied.requirements.some((entry) =>
        entry.evidence.signals.includes('process.grammar_unknown'),
      ),
    ).toBe(false)
    expect(applied.matched).toBe(true)
    expect(applied.telemetrySignals).toContain('effect_manifest.matched')
    expect(applied.audit?.outcome).toBe('matched')
  })

  it('does not replace requirements in telemetry-only role', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-telemetry-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = mergeConfig({})
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
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
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        head: 'unknown-cli',
        argv: ['unknown-cli', 'status'],
        requirements: base,
        segmentCompleteness: 'complete',
        role: 'telemetry-only',
        trustRecord: null,
      }),
    )
    expect(applied.matched).toBe(false)
    expect(applied.requirements).toEqual(base)
    expect(applied.telemetrySignals).toContain('effect_manifest.shadow_candidate_matched')
  })

  it('rejects a manifest whose basename does not match the command head', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-basename-'))
    await mkdir(path.dirname(manifestFilePath(repoRoot, 'unknown-cli')), { recursive: true })
    await writeFile(
      manifestFilePath(repoRoot, 'unknown-cli'),
      JSON.stringify({
        ...manifestFixture,
        command: { ...manifestFixture.command, basename: 'other-cli' },
      }),
    )
    const base = unsupportedProcess('unknown-cli', 'unknown-cli status', 'process.grammar_unknown')
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        head: 'unknown-cli',
        argv: ['unknown-cli', 'status'],
        requirements: base,
        segmentCompleteness: 'complete',
        role: 'canonical',
        trustRecord: null,
      }),
    )
    expect(applied.matched).toBe(false)
    expect(applied.audit?.reason).toBe('basename_mismatch')
  })

  it('refuses trusted rules when executable identity no longer matches', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-identity-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = mergeConfig({})
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
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
    await writeFile(manifest.command.canonicalPath, 'mutated\n')
    const base = unsupportedProcess('unknown-cli', 'unknown-cli status', 'process.grammar_unknown')
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        head: 'unknown-cli',
        argv: ['unknown-cli', 'status'],
        requirements: base,
        segmentCompleteness: 'complete',
        role: 'canonical',
        trustRecord: null,
      }),
    )
    expect(applied.matched).toBe(false)
    expect(applied.audit?.reason).toBe('executable_identity_mismatch')
  })

  it('does not apply trusted rules when gate consumption is disabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-gate-off-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = mergeConfig({})
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
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
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        head: 'unknown-cli',
        argv: ['unknown-cli', 'status'],
        requirements: base,
        segmentCompleteness: 'complete',
        role: 'canonical',
        trustRecord: null,
        gateConsumptionEnabled: false,
      }),
    )
    expect(applied.matched).toBe(false)
    expect(applied.requirements).toEqual(base)
  })

  it('rejects trusted rules when invocation resolves to a different executable', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-invocation-'))
    const manifest = await writeBoundManifest(repoRoot)
    const evilDir = path.join(repoRoot, 'evil')
    await mkdir(evilDir, { recursive: true })
    await writeFile(path.join(evilDir, 'unknown-cli'), 'evil\n', { mode: 0o755 })
    const config = mergeConfig({})
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
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
    const base = unsupportedProcess(
      './evil/unknown-cli',
      './evil/unknown-cli status',
      'process.grammar_unknown',
    )
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        head: './evil/unknown-cli',
        argv: ['./evil/unknown-cli', 'status'],
        requirements: base,
        segmentCompleteness: 'complete',
        role: 'canonical',
        trustRecord: null,
      }),
    )
    expect(applied.matched).toBe(false)
    expect(applied.audit?.reason).toBe('invocation_identity_mismatch')
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
    const applied = applyEffectManifest(
      manifestGateParams('/repo', {
        head: 'unknown-cli',
        argv: ['unknown-cli', 'status'],
        requirements: base,
        segmentCompleteness: 'complete',
        role: 'canonical',
        trustRecord: null,
      }),
    )
    expect(applied.matched).toBe(false)
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
    expect(collectRequirements(shadow.root)).toEqual(collectRequirements(legacy.root))
  })

  it('applies manifest in legacy mode lowering', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-legacy-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = mergeConfig({})
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
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

    const plan = await withBinOnPath(repoRoot, () =>
      lowerWithManifestGate(repoRoot, {
        cwd: repoRoot,
        repoRoot,
        inputFingerprint: 'fp',
        command: 'unknown-cli status',
        shellFrontendMode: 'legacy',
      }),
    )
    const requirements = collectRequirements(plan.root)
    expect(
      requirements.some((entry) => entry.evidence.signals.includes('process.grammar_unknown')),
    ).toBe(false)
    expect(plan.signals).toContain('effect_manifest.matched')
    expect(plan.effectManifestAudits?.[0]?.outcome).toBe('matched')
  })

  it('keeps shadow candidate manifest telemetry off the canonical plan', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-shadow-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = mergeConfig({})
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
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

    const legacy = await withBinOnPath(repoRoot, () =>
      lowerWithManifestGate(repoRoot, {
        cwd: repoRoot,
        repoRoot,
        inputFingerprint: 'fp',
        command: 'unknown-cli status',
        shellFrontendMode: 'legacy',
      }),
    )
    const shadow = await withBinOnPath(repoRoot, () =>
      lowerWithManifestGate(repoRoot, {
        cwd: repoRoot,
        repoRoot,
        inputFingerprint: 'fp',
        command: 'unknown-cli status',
        shellFrontendMode: 'shadow',
      }),
    )
    expect(collectRequirements(shadow.root)).toEqual(collectRequirements(legacy.root))
    expect(shadow.signals).toContain('effect_manifest.matched')
    expect(shadow.signals).toContain('effect_manifest.shadow_candidate_matched')
  })

  it('records canary disagreement when legacy resolves a trusted manifest but mvdan does not', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-canary-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = mergeConfig({})
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
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

    const legacy = await withBinOnPath(repoRoot, () =>
      lowerWithManifestGate(repoRoot, {
        cwd: repoRoot,
        repoRoot,
        inputFingerprint: 'fp',
        command: 'unknown-cli status',
        shellFrontendMode: 'legacy',
      }),
    )
    const canary = await withBinOnPath(repoRoot, () =>
      lowerWithManifestGate(repoRoot, {
        cwd: repoRoot,
        repoRoot,
        inputFingerprint: 'fp',
        command: 'unknown-cli status',
        shellFrontendMode: 'canary',
      }),
    )
    expect(
      collectRequirements(legacy.root).some((entry) =>
        entry.evidence.signals.includes('process.grammar_unknown'),
      ),
    ).toBe(false)
    expect(canary.signals).toContain('parser.disagreement')
    expect(canary.signals).not.toContain('effect_manifest.matched')
    expect(canary.signals).toContain('parser.artifact_unavailable')
  })
})
