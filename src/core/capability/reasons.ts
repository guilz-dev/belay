export const FS_SCOPE_REASONS = new Set(['outside_repo_mutation', 'outside_repo_redirect'])

export const JUDGE_CLOUD_CONSENT_REASON = 'judge_cloud_consent' as const

export const CAPABILITY_APPROVAL_REASONS = new Set<string>([
  ...FS_SCOPE_REASONS,
  JUDGE_CLOUD_CONSENT_REASON,
])

export function shouldSkipBrokerApprovedOnce(brokerActive: boolean, reason: string): boolean {
  return brokerActive && FS_SCOPE_REASONS.has(reason)
}

export function shouldSkipBrokerApprovedRecord(
  brokerActive: boolean,
  approvalReason: string | undefined,
): boolean {
  return brokerActive && approvalReason !== undefined && FS_SCOPE_REASONS.has(approvalReason)
}
