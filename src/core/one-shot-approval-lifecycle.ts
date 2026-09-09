import { compactApprovalsAt } from './approval.js'
import { APPROVAL_STATE_VERSION_V3, mintGrantForApprovedRecord } from './capability/approval-v3.js'
import {
  approvalGrantBundleExhausted,
  consumeApprovedRecordGrantBundle,
  decrementApprovalLegacyGrant,
  type GrantBundleValidationFailureReason,
  grantsFromApproval,
  validateAndConsumeGrantBundle,
  validateGrantBundleForLeaseReuse,
} from './capability/grant-lease.js'
import type { CapabilityRequestV1 } from './capability/request.js'
import type { ApprovalRecord, ApprovalStateFile } from './types.js'

export interface PendingApprovalTransition {
  state: ApprovalStateFile
  approval: ApprovalRecord
  created: boolean
}

export function ensurePendingApprovalTransition(params: {
  state: ApprovalStateFile
  candidate: ApprovalRecord
  nowMs: number
}): PendingApprovalTransition {
  const compacted = compactApprovalsAt(params.state, params.nowMs)
  const existing = compacted.approvals.find(
    (approval) =>
      approval.kind === params.candidate.kind &&
      approval.fingerprint === params.candidate.fingerprint &&
      approval.repoRoot === params.candidate.repoRoot,
  )
  if (existing) {
    return { state: compacted, approval: existing, created: false }
  }
  return {
    state: {
      ...compacted,
      version: APPROVAL_STATE_VERSION_V3,
      approvals: [...compacted.approvals, params.candidate],
    },
    approval: params.candidate,
    created: true,
  }
}

export interface RecordedApprovalTransition {
  pending: ApprovalStateFile
  approved: ApprovalStateFile
  approval: ApprovalRecord
}

export function recordApprovalTransition(params: {
  pending: ApprovalStateFile
  approved: ApprovalStateFile
  approvalId: string
  expected: Pick<ApprovalRecord, 'fingerprint' | 'repoRoot'>
  approvedAt: string
  nowMs: number
}): RecordedApprovalTransition | null {
  const pending = compactApprovalsAt(params.pending, params.nowMs)
  const approved = compactApprovalsAt(params.approved, params.nowMs)
  const pendingApproval = pending.approvals.find(
    (approval) =>
      approval.approvalId === params.approvalId &&
      approval.fingerprint === params.expected.fingerprint &&
      approval.repoRoot === params.expected.repoRoot,
  )
  const existing = approved.approvals.find((approval) => approval.approvalId === params.approvalId)

  if (
    existing &&
    (existing.fingerprint !== params.expected.fingerprint ||
      existing.repoRoot !== params.expected.repoRoot)
  ) {
    return null
  }
  if (!pendingApproval) {
    return existing ? { pending, approved, approval: existing } : null
  }

  const pendingApprovals = [...pending.approvals]
  const pendingIndex = pendingApprovals.findIndex(
    (approval) =>
      approval.approvalId === params.approvalId &&
      approval.fingerprint === pendingApproval.fingerprint &&
      approval.repoRoot === pendingApproval.repoRoot,
  )
  pendingApprovals.splice(pendingIndex, 1)
  const nextPending = { ...pending, approvals: pendingApprovals }
  const approvedRecord =
    existing ??
    mintGrantForApprovedRecord({
      ...pendingApproval,
      approvedAt: params.approvedAt,
    })

  return {
    pending: nextPending,
    approved: existing
      ? approved
      : {
          ...approved,
          version: APPROVAL_STATE_VERSION_V3,
          approvals: [...approved.approvals, approvedRecord],
        },
    approval: approvedRecord,
  }
}

export type ApprovedGateClaim =
  | { status: 'consumed'; approval: ApprovalRecord; firstExecution: boolean }
  | {
      status: 'invalid_bundle'
      approval: ApprovalRecord
      reason: GrantBundleValidationFailureReason
    }
  | null

export interface ApprovedGateClaimTransition {
  state: ApprovalStateFile
  result: ApprovedGateClaim
}

export function claimApprovedForGateTransition(params: {
  state: ApprovalStateFile
  kind: ApprovalRecord['kind']
  fingerprint: string
  repoRoot: string
  requests: readonly CapabilityRequestV1[]
  executionLeaseExpiresAt: string
  nowMs: number
}): ApprovedGateClaimTransition {
  const compacted = compactApprovalsAt(params.state, params.nowMs)
  const approvals = [...compacted.approvals]
  const matchIndex = approvals.findIndex(
    (approval) =>
      approval.kind === params.kind &&
      approval.fingerprint === params.fingerprint &&
      approval.repoRoot === params.repoRoot,
  )
  if (matchIndex === -1) {
    return { state: { ...compacted, approvals }, result: null }
  }

  const approval = approvals[matchIndex]
  if (!approval) {
    return { state: { ...compacted, approvals }, result: null }
  }
  if (approval.executionLeaseExpiresAt) {
    if (approval.grantBundleVersion === 1) {
      const validated = validateGrantBundleForLeaseReuse(approval, params.requests, params.nowMs)
      if (!validated.ok) {
        approvals.splice(matchIndex, 1)
        return {
          state: { ...compacted, approvals },
          result: { status: 'invalid_bundle', approval, reason: validated.reason },
        }
      }
    }
    return {
      state: { ...compacted, approvals },
      result: { status: 'consumed', approval, firstExecution: false },
    }
  }
  if (approvalGrantBundleExhausted(approval)) {
    approvals.splice(matchIndex, 1)
    return { state: { ...compacted, approvals }, result: null }
  }

  let updatedApproval = approval
  const bundle = grantsFromApproval(approval)
  if (approval.grantBundleVersion === 1) {
    const validated = validateAndConsumeGrantBundle(approval, params.requests, params.nowMs)
    if (!validated.ok) {
      approvals.splice(matchIndex, 1)
      return {
        state: { ...compacted, approvals },
        result: { status: 'invalid_bundle', approval, reason: validated.reason },
      }
    }
    updatedApproval = validated.approval
  } else if (bundle.length > 0) {
    const consumed = consumeApprovedRecordGrantBundle(approval, params.nowMs)
    if (!consumed.consumed) {
      return { state: { ...compacted, approvals }, result: null }
    }
    updatedApproval = consumed.approval
  } else if (approval.grant) {
    updatedApproval = decrementApprovalLegacyGrant(approval)
  }

  approvals[matchIndex] = {
    ...updatedApproval,
    executionLeaseExpiresAt: params.executionLeaseExpiresAt,
  }
  return {
    state: { ...compacted, approvals },
    result: { status: 'consumed', approval: updatedApproval, firstExecution: true },
  }
}

export interface ApprovedReplayClaimTransition {
  state: ApprovalStateFile
  approval: ApprovalRecord | null
}

export function claimApprovedForReplayTransition(params: {
  state: ApprovalStateFile
  approvalId: string
  nowMs: number
}): ApprovedReplayClaimTransition {
  const compacted = compactApprovalsAt(params.state, params.nowMs)
  const approvals = [...compacted.approvals]
  const matchIndex = approvals.findIndex((approval) => approval.approvalId === params.approvalId)
  if (matchIndex === -1) {
    return { state: { ...compacted, approvals }, approval: null }
  }
  const [approval] = approvals.splice(matchIndex, 1)
  return { state: { ...compacted, approvals }, approval: approval ?? null }
}

export interface DiscardApprovedTransition {
  state: ApprovalStateFile
  discarded: boolean
}

export function discardApprovedTransition(params: {
  state: ApprovalStateFile
  approvalId: string
  nowMs: number
}): DiscardApprovedTransition {
  const compacted = compactApprovalsAt(params.state, params.nowMs)
  const approvals = [...compacted.approvals]
  const matchIndex = approvals.findIndex((approval) => approval.approvalId === params.approvalId)
  if (matchIndex === -1) {
    return { state: { ...compacted, approvals }, discarded: false }
  }
  approvals.splice(matchIndex, 1)
  return { state: { ...compacted, approvals }, discarded: true }
}
