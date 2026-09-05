import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { getAdapterLayout } from '../adapters/layouts/index.js'
import { protectedArtifactRoots } from '../adapters/layouts/protected-paths.js'
import { ensureBelayStateDir, loadConfigFile } from '../config-io.js'
import { compactApprovals, createApprovalRecordWithEnvelope } from '../core/approval.js'
import { createGateApprovalStore } from '../core/approval-service.js'
import { issueApprovalToken } from '../core/approval-token.js'
import { appendCliAuditEvent } from '../core/audit-io.js'
import { mutateApprovalStateWithRetry } from '../core/capability/approval-state-mutation.js'
import { boundarySessionStatus } from '../core/capability/boundary-session.js'
import { configuredControlPlaneDir, DEFAULT_RECOVERY_CHECKPOINT } from '../core/config.js'
import { notifyDeny } from '../core/notify.js'
import { canonicalPath } from '../core/path-utils.js'
import {
  listRecoveryCheckpoints,
  RECOVERY_CHECKPOINT_CORRUPT,
  RECOVERY_RESTORE_CONFLICT,
  RECOVERY_RESTORE_REASON,
  recoveryCheckpointStorageBytes,
  recoveryRestoreBinding,
  restoreRecoveryCheckpoint,
  showRecoveryCheckpoint,
} from '../core/recovery/checkpoint.js'
import {
  formatRecoveryStateDiagnostic,
  recoveryNotificationConfigured,
  recoveryNotificationSetupWarning,
  summarizeRecoveryCheckpointDiagnostics,
} from '../core/recovery/operator-guidance.js'
import { probeFileCheckpointBackend } from '../core/transactional/backend-selector.js'
import { fileCheckpointIsolationReason } from '../core/transactional/file-checkpoint-isolation.js'
import { probeFileCloneStrategy } from '../core/transactional/file-clone.js'
import type { ApprovalRecord } from '../core/types.js'

export type RecoveryCheckpointSubcommand = 'status' | 'list' | 'show' | 'apply'

async function appendRecoveryAudit(
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadConfigFile>>,
  event: Record<string, unknown>,
): Promise<boolean> {
  try {
    await appendCliAuditEvent(repoRoot, config, event)
    return true
  } catch {
    return false
  }
}

async function consumeRecoveryApproval(params: {
  repoRoot: string
  config: Awaited<ReturnType<typeof loadConfigFile>>
  fingerprint: string
}): Promise<ApprovalRecord | null> {
  const store = createGateApprovalStore(params.repoRoot, params.config)
  return mutateApprovalStateWithRetry({
    load: store.loadApproved,
    write: store.writeApproved,
    mutate: (state) => {
      const compacted = compactApprovals(state)
      const index = compacted.approvals.findIndex(
        (entry) =>
          entry.kind === 'tool' &&
          entry.reason === RECOVERY_RESTORE_REASON &&
          entry.fingerprint === params.fingerprint &&
          entry.repoRoot === params.repoRoot,
      )
      if (index === -1) return null
      const [approval] = compacted.approvals.splice(index, 1)
      return approval ? { state: compacted, result: approval } : null
    },
  })
}

async function clearRecoveryPending(params: {
  repoRoot: string
  config: Awaited<ReturnType<typeof loadConfigFile>>
  fingerprint: string
}): Promise<void> {
  const store = createGateApprovalStore(params.repoRoot, params.config)
  await mutateApprovalStateWithRetry({
    load: store.loadPending,
    write: store.writePending,
    mutate: (state) => {
      const compacted = compactApprovals(state)
      const remaining = compacted.approvals.filter(
        (entry) =>
          !(
            entry.kind === 'tool' &&
            entry.reason === RECOVERY_RESTORE_REASON &&
            entry.fingerprint === params.fingerprint &&
            entry.repoRoot === params.repoRoot
          ),
      )
      if (remaining.length === compacted.approvals.length) return null
      compacted.approvals = remaining
      return { state: compacted, result: undefined }
    },
  })
}

async function ensureRecoveryPending(params: {
  repoRoot: string
  config: Awaited<ReturnType<typeof loadConfigFile>>
  fingerprint: string
  checkpointId: string
  manifestHash: string
  postStateHash: string
  paths: string[]
}): Promise<ApprovalRecord> {
  const store = createGateApprovalStore(params.repoRoot, params.config)
  const request = createApprovalRecordWithEnvelope({
    kind: 'tool',
    fingerprint: params.fingerprint,
    repoRoot: params.repoRoot,
    reason: RECOVERY_RESTORE_REASON,
    summary: `Restore recovery checkpoint ${params.checkpointId}`,
    approvalTtlMinutes: params.config.approvalTtlMinutes,
    approvalId: `belay_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    approvalInput: {
      input: 'recovery.restore',
      inputKind: 'tool',
      cwd: params.repoRoot,
      toolName: 'recovery.restore',
      payload: {
        checkpointId: params.checkpointId,
        manifestHash: params.manifestHash,
        postStateHash: params.postStateHash,
        paths: params.paths,
      },
    },
  })
  const result = await mutateApprovalStateWithRetry({
    load: store.loadPending,
    write: store.writePending,
    mutate: (state) => {
      const compacted = compactApprovals(state)
      const existing = compacted.approvals.find(
        (entry) =>
          entry.kind === 'tool' &&
          entry.reason === RECOVERY_RESTORE_REASON &&
          entry.fingerprint === params.fingerprint &&
          entry.repoRoot === params.repoRoot,
      )
      if (existing) return { state: compacted, result: existing }
      compacted.approvals.push(request)
      return { state: compacted, result: request }
    },
  })
  if (!result) throw new Error('recovery_approval_state_busy')
  return result
}

export async function recoveryCheckpointCommand(options: {
  targetDir?: string
  subcommand: RecoveryCheckpointSubcommand
  checkpointId?: string
}) {
  const repoRoot = canonicalPath(path.resolve(options.targetDir ?? process.cwd()))
  const config = await loadConfigFile(repoRoot)
  const stateDir = await ensureBelayStateDir(config, repoRoot)
  const checkpointConfig = config.policy.transactional.checkpoint ?? DEFAULT_RECOVERY_CHECKPOINT

  if (options.subcommand === 'status') {
    const checkpoints = await listRecoveryCheckpoints(stateDir, repoRoot)
    const states = Object.fromEntries(
      [...new Set(checkpoints.map((checkpoint) => checkpoint.state))].map((state) => [
        state,
        checkpoints.filter((checkpoint) => checkpoint.state === state).length,
      ]),
    )
    const advisories = summarizeRecoveryCheckpointDiagnostics(checkpoints)
    const backendCounts = Object.fromEntries(
      [...new Set(checkpoints.map((checkpoint) => checkpoint.backend))].map((backend) => [
        backend,
        checkpoints.filter((checkpoint) => checkpoint.backend === backend).length,
      ]),
    )
    const resourceKindCounts = Object.fromEntries(
      [
        ...new Set(checkpoints.map((checkpoint) => checkpoint.resourceKind ?? 'git_repository')),
      ].map((resourceKind) => [
        resourceKind,
        checkpoints.filter(
          (checkpoint) => (checkpoint.resourceKind ?? 'git_repository') === resourceKind,
        ).length,
      ]),
    )
    const checkpointBackends = Object.keys(backendCounts)
    const fileCheckpointConfig = config.policy.transactional.fileCheckpoint
    const configuredBoundary =
      config.capability?.boundaryDriver ??
      (config.sandbox.runtime === 'container' ? 'container' : null)
    let attestation = null
    if (configuredBoundary) {
      try {
        const session = await boundarySessionStatus({ repoRoot, config })
        attestation = session.attestation
      } catch {
        attestation = null
      }
    }
    const copyStrategy = fileCheckpointConfig.enabled ? await probeFileCloneStrategy() : null
    const adapterLayout = getAdapterLayout(config.adapter)
    const backendContext = {
      repoRoot,
      stateDir,
      cwd: repoRoot,
      dirtyIgnoreRoots: protectedArtifactRoots(
        adapterLayout,
        repoRoot,
        config.controlPlane.enabled ? configuredControlPlaneDir(config) : null,
      ),
      fileCheckpoint: fileCheckpointConfig,
      durableCheckpointEnabled: checkpointConfig.enabled,
      boundaryAttestation: attestation,
      boundaryAttestationFresh: false,
      boundaryDriverId: configuredBoundary ?? undefined,
    }
    const isolationAvailable = fileCheckpointIsolationReason(backendContext) === null
    const fileCheckpointProbe = await probeFileCheckpointBackend(backendContext)
    const fileCheckpointAvailable =
      config.policy.transactional.enabled && fileCheckpointProbe.eligible
    const isolation = isolationAvailable ? (attestation?.driver ?? configuredBoundary) : null
    return {
      ok: true,
      subcommand: 'status',
      repoRoot,
      backend:
        checkpointBackends.length === 1
          ? checkpointBackends[0]
          : checkpointBackends.length > 1
            ? 'mixed'
            : 'git_worktree',
      availableBackends: ['git_worktree', 'file_checkpoint'],
      backendCounts,
      resourceKindCounts,
      fileCheckpoint: {
        enabled: fileCheckpointConfig.enabled,
        allowNonGit: fileCheckpointConfig.allowNonGit,
        isolation,
        copyStrategy: copyStrategy ?? undefined,
        probe: fileCheckpointAvailable ? 'available' : 'unavailable',
      },
      enabled: checkpointConfig.enabled,
      checkpointCount: checkpoints.length,
      storageBytes: await recoveryCheckpointStorageBytes(stateDir, repoRoot),
      recoverableCount: checkpoints.filter((checkpoint) => checkpoint.state === 'applied').length,
      needsManualRepairCount: checkpoints.filter(
        (checkpoint) => checkpoint.state === 'needs_manual_repair',
      ).length,
      verifiedReceiptCount: checkpoints.filter((checkpoint) => checkpoint.receiptHash).length,
      states,
      advisories,
      limits: checkpointConfig,
    }
  }

  if (options.subcommand === 'list') {
    return {
      ok: true,
      subcommand: 'list',
      repoRoot,
      checkpoints: await listRecoveryCheckpoints(stateDir, repoRoot),
    }
  }

  if (!options.checkpointId) {
    throw new Error(`recover ${options.subcommand} requires a checkpoint id`)
  }

  if (options.subcommand === 'show') {
    const loaded = await showRecoveryCheckpoint(stateDir, options.checkpointId, repoRoot)
    return {
      ok: true,
      subcommand: 'show',
      manifest: loaded.manifest,
      state: loaded.state,
      manifestHash: loaded.manifestHash,
      receipt: loaded.receipt,
    }
  }

  let binding: Awaited<ReturnType<typeof recoveryRestoreBinding>>
  try {
    binding = await recoveryRestoreBinding(stateDir, options.checkpointId, repoRoot)
  } catch (error) {
    const reason = error instanceof Error ? error.message : RECOVERY_CHECKPOINT_CORRUPT
    await appendRecoveryAudit(repoRoot, config, {
      event:
        reason === RECOVERY_RESTORE_CONFLICT
          ? 'recoveryConflict'
          : reason === RECOVERY_CHECKPOINT_CORRUPT
            ? 'recoveryCorrupt'
            : 'recoveryRejected',
      recoveryCheckpointId: options.checkpointId,
      reason,
    })
    throw error
  }
  const approval = await consumeRecoveryApproval({
    repoRoot,
    config,
    fingerprint: binding.fingerprint,
  })

  if (!approval) {
    const request = await ensureRecoveryPending({
      repoRoot,
      config,
      fingerprint: binding.fingerprint,
      checkpointId: options.checkpointId,
      manifestHash: binding.manifestHash,
      postStateHash: binding.postStateHash,
      paths: binding.paths,
    })
    try {
      const current = await recoveryRestoreBinding(stateDir, options.checkpointId, repoRoot)
      if (current.fingerprint !== binding.fingerprint) {
        throw new Error(RECOVERY_RESTORE_CONFLICT)
      }
    } catch (error) {
      await clearRecoveryPending({ repoRoot, config, fingerprint: binding.fingerprint }).catch(
        () => {},
      )
      throw error
    }
    const notificationConfigured = recoveryNotificationConfigured(config)
    if (notificationConfigured) {
      try {
        await issueApprovalToken(
          {
            approvalId: request.approvalId,
            fingerprint: request.fingerprint,
            repoRoot: request.repoRoot,
            issuedAt: request.createdAt,
            expiresAt: request.expiresAt,
          },
          configuredControlPlaneDir(config),
        )
      } catch {
        // best-effort token pre-issue for local approval UX
      }
      await notifyDeny(config.notifications, {
        approvalId: request.approvalId,
        reason: request.reason,
        summary: request.summary,
        repoRoot: request.repoRoot,
        fingerprint: request.fingerprint,
      })
    }
    const auditRecorded = await appendRecoveryAudit(repoRoot, config, {
      event: 'recoveryApprovalRequested',
      recoveryCheckpointId: options.checkpointId,
      approvalId: request.approvalId,
      manifestHash: binding.manifestHash,
      postStateHash: binding.postStateHash,
      pathCount: binding.paths.length,
    })
    return {
      ok: false,
      subcommand: 'apply',
      verdict: 'deny_pending_approval',
      checkpointId: options.checkpointId,
      approvalId: request.approvalId,
      manifestHash: binding.manifestHash,
      paths: binding.paths,
      auditRecorded,
      message: notificationConfigured
        ? `Signed out-of-band approval required for ${request.approvalId}. Run \`belay approve ${request.approvalId} --token <signed-token>\` with a signed token from your local approval flow, then repeat this command.`
        : `${recoveryNotificationSetupWarning()} Pending approval id: ${request.approvalId}.`,
    }
  }

  try {
    const result = await restoreRecoveryCheckpoint(stateDir, options.checkpointId, repoRoot)
    await clearRecoveryPending({ repoRoot, config, fingerprint: binding.fingerprint }).catch(
      () => {},
    )
    const auditRecorded = await appendRecoveryAudit(repoRoot, config, {
      event: 'recoveryApplied',
      recoveryCheckpointId: options.checkpointId,
      approvalId: approval.approvalId,
      manifestHash: result.manifestHash,
      changeCount: result.changeCount,
    })
    return {
      ok: true,
      subcommand: 'apply',
      verdict: 'restored',
      checkpointId: options.checkpointId,
      ...result,
      auditRecorded,
      message: `Recovery checkpoint ${options.checkpointId} restored.`,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'recovery_restore_failed'
    await appendRecoveryAudit(repoRoot, config, {
      event: reason === RECOVERY_RESTORE_CONFLICT ? 'recoveryConflict' : 'recoveryRejected',
      recoveryCheckpointId: options.checkpointId,
      approvalId: approval.approvalId,
      reason,
    })
    throw error
  }
}

export function formatRecoveryCheckpointResult(result: Record<string, unknown>): string {
  if (result.subcommand === 'status') {
    const fileCheckpoint = result.fileCheckpoint as
      | {
          enabled?: boolean
          allowNonGit?: boolean
          isolation?: string | null
          copyStrategy?: string
          probe?: string
        }
      | undefined
    const backendCounts = result.backendCounts as Record<string, number> | undefined
    const resourceKindCounts = result.resourceKindCounts as Record<string, number> | undefined
    const lines = [
      `belay recover status for ${result.repoRoot}`,
      `Backend: ${result.backend}`,
      `Available backends: ${(result.availableBackends as string[] | undefined)?.join(', ') ?? 'git_worktree, file_checkpoint'}`,
      `Checkpointing: ${result.enabled ? 'enabled' : 'disabled'}`,
      `Checkpoints: ${result.checkpointCount} (${result.recoverableCount} recoverable)`,
      `Needs manual repair: ${result.needsManualRepairCount ?? 0}`,
      `Verified receipts: ${result.verifiedReceiptCount}`,
      `Storage: ${result.storageBytes} bytes`,
      `States: ${JSON.stringify(result.states)}`,
    ]
    if (backendCounts && Object.keys(backendCounts).length > 0) {
      lines.push(`Backend counts: ${JSON.stringify(backendCounts)}`)
    }
    if (resourceKindCounts && Object.keys(resourceKindCounts).length > 0) {
      lines.push(`Resource kind counts: ${JSON.stringify(resourceKindCounts)}`)
    }
    if (fileCheckpoint) {
      lines.push(
        `File checkpoint: enabled=${fileCheckpoint.enabled ? 'yes' : 'no'}, allowNonGit=${fileCheckpoint.allowNonGit ? 'yes' : 'no'}, probe=${fileCheckpoint.probe ?? 'unknown'}, isolation=${fileCheckpoint.isolation ?? 'none'}${fileCheckpoint.copyStrategy ? `, copyStrategy=${fileCheckpoint.copyStrategy}` : ''}`,
      )
    }
    const advisories = result.advisories as string[] | undefined
    if (advisories && advisories.length > 0) {
      lines.push('', 'Advisories:')
      for (const advisory of advisories) {
        lines.push(`- ${advisory}`)
      }
    }
    lines.push('')
    return `${lines.join('\n')}\n`
  }
  if (result.subcommand === 'list') {
    const checkpoints = result.checkpoints as Array<{
      checkpointId: string
      state: string
      stateDetail?: string
      backend: string
      resourceKind: string
      createdAt: string
      changeCount: number
      receiptHash?: string
    }>
    if (checkpoints.length === 0) return 'No recovery checkpoints found.\n'
    const lines = checkpoints.map((item) => {
      const diagnostic = formatRecoveryStateDiagnostic(
        item.state as Parameters<typeof formatRecoveryStateDiagnostic>[0],
        item.stateDetail,
      )
      const base = `${item.checkpointId}\t${item.state}\t${item.backend}\t${item.resourceKind}\t${item.changeCount} changes\treceipt:${item.receiptHash?.slice(0, 12) ?? '-'}\t${item.createdAt}`
      return diagnostic ? `${base}\n  ${diagnostic}` : base
    })
    return `${lines.join('\n')}\n`
  }
  if (result.subcommand === 'show') {
    const state = result.state as { state?: string; detail?: string } | undefined
    const diagnostic =
      state?.state !== undefined
        ? formatRecoveryStateDiagnostic(
            state.state as Parameters<typeof formatRecoveryStateDiagnostic>[0],
            state.detail,
          )
        : null
    const payload = diagnostic ? { ...result, diagnostic } : result
    return `${JSON.stringify(payload, null, 2)}\n`
  }
  return `${String(result.message ?? 'Recovery command completed.')}\n`
}
