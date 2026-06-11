import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DenyNotificationConfig {
  webhookUrl?: string
  commandHook?: string
}

export interface DenyNotificationEvent {
  approvalId: string
  reason: string
  summary: string
  repoRoot: string
  fingerprint: string
  approvalToken?: string
}

export async function notifyDeny(
  config: DenyNotificationConfig,
  event: DenyNotificationEvent,
): Promise<void> {
  const payload = JSON.stringify(event)

  if (config.webhookUrl) {
    try {
      await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      })
    } catch {
      // best-effort notification
    }
  }

  if (config.commandHook) {
    try {
      await execFileAsync(config.commandHook, [], {
        env: {
          ...process.env,
          BELAY_APPROVAL_ID: event.approvalId,
          BELAY_REASON: event.reason,
          BELAY_SUMMARY: event.summary,
          BELAY_REPO_ROOT: event.repoRoot,
          BELAY_FINGERPRINT: event.fingerprint,
          BELAY_APPROVAL_TOKEN: event.approvalToken ?? '',
        },
      })
    } catch {
      // best-effort notification
    }
  }
}
