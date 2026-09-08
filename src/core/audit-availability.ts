import type { AuditRecord, AvailabilityAskCounts } from './audit-types.js'
import { GATE_EVENTS } from './audit-types.js'

function inferWouldBlock(record: AuditRecord): boolean {
  return typeof record.wouldBlock === 'boolean'
    ? record.wouldBlock
    : record.verdict === 'deny_pending_approval'
}

function isGateRecord(record: AuditRecord): boolean {
  return typeof record.event === 'string' && GATE_EVENTS.has(record.event)
}

function judgeFallbackReason(record: AuditRecord): string {
  return typeof record.judgeFallbackReason === 'string' ? record.judgeFallbackReason : ''
}

export function isAvailabilityCausedAsk(record: AuditRecord): boolean {
  if (!isGateRecord(record) || !inferWouldBlock(record)) return false
  return (
    record.reason === 'missing_trusted_cwd' ||
    record.reason === 'dynamic_cwd_transition' ||
    judgeFallbackReason(record).length > 0
  )
}

export function computeAvailabilityAskCounts(records: AuditRecord[]): AvailabilityAskCounts {
  const counts: AvailabilityAskCounts = {
    total: 0,
    missingTrustedCwd: 0,
    dynamicCwdTransition: 0,
    judgeTimeout: 0,
    judgeFallback: 0,
  }

  for (const record of records) {
    if (!isGateRecord(record) || !inferWouldBlock(record)) continue

    if (record.reason === 'missing_trusted_cwd') {
      counts.missingTrustedCwd += 1
      counts.total += 1
      continue
    }
    if (record.reason === 'dynamic_cwd_transition') {
      counts.dynamicCwdTransition += 1
      counts.total += 1
      continue
    }

    const fallback = judgeFallbackReason(record)
    if (!fallback) continue
    if (fallback.includes('timeout')) {
      counts.judgeTimeout += 1
    } else {
      counts.judgeFallback += 1
    }
    counts.total += 1
  }

  return counts
}
