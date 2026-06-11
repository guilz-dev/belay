import { randomUUID } from 'node:crypto'
import { compactApprovals, createApprovalRecord } from './approval.js'
import { issueApprovalToken } from './approval-token.js'
import type { BelayConfigV3 } from './config.js'
import { configuredControlPlaneDir } from './config.js'
import {
  addDomainToAllowlist,
  loadEgressAllowlist,
  saveEgressAllowlist,
} from './egress/allowlist.js'
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
    return { approvalId: existing.approvalId, approval: existing, created: false }
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
  return { approvalId, approval, created: true }
}

const consumeLocks = new Map<string, Promise<void>>()

async function withConsumeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = consumeLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  consumeLocks.set(
    key,
    previous.then(() => gate),
  )
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (consumeLocks.get(key) === gate) {
      consumeLocks.delete(key)
    }
  }
}

export async function consumeApprovedEgress(params: {
  repoRoot: string
  fingerprint: string
  store: EgressApprovalStore
}): Promise<ApprovalRecord | null> {
  const lockKey = `${params.repoRoot}:${params.fingerprint}`
  return withConsumeLock(lockKey, async () => {
    const approved = await params.store.loadApproved()
    approved.state = compactApprovals(approved.state)
    const index = approved.state.approvals.findIndex(
      (approval) =>
        approval.kind === 'egress' &&
        approval.fingerprint === params.fingerprint &&
        approval.repoRoot === params.repoRoot,
    )
    if (index === -1) {
      await params.store.writeApproved(approved.filePath, approved.state)
      return null
    }
    const [approval] = approved.state.approvals.splice(index, 1)
    await params.store.writeApproved(approved.filePath, approved.state)
    return approval
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

  let approvalToken: string | undefined
  if (params.config.approvalSigning.required) {
    try {
      approvalToken = await issueApprovalToken(
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
      approvalToken = undefined
    }
  }

  await notifyDeny(params.config.notifications, {
    approvalId: params.approval.approvalId,
    reason: params.policyResult.reason,
    summary: params.policyResult.summary,
    repoRoot: params.repoRoot,
    fingerprint: params.policyResult.fingerprint,
    approvalToken,
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
  const host = match ? parseHostFromSummary(match.summary) : null

  if (params.scope === 'domain' && match && !host) {
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
