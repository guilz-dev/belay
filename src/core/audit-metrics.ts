import { matchesAuditCohort } from '../runtime-provenance.js'
import {
  bucketGateEventsByDay,
  computeApprovalLatencyStats,
  computeApprovalRatioByReason,
  computeAvailabilityAskCounts,
  computeRepeatedFingerprintAsks,
  computeWouldBlockByReason,
  countVerdicts,
  detectBypassAttempts,
  detectNoisyRules,
} from './audit-analysis.js'
import {
  auditFingerprint,
  buildApprovalRoundTrips,
  filterAuditRecords,
  inferWouldBlock,
  isApprovalRecorded,
  toAuditRecord,
} from './audit-query.js'
import {
  computeRecoveryMetrics,
  type RecoveryMetrics,
  type RecoveryMetricsCohort,
} from './audit-recovery-metrics.js'
import { isValidSessionCorrelationId } from './audit-serialize.js'
import type {
  AvailabilityAskCounts,
  ReasonApprovalRatio,
  RepeatedFingerprintAsk,
} from './audit-types.js'
import { AUDIT_METRICS_SCHEMA_VERSION, GATE_EVENTS } from './audit-types.js'
import { type HarvestReviewLedgerV1, latestHarvestReviews } from './harvest-review.js'

export const MIN_REVIEWED_BENIGN_EVENTS = 150
export const MIN_REVIEWED_SESSIONS = 3
export const MAX_BENIGN_BLOCK_RATE = 0.02

export interface AuditCohortIdentity {
  runtimeArtifactHash: string
  decisionConfigFingerprint: string
  boundaryProfile: string
  /** Display / forensics metadata — not used for v3 cohort matching when artifact hash is present. */
  runtimeBuildStamp: string
  configFingerprint: string
}

export interface AuditMetricsCohort {
  identity: AuditCohortIdentity | null
  gateEvents: number
  excludedGateEvents: number
  wouldBlockCount: number
  wouldBlockRate: number
  classifierWouldBlockCount: number
  classifierWouldBlockRate: number
  approvalRecordedCount: number
  availabilityAsks: AvailabilityAskCounts
  wouldBlockByReason: Record<string, number>
  topWouldBlockSummaries: Array<{ summary: string; reason: string; count: number }>
  containedExecution: ContainedExecutionMetrics
  reviewEvidencePresent: boolean
  reviewedTraffic: ReviewedTrafficReadiness
}

export interface ReviewedTrafficReadiness {
  reviewedBenignEvents: number
  reviewedBenignBlocked: number
  benignBlockRate: number
  distinctSessions: number
  availabilityAsks: number
  ready: boolean
}

export interface ContainedExecutionMetrics {
  wouldMediate: number
  complete: number
  failed: number
  timedOut: number
}

export interface AuditMetricsReport {
  schemaVersion: number
  auditLogPath: string
  totalLines: number
  parsedRecords: number
  gateEvents: number
  wouldBlockCount: number
  wouldBlockRate: number
  classifierWouldBlockCount: number
  classifierWouldBlockRate: number
  wouldBlockByReason: Record<string, number>
  approvalRatioByReason: ReasonApprovalRatio[]
  availabilityAsks: AvailabilityAskCounts
  repeatedFingerprintAsks: RepeatedFingerprintAsk[]
  byReason: Record<string, number>
  byKind: Record<string, number>
  byVerdict: Record<string, number>
  byLocation: Record<string, number>
  byOpacity: Record<string, number>
  byEffect: Record<string, number>
  byConfidence: Record<string, number>
  gateEventsByRuntime: Record<string, number>
  currentCohort: AuditMetricsCohort
  approvalRecordedCount: number
  topWouldBlockSummaries: Array<{ summary: string; reason: string; count: number }>
  containedExecution: ContainedExecutionMetrics
  approvalLatency: {
    count: number
    medianMs: number | null
    p95Ms: number | null
  }
  gateEventsByDay: Record<string, number>
  bypassAttemptCount: number
  noisyRuleCandidates: Array<{
    reason: string
    denyCount: number
    approvedCount: number
    approvalRate: number
  }>
  dogfood: {
    mode: string | null
    unknownLocalEffect: string | null
    readyForEnforce: boolean
    notes: string[]
  }
  recovery: RecoveryMetrics
  currentCohortRecovery: RecoveryMetricsCohort
}

function containedExecutionMetrics(
  records: readonly Record<string, unknown>[],
): ContainedExecutionMetrics {
  return {
    wouldMediate: records.filter((record) => record.wouldMediate === true).length,
    complete: records.filter((record) => record.reason === 'contained_execution_complete').length,
    failed: records.filter((record) => record.reason === 'contained_execution_failed').length,
    timedOut: records.filter(
      (record) => record.reason === 'contained_execution_failed' && record.timedOut === true,
    ).length,
  }
}

export function parseAuditNdjson(raw: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    try {
      records.push(JSON.parse(trimmed) as Record<string, unknown>)
    } catch {
      // skip malformed lines
    }
  }
  return records
}

function increment(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1
}

export function computeAuditMetrics(
  records: Record<string, unknown>[],
  options: {
    auditLogPath?: string
    mode?: string
    unknownLocalEffect?: string
    activeCohort?: AuditCohortIdentity | null
    reviewLedger?: HarvestReviewLedgerV1
  } = {},
): AuditMetricsReport {
  const auditRecords = records.map(toAuditRecord)
  const byReason: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  const byLocation: Record<string, number> = {}
  const byOpacity: Record<string, number> = {}
  const byEffect: Record<string, number> = {}
  const byConfidence: Record<string, number> = {}
  const gateEventsByRuntime: Record<string, number> = {}
  const summaryCounts = new Map<string, { summary: string; reason: string; count: number }>()
  let gateEvents = 0
  let wouldBlockCount = 0
  let approvalRecordedCount = 0

  for (const record of auditRecords) {
    const event = typeof record.event === 'string' ? record.event : ''
    if (isApprovalRecorded(record)) {
      approvalRecordedCount += 1
      continue
    }
    if (!GATE_EVENTS.has(event)) {
      continue
    }

    gateEvents += 1
    const runtimeBuild =
      typeof record.runtimeBuildStamp === 'string'
        ? record.runtimeBuildStamp
        : typeof record.runtimeVersion === 'string'
          ? record.runtimeVersion
          : 'unrecorded'
    increment(gateEventsByRuntime, runtimeBuild)
    const reason = typeof record.reason === 'string' ? record.reason : 'unknown'
    const kind = typeof record.kind === 'string' ? record.kind : 'unknown'
    increment(byReason, reason)
    increment(byKind, kind)
    if (typeof record.location === 'string') {
      increment(byLocation, record.location)
    }
    if (typeof record.opacity === 'string') {
      increment(byOpacity, record.opacity)
    }
    if (typeof record.effect === 'string') {
      increment(byEffect, record.effect)
    }
    if (typeof record.confidence === 'string') {
      increment(byConfidence, record.confidence)
    }

    if (inferWouldBlock(record)) {
      wouldBlockCount += 1
      const summary = typeof record.summary === 'string' ? record.summary : ''
      const key = `${reason}::${summary}`
      const existing = summaryCounts.get(key)
      if (existing) {
        existing.count += 1
      } else {
        summaryCounts.set(key, { summary, reason, count: 1 })
      }
    }
  }

  const byVerdict = countVerdicts(auditRecords)
  const roundTrips = buildApprovalRoundTrips(auditRecords)
  const approvalLatency = computeApprovalLatencyStats(roundTrips)
  const bypassAttempts = detectBypassAttempts(auditRecords)
  const noisyRuleCandidates = detectNoisyRules(auditRecords, roundTrips)
  const wouldBlockByReason = computeWouldBlockByReason(auditRecords)
  const approvalRatioByReason = computeApprovalRatioByReason(auditRecords, roundTrips)
  const availabilityAsks = computeAvailabilityAskCounts(auditRecords)
  const repeatedFingerprintAsks = computeRepeatedFingerprintAsks(auditRecords)

  const wouldBlockRate = gateEvents > 0 ? wouldBlockCount / gateEvents : 0
  const classifierWouldBlockCount = Math.max(0, wouldBlockCount - availabilityAsks.total)
  const classifierWouldBlockRate = gateEvents > 0 ? classifierWouldBlockCount / gateEvents : 0
  const topWouldBlockSummaries = [...summaryCounts.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 10)

  const activeCohort = options.activeCohort ?? null
  const cohortRecords = activeCohort
    ? auditRecords.filter((record) => matchesAuditCohort(record, activeCohort))
    : []
  const cohortGateRecords = cohortRecords.filter((record) => {
    const event = typeof record.event === 'string' ? record.event : ''
    return GATE_EVENTS.has(event) && !isApprovalRecorded(record)
  })
  const cohortGateEvents = cohortGateRecords.length
  const cohortWouldBlockCount = cohortGateRecords.filter(inferWouldBlock).length
  const cohortWouldBlockRate = cohortGateEvents > 0 ? cohortWouldBlockCount / cohortGateEvents : 0
  const cohortApprovalRecordedCount = cohortRecords.filter(isApprovalRecorded).length
  const cohortAvailabilityAsks = computeAvailabilityAskCounts(cohortRecords)
  const cohortClassifierWouldBlockCount = Math.max(
    0,
    cohortWouldBlockCount - cohortAvailabilityAsks.total,
  )
  const cohortClassifierWouldBlockRate =
    cohortGateEvents > 0 ? cohortClassifierWouldBlockCount / cohortGateEvents : 0
  const cohortRoundTrips = buildApprovalRoundTrips(cohortRecords)
  const cohortRepeatedFingerprintAsks = computeRepeatedFingerprintAsks(cohortRecords)
  const cohortNoisyRuleCandidates = detectNoisyRules(cohortRecords, cohortRoundTrips)
  const cohortWouldBlockByReason = computeWouldBlockByReason(cohortRecords)
  const cohortSummaryCounts = new Map<string, { summary: string; reason: string; count: number }>()
  for (const record of cohortGateRecords) {
    if (!inferWouldBlock(record)) {
      continue
    }
    const reason = typeof record.reason === 'string' ? record.reason : 'unknown'
    const summary = typeof record.summary === 'string' ? record.summary : ''
    const key = `${reason}::${summary}`
    const existing = cohortSummaryCounts.get(key)
    if (existing) {
      existing.count += 1
    } else {
      cohortSummaryCounts.set(key, { summary, reason, count: 1 })
    }
  }
  const cohortTopWouldBlockSummaries = [...cohortSummaryCounts.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 10)

  const latestReviews = options.reviewLedger
    ? latestHarvestReviews(options.reviewLedger)
    : new Map()
  const reviewEvidencePresent = latestReviews.size > 0
  const reviewedBenignRecords = cohortGateRecords.filter((record) => {
    const fingerprint = auditFingerprint(record)
    const kind = typeof record.kind === 'string' ? record.kind : undefined
    const boundaryProfile =
      typeof record.boundaryProfile === 'string' ? record.boundaryProfile : undefined
    if (!fingerprint || !kind || !boundaryProfile) {
      return false
    }
    const review = latestReviews.get(`${fingerprint}\u0000${kind}\u0000${boundaryProfile}`)
    return review?.outcome === 'provably-benign'
  })
  const reviewedBenignEvents = reviewedBenignRecords.length
  const reviewedBenignBlocked = reviewedBenignRecords.filter(inferWouldBlock).length
  const benignBlockRate =
    reviewedBenignEvents > 0 ? reviewedBenignBlocked / reviewedBenignEvents : 0
  const reviewedSessionIds = new Set<string>()
  for (const record of reviewedBenignRecords) {
    const sessionId = record.sessionCorrelationId
    if (typeof sessionId === 'string' && isValidSessionCorrelationId(sessionId)) {
      reviewedSessionIds.add(sessionId)
    }
  }
  const reviewedTraffic: ReviewedTrafficReadiness = {
    reviewedBenignEvents,
    reviewedBenignBlocked,
    benignBlockRate,
    distinctSessions: reviewedSessionIds.size,
    availabilityAsks: cohortAvailabilityAsks.total,
    ready:
      activeCohort !== null &&
      reviewEvidencePresent &&
      reviewedBenignEvents >= MIN_REVIEWED_BENIGN_EVENTS &&
      reviewedSessionIds.size >= MIN_REVIEWED_SESSIONS &&
      benignBlockRate < MAX_BENIGN_BLOCK_RATE &&
      cohortAvailabilityAsks.total === 0,
  }
  const currentCohort: AuditMetricsCohort = {
    identity: activeCohort,
    gateEvents: cohortGateEvents,
    excludedGateEvents: gateEvents - cohortGateEvents,
    wouldBlockCount: cohortWouldBlockCount,
    wouldBlockRate: cohortWouldBlockRate,
    classifierWouldBlockCount: cohortClassifierWouldBlockCount,
    classifierWouldBlockRate: cohortClassifierWouldBlockRate,
    approvalRecordedCount: cohortApprovalRecordedCount,
    availabilityAsks: cohortAvailabilityAsks,
    wouldBlockByReason: cohortWouldBlockByReason,
    topWouldBlockSummaries: cohortTopWouldBlockSummaries,
    containedExecution: containedExecutionMetrics(cohortGateRecords),
    reviewEvidencePresent,
    reviewedTraffic,
  }

  const mode = options.mode ?? null
  const unknownLocalEffect = options.unknownLocalEffect ?? null
  const notes: string[] = []
  const readyForEnforce = reviewedTraffic.ready

  if (mode === 'audit' && unknownLocalEffect === 'deny') {
    notes.push('Dogfood config detected: audit mode with fail-closed shell policy.')
    if (!activeCohort) {
      notes.push(
        'Active runtime provenance is unavailable — readiness cannot use historical audit evidence.',
      )
    }
    if (activeCohort && cohortGateEvents === 0) {
      notes.push(
        'No gate events for the active runtime/config cohort — run normal agent work, then re-check metrics.',
      )
    }
    if (activeCohort && cohortWouldBlockCount > 0) {
      notes.push(
        `${cohortWouldBlockCount} active-cohort would-block event(s) (${(cohortWouldBlockRate * 100).toFixed(1)}% of gate traffic; classifier-quality ${(cohortClassifierWouldBlockRate * 100).toFixed(1)}%). Review top summaries and correct EffectPlan semantics or resource scope; use exact approval only when the modeled effects are correct.`,
      )
      if (cohortApprovalRecordedCount > 0) {
        notes.push(
          `${cohortApprovalRecordedCount} active-cohort approval(s) recorded — these likely indicate actions operators wanted.`,
        )
      } else {
        notes.push(
          'Review top would-block summaries and correct EffectPlan semantics or resource scope before switching to enforce.',
        )
      }
    }
    if (!reviewEvidencePresent) {
      notes.push('Review evidence is missing — reviewed traffic readiness is unavailable.')
    }
    if (reviewedBenignEvents < MIN_REVIEWED_BENIGN_EVENTS) {
      notes.push(
        `Reviewed provably-benign events: ${reviewedBenignEvents} (required: at least ${MIN_REVIEWED_BENIGN_EVENTS}).`,
      )
    }
    if (reviewedSessionIds.size < MIN_REVIEWED_SESSIONS) {
      notes.push(
        `Distinct valid reviewed sessions: ${reviewedSessionIds.size} (required: at least ${MIN_REVIEWED_SESSIONS}).`,
      )
    }
    if (reviewedBenignEvents > 0 && benignBlockRate >= MAX_BENIGN_BLOCK_RATE) {
      notes.push(
        `Reviewed benign block rate: ${(benignBlockRate * 100).toFixed(2)}% (required: below ${(MAX_BENIGN_BLOCK_RATE * 100).toFixed(2)}%).`,
      )
    }
  } else if (mode !== 'audit') {
    notes.push('Config is not in audit mode — metrics show enforce-time behavior.')
  } else {
    notes.push('Set policy.unknownLocalEffect to "deny" to dogfood fail-closed defaults.')
  }

  if (cohortAvailabilityAsks.total > 0) {
    notes.push(
      `${cohortAvailabilityAsks.total} active-cohort availability-caused ask(s) — tune infrastructure before changing Effect semantics.`,
    )
    notes.push('Ready for enforce withheld while availability-caused asks are present.')
  }

  if (cohortRepeatedFingerprintAsks.length > 0) {
    notes.push(
      `${cohortRepeatedFingerprintAsks.length} active-cohort repeated fingerprint ask pattern(s) — review EffectPlan semantics and exact approval history.`,
    )
  }

  if (cohortNoisyRuleCandidates.length > 0) {
    notes.push(
      `${cohortNoisyRuleCandidates.length} active-cohort noisy rule candidate(s) — high deny-then-approve rate.`,
    )
  }

  const recoveryMetrics = computeRecoveryMetrics(auditRecords, { activeCohort })

  return {
    schemaVersion: AUDIT_METRICS_SCHEMA_VERSION,
    auditLogPath: options.auditLogPath ?? 'belay/audit.ndjson',
    totalLines: records.length,
    parsedRecords: records.length,
    gateEvents,
    wouldBlockCount,
    wouldBlockRate,
    classifierWouldBlockCount,
    classifierWouldBlockRate,
    wouldBlockByReason,
    approvalRatioByReason,
    availabilityAsks,
    repeatedFingerprintAsks,
    byReason,
    byKind,
    byVerdict,
    byLocation,
    byOpacity,
    byEffect,
    byConfidence,
    gateEventsByRuntime,
    currentCohort,
    approvalRecordedCount,
    topWouldBlockSummaries,
    containedExecution: containedExecutionMetrics(auditRecords),
    approvalLatency,
    gateEventsByDay: bucketGateEventsByDay(auditRecords),
    bypassAttemptCount: bypassAttempts.length,
    noisyRuleCandidates,
    dogfood: {
      mode,
      unknownLocalEffect,
      readyForEnforce,
      notes,
    },
    recovery: recoveryMetrics.allTime,
    currentCohortRecovery: recoveryMetrics.currentCohort,
  }
}

export { buildApprovalRoundTrips, filterAuditRecords, toAuditRecord }
