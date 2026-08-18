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
import {
  computeRecoveryMetrics,
  sanitizeRecoveryFailureReason,
} from '../core/audit-recovery-metrics.js'

const ACTIVE_COHORT = {
  runtimeBuildStamp: '0.8.0@2026-08-14T04:23:49.942Z',
  configFingerprint: 'active-config-fingerprint',
}

function cohortGate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'beforeShellExecution',
    kind: 'shell',
    verdict: 'allow',
    reason: 'read_only',
    wouldBlock: false,
    ...ACTIVE_COHORT,
    ...overrides,
  }
}

describe('audit-metrics', () => {
  it('parses NDJSON audit lines', () => {
    const records = parseAuditNdjson(
      '{"event":"beforeShellExecution","verdict":"allow"}\n\n{"event":"preToolUse"}\n',
    )
    expect(records).toHaveLength(2)
  })

  it('keeps historical audit records readable without EffectPlan or runtime fields', () => {
    const records = parseAuditNdjson(
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:00.000Z',
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          reason: 'external_command',
          by: 'v2',
          summary: 'curl https://example.com',
        }),
        '{malformed',
      ].join('\n'),
    )
    const normalized = records.map(toAuditRecord)
    const report = computeAuditMetrics(records)

    expect(normalized).toEqual([
      expect.objectContaining({
        verdict: 'deny_pending_approval',
        by: 'verdict',
      }),
    ])
    expect(report.gateEvents).toBe(1)
    expect(report.wouldBlockCount).toBe(1)
    expect(report.gateEventsByRuntime).toEqual({ unrecorded: 1 })
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
          ...ACTIVE_COHORT,
        },
        {
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'allow',
          reason: 'read_only',
          wouldBlock: false,
          summary: 'rg plan',
          ...ACTIVE_COHORT,
        },
        {
          event: 'beforeSubmitPrompt',
          kind: 'approval',
          reason: 'approval_recorded',
          ...ACTIVE_COHORT,
        },
      ],
      { mode: 'audit', unknownLocalEffect: 'deny', activeCohort: ACTIVE_COHORT },
    )

    expect(report.schemaVersion).toBe(4)
    expect(report.gateEvents).toBe(2)
    expect(report.wouldBlockCount).toBe(1)
    expect(report.wouldBlockRate).toBe(0.5)
    expect(report.approvalRecordedCount).toBe(1)
    expect(report.dogfood.notes.join(' ')).toContain('Dogfood config detected')
    expect(report.dogfood.notes.join(' ')).toContain('EffectPlan semantics')
    expect(report.dogfood.notes.join(' ')).not.toContain('overrides.allow')
  })

  it('groups gate events by recorded runtime build', () => {
    const report = computeAuditMetrics([
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
        runtimeVersion: '0.7.0',
        runtimeBuildStamp: '0.7.0@2026-08-11T23:22:02.616Z',
      },
      {
        event: 'preToolUse',
        kind: 'tool',
        verdict: 'allow',
        runtimeVersion: '0.7.0',
        runtimeBuildStamp: '0.7.0@2026-08-11T23:22:02.616Z',
      },
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
      },
    ])

    expect(report.gateEventsByRuntime).toEqual({
      '0.7.0@2026-08-11T23:22:02.616Z': 2,
      unrecorded: 1,
    })
    expect(formatMetricsReport(report)).toContain('Gate events by runtime:')
  })

  it('groups gate events by recorded runtime build', () => {
    const report = computeAuditMetrics([
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
        runtimeVersion: '0.7.0',
        runtimeBuildStamp: '0.7.0@2026-08-11T23:22:02.616Z',
      },
      {
        event: 'preToolUse',
        kind: 'tool',
        verdict: 'allow',
        runtimeVersion: '0.7.0',
        runtimeBuildStamp: '0.7.0@2026-08-11T23:22:02.616Z',
      },
      {
        event: 'beforeShellExecution',
        kind: 'shell',
        verdict: 'allow',
      },
    ])

    expect(report.gateEventsByRuntime).toEqual({
      '0.7.0@2026-08-11T23:22:02.616Z': 2,
      unrecorded: 1,
    })
    expect(formatMetricsReport(report)).toContain('Gate events by runtime:')
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
    const fewEvents = Array.from({ length: MIN_GATE_EVENTS_FOR_ENFORCE - 1 }, () => cohortGate())
    const notReady = computeAuditMetrics(fewEvents, {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
    })
    expect(notReady.dogfood.readyForEnforce).toBe(false)

    const enoughEvents = Array.from({ length: MIN_GATE_EVENTS_FOR_ENFORCE }, () => cohortGate())
    const ready = computeAuditMetrics(enoughEvents, {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
    })
    expect(ready.dogfood.readyForEnforce).toBe(true)
  })

  it('does not reuse old clean events as active-cohort readiness evidence', () => {
    const oldCleanEvents = Array.from({ length: MIN_GATE_EVENTS_FOR_ENFORCE }, () =>
      cohortGate({
        runtimeBuildStamp: '0.7.0@2026-08-11T23:28:49.254Z',
        configFingerprint: 'old-config-fingerprint',
      }),
    )

    const report = computeAuditMetrics(oldCleanEvents, {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
    })

    expect(report.gateEvents).toBe(MIN_GATE_EVENTS_FOR_ENFORCE)
    expect(report.currentCohort.gateEvents).toBe(0)
    expect(report.currentCohort.excludedGateEvents).toBe(MIN_GATE_EVENTS_FOR_ENFORCE)
    expect(report.dogfood.readyForEnforce).toBe(false)
    expect(report.dogfood.notes.join(' ')).toContain(
      'No gate events for the active runtime/config cohort',
    )
  })

  it('ignores old noisy events when the active cohort is clean', () => {
    const oldNoisyEvents = Array.from({ length: MIN_GATE_EVENTS_FOR_ENFORCE }, () =>
      cohortGate({
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        wouldBlock: true,
        runtimeBuildStamp: '0.7.0@2026-08-11T23:28:49.254Z',
        configFingerprint: 'old-config-fingerprint',
      }),
    )
    const currentCleanEvents = Array.from({ length: MIN_GATE_EVENTS_FOR_ENFORCE }, () =>
      cohortGate(),
    )

    const report = computeAuditMetrics([...oldNoisyEvents, ...currentCleanEvents], {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
    })

    expect(report.gateEvents).toBe(MIN_GATE_EVENTS_FOR_ENFORCE * 2)
    expect(report.wouldBlockCount).toBe(MIN_GATE_EVENTS_FOR_ENFORCE)
    expect(report.currentCohort.gateEvents).toBe(MIN_GATE_EVENTS_FOR_ENFORCE)
    expect(report.currentCohort.wouldBlockCount).toBe(0)
    expect(report.currentCohort.excludedGateEvents).toBe(MIN_GATE_EVENTS_FOR_ENFORCE)
    expect(report.dogfood.readyForEnforce).toBe(true)
  })

  it('labels all-time history separately from the current readiness cohort', () => {
    const oldEvent = cohortGate({
      runtimeBuildStamp: '0.7.0@2026-08-11T23:28:49.254Z',
      configFingerprint: 'old-config-fingerprint',
    })
    const currentEvent = cohortGate()

    const formatted = formatMetricsReport(
      computeAuditMetrics([oldEvent, currentEvent], {
        mode: 'audit',
        unknownLocalEffect: 'deny',
        activeCohort: ACTIVE_COHORT,
      }),
    )

    expect(formatted).toContain('All-time gate events: 2')
    expect(formatted).toContain('Current readiness cohort:')
    expect(formatted).toContain(`- runtime build: ${ACTIVE_COHORT.runtimeBuildStamp}`)
    expect(formatted).toContain('- matching gate events: 1')
    expect(formatted).toContain('- excluded historical/mismatched gate events: 1')
  })

  it('keeps active-cohort remediation reasons separate from historical asks', () => {
    const oldAsk = cohortGate({
      verdict: 'deny_pending_approval',
      reason: 'old_unknown',
      summary: 'old command',
      wouldBlock: true,
      runtimeBuildStamp: '0.7.0@2026-08-11T23:28:49.254Z',
      configFingerprint: 'old-config-fingerprint',
    })
    const currentAsk = cohortGate({
      verdict: 'deny_pending_approval',
      reason: 'unknown_local_effect',
      summary: 'current command',
      wouldBlock: true,
    })

    const report = computeAuditMetrics([oldAsk, currentAsk], {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
    })
    const formatted = formatMetricsReport(report)

    expect(report.currentCohort.wouldBlockByReason).toEqual({ unknown_local_effect: 1 })
    expect(report.currentCohort.topWouldBlockSummaries).toEqual([
      { reason: 'unknown_local_effect', summary: 'current command', count: 1 },
    ])
    expect(formatted).toContain('Current-cohort would-block by reason:')
    expect(formatted).toContain('- unknown_local_effect: 1')
    expect(formatted).toContain('Current-cohort top would-block summaries:')
    expect(formatted).toContain('[unknown_local_effect] x1: current command')
  })

  it('excludes a matching runtime build with a different config fingerprint', () => {
    const currentEvents = Array.from({ length: MIN_GATE_EVENTS_FOR_ENFORCE - 1 }, () =>
      cohortGate(),
    )
    const mismatchedConfigEvent = cohortGate({ configFingerprint: 'different-config' })

    const report = computeAuditMetrics([...currentEvents, mismatchedConfigEvent], {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
    })

    expect(report.currentCohort.gateEvents).toBe(MIN_GATE_EVENTS_FOR_ENFORCE - 1)
    expect(report.currentCohort.excludedGateEvents).toBe(1)
    expect(report.dogfood.readyForEnforce).toBe(false)
  })

  it('withholds readiness for an active-cohort availability ask', () => {
    const currentCleanEvents = Array.from({ length: MIN_GATE_EVENTS_FOR_ENFORCE - 1 }, () =>
      cohortGate(),
    )
    const availabilityAsk = cohortGate({
      verdict: 'deny_pending_approval',
      reason: 'unknown_local_effect',
      wouldBlock: true,
      judgeFallbackReason: 'eval_timeout',
    })

    const report = computeAuditMetrics([...currentCleanEvents, availabilityAsk], {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
    })

    expect(report.currentCohort.gateEvents).toBe(MIN_GATE_EVENTS_FOR_ENFORCE)
    expect(report.currentCohort.availabilityAsks.total).toBe(1)
    expect(report.currentCohort.classifierWouldBlockRate).toBe(0)
    expect(report.dogfood.readyForEnforce).toBe(false)
    expect(report.dogfood.notes.join(' ')).toContain('Ready for enforce withheld')
  })

  it('fails closed when the active cohort identity is unavailable', () => {
    const report = computeAuditMetrics(
      Array.from({ length: MIN_GATE_EVENTS_FOR_ENFORCE }, () => cohortGate()),
      { mode: 'audit', unknownLocalEffect: 'deny', activeCohort: null },
    )

    expect(report.currentCohort.identity).toBeNull()
    expect(report.currentCohort.gateEvents).toBe(0)
    expect(report.dogfood.readyForEnforce).toBe(false)
    expect(report.dogfood.notes.join(' ')).toContain('Active runtime provenance is unavailable')
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
        ...ACTIVE_COHORT,
      })),
      { mode: 'audit', unknownLocalEffect: 'deny', activeCohort: ACTIVE_COHORT },
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

  it('recommends exact Effect remediation instead of standing command lists', () => {
    const report = computeAuditMetrics(
      [
        {
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          reason: 'unknown_local_effect',
          wouldBlock: true,
          fingerprint: 'fp-repeat',
          summary: 'make build',
          ...ACTIVE_COHORT,
        },
        {
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          reason: 'unknown_local_effect',
          wouldBlock: true,
          fingerprint: 'fp-repeat',
          summary: 'make build',
          ...ACTIVE_COHORT,
        },
      ],
      { mode: 'audit', unknownLocalEffect: 'deny', activeCohort: ACTIVE_COHORT },
    )
    const guidance = report.dogfood.notes.join(' ')

    expect(guidance).toContain('EffectPlan semantics')
    expect(guidance).toContain('exact approval')
    expect(guidance).not.toContain('overrides.allow')
    expect(guidance).not.toContain('standing-allow')
  })

  it('aggregates recovery snapshot and restore metrics without affecting dogfood readiness', () => {
    const records = [
      cohortGate({
        transactional: true,
        transactionalBackend: 'git_worktree',
        resourceKind: 'git_repository',
        snapshotPrepareMs: 100,
        recoveryCheckpointId: 'cp_applied',
        recoveryState: 'applied',
      }),
      cohortGate({
        transactional: false,
        transactionalBackend: 'file_checkpoint',
        resourceKind: 'directory',
        transactionalSkipReason: 'file_checkpoint_isolation_unavailable',
        recoveryFailClosed: true,
      }),
      {
        event: 'recoveryApplied',
        recoveryCheckpointId: 'cp_test',
        ...ACTIVE_COHORT,
      },
      {
        event: 'recoveryConflict',
        recoveryCheckpointId: 'cp_conflict',
        ...ACTIVE_COHORT,
      },
    ]

    const report = computeAuditMetrics(records, {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
    })

    expect(report.recovery.snapshot.attempts).toBe(2)
    expect(report.recovery.snapshot.applied).toBe(1)
    expect(report.recovery.snapshot.skipped).toBe(1)
    expect(report.recovery.snapshot.byBackend).toEqual({
      git_worktree: 1,
      file_checkpoint: 1,
    })
    expect(report.recovery.snapshot.byResourceKind).toEqual({
      git_repository: 1,
      directory: 1,
    })
    expect(report.recovery.snapshot.prepareSampleCount).toBe(1)
    expect(report.recovery.snapshot.prepareMsP50).toBe(100)
    expect(report.recovery.restore).toEqual({ applied: 1, conflict: 1, rejected: 0 })
    expect(report.currentCohortRecovery.snapshot.attempts).toBe(2)
    expect(report.currentCohortRecovery.excludedSnapshotAttempts).toBe(0)
    expect(formatMetricsReport(report)).toContain('All-time recovery metrics:')
    expect(formatMetricsReport(report)).toContain('file_checkpoint_isolation_unavailable: 1')
  })

  it('reads historical audit records without recovery fields', () => {
    const report = computeAuditMetrics(
      [
        {
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'allow',
          reason: 'read_only',
        },
      ],
      { activeCohort: ACTIVE_COHORT },
    )

    expect(report.recovery.snapshot.attempts).toBe(0)
    expect(report.recovery.restore.applied).toBe(0)
    expect(report.dogfood.readyForEnforce).toBe(false)
  })

  it('sanitizes unstable recovery failure reasons', () => {
    expect(
      sanitizeRecoveryFailureReason({
        transactionalSkipReason: '/tmp/secret/path changed',
      }),
    ).toBe('transactional_execution_failed')
    expect(
      sanitizeRecoveryFailureReason({
        transactionalSkipReason: 'file_checkpoint_quota_exceeded',
      }),
    ).toBe('file_checkpoint_quota_exceeded')
  })

  it('does not let recovery metrics change readyForEnforce', () => {
    const records = Array.from({ length: MIN_GATE_EVENTS_FOR_ENFORCE }, () => cohortGate())
    records.push({
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      transactional: false,
      transactionalSkipReason: 'dirty_worktree',
      recoveryFailClosed: true,
      ...ACTIVE_COHORT,
    })

    const report = computeAuditMetrics(records, {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
    })

    expect(report.recovery.snapshot.skipped).toBe(1)
    expect(report.dogfood.readyForEnforce).toBe(true)
    expect(
      computeRecoveryMetrics(records.map(toAuditRecord), { activeCohort: ACTIVE_COHORT })
        .currentCohort.snapshot.failuresByReason,
    ).toEqual({ dirty_worktree: 1 })
  })

  it('includes CLI restore events in the active cohort when provenance is stamped', () => {
    const report = computeAuditMetrics(
      [
        {
          event: 'recoveryApplied',
          recoveryCheckpointId: 'cp_cli',
          ...ACTIVE_COHORT,
        },
        {
          event: 'recoveryApplied',
          recoveryCheckpointId: 'cp_old',
          runtimeBuildStamp: '0.7.0@old',
          configFingerprint: 'old-config',
        },
      ],
      { activeCohort: ACTIVE_COHORT },
    )

    expect(report.recovery.restore.applied).toBe(2)
    expect(report.currentCohortRecovery.restore.applied).toBe(1)
    expect(report.currentCohortRecovery.excludedRestoreEvents).toBe(1)
  })

  it('counts observed-risk transactional runs as skipped snapshot outcomes', () => {
    const report = computeAuditMetrics(
      [
        cohortGate({
          transactional: true,
          transactionalBackend: 'file_checkpoint',
          resourceKind: 'directory',
          transactionalReason: 'transactional_observed_risk',
        }),
      ],
      { activeCohort: ACTIVE_COHORT },
    )

    expect(report.recovery.snapshot.attempts).toBe(1)
    expect(report.recovery.snapshot.applied).toBe(0)
    expect(report.recovery.snapshot.skipped).toBe(1)
    expect(report.recovery.snapshot.failuresByReason).toEqual({
      transactional_observed_risk: 1,
    })
  })

  it('counts observed-safe snapshots as applied without requiring a durable checkpoint', () => {
    const report = computeAuditMetrics(
      [
        cohortGate({
          transactional: true,
          reason: 'transactional_already_applied',
          transactionalBackend: 'git_worktree',
          resourceKind: 'git_repository',
          transactionalReason: 'transactional_observed_safe',
        }),
      ],
      { activeCohort: ACTIVE_COHORT },
    )

    expect(report.recovery.snapshot.applied).toBe(1)
    expect(report.recovery.snapshot.skipped).toBe(0)
    expect(report.recovery.snapshot.failuresByReason).toEqual({})
  })

  it('counts an observed-safe snapshot with a failed real apply as skipped', () => {
    const report = computeAuditMetrics(
      [
        cohortGate({
          transactional: true,
          verdict: 'deny_pending_approval',
          reason: 'transactional_apply_failed',
          transactionalBackend: 'file_checkpoint',
          resourceKind: 'directory',
          transactionalReason: 'transactional_observed_safe',
        }),
      ],
      { activeCohort: ACTIVE_COHORT },
    )

    expect(report.recovery.snapshot.applied).toBe(0)
    expect(report.recovery.snapshot.skipped).toBe(1)
    expect(report.recovery.snapshot.failuresByReason).toEqual({
      transactional_apply_failed: 1,
    })
  })
})
