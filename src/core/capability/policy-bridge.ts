import type { PolicyDecision } from './policy-types.js'
import type { CapabilityRequestV1 } from './request.js'

export interface CapabilityAuthorizationMetadata {
  capabilityRequests: CapabilityRequestV1[]
  authorizationDecision: PolicyDecision
}

export interface PolicyLegacyReasonHints {
  outsideMutation?: boolean
  effect?: 'read_only' | 'local_mutation' | 'remote_mutation' | 'unknown'
}

export function singleCapabilityMetadata(
  request: CapabilityRequestV1,
  decision: PolicyDecision,
): CapabilityAuthorizationMetadata {
  return {
    capabilityRequests: [request],
    authorizationDecision: decision,
  }
}

/**
 * Maps a PolicyDecision to hook-facing legacy reason strings.
 * Pass hints when the shell segment context is known (outside-repo mutation, etc.).
 */
export function policyDecisionToLegacyReason(
  decision: PolicyDecision,
  hints: PolicyLegacyReasonHints = {},
): string {
  if (decision.reason === 'outside_repo_mutation') {
    return 'outside_repo_mutation'
  }
  if (decision.reason === 'external_effect' || decision.reason === 'network_connect') {
    return 'external_effect'
  }
  if (decision.reason === 'high_stakes_path' || decision.reason === 'secret_path') {
    return 'tier1_catastrophic'
  }
  if (decision.reason === 'indeterminate_effect') {
    return 'unknown_local_effect'
  }
  if (decision.reason === 'opaque_execution') {
    return 'opaque_execution'
  }
  if (decision.reason === 'control_plane_mutation') {
    return 'control_plane_mutation'
  }
  if (decision.reason === 'policy_default') {
    if (
      decision.signals.includes('outside_repo_path') ||
      decision.signals.includes('outside_repo_mutation')
    ) {
      return 'outside_repo_mutation'
    }
    if (hints.outsideMutation && hints.effect !== 'read_only') {
      return 'outside_repo_mutation'
    }
    return 'unknown_local_effect'
  }
  if (decision.reason === 'subagent_review') {
    return 'subagent_review'
  }
  if (decision.outcome === 'deny') {
    return decision.reason
  }
  return decision.reason
}

/** @deprecated Use policyDecisionToLegacyReason for shell segments that need outside-repo hints. */
export function policyReasonToLegacyReason(decision: PolicyDecision): string {
  return policyDecisionToLegacyReason(decision)
}
