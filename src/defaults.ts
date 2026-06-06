import type { BelayConfig } from './types.js'

export const PACKAGE_NAME = 'agent-belay'

export type ManagedHookDefinition = {
  command: string
  placement: 'prepend' | 'append'
  matcher?: string
}

function runnerCommand(platform: NodeJS.Platform, hookName: string, ...args: string[]): string {
  const base =
    platform === 'win32' ? '.\\.cursor\\hooks\\belay-runner.cmd' : './.cursor/hooks/belay-runner'
  return [base, hookName, ...args].join(' ')
}

export function getManagedHookEvents(
  platform: NodeJS.Platform = process.platform,
): Record<string, ManagedHookDefinition> {
  return {
    beforeSubmitPrompt: {
      command: runnerCommand(platform, 'belay-before-submit'),
      placement: 'prepend',
    },
    beforeShellExecution: {
      command: runnerCommand(platform, 'belay-shell-gate'),
      placement: 'prepend',
    },
    preToolUse: {
      command: runnerCommand(platform, 'belay-tool-gate', 'preToolUse'),
      placement: 'prepend',
      matcher: 'Task',
    },
    subagentStart: {
      command: runnerCommand(platform, 'belay-tool-gate', 'subagentStart'),
      placement: 'prepend',
      matcher: 'generalPurpose',
    },
    postToolUse: {
      command: runnerCommand(platform, 'belay-audit', 'postToolUse'),
      placement: 'append',
    },
    stop: {
      command: runnerCommand(platform, 'belay-audit', 'stop'),
      placement: 'append',
    },
    sessionEnd: {
      command: runnerCommand(platform, 'belay-audit', 'sessionEnd'),
      placement: 'append',
    },
  }
}

export const DEFAULT_CONFIG: BelayConfig = {
  version: 1,
  mode: 'enforce',
  approvalTtlMinutes: 15,
  tokenPrefix: '/belay-approve',
  gates: {
    shell: true,
    subagent: true,
  },
  audit: {
    logPath: '.cursor/belay/audit.ndjson',
  },
}

export const EMPTY_APPROVALS = {
  version: 1,
  approvals: [],
} as const
