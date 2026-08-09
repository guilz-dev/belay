import { randomUUID } from 'node:crypto'

import type { ApprovalRecord, ApprovalStateFile } from '../types.js'
import { hashCapabilityRequests } from './capability-request-hash.js'
import type { CapabilityGrantV1 } from './grant.js'
import { CAPABILITY_GRANT_VERSION } from './grant.js'
import type { CapabilityRequestV1 } from './request.js'

export const APPROVAL_STATE_VERSION_V3 = 3 as const
export const EFFECT_PLAN_HASH_VERSION = 'effect-plan:v1' as const

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
  effectPlanHash?: string,
): ApprovalRecord {
  const withRequests = !capabilityRequests?.length
    ? approval
    : {
        ...approval,
        capabilityRequests,
        capabilityRequestHash: hashCapabilityRequests(capabilityRequests),
      }
  if (!effectPlanHash) {
    return withRequests
  }
  return {
    ...withRequests,
    effectPlanHash,
  }
}

/** Dual-read: expose legacy single grant as a one-element bundle without mutating storage. */
export function normalizeApprovalGrants(approval: ApprovalRecord): ApprovalRecord {
  if (approval.grants?.length) {
    return approval
  }
  if (approval.grant) {
    return { ...approval, grants: [approval.grant] }
  }
  return approval
}

export function mintCapabilityGrantForRequest(params: {
  approval: ApprovalRecord
  request: CapabilityRequestV1
  grantSuffix?: string
  issuer?: string
  maxUses?: number
}): CapabilityGrantV1 {
  const expiresAt = params.approval.expiresAt
  const suffix = params.grantSuffix ?? ''
  const grantId =
    suffix === '' || suffix === '0'
      ? `grant_${params.approval.approvalId}${suffix === '0' && params.grantSuffix !== undefined ? '_0' : ''}`
      : `grant_${params.approval.approvalId}_${suffix}`
  return {
    version: CAPABILITY_GRANT_VERSION,
    grantId,
    principal: params.request.principal,
    action: params.request.action,
    resource: params.request.resource,
    inputFingerprint: params.request.context.inputFingerprint,
    issuedAt: params.approval.approvedAt ?? new Date().toISOString(),
    expiresAt,
    maxUses: params.maxUses ?? 1,
    usesRemaining: params.maxUses ?? 1,
    issuer: params.issuer ?? 'belay-approval-v3',
  }
}

/** @deprecated Use mintCapabilityGrantBundle; returns first grant only for legacy callers. */
export function mintCapabilityGrant(params: {
  approval: ApprovalRecord
  capabilityRequests: CapabilityRequestV1[]
  issuer?: string
  maxUses?: number
}): CapabilityGrantV1 | null {
  const bundle = mintCapabilityGrantBundle(params)
  return bundle[0] ?? null
}

export function mintCapabilityGrantBundle(params: {
  approval: ApprovalRecord
  capabilityRequests: CapabilityRequestV1[]
  issuer?: string
  maxUses?: number
}): CapabilityGrantV1[] {
  if (!params.capabilityRequests.length) {
    return []
  }
  return params.capabilityRequests.map((request, index) =>
    mintCapabilityGrantForRequest({
      approval: params.approval,
      request,
      grantSuffix: params.capabilityRequests.length === 1 ? undefined : String(index),
      issuer: params.issuer,
      maxUses: params.maxUses,
    }),
  )
}

export function mintGrantForApprovedRecord(approval: ApprovalRecord): ApprovalRecord {
  const normalized = normalizeApprovalGrants(approval)
  if ((normalized.grants?.length ?? 0) > 0 || !normalized.capabilityRequests?.length) {
    return normalized
  }
  const grants = mintCapabilityGrantBundle({
    approval: normalized,
    capabilityRequests: normalized.capabilityRequests,
  })
  if (!grants.length) {
    return normalized
  }
  return {
    ...normalized,
    grants,
    grant: grants[0],
  }
}

export function newGrantId(): string {
  return `grant_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}
