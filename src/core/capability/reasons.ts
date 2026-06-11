export const FS_SCOPE_REASONS = new Set(['outside_repo_mutation', 'outside_repo_redirect'])

export function shouldSkipBrokerApprovedOnce(brokerActive: boolean, reason: string): boolean {
  return brokerActive && FS_SCOPE_REASONS.has(reason)
}
