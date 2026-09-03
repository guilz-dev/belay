import path from 'node:path'

import { tokenizeShell } from '../../shell-tokenizer.js'
import { joinEffectOpacity } from '../normalize.js'
import type { ShellEffectRequirement, ShellEffectSegment } from '../shell-build.js'
import type { EffectPlan } from '../types.js'
import { requirement } from './requirement.js'
import { resolvePathOperand } from './tokens.js'

const DYNAMIC_SHELL_VALUE_PATTERN =
  /(?:\$\(|`|\$(?:\d+|[@*#?$!-]|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*))/
const SHELL_GLOB_PATTERN = /[*?[]/

export function requiresKnownCwd(requirementValue: ShellEffectRequirement): boolean {
  if (
    requirementValue.action === 'fs.write' ||
    requirementValue.action === 'git.ref.write' ||
    requirementValue.action === 'control_plane.write'
  ) {
    return true
  }
  return (
    requirementValue.action === 'process.exec' &&
    requirementValue.resource.kind === 'executable' &&
    requirementValue.resource.operation === 'spawn'
  )
}

export function joinNestedOpacity(
  outer: EffectPlan['opacity'],
  nested: ShellEffectSegment,
): EffectPlan['opacity'] {
  const nestedOpacity =
    nested.completeness === 'partial' && nested.opacity === 'transparent'
      ? 'recursive'
      : nested.opacity
  return joinEffectOpacity(outer, nestedOpacity)
}

export function startsLocalPostgresService(command: string): boolean {
  const tokens = tokenizeShell(command)
  return (
    path.basename(tokens[0] ?? '') === 'docker' &&
    tokens[1] === 'compose' &&
    ['up', 'start', 'restart'].includes(tokens[2] ?? '') &&
    tokens.includes('postgres')
  )
}

export function resolveCdTransition(
  command: string,
  currentCwd: string,
): { cwd: string; known: boolean } | null {
  const tokens = tokenizeShell(command)
  if (path.basename(tokens[0] ?? '') !== 'cd') {
    return null
  }
  const target = tokens[1] ?? '~'
  if (!target || target === '-' || target.includes('$') || target.includes('`')) {
    return { cwd: currentCwd, known: false }
  }
  return { cwd: resolvePathOperand(target, currentCwd), known: true }
}

export function shellSegment(
  commandRedacted: string,
  segmentHead: string,
  requirements: ShellEffectRequirement[],
  opacity: EffectPlan['opacity'],
  signals: Set<string>,
): ShellEffectSegment {
  const normalizedRequirements = requirements.flatMap((entry) => {
    const dynamicSignal = dynamicResourceSignal(entry.resource)
    if (dynamicSignal) {
      return [
        { ...entry, resource: { kind: 'unknown' } as const },
        requirement(
          'indeterminate',
          'indeterminate',
          { kind: 'unknown' },
          entry.provenance.segment ?? commandRedacted,
          [...entry.evidence.signals, dynamicSignal],
        ),
      ]
    }
    return [entry]
  })
  const partial = normalizedRequirements.some(
    (entry) => entry.tag === 'indeterminate' || entry.action === 'indeterminate',
  )
  return {
    commandRedacted,
    segmentHead,
    requirements: normalizedRequirements,
    completeness: partial ? 'partial' : 'complete',
    opacity,
    signals: [...signals].sort(),
  }
}

export function dynamicResourceSignal(resource: ShellEffectRequirement['resource']): string | null {
  const expanded = (value: string | undefined): boolean =>
    Boolean(value && DYNAMIC_SHELL_VALUE_PATTERN.test(value))
  const pathLike = (value: string | undefined, allowSemanticWildcard = false): boolean =>
    Boolean(
      value && (expanded(value) || (!allowSemanticWildcard && SHELL_GLOB_PATTERN.test(value))),
    )
  switch (resource.kind) {
    case 'path':
      return pathLike(resource.path) ? 'shell.path_unresolved' : null
    case 'network':
      return expanded(resource.host) || expanded(resource.protocol)
        ? 'shell.network_resource_unresolved'
        : null
    case 'git-ref':
      return pathLike(resource.repoPath) || pathLike(resource.ref, resource.ref.endsWith('/*'))
        ? 'shell.git_resource_unresolved'
        : null
    case 'executable':
      return expanded(resource.command) ? 'shell.executable_unresolved' : null
    default:
      return null
  }
}
