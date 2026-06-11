import type { ApprovalStateFile } from '../types.js'
import { egressFingerprint, egressSummary } from './fingerprint.js'
import { isHostAllowlisted } from './allowlist.js'
import type { EgressAllowlistFile, EgressConnectRequest, EgressPolicyResult } from './types.js'

export function evaluateEgressConnect(params: {
  request: EgressConnectRequest
  allowlist: EgressAllowlistFile
  approved: ApprovalStateFile
  pendingApprovalId?: string
}): EgressPolicyResult {
  const { request, allowlist, approved } = params
  const host = request.host.toLowerCase()
  const fingerprint = egressFingerprint(request.repoRoot, host, request.port)
  const summary = egressSummary(host, request.port, request.method)

  if (isHostAllowlisted(host, allowlist)) {
    return {
      decision: 'allow',
      fingerprint,
      summary,
      reason: 'egress_allowlist',
    }
  }

  const approvedMatch = approved.approvals.find(
    (approval) =>
      approval.kind === 'egress' &&
      approval.fingerprint === fingerprint &&
      approval.repoRoot === request.repoRoot,
  )
  if (approvedMatch) {
    return {
      decision: 'allow',
      fingerprint,
      summary,
      reason: 'approved_once',
    }
  }

  return {
    decision: 'deny_pending',
    fingerprint,
    summary,
    reason: 'egress_blocked',
    approvalId: params.pendingApprovalId,
  }
}
