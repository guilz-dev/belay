import { getManagedHookEntries } from '../../defaults.js'
import type { HookEntry, HooksFile } from '../../types.js'

function entryMatches(existing: HookEntry, expected: HookEntry): boolean {
  return existing.command === expected.command && existing.matcher === expected.matcher
}

function mergeHookEntry(
  current: HookEntry[] | undefined,
  expected: HookEntry,
  placement: 'prepend' | 'append',
): HookEntry[] {
  const entries = Array.isArray(current) ? [...current] : []
  const filtered = entries.filter((entry) => !entryMatches(entry, expected))
  if (placement === 'prepend') {
    return [expected, ...filtered]
  }
  return [...filtered, expected]
}

export function mergeCursorHooksFile(
  current: HooksFile,
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
): HooksFile {
  const next: HooksFile = {
    version: current.version || 1,
    hooks: { ...current.hooks },
  }
  const managedEntries = getManagedHookEntries(platform, hooksDir, repoRoot)
  for (const { event, definition } of managedEntries) {
    next.hooks[event] = mergeHookEntry(
      next.hooks[event],
      {
        command: definition.command,
        matcher: definition.matcher,
      },
      definition.placement,
    )
  }
  return next
}
