import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { loadConfigFile } from '../config-io.js'
import type { AuditMetricsReport } from '../core/audit-metrics.js'
import { computeAuditMetrics, parseAuditNdjson } from '../core/audit-metrics.js'

export interface MetricsOptions {
  targetDir?: string
  json?: boolean
}

function formatFingerprintPreview(fingerprint: string): string {
  if (fingerprint.length <= 12) {
    return fingerprint
  }
  return `${fingerprint.slice(0, 12)}…`
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
    `Classifier-quality would-block: ${report.classifierWouldBlockCount} (${(report.classifierWouldBlockRate * 100).toFixed(1)}%)`,
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

  if (report.availabilityAsks.total > 0) {
    lines.push('', 'Availability-caused asks (infrastructure, not classifier ground truth):')
    lines.push(`- missing trusted cwd: ${report.availabilityAsks.missingTrustedCwd}`)
    lines.push(`- judge timeout: ${report.availabilityAsks.judgeTimeout}`)
    lines.push(`- other judge fallback: ${report.availabilityAsks.judgeFallback}`)
    lines.push(`- total: ${report.availabilityAsks.total}`)
  }

  if (report.repeatedFingerprintAsks.length > 0) {
    lines.push('', 'Repeated fingerprint asks (repeat friction):')
    for (const entry of report.repeatedFingerprintAsks) {
      lines.push(
        `- [${entry.reason}] x${entry.askCount} ${formatFingerprintPreview(entry.fingerprint)}: ${entry.summary}`,
      )
    }
  }

  if (Object.keys(report.wouldBlockByReason).length > 0) {
    lines.push('', 'Would-block by reason:')
    for (const [reason, count] of Object.entries(report.wouldBlockByReason).sort(
      (a, b) => b[1] - a[1],
    )) {
      lines.push(`- ${reason}: ${count}`)
    }
  }

  if (report.approvalRatioByReason.length > 0) {
    lines.push('', 'Approval ratio by reason (candidate signal, not ground truth):')
    for (const entry of report.approvalRatioByReason.slice(0, 10)) {
      lines.push(
        `- ${entry.reason}: ${(entry.approvalRate * 100).toFixed(0)}% approved after deny (${entry.approvedAfterDenyCount}/${entry.wouldBlockCount})`,
      )
    }
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
    lines.push(
      '',
      'Noisy rule candidates (high-signal subset of approval ratios; ≥50% approved after deny):',
    )
    for (const rule of report.noisyRuleCandidates) {
      lines.push(
        `- ${rule.reason}: ${(rule.approvalRate * 100).toFixed(0)}% approved after deny (${rule.approvedCount}/${rule.denyCount})`,
      )
    }
  }

  if (Object.keys(report.byReason).length > 0) {
    lines.push('', 'All gate events by reason:')
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
