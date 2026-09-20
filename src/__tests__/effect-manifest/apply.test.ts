import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { repoLocalStateDirFor } from '../../config-io.js'
import { mergeConfig } from '../../core/config.js'
import { collectRequirements } from '../../core/effect-ir/build.js'
import { unsupportedProcess } from '../../core/effect-ir/shell-lower/requirement.js'
import { lowerShellEffectPlan } from '../../core/effect-ir/shell-lower.js'
import { applyEffectManifest } from '../../core/effect-manifest/apply.js'
import { ruleFingerprint } from '../../core/effect-manifest/codec.js'
import { commandIdentityFingerprint } from '../../core/effect-manifest/command-identity.js'
import { manifestFilePath } from '../../core/effect-manifest/paths.js'
import {
  effectManifestTrustRecordPath,
  saveEffectManifestTrustRecord,
} from '../../core/effect-manifest/trust-store.js'
import type { EffectManifestV1 } from '../../core/effect-manifest/types.js'
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

async function writeBoundManifest(repoRoot: string, manifest: EffectManifestV1 = manifestFixture) {
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
  params: Omit<Parameters<typeof applyEffectManifest>[0], 'repoRoot' | 'cwd' | 'pathEnv'>,
) {
  const binDir = path.join(repoRoot, 'bin')
  return {
    repoRoot,
    cwd: repoRoot,
    pathEnv: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    belayConfig: manifestConfig(repoRoot),
    ...params,
  }
}

function lowerWithManifestGate(
  repoRoot: string,
  params: Parameters<typeof lowerShellEffectPlan>[0],
  config = mergeConfig({}),
) {
  return lowerShellEffectPlan({
    ...params,
    cwd: params.cwd ?? repoRoot,
    belayConfig: config,
  })
}

function manifestConfig(repoRoot: string) {
  return mergeConfig({
    controlPlane: {
      enabled: false,
      configDir: path.join(os.tmpdir(), 'belay-test-control-plane', path.basename(repoRoot)),
    },
  })
}

describe('applyEffectManifest', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })
  it('replaces grammar_unknown only for trusted rules on canonical role', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = manifestConfig(repoRoot)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
        ],
      },
    )

    const base = unsupportedProcess('unknown-cli', 'unknown-cli status', 'process.grammar_unknown')
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        invocationHead: 'unknown-cli',
        decoderHead: 'unknown-cli',
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

  it('instantiates typed captures and resolves relative paths against the segment cwd', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-capture-'))
    const actionCwd = path.join(repoRoot, 'nested')
    await mkdir(actionCwd)
    const capturedManifest: EffectManifestV1 = {
      ...manifestFixture,
      rules: [
        {
          ...fixtureRule,
          id: 'captured-path',
          matcher: {
            argv: [
              { kind: 'literal', value: 'write' },
              { kind: 'path', name: 'target' },
            ],
          },
          contract: {
            processOperation: 'inspect',
            effects: [
              {
                tag: 'fs.write',
                action: 'fs.write',
                resource: { kind: 'path', path: `\${target}` },
              },
            ],
          },
        },
      ],
    }
    const manifest = await writeBoundManifest(repoRoot, capturedManifest)
    const rule = manifest.rules[0]
    if (!rule) {
      throw new Error('rule missing')
    }
    const config = manifestConfig(repoRoot)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(
        config,
        repoLocalStateDirFor(repoRoot, config),
        repoRoot,
        manifest.command.canonicalPath,
      ),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          {
            id: rule.id,
            ruleFingerprint: ruleFingerprint(manifest, rule),
            trustedAt: '2026-09-19T00:00:00Z',
          },
        ],
      },
    )
    const base = unsupportedProcess(
      'unknown-cli',
      'unknown-cli write output.txt',
      'process.grammar_unknown',
    )
    const applied = applyEffectManifest({
      ...manifestGateParams(repoRoot, {
        invocationHead: 'unknown-cli',
        decoderHead: 'unknown-cli',
        argv: ['unknown-cli', 'write', 'output.txt'],
        requirements: base,
        segmentCompleteness: 'complete',
        role: 'canonical',
        trustRecord: null,
      }),
      cwd: actionCwd,
    })
    expect(applied.matched).toBe(true)
    expect(applied.requirements).toContainEqual(
      expect.objectContaining({
        action: 'fs.write',
        resource: { kind: 'path', path: path.join(actionCwd, 'output.txt') },
      }),
    )
  })

  it('does not replace requirements in telemetry-only role', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-telemetry-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = manifestConfig(repoRoot)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
        ],
      },
    )
    const base = unsupportedProcess('unknown-cli', 'unknown-cli status', 'process.grammar_unknown')
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        invocationHead: 'unknown-cli',
        decoderHead: 'unknown-cli',
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

  it('skips manifest work when the shell analysis deadline has passed', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-deadline-'))
    await writeBoundManifest(repoRoot)
    const base = unsupportedProcess('unknown-cli', 'unknown-cli status', 'process.grammar_unknown')
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        invocationHead: 'unknown-cli',
        decoderHead: 'unknown-cli',
        argv: ['unknown-cli', 'status'],
        requirements: base,
        segmentCompleteness: 'complete',
        role: 'canonical',
        trustRecord: null,
        effectManifestAnalysisDeadlineMs: Date.now() - 1,
      }),
    )
    expect(applied.matched).toBe(false)
    expect(applied.requirements).toEqual(base)
    expect(applied.telemetrySignals).toEqual([])
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
        invocationHead: 'unknown-cli',
        decoderHead: 'unknown-cli',
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
    const config = manifestConfig(repoRoot)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
        ],
      },
    )
    await writeFile(manifest.command.canonicalPath, 'mutated\n')
    const base = unsupportedProcess('unknown-cli', 'unknown-cli status', 'process.grammar_unknown')
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        invocationHead: 'unknown-cli',
        decoderHead: 'unknown-cli',
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

  it('uses trusted rules without a separate configuration switch', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-gate-off-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = manifestConfig(repoRoot)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
        ],
      },
    )
    const base = unsupportedProcess('unknown-cli', 'unknown-cli status', 'process.grammar_unknown')
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        invocationHead: 'unknown-cli',
        decoderHead: 'unknown-cli',
        argv: ['unknown-cli', 'status'],
        requirements: base,
        segmentCompleteness: 'complete',
        role: 'canonical',
        trustRecord: null,
      }),
    )
    expect(applied.matched).toBe(true)
    expect(applied.requirements).not.toEqual(base)
  })

  it('fails closed when the deadline expires during identity work', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-mid-deadline-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = manifestConfig(repoRoot)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          {
            id: 'argv-test',
            ruleFingerprint: ruleFingerprint(manifest, fixtureRule),
            trustedAt: '2026-09-19T00:00:00Z',
          },
        ],
      },
    )
    vi.spyOn(Date, 'now').mockReturnValueOnce(99).mockReturnValue(101)
    const base = unsupportedProcess('unknown-cli', 'unknown-cli status', 'process.grammar_unknown')
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        invocationHead: 'unknown-cli',
        decoderHead: 'unknown-cli',
        argv: ['unknown-cli', 'status'],
        requirements: base,
        segmentCompleteness: 'complete',
        role: 'canonical',
        trustRecord: null,
        effectManifestAnalysisDeadlineMs: 100,
      }),
    )
    expect(applied.matched).toBe(false)
    expect(applied.requirements).toEqual(base)
    expect(applied.audit?.reason).toBe('deadline_exceeded')
  })

  it('rejects trusted rules when invocation resolves to a different executable', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-invocation-'))
    const manifest = await writeBoundManifest(repoRoot)
    const evilDir = path.join(repoRoot, 'evil')
    await mkdir(evilDir, { recursive: true })
    await writeFile(path.join(evilDir, 'unknown-cli'), 'evil\n', { mode: 0o755 })
    const config = manifestConfig(repoRoot)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
        ],
      },
    )
    const base = unsupportedProcess(
      'unknown-cli',
      './evil/unknown-cli status',
      'process.grammar_unknown',
    )
    const applied = applyEffectManifest(
      manifestGateParams(repoRoot, {
        invocationHead: './evil/unknown-cli',
        decoderHead: 'unknown-cli',
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
        invocationHead: 'unknown-cli',
        decoderHead: 'unknown-cli',
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
    expect(legacy.effectManifestAudits?.[0]?.reason).toBe('no_manifest')
  })

  it('applies manifest in legacy mode lowering', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-legacy-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = manifestConfig(repoRoot)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
        ],
      },
    )

    const plan = await withBinOnPath(repoRoot, () =>
      lowerWithManifestGate(
        repoRoot,
        {
          cwd: repoRoot,
          repoRoot,
          inputFingerprint: 'fp',
          command: 'unknown-cli status',
          shellFrontendMode: 'legacy',
        },
        config,
      ),
    )
    const requirements = collectRequirements(plan.root)
    expect(
      requirements.some((entry) => entry.evidence.signals.includes('process.grammar_unknown')),
    ).toBe(false)
    expect(plan.signals).toContain('effect_manifest.matched')
    expect(plan.effectManifestAudits?.[0]?.outcome).toBe('matched')
  })

  it('uses the command-local PATH when resolving executable identity', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-local-path-'))
    const manifest = await writeBoundManifest(repoRoot)
    const evilDir = path.join(repoRoot, 'evil-bin')
    await mkdir(evilDir)
    await writeFile(path.join(evilDir, 'unknown-cli'), 'evil\n', { mode: 0o755 })
    const config = manifestConfig(repoRoot)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          {
            id: 'argv-test',
            ruleFingerprint: ruleFingerprint(manifest, fixtureRule),
            trustedAt: '2026-09-19T00:00:00Z',
          },
        ],
      },
    )

    const plan = lowerWithManifestGate(
      repoRoot,
      {
        cwd: repoRoot,
        repoRoot,
        inputFingerprint: 'fp',
        command: `PATH=${evilDir} unknown-cli status`,
        shellFrontendMode: 'legacy',
        env: { PATH: `${path.join(repoRoot, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` },
      },
      config,
    )
    expect(
      collectRequirements(plan.root).some((entry) =>
        entry.evidence.signals.includes('process.grammar_unknown'),
      ),
    ).toBe(true)
    expect(plan.effectManifestAudits?.[0]?.reason).toBe('invocation_identity_mismatch')
  })

  it('resolves relative effect paths against a cwd changed by an earlier segment', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-segment-cwd-'))
    const nested = path.join(repoRoot, 'nested')
    await mkdir(nested)
    const withWrite: EffectManifestV1 = {
      ...manifestFixture,
      rules: [
        {
          ...fixtureRule,
          contract: {
            processOperation: 'inspect',
            effects: [
              {
                tag: 'fs.write',
                action: 'fs.write',
                resource: { kind: 'path', path: 'output.txt' },
              },
            ],
          },
        },
      ],
    }
    const manifest = await writeBoundManifest(repoRoot, withWrite)
    const rule = manifest.rules[0]
    if (!rule) {
      throw new Error('rule missing')
    }
    const config = manifestConfig(repoRoot)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(
        config,
        repoLocalStateDirFor(repoRoot, config),
        repoRoot,
        manifest.command.canonicalPath,
      ),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          {
            id: rule.id,
            ruleFingerprint: ruleFingerprint(manifest, rule),
            trustedAt: '2026-09-19T00:00:00Z',
          },
        ],
      },
    )

    const plan = await withBinOnPath(repoRoot, () =>
      lowerWithManifestGate(
        repoRoot,
        {
          cwd: repoRoot,
          repoRoot,
          inputFingerprint: 'fp',
          command: 'cd nested && unknown-cli status',
          shellFrontendMode: 'legacy',
        },
        config,
      ),
    )
    expect(collectRequirements(plan.root)).toContainEqual(
      expect.objectContaining({
        action: 'fs.write',
        resource: { kind: 'path', path: path.join(nested, 'output.txt') },
      }),
    )
  })

  it('does not relabel legacy manifest work as an unavailable mvdan shadow candidate', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-shadow-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = manifestConfig(repoRoot)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
        ],
      },
    )

    const legacy = await withBinOnPath(repoRoot, () =>
      lowerWithManifestGate(
        repoRoot,
        {
          cwd: repoRoot,
          repoRoot,
          inputFingerprint: 'fp',
          command: 'unknown-cli status',
          shellFrontendMode: 'legacy',
        },
        config,
      ),
    )
    const shadow = await withBinOnPath(repoRoot, () =>
      lowerWithManifestGate(
        repoRoot,
        {
          cwd: repoRoot,
          repoRoot,
          inputFingerprint: 'fp',
          command: 'unknown-cli status',
          shellFrontendMode: 'shadow',
        },
        config,
      ),
    )
    expect(collectRequirements(shadow.root)).toEqual(collectRequirements(legacy.root))
    expect(shadow.signals).toContain('effect_manifest.matched')
    expect(shadow.signals).not.toContain('effect_manifest.shadow_candidate_matched')
    expect(shadow.effectManifestAudits?.every((audit) => audit.frontendId === 'legacy-v1')).toBe(
      true,
    )
  })

  it('records canary disagreement when legacy resolves a trusted manifest but mvdan does not', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-canary-'))
    const manifest = await writeBoundManifest(repoRoot)
    const config = manifestConfig(repoRoot)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
        ],
      },
    )

    const legacy = await withBinOnPath(repoRoot, () =>
      lowerWithManifestGate(
        repoRoot,
        {
          cwd: repoRoot,
          repoRoot,
          inputFingerprint: 'fp',
          command: 'unknown-cli status',
          shellFrontendMode: 'legacy',
        },
        config,
      ),
    )
    const canary = await withBinOnPath(repoRoot, () =>
      lowerWithManifestGate(
        repoRoot,
        {
          cwd: repoRoot,
          repoRoot,
          inputFingerprint: 'fp',
          command: 'unknown-cli status',
          shellFrontendMode: 'canary',
        },
        config,
      ),
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

  it('does not apply trusted manifests when invocation resolves outside the repo bin', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-shell-evil-'))
    const manifest = await writeBoundManifest(repoRoot)
    const evilDir = path.join(repoRoot, 'evil')
    await mkdir(evilDir, { recursive: true })
    await writeFile(path.join(evilDir, 'unknown-cli'), 'evil\n', { mode: 0o755 })
    const config = manifestConfig(repoRoot)
    const stateDir = repoLocalStateDirFor(repoRoot, config)
    const ruleFp = ruleFingerprint(manifest, fixtureRule)
    await saveEffectManifestTrustRecord(
      effectManifestTrustRecordPath(config, stateDir, repoRoot, manifest.command.canonicalPath),
      {
        schemaVersion: 1,
        repoRoot,
        manifestPath: manifestFilePath(repoRoot, 'unknown-cli'),
        commandIdentityFingerprint: commandIdentityFingerprint(manifest.command),
        trustedRules: [
          { id: 'argv-test', ruleFingerprint: ruleFp, trustedAt: '2026-09-19T00:00:00Z' },
        ],
      },
    )

    const plan = await withBinOnPath(repoRoot, () =>
      lowerWithManifestGate(
        repoRoot,
        {
          cwd: repoRoot,
          repoRoot,
          inputFingerprint: 'fp',
          command: './evil/unknown-cli status',
          shellFrontendMode: 'legacy',
        },
        config,
      ),
    )
    expect(
      collectRequirements(plan.root).some((entry) =>
        entry.evidence.signals.includes('process.grammar_unknown'),
      ),
    ).toBe(true)
    expect(plan.signals).not.toContain('effect_manifest.matched')
  })
})
