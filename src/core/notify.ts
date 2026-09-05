import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { canonicalPath, pathWithinRoot } from './path-utils.js'

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
}

export interface NotifyDependencies {
  fetch: typeof globalThis.fetch
  execFile: (
    file: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
  ) => Promise<unknown>
}

const LOOPBACK_WEBHOOK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function webhookConfigIssue(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `notifications.webhookUrl is invalid: ${url}`
  }
  if (parsed.protocol === 'https:') {
    return null
  }
  const normalizedHostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (parsed.protocol === 'http:' && LOOPBACK_WEBHOOK_HOSTS.has(normalizedHostname)) {
    return null
  }
  return `notifications.webhookUrl must use https (http is allowed only for localhost, 127.0.0.1, or ::1): ${url}`
}

function commandHookConfigIssue(commandHook: string, repoRoot: string): string | null {
  if (!path.isAbsolute(commandHook)) {
    return `notifications.commandHook must be an absolute path: ${commandHook}`
  }
  if (pathWithinRoot(canonicalPath(repoRoot), canonicalPath(commandHook))) {
    return `notifications.commandHook must not be inside the repository: ${commandHook}`
  }
  return null
}

export function notificationConfigIssues(
  config: DenyNotificationConfig,
  repoRoot: string,
): string[] {
  const issues: string[] = []
  if (config.webhookUrl) {
    const issue = webhookConfigIssue(config.webhookUrl)
    if (issue) {
      issues.push(issue)
    }
  }
  if (config.commandHook) {
    const issue = commandHookConfigIssue(config.commandHook, repoRoot)
    if (issue) {
      issues.push(issue)
    }
  }
  return issues
}

export async function notifyDeny(
  config: DenyNotificationConfig,
  event: DenyNotificationEvent,
  deps: NotifyDependencies = {
    fetch: globalThis.fetch.bind(globalThis),
    execFile: (file, args, options) => execFileAsync(file, [...args], options),
  },
): Promise<void> {
  const payload = JSON.stringify({
    approvalId: event.approvalId,
    reason: event.reason,
    summary: event.summary,
    repoRoot: event.repoRoot,
    fingerprint: event.fingerprint,
  })

  const webhookIssue = config.webhookUrl ? webhookConfigIssue(config.webhookUrl) : null
  if (config.webhookUrl && !webhookIssue) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      try {
        await deps.fetch(config.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }
    } catch {
      // best-effort notification
    }
  }

  const commandHookIssue = config.commandHook
    ? commandHookConfigIssue(config.commandHook, event.repoRoot)
    : null
  if (config.commandHook && !commandHookIssue) {
    try {
      await deps.execFile(config.commandHook, [], {
        env: {
          BELAY_APPROVAL_ID: event.approvalId,
          BELAY_REASON: event.reason,
          BELAY_SUMMARY: event.summary,
          BELAY_REPO_ROOT: event.repoRoot,
          BELAY_FINGERPRINT: event.fingerprint,
        },
      })
    } catch {
      // best-effort notification
    }
  }
}
