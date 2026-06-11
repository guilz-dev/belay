import { recordApproval } from './approval-service.js'
import {
  addPathToAllowlist,
  loadFsScopeAllowlist,
  normalizeAllowlistPath,
  saveFsScopeAllowlist,
} from './capability/allowlist.js'
import { FS_SCOPE_REASONS } from './capability/reasons.js'
import type { CapabilityApprovalScope } from './capability/types.js'
import type { BelayConfigV3 } from './config.js'
import type { ApprovalStateFile } from './types.js'

export interface CapabilityApprovalStore {
  loadPending: () => Promise<{ filePath: string; state: ApprovalStateFile }>
  loadApproved: () => Promise<{ filePath: string; state: ApprovalStateFile }>
  writePending: (filePath: string, state: ApprovalStateFile) => Promise<void>
  writeApproved: (filePath: string, state: ApprovalStateFile) => Promise<void>
  allowlistPath: string
}

export async function recordCapabilityApproval(params: {
  approvalId: string
  config: BelayConfigV3
  store: CapabilityApprovalStore
  scope?: CapabilityApprovalScope
  scopePath?: string
  token?: string
  requireSignedToken?: boolean
}): Promise<{ ok: boolean; message: string }> {
  const pending = await params.store.loadPending()
  const match = pending.state.approvals.find(
    (approval) => approval.approvalId === params.approvalId,
  )

  if (params.scope === 'path') {
    if (!match || !FS_SCOPE_REASONS.has(match.reason)) {
      return {
        ok: false,
        message:
          'Path scope approvals apply only to pending outside-repo shell actions (outside_repo_mutation / outside_repo_redirect).',
      }
    }
    if (!params.scopePath?.trim()) {
      return {
        ok: false,
        message: 'approve --scope path requires --path <absolute-or-relative-path>.',
      }
    }
  }

  const result = await recordApproval({
    approvalId: params.approvalId,
    config: params.config,
    token: params.token,
    requireSignedToken: params.requireSignedToken ?? false,
    store: params.store,
  })

  if (!result.ok || params.scope !== 'path' || !params.scopePath?.trim()) {
    return { ok: result.ok, message: result.message }
  }

  const allowlist = await loadFsScopeAllowlist(params.store.allowlistPath)
  const normalizedPath = normalizeAllowlistPath(params.scopePath.trim())
  const updated = addPathToAllowlist(allowlist, {
    path: normalizedPath,
    approvedAt: new Date().toISOString(),
    approvalId: params.approvalId,
  })
  await saveFsScopeAllowlist(params.store.allowlistPath, updated)
  return {
    ok: true,
    message: `${result.message} Path ${normalizedPath} added to fs-scope allowlist.`,
  }
}
