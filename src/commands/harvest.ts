import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadConfigFile } from '../config-io.js'
import { parseAuditNdjson } from '../core/audit-metrics.js'
import { toAuditRecord } from '../core/audit-query.js'
import type { AuditRecord } from '../core/audit-types.js'
import {
  applyHarvestReview,
  buildHarvestReport,
  filterRecordsForHarvest,
  type HarvestReport,
  type HarvestReviewOutcome,
} from '../core/harvest.js'
import { parseCorpusCases } from '../corpus/types.js'
import { loadAuditRecords } from './audit.js'

export interface HarvestListOptions {
  targetDir?: string
  since?: string
  until?: string
  json?: boolean
}

export interface HarvestApplyOptions {
  targetDir?: string
  command: string
  outcome: HarvestReviewOutcome
  reason?: string
  corpusPath?: string
}

export async function harvestListProject(options: HarvestListOptions = {}): Promise<HarvestReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const records = await loadAuditRecords(repoRoot)
  return harvestReportFromRecords(records, {
    since: options.since,
    until: options.until,
    allowPatterns: config.overrides.allow,
  })
}

export function harvestReportFromRecords(
  records: AuditRecord[],
  options: { since?: string; until?: string; allowPatterns?: string[] } = {},
): HarvestReport {
  return buildHarvestReport(
    filterRecordsForHarvest(records, { since: options.since, until: options.until }),
    { allowPatterns: options.allowPatterns },
  )
}

export function formatHarvestReport(report: HarvestReport): string {
  const lines = [
    `belay harvest (scope: ${report.scope} audit traces only)`,
    `Schema: v${report.schemaVersion}`,
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
    'Candidates are review-only signals — approve in audit does not auto-promote to corpus.',
    'Time filters (--since/--until) keep paired deny/approval rows for round-trip detection.',
    'Use: belay harvest apply --command "<text>" --outcome provably-benign|accepted-benign|reject',
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

  const raw = await readFile(corpusPath, 'utf8')
  const cases = parseCorpusCases(JSON.parse(raw))
  const result = applyHarvestReview(cases, {
    command: options.command,
    outcome: options.outcome,
    reason: options.reason,
  })

  if (result.applied) {
    await writeFile(corpusPath, `${JSON.stringify(result.cases, null, 2)}\n`, 'utf8')
  }

  return {
    ok: result.applied,
    message: result.message,
    corpusPath: path.relative(repoRoot, corpusPath) || corpusPath,
  }
}

/** Parse audit ndjson for tests without full project layout. */
export function harvestReportFromNdjson(raw: string): HarvestReport {
  const records = parseAuditNdjson(raw).map((entry) => toAuditRecord(entry))
  return harvestReportFromRecords(records)
}
