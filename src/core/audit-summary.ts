import {
  auditToolInvocationCorrelationId,
  filterAuditRecords,
  inferWouldBlock,
  isApprovalRecorded,
  isGateRecord,
  parseTimestamp,
  recordStringField,
} from './audit-query.js'
import type { AuditFilter, AuditRecord } from './audit-types.js'

export type AuditTier = 'Tier0' | 'Tier1' | 'deterministic'

export interface RecentAskEntry {
  timestamp?: string
  summary: string
  reason: string
  tier: AuditTier
}

export interface RecentHostDenialEntry {
  gateTimestamp?: string
  failureTimestamp?: string
  summary: string
  errorMessage: string
}

export interface AuditVisibilitySummary {
  gateEvents: number
  askCount: number
  enforceAskCount: number
  auditAskCount: number
  unknownModeAskCount: number
  flagCount: number
  allowCount: number
  silentPassRate: number
  recentAsks: RecentAskEntry[]
  hostDeniedAfterAllowCount: number
  recentHostDenials: RecentHostDenialEntry[]
  unrecognizedHostFailureCount: number
}

export const DEFAULT_SILENT_PASS_THRESHOLD = 0.5
export const MIN_GATE_EVENTS_FOR_FENCE_DRIFT = 20

export interface FenceDriftOptions {
  threshold?: number
}

function isTier0Reason(reason: string): boolean {
  return reason.startsWith('tier0_') || reason === 'external_effect'
}

export function inferAuditTier(record: AuditRecord): AuditTier {
  const savedConfidence = typeof record.confidence === 'string' ? record.confidence : ''
  const reason = typeof record.reason === 'string' ? record.reason : ''

  if (savedConfidence === 'llm') {
    return 'Tier1'
  }
  if (savedConfidence === 'deterministic') {
    return isTier0Reason(reason) ? 'Tier0' : 'deterministic'
  }

  if (isTier0Reason(reason)) {
    return 'Tier0'
  }
  if (reason === 'unknown_local_effect') {
    return 'Tier1'
  }
  return 'deterministic'
}

export function formatAskBreakdown(
  summary: Pick<
    AuditVisibilitySummary,
    'askCount' | 'enforceAskCount' | 'auditAskCount' | 'unknownModeAskCount'
  >,
  indent = '',
): string[] {
  const lines = [
    `${indent}Ask (would-block): ${summary.askCount}`,
    `${indent}  enforce (blocked): ${summary.enforceAskCount}`,
    `${indent}  audit (would-block only): ${summary.auditAskCount}`,
  ]
  if (summary.unknownModeAskCount > 0) {
    lines.push(`${indent}  mode unknown (legacy): ${summary.unknownModeAskCount}`)
  }
  return lines
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
  const allGateRecords = records.filter(isGateEventRecord)
  const recentAskLimit = options.recentAskLimit ?? 10

  let askCount = 0
  let enforceAskCount = 0
  let auditAskCount = 0
  let unknownModeAskCount = 0
  let flagCount = 0
  let allowCount = 0
  const recentAsks: RecentAskEntry[] = []
  const allowedByInvocation = new Map<string, AuditRecord>()
  const recentHostDenials: RecentHostDenialEntry[] = []
  let unrecognizedHostFailureCount = 0
  const matchedHostDenials = new Set<string>()

  for (const record of allGateRecords) {
    const invocationId = auditToolInvocationCorrelationId(record)
    if (invocationId && !inferWouldBlock(record) && record.permission === 'allow') {
      const existing = allowedByInvocation.get(invocationId)
      const recordMs = parseTimestamp(record.timestamp) ?? Number.NEGATIVE_INFINITY
      const existingMs = existing
        ? (parseTimestamp(existing.timestamp) ?? Number.NEGATIVE_INFINITY)
        : Number.NEGATIVE_INFINITY
      if (!existing || recordMs >= existingMs) {
        allowedByInvocation.set(invocationId, record)
      }
    }
  }

  for (const record of gateRecords) {
    if (inferWouldBlock(record)) {
      askCount += 1
      const recordMode = recordStringField(record, 'mode')
      if (recordMode === 'enforce') {
        enforceAskCount += 1
      } else if (recordMode === 'audit') {
        auditAskCount += 1
      } else {
        unknownModeAskCount += 1
      }
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

  for (const record of filtered) {
    if (record.event !== 'postToolUseFailure') {
      continue
    }
    if (record.failureType !== 'permission_denied') {
      unrecognizedHostFailureCount += 1
      continue
    }
    const invocationId = auditToolInvocationCorrelationId(record)
    const gate = invocationId ? allowedByInvocation.get(invocationId) : undefined
    if (!gate) {
      continue
    }
    const gateMs = parseTimestamp(gate.timestamp)
    const failureMs = parseTimestamp(record.timestamp)
    if (gateMs !== null && failureMs !== null && failureMs < gateMs) {
      continue
    }
    if (invocationId && matchedHostDenials.has(invocationId)) {
      continue
    }
    if (invocationId) {
      matchedHostDenials.add(invocationId)
    }
    recentHostDenials.push({
      gateTimestamp: gate.timestamp,
      failureTimestamp: record.timestamp,
      summary: typeof gate.summary === 'string' ? gate.summary : '',
      errorMessage: typeof record.errorMessage === 'string' ? record.errorMessage : '',
    })
  }

  recentAsks.sort((left, right) => {
    const leftMs = parseTimestamp(left.timestamp) ?? 0
    const rightMs = parseTimestamp(right.timestamp) ?? 0
    return rightMs - leftMs
  })
  recentHostDenials.sort((left, right) => {
    const leftMs = parseTimestamp(left.failureTimestamp) ?? 0
    const rightMs = parseTimestamp(right.failureTimestamp) ?? 0
    return rightMs - leftMs
  })

  const gateEvents = gateRecords.length
  const silentPassRate = gateEvents > 0 ? (allowCount + flagCount) / gateEvents : 0

  return {
    gateEvents,
    askCount,
    enforceAskCount,
    auditAskCount,
    unknownModeAskCount,
    flagCount,
    allowCount,
    silentPassRate,
    recentAsks: recentAsks.slice(0, recentAskLimit),
    hostDeniedAfterAllowCount: recentHostDenials.length,
    recentHostDenials: recentHostDenials.slice(0, recentAskLimit),
    unrecognizedHostFailureCount,
  }
}

export function detectFenceDrift(
  summary: Pick<AuditVisibilitySummary, 'gateEvents' | 'silentPassRate'>,
  options: FenceDriftOptions = {},
): { warnings: string[]; notes: string[] } {
  const threshold = options.threshold ?? DEFAULT_SILENT_PASS_THRESHOLD
  const warnings: string[] = []
  const notes: string[] = []

  if (summary.gateEvents === 0) {
    return { warnings, notes }
  }

  if (summary.gateEvents < MIN_GATE_EVENTS_FOR_FENCE_DRIFT) {
    notes.push(
      `Fence drift check deferred: only ${summary.gateEvents} gate event(s) recorded (need at least ${MIN_GATE_EVENTS_FOR_FENCE_DRIFT} for a reliable silent-pass rate).`,
    )
    return { warnings, notes }
  }

  if (summary.silentPassRate < threshold) {
    warnings.push(
      `Silent-pass rate is ${(summary.silentPassRate * 100).toFixed(1)}% (below ${(threshold * 100).toFixed(0)}% threshold). ` +
        'This may indicate over-blocking (fence-like behavior). Use belay explain on recent asks to check for false positives.',
    )
  }

  return { warnings, notes }
}
