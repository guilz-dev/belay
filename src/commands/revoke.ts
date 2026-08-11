import path from 'node:path'

import {
  loadApprovalState,
  loadConfigFile,
  pendingApprovalsPath,
  saveApprovalState,
} from '../config-io.js'
import { compactApprovals } from '../core/approval.js'
import { mutateApprovalStateWithRetry } from '../core/capability/approval-state-mutation.js'
import type { RevokeOptions } from '../types.js'

export async function revokeApproval(
  options: RevokeOptions,
): Promise<{ ok: boolean; message: string }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const revoked = await mutateApprovalStateWithRetry({
    load: async () => ({
      filePath: pendingApprovalsPath(repoRoot, config),
      state: await loadApprovalState(repoRoot, 'pending-approvals.json', config),
    }),
    write: async (_filePath, state) =>
      saveApprovalState(repoRoot, 'pending-approvals.json', state, config),
    mutate: (state) => {
      const compacted = compactApprovals(state)
      const index = compacted.approvals.findIndex(
        (approval) => approval.approvalId === options.approvalId,
      )
      if (index === -1) {
        return null
      }
      compacted.approvals.splice(index, 1)
      return { state: compacted, result: true }
    },
  })

  if (revoked !== true) {
    return {
      ok: false,
      message: `Pending approval ${options.approvalId} not found or already expired.`,
    }
  }

  return {
    ok: true,
    message: `Revoked pending approval ${options.approvalId}.`,
  }
}
