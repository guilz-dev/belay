import {
  approvedApprovalsPath,
  loadApprovalState,
  pendingApprovalsPath,
  saveApprovalState,
} from '../config-io.js'
import { compactApprovals } from './approval.js'
import { buildApprovalRecordedMessage, type ReplayAdapterId } from './approval-replay.js'
import { verifyApprovalToken } from './approval-token.js'
import {
  mutateApprovalStateWithRetry,
  mutatePendingAndApprovedWithRetry,
} from './capability/approval-state-mutation.js'
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

  const [pending, approved] = await Promise.all([store.loadPending(), store.loadApproved()])
  pending.state = compactApprovals(pending.state)
  approved.state = compactApprovals(approved.state)
  const pendingApproval = pending.state.approvals.find((entry) => entry.approvalId === approvalId)
  const approvedApproval = approved.state.approvals.find((entry) => entry.approvalId === approvalId)
  const approval = pendingApproval ?? approvedApproval
  if (!approval) {
    await mutateApprovalStateWithRetry({
      load: store.loadPending,
      write: store.writePending,
      mutate: (state) => ({ state: compactApprovals(state), result: true }),
    })
    return { ok: false, message: 'Belay approval not found or expired.' }
  }

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

  if (!pendingApproval && approvedApproval) {
    return {
      ok: true,
      message: buildApprovalRecordedMessage(config, approvedApproval, adapter),
      approval: approvedApproval,
    }
  }

  const recorded = await mutatePendingAndApprovedWithRetry({
    loadPending: store.loadPending,
    loadApproved: store.loadApproved,
    writePending: store.writePending,
    writeApproved: store.writeApproved,
    mutate: (pendingState, approvedState) => {
      const compactedPending = compactApprovals(pendingState)
      const compactedApproved = compactApprovals(approvedState)
      const existing = compactedApproved.approvals.find((entry) => entry.approvalId === approvalId)
      if (
        existing &&
        (existing.fingerprint !== approval.fingerprint || existing.repoRoot !== approval.repoRoot)
      ) {
        return null
      }
      const pendingIndex = compactedPending.approvals.findIndex(
        (entry) =>
          entry.approvalId === approvalId &&
          entry.fingerprint === approval.fingerprint &&
          entry.repoRoot === approval.repoRoot,
      )
      if (pendingIndex === -1) {
        return existing
          ? {
              pending: compactedPending,
              approved: compactedApproved,
              result: existing,
            }
          : null
      }
      const [claimed] = compactedPending.approvals.splice(pendingIndex, 1)
      if (!claimed) {
        return null
      }
      const approvedRecord =
        existing ??
        mintGrantForApprovedRecord({
          ...claimed,
          approvedAt: new Date().toISOString(),
        })
      if (!existing) {
        compactedApproved.version = APPROVAL_STATE_VERSION_V3
        compactedApproved.approvals.push(approvedRecord)
      }
      return {
        pending: compactedPending,
        approved: compactedApproved,
        result: approvedRecord,
      }
    },
  })
  if (!recorded) {
    return { ok: false, message: 'Belay approval not found, expired, or already claimed.' }
  }

  return {
    ok: true,
    message: buildApprovalRecordedMessage(config, recorded, adapter),
    approval: recorded,
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
