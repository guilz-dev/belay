import type { ApprovalStateFile } from '../types.js'
import type { CapabilityGrantV1 } from './grant.js'
import { isGrantScopeTooBroad } from './grant.js'
import { grantMatchesRequest } from './grant-match.js'
import type { CapabilityRequestV1 } from './request.js'

export function grantsFromApprovedState(
  state: ApprovalStateFile,
  repoRoot: string,
): CapabilityGrantV1[] {
  const now = Date.now()
  return state.approvals
    .filter((approval) => approval.repoRoot === repoRoot)
    .map((approval) => approval.grant)
    .filter((grant): grant is CapabilityGrantV1 => {
      if (!grant) {
        return false
      }
      if (isGrantScopeTooBroad(grant)) {
        return false
      }
      const expires = Date.parse(grant.expiresAt)
      return Number.isFinite(expires) && expires > now && grant.usesRemaining > 0
    })
}

export function consumeGrantLease(
  state: ApprovalStateFile,
  grantId: string,
): { state: ApprovalStateFile; consumed: boolean } {
  let consumed = false
  const approvals = state.approvals.map((approval) => {
    const grant = approval.grant
    if (!grant || grant.grantId !== grantId || grant.usesRemaining <= 0) {
      return approval
    }
    consumed = true
    const usesRemaining = grant.usesRemaining - 1
    return {
      ...approval,
      grant: {
        ...grant,
        usesRemaining,
      },
    }
  })
  return {
    state: { ...state, approvals },
    consumed,
  }
}

export function findMatchingGrant(
  grants: CapabilityGrantV1[] | undefined,
  request: CapabilityRequestV1,
): CapabilityGrantV1 | undefined {
  if (!grants?.length) {
    return undefined
  }
  return grants.find((grant) => grantMatchesRequest(grant, request))
}
