import path from 'node:path'

import { cursorLayout } from './adapters/layouts/cursor.js'
import { buildRunnerInvocation } from './adapters/layouts/scope.js'
import { type BelayConfigV3, DEFAULT_CONFIG_V3 } from './core/config.js'

export const PACKAGE_NAME = 'agent-belay'

export const DEFAULT_CONFIG: BelayConfigV3 = DEFAULT_CONFIG_V3

export type ManagedHookDefinition = {
  command: string
  placement: 'prepend' | 'append'
  matcher?: string
}

function runnerCommand(
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
  hookScript: string,
  ...args: string[]
): string {
  return buildRunnerInvocation(platform, hooksDir, repoRoot, hookScript, ...args)
}

export function getManagedHookEntries(
  platform: NodeJS.Platform = process.platform,
  hooksDir?: string,
  repoRoot?: string,
): Array<{ event: string; definition: ManagedHookDefinition }> {
  const resolvedRepo = path.resolve(repoRoot ?? process.cwd())
  const resolvedHooksDir = hooksDir ?? cursorLayout.hooksDir(resolvedRepo)
  const toolGate = runnerCommand(
    platform,
    resolvedHooksDir,
    resolvedRepo,
    'belay-tool-gate',
    'preToolUse',
  )
  const subagentGate = runnerCommand(
    platform,
    resolvedHooksDir,
    resolvedRepo,
    'belay-tool-gate',
    'subagentStart',
  )

  return [
    {
      event: 'beforeSubmitPrompt',
      definition: {
        command: runnerCommand(platform, resolvedHooksDir, resolvedRepo, 'belay-before-submit'),
        placement: 'prepend',
      },
    },
    {
      event: 'beforeShellExecution',
      definition: {
        command: runnerCommand(platform, resolvedHooksDir, resolvedRepo, 'belay-shell-gate'),
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
      event: 'subagentStart',
      definition: {
        command: subagentGate,
        placement: 'prepend',
        matcher: 'explore',
      },
    },
    {
      event: 'subagentStart',
      definition: {
        command: subagentGate,
        placement: 'prepend',
        matcher: 'videoReview',
      },
    },
    {
      event: 'subagentStart',
      definition: {
        command: subagentGate,
        placement: 'prepend',
        matcher: 'bugbot',
      },
    },
    {
      event: 'postToolUse',
      definition: {
        command: runnerCommand(
          platform,
          resolvedHooksDir,
          resolvedRepo,
          'belay-audit',
          'postToolUse',
        ),
        placement: 'append',
      },
    },
    {
      event: 'stop',
      definition: {
        command: runnerCommand(platform, resolvedHooksDir, resolvedRepo, 'belay-audit', 'stop'),
        placement: 'append',
      },
    },
    {
      event: 'sessionEnd',
      definition: {
        command: runnerCommand(
          platform,
          resolvedHooksDir,
          resolvedRepo,
          'belay-audit',
          'sessionEnd',
        ),
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
