import { recordApproval } from './approval-service.js'
import {
  addPathToAllowlist,
  loadFsScopeAllowlist,
  normalizeAllowlistPath,
  saveFsScopeAllowlist,
} from './capability/allowlist.js'
import { FS_SCOPE_REASONS } from './capability/reasons.js'
import {
  addTrustedWorkspaceRoot,
  loadTrustedWorkspaceRoots,
  normalizeTrustedWorkspaceRootPath,
  saveTrustedWorkspaceRoots,
  validateTrustedWorkspaceRootCandidate,
} from './capability/trusted-workspace-roots.js'
import type { CapabilityApprovalScope } from './capability/types.js'
import { type BelayConfigV3, resolveControlPlaneDir } from './config.js'
import type { ApprovalStateFile } from './types.js'

export interface CapabilityApprovalStore {
  loadPending: () => Promise<{ filePath: string; state: ApprovalStateFile }>
  loadApproved: () => Promise<{ filePath: string; state: ApprovalStateFile }>
  writePending: (filePath: string, state: ApprovalStateFile) => Promise<void>
  writeApproved: (filePath: string, state: ApprovalStateFile) => Promise<void>
  allowlistPath: string
  trustedRootsPath: string
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
    if (!match || match.kind !== 'shell' || !FS_SCOPE_REASONS.has(match.reason)) {
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

  if (params.scope === 'workspace-root') {
    if (!match || !FS_SCOPE_REASONS.has(match.reason)) {
      return {
        ok: false,
        message:
          'workspace-root scope approvals apply only to pending outside-repo actions (outside_repo_mutation / outside_repo_redirect).',
      }
    }
    if (!params.scopePath?.trim()) {
      return {
        ok: false,
        message: 'approve --scope workspace-root requires --path <absolute-directory-path>.',
      }
    }
    if (!match.scopeHint || match.scopeHint.scope !== 'workspace-root') {
      return {
        ok: false,
        message:
          'workspace-root approval requires a pending scope hint. Re-run the original blocked action to mint a scoped approval.',
      }
    }

    const normalizedPath = normalizeTrustedWorkspaceRootPath(params.scopePath.trim())
    const normalizedHint = normalizeTrustedWorkspaceRootPath(match.scopeHint.path)
    if (normalizedPath !== normalizedHint) {
      return {
        ok: false,
        message: `workspace-root approval path must exactly match the suggested path: ${normalizedHint}`,
      }
    }
    const validation = validateTrustedWorkspaceRootCandidate({
      candidatePath: normalizedPath,
      repoRoot: match.repoRoot,
      controlPlaneDir: params.config.controlPlane.enabled
        ? resolveControlPlaneDir(params.config)
        : undefined,
      requireExistingDirectory: true,
      requireNonGit: true,
    })
    if (!validation.ok) {
      if (validation.reason === 'not_directory') {
        return {
          ok: false,
          message: 'workspace-root approval requires an existing directory path.',
        }
      }
      if (validation.reason === 'broad_root') {
        return {
          ok: false,
          message:
            'workspace-root approval rejected: broad roots (/, drive root, HOME) are not allowed.',
        }
      }
      if (validation.reason === 'high_stakes') {
        return {
          ok: false,
          message:
            'workspace-root approval rejected: high-stakes directories cannot be trusted roots.',
        }
      }
      if (validation.reason === 'inside_repo') {
        return {
          ok: false,
          message:
            'workspace-root approval rejected: the path is already inside the repository root.',
        }
      }
      if (validation.reason === 'inside_git_repo') {
        return {
          ok: false,
          message: `workspace-root approval rejected: ${normalizedPath} is under a git repository.`,
        }
      }
      if (validation.reason === 'control_plane_overlap') {
        return {
          ok: false,
          message: 'workspace-root approval rejected: control plane paths cannot be trusted roots.',
        }
      }
      return {
        ok: false,
        message: 'workspace-root approval rejected by trusted-root policy.',
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

  if (
    !result.ok ||
    (params.scope !== 'path' && params.scope !== 'workspace-root') ||
    !params.scopePath?.trim()
  ) {
    return { ok: result.ok, message: result.message }
  }

  if (params.scope === 'workspace-root') {
    const trustedRoots = await loadTrustedWorkspaceRoots(params.store.trustedRootsPath)
    const normalizedPath = normalizeTrustedWorkspaceRootPath(params.scopePath.trim())
    const updated = addTrustedWorkspaceRoot(trustedRoots, {
      path: normalizedPath,
      approvedAt: new Date().toISOString(),
      approvalId: params.approvalId,
      source: 'approval',
    })
    await saveTrustedWorkspaceRoots(params.store.trustedRootsPath, updated)
    return {
      ok: true,
      message: `${result.message} Trusted workspace root ${normalizedPath} added.`,
    }
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
