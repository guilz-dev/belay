import { randomUUID } from 'node:crypto'

import { compactApprovals, createApprovalRecord } from './approval.js'
import type { BelayConfigV3 } from './config.js'
import {
  addDomainToAllowlist,
  loadEgressAllowlist,
  saveEgressAllowlist,
} from './egress/allowlist.js'
import { parseHostFromSummary } from './egress/fingerprint.js'
import type { EgressApprovalScope, EgressPolicyResult } from './egress/types.js'
import type { ApprovalStateFile } from './types.js'

export interface EgressApprovalStore {
  loadPending: () => Promise<{ filePath: string; state: ApprovalStateFile }>
  loadApproved: () => Promise<{ filePath: string; state: ApprovalStateFile }>
  writePending: (filePath: string, state: ApprovalStateFile) => Promise<void>
  writeApproved: (filePath: string, state: ApprovalStateFile) => Promise<void>
  allowlistPath: string
}

export async function ensurePendingEgressApproval(params: {
  config: BelayConfigV3
  repoRoot: string
  policyResult: EgressPolicyResult
  store: EgressApprovalStore
}): Promise<{ approvalId: string }> {
  const { config, repoRoot, policyResult, store } = params
  const pending = await store.loadPending()
  pending.state = compactApprovals(pending.state)

  const existing = pending.state.approvals.find(
    (approval) =>
      approval.kind === 'egress' &&
      approval.fingerprint === policyResult.fingerprint &&
      approval.repoRoot === repoRoot,
  )
  if (existing) {
    await store.writePending(pending.filePath, pending.state)
    return { approvalId: existing.approvalId }
  }

  const approvalId = `belay_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const approval = createApprovalRecord({
    kind: 'egress',
    fingerprint: policyResult.fingerprint,
    repoRoot,
    reason: policyResult.reason,
    summary: policyResult.summary,
    approvalTtlMinutes: config.approvalTtlMinutes,
    approvalId,
  })
  pending.state.approvals.push(approval)
  await store.writePending(pending.filePath, pending.state)
  return { approvalId }
}

export async function recordEgressApproval(params: {
  approvalId: string
  config: BelayConfigV3
  store: EgressApprovalStore
  scope?: EgressApprovalScope
  token?: string
  requireSignedToken?: boolean
}): Promise<{ ok: boolean; message: string }> {
  const { recordApproval } = await import('./approval-service.js')
  const pending = await params.store.loadPending()
  const match = pending.state.approvals.find((approval) => approval.approvalId === params.approvalId)
  const host = match ? parseHostFromSummary(match.summary) : null

  const result = await recordApproval({
    approvalId: params.approvalId,
    config: params.config,
    token: params.token,
    requireSignedToken: params.requireSignedToken ?? false,
    store: params.store,
  })

  if (!result.ok || params.scope !== 'domain' || !host) {
    return { ok: result.ok, message: result.message }
  }

  const allowlist = await loadEgressAllowlist(params.store.allowlistPath)
  const updated = addDomainToAllowlist(allowlist, {
    host,
    approvedAt: new Date().toISOString(),
    approvalId: params.approvalId,
  })
  await saveEgressAllowlist(params.store.allowlistPath, updated)
  return {
    ok: true,
    message: `${result.message} Domain ${host} added to egress allowlist.`,
  }
}
