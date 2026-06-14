import {
  filterAuditRecords,
  inferWouldBlock,
  isApprovalRecorded,
  isGateRecord,
  isSilentPassRecord,
  parseTimestamp,
  recordStringField,
} from './audit-query.js'
import type { AuditRecord } from './audit-types.js'
import type { RecoverTargetInput } from './recover-advice.js'

export interface RecoverSelectOptions {
  since?: string
  fingerprint?: string
  limit?: number
}

function isRecoverCandidate(record: AuditRecord): boolean {
  if (!isGateRecord(record) || isApprovalRecorded(record)) {
    return false
  }
  if (inferWouldBlock(record)) {
    return true
  }
  const effect = recordStringField(record, 'effect')
  return effect === 'local_mutation' || effect === 'external_effect'
}

export function recoverCandidatePriority(record: AuditRecord): number {
  const effect = recordStringField(record, 'effect')

  if (effect === 'local_mutation') {
    return isSilentPassRecord(record) ? 0 : 1
  }
  if (inferWouldBlock(record) || effect === 'external_effect') {
    return 2
  }
  return 3
}

function compareRecoverCandidates(left: AuditRecord, right: AuditRecord): number {
  const priorityDelta = recoverCandidatePriority(left) - recoverCandidatePriority(right)
  if (priorityDelta !== 0) {
    return priorityDelta
  }
  const leftMs = parseTimestamp(left.timestamp) ?? 0
  const rightMs = parseTimestamp(right.timestamp) ?? 0
  return rightMs - leftMs
}

export function recordToRecoverTarget(record: AuditRecord): RecoverTargetInput {
  return {
    timestamp: record.timestamp,
    fingerprint: recordStringField(record, 'fingerprint') || undefined,
    summary: recordStringField(record, 'summary'),
    reason: recordStringField(record, 'reason') || 'unknown',
    effect: recordStringField(record, 'effect') || undefined,
    location: recordStringField(record, 'location') || undefined,
    permission: recordStringField(record, 'permission') || undefined,
    assessment: record.assessment,
  }
}

export function selectRecoverTarget(
  records: AuditRecord[],
  options: RecoverSelectOptions = {},
): RecoverTargetInput | null {
  const filtered = filterAuditRecords(records, {
    since: options.since,
    fingerprint: options.fingerprint,
  })
  const candidates = filtered.filter(isRecoverCandidate)
  if (candidates.length === 0) {
    return null
  }

  candidates.sort(compareRecoverCandidates)

  const limit = options.limit ?? 1
  const index = Math.min(limit, candidates.length) - 1
  const selected = candidates[index] ?? candidates[0]
  if (!selected) {
    return null
  }
  return recordToRecoverTarget(selected)
}
