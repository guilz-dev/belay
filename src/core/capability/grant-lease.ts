import type { ApprovalRecord, ApprovalStateFile } from '../types.js'
import type { CapabilityGrantV1 } from './grant.js'
import { isGrantScopeTooBroad } from './grant.js'
import { grantMatchesRequest } from './grant-match.js'
import type { CapabilityRequestV1 } from './request.js'

function isActiveGrant(grant: CapabilityGrantV1, now: number): boolean {
  if (isGrantScopeTooBroad(grant)) {
    return false
  }
  const expires = Date.parse(grant.expiresAt)
  return Number.isFinite(expires) && expires > now && grant.usesRemaining > 0
}

export function grantsFromApproval(approval: {
  grant?: CapabilityGrantV1
  grants?: CapabilityGrantV1[]
}): CapabilityGrantV1[] {
  if (approval.grants?.length) {
    return approval.grants
  }
  if (approval.grant) {
    return [approval.grant]
  }
  return []
}

export function approvalGrantBundleExhausted(approval: {
  grant?: CapabilityGrantV1
  grants?: CapabilityGrantV1[]
}): boolean {
  const bundle = grantsFromApproval(approval)
  if (!bundle.length) {
    return false
  }
  return bundle.every((grant) => grant.usesRemaining <= 0)
}

export function consumeApprovalGrantBundle(
  approval: ApprovalRecord,
  requests: readonly CapabilityRequestV1[],
): { approval: ApprovalRecord; consumed: boolean } {
  const bundle = grantsFromApproval(approval)
  if (!bundle.length || !requests.length) {
    return { approval, consumed: false }
  }
  const grants = [...bundle]
  const now = Date.now()
  for (const request of requests) {
    const index = grants.findIndex((grant) => {
      return isActiveGrant(grant, now) && grantMatchesRequest(grant, request)
    })
    if (index === -1) {
      return { approval, consumed: false }
    }
    const grant = grants[index]
    if (!grant) {
      return { approval, consumed: false }
    }
    grants[index] = decrementGrant(grant)
  }
  return {
    approval: {
      ...approval,
      grants,
      grant: grants[0],
    },
    consumed: true,
  }
}

/** Consume every grant in an approved record after fingerprint/hash replay validation. */
export function consumeApprovedRecordGrantBundle(approval: ApprovalRecord): {
  approval: ApprovalRecord
  consumed: boolean
} {
  const bundle = grantsFromApproval(approval)
  const now = Date.now()
  if (
    !bundle.length ||
    bundle.some((grant) => {
      const expires = Date.parse(grant.expiresAt)
      return !Number.isFinite(expires) || expires <= now || grant.usesRemaining <= 0
    })
  ) {
    return { approval, consumed: false }
  }
  const grants = bundle.map((grant) => decrementGrant(grant))
  return {
    approval: {
      ...approval,
      grants,
      grant: grants[0],
    },
    consumed: true,
  }
}

export function decrementApprovalLegacyGrant(approval: ApprovalRecord): ApprovalRecord {
  const bundle = grantsFromApproval(approval)
  if (!bundle.length) {
    return approval
  }
  const grants = bundle.map((grant, index) => (index === 0 ? decrementGrant(grant) : grant))
  return {
    ...approval,
    grants,
    grant: grants[0],
  }
}

export function grantsFromApprovedState(
  state: ApprovalStateFile,
  repoRoot: string,
): CapabilityGrantV1[] {
  const now = Date.now()
  const collected: CapabilityGrantV1[] = []
  for (const approval of state.approvals) {
    if (approval.repoRoot !== repoRoot) {
      continue
    }
    for (const grant of grantsFromApproval(approval)) {
      if (isActiveGrant(grant, now)) {
        collected.push(grant)
      }
    }
  }
  return collected
}

function decrementGrant(grant: CapabilityGrantV1): CapabilityGrantV1 {
  return {
    ...grant,
    usesRemaining: grant.usesRemaining - 1,
  }
}

export function consumeGrantLease(
  state: ApprovalStateFile,
  grantId: string,
): { state: ApprovalStateFile; consumed: boolean } {
  let consumed = false
  const approvals = state.approvals.map((approval) => {
    const bundle = grantsFromApproval(approval)
    const index = bundle.findIndex((g) => g.grantId === grantId)
    if (index === -1) {
      return approval
    }
    const grant = bundle[index]
    if (!grant || grant.usesRemaining <= 0) {
      return approval
    }
    consumed = true
    const updated = decrementGrant(grant)
    const grants = [...bundle]
    grants[index] = updated
    return {
      ...approval,
      grants,
      grant: grants[0],
    }
  })
  return {
    state: { ...state, approvals },
    consumed,
  }
}

/** Consume one lease for each request; all must succeed (atomic bundle consumption). */
export function consumeGrantLeasesForRequests(
  state: ApprovalStateFile,
  requests: CapabilityRequestV1[],
): { state: ApprovalStateFile; consumed: boolean } {
  const repoRoot = requests[0]?.principal.repoRoot
  if (!repoRoot || requests.some((request) => request.principal.repoRoot !== repoRoot)) {
    return { state, consumed: false }
  }
  for (let index = 0; index < state.approvals.length; index += 1) {
    const approval = state.approvals[index]
    if (!approval || approval.repoRoot !== repoRoot) {
      continue
    }
    const consumed = consumeApprovalGrantBundle(approval, requests)
    if (!consumed.consumed) {
      continue
    }
    const approvals = [...state.approvals]
    approvals[index] = consumed.approval
    return { state: { ...state, approvals }, consumed: true }
  }
  return { state, consumed: false }
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
