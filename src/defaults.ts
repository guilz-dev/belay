import path from 'node:path'

import { cursorLayout } from './adapters/layouts/cursor.js'
import {
  buildAbsoluteRunnerInvocation,
  buildLegacyAbsoluteRunnerInvocation,
  buildLegacyBarePowerShellRunnerInvocation,
  buildLegacyQuotedAbsoluteRunnerInvocation,
  buildRunnerInvocation,
} from './adapters/layouts/scope.js'
import { type BelayConfigV3, DEFAULT_CONFIG_V3 } from './core/config.js'

export { PACKAGE_NAME } from './branding.js'

export const DEFAULT_CONFIG: BelayConfigV3 = DEFAULT_CONFIG_V3

export type ManagedHookDefinition = {
  command: string
  placement: 'prepend' | 'append'
  matcher?: string
  failClosed?: boolean
}

export type CursorManagedHookDefinition = ManagedHookDefinition & { failClosed: true }

function runnerCommand(
  platform: NodeJS.Platform,
  hooksDir: string,
  _repoRoot: string,
  hookScript: string,
  runnerPathMode:
    | 'absolute'
    | 'legacy-relative'
    | 'legacy-absolute'
    | 'legacy-quoted-absolute'
    | 'legacy-bare-powershell-absolute',
  ...args: string[]
): string {
  if (runnerPathMode === 'absolute') {
    return buildAbsoluteRunnerInvocation(platform, hooksDir, hookScript, ...args)
  }
  if (runnerPathMode === 'legacy-absolute') {
    return buildLegacyAbsoluteRunnerInvocation(platform, hooksDir, hookScript, ...args)
  }
  if (runnerPathMode === 'legacy-quoted-absolute') {
    return buildLegacyQuotedAbsoluteRunnerInvocation(platform, hooksDir, hookScript, ...args)
  }
  if (runnerPathMode === 'legacy-bare-powershell-absolute') {
    return buildLegacyBarePowerShellRunnerInvocation(platform, hooksDir, hookScript, ...args)
  }
  return buildRunnerInvocation(platform, hooksDir, _repoRoot, hookScript, ...args)
}

export function getManagedHookEntries(
  platform: NodeJS.Platform = process.platform,
  hooksDir?: string,
  repoRoot?: string,
  runnerPathMode:
    | 'absolute'
    | 'legacy-relative'
    | 'legacy-absolute'
    | 'legacy-quoted-absolute'
    | 'legacy-bare-powershell-absolute' = 'absolute',
): Array<{ event: string; definition: CursorManagedHookDefinition }> {
  const resolvedRepo = path.resolve(repoRoot ?? process.cwd())
  const resolvedHooksDir = hooksDir ?? cursorLayout.hooksDir(resolvedRepo)
  const toolGate = runnerCommand(
    platform,
    resolvedHooksDir,
    resolvedRepo,
    'belay-tool-gate',
    runnerPathMode,
    'preToolUse',
  )
  const subagentGate = runnerCommand(
    platform,
    resolvedHooksDir,
    resolvedRepo,
    'belay-tool-gate',
    runnerPathMode,
    'subagentStart',
  )

  const entries: Array<{
    event: string
    definition: Omit<CursorManagedHookDefinition, 'failClosed'>
  }> = [
    {
      event: 'beforeSubmitPrompt',
      definition: {
        command: runnerCommand(
          platform,
          resolvedHooksDir,
          resolvedRepo,
          'belay-before-submit',
          runnerPathMode,
        ),
        placement: 'prepend',
      },
    },
    {
      event: 'beforeShellExecution',
      definition: {
        command: runnerCommand(
          platform,
          resolvedHooksDir,
          resolvedRepo,
          'belay-shell-gate',
          runnerPathMode,
        ),
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
          runnerPathMode,
          'postToolUse',
        ),
        placement: 'append',
      },
    },
    {
      event: 'postToolUseFailure',
      definition: {
        command: runnerCommand(
          platform,
          resolvedHooksDir,
          resolvedRepo,
          'belay-audit',
          runnerPathMode,
          'postToolUseFailure',
        ),
        placement: 'append',
      },
    },
    {
      event: 'stop',
      definition: {
        command: runnerCommand(
          platform,
          resolvedHooksDir,
          resolvedRepo,
          'belay-audit',
          runnerPathMode,
          'stop',
        ),
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
          runnerPathMode,
          'sessionEnd',
        ),
        placement: 'append',
      },
    },
  ]
  return entries.map(({ event, definition }) => ({
    event,
    definition: { ...definition, failClosed: true },
  }))
}

/** @deprecated Use getManagedHookEntries instead. */
export function getManagedHookEvents(
  platform: NodeJS.Platform = process.platform,
): Record<string, CursorManagedHookDefinition> {
  const entries = getManagedHookEntries(platform)
  const result: Record<string, CursorManagedHookDefinition> = {}
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
