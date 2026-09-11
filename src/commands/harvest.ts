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
import { isValidAuditFingerprint } from '../core/audit-serialize.js'
import type { AuditRecord } from '../core/audit-types.js'
import { harvestReviewLedgerPath } from '../core/audit-version-path.js'
import {
  applyHarvestReview,
  buildHarvestReport,
  filterRecordsForHarvest,
  type HarvestReport,
  type HarvestReviewOutcome,
} from '../core/harvest.js'
import {
  type HarvestReviewRecordV1,
  harvestReviewKey,
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
  /** Include candidates already reviewed under the exact boundary-qualified review key. */
  includeReviewed?: boolean
  auditVersion?: string
  allVersions?: boolean
}

export interface HarvestApplyOptions {
  targetDir?: string
  command: string
  outcome: HarvestReviewOutcome
  reason?: string
  corpusPath?: string
  /** Explicit forensic mode; the command must still exactly match the mixed report. */
  allCohorts?: boolean
  /** Optional discriminator when one displayed command has multiple candidate fingerprints. */
  fingerprint?: string
  /** Optional discriminator when evidence spans multiple boundary profiles. */
  boundaryProfile?: string
  auditVersion?: string
  allVersions?: boolean
}

export async function harvestListProject(options: HarvestListOptions = {}): Promise<HarvestReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const records = await loadAuditRecords(repoRoot, {
    auditVersion: options.auditVersion,
    allVersions: options.allVersions,
  })
  const cohort = await resolveActiveAuditCohort(repoRoot, config)
  const forensicNotes = [
    ...(options.allVersions
      ? ['Mixed-version forensic mode: do not bulk-promote candidates.']
      : []),
    ...(options.auditVersion ? [`Audit version scope: v${options.auditVersion}.`] : []),
  ]
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
    notes: [
      ...(options.allCohorts
        ? ['Mixed-history forensic mode: do not bulk-promote candidates.']
        : []),
      ...forensicNotes,
    ],
    since: options.since,
    until: options.until,
    ...(options.allCohorts || !cohort ? {} : { legacyBoundaryProfile: cohort.boundaryProfile }),
  })
  if (options.includeReviewed) {
    return report
  }
  const ledger = await loadHarvestReviewLedger(
    harvestReviewLedgerPath(repoRoot, config.audit.logPath),
  )
  const reviewedKeys = new Set(latestHarvestReviews(ledger).keys())
  return {
    ...report,
    candidates: report.candidates.filter(
      (candidate) =>
        candidate.boundaryProfile === null || !reviewedKeys.has(harvestReviewKey(candidate)),
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
    legacyBoundaryProfile?: string
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
  options: { since?: string; until?: string; legacyBoundaryProfile?: string } = {},
): HarvestReport {
  const filtered = filterRecordsForHarvest(records, {
    since: options.since,
    until: options.until,
  })
  return buildHarvestReport(
    filtered,
    options.legacyBoundaryProfile ? { legacyBoundaryProfile: options.legacyBoundaryProfile } : {},
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
      const boundaryProfile =
        candidate.boundaryProfile === null
          ? 'legacy/unknown (null)'
          : JSON.stringify(candidate.boundaryProfile)
      lines.push(
        `- ${JSON.stringify(candidate.command)} [${candidate.sources.join(', ')}] asks=${candidate.askCount} approved=${candidate.approvedAfterDeny ? 'yes' : 'no'} fp=${candidate.fingerprint.slice(0, 12)}… boundary=${boundaryProfile}`,
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
    'Use --include-reviewed to display candidates already reviewed under the exact (fingerprint, kind, boundaryProfile) review key.',
    'Use: belay harvest apply --command "<text>" --outcome provably-benign|accepted-benign|must-ask|reject',
  )
  return lines.join('\n')
}

export async function harvestApplyProject(
  options: HarvestApplyOptions,
): Promise<{ ok: boolean; message: string; corpusPath: string }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const corpusPath = path.resolve(
    repoRoot,
    options.corpusPath ?? path.join('corpus', 'shell-commands.json'),
  )
  if (options.fingerprint && !isValidAuditFingerprint(options.fingerprint)) {
    return {
      ok: false,
      message: 'Harvest apply fingerprint must be a lowercase 64-hex value.',
      corpusPath: path.relative(repoRoot, corpusPath) || corpusPath,
    }
  }
  const config = await loadConfigFile(repoRoot)

  const report = await harvestListProject({
    targetDir: repoRoot,
    allCohorts: options.allCohorts,
    includeReviewed: true,
    auditVersion: options.auditVersion,
    allVersions: options.allVersions,
  })
  const commandMatches = report.candidates.filter((entry) => entry.command === options.command)
  const matchingCandidates = options.fingerprint
    ? commandMatches.filter((entry) => entry.fingerprint === options.fingerprint)
    : commandMatches
  const boundaryMatches = options.boundaryProfile
    ? matchingCandidates.filter((entry) => entry.boundaryProfile === options.boundaryProfile)
    : matchingCandidates
  const [candidate] = boundaryMatches
  if (!candidate) {
    const selectorMessage =
      options.fingerprint && options.boundaryProfile
        ? `No candidate matches the exact command, fingerprint ${options.fingerprint}, and boundary profile ${JSON.stringify(options.boundaryProfile)} in the selected harvest report.`
        : options.fingerprint
          ? `No candidate matches the exact command and fingerprint ${options.fingerprint} in the selected harvest report.`
          : options.boundaryProfile
            ? `No candidate matches the exact command and boundary profile ${JSON.stringify(options.boundaryProfile)} in the selected harvest report.`
            : `Command is not an exact candidate in the selected harvest report: ${JSON.stringify(options.command)}.`
    return {
      ok: false,
      message: selectorMessage,
      corpusPath: path.relative(repoRoot, corpusPath) || corpusPath,
    }
  }
  const matchingReviewKeys = new Set(boundaryMatches.map((entry) => harvestReviewKey(entry)))
  if (matchingReviewKeys.size > 1) {
    return {
      ok: false,
      message: `Multiple candidate fingerprints or boundary profiles match ${JSON.stringify(options.command)}; inspect harvest list --include-reviewed --json and retry with both --fingerprint <64-hex> and --boundary-profile <id>.`,
      corpusPath: path.relative(repoRoot, corpusPath) || corpusPath,
    }
  }
  if (candidate.boundaryProfile === null) {
    return {
      ok: false,
      message: 'Candidate boundary profile is unavailable; cannot bind the review.',
      corpusPath: path.relative(repoRoot, corpusPath) || corpusPath,
    }
  }

  const reviewedAt = new Date().toISOString()
  const ledgerPath = harvestReviewLedgerPath(repoRoot, config.audit.logPath)
  const ledger = await loadHarvestReviewLedger(ledgerPath)
  const review: HarvestReviewRecordV1 = {
    fingerprint: candidate.fingerprint,
    kind: candidate.kind,
    boundaryProfile: candidate.boundaryProfile,
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
export function harvestReportFromNdjson(ndjson: string): HarvestReport {
  const records = parseAuditNdjson(ndjson).map((entry) => toAuditRecord(entry))
  return harvestReportFromRecords(records)
}
