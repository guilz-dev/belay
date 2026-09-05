import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'
import { loadAuditRecords } from '../commands/audit.js'
import { doctorProject } from '../commands/doctor.js'
import { dogfoodProject } from '../commands/dogfood.js'
import { checkDogfoodProject } from '../commands/dogfood-check.js'
import { statusProject } from '../commands/status.js'
import { loadConfigFile, runtimeCorePath } from '../config-io.js'
import { mergeConfig } from '../core/config.js'
import { canonicalStringify, hashValue } from '../core/fingerprint.js'
import { initProject } from '../installer.js'
import { loadOperationalInsights } from '../operational-insights.js'

const tempDirs: string[] = []
const execFileAsync = promisify(execFile)

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

function auditRecordLine(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

async function writeAuditLines(repoRoot: string, lines: string): Promise<void> {
  const config = await loadConfigFile(repoRoot)
  await writeFile(path.join(repoRoot, config.audit.logPath), lines)
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

describe('dogfood release check', () => {
  it('loads audit records for the explicitly selected adapter', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-adapter-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, adapter: 'cursor', dogfood: true })
    await initProject({ targetDir: repoRoot, adapter: 'claude', dogfood: true })
    const cursorConfig = await loadConfigFile(repoRoot, 'cursor')
    const claudeConfig = await loadConfigFile(repoRoot, 'claude')
    await writeFile(
      path.join(repoRoot, cursorConfig.audit.logPath),
      auditRecordLine({ timestamp: new Date().toISOString(), event: 'cursor-only' }),
    )
    await writeFile(
      path.join(repoRoot, claudeConfig.audit.logPath),
      auditRecordLine({ timestamp: new Date().toISOString(), event: 'claude-only' }),
    )

    const records = await loadAuditRecords(repoRoot, 'claude')

    expect(records.map((record) => record.event)).toEqual(['claude-only'])
  })

  it('fails with invalid_since when --since is not ISO8601', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-bad-since-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })

    const result = await checkDogfoodProject({ targetDir: repoRoot, since: 'yesterday' })
    expect(result.ok).toBe(false)
    expect(result.failures).toContain('invalid_since')
  })

  it('fails with dogfood_inactive when audit+deny mode is not active', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-inactive-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })

    const result = await checkDogfoodProject({ targetDir: repoRoot, since: isoMinutesAgo(5) })
    expect(result.ok).toBe(false)
    expect(result.failures).toContain('dogfood_inactive')
  })

  it('fails when zero gate events exist since cutoff', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-empty-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    const provenance = await activeAuditProvenance(repoRoot)
    await writeAuditLines(
      repoRoot,
      auditRecordLine({
        timestamp: isoMinutesAgo(30),
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
        permission: 'allow',
        reason: 'read_only',
        mode: 'audit',
        ...provenance,
      }),
    )

    const result = await checkDogfoodProject({ targetDir: repoRoot, since: isoMinutesAgo(1) })
    expect(result.ok).toBe(false)
    expect(result.gateEvents).toBe(0)
    expect(result.failures).toContain('no_gate_events_since_cutoff')
  })

  it('fails when audit-mode records contain permission deny', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-audit-deny-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    const provenance = await activeAuditProvenance(repoRoot)
    await writeAuditLines(
      repoRoot,
      auditRecordLine({
        timestamp: isoMinutesAgo(1),
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        permission: 'deny',
        reason: 'unknown_local_effect',
        mode: 'audit',
        ...provenance,
      }),
    )

    const result = await checkDogfoodProject({ targetDir: repoRoot, since: isoMinutesAgo(5) })
    expect(result.ok).toBe(false)
    expect(result.auditModeDenyCount).toBe(1)
    expect(result.failures).toContain('audit_mode_permission_deny')
  })

  it('fails when host denied-after-allow exists in window', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-host-deny-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    const provenance = await activeAuditProvenance(repoRoot)
    const invocation = 'aaaaaaaaaaaaaaaa'
    await writeAuditLines(
      repoRoot,
      [
        auditRecordLine({
          timestamp: isoMinutesAgo(2),
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'allow',
          permission: 'allow',
          reason: 'read_only',
          mode: 'audit',
          toolInvocationCorrelationId: invocation,
          ...provenance,
        }),
        auditRecordLine({
          timestamp: isoMinutesAgo(1),
          event: 'postToolUseFailure',
          failureType: 'permission_denied',
          errorMessage: 'EPERM',
          toolInvocationCorrelationId: invocation,
          ...provenance,
        }),
      ].join(''),
    )

    const result = await checkDogfoodProject({ targetDir: repoRoot, since: isoMinutesAgo(5) })
    expect(result.ok).toBe(false)
    expect(result.hostDeniedAfterAllowCount).toBe(1)
    expect(result.failures).toContain('host_denied_after_allow')
  })

  it('fails when shell gate records are emitted as preToolUse', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-shell-tool-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    const provenance = await activeAuditProvenance(repoRoot)
    await writeAuditLines(
      repoRoot,
      auditRecordLine({
        timestamp: isoMinutesAgo(1),
        event: 'preToolUse',
        kind: 'shell',
        verdict: 'allow',
        permission: 'allow',
        reason: 'read_only',
        mode: 'audit',
        ...provenance,
      }),
    )

    const result = await checkDogfoodProject({ targetDir: repoRoot, since: isoMinutesAgo(5) })
    expect(result.ok).toBe(false)
    expect(result.shellPreToolUseCount).toBe(1)
    expect(result.failures).toContain('shell_event_recorded_as_preToolUse')
  })

  it('fails when in-window gate events include a mismatched cohort', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-cohort-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    const provenance = await activeAuditProvenance(repoRoot)
    await writeAuditLines(
      repoRoot,
      [
        auditRecordLine({
          timestamp: isoMinutesAgo(2),
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'allow',
          permission: 'allow',
          reason: 'read_only',
          mode: 'audit',
          ...provenance,
        }),
        auditRecordLine({
          timestamp: isoMinutesAgo(1),
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'allow',
          permission: 'allow',
          reason: 'read_only',
          mode: 'audit',
          runtimeBuildStamp: '0.0.0@old',
          configFingerprint: provenance.configFingerprint,
        }),
      ].join(''),
    )

    const result = await checkDogfoodProject({ targetDir: repoRoot, since: isoMinutesAgo(5) })
    expect(result.ok).toBe(false)
    expect(result.mismatchedCohortCount).toBe(1)
    expect(result.failures).toContain('mismatched_active_cohort')
  })

  it('fails when linked worktrees are missing dogfood config', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-worktree-'))
    const linkedParent = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-linked-'))
    const linkedWorktree = path.join(linkedParent, 'linked-worktree')
    tempDirs.push(repoRoot, linkedParent)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await writeFile(path.join(repoRoot, 'README.md'), '# root\n')
    await execFileAsync('git', ['init', '--quiet'], { cwd: repoRoot })
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=belay-test',
        '-c',
        'user.email=belay-test@example.com',
        'commit',
        '-m',
        'init',
      ],
      { cwd: repoRoot },
    )
    await execFileAsync('git', ['worktree', 'add', linkedWorktree, '-b', 'linked-check'], {
      cwd: repoRoot,
    })
    const provenance = await activeAuditProvenance(repoRoot)
    await writeAuditLines(
      repoRoot,
      auditRecordLine({
        timestamp: isoMinutesAgo(1),
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
        permission: 'allow',
        reason: 'read_only',
        mode: 'audit',
        ...provenance,
      }),
    )

    const result = await checkDogfoodProject({ targetDir: repoRoot, since: isoMinutesAgo(5) })
    expect(result.ok).toBe(false)
    expect(result.environmentSkewCount).toBeGreaterThan(0)
    expect(result.failures).toContain('environment_skew')
  })

  it('marks a clean active cohort as ok', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-clean-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    const provenance = await activeAuditProvenance(repoRoot)
    await writeAuditLines(
      repoRoot,
      [
        auditRecordLine({
          timestamp: isoMinutesAgo(2),
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'allow',
          permission: 'allow',
          reason: 'read_only',
          mode: 'audit',
          ...provenance,
        }),
        auditRecordLine({
          timestamp: isoMinutesAgo(1),
          event: 'preToolUse',
          kind: 'tool',
          verdict: 'allow',
          permission: 'allow',
          reason: 'read_only',
          mode: 'audit',
          ...provenance,
        }),
      ].join(''),
    )

    const result = await checkDogfoodProject({ targetDir: repoRoot, since: isoMinutesAgo(5) })
    expect(result.ok).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.gateEvents).toBe(2)
  })

  it('adds invalid_timestamp_record when any loaded timestamp is invalid', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-bad-record-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    const provenance = await activeAuditProvenance(repoRoot)
    await writeAuditLines(
      repoRoot,
      [
        auditRecordLine({
          timestamp: isoMinutesAgo(2),
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'allow',
          permission: 'allow',
          reason: 'read_only',
          mode: 'audit',
          ...provenance,
        }),
        auditRecordLine({
          timestamp: 'not-a-timestamp',
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'allow',
          permission: 'allow',
          reason: 'read_only',
          mode: 'audit',
          ...provenance,
        }),
      ].join(''),
    )

    const result = await checkDogfoodProject({ targetDir: repoRoot, since: isoMinutesAgo(5) })
    expect(result.ok).toBe(false)
    expect(result.failures).toContain('invalid_timestamp_record')
  })
})
