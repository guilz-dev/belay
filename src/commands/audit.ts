import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { loadConfigFile } from '../config-io.js'
import { detectBypassAttempts, detectNoisyRules } from '../core/audit-analysis.js'
import {
  type AuditReadScopeOptions,
  loadAuditRecords,
  loadScopedAuditRecords,
} from '../core/audit-load.js'
import {
  buildApprovalRoundTrips,
  filterAuditRecords,
  summarizeRoundTrips,
} from '../core/audit-query.js'
import type { AuditFilter } from '../core/audit-types.js'
import {
  listVersionedAuditLogRoots,
  resolveActiveAuditLogPath,
  resolveAuditLogDirectory,
} from '../core/audit-version-path.js'
import { type BelayConfigV3, mergeConfig } from '../core/config.js'
import { diffReclassification } from '../core/reclassify.js'
import type { AdapterName } from '../types.js'

export type AuditSubcommand = 'query' | 'summarize' | 'replay' | 'versions'

export type { AuditReadScopeOptions }

export interface AuditOptions {
  targetDir?: string
  subcommand: AuditSubcommand
  json?: boolean
  since?: string
  until?: string
  verdict?: string
  reason?: string
  kind?: string
  fingerprint?: string
  event?: string
  location?: string
  opacity?: string
  effect?: string
  confidence?: string
  limit?: number
  configPath?: string
  auditVersion?: string
  allVersions?: boolean
}

export { loadAuditRecords, loadScopedAuditRecords }

export type AuditVersionsReport = {
  subcommand: 'versions'
  directory: string
  activePath: string
  versions: Array<{ path: string; basename: string; active: boolean }>
}

export type AuditQueryReport = {
  subcommand: 'query'
  records: import('../core/audit-types.js').AuditRecord[]
  count: number
}

export type AuditSummarizeReport = {
  subcommand: 'summarize'
  roundTrips: ReturnType<typeof buildApprovalRoundTrips>
  lines: string[]
  bypassAttempts: ReturnType<typeof detectBypassAttempts>
  noisyRules: ReturnType<typeof detectNoisyRules>
}

type ReclassificationDiff = NonNullable<Awaited<ReturnType<typeof diffReclassification>>>

export type AuditReplayReport = {
  subcommand: 'replay'
  candidateConfigPath: string | null
  configWarning?: string
  changedCount: number
  diffs: ReclassificationDiff[]
}

export type AuditProjectReport =
  | AuditVersionsReport
  | AuditQueryReport
  | AuditSummarizeReport
  | AuditReplayReport

export async function auditVersionsProject(
  options: { targetDir?: string; adapter?: AdapterName } = {},
): Promise<AuditVersionsReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot, options.adapter)
  const directory = resolveAuditLogDirectory(repoRoot, config.audit.logPath)
  const activePath = await resolveActiveAuditLogPath(repoRoot, config)
  const versions = listVersionedAuditLogRoots(directory).map((filePath) => ({
    path: filePath,
    basename: path.basename(filePath),
    active: filePath === activePath,
  }))
  return {
    subcommand: 'versions' as const,
    directory,
    activePath,
    versions,
  }
}

export async function auditProject(options: AuditOptions): Promise<AuditProjectReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())

  if (options.subcommand === 'versions') {
    return auditVersionsProject({ targetDir: repoRoot })
  }

  const readScope: AuditReadScopeOptions = {
    auditVersion: options.auditVersion,
    allVersions: options.allVersions,
  }
  const records = await loadAuditRecords(repoRoot, readScope)
  const filter: AuditFilter = {
    since: options.since,
    until: options.until,
    verdict: options.verdict,
    reason: options.reason,
    kind: options.kind,
    fingerprint: options.fingerprint,
    event: options.event,
    location: options.location,
    opacity: options.opacity,
    effect: options.effect,
    confidence: options.confidence,
    limit: options.limit,
  }

  if (options.subcommand === 'query') {
    const filtered = filterAuditRecords(records, filter)
    return { subcommand: 'query' as const, records: filtered, count: filtered.length }
  }

  if (options.subcommand === 'summarize') {
    const filtered = filterAuditRecords(records, filter)
    const trips = buildApprovalRoundTrips(filtered)
    const bypassAttempts = detectBypassAttempts(filtered)
    const noisyRules = detectNoisyRules(filtered, trips)
    return {
      subcommand: 'summarize' as const,
      roundTrips: trips,
      lines: summarizeRoundTrips(trips),
      bypassAttempts,
      noisyRules,
    }
  }

  const config = await loadConfigFile(repoRoot)
  let candidateConfig: BelayConfigV3 = config
  let configWarning: string | undefined
  if (options.configPath) {
    if (!existsSync(options.configPath)) {
      configWarning = `Candidate config not found: ${options.configPath}`
    } else {
      const raw = JSON.parse(await readFile(options.configPath, 'utf8')) as unknown
      candidateConfig = mergeConfig(raw, config)
    }
  }

  const filtered = filterAuditRecords(records, filter)
  const diffs = (
    await Promise.all(
      filtered.map((record) => diffReclassification(record, candidateConfig, repoRoot)),
    )
  ).filter((diff): diff is NonNullable<typeof diff> => diff !== null)

  return {
    subcommand: 'replay' as const,
    candidateConfigPath: options.configPath ?? null,
    configWarning,
    changedCount: diffs.length,
    diffs,
  }
}

export function formatAuditReport(report: AuditProjectReport): string {
  if (report.subcommand === 'versions') {
    const lines = [
      'audit versions:',
      `directory: ${report.directory}`,
      `active: ${report.activePath}`,
    ]
    if (report.versions.length === 0) {
      lines.push('No versioned audit logs found.')
    } else {
      for (const version of report.versions) {
        lines.push(`- ${version.basename}${version.active ? ' (active)' : ''}`)
      }
    }
    return `${lines.join('\n')}\n`
  }

  if (report.subcommand === 'query') {
    const records = report.records ?? []
    const count = report.count ?? records.length
    const lines = [`audit query: ${count} record(s)`]
    for (const record of records.slice(0, 50)) {
      const v2Axes =
        typeof record.location === 'string'
          ? ` location=${record.location} opacity=${record.opacity ?? '?'} effect=${record.effect ?? '?'} confidence=${record.confidence ?? '?'}`
          : ''
      lines.push(
        `- ${record.timestamp ?? '?'} [${record.event ?? '?'}] ${record.verdict ?? '?'} (${record.reason ?? '?'})${v2Axes} ${record.summary ?? ''}`,
      )
    }
    if (count > 50) {
      lines.push(`... ${count - 50} more`)
    }
    return `${lines.join('\n')}\n`
  }

  if (report.subcommand === 'summarize') {
    const lines = ['audit summarize:', '']
    const summaryLines = report.lines ?? []
    const bypassAttempts = report.bypassAttempts ?? []
    const noisyRules = report.noisyRules ?? []
    if (summaryLines.length === 0) {
      lines.push('No deny → approve → execute round-trips found.')
    } else {
      lines.push('Round-trips:')
      for (const line of summaryLines) {
        lines.push(`- ${line}`)
      }
    }
    if (bypassAttempts.length > 0) {
      lines.push('', `Bypass attempts (${bypassAttempts.length}):`)
      for (const attempt of bypassAttempts.slice(0, 10)) {
        lines.push(
          `- [${attempt.signal}] denied "${attempt.denySummary}" → tried "${attempt.attemptSummary}"`,
        )
      }
    }
    if (noisyRules.length > 0) {
      lines.push('', 'Noisy rule candidates:')
      for (const rule of noisyRules) {
        lines.push(
          `- ${rule.reason}: ${(rule.approvalRate * 100).toFixed(0)}% approved after deny (${rule.approvedCount}/${rule.denyCount})`,
        )
      }
    }
    return `${lines.join('\n')}\n`
  }

  if (report.subcommand !== 'replay') {
    return ''
  }

  const lines = [
    `audit replay: ${report.changedCount} verdict change(s)`,
    report.candidateConfigPath ? `Candidate config: ${report.candidateConfigPath}` : '',
    report.configWarning ?? '',
  ].filter(Boolean)
  for (const diff of report.diffs.slice(0, 30)) {
    lines.push(
      `- ${diff.summary ?? diff.fingerprint}: ${diff.previousVerdict}/${diff.previousReason} → ${diff.nextVerdict}/${diff.nextReason}`,
    )
  }
  return `${lines.join('\n')}\n`
}
