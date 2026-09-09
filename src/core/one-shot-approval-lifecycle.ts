import { compactApprovalsAt } from './approval.js'
import { APPROVAL_STATE_VERSION_V3, mintGrantForApprovedRecord } from './capability/approval-v3.js'
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
  approvedAt: string
  nowMs: number
}): RecordedApprovalTransition | null {
  const pending = compactApprovalsAt(params.pending, params.nowMs)
  const approved = compactApprovalsAt(params.approved, params.nowMs)
  const pendingApproval = pending.approvals.find(
    (approval) => approval.approvalId === params.approvalId,
  )
  const existing = approved.approvals.find((approval) => approval.approvalId === params.approvalId)

  if (!pendingApproval) {
    return existing ? { pending, approved, approval: existing } : null
  }
  if (
    existing &&
    (existing.fingerprint !== pendingApproval.fingerprint ||
      existing.repoRoot !== pendingApproval.repoRoot)
  ) {
    return null
  }

  const nextPending = {
    ...pending,
    approvals: pending.approvals.filter(
      (approval) =>
        approval.approvalId !== params.approvalId ||
        approval.fingerprint !== pendingApproval.fingerprint ||
        approval.repoRoot !== pendingApproval.repoRoot,
    ),
  }
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
