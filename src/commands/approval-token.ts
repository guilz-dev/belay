import path from 'node:path'

import { loadApprovalState, loadConfigFile } from '../config-io.js'
import { isExpired } from '../core/approval.js'
import { issueApprovalToken } from '../core/approval-token.js'
import { configuredControlPlaneDir } from '../core/config.js'
import { canonicalPath } from '../core/path-utils.js'

export interface IssuePendingApprovalTokenOptions {
  targetDir?: string
  approvalId: string
}

export interface IssuePendingApprovalTokenResult {
  ok: boolean
  message: string
  token?: string
}

export async function issuePendingApprovalToken(
  options: IssuePendingApprovalTokenOptions,
): Promise<IssuePendingApprovalTokenResult> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const pending = await loadApprovalState(repoRoot, 'pending-approvals.json', config)
  const approval = pending.approvals.find((entry) => entry.approvalId === options.approvalId)
  if (!approval || isExpired(approval)) {
    return { ok: false, message: `Pending approval not found: ${options.approvalId}` }
  }
  if (canonicalPath(approval.repoRoot) !== canonicalPath(repoRoot)) {
    return { ok: false, message: `Approval repository does not match: ${options.approvalId}` }
  }

  const token = await issueApprovalToken(
    {
      approvalId: approval.approvalId,
      fingerprint: approval.fingerprint,
      repoRoot: approval.repoRoot,
      issuedAt: approval.createdAt,
      expiresAt: approval.expiresAt,
    },
    configuredControlPlaneDir(config),
  )
  return { ok: true, token, message: token }
}
