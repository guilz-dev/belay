import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { doctorProject } from '../commands/doctor.js'
import { dogfoodProject } from '../commands/dogfood.js'
import { statusProject } from '../commands/status.js'
import { loadConfigFile, runtimeCorePath } from '../config-io.js'
import { mergeConfig } from '../core/config.js'
import { canonicalStringify, hashValue } from '../core/fingerprint.js'
import { initProject } from '../installer.js'
import { loadOperationalInsights } from '../operational-insights.js'

const tempDirs: string[] = []

function auditAllowLine(provenance: {
  runtimeBuildStamp: string
  configFingerprint: string
}): string {
  return `${JSON.stringify({
    event: 'beforeShellExecution',
    kind: 'shell',
    verdict: 'allow',
    reason: 'read_only',
    wouldBlock: false,
    mode: 'audit',
    ...provenance,
  })}\n`
}

function auditWouldBlockLine(provenance: {
  runtimeBuildStamp: string
  configFingerprint: string
}): string {
  return `${JSON.stringify({
    event: 'beforeShellExecution',
    kind: 'shell',
    verdict: 'deny_pending_approval',
    reason: 'unknown_local_effect',
    wouldBlock: true,
    mode: 'audit',
    ...provenance,
  })}\n`
}

async function activeAuditProvenance(
  repoRoot: string,
): Promise<{ runtimeBuildStamp: string; configFingerprint: string }> {
  const runtime = await readFile(runtimeCorePath(repoRoot), 'utf8')
  const runtimeBuildStamp = runtime.match(/RUNTIME_BUILD_STAMP\s*=\s*"([^"]+)"/)?.[1]
  if (!runtimeBuildStamp) {
    throw new Error('test runtime is missing RUNTIME_BUILD_STAMP')
  }
  const config = await loadConfigFile(repoRoot)
  return {
    runtimeBuildStamp,
    configFingerprint: hashValue(canonicalStringify(config)),
  }
}

async function seedDogfoodEnforceReady(repoRoot: string): Promise<void> {
  const installedConfig = JSON.parse(
    await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
  )
  const config = mergeConfig({
    ...installedConfig,
    mode: 'audit',
    policy: {
      ...installedConfig.policy,
      unknownLocalEffect: 'deny',
      unparseableShell: 'deny',
    },
    controlPlane: {
      enabled: false,
      configDir: null,
      integrity: 'none',
    },
    audit: { logPath: '.cursor/belay/audit.ndjson', includeAssessment: true },
  })
  await writeFile(
    path.join(repoRoot, '.cursor', 'belay.config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  const provenance = await activeAuditProvenance(repoRoot)
  await writeFile(path.join(repoRoot, config.audit.logPath), auditAllowLine(provenance).repeat(20))
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('dogfood command', () => {
  it('init --preset l1-full-recommended --dogfood keeps preset layers but sets audit mode', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-preset-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, preset: 'l1-full-recommended', dogfood: true })

    const config = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    expect(config.mode).toBe('audit')
    expect(config.sandbox.enabled).toBe(true)
    expect(config.egress.enabled).toBe(true)
    expect(config.approvalSigning.required).toBe(true)
    expect(config.controlPlane.isolation.mode).toBe('separate-user')
    expect(config.policy.unknownLocalEffect).toBe('deny')
    expect(config.controlPlane.spikeOnPrompt).toBeUndefined()
  })

  it('enables audit mode with fail-closed policy', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const result = await dogfoodProject({ targetDir: repoRoot })
    expect(result.ok, result.message).toBe(true)
    expect(result.mode).toBe('audit')
    expect(result.unknownLocalEffect).toBe('deny')

    const config = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    expect(config.mode).toBe('audit')
    expect(config.policy.unknownLocalEffect).toBe('deny')
  })

  it('promotes to enforce when metrics are ready', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-enforce-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await seedDogfoodEnforceReady(repoRoot)

    const result = await dogfoodProject({ targetDir: repoRoot, enforce: true })
    expect(result.ok, result.message).toBe(true)
    expect(result.mode).toBe('enforce')

    const config = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    expect(config.mode).toBe('enforce')
  })

  it('does not promote from clean events recorded by an older runtime', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-old-runtime-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    const installedConfig = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    const config = mergeConfig({
      ...installedConfig,
      mode: 'audit',
      policy: { ...installedConfig.policy, unknownLocalEffect: 'deny' },
    })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
    )
    await writeFile(
      path.join(repoRoot, config.audit.logPath),
      auditAllowLine({
        runtimeBuildStamp: '0.7.0@2026-08-11T23:28:49.254Z',
        configFingerprint: hashValue(canonicalStringify(config)),
      }).repeat(20),
    )

    const result = await dogfoodProject({ targetDir: repoRoot, enforce: true })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('No gate events for the active runtime/config cohort')
  })

  it('refuses enforce until metrics are ready unless forced', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-force-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })

    const blocked = await dogfoodProject({ targetDir: repoRoot, enforce: true })
    expect(blocked.ok).toBe(false)
    expect(blocked.message).toContain('EffectPlan semantics')
    expect(blocked.message).toContain('resource scope')
    expect(blocked.message).not.toContain('overrides.allow')

    const forced = await dogfoodProject({ targetDir: repoRoot, enforce: true, force: true })
    expect(forced.ok).toBe(true)
    expect(forced.mode).toBe('enforce')
  })

  it('surfaces dogfood status without OQ3 spike fields', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-status-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    await dogfoodProject({ targetDir: repoRoot })
    await writeFile(
      path.join(repoRoot, '.cursor', 'belay.config.json'),
      `${JSON.stringify(
        mergeConfig({
          mode: 'audit',
          policy: { unknownLocalEffect: 'deny' },
        }),
        null,
        2,
      )}\n`,
    )

    const status = await statusProject({ targetDir: repoRoot })
    expect(status.dogfood.active).toBe(true)
    expect('oq3Spike' in status).toBe(false)

    const insights = await loadOperationalInsights({ targetDir: repoRoot })
    expect(insights.dogfood.active).toBe(true)
    expect('oq3Spike' in insights).toBe(false)
  })

  it('surfaces only active-cohort evidence in dogfood status and doctor', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-cohort-status-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await seedDogfoodEnforceReady(repoRoot)
    const config = await loadConfigFile(repoRoot)
    await appendFile(
      path.join(repoRoot, config.audit.logPath),
      auditWouldBlockLine({
        runtimeBuildStamp: '0.7.0@2026-08-11T23:28:49.254Z',
        configFingerprint: 'old-config-fingerprint',
      }).repeat(21),
    )

    const status = await statusProject({ targetDir: repoRoot })
    const doctor = await doctorProject({ targetDir: repoRoot })

    expect(status.dogfood.gateEvents).toBe(20)
    expect(status.dogfood.wouldBlockCount).toBe(0)
    expect(status.dogfood.excludedGateEvents).toBe(21)
    expect(doctor.dogfood?.gateEvents).toBe(20)
    expect(doctor.dogfood?.excludedGateEvents).toBe(21)
    expect(doctor.warnings.some((warning) => warning.includes('Silent-pass rate'))).toBe(false)
  })
})
