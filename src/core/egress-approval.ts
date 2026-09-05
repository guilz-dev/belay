import { randomUUID } from 'node:crypto'
import { compactApprovals, createApprovalRecord } from './approval.js'
import { issueApprovalToken } from './approval-token.js'
import { mutateApprovalStateWithRetry } from './capability/approval-state-mutation.js'
import type { BelayConfigV3 } from './config.js'
import { configuredControlPlaneDir } from './config.js'
import { addDomainToAllowlist, mutateEgressAllowlist } from './egress/allowlist.js'
import { parseHostFromSummary } from './egress/fingerprint.js'
import type { EgressApprovalScope, EgressPolicyResult } from './egress/types.js'
import { notifyDeny } from './notify.js'
import type { ApprovalRecord, ApprovalStateFile } from './types.js'

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
}): Promise<{ approvalId: string; approval: ApprovalRecord; created: boolean }> {
  const { config, repoRoot, policyResult, store } = params
  const approvalId = `belay_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const candidate = createApprovalRecord({
    kind: 'egress',
    fingerprint: policyResult.fingerprint,
    repoRoot,
    reason: policyResult.reason,
    summary: policyResult.summary,
    approvalTtlMinutes: config.approvalTtlMinutes,
    approvalId,
  })
  const outcome = await mutateApprovalStateWithRetry({
    load: store.loadPending,
    write: store.writePending,
    mutate: (state) => {
      const compacted = compactApprovals(state)
      const existing = compacted.approvals.find(
        (approval) =>
          approval.kind === 'egress' &&
          approval.fingerprint === policyResult.fingerprint &&
          approval.repoRoot === repoRoot,
      )
      if (existing) {
        return {
          state: compacted,
          result: { approvalId: existing.approvalId, approval: existing, created: false },
        }
      }
      compacted.approvals.push(candidate)
      return {
        state: compacted,
        result: { approvalId, approval: candidate, created: true },
      }
    },
  })
  if (!outcome) {
    throw new Error('Failed to persist pending egress approval')
  }
  return outcome
}

export async function consumeApprovedEgress(params: {
  repoRoot: string
  fingerprint: string
  store: EgressApprovalStore
}): Promise<ApprovalRecord | null> {
  return mutateApprovalStateWithRetry<ApprovalRecord | null>({
    load: params.store.loadApproved,
    write: params.store.writeApproved,
    mutate: (state) => {
      const compacted = compactApprovals(state)
      const index = compacted.approvals.findIndex(
        (approval) =>
          approval.kind === 'egress' &&
          approval.fingerprint === params.fingerprint &&
          approval.repoRoot === params.repoRoot,
      )
      if (index === -1) {
        return null
      }
      const [approval] = compacted.approvals.splice(index, 1)
      return { state: compacted, result: approval ?? null }
    },
  })
}

export async function notifyEgressDeny(params: {
  config: BelayConfigV3
  repoRoot: string
  policyResult: EgressPolicyResult
  approval: ApprovalRecord
}): Promise<void> {
  if (!params.config.notifications.webhookUrl && !params.config.notifications.commandHook) {
    return
  }

  if (params.config.approvalSigning.required) {
    try {
      await issueApprovalToken(
        {
          approvalId: params.approval.approvalId,
          fingerprint: params.approval.fingerprint,
          repoRoot: params.approval.repoRoot,
          issuedAt: params.approval.createdAt,
          expiresAt: params.approval.expiresAt,
        },
        configuredControlPlaneDir(params.config),
      )
    } catch {
      // best-effort token pre-issue for local approval UX
    }
  }

  await notifyDeny(params.config.notifications, {
    approvalId: params.approval.approvalId,
    reason: params.policyResult.reason,
    summary: params.policyResult.summary,
    repoRoot: params.repoRoot,
    fingerprint: params.policyResult.fingerprint,
  })
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
  const match = pending.state.approvals.find(
    (approval) => approval.approvalId === params.approvalId,
  )
  const pendingHost = match ? parseHostFromSummary(match.summary) : null

  if (params.scope === 'domain' && match && !pendingHost) {
    return {
      ok: false,
      message: `Cannot add domain to egress allowlist: could not parse host from summary "${match.summary}".`,
    }
  }

  const result = await recordApproval({
    approvalId: params.approvalId,
    config: params.config,
    token: params.token,
    requireSignedToken: params.requireSignedToken ?? false,
    store: params.store,
  })

  const host = result.approval ? parseHostFromSummary(result.approval.summary) : pendingHost
  if (!result.ok || params.scope !== 'domain' || !host) {
    return { ok: result.ok, message: result.message }
  }

  await mutateEgressAllowlist(params.store.allowlistPath, (allowlist) =>
    addDomainToAllowlist(allowlist, {
      host,
      approvedAt: new Date().toISOString(),
      approvalId: params.approvalId,
    }),
  )
  return {
    ok: true,
    message: `${result.message} Domain ${host} added to egress allowlist.`,
  }
}
