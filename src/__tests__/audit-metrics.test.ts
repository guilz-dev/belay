import { describe, expect, it } from 'vitest'

import {
  computeAuditMetrics,
  MIN_GATE_EVENTS_FOR_ENFORCE,
  parseAuditNdjson,
} from '../core/audit-metrics.js'

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

    expect(report.schemaVersion).toBe(2)
    expect(report.gateEvents).toBe(2)
    expect(report.wouldBlockCount).toBe(1)
    expect(report.wouldBlockRate).toBe(0.5)
    expect(report.approvalRecordedCount).toBe(1)
    expect(report.dogfood.notes.join(' ')).toContain('Dogfood config detected')
  })

  it('requires minimum gate events before readyForEnforce with zero would-block rate', () => {
    const fewEvents = Array.from({ length: MIN_GATE_EVENTS_FOR_ENFORCE - 1 }, () => ({
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'allow',
      reason: 'read_only',
      wouldBlock: false,
    }))
    const notReady = computeAuditMetrics(fewEvents, {
      mode: 'audit',
      unknownLocalEffect: 'deny',
    })
    expect(notReady.dogfood.readyForEnforce).toBe(false)

    const enoughEvents = Array.from({ length: MIN_GATE_EVENTS_FOR_ENFORCE }, () => ({
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'allow',
      reason: 'read_only',
      wouldBlock: false,
    }))
    const ready = computeAuditMetrics(enoughEvents, {
      mode: 'audit',
      unknownLocalEffect: 'deny',
    })
    expect(ready.dogfood.readyForEnforce).toBe(true)
  })
})
