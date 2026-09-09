import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadAuditRecords } from '../commands/audit.js'
import { doctorProject } from '../commands/doctor.js'
import { dogfoodProject } from '../commands/dogfood.js'
import { checkDogfoodProject, formatDogfoodCheckResult } from '../commands/dogfood-check.js'
import { qualityCheck } from '../commands/quality.js'
import { statusProject } from '../commands/status.js'
import { loadConfigFile, runtimeCorePath } from '../config-io.js'
import { appendAuditRecord } from '../core/audit-serialize.js'
import { DEFAULT_REDACTION_V3, mergeConfig } from '../core/config.js'
import { canonicalStringify, hashValue } from '../core/fingerprint.js'
import { initProject } from '../installer.js'
import { loadOperationalInsights } from '../operational-insights.js'
import { resolveActiveAuditCohort } from '../runtime-provenance.js'

const tempDirs: string[] = []
const execFileAsync = promisify(execFile)
const REVIEWED_FINGERPRINT = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
const REVIEWED_SESSION_IDS = ['1111111111111111', '2222222222222222', '3333333333333333']

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

async function seedPassingCorpus(repoRoot: string): Promise<void> {
  const corpusDir = path.join(repoRoot, 'corpus')
  await mkdir(corpusDir, { recursive: true })
  await writeFile(
    path.join(corpusDir, 'shell-commands.json'),
    `${JSON.stringify([
      {
        kind: 'shell',
        category: 'provably-benign',
        command: 'git status',
        verdict: 'allow',
        reason: 'read_only',
      },
      {
        kind: 'shell',
        category: 'must-ask',
        command: 'git push origin main',
        verdict: 'deny_pending_approval',
        reason: 'external_effect',
      },
    ])}\n`,
  )
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
  const persistedConfig = await loadConfigFile(repoRoot)
  const cohort = await resolveActiveAuditCohort(repoRoot, persistedConfig)
  expect(cohort).not.toBeNull()
  if (!cohort) {
    throw new Error('fixture active cohort unavailable')
  }
  const records = Array.from({ length: 150 }, (_, index) => ({
    event: 'beforeShellExecution',
    kind: 'shell',
    verdict: 'allow',
    reason: 'read_only',
    wouldBlock: false,
    mode: 'audit',
    fingerprint: REVIEWED_FINGERPRINT,
    sessionCorrelationId: REVIEWED_SESSION_IDS[index % REVIEWED_SESSION_IDS.length],
    ...cohort,
  }))
  const auditPath = path.join(repoRoot, persistedConfig.audit.logPath)
  await writeFile(
    auditPath,
    `${records
      .slice(0, -1)
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
  )
  await appendAuditRecord(auditPath, records.at(-1) ?? {}, DEFAULT_REDACTION_V3)
  await writeFile(
    path.join(path.dirname(auditPath), 'harvest-reviews.json'),
    `${JSON.stringify({
      version: 1,
      reviews: [
        {
          fingerprint: REVIEWED_FINGERPRINT,
          kind: 'shell',
          boundaryProfile: cohort.boundaryProfile,
          outcome: 'provably-benign',
          reviewedAt: '2026-09-08T00:00:00.000Z',
        },
      ],
    })}\n`,
  )
  await seedPassingCorpus(repoRoot)
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

  it('checks the explicitly selected adapter immediately before enforce promotion', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-enforce-adapter-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, adapter: 'cursor', dogfood: true })
    await seedDogfoodEnforceReady(repoRoot)
    await initProject({ targetDir: repoRoot, adapter: 'claude', dogfood: true })

    const result = await dogfoodProject({
      targetDir: repoRoot,
      adapter: 'cursor',
      enforce: true,
    })
    const cursorConfig = await loadConfigFile(repoRoot, 'cursor')
    const claudeConfig = await loadConfigFile(repoRoot, 'claude')

    expect(result.ok, result.message).toBe(true)
    expect(cursorConfig.mode).toBe('enforce')
    expect(claudeConfig.mode).toBe('audit')
  })

  it('recomputes combined quality immediately before enforce mutation', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-quality-recheck-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await seedDogfoodEnforceReady(repoRoot)
    expect((await qualityCheck({ targetDir: repoRoot })).readyForEnforce).toBe(true)

    const config = await loadConfigFile(repoRoot)
    await writeFile(
      path.join(path.dirname(path.join(repoRoot, config.audit.logPath)), 'harvest-reviews.json'),
      '{"version":1,"reviews":[]}\n',
    )

    const result = await dogfoodProject({ targetDir: repoRoot, enforce: true })
    const unchanged = await loadConfigFile(repoRoot)

    expect(result.ok).toBe(false)
    expect(result.message).toContain('combined quality readiness failed')
    expect(result.message).toContain('Review evidence is missing')
    expect(unchanged.mode).toBe('audit')
  })

  it('writes the exact config snapshot evaluated by quality when config changes between loads', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-config-snapshot-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await seedDogfoodEnforceReady(repoRoot)
    const evaluatedConfig = await loadConfigFile(repoRoot)
    const staleConfig = mergeConfig({
      ...evaluatedConfig,
      audit: { ...evaluatedConfig.audit, includeAssessment: false },
    })
    expect(evaluatedConfig.audit.includeAssessment).toBe(true)
    expect(staleConfig.audit.includeAssessment).toBe(false)

    vi.resetModules()
    vi.doMock('../config-io.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../config-io.js')>()
      const loadConfigSnapshot = vi
        .fn(async () => evaluatedConfig)
        .mockResolvedValueOnce(staleConfig)
      return { ...actual, loadConfigFile: loadConfigSnapshot }
    })

    try {
      const { dogfoodProject: dogfoodWithChangingConfig } = await import('../commands/dogfood.js')
      const result = await dogfoodWithChangingConfig({ targetDir: repoRoot, enforce: true })
      const persisted = await loadConfigFile(repoRoot)

      expect(result.ok, result.message).toBe(true)
      expect(persisted.mode).toBe('enforce')
      expect(persisted.audit.includeAssessment).toBe(true)
    } finally {
      vi.doUnmock('../config-io.js')
      vi.resetModules()
    }
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
    await seedPassingCorpus(repoRoot)

    const result = await dogfoodProject({ targetDir: repoRoot, enforce: true })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('No gate events for the active runtime/config cohort')
  })

  it('refuses enforce until metrics are ready unless forced', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-force-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await seedPassingCorpus(repoRoot)

    const blocked = await dogfoodProject({ targetDir: repoRoot, enforce: true })
    expect(blocked.ok).toBe(false)
    expect(blocked.message).toContain('combined quality readiness failed')
    expect(blocked.message).toContain('Reviewed provably-benign events')
    expect(blocked.message).not.toContain('overrides.allow')

    const forced = await dogfoodProject({ targetDir: repoRoot, enforce: true, force: true })
    expect(forced.ok).toBe(true)
    expect(forced.mode).toBe('enforce')
    expect(forced.message).toContain('Explicit --force override')
    expect(forced.message).toContain('combined quality readiness failed')
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

    expect(status.dogfood.gateEvents).toBe(150)
    expect(status.dogfood.wouldBlockCount).toBe(0)
    expect(status.dogfood.reviewedBenignEvents).toBe(150)
    expect(status.dogfood.reviewedBenignBlocked).toBe(0)
    expect(status.dogfood.benignBlockRate).toBe(0)
    expect(status.dogfood.distinctSessions).toBe(3)
    expect(status.dogfood.availabilityAsks).toBe(0)
    expect(status.dogfood.trafficReadyForEnforce).toBe(true)
    expect(status.dogfood.readyForEnforce).toBe(true)
    expect(status.dogfood.excludedGateEvents).toBe(21)
    expect(doctor.dogfood?.gateEvents).toBe(150)
    expect(doctor.dogfood?.reviewedBenignEvents).toBe(150)
    expect(doctor.dogfood?.reviewedBenignBlocked).toBe(0)
    expect(doctor.dogfood?.benignBlockRate).toBe(0)
    expect(doctor.dogfood?.distinctSessions).toBe(3)
    expect(doctor.dogfood?.availabilityAsks).toBe(0)
    expect(doctor.dogfood?.trafficReadyForEnforce).toBe(true)
    expect(doctor.dogfood?.readyForEnforce).toBe(true)
    expect(doctor.dogfood?.excludedGateEvents).toBe(21)
    expect(doctor.warnings.some((warning) => warning.includes('Silent-pass rate'))).toBe(false)
  })

  it('keeps traffic readiness separate and withholds status/doctor promotion on corpus failure', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-corpus-status-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, dogfood: true })
    await seedDogfoodEnforceReady(repoRoot)

    vi.resetModules()
    vi.doMock('../corpus/evaluate.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../corpus/evaluate.js')>()
      return {
        ...actual,
        runCorpusEvaluation: vi.fn(async (corpusDir?: string) => {
          const metrics = await actual.runCorpusEvaluation(corpusDir)
          return {
            ...metrics,
            gates: {
              ...metrics.gates,
              mustAsk: { ...metrics.gates.mustAsk, mismatches: 1 },
            },
          }
        }),
      }
    })

    try {
      const { formatStatusReport, statusProject: statusWithFailingCorpus } = await import(
        '../commands/status.js'
      )
      const { doctorProject: doctorWithFailingCorpus, formatDoctorReport } = await import(
        '../commands/doctor.js'
      )
      const status = await statusWithFailingCorpus({ targetDir: repoRoot })
      const doctor = await doctorWithFailingCorpus({ targetDir: repoRoot })
      const statusText = formatStatusReport(status)
      const doctorText = formatDoctorReport(doctor)

      expect(status.dogfood.trafficReadyForEnforce).toBe(true)
      expect(status.dogfood.readyForEnforce).toBe(false)
      expect(status.dogfood.notes).toContain('Corpus MUST-ASK misses: 1 (required: 0).')
      expect(statusText).toContain('Traffic ready for enforce: yes')
      expect(statusText).toContain('Combined quality ready for enforce: no')
      expect(doctor.dogfood?.trafficReadyForEnforce).toBe(true)
      expect(doctor.dogfood?.readyForEnforce).toBe(false)
      expect(doctor.notes).toContain('Enforce readiness: Corpus MUST-ASK misses: 1 (required: 0).')
      expect(doctor.notes.some((note) => note.includes('suggest enforce mode is ready'))).toBe(
        false,
      )
      expect(doctorText).toContain('traffic ready: yes | combined quality ready: no')
    } finally {
      vi.doUnmock('../corpus/evaluate.js')
      vi.resetModules()
    }
  }, 60_000)

  it('uses the explicitly selected adapter for doctor readiness evidence', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-doctor-readiness-adapter-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot, adapter: 'cursor', dogfood: true })
    await seedDogfoodEnforceReady(repoRoot)
    await initProject({ targetDir: repoRoot, adapter: 'claude', dogfood: true })

    const report = await doctorProject({ targetDir: repoRoot, adapter: 'cursor' })

    expect(report.dogfood?.gateEvents).toBe(150)
    expect(report.dogfood?.trafficReadyForEnforce).toBe(true)
    expect(report.dogfood?.readyForEnforce).toBe(true)
  }, 60_000)
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

  it('does not count inherited linked worktrees as environment skew', async () => {
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
    expect(result.environmentSkewCount).toBe(0)
    expect(result.failures).not.toContain('environment_skew')
  })

  it('fails when a linked worktree overrides inherited config with enforce mode', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-no-inherit-'))
    const linkedParent = await mkdtemp(
      path.join(os.tmpdir(), 'belay-dogfood-check-no-inherit-linked-'),
    )
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
    await execFileAsync('git', ['worktree', 'add', linkedWorktree, '-b', 'linked-no-inherit'], {
      cwd: repoRoot,
    })
    const primaryConfig = JSON.parse(
      await readFile(path.join(repoRoot, '.cursor', 'belay.config.json'), 'utf8'),
    )
    await mkdir(path.join(linkedWorktree, '.cursor'), { recursive: true })
    await writeFile(
      path.join(linkedWorktree, '.cursor', 'belay.config.json'),
      `${JSON.stringify({ ...primaryConfig, mode: 'enforce' })}\n`,
    )

    const result = await checkDogfoodProject({ targetDir: repoRoot, since: isoMinutesAgo(5) })
    expect(result.environmentSkewCount).toBeGreaterThan(0)
    expect(result.failures).toContain('environment_skew')
  })

  it('fails when a linked worktree has a foreign-root Cursor shim', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-dogfood-check-routing-root-'))
    const linkedParent = await mkdtemp(
      path.join(os.tmpdir(), 'belay-dogfood-check-routing-linked-'),
    )
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
    await execFileAsync('git', ['worktree', 'add', linkedWorktree, '-b', 'linked-routing-check'], {
      cwd: repoRoot,
    })
    await initProject({ targetDir: linkedWorktree, dogfood: true })
    await writeFile(
      path.join(linkedWorktree, '.cursor', 'hooks', 'belay-shell-gate.mjs'),
      `import { dispatchCursorHook } from '../belay/runtime/dispatcher.mjs'

await dispatchCursorHook({
  origin: ${JSON.stringify({ scope: 'project', repoRoot })},
  kind: "shell-gate",
  eventName: "beforeShellExecution",
})
`,
    )
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
    expect(result.hookRoutingSkewCount).toBe(1)
    expect(result.failures).toContain('hook_routing_skew')
    expect(formatDogfoodCheckResult(result)).toContain('hook routing skew count: 1')
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
