import {
  approvedApprovalsPath,
  loadApprovalState,
  pendingApprovalsPath,
  saveApprovalState,
} from '../config-io.js'
import { compactApprovalsAt } from './approval.js'
import { buildApprovalRecordedMessage, type ReplayAdapterId } from './approval-replay.js'
import { verifyApprovalToken } from './approval-token.js'
import {
  mutateApprovalStateWithRetry,
  mutatePendingAndApprovedWithRetry,
} from './capability/approval-state-mutation.js'
import type { CapabilityRequestV1 } from './capability/request.js'
import type { BelayConfigV3 } from './config.js'
import { configuredControlPlaneDir } from './config.js'
import {
  type ApprovedGateClaim,
  claimApprovedForGateTransition,
  claimApprovedForReplayTransition,
  discardApprovedTransition,
  ensurePendingApprovalTransition,
  recordApprovalTransition,
} from './one-shot-approval-lifecycle.js'
import type { ApprovalRecord, ApprovalStateFile } from './types.js'

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
  const nowMs = Date.now()

  const [pending, approved] = await Promise.all([store.loadPending(), store.loadApproved()])
  pending.state = compactApprovalsAt(pending.state, nowMs)
  approved.state = compactApprovalsAt(approved.state, nowMs)
  const pendingApproval = pending.state.approvals.find((entry) => entry.approvalId === approvalId)
  const approvedApproval = approved.state.approvals.find((entry) => entry.approvalId === approvalId)
  const approval = pendingApproval ?? approvedApproval
  if (!approval) {
    await mutateApprovalStateWithRetry({
      load: store.loadPending,
      write: store.writePending,
      mutate: (state) => ({ state: compactApprovalsAt(state, nowMs), result: true }),
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
      const outcome = recordApprovalTransition({
        pending: pendingState,
        approved: approvedState,
        approvalId,
        expected: approval,
        approvedAt: new Date(nowMs).toISOString(),
        nowMs,
      })
      return outcome
        ? { pending: outcome.pending, approved: outcome.approved, result: outcome.approval }
        : null
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
  const nowMs = Date.now()
  return mutateApprovalStateWithRetry({
    load: params.store.loadApproved,
    write: params.store.writeApproved,
    mutate: (state) => {
      const outcome = claimApprovedForReplayTransition({
        state,
        approvalId: params.approvalId,
        nowMs,
      })
      if (!outcome.approval) {
        return null
      }
      return { state: outcome.state, result: outcome.approval }
    },
  })
}

export async function ensurePendingOneShotApproval(params: {
  candidate: ApprovalRecord
  store: ApprovalStore
}): Promise<{ approval: ApprovalRecord; created: boolean }> {
  const nowMs = Date.now()
  const outcome = await mutateApprovalStateWithRetry({
    load: params.store.loadPending,
    write: params.store.writePending,
    mutate: (state) => {
      const transition = ensurePendingApprovalTransition({
        state,
        candidate: params.candidate,
        nowMs,
      })
      return {
        state: transition.state,
        result: { approval: transition.approval, created: transition.created },
      }
    },
  })
  if (!outcome) {
    throw new Error('Failed to persist pending approval')
  }
  return outcome
}

export async function claimApprovedForGate(params: {
  kind: ApprovalRecord['kind']
  fingerprint: string
  repoRoot: string
  requests: CapabilityRequestV1[]
  executionLeaseMs: number
  store: ApprovalStore
}): Promise<ApprovedGateClaim> {
  const nowMs = Date.now()
  const executionLeaseExpiresAt = new Date(nowMs + params.executionLeaseMs).toISOString()
  return mutateApprovalStateWithRetry<ApprovedGateClaim>({
    load: params.store.loadApproved,
    write: params.store.writeApproved,
    mutate: (state) => {
      const outcome = claimApprovedForGateTransition({
        state,
        kind: params.kind,
        fingerprint: params.fingerprint,
        repoRoot: params.repoRoot,
        requests: params.requests,
        executionLeaseExpiresAt,
        nowMs,
      })
      return { state: outcome.state, result: outcome.result }
    },
  })
}

export async function discardApprovedOneShotApproval(params: {
  approvalId: string
  store: ApprovalStore
}): Promise<void> {
  const nowMs = Date.now()
  const discarded = await mutateApprovalStateWithRetry({
    load: params.store.loadApproved,
    write: params.store.writeApproved,
    mutate: (state) => {
      const outcome = discardApprovedTransition({
        state,
        approvalId: params.approvalId,
        nowMs,
      })
      return { state: outcome.state, result: true }
    },
  })
  if (discarded !== true) {
    throw new Error(`Failed to discard rejected approval ${params.approvalId}`)
  }
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
