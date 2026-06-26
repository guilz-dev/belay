import { describe, expect, it } from 'vitest'
import { formatMetricsReport } from '../commands/metrics.js'
import {
  computeApprovalRatioByReason,
  computeAvailabilityAskCounts,
  computeRepeatedFingerprintAsks,
  computeWouldBlockByReason,
  isAvailabilityCausedAsk,
} from '../core/audit-analysis.js'
import {
  buildApprovalRoundTrips,
  computeAuditMetrics,
  MIN_GATE_EVENTS_FOR_ENFORCE,
  parseAuditNdjson,
  toAuditRecord,
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

    expect(report.schemaVersion).toBe(3)
    expect(report.gateEvents).toBe(2)
    expect(report.wouldBlockCount).toBe(1)
    expect(report.wouldBlockRate).toBe(0.5)
    expect(report.approvalRecordedCount).toBe(1)
    expect(report.dogfood.notes.join(' ')).toContain('Dogfood config detected')
  })

  it('aggregates verdict audit axes when present', () => {
    const report = computeAuditMetrics([
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        reason: 'high_stakes_path',
        location: 'repo_local',
        opacity: 'transparent',
        effect: 'local_mutation',
        confidence: 'deterministic',
      },
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
        reason: 'read_only',
        location: 'repo_local',
        opacity: 'transparent',
        effect: 'read_only',
        confidence: 'deterministic',
      },
    ])

    expect(report.byLocation).toEqual({ repo_local: 2 })
    expect(report.byOpacity).toEqual({ transparent: 2 })
    expect(report.byEffect).toEqual({ local_mutation: 1, read_only: 1 })
    expect(report.byConfidence).toEqual({ deterministic: 2 })
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

  it('summarizes would-block reasons and approval ratios separately from all gate reasons', () => {
    const records = [
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        wouldBlock: true,
        fingerprint: 'fp-make',
        summary: 'make build',
        approvalId: 'ap-1',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        wouldBlock: true,
        fingerprint: 'fp-make',
        summary: 'make build',
        timestamp: '2026-01-01T00:05:00.000Z',
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
        approvalId: 'ap-1',
        timestamp: '2026-01-01T00:01:00.000Z',
      },
    ].map(toAuditRecord)

    const roundTrips = buildApprovalRoundTrips(records)
    expect(computeWouldBlockByReason(records)).toEqual({ unknown_local_effect: 2 })
    expect(computeApprovalRatioByReason(records, roundTrips)).toEqual([
      {
        reason: 'unknown_local_effect',
        wouldBlockCount: 2,
        approvedAfterDenyCount: 1,
        approvalRate: 0.5,
      },
    ])

    const report = computeAuditMetrics(records)
    expect(report.wouldBlockByReason).toEqual({ unknown_local_effect: 2 })
    expect(report.approvalRatioByReason[0]?.approvalRate).toBe(0.5)
    expect(report.repeatedFingerprintAsks).toEqual([
      {
        fingerprint: 'fp-make',
        summary: 'make build',
        reason: 'unknown_local_effect',
        askCount: 2,
      },
    ])
  })

  it('counts availability-caused asks separately from classifier-quality friction', () => {
    const records = [
      {
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        reason: 'missing_trusted_cwd',
        wouldBlock: true,
        fingerprint: 'fp-cwd',
      },
      {
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        wouldBlock: true,
        judgeFallbackReason: 'eval_timeout',
        fingerprint: 'fp-timeout',
      },
      {
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        wouldBlock: true,
        judgeFallbackReason: 'cursor_cli_unavailable',
        fingerprint: 'fp-fallback',
      },
      {
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        reason: 'external_effect',
        wouldBlock: true,
        fingerprint: 'fp-real',
      },
    ].map(toAuditRecord)

    expect(computeAvailabilityAskCounts(records)).toEqual({
      total: 3,
      missingTrustedCwd: 1,
      judgeTimeout: 1,
      judgeFallback: 1,
    })
    expect(computeRepeatedFingerprintAsks(records)).toEqual([])

    const formatted = formatMetricsReport(computeAuditMetrics(records))
    expect(formatted).toContain('Availability-caused asks')
    expect(formatted).toContain('missing trusted cwd: 1')
    expect(formatted).toContain('Would-block by reason')
    expect(formatted).not.toContain('Repeated fingerprint asks')
  })

  it('prefers missing_trusted_cwd over judge fallback when both signals are present', () => {
    const records = [
      {
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        reason: 'missing_trusted_cwd',
        wouldBlock: true,
        judgeFallbackReason: 'eval_timeout',
      },
    ].map(toAuditRecord)

    expect(isAvailabilityCausedAsk(records[0])).toBe(true)
    expect(computeAvailabilityAskCounts(records)).toEqual({
      total: 1,
      missingTrustedCwd: 1,
      judgeTimeout: 0,
      judgeFallback: 0,
    })
  })

  it('uses the latest event metadata for repeated fingerprint asks', () => {
    const records = [
      {
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        reason: 'read_only',
        wouldBlock: true,
        fingerprint: 'fp-repeat',
        summary: 'git status',
      },
      {
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        wouldBlock: true,
        fingerprint: 'fp-repeat',
        summary: 'make build',
      },
    ].map(toAuditRecord)

    expect(computeRepeatedFingerprintAsks(records)).toEqual([
      {
        fingerprint: 'fp-repeat',
        summary: 'make build',
        reason: 'unknown_local_effect',
        askCount: 2,
      },
    ])
  })

  it('withholds readyForEnforce when availability-caused asks are present', () => {
    const report = computeAuditMetrics(
      Array.from({ length: MIN_GATE_EVENTS_FOR_ENFORCE }, () => ({
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        wouldBlock: true,
        judgeFallbackReason: 'eval_timeout',
      })),
      { mode: 'audit', unknownLocalEffect: 'deny' },
    )

    expect(report.availabilityAsks.total).toBe(MIN_GATE_EVENTS_FOR_ENFORCE)
    expect(report.classifierWouldBlockCount).toBe(0)
    expect(report.dogfood.readyForEnforce).toBe(false)
    expect(report.dogfood.notes.join(' ')).toContain('Ready for enforce withheld')
  })

  it('formats repeated fingerprint asks in metrics output', () => {
    const formatted = formatMetricsReport(
      computeAuditMetrics(
        [
          {
            event: 'beforeShellExecution',
            verdict: 'deny_pending_approval',
            reason: 'read_only',
            wouldBlock: true,
            fingerprint: 'short-fp',
            summary: 'git status',
          },
          {
            event: 'beforeShellExecution',
            verdict: 'deny_pending_approval',
            reason: 'read_only',
            wouldBlock: true,
            fingerprint: 'short-fp',
            summary: 'git status',
          },
        ].map(toAuditRecord),
      ),
    )

    expect(formatted).toContain('Repeated fingerprint asks')
    expect(formatted).toContain('x2 short-fp: git status')
    expect(formatted).not.toContain('short-fp…')
  })
})
