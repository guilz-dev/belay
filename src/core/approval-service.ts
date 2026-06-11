import { verifyApprovalToken } from './approval-token.js'
import { compactApprovals } from './approval.js'
import type { BelayConfigV3 } from './config.js'
import { configuredControlPlaneDir } from './config.js'
import type { ApprovalStateFile } from './types.js'

export interface ApprovalStore {
  loadPending: () => Promise<{ filePath: string; state: ApprovalStateFile }>
  loadApproved: () => Promise<{ filePath: string; state: ApprovalStateFile }>
  writePending: (filePath: string, state: ApprovalStateFile) => Promise<void>
  writeApproved: (filePath: string, state: ApprovalStateFile) => Promise<void>
}

export async function recordApproval(params: {
  approvalId: string
  config: BelayConfigV3
  store: ApprovalStore
  token?: string
}): Promise<{ ok: boolean; message: string; approval?: ApprovalStateFile['approvals'][number] }> {
  const { approvalId, config, store, token } = params

  if (config.approvalSigning.required) {
    if (!token) {
      return { ok: false, message: 'Signed approval token required for out-of-band approval.' }
    }
    const controlPlaneDir = configuredControlPlaneDir(config)
    const verified = await verifyApprovalToken(token, controlPlaneDir)
    if (!verified || verified.approvalId !== approvalId) {
      return { ok: false, message: 'Invalid or expired signed approval token.' }
    }
  }

  const pending = await store.loadPending()
  pending.state = compactApprovals(pending.state)
  const index = pending.state.approvals.findIndex((approval) => approval.approvalId === approvalId)
  if (index === -1) {
    await store.writePending(pending.filePath, pending.state)
    return { ok: false, message: 'Belay approval not found or expired.' }
  }

  const [approval] = pending.state.approvals.splice(index, 1)
  await store.writePending(pending.filePath, pending.state)

  const approved = await store.loadApproved()
  approved.state = compactApprovals(approved.state)
  approved.state.approvals.push({
    ...approval,
    approvedAt: new Date().toISOString(),
  })
  await store.writeApproved(approved.filePath, approved.state)

  return {
    ok: true,
    message: `Belay approval recorded for ${approvalId}. Retry the original action once before it expires.`,
    approval,
  }
}
