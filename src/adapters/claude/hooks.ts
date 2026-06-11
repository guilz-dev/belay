import type { ManagedHookDefinition } from '../../defaults.js'

function runnerCommand(platform: NodeJS.Platform, hookName: string, ...args: string[]): string {
  const base =
    platform === 'win32' ? '.\\.claude\\hooks\\belay-runner.cmd' : './.claude/hooks/belay-runner'
  return [base, hookName, ...args].join(' ')
}

export interface ClaudeHookGroup {
  matcher?: string
  hooks: Array<{ type: 'command'; command: string }>
}

export function getClaudeManagedHookGroups(
  platform: NodeJS.Platform = process.platform,
): Record<string, ClaudeHookGroup[]> {
  const toolGate = runnerCommand(platform, 'belay-tool-gate', 'PreToolUse')
  const shellGate = runnerCommand(platform, 'belay-shell-gate')
  const approvalGate = runnerCommand(platform, 'belay-before-submit')
  const auditHook = runnerCommand(platform, 'belay-audit', 'PostToolUse')

  return {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: shellGate }],
      },
      {
        matcher: 'Task',
        hooks: [{ type: 'command', command: toolGate }],
      },
      {
        matcher: 'Write|Edit|Delete',
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
): Array<{ event: string; definition: ManagedHookDefinition }> {
  const groups = getClaudeManagedHookGroups(platform)
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
