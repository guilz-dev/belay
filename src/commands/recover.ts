import path from 'node:path'
import {
  filterAuditRecords,
  inferWouldBlock,
  isApprovalRecorded,
  isGateRecord,
  parseTimestamp,
} from '../core/audit-query.js'
import type { AuditRecord } from '../core/audit-types.js'
import { buildRecoverAdvice, type RecoverTargetInput } from '../core/recover-advice.js'
import { probeGitState } from '../core/recover-git-probe.js'
import type { RecoverOptions, RecoverReport } from '../types.js'
import { loadAuditRecords } from './audit.js'
import { classifyForReport } from './classify-for-report.js'

function isRecoverCandidate(record: AuditRecord): boolean {
  if (!isGateRecord(record) || isApprovalRecorded(record)) {
    return false
  }
  if (inferWouldBlock(record)) {
    return true
  }
  const effect = typeof record.effect === 'string' ? record.effect : ''
  return effect === 'local_mutation' || effect === 'external_effect'
}

function recordToTarget(record: AuditRecord): RecoverTargetInput {
  return {
    timestamp: record.timestamp,
    fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : undefined,
    summary: typeof record.summary === 'string' ? record.summary : '',
    reason: typeof record.reason === 'string' ? record.reason : 'unknown',
    effect: typeof record.effect === 'string' ? record.effect : undefined,
    location: typeof record.location === 'string' ? record.location : undefined,
    permission: typeof record.permission === 'string' ? record.permission : undefined,
    assessment: record.assessment,
  }
}

function selectRecoverTarget(
  records: AuditRecord[],
  options: RecoverOptions,
): RecoverTargetInput | null {
  const filtered = filterAuditRecords(records, {
    since: options.since,
    fingerprint: options.fingerprint,
  })
  const candidates = filtered.filter(isRecoverCandidate)
  if (candidates.length === 0) {
    return null
  }

  candidates.sort((left, right) => {
    const leftMs = parseTimestamp(left.timestamp) ?? 0
    const rightMs = parseTimestamp(right.timestamp) ?? 0
    return rightMs - leftMs
  })

  const limit = options.limit ?? 1
  const index = Math.min(limit, candidates.length) - 1
  const selected = candidates[index] ?? candidates[0]
  if (!selected) {
    return null
  }
  return recordToTarget(selected)
}

export async function recoverProject(options: RecoverOptions = {}): Promise<RecoverReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  let target: RecoverTargetInput | null = null
  const extraWarnings: string[] = []

  if (options.command) {
    extraWarnings.push(
      '--command re-runs shell classification and may invoke Tier1 judge (classification only — no recovery commands are executed). Prefer audit-based recovery when possible.',
    )
    const classified = await classifyForReport({
      targetDir: repoRoot,
      command: options.command,
      kind: 'shell',
    })
    target = {
      summary: classified.input,
      reason: classified.result.reason,
      effect: classified.result.v2?.effect,
      location: classified.result.v2?.location,
      permission: classified.permission,
      assessment: classified.result.assessment,
    }
  } else {
    const records = await loadAuditRecords(repoRoot)
    target = selectRecoverTarget(records, options)
  }

  const git = await probeGitState(repoRoot)

  if (!target) {
    return {
      repoRoot,
      recoverable: false,
      confidence: 'medium',
      disclaimer: buildRecoverAdvice({
        repoRoot,
        target: { summary: '', reason: 'unknown' },
      }).disclaimer,
      advice: ['No recoverable audit events found in the selected window.'],
      warnings: ['Specify --fingerprint, --since, or --command to narrow recovery advice.'],
    }
  }

  const advice = buildRecoverAdvice({ repoRoot, target, git })

  return {
    repoRoot,
    target: {
      timestamp: target.timestamp,
      fingerprint: target.fingerprint,
      summary: target.summary,
      reason: target.reason,
      effect: target.effect,
      location: target.location,
      permission: target.permission,
    },
    ...advice,
    warnings: [...extraWarnings, ...advice.warnings],
  }
}

export function formatRecoverReport(report: RecoverReport): string {
  const lines = [
    `agent-belay recover for ${report.repoRoot}`,
    '',
    'Disclaimer:',
    ...report.disclaimer.map((line) => `- ${line}`),
    '',
  ]

  if (report.target) {
    lines.push('Target:')
    if (report.target.timestamp) {
      lines.push(`- time: ${report.target.timestamp}`)
    }
    if (report.target.fingerprint) {
      lines.push(`- fingerprint: ${report.target.fingerprint}`)
    }
    lines.push(`- reason: ${report.target.reason}`)
    if (report.target.effect) {
      lines.push(`- effect: ${report.target.effect}`)
    }
    if (report.target.location) {
      lines.push(`- location: ${report.target.location}`)
    }
    lines.push(`- summary: ${report.target.summary}`)
    lines.push('')
  }

  lines.push(
    `Recoverable: ${report.recoverable ? 'possibly' : 'unlikely'} (confidence=${report.confidence})`,
  )
  lines.push('')
  lines.push('Advice:')
  for (const line of report.advice) {
    lines.push(`- ${line}`)
  }

  if (report.warnings.length > 0) {
    lines.push('')
    lines.push('Warnings:')
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`)
    }
  }

  return `${lines.join('\n')}\n`
}
