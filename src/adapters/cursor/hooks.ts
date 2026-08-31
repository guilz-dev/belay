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

/** Managed Shell preToolUse gate for Cursor Agent Shell tool invocations. */
export function managedShellPreToolUseEntry(
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
): HookEntry {
  const managed = getManagedHookEntries(platform, hooksDir, repoRoot)
  const referencePreToolUse = managed.find(
    (entry) => entry.event === 'preToolUse' && entry.definition.matcher === 'Write',
  )?.definition
  if (!referencePreToolUse) {
    throw new Error('managed hook definitions missing for Shell preToolUse gate')
  }
  return {
    command: referencePreToolUse.command,
    matcher: 'Shell',
  }
}

/** @deprecated Use {@link managedShellPreToolUseEntry}. */
export const legacyManagedShellPreToolUseEntry = managedShellPreToolUseEntry

export function stripCursorHooksFile(
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
    const entries = next.hooks[event]
    if (!Array.isArray(entries)) {
      continue
    }
    next.hooks[event] = entries.filter(
      (entry) =>
        !entryMatches(entry, {
          command: definition.command,
          matcher: definition.matcher,
        }),
    )
    if (next.hooks[event].length === 0) {
      delete next.hooks[event]
    }
  }
  return next
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

export function hasDuplicateCursorShellGates(
  hooks: HooksFile,
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
): boolean {
  const shellEntry = managedShellPreToolUseEntry(platform, hooksDir, repoRoot)
  const preToolUse = hooks.hooks.preToolUse
  if (!Array.isArray(preToolUse)) {
    return false
  }
  const shellMatches = preToolUse.filter((entry) => entryMatches(entry, shellEntry))
  return shellMatches.length > 1
}
