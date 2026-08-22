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

/** Legacy Belay-managed Shell preToolUse gate duplicated beforeShellExecution. */
export function legacyManagedShellPreToolUseEntry(
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
): HookEntry {
  const managed = getManagedHookEntries(platform, hooksDir, repoRoot)
  const referencePreToolUse = managed.find(
    (entry) => entry.event === 'preToolUse' && entry.definition.matcher === 'Write',
  )?.definition
  if (!referencePreToolUse) {
    throw new Error('managed hook definitions missing for legacy Shell migration')
  }
  return {
    command: referencePreToolUse.command,
    matcher: 'Shell',
  }
}

export function removeLegacyManagedShellPreToolUse(
  hooks: HooksFile,
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
): HooksFile {
  const legacy = legacyManagedShellPreToolUseEntry(platform, hooksDir, repoRoot)
  const preToolUse = hooks.hooks.preToolUse
  if (!Array.isArray(preToolUse)) {
    return hooks
  }
  return {
    ...hooks,
    hooks: {
      ...hooks.hooks,
      preToolUse: preToolUse.filter((entry) => !entryMatches(entry, legacy)),
    },
  }
}

export function mergeCursorHooksFile(
  current: HooksFile,
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
): HooksFile {
  const withoutLegacyShell = removeLegacyManagedShellPreToolUse(
    current,
    platform,
    hooksDir,
    repoRoot,
  )
  const next: HooksFile = {
    version: withoutLegacyShell.version || 1,
    hooks: { ...withoutLegacyShell.hooks },
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

export function hasDuplicateCursorShellGates(
  hooks: HooksFile,
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
): boolean {
  const legacy = legacyManagedShellPreToolUseEntry(platform, hooksDir, repoRoot)
  const preToolUse = hooks.hooks.preToolUse
  if (!Array.isArray(preToolUse)) {
    return false
  }
  return preToolUse.some((entry) => entryMatches(entry, legacy))
}
