import { matchesCustomCommand } from '../custom-command-match.js'
import type { ParsedSegment } from './parser.js'
import type { InternalSegmentVerdict, VerdictContext } from './types.js'

export function matchesCustomPatterns(
  command: string,
  segment: ParsedSegment,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) {
    return false
  }
  const normalized = command.trim()
  return patterns.some(
    (pattern) =>
      matchesCustomCommand(normalized, segment.key, pattern) ||
      matchesCustomCommand(segment.normalized, segment.key, pattern),
  )
}

export function customAllowMatch(
  command: string,
  segment: ParsedSegment,
  context: VerdictContext,
): boolean {
  return matchesCustomPatterns(command, segment, context.customAllowCommands)
}

export function customExternalMatch(
  command: string,
  segment: ParsedSegment,
  context: VerdictContext,
): boolean {
  return matchesCustomPatterns(command, segment, context.customExternalCommands)
}

export function allowFromCustomOverride(
  opacity: InternalSegmentVerdict['opacity'],
): InternalSegmentVerdict {
  return {
    permission: 'allow',
    location: 'repo_local',
    opacity,
    effect: 'unknown',
    confidence: 'deterministic',
    reason: 'custom_allow',
    signals: ['custom_allow'],
  }
}

export function askFromCustomExternal(
  opacity: InternalSegmentVerdict['opacity'],
): InternalSegmentVerdict {
  return {
    permission: 'ask',
    location: 'external',
    opacity,
    effect: 'remote_mutation',
    confidence: 'deterministic',
    reason: 'custom_external',
    signals: ['custom_external'],
  }
}
