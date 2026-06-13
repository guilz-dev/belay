import path from 'node:path'

import {
  belayStateDir,
  countExpiredPending,
  loadApprovalState,
  loadConfigFile,
  pendingApprovalsPath,
  repoLocalStateDirFor,
} from '../config-io.js'
import { compactApprovals } from '../core/approval.js'
import { loadOperationalInsights } from '../operational-insights.js'
import type { StatusOptions, StatusReport } from '../types.js'
import { collectHealthSnapshot } from './health-snapshot.js'

export async function statusProject(options: StatusOptions = {}): Promise<StatusReport> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const pendingRaw = await loadApprovalState(repoRoot, 'pending-approvals.json', config)
  const approvedRaw = await loadApprovalState(repoRoot, 'approved-approvals.json', config)
  const expiredPendingCount = countExpiredPending(pendingRaw)
  const operational = await loadOperationalInsights({ targetDir: repoRoot })
  const health = await collectHealthSnapshot({ targetDir: repoRoot, adapter: config.adapter })

  return {
    repoRoot,
    approvalStateDir: belayStateDir(config, repoLocalStateDirFor(repoRoot, config)),
    pending: compactApprovals(pendingRaw).approvals,
    approved: compactApprovals(approvedRaw).approvals,
    expiredPendingCount,
    dogfood: operational.dogfood,
    health,
  }
}

export function formatStatusReport(report: StatusReport): string {
  const { health } = report
  const lines = [
    `agent-belay status for ${report.repoRoot}`,
    `Adapter: ${health.adapter} (scope=${health.installScope})`,
    `Floor installed: ${health.floorInstalled ? 'yes' : 'no'}`,
    `Skill installed: ${health.skillInstalled ? 'yes' : 'no'}`,
    ...(health.skillOnly
      ? [
          'Skill-only mode: yes — hooks are missing or incomplete. Run `npx agent-belay init` to install the enforcement floor.',
        ]
      : []),
    `Approval state: ${report.approvalStateDir}`,
    `Pending: ${report.pending.length}`,
    `Approved (awaiting use): ${report.approved.length}`,
    `Expired pending (not yet compacted): ${report.expiredPendingCount}`,
    `Dogfood: ${report.dogfood.active ? 'active' : 'inactive'} (mode=${report.dogfood.mode}, unknownLocalEffect=${report.dogfood.unknownLocalEffect})`,
    `Metrics: ${report.dogfood.gateEvents} gate events, ${report.dogfood.wouldBlockCount} would-block (${(report.dogfood.wouldBlockRate * 100).toFixed(1)}%)`,
    `Ready for enforce: ${report.dogfood.readyForEnforce ? 'yes' : 'not yet'}`,
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
