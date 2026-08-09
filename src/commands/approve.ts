import path from 'node:path'

import { loadApprovalState, loadConfigFile } from '../config-io.js'
import { canAutoReplay, getExecutionLeaseMs } from '../core/approval-replay.js'
import {
  claimApprovedForReplay,
  createGateApprovalStore,
  recordApproval,
} from '../core/approval-service.js'
import { runBoundaryAgentCommand } from '../core/capability/boundary-session.js'
import { JUDGE_CLOUD_CONSENT_REASON } from '../core/capability/reasons.js'
import type { CapabilityApprovalScope } from '../core/capability/types.js'
import { recordCapabilityApproval } from '../core/capability-approval.js'
import type { EgressApprovalScope } from '../core/egress/types.js'
import { recordEgressApproval } from '../core/egress-approval.js'
import { RECOVERY_RESTORE_REASON } from '../core/recovery/checkpoint.js'
import { createEgressApprovalStore } from '../services/egress-service.js'
import { createCapabilityApprovalStore } from '../services/sandbox-service.js'

export type ApproveScope = EgressApprovalScope | CapabilityApprovalScope

export interface ApproveOptions {
  targetDir?: string
  approvalId: string
  token?: string
  scope?: ApproveScope
  scopePath?: string
  replay?: boolean
}

export async function approvePending(
  options: ApproveOptions,
): Promise<{ ok: boolean; message: string }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const config = await loadConfigFile(repoRoot)
  const pending = await loadApprovalState(repoRoot, 'pending-approvals.json', config)
  const match = pending.approvals.find((approval) => approval.approvalId === options.approvalId)

  if (match?.reason === RECOVERY_RESTORE_REASON) {
    if (options.scope && options.scope !== 'once') {
      return { ok: false, message: 'Recovery restore approvals support one-shot scope only.' }
    }
    const result = await recordApproval({
      approvalId: options.approvalId,
      config,
      token: options.token,
      requireSignedToken: true,
      store: createGateApprovalStore(repoRoot, config),
    })
    return { ok: result.ok, message: result.message }
  }

  if (match?.reason === JUDGE_CLOUD_CONSENT_REASON) {
    const result = await recordCapabilityApproval({
      approvalId: options.approvalId,
      config,
      token: options.token,
      requireSignedToken: config.approvalSigning.required,
      store: createCapabilityApprovalStore(repoRoot, config),
    })
    return { ok: result.ok, message: result.message }
  }

  if (match?.kind === 'egress') {
    const result = await recordEgressApproval({
      approvalId: options.approvalId,
      config,
      scope: (options.scope === 'domain' ? 'domain' : 'once') as EgressApprovalScope,
      token: options.token,
      requireSignedToken: config.approvalSigning.required,
      store: createEgressApprovalStore(repoRoot, config),
    })
    return { ok: result.ok, message: result.message }
  }

  if (options.scope === 'path' || options.scope === 'workspace-root') {
    const result = await recordCapabilityApproval({
      approvalId: options.approvalId,
      config,
      scope: options.scope,
      scopePath: options.scopePath,
      token: options.token,
      requireSignedToken: config.approvalSigning.required,
      store: createCapabilityApprovalStore(repoRoot, config),
    })
    return { ok: result.ok, message: result.message }
  }

  const approvalStore = createGateApprovalStore(repoRoot, config)

  const result = await recordApproval({
    approvalId: options.approvalId,
    config,
    token: options.token,
    requireSignedToken: config.approvalSigning.required,
    store: approvalStore,
  })

  if (!result.ok) {
    return { ok: result.ok, message: result.message }
  }

  if (options.replay) {
    const approval = result.approval
    if (!approval) {
      return { ok: false, message: 'Approval recorded but replay envelope is missing.' }
    }
    if (!canAutoReplay(config, approval.kind)) {
      return {
        ok: false,
        message:
          'Replay is not enabled for this approval kind. Retry the original action manually or enable approval.autoReplayScopes.',
      }
    }
    if (approval.kind !== 'shell' || !approval.input) {
      return {
        ok: false,
        message:
          'CLI replay is only supported for shell approvals. Retry the original tool or subagent action manually.',
      }
    }
    const claimed = await claimApprovedForReplay({
      approvalId: options.approvalId,
      store: approvalStore,
    })
    if (!claimed) {
      return { ok: false, message: 'Approval could not be claimed for replay.' }
    }
    const replayResult = await runBoundaryAgentCommand({
      repoRoot,
      config,
      command: claimed.input ?? approval.input,
      cwd: claimed.cwd ?? repoRoot,
      timeoutMs: getExecutionLeaseMs(config),
      runOptions: { mountReadOnly: false },
    })
    if (replayResult.exitCode === 0) {
      return {
        ok: true,
        message: `Belay replay succeeded for ${options.approvalId}. Do not retry via hooks; the one-shot grant was consumed.`,
      }
    }
    const timeoutNote = replayResult.timedOut ? ' Replay timed out.' : ''
    return {
      ok: false,
      message: `Belay replay failed for ${options.approvalId} (exit ${replayResult.exitCode}).${timeoutNote} The one-shot approval was consumed before replay and was not re-armed.`,
    }
  }

  return { ok: result.ok, message: result.message }
}
