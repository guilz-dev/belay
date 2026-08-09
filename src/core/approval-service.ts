import {
  approvedApprovalsPath,
  loadApprovalState,
  pendingApprovalsPath,
  saveApprovalState,
} from '../config-io.js'
import { compactApprovals } from './approval.js'
import { buildApprovalRecordedMessage, type ReplayAdapterId } from './approval-replay.js'
import { verifyApprovalToken } from './approval-token.js'
import { mutateApprovalStateWithRetry } from './capability/approval-state-mutation.js'
import { APPROVAL_STATE_VERSION_V3, mintGrantForApprovedRecord } from './capability/approval-v3.js'
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
  /** When true, require a signed token (out-of-band CLI path). Editor prompts skip this. */
  requireSignedToken?: boolean
  adapter?: ReplayAdapterId
}): Promise<{ ok: boolean; message: string; approval?: ApprovalStateFile['approvals'][number] }> {
  const { approvalId, config, store, token, requireSignedToken = false, adapter } = params

  const pending = await store.loadPending()
  pending.state = compactApprovals(pending.state)
  const index = pending.state.approvals.findIndex((approval) => approval.approvalId === approvalId)
  if (index === -1) {
    await store.writePending(pending.filePath, pending.state)
    return { ok: false, message: 'Belay approval not found or expired.' }
  }

  const [approval] = pending.state.approvals.slice(index, index + 1)

  if (requireSignedToken) {
    if (!token) {
      return { ok: false, message: 'Signed approval token required for out-of-band approval.' }
    }
    const controlPlaneDir = configuredControlPlaneDir(config)
    const verified = await verifyApprovalToken(token, controlPlaneDir)
    if (!verified || verified.approvalId !== approvalId) {
      return { ok: false, message: 'Invalid or expired signed approval token.' }
    }
    if (verified.fingerprint !== approval.fingerprint || verified.repoRoot !== approval.repoRoot) {
      return { ok: false, message: 'Signed approval token does not match the pending approval.' }
    }
  }

  pending.state.approvals.splice(index, 1)
  await store.writePending(pending.filePath, pending.state)

  const approved = await store.loadApproved()
  approved.state = compactApprovals(approved.state)
  const approvedRecord = mintGrantForApprovedRecord({
    ...approval,
    approvedAt: new Date().toISOString(),
  })
  approved.state.version = APPROVAL_STATE_VERSION_V3
  approved.state.revision = (approved.state.revision ?? 0) + 1
  approved.state.approvals.push(approvedRecord)
  await store.writeApproved(approved.filePath, approved.state)

  return {
    ok: true,
    message: buildApprovalRecordedMessage(config, approval, adapter),
    approval: approvedRecord,
  }
}

/** @deprecated Replay callers must claim before execution with `claimApprovedForReplay`. */
export async function consumeApprovedAfterCliReplay(params: {
  approvalId: string
  store: ApprovalStore
}): Promise<void> {
  await claimApprovedForReplay(params)
}

/** Atomically spend and return a one-shot approval before executing its replay. */
export async function claimApprovedForReplay(params: {
  approvalId: string
  store: ApprovalStore
}): Promise<ApprovalStateFile['approvals'][number] | null> {
  return mutateApprovalStateWithRetry({
    load: params.store.loadApproved,
    write: params.store.writeApproved,
    mutate: (state) => {
      const compacted = compactApprovals(state)
      const index = compacted.approvals.findIndex(
        (approval) => approval.approvalId === params.approvalId,
      )
      if (index === -1) {
        return null
      }
      const [claimed] = compacted.approvals.splice(index, 1)
      return { state: compacted, result: claimed ?? null }
    },
  })
}

export function createGateApprovalStore(repoRoot: string, config: BelayConfigV3): ApprovalStore {
  return {
    async loadPending() {
      const filePath = pendingApprovalsPath(repoRoot, config)
      return {
        filePath,
        state: await loadApprovalState(repoRoot, 'pending-approvals.json', config),
      }
    },
    async loadApproved() {
      const filePath = approvedApprovalsPath(repoRoot, config)
      return {
        filePath,
        state: await loadApprovalState(repoRoot, 'approved-approvals.json', config),
      }
    },
    async writePending(_filePath, state) {
      await saveApprovalState(repoRoot, 'pending-approvals.json', state, config)
    },
    async writeApproved(_filePath, state) {
      await saveApprovalState(repoRoot, 'approved-approvals.json', state, config)
    },
  }
}

export function gateApprovalStoreFromDeps(deps: {
  loadApprovals: (
    fileName: 'pending-approvals.json' | 'approved-approvals.json',
  ) => Promise<{ filePath: string; state: ApprovalStateFile }>
  writeApprovals: (filePath: string, state: ApprovalStateFile) => Promise<void>
}): ApprovalStore {
  return {
    loadPending: () => deps.loadApprovals('pending-approvals.json'),
    loadApproved: () => deps.loadApprovals('approved-approvals.json'),
    writePending: (filePath, state) => deps.writeApprovals(filePath, state),
    writeApproved: (filePath, state) => deps.writeApprovals(filePath, state),
  }
}
