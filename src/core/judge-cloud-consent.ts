import { randomUUID } from 'node:crypto'
import { loadApprovalState, pendingApprovalsPath, saveApprovalState } from '../config-io.js'
import { compactApprovals, createApprovalRecord } from './approval.js'
import { mutateApprovalStateWithRetry } from './capability/approval-state-mutation.js'
import { JUDGE_CLOUD_CONSENT_REASON } from './capability/reasons.js'
import type { BelayConfigV4, JudgeProviderId } from './config.js'

export { JUDGE_CLOUD_CONSENT_REASON }

export function judgeCloudConsentFingerprint(
  providerId: JudgeProviderId,
  endpoint: string,
): string {
  return `judge_cloud_consent:${providerId}:${endpoint.trim()}`
}

export async function ensurePendingJudgeCloudConsentApproval(params: {
  repoRoot: string
  config: BelayConfigV4
  providerId: JudgeProviderId
  endpoint: string
}): Promise<{ approvalId: string; created: boolean }> {
  const { repoRoot, config, providerId, endpoint } = params
  const normalizedEndpoint = endpoint.trim()
  const fingerprint = judgeCloudConsentFingerprint(providerId, normalizedEndpoint)
  const approvalId = `belay_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const candidate = createApprovalRecord({
    kind: 'capability',
    fingerprint,
    repoRoot,
    reason: JUDGE_CLOUD_CONSENT_REASON,
    summary: `Cloud judge egress to ${providerId} (${normalizedEndpoint})`,
    approvalTtlMinutes: config.approvalTtlMinutes,
    approvalId,
    input: `belay judge use ${providerId} --endpoint ${normalizedEndpoint}`,
    inputKind: 'shell',
  })
  const outcome = await mutateApprovalStateWithRetry({
    load: async () => ({
      filePath: pendingApprovalsPath(repoRoot, config),
      state: await loadApprovalState(repoRoot, 'pending-approvals.json', config),
    }),
    write: async (_filePath, state) =>
      saveApprovalState(repoRoot, 'pending-approvals.json', state, config),
    mutate: (state) => {
      const compacted = compactApprovals(state)
      const existing = compacted.approvals.find(
        (approval) =>
          approval.kind === 'capability' &&
          approval.reason === JUDGE_CLOUD_CONSENT_REASON &&
          approval.fingerprint === fingerprint &&
          approval.repoRoot === repoRoot,
      )
      if (existing) {
        return {
          state: compacted,
          result: { approvalId: existing.approvalId, created: false },
        }
      }
      compacted.approvals.push(candidate)
      return { state: compacted, result: { approvalId, created: true } }
    },
  })
  if (!outcome) {
    throw new Error('Failed to persist cloud judge consent approval')
  }
  return outcome
}
