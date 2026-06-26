import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseAuditNdjson } from '../core/audit-metrics.js'
import { toAuditRecord } from '../core/audit-query.js'
import type { AuditRecord } from '../core/audit-types.js'
import {
  applyHarvestReview,
  buildHarvestReport,
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

function filterShellRecords(records: AuditRecord[], since?: string, until?: string): AuditRecord[] {
  let filtered = records.filter(
    (record) => record.event === 'beforeShellExecution' || record.kind === 'shell',
  )
  if (since) {
    const sinceMs = Date.parse(since)
    if (!Number.isNaN(sinceMs)) {
      filtered = filtered.filter((record) => {
        const ts = record.timestamp ? Date.parse(record.timestamp) : Number.NaN
        return !Number.isNaN(ts) && ts >= sinceMs
      })
    }
  }
  if (until) {
    const untilMs = Date.parse(until)
    if (!Number.isNaN(untilMs)) {
      filtered = filtered.filter((record) => {
        const ts = record.timestamp ? Date.parse(record.timestamp) : Number.NaN
        return !Number.isNaN(ts) && ts <= untilMs
      })
    }
  }
  return filtered
}

export async function harvestListProject(options: HarvestListOptions = {}): Promise<HarvestReport> {
  const records = await loadAuditRecords(path.resolve(options.targetDir ?? process.cwd()))
  return buildHarvestReport(filterShellRecords(records, options.since, options.until))
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
  return buildHarvestReport(records)
}
