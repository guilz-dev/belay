import type { CorpusCase, CorpusCategory } from '../corpus/types.js'
import { computeRepeatedFingerprintAsks, isAvailabilityCausedAsk } from './audit-analysis.js'
import {
  buildApprovalRoundTrips,
  inferWouldBlock,
  isApprovalRecorded,
  isGateRecord,
} from './audit-query.js'
import type { AuditRecord } from './audit-types.js'

export const HARVEST_REPORT_SCHEMA_VERSION = 1

export type HarvestCandidateSource = 'deny_then_approve' | 'repeated_ask' | 'read_style_signal'

export type HarvestReviewOutcome = 'provably-benign' | 'accepted-benign' | 'reject'

export interface HarvestCandidate {
  kind: 'shell'
  command: string
  fingerprint: string
  reason: string
  sources: HarvestCandidateSource[]
  askCount: number
  approvedAfterDeny: boolean
}

export type AvailabilitySignal = 'missing_trusted_cwd' | 'judge_timeout' | 'judge_fallback'

export interface AvailabilityQueueItem {
  kind: 'shell'
  command: string
  fingerprint: string
  reason: string
  availabilitySignal: AvailabilitySignal
  judgeFallbackReason?: string
  askCount: number
}

export interface HarvestReport {
  schemaVersion: typeof HARVEST_REPORT_SCHEMA_VERSION
  /** Initial harvest scope — shell audit traces only. */
  scope: 'shell'
  candidates: HarvestCandidate[]
  availabilityQueue: AvailabilityQueueItem[]
}

const READ_STYLE_COMMAND_PATTERN =
  /^\s*(git\s+status|git\s+diff|git\s+log|git\s+show|ls\b|cat\b|head\b|tail\b|find\b|rg\b|grep\b|fd\b|bat\b|less\b|more\b|pwd\b|whoami\b|env\b|printenv\b|npm\s+(test|run\s+test)|pnpm\s+(test|run\s+test)|yarn\s+test)/

function isShellGateRecord(record: AuditRecord): boolean {
  return (
    isGateRecord(record) && (record.event === 'beforeShellExecution' || record.kind === 'shell')
  )
}

function shellRecords(records: AuditRecord[]): AuditRecord[] {
  return records.filter(isShellGateRecord)
}

function availabilitySignal(record: AuditRecord): AvailabilitySignal | null {
  if (!isAvailabilityCausedAsk(record)) {
    return null
  }
  if (record.reason === 'missing_trusted_cwd') {
    return 'missing_trusted_cwd'
  }
  const fallback = typeof record.judgeFallbackReason === 'string' ? record.judgeFallbackReason : ''
  if (fallback.includes('timeout')) {
    return 'judge_timeout'
  }
  return 'judge_fallback'
}

function commandFromRecord(record: AuditRecord): string {
  return (record.summary ?? '').trim()
}

function hasReadStyleSignal(summary: string): boolean {
  return READ_STYLE_COMMAND_PATTERN.test(summary)
}

function upsertCandidate(
  map: Map<string, HarvestCandidate>,
  params: {
    fingerprint: string
    command: string
    reason: string
    source: HarvestCandidateSource
    askCount?: number
    approvedAfterDeny?: boolean
  },
): void {
  const existing = map.get(params.fingerprint)
  if (existing) {
    if (!existing.sources.includes(params.source)) {
      existing.sources.push(params.source)
    }
    existing.askCount = Math.max(existing.askCount, params.askCount ?? 1)
    existing.approvedAfterDeny = existing.approvedAfterDeny || Boolean(params.approvedAfterDeny)
    if (params.command) {
      existing.command = params.command
    }
    if (params.reason) {
      existing.reason = params.reason
    }
    return
  }

  map.set(params.fingerprint, {
    kind: 'shell',
    command: params.command,
    fingerprint: params.fingerprint,
    reason: params.reason,
    sources: [params.source],
    askCount: params.askCount ?? 1,
    approvedAfterDeny: Boolean(params.approvedAfterDeny),
  })
}

export function extractAvailabilityQueue(records: AuditRecord[]): AvailabilityQueueItem[] {
  const grouped = new Map<string, AvailabilityQueueItem>()

  for (const record of shellRecords(records)) {
    if (!inferWouldBlock(record) || !record.fingerprint) {
      continue
    }
    const signal = availabilitySignal(record)
    if (!signal) {
      continue
    }

    const fingerprint = record.fingerprint
    const existing = grouped.get(fingerprint)
    if (existing) {
      existing.askCount += 1
      existing.command = commandFromRecord(record) || existing.command
      existing.reason = record.reason ?? existing.reason
      continue
    }

    grouped.set(fingerprint, {
      kind: 'shell',
      command: commandFromRecord(record),
      fingerprint,
      reason: record.reason ?? 'unknown',
      availabilitySignal: signal,
      ...(typeof record.judgeFallbackReason === 'string'
        ? { judgeFallbackReason: record.judgeFallbackReason }
        : {}),
      askCount: 1,
    })
  }

  return [...grouped.values()].sort((left, right) => right.askCount - left.askCount)
}

function recordsForShellRoundTrips(records: AuditRecord[]): AuditRecord[] {
  return records.filter(
    (record) =>
      isApprovalRecorded(record) ||
      (isShellGateRecord(record) && inferWouldBlock(record) && !isAvailabilityCausedAsk(record)),
  )
}

export function extractHarvestCandidates(records: AuditRecord[]): HarvestCandidate[] {
  const shellOnly = shellRecords(records)
  const classifierAsks = shellOnly.filter(
    (record) => inferWouldBlock(record) && !isAvailabilityCausedAsk(record),
  )
  const map = new Map<string, HarvestCandidate>()

  const roundTrips = buildApprovalRoundTrips(recordsForShellRoundTrips(records)).filter(
    (trip) => trip.kind === 'shell' || trip.kind === 'unknown',
  )
  for (const trip of roundTrips) {
    if (!trip.fingerprint || !trip.approvalTimestamp) {
      continue
    }
    upsertCandidate(map, {
      fingerprint: trip.fingerprint,
      command: trip.summary,
      reason: trip.reason,
      source: 'deny_then_approve',
      approvedAfterDeny: true,
    })
  }

  for (const entry of computeRepeatedFingerprintAsks(classifierAsks, 2, 50)) {
    upsertCandidate(map, {
      fingerprint: entry.fingerprint,
      command: entry.summary,
      reason: entry.reason,
      source: 'repeated_ask',
      askCount: entry.askCount,
    })
  }

  for (const record of classifierAsks) {
    if (!record.fingerprint) {
      continue
    }
    const command = commandFromRecord(record)
    if (!hasReadStyleSignal(command)) {
      continue
    }
    upsertCandidate(map, {
      fingerprint: record.fingerprint,
      command,
      reason: record.reason ?? 'unknown',
      source: 'read_style_signal',
    })
  }

  return [...map.values()].sort((left, right) => {
    if (right.askCount !== left.askCount) {
      return right.askCount - left.askCount
    }
    return left.command.localeCompare(right.command)
  })
}

export function buildHarvestReport(records: AuditRecord[]): HarvestReport {
  return {
    schemaVersion: HARVEST_REPORT_SCHEMA_VERSION,
    scope: 'shell',
    candidates: extractHarvestCandidates(records),
    availabilityQueue: extractAvailabilityQueue(records),
  }
}

function defaultReasonForCategory(category: CorpusCategory): string {
  if (category === 'provably-benign') {
    return 'read_only'
  }
  return 'local_mutation'
}

export function applyHarvestReview(
  cases: CorpusCase[],
  params: {
    command: string
    outcome: HarvestReviewOutcome
    reason?: string
  },
): { cases: CorpusCase[]; applied: boolean; message: string } {
  const command = params.command.trim()
  if (!command) {
    return { cases, applied: false, message: 'Command must be non-empty.' }
  }

  if (params.outcome === 'reject') {
    return { cases, applied: false, message: `Rejected candidate ${JSON.stringify(command)}.` }
  }

  const category = params.outcome
  const verdict = category === 'provably-benign' ? 'allow' : 'allow_flagged'
  const reason = params.reason?.trim() || defaultReasonForCategory(category)

  const duplicate = cases.find((entry) => entry.command === command)
  if (duplicate) {
    if (duplicate.category === category) {
      return {
        cases,
        applied: false,
        message: `Corpus already contains ${JSON.stringify(command)} as ${category}.`,
      }
    }
    return {
      cases,
      applied: false,
      message: `Corpus already contains ${JSON.stringify(command)} as ${duplicate.category}; resolve manually.`,
    }
  }

  const nextCase: CorpusCase = {
    kind: 'shell',
    category,
    command,
    verdict,
    reason,
  }

  return {
    cases: [...cases, nextCase],
    applied: true,
    message: `Added ${JSON.stringify(command)} to corpus as ${category}.`,
  }
}
