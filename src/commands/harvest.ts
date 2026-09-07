import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadConfigFile } from '../config-io.js'
import { parseAuditNdjson } from '../core/audit-metrics.js'
import {
  auditApprovalCorrelationId,
  isApprovalRecorded,
  isShellGateRecord,
  toAuditRecord,
} from '../core/audit-query.js'
import type { AuditRecord } from '../core/audit-types.js'
import {
  applyHarvestReview,
  buildHarvestReport,
  filterRecordsForHarvest,
  type HarvestReport,
  type HarvestReviewOutcome,
} from '../core/harvest.js'
import {
  type HarvestReviewRecordV1,
  latestHarvestReviews,
  loadHarvestReviewLedger,
  writeHarvestReviewLedgerAtomic,
} from '../core/harvest-review.js'
import { parseCorpusCases } from '../corpus/types.js'
import { matchesAuditCohort, resolveActiveAuditCohort } from '../runtime-provenance.js'
import { loadAuditRecords } from './audit.js'

export interface HarvestListOptions {
  targetDir?: string
  since?: string
  until?: string
  json?: boolean
  /** Explicit forensic mode; mixed history must never be bulk-promoted. */
  allCohorts?: boolean
  /** Include candidates already reviewed at the active boundary. */
  includeReviewed?: boolean
}

export interface HarvestApplyOptions {
  targetDir?: string
  command: string
  outcome: HarvestReviewOutcome
  reason?: string
  corpusPath?: string
  /** Explicit forensic mode; the command must still exactly match the mixed report. */
  allCohorts?: boolean
}

function auditLogPath(repoRoot: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.join(repoRoot, configuredPath)
}

function harvestReviewLedgerPath(repoRoot: string, configuredAuditPath: string): string {
  return path.join(
    path.dirname(auditLogPath(repoRoot, configuredAuditPath)),
    'harvest-reviews.json',
  )
}

export async function harvestListProject(options: HarvestListOptions = {}): Promise<HarvestReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const records = await loadAuditRecords(repoRoot)
  const cohort = await resolveActiveAuditCohort(repoRoot, config)
  const shellGateRecords = records.filter(isShellGateRecord)
  const matchingGateRecords = cohort
    ? shellGateRecords.filter((record) => matchesAuditCohort(record, cohort))
    : []

  if (!cohort && !options.allCohorts) {
    return scopedHarvestReport([], {
      cohort: null,
      matchingGateEvents: 0,
      excludedGateEvents: shellGateRecords.length,
      notes: [
        'Active audit cohort is unavailable; no historical records were harvested. Use --all-cohorts only for forensic review.',
      ],
    })
  }

  const harvestRecords = options.allCohorts
    ? records
    : recordsForActiveCohort(records, matchingGateRecords)
  const report = scopedHarvestReport(harvestRecords, {
    cohort,
    matchingGateEvents: matchingGateRecords.length,
    excludedGateEvents: shellGateRecords.length - matchingGateRecords.length,
    notes: options.allCohorts
      ? ['Mixed-history forensic mode: do not bulk-promote candidates.']
      : [],
    since: options.since,
    until: options.until,
  })
  if (options.includeReviewed || !cohort) {
    return report
  }
  const ledger = await loadHarvestReviewLedger(
    harvestReviewLedgerPath(repoRoot, config.audit.logPath),
  )
  const reviewedFingerprints = new Set(
    [...latestHarvestReviews(ledger).values()]
      .filter(
        (review) => review.kind === 'shell' && review.boundaryProfile === cohort.boundaryProfile,
      )
      .map((review) => review.fingerprint),
  )
  return {
    ...report,
    candidates: report.candidates.filter(
      (candidate) => !reviewedFingerprints.has(candidate.fingerprint),
    ),
  }
}

function recordsForActiveCohort(
  records: AuditRecord[],
  matchingGateRecords: AuditRecord[],
): AuditRecord[] {
  const matchingSet = new Set(matchingGateRecords)
  const approvalIds = new Set(
    matchingGateRecords
      .map((record) => record.approvalId)
      .filter((approvalId): approvalId is string => typeof approvalId === 'string'),
  )
  const approvalCorrelationIds = new Set(
    matchingGateRecords
      .map(auditApprovalCorrelationId)
      .filter((correlationId): correlationId is string => correlationId !== undefined),
  )
  const isPairedApproval = (record: AuditRecord): boolean => {
    if (!isApprovalRecorded(record)) {
      return false
    }
    const correlationId = auditApprovalCorrelationId(record)
    if (correlationId) {
      return approvalCorrelationIds.has(correlationId)
    }
    return typeof record.approvalId === 'string' && approvalIds.has(record.approvalId)
  }
  return records.filter((record) => matchingSet.has(record) || isPairedApproval(record))
}

function scopedHarvestReport(
  records: AuditRecord[],
  options: {
    cohort: HarvestReport['cohort']
    matchingGateEvents: number
    excludedGateEvents: number
    notes: string[]
    since?: string
    until?: string
  },
): HarvestReport {
  const report = harvestReportFromRecords(records, options)
  return {
    ...report,
    cohort: options.cohort,
    matchingGateEvents: options.matchingGateEvents,
    excludedGateEvents: options.excludedGateEvents,
    notes: options.notes,
  }
}

export function harvestReportFromRecords(
  records: AuditRecord[],
  options: { since?: string; until?: string } = {},
): HarvestReport {
  return buildHarvestReport(
    filterRecordsForHarvest(records, { since: options.since, until: options.until }),
  )
}

export function formatHarvestReport(report: HarvestReport): string {
  const lines = [
    `belay harvest (scope: ${report.scope} audit traces only)`,
    `Schema: v${report.schemaVersion}`,
    `Active cohort: ${report.cohort ? report.cohort.runtimeBuildStamp : 'unavailable'}`,
    `Matching gate events: ${report.matchingGateEvents}`,
    `Excluded historical/mismatched gate events: ${report.excludedGateEvents}`,
    '',
    `Benign candidates (${report.candidates.length}):`,
  ]

  if (report.candidates.length === 0) {
    lines.push('- (none)')
  } else {
    for (const candidate of report.candidates) {
      lines.push(
        `- ${JSON.stringify(candidate.command)} [${candidate.sources.join(', ')}] asks=${candidate.askCount} approved=${candidate.approvedAfterDeny ? 'yes' : 'no'} fp=${candidate.fingerprint.slice(0, 12)}…`,
      )
    }
  }

  lines.push('', `Availability queue (${report.availabilityQueue.length}):`)
  if (report.availabilityQueue.length === 0) {
    lines.push('- (none)')
  } else {
    for (const entry of report.availabilityQueue) {
      lines.push(
        `- ${JSON.stringify(entry.command)} signal=${entry.availabilitySignal} asks=${entry.askCount} (${entry.reason})`,
      )
    }
  }

  lines.push(
    '',
    ...report.notes,
    'Candidates are review-only signals — approve in audit does not auto-promote to corpus.',
    'Time filters (--since/--until) keep paired deny/approval rows for round-trip detection.',
    'Use --include-reviewed to display candidates already reviewed at the active boundary.',
    'Use: belay harvest apply --command "<text>" --outcome provably-benign|accepted-benign|must-ask|reject',
  )
  return lines.join('\n')
}

export async function harvestApplyProject(
  options: HarvestApplyOptions,
): Promise<{ ok: boolean; message: string; corpusPath: string }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const corpusPath = path.resolve(
    repoRoot,
    options.corpusPath ?? path.join('corpus', 'shell-commands.json'),
  )

  const report = await harvestListProject({
    targetDir: repoRoot,
    allCohorts: options.allCohorts,
    includeReviewed: true,
  })
  const matchingCandidates = report.candidates.filter((entry) => entry.command === options.command)
  const [candidate] = matchingCandidates
  if (!candidate) {
    return {
      ok: false,
      message: `Command is not an exact candidate in the selected harvest report: ${JSON.stringify(options.command)}.`,
      corpusPath: path.relative(repoRoot, corpusPath) || corpusPath,
    }
  }
  const matchingFingerprints = new Set(matchingCandidates.map((entry) => entry.fingerprint))
  if (matchingFingerprints.size > 1) {
    return {
      ok: false,
      message: `Multiple candidate fingerprints match ${JSON.stringify(options.command)}; inspect harvest list --include-reviewed --json and use a report where the command resolves unambiguously.`,
      corpusPath: path.relative(repoRoot, corpusPath) || corpusPath,
    }
  }
  if (!report.cohort) {
    return {
      ok: false,
      message: 'Active audit cohort is unavailable; cannot bind the review to a boundary profile.',
      corpusPath: path.relative(repoRoot, corpusPath) || corpusPath,
    }
  }

  const reviewedAt = new Date().toISOString()
  const ledgerPath = harvestReviewLedgerPath(repoRoot, config.audit.logPath)
  const ledger = await loadHarvestReviewLedger(ledgerPath)
  const review: HarvestReviewRecordV1 = {
    fingerprint: candidate.fingerprint,
    kind: candidate.kind,
    boundaryProfile: report.cohort.boundaryProfile,
    outcome: options.outcome,
    ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
    reviewedAt,
  }
  await writeHarvestReviewLedgerAtomic(ledgerPath, {
    version: 1,
    reviews: [...ledger.reviews, review],
  })

  if (options.outcome === 'reject') {
    const result = applyHarvestReview([], {
      command: options.command,
      outcome: options.outcome,
      reason: options.reason,
      fingerprint: candidate.fingerprint,
      reviewedAt,
    })
    return {
      ok: result.ok,
      message: result.message,
      corpusPath: path.relative(repoRoot, corpusPath) || corpusPath,
    }
  }

  const raw = await readFile(corpusPath, 'utf8')
  const cases = parseCorpusCases(JSON.parse(raw))
  const result = applyHarvestReview(cases, {
    command: options.command,
    outcome: options.outcome,
    reason: options.reason,
    fingerprint: candidate.fingerprint,
    reviewedAt,
  })

  if (result.applied) {
    await writeFile(corpusPath, `${JSON.stringify(result.cases, null, 2)}\n`, 'utf8')
  }

  return {
    ok: result.ok,
    message: result.message,
    corpusPath: path.relative(repoRoot, corpusPath) || corpusPath,
  }
}

/** Parse audit ndjson for tests without full project layout. */
export function harvestReportFromNdjson(raw: string): HarvestReport {
  const records = parseAuditNdjson(raw).map((entry) => toAuditRecord(entry))
  return harvestReportFromRecords(records)
}
