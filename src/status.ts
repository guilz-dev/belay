import path from 'node:path'

import {
  belayStateDir,
  countExpiredPending,
  loadApprovalState,
  loadConfigFile,
  pendingApprovalsPath,
} from './config-io.js'
import { compactApprovals } from './core/approval.js'
import type { StatusOptions, StatusReport } from './types.js'

export async function statusProject(options: StatusOptions = {}): Promise<StatusReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const pendingRaw = await loadApprovalState(repoRoot, 'pending-approvals.json', config)
  const approvedRaw = await loadApprovalState(repoRoot, 'approved-approvals.json', config)
  const expiredPendingCount = countExpiredPending(pendingRaw)

  return {
    repoRoot,
    approvalStateDir: belayStateDir(config, repoRoot),
    pending: compactApprovals(pendingRaw).approvals,
    approved: compactApprovals(approvedRaw).approvals,
    expiredPendingCount,
  }
}

export function formatStatusReport(report: StatusReport): string {
  const lines = [
    `agent-belay status for ${report.repoRoot}`,
    `Approval state: ${report.approvalStateDir}`,
    `Pending: ${report.pending.length}`,
    `Approved (awaiting use): ${report.approved.length}`,
    `Expired pending (not yet compacted): ${report.expiredPendingCount}`,
    '',
  ]

  if (report.pending.length === 0 && report.approved.length === 0) {
    lines.push('No active approvals.')
    return `${lines.join('\n')}\n`
  }

  if (report.pending.length > 0) {
    lines.push('Pending approvals:')
    for (const approval of report.pending) {
      lines.push(
        `- ${approval.approvalId} [${approval.kind}] ${approval.reason} — expires ${approval.expiresAt}`,
      )
    }
    lines.push('')
  }

  if (report.approved.length > 0) {
    lines.push('Approved (one-shot, not yet consumed):')
    for (const approval of report.approved) {
      lines.push(
        `- ${approval.approvalId} [${approval.kind}] ${approval.reason} — expires ${approval.expiresAt}`,
      )
    }
  }

  return `${lines.join('\n')}\n`
}

export { pendingApprovalsPath }
