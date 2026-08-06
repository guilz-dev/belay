import { randomUUID } from 'node:crypto'

import type { ApprovalRecord, ApprovalStateFile } from '../types.js'
import { hashCapabilityRequests } from './capability-request-hash.js'
import type { CapabilityGrantV1 } from './grant.js'
import { CAPABILITY_GRANT_VERSION } from './grant.js'
import type { CapabilityRequestV1 } from './request.js'

export const APPROVAL_STATE_VERSION_V3 = 3 as const

export function normalizeApprovalStateVersion(state: ApprovalStateFile): ApprovalStateFile {
  const version =
    state.version === APPROVAL_STATE_VERSION_V3
      ? APPROVAL_STATE_VERSION_V3
      : state.version === 2
        ? 2
        : 1
  return { ...state, version }
}

export function upgradeApprovalStateToV3(state: ApprovalStateFile): ApprovalStateFile {
  const normalized = normalizeApprovalStateVersion(state)
  if (normalized.version === APPROVAL_STATE_VERSION_V3) {
    return normalized
  }
  return {
    version: APPROVAL_STATE_VERSION_V3,
    approvals: normalized.approvals.map((approval) => ({
      ...approval,
      capabilityRequestHash:
        approval.capabilityRequestHash ??
        (approval.capabilityRequests?.length
          ? hashCapabilityRequests(approval.capabilityRequests)
          : undefined),
    })),
  }
}

export function attachCapabilityEnvelope(
  approval: ApprovalRecord,
  capabilityRequests?: CapabilityRequestV1[],
): ApprovalRecord {
  if (!capabilityRequests?.length) {
    return approval
  }
  return {
    ...approval,
    capabilityRequests,
    capabilityRequestHash: hashCapabilityRequests(capabilityRequests),
  }
}

export function mintCapabilityGrant(params: {
  approval: ApprovalRecord
  capabilityRequests: CapabilityRequestV1[]
  issuer?: string
  maxUses?: number
}): CapabilityGrantV1 | null {
  const request = params.capabilityRequests[0]
  if (!request) {
    return null
  }
  const expiresAt = params.approval.expiresAt
  return {
    version: CAPABILITY_GRANT_VERSION,
    grantId: `grant_${params.approval.approvalId}`,
    principal: request.principal,
    action: request.action,
    resource: request.resource,
    inputFingerprint: request.context.inputFingerprint,
    issuedAt: params.approval.approvedAt ?? new Date().toISOString(),
    expiresAt,
    maxUses: params.maxUses ?? 1,
    usesRemaining: params.maxUses ?? 1,
    issuer: params.issuer ?? 'belay-approval-v3',
  }
}

export function mintGrantForApprovedRecord(approval: ApprovalRecord): ApprovalRecord {
  if (approval.grant || !approval.capabilityRequests?.length) {
    return approval
  }
  const grant = mintCapabilityGrant({
    approval,
    capabilityRequests: approval.capabilityRequests,
  })
  if (!grant) {
    return approval
  }
  return { ...approval, grant }
}

export function newGrantId(): string {
  return `grant_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}
