import path from 'node:path'

import { loadApprovalState, loadConfigFile, saveApprovalState } from './config-io.js'
import { compactApprovals } from './core/approval.js'
import type { RevokeOptions } from './types.js'

export async function revokeApproval(
  options: RevokeOptions,
): Promise<{ ok: boolean; message: string }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const pending = await loadApprovalState(repoRoot, 'pending-approvals.json', config)
  const compacted = compactApprovals(pending)
  const index = compacted.approvals.findIndex(
    (approval) => approval.approvalId === options.approvalId,
  )

  if (index === -1) {
    return {
      ok: false,
      message: `Pending approval ${options.approvalId} not found or already expired.`,
    }
  }

  compacted.approvals.splice(index, 1)
  await saveApprovalState(repoRoot, 'pending-approvals.json', compacted, config)
  return {
    ok: true,
    message: `Revoked pending approval ${options.approvalId}.`,
  }
}
