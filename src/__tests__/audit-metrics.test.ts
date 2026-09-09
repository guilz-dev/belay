import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatMetricsReport, metricsProject } from '../commands/metrics.js'
import { loadConfigFile, writeTrustedConfigFile } from '../config-io.js'
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
  MAX_BENIGN_BLOCK_RATE,
  MIN_REVIEWED_BENIGN_EVENTS,
  MIN_REVIEWED_SESSIONS,
  parseAuditNdjson,
  toAuditRecord,
} from '../core/audit-metrics.js'
import {
  computeRecoveryMetrics,
  sanitizeRecoveryFailureReason,
} from '../core/audit-recovery-metrics.js'
import type { HarvestReviewLedgerV1, HarvestReviewOutcome } from '../core/harvest-review.js'
import { initProject } from '../installer.js'
import { resolveActiveAuditCohort } from '../runtime-provenance.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const ACTIVE_COHORT = {
  runtimeArtifactHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  decisionConfigFingerprint: 'active-decision-fingerprint',
  boundaryProfile: 'l3-l4-only',
  runtimeBuildStamp: '0.8.0@2026-08-14T04:23:49.942Z',
  configFingerprint: 'active-config-fingerprint',
}

const LEGACY_COHORT = {
  runtimeArtifactHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  decisionConfigFingerprint: 'old-decision-fingerprint',
  boundaryProfile: 'l3-l4-only',
  runtimeBuildStamp: '0.7.0@2026-08-11T23:28:49.254Z',
  configFingerprint: 'old-config-fingerprint',
}

const REVIEWED_FINGERPRINT = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
const VALID_SESSION_IDS = ['1111111111111111', '2222222222222222', '3333333333333333']
const LEGACY_DIAGNOSTIC_SAMPLE_COUNT = 20

function testFingerprint(label: string): string {
  return createHash('sha256').update(label).digest('hex')
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

function reviewLedger(
  outcome: HarvestReviewOutcome = 'provably-benign',
  overrides: Partial<HarvestReviewLedgerV1['reviews'][number]> = {},
): HarvestReviewLedgerV1 {
  return {
    version: 1,
    reviews: [
      {
        fingerprint: REVIEWED_FINGERPRINT,
        kind: 'shell',
        boundaryProfile: ACTIVE_COHORT.boundaryProfile,
        outcome,
        reviewedAt: '2026-09-08T00:00:00.000Z',
        ...overrides,
      },
    ],
  }
}

function reviewedBenignGateEvents(
  count: number,
  options: {
    sessionIds?: string[]
    explicitBlocked?: number
    legacyBlocked?: number
    fingerprint?: string
    kind?: string
  } = {},
): Record<string, unknown>[] {
  const sessionIds = options.sessionIds ?? VALID_SESSION_IDS
  const explicitBlocked = options.explicitBlocked ?? 0
  const legacyBlocked = options.legacyBlocked ?? 0
  return Array.from({ length: count }, (_, index) => {
    const record = cohortGate({
      fingerprint: options.fingerprint ?? REVIEWED_FINGERPRINT,
      kind: options.kind ?? 'shell',
      sessionCorrelationId: sessionIds[index % sessionIds.length],
    })
    if (index < explicitBlocked) {
      record.verdict = 'allow'
      record.wouldBlock = true
    } else if (index < explicitBlocked + legacyBlocked) {
      record.verdict = 'deny_pending_approval'
      delete record.wouldBlock
    }
    return record
  })
}

function reviewedMetrics(
  records: Record<string, unknown>[],
  ledger: HarvestReviewLedgerV1 | undefined = reviewLedger(),
) {
  return computeAuditMetrics(records, {
    mode: 'audit',
    unknownLocalEffect: 'deny',
    activeCohort: ACTIVE_COHORT,
    reviewLedger: ledger,
  })
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

  it('aggregates the current cohort across generations and exposes content-free storage diagnostics', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'belay-audit-metrics-generations-'))
    tempDirs.push(repoRoot)
    await initProject({ targetDir: repoRoot })
    const initialConfig = await loadConfigFile(repoRoot)
    const rotationMaxBytes = 1_024
    await writeTrustedConfigFile(repoRoot, {
      ...initialConfig,
      audit: { ...initialConfig.audit, maxBytes: rotationMaxBytes, maxFiles: 3 },
    })
    const config = await loadConfigFile(repoRoot)
    const cohort = await resolveActiveAuditCohort(repoRoot, config)
    expect(cohort).not.toBeNull()
    if (!cohort) {
      throw new Error('fixture active cohort unavailable')
    }

    const auditPath = path.join(repoRoot, config.audit.logPath)
    const generation = `${JSON.stringify(
      cohortGate({
        timestamp: '2026-09-08T00:00:00.000Z',
        fingerprint: REVIEWED_FINGERPRINT,
        sessionCorrelationId: VALID_SESSION_IDS[0],
        ...cohort,
      }),
    )}\n\n`
    const activeRecord = JSON.stringify(
      cohortGate({
        timestamp: '2026-09-08T00:00:01.000Z',
        fingerprint: REVIEWED_FINGERPRINT,
        sessionCorrelationId: VALID_SESSION_IDS[1],
        ...cohort,
      }),
    )
    const malformed = '{"private-malformed-marker":'
    const nonObject = '"private-non-object-marker"'
    const aboveRotationThreshold = JSON.stringify(
      cohortGate({
        timestamp: '2026-09-08T00:00:02.000Z',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        wouldBlock: true,
        summary: 'valid record above the rotation threshold',
        padding: 'x'.repeat(1_500),
        fingerprint: REVIEWED_FINGERPRINT,
        sessionCorrelationId: VALID_SESSION_IDS[2],
        ...cohort,
      }),
    )
    expect(Buffer.byteLength(`${aboveRotationThreshold}\n`, 'utf8')).toBeGreaterThan(
      rotationMaxBytes,
    )
    const active = `${activeRecord}\n${malformed}\n${nonObject}\n${aboveRotationThreshold}\n`
    await writeFile(`${auditPath}.1`, generation, 'utf8')
    await writeFile(auditPath, active, 'utf8')
    await writeFile(
      path.join(path.dirname(auditPath), 'harvest-reviews.json'),
      `${JSON.stringify(reviewLedger())}\n`,
      'utf8',
    )

    const report = await metricsProject({ targetDir: repoRoot })
    const formatted = formatMetricsReport(report)

    expect(report.auditStorage).toEqual({
      filesRead: 2,
      bytesRead: Buffer.byteLength(generation, 'utf8') + Buffer.byteLength(active, 'utf8'),
      parsedRecords: 3,
      malformedLines: 2,
      oversizedLines: 0,
    })
    expect(report.currentCohort.gateEvents).toBe(3)
    expect(report.currentCohort.wouldBlockCount).toBe(1)
    expect(report.currentCohort.reviewedTraffic.reviewedBenignEvents).toBe(3)
    expect(report.currentCohort.reviewedTraffic.reviewedBenignBlocked).toBe(1)
    expect(report.currentCohort.reviewedTraffic.distinctSessions).toBe(3)
    expect(formatted).toContain('Retained audit storage:')
    expect(formatted).toContain('- files read: 2')
    expect(formatted).toContain('- malformed lines skipped: 2')
    expect(formatted).toContain('- oversized lines skipped: 0')
    expect(formatted).not.toContain('private-malformed-marker')
    expect(formatted).not.toContain('private-non-object-marker')
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

  it.each([
    {
      name: '149 reviewed benign events across 3 sessions',
      events: reviewedBenignGateEvents(149),
      expectedEvents: 149,
      expectedSessions: 3,
      expectedBlocked: 0,
      expectedRate: 0,
      ready: false,
    },
    {
      name: '150 reviewed benign events across only 2 sessions',
      events: reviewedBenignGateEvents(150, {
        sessionIds: VALID_SESSION_IDS.slice(0, 2),
      }),
      expectedEvents: 150,
      expectedSessions: 2,
      expectedBlocked: 0,
      expectedRate: 0,
      ready: false,
    },
    {
      name: '150 reviewed benign events across 3 sessions with 2 blocks',
      events: reviewedBenignGateEvents(150, { explicitBlocked: 2 }),
      expectedEvents: 150,
      expectedSessions: 3,
      expectedBlocked: 2,
      expectedRate: 2 / 150,
      ready: true,
    },
    {
      name: '150 reviewed benign events across 3 sessions with exactly 3 blocks',
      events: reviewedBenignGateEvents(150, { explicitBlocked: 3 }),
      expectedEvents: 150,
      expectedSessions: 3,
      expectedBlocked: 3,
      expectedRate: 0.02,
      ready: false,
    },
  ])('$name applies every strict traffic-readiness boundary', (fixture) => {
    const report = reviewedMetrics(fixture.events)

    expect(report.currentCohort.reviewedTraffic).toEqual({
      reviewedBenignEvents: fixture.expectedEvents,
      reviewedBenignBlocked: fixture.expectedBlocked,
      benignBlockRate: fixture.expectedRate,
      distinctSessions: fixture.expectedSessions,
      availabilityAsks: 0,
      ready: fixture.ready,
    })
    expect(report.dogfood.readyForEnforce).toBe(fixture.ready)
  })

  it('requires zero availability asks across all active-cohort gate events', () => {
    const events = reviewedBenignGateEvents(150)
    events.push(
      cohortGate({
        fingerprint: testFingerprint('unreviewed-availability-event'),
        sessionCorrelationId: VALID_SESSION_IDS[0],
        verdict: 'deny_pending_approval',
        wouldBlock: true,
        reason: 'missing_trusted_cwd',
      }),
    )

    const report = reviewedMetrics(events)

    expect(report.currentCohort.reviewedTraffic.reviewedBenignEvents).toBe(150)
    expect(report.currentCohort.reviewedTraffic.availabilityAsks).toBe(1)
    expect(report.currentCohort.reviewedTraffic.ready).toBe(false)
  })

  it('does not admit accepted-benign reviews to the traffic denominator', () => {
    const report = reviewedMetrics(reviewedBenignGateEvents(150), reviewLedger('accepted-benign'))

    expect(report.currentCohort.reviewEvidencePresent).toBe(true)
    expect(report.currentCohort.reviewedTraffic.reviewedBenignEvents).toBe(0)
    expect(report.currentCohort.reviewedTraffic.ready).toBe(false)
  })

  it.each([
    ['accepted-benign', 'accepted-benign'],
    ['must-ask', 'must-ask'],
    ['reject', 'reject'],
  ] as const)('excludes %s review evidence from benign samples', (_name, outcome) => {
    const report = reviewedMetrics(reviewedBenignGateEvents(1), reviewLedger(outcome))

    expect(report.currentCohort.reviewedTraffic.reviewedBenignEvents).toBe(0)
    expect(report.currentCohort.reviewedTraffic.reviewedBenignBlocked).toBe(0)
  })

  it('fails closed when the active cohort or review ledger is missing', () => {
    const events = reviewedBenignGateEvents(150)
    const missingCohort = computeAuditMetrics(events, {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: null,
      reviewLedger: reviewLedger(),
    })
    const missingLedger = computeAuditMetrics(events, {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
    })
    const emptyLedger = reviewedMetrics(events, { version: 1, reviews: [] })

    expect(missingCohort.currentCohort.reviewedTraffic.ready).toBe(false)
    expect(missingLedger.currentCohort.reviewEvidencePresent).toBe(false)
    expect(missingLedger.currentCohort.reviewedTraffic.reviewedBenignEvents).toBe(0)
    expect(missingLedger.currentCohort.reviewedTraffic.ready).toBe(false)
    expect(emptyLedger.currentCohort.reviewEvidencePresent).toBe(false)
    expect(emptyLedger.currentCohort.reviewedTraffic.ready).toBe(false)
  })

  it('uses only the latest review for a fingerprint, kind, and boundary profile', () => {
    const events = reviewedBenignGateEvents(150)
    const acceptedLatest = reviewedMetrics(events, {
      version: 1,
      reviews: [
        ...reviewLedger('provably-benign', {
          reviewedAt: '2026-09-08T00:00:00.000Z',
        }).reviews,
        ...reviewLedger('accepted-benign', {
          reviewedAt: '2026-09-08T00:01:00.000Z',
        }).reviews,
      ],
    })
    const provableLatest = reviewedMetrics(events, {
      version: 1,
      reviews: [
        ...reviewLedger('accepted-benign', {
          reviewedAt: '2026-09-08T00:00:00.000Z',
        }).reviews,
        ...reviewLedger('provably-benign', {
          reviewedAt: '2026-09-08T00:01:00.000Z',
        }).reviews,
      ],
    })

    expect(acceptedLatest.currentCohort.reviewedTraffic.reviewedBenignEvents).toBe(0)
    expect(provableLatest.currentCohort.reviewedTraffic.reviewedBenignEvents).toBe(150)
  })

  it('joins review evidence only on the exact fingerprint, kind, and boundary profile', () => {
    const matching = reviewedBenignGateEvents(150)
    const wrongFingerprint = reviewedBenignGateEvents(1, {
      fingerprint: testFingerprint('wrong-fingerprint'),
    })
    const wrongKind = reviewedBenignGateEvents(1, { kind: 'tool' })
    const reviews: HarvestReviewLedgerV1 = {
      version: 1,
      reviews: [
        ...reviewLedger().reviews,
        ...reviewLedger('provably-benign', {
          fingerprint: testFingerprint('review-only-wrong-fingerprint'),
        }).reviews,
        ...reviewLedger('provably-benign', {
          boundaryProfile: 'future-boundary-profile',
        }).reviews,
      ],
    }

    const report = reviewedMetrics([...matching, ...wrongFingerprint, ...wrongKind], reviews)

    expect(report.currentCohort.reviewedTraffic.reviewedBenignEvents).toBe(150)
    expect(report.currentCohort.reviewedTraffic.distinctSessions).toBe(3)
  })

  it('counts only distinct valid lowercase 16-hex session hashes', () => {
    const events = reviewedBenignGateEvents(150, {
      sessionIds: [
        '1111111111111111',
        '2222222222222222',
        'ABCDEFABCDEFABCD',
        'short',
        'gggggggggggggggg',
      ],
    })

    const report = reviewedMetrics(events)

    expect(report.currentCohort.reviewedTraffic.reviewedBenignEvents).toBe(150)
    expect(report.currentCohort.reviewedTraffic.distinctSessions).toBe(2)
    expect(report.currentCohort.reviewedTraffic.ready).toBe(false)
  })

  it('uses canonical would-block inference for explicit and legacy verdict encodings', () => {
    const report = reviewedMetrics(
      reviewedBenignGateEvents(150, { explicitBlocked: 1, legacyBlocked: 1 }),
    )

    expect(report.currentCohort.reviewedTraffic.reviewedBenignBlocked).toBe(2)
    expect(report.currentCohort.reviewedTraffic.benignBlockRate).toBe(2 / 150)
    expect(report.currentCohort.reviewedTraffic.ready).toBe(true)
  })

  it('formats every reviewed traffic counter separately from raw cohort diagnostics', () => {
    const formatted = formatMetricsReport(
      reviewedMetrics(reviewedBenignGateEvents(150, { explicitBlocked: 2 })),
    )

    expect(formatted).toContain('Reviewed provably-benign traffic:')
    expect(formatted).toContain('- reviewed benign events: 150')
    expect(formatted).toContain('- reviewed benign blocked: 2 (1.33%)')
    expect(formatted).toContain('- distinct valid sessions: 3')
    expect(formatted).toContain('- active-cohort availability asks: 0')
    expect(formatted).toContain('- traffic ready for enforce: yes')
    expect(formatted).toContain('- would-block: 2 (1.3%)')
  })

  it('publishes the exact reviewed traffic thresholds', () => {
    expect(MIN_REVIEWED_BENIGN_EVENTS).toBe(150)
    expect(MIN_REVIEWED_SESSIONS).toBe(3)
    expect(MAX_BENIGN_BLOCK_RATE).toBe(0.02)
  })

  it('does not reuse old clean events as active-cohort readiness evidence', () => {
    const oldCleanEvents = Array.from({ length: LEGACY_DIAGNOSTIC_SAMPLE_COUNT }, () =>
      cohortGate({
        ...LEGACY_COHORT,
      }),
    )

    const report = computeAuditMetrics(oldCleanEvents, {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
    })

    expect(report.gateEvents).toBe(LEGACY_DIAGNOSTIC_SAMPLE_COUNT)
    expect(report.currentCohort.gateEvents).toBe(0)
    expect(report.currentCohort.excludedGateEvents).toBe(LEGACY_DIAGNOSTIC_SAMPLE_COUNT)
    expect(report.dogfood.readyForEnforce).toBe(false)
    expect(report.dogfood.notes.join(' ')).toContain(
      'No gate events for the active runtime/config cohort',
    )
  })

  it('ignores old noisy events when the active cohort is clean', () => {
    const oldNoisyEvents = Array.from({ length: LEGACY_DIAGNOSTIC_SAMPLE_COUNT }, () =>
      cohortGate({
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        wouldBlock: true,
        ...LEGACY_COHORT,
      }),
    )
    const currentCleanEvents = reviewedBenignGateEvents(150)

    const report = computeAuditMetrics([...oldNoisyEvents, ...currentCleanEvents], {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
      reviewLedger: reviewLedger(),
    })

    expect(report.gateEvents).toBe(LEGACY_DIAGNOSTIC_SAMPLE_COUNT + 150)
    expect(report.wouldBlockCount).toBe(LEGACY_DIAGNOSTIC_SAMPLE_COUNT)
    expect(report.currentCohort.gateEvents).toBe(150)
    expect(report.currentCohort.wouldBlockCount).toBe(0)
    expect(report.currentCohort.excludedGateEvents).toBe(LEGACY_DIAGNOSTIC_SAMPLE_COUNT)
    expect(report.dogfood.readyForEnforce).toBe(true)
  })

  it('labels all-time history separately from the current readiness cohort', () => {
    const oldEvent = cohortGate({
      ...LEGACY_COHORT,
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
      ...LEGACY_COHORT,
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
    const currentEvents = Array.from({ length: LEGACY_DIAGNOSTIC_SAMPLE_COUNT - 1 }, () =>
      cohortGate(),
    )
    const mismatchedConfigEvent = cohortGate({
      configFingerprint: 'different-config',
      decisionConfigFingerprint: 'different-decision-config',
    })

    const report = computeAuditMetrics([...currentEvents, mismatchedConfigEvent], {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
    })

    expect(report.currentCohort.gateEvents).toBe(LEGACY_DIAGNOSTIC_SAMPLE_COUNT - 1)
    expect(report.currentCohort.excludedGateEvents).toBe(1)
    expect(report.dogfood.readyForEnforce).toBe(false)
  })

  it('withholds readiness for an active-cohort availability ask', () => {
    const currentCleanEvents = Array.from({ length: LEGACY_DIAGNOSTIC_SAMPLE_COUNT - 1 }, () =>
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

    expect(report.currentCohort.gateEvents).toBe(LEGACY_DIAGNOSTIC_SAMPLE_COUNT)
    expect(report.currentCohort.availabilityAsks.total).toBe(1)
    expect(report.currentCohort.classifierWouldBlockRate).toBe(0)
    expect(report.dogfood.readyForEnforce).toBe(false)
    expect(report.dogfood.notes.join(' ')).toContain('Ready for enforce withheld')
  })

  it('fails closed when the active cohort identity is unavailable', () => {
    const report = computeAuditMetrics(
      Array.from({ length: LEGACY_DIAGNOSTIC_SAMPLE_COUNT }, () => cohortGate()),
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
        fingerprint: testFingerprint('fp-make'),
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
        fingerprint: testFingerprint('fp-make'),
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
        fingerprint: testFingerprint('fp-make'),
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
        fingerprint: testFingerprint('fp-cwd'),
      },
      {
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        reason: 'dynamic_cwd_transition',
        wouldBlock: true,
        fingerprint: testFingerprint('fp-dynamic-cwd'),
      },
      {
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        wouldBlock: true,
        judgeFallbackReason: 'eval_timeout',
        fingerprint: testFingerprint('fp-timeout'),
      },
      {
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        wouldBlock: true,
        judgeFallbackReason: 'cursor_cli_unavailable',
        fingerprint: testFingerprint('fp-fallback'),
      },
      {
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        reason: 'external_effect',
        wouldBlock: true,
        fingerprint: testFingerprint('fp-real'),
      },
    ].map(toAuditRecord)

    expect(computeAvailabilityAskCounts(records)).toEqual({
      total: 4,
      missingTrustedCwd: 1,
      dynamicCwdTransition: 1,
      judgeTimeout: 1,
      judgeFallback: 1,
    })
    expect(computeRepeatedFingerprintAsks(records)).toEqual([])

    const formatted = formatMetricsReport(computeAuditMetrics(records))
    expect(formatted).toContain('Availability-caused asks')
    expect(formatted).toContain('missing action/trusted cwd: 1')
    expect(formatted).toContain('dynamic cwd transition: 1')
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
      dynamicCwdTransition: 0,
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
        fingerprint: testFingerprint('fp-repeat'),
        summary: 'git status',
      },
      {
        event: 'beforeShellExecution',
        verdict: 'deny_pending_approval',
        reason: 'unknown_local_effect',
        wouldBlock: true,
        fingerprint: testFingerprint('fp-repeat'),
        summary: 'make build',
      },
    ].map(toAuditRecord)

    expect(computeRepeatedFingerprintAsks(records)).toEqual([
      {
        fingerprint: testFingerprint('fp-repeat'),
        summary: 'make build',
        reason: 'unknown_local_effect',
        askCount: 2,
      },
    ])
  })

  it('withholds readyForEnforce when availability-caused asks are present', () => {
    const report = computeAuditMetrics(
      Array.from({ length: LEGACY_DIAGNOSTIC_SAMPLE_COUNT }, () => ({
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

    expect(report.availabilityAsks.total).toBe(LEGACY_DIAGNOSTIC_SAMPLE_COUNT)
    expect(report.classifierWouldBlockCount).toBe(0)
    expect(report.dogfood.readyForEnforce).toBe(false)
    expect(report.dogfood.notes.join(' ')).toContain('Ready for enforce withheld')
  })

  it('formats repeated fingerprint asks in metrics output', () => {
    const fingerprint = testFingerprint('short-fp')
    const formatted = formatMetricsReport(
      computeAuditMetrics(
        [
          {
            event: 'beforeShellExecution',
            verdict: 'deny_pending_approval',
            reason: 'read_only',
            wouldBlock: true,
            fingerprint,
            summary: 'git status',
          },
          {
            event: 'beforeShellExecution',
            verdict: 'deny_pending_approval',
            reason: 'read_only',
            wouldBlock: true,
            fingerprint,
            summary: 'git status',
          },
        ].map(toAuditRecord),
      ),
    )

    expect(formatted).toContain('Repeated fingerprint asks')
    expect(formatted).toContain(`x2 ${fingerprint.slice(0, 12)}…: git status`)
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
          fingerprint: testFingerprint('fp-repeat'),
          summary: 'make build',
          ...ACTIVE_COHORT,
        },
        {
          event: 'beforeShellExecution',
          kind: 'shell',
          verdict: 'deny_pending_approval',
          reason: 'unknown_local_effect',
          wouldBlock: true,
          fingerprint: testFingerprint('fp-repeat'),
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
    const records = reviewedBenignGateEvents(150)
    records.push({
      event: 'beforeShellExecution',
      kind: 'shell',
      verdict: 'deny_pending_approval',
      fingerprint: testFingerprint('recovery-only-event'),
      transactional: false,
      transactionalSkipReason: 'dirty_worktree',
      recoveryFailClosed: true,
      ...ACTIVE_COHORT,
    })

    const report = computeAuditMetrics(records, {
      mode: 'audit',
      unknownLocalEffect: 'deny',
      activeCohort: ACTIVE_COHORT,
      reviewLedger: reviewLedger(),
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
