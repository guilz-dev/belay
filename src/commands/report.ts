import { loadConfigForCommand } from '../config-io.js'
import {
  detectFenceDrift,
  formatAskBreakdown,
  summarizeAuditVisibility,
} from '../core/audit-summary.js'
import type { AuditFilter } from '../core/audit-types.js'
import {
  listVersionedAuditLogRoots,
  resolveActiveAuditLogPath,
  resolveAuditLogDirectory,
} from '../core/audit-version-path.js'
import type { AuditVisibilityReport, ReportOptions } from '../types.js'
import { loadAuditRecords } from './audit.js'

export async function reportProject(options: ReportOptions = {}): Promise<AuditVisibilityReport> {
  const {
    effectiveRepoRoot: repoRoot,
    requestedTarget,
    adapter,
    config,
  } = await loadConfigForCommand(options.targetDir, options.adapter)
  const auditLogPath = await resolveActiveAuditLogPath(repoRoot, config)
  const records = await loadAuditRecords(repoRoot, {
    adapter,
    auditVersion: options.auditVersion,
    allVersions: options.allVersions,
  })

  const filter: AuditFilter = {
    since: options.since,
    until: options.until,
  }

  const summary = summarizeAuditVisibility(records, filter, {
    recentAskLimit: options.limit ?? 10,
  })
  const drift = detectFenceDrift(summary, {
    threshold: config.policy.fenceWarnThreshold,
  })
  const notes = [...drift.notes]
  notes.push(`Readiness: ${auditLogPath}.readiness.json`)
  const auditDirectory = resolveAuditLogDirectory(repoRoot, config.audit.logPath)
  const versionedLogs = listVersionedAuditLogRoots(auditDirectory)
  if (versionedLogs.length > 1) {
    notes.push(
      `Versioned audit logs (${versionedLogs.length}): use \`belay audit versions\` or --all-versions for forensic reads.`,
    )
  }

  return {
    repoRoot,
    requestedTarget: requestedTarget !== repoRoot ? requestedTarget : undefined,
    auditLogPath,
    auditReadinessPath: `${auditLogPath}.readiness.json`,
    ...summary,
    warnings: drift.warnings,
    notes,
  }
}

export function formatReport(report: AuditVisibilityReport): string {
  const recentHostDenials = report.recentHostDenials ?? []
  const lines = [
    `belay report for ${report.repoRoot}`,
    ...(report.requestedTarget
      ? [`CLI target: ${report.requestedTarget} (config anchor: ${report.repoRoot})`]
      : []),
    `Audit log: ${report.auditLogPath}`,
    '',
    `Gate events: ${report.gateEvents}`,
    ...formatAskBreakdown(report),
    `Flag (allow_flagged): ${report.flagCount}`,
    `Allow (silent pass): ${report.allowCount}`,
    `Host denied after Belay allow: ${report.hostDeniedAfterAllowCount ?? 0}`,
    ...(report.knownHostNoiseCount && report.knownHostNoiseCount > 0
      ? [`Known host hook noise (non-Belay): ${report.knownHostNoiseCount}`]
      : []),
    ...(report.unrecognizedHostFailureCount && report.unrecognizedHostFailureCount > 0
      ? [`Unrecognized host tool failures: ${report.unrecognizedHostFailureCount}`]
      : []),
    `Silent-pass rate: ${(report.silentPassRate * 100).toFixed(1)}%`,
    '',
  ]

  if (report.warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`)
    }
    lines.push('')
  }

  if (report.notes.length > 0) {
    lines.push('Notes:')
    for (const note of report.notes) {
      lines.push(`- ${note}`)
    }
    lines.push('')
  }

  if (recentHostDenials.length > 0) {
    lines.push('Host denials after Belay allow:')
    for (const denial of recentHostDenials) {
      const when = denial.failureTimestamp ?? 'unknown-time'
      const detail = denial.errorMessage ? ` — ${denial.errorMessage}` : ''
      lines.push(`- [${when}] ${denial.summary}${detail}`)
    }
    lines.push('')
  }

  if (report.recentAsks.length === 0) {
    lines.push('No recent asks in the selected period.')
  } else {
    lines.push('Recent asks:')
    for (const ask of report.recentAsks) {
      const when = ask.timestamp ?? 'unknown-time'
      lines.push(`- [${when}] (${ask.tier}) ${ask.reason} — ${ask.summary}`)
    }
  }

  return `${lines.join('\n')}\n`
}
