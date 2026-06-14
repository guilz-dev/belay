import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { doctorProject } from '../commands/doctor.js'
import { formatReport, reportProject } from '../commands/report.js'
import { formatStatusReport, statusProject } from '../commands/status.js'
import { toAuditRecord } from '../core/audit-metrics.js'
import {
  detectFenceDrift,
  formatAskBreakdown,
  inferAuditTier,
  summarizeAuditVisibility,
} from '../core/audit-summary.js'
import { initProject } from '../installer.js'

const VISIBILITY_FIXTURE = [
  {
    timestamp: '2026-01-01T00:00:00.000Z',
    event: 'beforeShellExecution',
    verdict: 'deny_pending_approval',
    wouldBlock: true,
    mode: 'enforce',
    reason: 'tier0_external',
    summary: 'docker push myapp',
  },
  {
    timestamp: '2026-01-02T00:00:00.000Z',
    event: 'beforeShellExecution',
    verdict: 'allow',
    wouldBlock: true,
    permission: 'allow',
    mode: 'audit',
    reason: 'unknown_local_effect',
    confidence: 'llm',
    summary: 'npm install',
  },
  {
    timestamp: '2026-01-02T05:00:00.000Z',
    event: 'beforeShellExecution',
    verdict: 'deny_pending_approval',
    wouldBlock: true,
    mode: 'enforce',
    reason: 'tier0_external',
    summary: 'docker push blocked',
  },
  {
    timestamp: '2026-01-03T00:00:00.000Z',
    event: 'beforeShellExecution',
    verdict: 'allow_flagged',
    reason: 'command_substitution',
    summary: 'echo $(git status)',
  },
  {
    timestamp: '2026-01-04T00:00:00.000Z',
    event: 'beforeShellExecution',
    verdict: 'allow',
    reason: 'routine',
    summary: 'git status',
  },
]

describe('audit visibility (T-V1)', () => {
  it('summarizes ask/flag/allow and silent-pass rate from gate events', () => {
    const records = VISIBILITY_FIXTURE.map((entry) => toAuditRecord(entry))
    const summary = summarizeAuditVisibility(records)

    expect(summary.gateEvents).toBe(5)
    expect(summary.askCount).toBe(3)
    expect(summary.enforceAskCount).toBe(2)
    expect(summary.auditAskCount).toBe(1)
    expect(summary.unknownModeAskCount).toBe(0)
    expect(summary.flagCount).toBe(1)
    expect(summary.allowCount).toBe(2)
    expect(summary.silentPassRate).toBeCloseTo(0.6)
    expect(summary.recentAsks[0]?.summary).toBe('docker push blocked')
    expect(summary.recentAsks[1]?.summary).toBe('npm install')
    expect(summary.recentAsks[2]?.summary).toBe('docker push myapp')
  })

  it('infers audit tiers with saved confidence first, then reason fallback', () => {
    expect(
      inferAuditTier(toAuditRecord({ reason: 'tier0_external', confidence: 'deterministic' })),
    ).toBe('Tier0')
    expect(inferAuditTier(toAuditRecord({ reason: 'routine', confidence: 'llm' }))).toBe('Tier1')
    expect(inferAuditTier(toAuditRecord({ reason: 'routine', confidence: 'deterministic' }))).toBe(
      'deterministic',
    )
    expect(inferAuditTier(toAuditRecord({ reason: 'tier0_external' }))).toBe('Tier0')
    expect(
      inferAuditTier(toAuditRecord({ reason: 'unknown_local_effect', confidence: 'llm' })),
    ).toBe('Tier1')
    expect(inferAuditTier(toAuditRecord({ reason: 'routine' }))).toBe('deterministic')
  })

  it('formats human-readable and json-compatible report output', () => {
    const records = VISIBILITY_FIXTURE.map((entry) => toAuditRecord(entry))
    const summary = summarizeAuditVisibility(records)
    const text = formatReport({
      repoRoot: '/repo',
      auditLogPath: '/repo/belay/audit.ndjson',
      warnings: [],
      notes: [],
      ...summary,
    })

    expect(text).toContain('Ask (would-block): 3')
    expect(text).toContain('enforce (blocked): 2')
    expect(text).toContain('audit (would-block only): 1')
    expect(text).toContain('Silent-pass rate: 60.0%')
    expect(text).toContain('docker push myapp')
  })

  it('counts legacy asks without mode separately', () => {
    const records = [
      ...VISIBILITY_FIXTURE,
      {
        timestamp: '2026-01-05T00:00:00.000Z',
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        reason: 'tier0_external',
        summary: 'legacy ask without mode',
      },
    ].map((entry) => toAuditRecord(entry))
    const summary = summarizeAuditVisibility(records)

    expect(summary.askCount).toBe(4)
    expect(summary.unknownModeAskCount).toBe(1)
    const text = formatReport({
      repoRoot: '/repo',
      auditLogPath: '/repo/belay/audit.ndjson',
      warnings: [],
      notes: [],
      ...summary,
    })
    expect(text).toContain('mode unknown (legacy): 1')
  })

  it('formats ask breakdown helper with optional legacy bucket', () => {
    expect(
      formatAskBreakdown({
        askCount: 3,
        enforceAskCount: 2,
        auditAskCount: 1,
        unknownModeAskCount: 0,
      }),
    ).toEqual(['Ask (would-block): 3', '  enforce (blocked): 2', '  audit (would-block only): 1'])
    expect(
      formatAskBreakdown({
        askCount: 4,
        enforceAskCount: 2,
        auditAskCount: 1,
        unknownModeAskCount: 1,
      }),
    ).toContain('  mode unknown (legacy): 1')
  })

  it('includes enforce/audit breakdown in status output', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'belay-status-visibility-'))
    try {
      await initProject({ targetDir: tempDir })
      await writeFile(
        path.join(tempDir, '.cursor', 'belay', 'audit.ndjson'),
        `${JSON.stringify({
          timestamp: '2026-01-01T00:00:00.000Z',
          event: 'beforeShellExecution',
          verdict: 'deny_pending_approval',
          wouldBlock: true,
          mode: 'enforce',
          reason: 'tier0_external',
          summary: 'docker push myapp',
        })}\n`,
        'utf8',
      )

      const status = await statusProject({ targetDir: tempDir })
      const text = formatStatusReport(status)
      expect(text).toContain('Containment posture: best-effort')
      expect(text).toContain('enforce (blocked): 1')
      expect(text).toContain('audit (would-block only): 0')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('serializes reportProject output as stable JSON (T-V1)', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'belay-report-json-'))
    try {
      await initProject({ targetDir: tempDir })
      const record = {
        timestamp: '2026-01-01T00:00:00.000Z',
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        reason: 'tier0_external',
        summary: 'docker push myapp',
      }
      await writeFile(
        path.join(tempDir, '.cursor', 'belay', 'audit.ndjson'),
        `${JSON.stringify(record)}\n`,
        'utf8',
      )

      const report = await reportProject({ targetDir: tempDir })
      const parsed = JSON.parse(JSON.stringify(report)) as typeof report

      expect(parsed.gateEvents).toBe(1)
      expect(parsed.askCount).toBe(1)
      expect(parsed.unknownModeAskCount).toBe(1)
      expect(parsed.flagCount).toBe(0)
      expect(parsed.allowCount).toBe(0)
      expect(parsed.silentPassRate).toBe(0)
      expect(parsed.recentAsks).toHaveLength(1)
      expect(parsed.recentAsks[0]?.tier).toBe('Tier0')
      expect(parsed.auditLogPath).toContain('audit.ndjson')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
  it('uses policy.fenceWarnThreshold from config in reportProject', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'belay-report-threshold-'))
    try {
      await initProject({ targetDir: tempDir })
      const configPath = path.join(tempDir, '.cursor', 'belay.config.json')
      const config = JSON.parse(await readFile(configPath, 'utf8')) as {
        policy: Record<string, unknown>
      }
      config.policy.fenceWarnThreshold = 0.7
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

      const auditLines = Array.from({ length: 25 }, (_, index) =>
        JSON.stringify({
          timestamp: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
          event: 'beforeShellExecution',
          verdict: index < 10 ? 'deny_pending_approval' : 'allow',
          wouldBlock: index < 10,
          mode: 'enforce',
          reason: index < 10 ? 'tier0_external' : 'routine',
          summary: `cmd-${index}`,
        }),
      ).join('\n')
      await writeFile(
        path.join(tempDir, '.cursor', 'belay', 'audit.ndjson'),
        `${auditLines}\n`,
        'utf8',
      )

      const report = await reportProject({ targetDir: tempDir })
      expect(report.silentPassRate).toBeCloseTo(0.6)
      expect(report.warnings.some((line) => line.includes('below 70% threshold'))).toBe(true)

      const doctor = await doctorProject({ targetDir: tempDir })
      expect(doctor.warnings.some((line) => line.includes('below 70% threshold'))).toBe(true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('fence drift warnings (T-V2)', () => {
  it('warns when silent-pass rate is clearly below threshold with enough samples', () => {
    const drift = detectFenceDrift({ gateEvents: 25, silentPassRate: 0.4 })
    expect(drift.warnings.some((line) => line.includes('Silent-pass rate'))).toBe(true)
    expect(drift.warnings.some((line) => line.includes('false positives'))).toBe(true)
  })

  it('does not warn at 0.97 silent-pass rate (legitimate ask-heavy repos)', () => {
    const drift = detectFenceDrift({ gateEvents: 25, silentPassRate: 0.97 })
    expect(drift.warnings).toHaveLength(0)
  })

  it('does not warn at 0.9 silent-pass rate with default conservative threshold', () => {
    const drift = detectFenceDrift({ gateEvents: 25, silentPassRate: 0.9 })
    expect(drift.warnings).toHaveLength(0)
  })

  it('defers fence drift judgment when sample size is small', () => {
    const drift = detectFenceDrift({ gateEvents: 5, silentPassRate: 0.5 })
    expect(drift.warnings).toHaveLength(0)
    expect(drift.notes.some((line) => line.includes('deferred'))).toBe(true)
  })

  it('stays silent when there are no gate events', () => {
    const drift = detectFenceDrift({ gateEvents: 0, silentPassRate: 0 })
    expect(drift.warnings).toHaveLength(0)
    expect(drift.notes).toHaveLength(0)
  })

  it('surfaces fence drift warnings in report and doctor', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'belay-report-'))
    try {
      await initProject({ targetDir: tempDir })
      const auditLines = Array.from({ length: 25 }, (_, index) =>
        JSON.stringify({
          timestamp: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
          event: 'beforeShellExecution',
          verdict: index < 15 ? 'deny_pending_approval' : 'allow',
          wouldBlock: index < 15,
          mode: index < 15 ? 'enforce' : 'enforce',
          reason: index < 15 ? 'tier0_external' : 'routine',
          summary: `cmd-${index}`,
        }),
      ).join('\n')

      await writeFile(
        path.join(tempDir, '.cursor', 'belay', 'audit.ndjson'),
        `${auditLines}\n`,
        'utf8',
      )

      const report = await reportProject({ targetDir: tempDir })
      expect(report.warnings.some((line) => line.includes('Silent-pass rate'))).toBe(true)

      const doctor = await doctorProject({ targetDir: tempDir })
      expect(doctor.warnings.some((line) => line.includes('Silent-pass rate'))).toBe(true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
