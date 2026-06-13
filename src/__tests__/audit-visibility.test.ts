import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { doctorProject } from '../commands/doctor.js'
import { formatReport, reportProject } from '../commands/report.js'
import { toAuditRecord } from '../core/audit-metrics.js'
import {
  detectFenceDrift,
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
    reason: 'tier0_external',
    summary: 'docker push myapp',
  },
  {
    timestamp: '2026-01-02T00:00:00.000Z',
    event: 'beforeShellExecution',
    verdict: 'allow',
    wouldBlock: true,
    permission: 'allow',
    reason: 'unknown_local_effect',
    confidence: 'llm',
    summary: 'npm install',
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

    expect(summary.gateEvents).toBe(4)
    expect(summary.askCount).toBe(2)
    expect(summary.flagCount).toBe(1)
    expect(summary.allowCount).toBe(2)
    expect(summary.silentPassRate).toBeCloseTo(0.75)
    expect(summary.recentAsks[0]?.summary).toBe('npm install')
    expect(summary.recentAsks[1]?.summary).toBe('docker push myapp')
  })

  it('infers audit tiers', () => {
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

    expect(text).toContain('Ask (would-block): 2')
    expect(text).toContain('Silent-pass rate: 75.0%')
    expect(text).toContain('docker push myapp')
  })
})

describe('fence drift warnings (T-V2)', () => {
  it('warns when silent-pass rate is below threshold with enough samples', () => {
    const drift = detectFenceDrift({ gateEvents: 25, silentPassRate: 0.9 })
    expect(drift.warnings.some((line) => line.includes('Silent-pass rate'))).toBe(true)
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
          verdict: index < 5 ? 'deny_pending_approval' : 'allow',
          wouldBlock: index < 5,
          reason: index < 5 ? 'tier0_external' : 'routine',
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
