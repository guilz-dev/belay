import {
  filterAuditRecords,
  inferWouldBlock,
  isApprovalRecorded,
  isGateRecord,
  parseTimestamp,
} from './audit-query.js'
import type { AuditFilter, AuditRecord } from './audit-types.js'

export type AuditTier = 'Tier0' | 'Tier1' | 'deterministic'

export interface RecentAskEntry {
  timestamp?: string
  summary: string
  reason: string
  tier: AuditTier
}

export interface AuditVisibilitySummary {
  gateEvents: number
  askCount: number
  flagCount: number
  allowCount: number
  silentPassRate: number
  recentAsks: RecentAskEntry[]
}

export const DEFAULT_SILENT_PASS_THRESHOLD = 0.98
export const MIN_GATE_EVENTS_FOR_FENCE_DRIFT = 20

export function inferAuditTier(record: AuditRecord): AuditTier {
  const reason = typeof record.reason === 'string' ? record.reason : ''
  const confidence = typeof record.confidence === 'string' ? record.confidence : ''
  if (reason.startsWith('tier0_') || reason === 'external_effect') {
    return 'Tier0'
  }
  if (confidence === 'llm' || reason === 'unknown_local_effect') {
    return 'Tier1'
  }
  return 'deterministic'
}

function isGateEventRecord(record: AuditRecord): boolean {
  return isGateRecord(record) && !isApprovalRecorded(record)
}

export function summarizeAuditVisibility(
  records: AuditRecord[],
  filter: AuditFilter = {},
  options: { recentAskLimit?: number } = {},
): AuditVisibilitySummary {
  const filtered = filterAuditRecords(records, filter)
  const gateRecords = filtered.filter(isGateEventRecord)
  const recentAskLimit = options.recentAskLimit ?? 10

  let askCount = 0
  let flagCount = 0
  let allowCount = 0
  const recentAsks: RecentAskEntry[] = []

  for (const record of gateRecords) {
    if (inferWouldBlock(record)) {
      askCount += 1
      recentAsks.push({
        timestamp: record.timestamp,
        summary: typeof record.summary === 'string' ? record.summary : '',
        reason: typeof record.reason === 'string' ? record.reason : 'unknown',
        tier: inferAuditTier(record),
      })
    }
    if (record.verdict === 'allow_flagged') {
      flagCount += 1
    }
    if (record.verdict === 'allow') {
      allowCount += 1
    }
  }

  recentAsks.sort((left, right) => {
    const leftMs = parseTimestamp(left.timestamp) ?? 0
    const rightMs = parseTimestamp(right.timestamp) ?? 0
    return rightMs - leftMs
  })

  const gateEvents = gateRecords.length
  const silentPassRate = gateEvents > 0 ? (allowCount + flagCount) / gateEvents : 0

  return {
    gateEvents,
    askCount,
    flagCount,
    allowCount,
    silentPassRate,
    recentAsks: recentAsks.slice(0, recentAskLimit),
  }
}

export function detectFenceDrift(
  summary: Pick<AuditVisibilitySummary, 'gateEvents' | 'silentPassRate'>,
  threshold = DEFAULT_SILENT_PASS_THRESHOLD,
): string[] {
  const warnings: string[] = []
  if (summary.gateEvents < MIN_GATE_EVENTS_FOR_FENCE_DRIFT) {
    warnings.push(
      `Fence drift check deferred: only ${summary.gateEvents} gate event(s) recorded (need at least ${MIN_GATE_EVENTS_FOR_FENCE_DRIFT} for a reliable silent-pass rate).`,
    )
    return warnings
  }
  if (summary.silentPassRate < threshold) {
    warnings.push(
      `Silent-pass rate is ${(summary.silentPassRate * 100).toFixed(1)}% (below ${(threshold * 100).toFixed(0)}% expected). ` +
        'This may indicate over-blocking (fence-like behavior). Review recent asks with agent-belay report.',
    )
  }
  return warnings
}
