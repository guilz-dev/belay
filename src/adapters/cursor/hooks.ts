import { existsSync, realpathSync } from 'node:fs'

import { getManagedHookEntries } from '../../defaults.js'
import type { HookEntry, HooksFile } from '../../types.js'

function entryMatches(existing: HookEntry, expected: HookEntry): boolean {
  return existing.command === expected.command && existing.matcher === expected.matcher
}

function legacyManagedEntries(platform: NodeJS.Platform, hooksDir: string, repoRoot: string) {
  const entries = [
    ...getManagedHookEntries(platform, hooksDir, repoRoot, 'legacy-relative'),
    ...getManagedHookEntries(platform, hooksDir, repoRoot, 'legacy-absolute'),
    ...getManagedHookEntries(platform, hooksDir, repoRoot, 'legacy-quoted-absolute'),
    ...getManagedHookEntries(platform, hooksDir, repoRoot, 'legacy-bare-powershell-absolute'),
  ]
  if (existsSync(hooksDir)) {
    const canonicalHooksDir = realpathSync(hooksDir)
    if (canonicalHooksDir !== hooksDir) {
      entries.push(
        ...getManagedHookEntries(platform, canonicalHooksDir, repoRoot, 'legacy-absolute'),
      )
    }
  }
  return entries
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
    failClosed: true,
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
  return stripLegacyManagedShellPreToolUseGates(next, platform, hooksDir, repoRoot)
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
        failClosed: definition.failClosed,
      },
      variants,
      definition.placement,
    )
  }
  return stripLegacyManagedShellPreToolUseGates(next, platform, hooksDir, repoRoot)
}

export function legacyManagedShellPreToolUseVariants(
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
): HookEntry[] {
  const shellEntry = managedShellPreToolUseEntry(platform, hooksDir, repoRoot)
  const legacyEntries = legacyManagedEntries(platform, hooksDir, repoRoot)
  const commands = new Set<string>([shellEntry.command])
  for (const entry of legacyEntries) {
    if (entry.event === 'preToolUse' && entry.definition.matcher === 'Write') {
      commands.add(entry.definition.command)
    }
  }
  return [...commands].map((command) => ({
    command,
    matcher: 'Shell',
    failClosed: true,
  }))
}

function stripLegacyManagedShellPreToolUseGates(
  hooks: HooksFile,
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
): HooksFile {
  const variants = legacyManagedShellPreToolUseVariants(platform, hooksDir, repoRoot)
  const preToolUse = hooks.hooks.preToolUse
  if (!Array.isArray(preToolUse) || variants.length === 0) {
    return hooks
  }
  const filtered = preToolUse.filter(
    (entry) => !variants.some((variant) => entryMatches(entry, variant)),
  )
  if (filtered.length === preToolUse.length) {
    return hooks
  }
  const next: HooksFile = {
    version: hooks.version || 1,
    hooks: { ...hooks.hooks },
  }
  if (filtered.length === 0) {
    delete next.hooks.preToolUse
  } else {
    next.hooks.preToolUse = filtered
  }
  return next
}

export function hasLegacyCursorDoubleShellGates(
  hooks: HooksFile,
  platform: NodeJS.Platform,
  hooksDir: string,
  repoRoot: string,
): boolean {
  const shellVariants = legacyManagedShellPreToolUseVariants(platform, hooksDir, repoRoot)
  const preToolUse = hooks.hooks.preToolUse
  const beforeShell = hooks.hooks.beforeShellExecution
  if (!Array.isArray(preToolUse) || !Array.isArray(beforeShell)) {
    return false
  }
  const hasLegacyShellPreToolUse = preToolUse.some((entry) =>
    shellVariants.some((variant) => entryMatches(entry, variant)),
  )
  if (!hasLegacyShellPreToolUse) {
    return false
  }
  const managedEntries = getManagedHookEntries(platform, hooksDir, repoRoot)
  const shellManaged = managedEntries.find((entry) => entry.event === 'beforeShellExecution')
  if (!shellManaged) {
    return false
  }
  const shellVariantsForBefore = variantsForDefinition(
    legacyManagedEntries(platform, hooksDir, repoRoot),
    'beforeShellExecution',
    shellManaged.definition,
  )
  return beforeShell.some((entry) =>
    shellVariantsForBefore.some((variant) => entryMatches(entry, variant)),
  )
}

/** @deprecated Use {@link hasLegacyCursorDoubleShellGates}. */
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
