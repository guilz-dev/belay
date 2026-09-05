import type { BelayConfigV4 } from '../config.js'
import type { RecoveryCheckpointState, RecoveryCheckpointSummary } from './types.js'

export function recoveryNotificationConfigured(config: BelayConfigV4): boolean {
  return Boolean(config.notifications.webhookUrl || config.notifications.commandHook)
}

export function recoveryApprovalSetupNotes(): string[] {
  return [
    'Recovery restore flow: run `belay recover apply <checkpoint-id>`, approve with `belay approve <approval-id> --token <signed-token>`, then run the same apply command again.',
    'Recovery restore always requires a signed out-of-band token, even when approvalSigning.required is false for general approvals.',
  ]
}

export function recoveryNotificationSetupWarning(): string {
  return (
    'Recovery checkpoint restore requires a signed out-of-band approval token, but no notification channel is configured. ' +
    'Set notifications.webhookUrl or notifications.commandHook (e.g. via `belay config`) so `belay recover apply` can emit approval-required alerts.'
  )
}

export function formatRecoveryStateDiagnostic(
  state: RecoveryCheckpointState,
  detail?: string,
): string | null {
  switch (state) {
    case 'needs_manual_repair':
      return (
        detail ??
        'Repository files no longer match the recorded before/after snapshots after an interrupted apply or restore. ' +
          'Inspect the working tree manually; automatic restore is blocked until the mismatch is resolved or the checkpoint is removed.'
      )
    case 'conflict':
      return (
        detail ??
        'Current repository files do not match the recorded post-state for this checkpoint. Restore was refused to avoid overwriting newer changes.'
      )
    case 'corrupt':
      return (
        detail ??
        'Checkpoint artifacts failed integrity checks. Do not restore from this checkpoint; inspect or remove the artifact directory manually.'
      )
    default:
      return detail ?? null
  }
}

export function summarizeRecoveryCheckpointDiagnostics(
  checkpoints: RecoveryCheckpointSummary[],
): string[] {
  const advisories: string[] = []
  for (const checkpoint of checkpoints) {
    const diagnostic = formatRecoveryStateDiagnostic(checkpoint.state, checkpoint.stateDetail)
    if (!diagnostic) continue
    advisories.push(`${checkpoint.checkpointId} (${checkpoint.state}): ${diagnostic}`)
  }
  return advisories
}
