import type { ScrubOptions } from '../types.js'

/**
 * The only pre-execution failures that may return to the ordinary one-shot approval path.
 * Every other contained-execution failure is terminal and denies the original host command.
 */
export const CONTAINED_EXECUTION_APPROVAL_FALLBACK_REASONS = [
  'contained_execution_docker_substrate_unavailable',
  'contained_execution_docker_daemon_unavailable',
] as const

export type ContainedExecutionApprovalFallbackReason =
  (typeof CONTAINED_EXECUTION_APPROVAL_FALLBACK_REASONS)[number]

const approvalFallbackReasons: ReadonlySet<string> = new Set(
  CONTAINED_EXECUTION_APPROVAL_FALLBACK_REASONS,
)

export function isContainedExecutionApprovalFallbackReason(
  reason: string,
): reason is ContainedExecutionApprovalFallbackReason {
  return approvalFallbackReasons.has(reason)
}

/** Contained guest output is a security boundary and cannot inherit user-disableable audit flags. */
export const CONTAINED_EXECUTION_OUTPUT_SCRUB_OPTIONS: Readonly<Required<ScrubOptions>> =
  Object.freeze({
    maskApprovalIds: true,
    maskBearerTokens: true,
    maskAuthHeaders: true,
    maskKeyValueSecrets: true,
    maskHighEntropyStrings: true,
  })
