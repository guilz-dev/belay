import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { loadConfigFile } from '../config-io.js'
import type { AuditMetricsReport } from '../core/audit-metrics.js'
import { computeAuditMetrics, parseAuditNdjson } from '../core/audit-metrics.js'

export interface MetricsOptions {
  targetDir?: string
  json?: boolean
}

export async function metricsProject(options: MetricsOptions = {}): Promise<AuditMetricsReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const auditLogPath = path.join(repoRoot, config.audit.logPath)
  let raw = ''
  try {
    raw = await readFile(auditLogPath, 'utf8')
  } catch {
    raw = ''
  }
  const records = parseAuditNdjson(raw)
  return computeAuditMetrics(records, {
    auditLogPath: config.audit.logPath,
    mode: config.mode,
    unknownLocalEffect: config.policy.unknownLocalEffect,
  })
}

export function formatMetricsReport(report: AuditMetricsReport): string {
  const lines = [
    `belay metrics for ${report.auditLogPath}`,
    `Schema: v${report.schemaVersion}`,
    `Gate events: ${report.gateEvents}`,
    `Would-block: ${report.wouldBlockCount} (${(report.wouldBlockRate * 100).toFixed(1)}%)`,
    `Approvals recorded during audit: ${report.approvalRecordedCount}`,
  ]

  if (report.approvalLatency.count > 0) {
    lines.push(
      `Approval latency: median ${report.approvalLatency.medianMs ?? 0}ms, p95 ${report.approvalLatency.p95Ms ?? 0}ms (${report.approvalLatency.count} samples)`,
    )
  }

  if (report.bypassAttemptCount > 0) {
    lines.push(`Bypass attempts detected: ${report.bypassAttemptCount}`)
  }

  if (Object.keys(report.byVerdict).length > 0) {
    lines.push('', 'By verdict:')
    for (const [verdict, count] of Object.entries(report.byVerdict).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${verdict}: ${count}`)
    }
  }

  const v2Buckets: Array<[string, Record<string, number>]> = [
    ['location', report.byLocation],
    ['opacity', report.byOpacity],
    ['effect', report.byEffect],
    ['confidence', report.byConfidence],
  ]
  for (const [axis, bucket] of v2Buckets) {
    if (Object.keys(bucket).length > 0) {
      lines.push('', `By ${axis}:`)
      for (const [value, count] of Object.entries(bucket).sort((a, b) => b[1] - a[1])) {
        lines.push(`- ${value}: ${count}`)
      }
    }
  }

  if (Object.keys(report.gateEventsByDay).length > 0) {
    lines.push('', 'Gate events by day:')
    for (const [day, count] of Object.entries(report.gateEventsByDay).sort()) {
      lines.push(`- ${day}: ${count}`)
    }
  }

  if (report.noisyRuleCandidates.length > 0) {
    lines.push('', 'Noisy rule candidates:')
    for (const rule of report.noisyRuleCandidates) {
      lines.push(
        `- ${rule.reason}: ${(rule.approvalRate * 100).toFixed(0)}% approved after deny (${rule.approvedCount}/${rule.denyCount})`,
      )
    }
  }

  if (Object.keys(report.byReason).length > 0) {
    lines.push('', 'By reason:')
    for (const [reason, count] of Object.entries(report.byReason).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${reason}: ${count}`)
    }
  }

  if (report.topWouldBlockSummaries.length > 0) {
    lines.push('', 'Top would-block summaries:')
    for (const entry of report.topWouldBlockSummaries) {
      lines.push(`- [${entry.reason}] x${entry.count}: ${entry.summary}`)
    }
  }

  if (report.dogfood.notes.length > 0) {
    lines.push('', 'Dogfood notes:')
    for (const note of report.dogfood.notes) {
      lines.push(`- ${note}`)
    }
    lines.push(
      '',
      report.dogfood.readyForEnforce ? 'Ready for enforce: yes' : 'Ready for enforce: not yet',
    )
  }

  return `${lines.join('\n')}\n`
}
