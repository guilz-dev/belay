import type { ClassifyResult } from '../types.js'

export function capabilityGrantLeaseRequired(
  result: Pick<ClassifyResult, 'reason' | 'authorizationDecision'>,
): boolean {
  return (
    result.reason === 'capability_grant' ||
    result.authorizationDecision?.matchedRule === 'grant.exact'
  )
}

/** Fail closed when a grant lease is required but capability requests are missing. */
export function canConsumeCapabilityGrantLease(result: ClassifyResult): boolean {
  if (!capabilityGrantLeaseRequired(result)) {
    return true
  }
  return (result.capabilityRequests?.length ?? 0) > 0
}
