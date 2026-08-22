import type { AuditCohortIdentity } from './audit-metrics.js'
import type { AuditRecord } from './audit-types.js'
import { GATE_EVENTS } from './audit-types.js'
import { matchesAuditCohort } from '../runtime-provenance.js'

const RESTORE_EVENTS = new Set(['recoveryApplied', 'recoveryConflict', 'recoveryRejected'])

const STABLE_FAILURE_REASON = /^[a-z][a-z0-9_]*$/

export interface RecoverySnapshotMetrics {
  attempts: number
  applied: number
  skipped: number
  byBackend: Record<string, number>
  byResourceKind: Record<string, number>
  prepareSampleCount: number
  prepareMsP50: number | null
  prepareMsP95: number | null
  failuresByReason: Record<string, number>
}

export interface RecoveryRestoreMetrics {
  applied: number
  conflict: number
  rejected: number
}

export interface RecoveryMetrics {
  snapshot: RecoverySnapshotMetrics
  restore: RecoveryRestoreMetrics
}

export interface RecoveryMetricsCohort extends RecoveryMetrics {
  excludedSnapshotAttempts: number
  excludedRestoreEvents: number
}

function increment(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null
  }
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? null
}

export function sanitizeRecoveryFailureReason(record: AuditRecord): string {
  const reason = record.transactionalSkipReason ?? record.reason
  if (typeof reason === 'string' && STABLE_FAILURE_REASON.test(reason)) {
    return reason
  }
  return 'transactional_execution_failed'
}

function isRecoverySnapshotRecord(record: AuditRecord): boolean {
  if (typeof record.transactional === 'boolean') {
    return true
  }
  if (typeof record.transactionalSkipReason === 'string') {
    return true
  }
  if (record.recoveryFailClosed === true) {
    return true
  }
  return false
}

function isRecoveryRestoreRecord(record: AuditRecord): boolean {
  const event = typeof record.event === 'string' ? record.event : ''
  return RESTORE_EVENTS.has(event)
}

function matchesCohort(record: AuditRecord, cohort: AuditCohortIdentity): boolean {
  return matchesAuditCohort(record, cohort)
}

function emptySnapshotMetrics(): RecoverySnapshotMetrics {
  return {
    attempts: 0,
    applied: 0,
    skipped: 0,
    byBackend: {},
    byResourceKind: {},
    prepareSampleCount: 0,
    prepareMsP50: null,
    prepareMsP95: null,
    failuresByReason: {},
  }
}

function emptyRestoreMetrics(): RecoveryRestoreMetrics {
  return {
    applied: 0,
    conflict: 0,
    rejected: 0,
  }
}

function isRecoverySnapshotApplied(record: AuditRecord): boolean {
  return (
    record.transactional === true &&
    (record.reason === 'transactional_already_applied' ||
      typeof record.recoveryCheckpointId === 'string' ||
      record.recoveryState === 'applied')
  )
}

function computeSnapshotMetrics(records: AuditRecord[]): RecoverySnapshotMetrics {
  const metrics = emptySnapshotMetrics()
  const prepareSamples: number[] = []

  for (const record of records) {
    const event = typeof record.event === 'string' ? record.event : ''
    if (!GATE_EVENTS.has(event)) {
      continue
    }
    if (!isRecoverySnapshotRecord(record)) {
      continue
    }

    metrics.attempts += 1
    if (isRecoverySnapshotApplied(record)) {
      metrics.applied += 1
    } else {
      metrics.skipped += 1
      if (record.transactionalReason === 'transactional_observed_risk') {
        increment(metrics.failuresByReason, 'transactional_observed_risk')
      } else {
        increment(metrics.failuresByReason, sanitizeRecoveryFailureReason(record))
      }
    }

    const backend =
      typeof record.transactionalBackend === 'string' ? record.transactionalBackend : 'unknown'
    increment(metrics.byBackend, backend)

    const resourceKind = typeof record.resourceKind === 'string' ? record.resourceKind : 'unknown'
    increment(metrics.byResourceKind, resourceKind)

    if (typeof record.snapshotPrepareMs === 'number' && Number.isFinite(record.snapshotPrepareMs)) {
      prepareSamples.push(record.snapshotPrepareMs)
    }
  }

  prepareSamples.sort((left, right) => left - right)
  metrics.prepareSampleCount = prepareSamples.length
  metrics.prepareMsP50 = percentile(prepareSamples, 50)
  metrics.prepareMsP95 = percentile(prepareSamples, 95)
  return metrics
}

function computeRestoreMetrics(records: AuditRecord[]): RecoveryRestoreMetrics {
  const metrics = emptyRestoreMetrics()
  for (const record of records) {
    const event = typeof record.event === 'string' ? record.event : ''
    if (event === 'recoveryApplied') {
      metrics.applied += 1
    } else if (event === 'recoveryConflict') {
      metrics.conflict += 1
    } else if (event === 'recoveryRejected') {
      metrics.rejected += 1
    }
  }
  return metrics
}

export function computeRecoveryMetrics(
  records: AuditRecord[],
  options: { activeCohort?: AuditCohortIdentity | null } = {},
): { allTime: RecoveryMetrics; currentCohort: RecoveryMetricsCohort } {
  const gateSnapshotRecords = records.filter((record) => {
    const event = typeof record.event === 'string' ? record.event : ''
    return GATE_EVENTS.has(event) && isRecoverySnapshotRecord(record)
  })
  const restoreRecords = records.filter(isRecoveryRestoreRecord)

  const activeCohort = options.activeCohort ?? null
  const cohortGateSnapshotRecords = activeCohort
    ? gateSnapshotRecords.filter((record) => matchesCohort(record, activeCohort))
    : []
  const cohortRestoreRecords = activeCohort
    ? restoreRecords.filter((record) => matchesCohort(record, activeCohort))
    : []

  return {
    allTime: {
      snapshot: computeSnapshotMetrics(gateSnapshotRecords),
      restore: computeRestoreMetrics(restoreRecords),
    },
    currentCohort: {
      snapshot: computeSnapshotMetrics(cohortGateSnapshotRecords),
      restore: computeRestoreMetrics(cohortRestoreRecords),
      excludedSnapshotAttempts: gateSnapshotRecords.length - cohortGateSnapshotRecords.length,
      excludedRestoreEvents: restoreRecords.length - cohortRestoreRecords.length,
    },
  }
}
