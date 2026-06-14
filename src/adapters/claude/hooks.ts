import path from 'node:path'
import type { ManagedHookDefinition } from '../../defaults.js'
import { buildRunnerInvocation } from '../layouts/scope.js'

export interface ClaudeHookGroup {
  matcher?: string
  hooks: Array<{ type: 'command'; command: string }>
}

export function getClaudeManagedHookGroups(
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
): Record<string, ClaudeHookGroup[]> {
  const runner = (hookName: string, ...args: string[]) =>
    buildRunnerInvocation(platform, hooksDir, repoRoot, hookName, ...args)
  const toolGate = runner('belay-tool-gate', 'PreToolUse')
  const approvalGate = runner('belay-before-submit')
  const auditHook = runner('belay-audit', 'PostToolUse')

  return {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: toolGate }],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [{ type: 'command', command: approvalGate }],
      },
    ],
    PostToolUse: [
      {
        hooks: [{ type: 'command', command: auditHook }],
      },
    ],
  }
}

export function getClaudeManagedHookEntries(
  platform: NodeJS.Platform = process.platform,
  hooksDir?: string,
  repoRoot?: string,
): Array<{ event: string; definition: ManagedHookDefinition }> {
  const resolvedRepo = path.resolve(repoRoot ?? process.cwd())
  const resolvedHooksDir = hooksDir ?? path.join(resolvedRepo, '.claude', 'hooks')
  const groups = getClaudeManagedHookGroups(platform, resolvedHooksDir, resolvedRepo)
  const entries: Array<{ event: string; definition: ManagedHookDefinition }> = []
  for (const [event, groupList] of Object.entries(groups)) {
    for (const group of groupList) {
      const command = group.hooks[0]?.command
      if (!command) {
        continue
      }
      entries.push({
        event,
        definition: {
          command,
          placement: 'prepend',
          matcher: group.matcher,
        },
      })
    }
  }
  return entries
}
