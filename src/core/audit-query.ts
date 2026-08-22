import {
  isValidApprovalCorrelationId,
  isValidAuditFingerprint,
  isValidAuditTimestamp,
} from './audit-serialize.js'
import type { ApprovalRoundTrip, AuditFilter, AuditRecord } from './audit-types.js'
import { GATE_EVENTS } from './audit-types.js'

export function toAuditRecord(value: Record<string, unknown>): AuditRecord {
  const record = { ...value } as AuditRecord
  if (record.by === 'v2') {
    record.by = 'verdict'
  }
  return record
}

export function parseTimestamp(value?: string): number | null {
  if (!value || !isValidAuditTimestamp(value)) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export function auditFingerprint(record: AuditRecord): string | undefined {
  if (typeof record.fingerprint !== 'string' || !isValidAuditFingerprint(record.fingerprint)) {
    return undefined
  }
  return record.fingerprint
}

export function auditApprovalCorrelationId(record: AuditRecord): string | undefined {
  if (
    typeof record.approvalCorrelationId === 'string' &&
    isValidApprovalCorrelationId(record.approvalCorrelationId)
  ) {
    return record.approvalCorrelationId
  }
  return undefined
}

export function isGateRecord(record: AuditRecord): boolean {
  return typeof record.event === 'string' && GATE_EVENTS.has(record.event)
}

export function isShellGateRecord(record: AuditRecord): boolean {
  return (
    isGateRecord(record) && (record.event === 'beforeShellExecution' || record.kind === 'shell')
  )
}

export function isApprovalRecorded(record: AuditRecord): boolean {
  return (
    (record.event === 'approval' ||
      (record.event === 'beforeSubmitPrompt' && record.reason === 'approval_recorded')) &&
    record.reason === 'approval_recorded'
  )
}

export function inferWouldBlock(record: AuditRecord): boolean {
  if (typeof record.wouldBlock === 'boolean') {
    return record.wouldBlock
  }
  return record.verdict === 'deny_pending_approval'
}

export function recordStringField(
  record: AuditRecord,
  field:
    | 'effect'
    | 'reason'
    | 'permission'
    | 'verdict'
    | 'mode'
    | 'summary'
    | 'fingerprint'
    | 'location',
): string {
  const value = record[field]
  return typeof value === 'string' ? value : ''
}

export function isSilentPassRecord(record: AuditRecord): boolean {
  const permission = recordStringField(record, 'permission')
  const verdict = recordStringField(record, 'verdict')
  return (
    permission === 'allow' ||
    permission === 'allow_flagged' ||
    verdict === 'allow' ||
    verdict === 'allow_flagged'
  )
}

export function filterAuditRecords(
  records: AuditRecord[],
  filter: AuditFilter = {},
): AuditRecord[] {
  const sinceMs = parseTimestamp(filter.since)
  const untilMs = parseTimestamp(filter.until)

  let filtered = records.filter((record) => {
    const timestampMs = parseTimestamp(record.timestamp)
    if (sinceMs !== null && (timestampMs === null || timestampMs < sinceMs)) {
      return false
    }
    if (untilMs !== null && (timestampMs === null || timestampMs > untilMs)) {
      return false
    }
    if (filter.verdict && record.verdict !== filter.verdict) {
      return false
    }
    if (filter.reason && record.reason !== filter.reason) {
      return false
    }
    if (filter.kind && record.kind !== filter.kind) {
      return false
    }
    if (filter.fingerprint && record.fingerprint !== filter.fingerprint) {
      return false
    }
    if (filter.event && record.event !== filter.event) {
      return false
    }
    if (filter.location && record.location !== filter.location) {
      return false
    }
    if (filter.opacity && record.opacity !== filter.opacity) {
      return false
    }
    if (filter.effect && record.effect !== filter.effect) {
      return false
    }
    if (filter.confidence && record.confidence !== filter.confidence) {
      return false
    }
    return true
  })

  if (typeof filter.limit === 'number' && filter.limit > 0) {
    filtered = filtered.slice(-filter.limit)
  }

  return filtered
}

export function buildApprovalRoundTrips(records: AuditRecord[]): ApprovalRoundTrip[] {
  const trips: ApprovalRoundTrip[] = []
  const pendingByCorrelationId = new Map<string, ApprovalRoundTrip>()
  const pendingByApprovalId = new Map<string, ApprovalRoundTrip>()
  const pendingByFingerprint = new Map<string, ApprovalRoundTrip>()

  for (const record of records) {
    const timestamp = record.timestamp ?? ''
    const fingerprint = auditFingerprint(record)
    const correlationId = auditApprovalCorrelationId(record)

    if (isGateRecord(record) && inferWouldBlock(record) && fingerprint) {
      const trip: ApprovalRoundTrip = {
        denyTimestamp: timestamp,
        fingerprint,
        reason: record.reason ?? 'unknown',
        summary: record.summary ?? '',
        kind: record.kind ?? 'unknown',
        approvalId: record.approvalId,
        approvalCorrelationId: correlationId,
      }
      trips.push(trip)
      if (correlationId) {
        pendingByCorrelationId.set(correlationId, trip)
      }
      if (record.approvalId && !String(record.approvalId).startsWith('<')) {
        pendingByApprovalId.set(record.approvalId, trip)
      }
      pendingByFingerprint.set(fingerprint, trip)
      continue
    }

    if (isApprovalRecorded(record)) {
      const trip =
        (correlationId ? pendingByCorrelationId.get(correlationId) : undefined) ??
        (record.approvalId ? pendingByApprovalId.get(record.approvalId) : undefined)
      if (trip) {
        trip.approvalTimestamp = timestamp
        const denyMs = parseTimestamp(trip.denyTimestamp)
        const approvalMs = parseTimestamp(timestamp)
        if (denyMs !== null && approvalMs !== null) {
          trip.approvalLatencyMs = approvalMs - denyMs
        }
      }
      continue
    }

    if (
      isGateRecord(record) &&
      record.reason === 'approved_once' &&
      fingerprint &&
      record.permission === 'allow'
    ) {
      const trip = correlationId
        ? pendingByCorrelationId.get(correlationId)
        : pendingByFingerprint.get(fingerprint)
      if (trip) {
        trip.executeTimestamp = timestamp
      }
    }
  }

  return trips
}

export function summarizeRoundTrips(trips: ApprovalRoundTrip[]): string[] {
  return trips.map((trip) => {
    const parts = [
      `[${trip.kind}] ${trip.summary}`,
      `denied(${trip.reason})`,
      trip.approvalTimestamp ? 'approved' : 'pending-approval',
      trip.executeTimestamp ? 'executed' : 'not-retried',
    ]
    if (typeof trip.approvalLatencyMs === 'number') {
      parts.push(`${Math.round(trip.approvalLatencyMs / 1000)}s latency`)
    }
    return parts.join(' → ')
  })
}
