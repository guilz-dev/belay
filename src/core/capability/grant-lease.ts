import { canonicalStringify } from '../fingerprint.js'
import type { ApprovalRecord, ApprovalStateFile } from '../types.js'
import type { CapabilityGrantV1 } from './grant.js'
import { isGrantScopeTooBroad } from './grant.js'
import { grantMatchesRequest } from './grant-match.js'
import type { CapabilityRequestV1 } from './request.js'

export type GrantBundleValidationFailureReason =
  | 'legacy_record'
  | 'empty_requests'
  | 'cardinality_mismatch'
  | 'grant_scope_too_broad'
  | 'grant_inactive'
  | 'grant_mismatch'

export type GrantBundleValidationResult =
  | { ok: true; approval: ApprovalRecord }
  | { ok: false; reason: GrantBundleValidationFailureReason }

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

function exactGrantMatchesRequest(grant: CapabilityGrantV1, request: CapabilityRequestV1): boolean {
  return (
    persistedCanonicalStringify(grant.principal) ===
      persistedCanonicalStringify(request.principal) &&
    grant.action === request.action &&
    persistedCanonicalStringify(grant.resource) === persistedCanonicalStringify(request.resource) &&
    grant.inputFingerprint === request.context.inputFingerprint
  )
}

type GrantUsageExpectation = 'available' | 'previously_consumed'

function validateExactGrantBundle(
  approval: ApprovalRecord,
  requests: readonly CapabilityRequestV1[],
  now: number,
  usage: GrantUsageExpectation,
): GrantBundleValidationResult {
  if (approval.grantBundleVersion !== 1) {
    return { ok: false, reason: 'legacy_record' }
  }
  if (!requests.length) {
    return { ok: false, reason: 'empty_requests' }
  }
  const bundle = grantsFromApproval(approval)
  if (bundle.length !== requests.length) {
    return { ok: false, reason: 'cardinality_mismatch' }
  }
  if (bundle.some((grant) => isGrantScopeTooBroad(grant))) {
    return { ok: false, reason: 'grant_scope_too_broad' }
  }
  const usageIsValid = bundle.every((grant) => {
    const expires = Date.parse(grant.expiresAt)
    if (!Number.isFinite(expires) || expires <= now) {
      return false
    }
    return usage === 'available'
      ? grant.usesRemaining > 0
      : grant.usesRemaining >= 0 && grant.usesRemaining < grant.maxUses
  })
  if (!usageIsValid) {
    return { ok: false, reason: 'grant_inactive' }
  }

  const unmatched = [...bundle]
  for (const request of requests) {
    const index = unmatched.findIndex((grant) => exactGrantMatchesRequest(grant, request))
    if (index === -1) {
      return { ok: false, reason: 'grant_mismatch' }
    }
    unmatched.splice(index, 1)
  }
  if (unmatched.length > 0) {
    return { ok: false, reason: 'grant_mismatch' }
  }
  return { ok: true, approval }
}

function persistedCanonicalStringify(value: unknown): string {
  return canonicalStringify(omitUndefined(value))
}

function omitUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => omitUndefined(entry))
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, omitUndefined(entry)]),
  )
}

/** Validate and consume a marked exact bundle without mutating on any failure. */
export function validateAndConsumeGrantBundle(
  approval: ApprovalRecord,
  requests: readonly CapabilityRequestV1[],
  now = Date.now(),
): GrantBundleValidationResult {
  const validated = validateExactGrantBundle(approval, requests, now, 'available')
  if (!validated.ok) {
    return validated
  }

  const grants = grantsFromApproval(approval).map((grant) => decrementGrant(grant))
  return {
    ok: true,
    approval: {
      ...approval,
      grants,
      grant: grants[0],
    },
  }
}

/** Revalidate a marked bundle during an active replay lease without consuming it twice. */
export function validateGrantBundleForLeaseReuse(
  approval: ApprovalRecord,
  requests: readonly CapabilityRequestV1[],
  now = Date.now(),
): GrantBundleValidationResult {
  return validateExactGrantBundle(approval, requests, now, 'previously_consumed')
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
