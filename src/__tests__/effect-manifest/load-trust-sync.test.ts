import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
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
import { canonicalPath } from '../../core/path-utils.js'
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
  it('never places trust in a repository-local configured control-plane directory', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-trust-local-'))
    const config = mergeConfig({
      controlPlane: { enabled: false, configDir: path.join(repoRoot, '.belay-control') },
    })
    const recordPath = effectManifestTrustRecordPath(
      config,
      repoLocalStateDirFor(repoRoot, config),
      repoRoot,
      path.join(repoRoot, 'bin', 'unknown-cli'),
    )

    expect(recordPath.startsWith(`${canonicalPath(repoRoot)}${path.sep}`)).toBe(false)
  })

  it('reads trust only from the out-of-repo control-plane dir even when disabled', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-trust-cp-'))
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-cp-state-'))
    const repoConfig = mergeConfig({
      controlPlane: { enabled: false, configDir: controlPlaneDir },
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
    expect(recordPath.startsWith(canonicalPath(controlPlaneDir))).toBe(true)
    expect(recordPath.startsWith(canonicalPath(repoRoot))).toBe(false)
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
      invocationHead: bound.command.canonicalPath,
      decoderHead: 'unknown-cli',
      argv: [bound.command.canonicalPath, 'status'],
      requirements: base,
      segmentCompleteness: 'complete',
      role: 'canonical',
      trustRecord: null,
      belayConfig: repoConfig,
    })
    const withDefaultConfig = applyEffectManifest({
      repoRoot,
      cwd: repoRoot,
      pathEnv: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      invocationHead: bound.command.canonicalPath,
      decoderHead: 'unknown-cli',
      argv: [bound.command.canonicalPath, 'status'],
      requirements: base,
      segmentCompleteness: 'complete',
      role: 'canonical',
      trustRecord: null,
      belayConfig: defaultConfig,
    })

    expect(withRepoConfig.matched).toBe(true)
    expect(withDefaultConfig.matched).toBe(false)
  })

  it('rejects duplicate keys and unknown fields in trust records', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-trust-invalid-'))
    const controlPlaneDir = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-trust-state-'))
    const config = mergeConfig({ controlPlane: { enabled: false, configDir: controlPlaneDir } })
    const executable = path.join(repoRoot, 'tool')
    const recordPath = effectManifestTrustRecordPath(
      config,
      repoLocalStateDirFor(repoRoot, config),
      repoRoot,
      executable,
    )
    await mkdir(path.dirname(recordPath), { recursive: true })
    await writeFile(
      recordPath,
      `{"schemaVersion":1,"schemaVersion":1,"repoRoot":${JSON.stringify(repoRoot)},"manifestPath":${JSON.stringify(path.join(repoRoot, '.belay/manifests/tool.json'))},"commandIdentityFingerprint":"${'a'.repeat(64)}","trustedRules":[]}`,
    )
    expect(loadEffectManifestTrustSync(repoRoot, executable, config)).toBeNull()
  })

  it('binds trust to canonical checkout identity across a symlinked path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belay-manifest-canonical-root-'))
    const repoRoot = path.join(root, 'repo')
    const linkedRoot = path.join(root, 'linked-repo')
    const controlPlaneDir = path.join(root, 'control')
    await mkdir(repoRoot)
    await symlink(repoRoot, linkedRoot, 'dir')
    const config = mergeConfig({ controlPlane: { enabled: false, configDir: controlPlaneDir } })
    const bound = await bindManifestExecutableIdentity(repoRoot, manifestFixture)
    const recordPath = effectManifestTrustRecordPath(
      config,
      repoLocalStateDirFor(linkedRoot, config),
      linkedRoot,
      bound.command.canonicalPath,
    )
    await saveEffectManifestTrustRecord(recordPath, {
      schemaVersion: 1,
      repoRoot: linkedRoot,
      manifestPath: manifestFilePath(linkedRoot, 'unknown-cli'),
      commandIdentityFingerprint: commandIdentityFingerprint(bound.command),
      trustedRules: [],
    })

    expect(
      loadEffectManifestTrustSync(repoRoot, bound.command.canonicalPath, config),
    ).toMatchObject({
      repoRoot: canonicalPath(repoRoot),
    })
  })
})
