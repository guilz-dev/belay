import { describe, expect, it } from 'vitest'

import { computeAuditMetrics, parseAuditNdjson } from '../core/audit-metrics.js'

describe('audit-metrics', () => {
  it('parses NDJSON audit lines', () => {
    const records = parseAuditNdjson(
      '{"event":"beforeShellExecution","verdict":"allow"}\n\n{"event":"preToolUse"}\n',
    )
    expect(records).toHaveLength(2)
  })

  it('computes would-block metrics for dogfood config', () => {
    const report = computeAuditMetrics(
      [
        {
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          reason: 'unknown_local_effect',
          wouldBlock: true,
          summary: 'make build',
        },
        {
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'allow',
          reason: 'read_only',
          wouldBlock: false,
          summary: 'rg plan',
        },
        {
          event: 'beforeSubmitPrompt',
          kind: 'approval',
          reason: 'approval_recorded',
        },
      ],
      { mode: 'audit', unknownLocalEffect: 'deny' },
    )

    expect(report.gateEvents).toBe(2)
    expect(report.wouldBlockCount).toBe(1)
    expect(report.wouldBlockRate).toBe(0.5)
    expect(report.approvalRecordedCount).toBe(1)
    expect(report.dogfood.notes.join(' ')).toContain('Dogfood config detected')
  })
})
