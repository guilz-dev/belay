import { type BelayConfigV2, DEFAULT_CONFIG_V2 } from './core/config.js'

export const PACKAGE_NAME = 'agent-belay'

export const DEFAULT_CONFIG: BelayConfigV2 = DEFAULT_CONFIG_V2

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

export function getManagedHookEntries(
  platform: NodeJS.Platform = process.platform,
): Array<{ event: string; definition: ManagedHookDefinition }> {
  const toolGate = runnerCommand(platform, 'belay-tool-gate', 'preToolUse')
  const subagentGate = runnerCommand(platform, 'belay-tool-gate', 'subagentStart')

  return [
    {
      event: 'beforeSubmitPrompt',
      definition: {
        command: runnerCommand(platform, 'belay-before-submit'),
        placement: 'prepend',
      },
    },
    {
      event: 'beforeShellExecution',
      definition: {
        command: runnerCommand(platform, 'belay-shell-gate'),
        placement: 'prepend',
      },
    },
    {
      event: 'preToolUse',
      definition: {
        command: toolGate,
        placement: 'prepend',
        matcher: 'Task',
      },
    },
    {
      event: 'preToolUse',
      definition: {
        command: toolGate,
        placement: 'prepend',
        matcher: 'Shell',
      },
    },
    {
      event: 'preToolUse',
      definition: {
        command: toolGate,
        placement: 'prepend',
        matcher: 'Write',
      },
    },
    {
      event: 'preToolUse',
      definition: {
        command: toolGate,
        placement: 'prepend',
        matcher: 'StrReplace',
      },
    },
    {
      event: 'preToolUse',
      definition: {
        command: toolGate,
        placement: 'prepend',
        matcher: 'Delete',
      },
    },
    {
      event: 'subagentStart',
      definition: {
        command: subagentGate,
        placement: 'prepend',
        matcher: 'generalPurpose',
      },
    },
    {
      event: 'subagentStart',
      definition: {
        command: subagentGate,
        placement: 'prepend',
        matcher: 'computerUse',
      },
    },
    {
      event: 'subagentStart',
      definition: {
        command: subagentGate,
        placement: 'prepend',
        matcher: 'debug',
      },
    },
    {
      event: 'postToolUse',
      definition: {
        command: runnerCommand(platform, 'belay-audit', 'postToolUse'),
        placement: 'append',
      },
    },
    {
      event: 'stop',
      definition: {
        command: runnerCommand(platform, 'belay-audit', 'stop'),
        placement: 'append',
      },
    },
    {
      event: 'sessionEnd',
      definition: {
        command: runnerCommand(platform, 'belay-audit', 'sessionEnd'),
        placement: 'append',
      },
    },
  ]
}

/** @deprecated Use getManagedHookEntries instead. */
export function getManagedHookEvents(
  platform: NodeJS.Platform = process.platform,
): Record<string, ManagedHookDefinition> {
  const entries = getManagedHookEntries(platform)
  const result: Record<string, ManagedHookDefinition> = {}
  for (const entry of entries) {
    if (!result[entry.event]) {
      result[entry.event] = entry.definition
    }
  }
  return result
}

export const EMPTY_APPROVALS = {
  version: 1,
  approvals: [],
} as const
