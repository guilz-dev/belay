import type { ApprovalRoundTrip, AuditFilter, AuditRecord } from './audit-types.js'
import { GATE_EVENTS } from './audit-types.js'

export function toAuditRecord(value: Record<string, unknown>): AuditRecord {
  return value as AuditRecord
}

export function parseTimestamp(value?: string): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export function isGateRecord(record: AuditRecord): boolean {
  return typeof record.event === 'string' && GATE_EVENTS.has(record.event)
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
    return true
  })

  if (typeof filter.limit === 'number' && filter.limit > 0) {
    filtered = filtered.slice(-filter.limit)
  }

  return filtered
}

export function buildApprovalRoundTrips(records: AuditRecord[]): ApprovalRoundTrip[] {
  const trips: ApprovalRoundTrip[] = []
  const pendingByApprovalId = new Map<string, ApprovalRoundTrip>()
  const pendingByFingerprint = new Map<string, ApprovalRoundTrip>()

  for (const record of records) {
    const timestamp = record.timestamp ?? ''
    if (isGateRecord(record) && inferWouldBlock(record) && record.fingerprint) {
      const trip: ApprovalRoundTrip = {
        denyTimestamp: timestamp,
        fingerprint: record.fingerprint,
        reason: record.reason ?? 'unknown',
        summary: record.summary ?? '',
        kind: record.kind ?? 'unknown',
        approvalId: record.approvalId,
      }
      trips.push(trip)
      if (record.approvalId) {
        pendingByApprovalId.set(record.approvalId, trip)
      }
      pendingByFingerprint.set(record.fingerprint, trip)
      continue
    }

    if (isApprovalRecorded(record) && record.approvalId) {
      const trip = pendingByApprovalId.get(record.approvalId)
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
      record.fingerprint &&
      record.permission === 'allow'
    ) {
      const trip = pendingByFingerprint.get(record.fingerprint)
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
