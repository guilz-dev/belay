import { getManagedHookEntries } from '../../defaults.js'
import type { HookEntry, HooksFile } from '../../types.js'

function entryMatches(existing: HookEntry, expected: HookEntry): boolean {
  return existing.command === expected.command && existing.matcher === expected.matcher
}

function legacyManagedEntries(platform: NodeJS.Platform, hooksDir: string, repoRoot: string) {
  return getManagedHookEntries(platform, hooksDir, repoRoot, 'legacy-relative')
}

function variantsForDefinition(
  legacyEntries: ReturnType<typeof getManagedHookEntries>,
  event: string,
  definition: HookEntry,
): HookEntry[] {
  return [
    definition,
    ...legacyEntries
      .filter((entry) => entry.event === event && entry.definition.matcher === definition.matcher)
      .map((entry) => entry.definition),
  ]
}

function mergeHookEntry(
  current: HookEntry[] | undefined,
  expected: HookEntry,
  managedVariants: HookEntry[],
  placement: 'prepend' | 'append',
): HookEntry[] {
  const entries = Array.isArray(current) ? [...current] : []
  const filtered = entries.filter(
    (entry) => !managedVariants.some((variant) => entryMatches(entry, variant)),
  )
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
  const legacyEntries = legacyManagedEntries(platform, hooksDir, repoRoot)
  for (const { event, definition } of managedEntries) {
    const entries = next.hooks[event]
    if (!Array.isArray(entries)) {
      continue
    }
    const variants = variantsForDefinition(legacyEntries, event, definition)
    next.hooks[event] = entries.filter(
      (entry) => !variants.some((variant) => entryMatches(entry, variant)),
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
  const legacyEntries = legacyManagedEntries(platform, hooksDir, repoRoot)
  for (const { event, definition } of managedEntries) {
    const variants = variantsForDefinition(legacyEntries, event, definition)
    next.hooks[event] = mergeHookEntry(
      next.hooks[event],
      {
        command: definition.command,
        matcher: definition.matcher,
      },
      variants,
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

export function hasManagedCursorHookEntries(
  hooks: HooksFile,
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
): boolean {
  const managedEntries = [
    ...getManagedHookEntries(platform, hooksDir, repoRoot),
    ...legacyManagedEntries(platform, hooksDir, repoRoot),
  ]
  return managedEntries.some(({ event, definition }) =>
    hooks.hooks[event]?.some((entry) => entryMatches(entry, definition)),
  )
}
