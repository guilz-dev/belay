import path from 'node:path'

import { isEgressToolHead } from '../../verdict/egress-classify.js'
import type { ShellEffectRequirement } from '../shell-build.js'

const ARGV_DELEGATE_INNER_BLOCKLIST = new Set([
  'sudo',
  'env',
  'command',
  'builtin',
  'exec',
  'time',
  'nice',
  'nohup',
  'stdbuf',
  'setsid',
  '(',
])

const MAX_NESTED_ARGV_DELEGATE_DEPTH = 1

export function shouldApplyArgvDelegate(
  head: string,
  innerTokens: string[],
  depth: number,
): boolean {
  if (depth > MAX_NESTED_ARGV_DELEGATE_DEPTH || isEgressToolHead(head) || head === 'bundle') {
    return false
  }
  if (ARGV_DELEGATE_INNER_BLOCKLIST.has(head)) {
    return false
  }
  const innerHead = path.basename(innerTokens[0] ?? '')
  if (ARGV_DELEGATE_INNER_BLOCKLIST.has(innerHead)) {
    return false
  }
  return innerTokens.length >= 1
}

export function isGrammarUnknownOnly(
  requirements: ShellEffectRequirement[],
  head: string,
): boolean {
  if (requirements.length !== 2) {
    return false
  }
  const [spawn, indeterminate] = requirements
  return (
    spawn.tag === 'process.exec' &&
    spawn.action === 'process.exec' &&
    spawn.resource.kind === 'executable' &&
    spawn.resource.command === head &&
    spawn.resource.operation === 'spawn' &&
    spawn.evidence.level === 'certain' &&
    spawn.evidence.signals.length === 1 &&
    spawn.evidence.signals[0] === 'process.grammar_unknown' &&
    indeterminate.tag === 'indeterminate' &&
    indeterminate.action === 'indeterminate' &&
    indeterminate.resource.kind === 'unknown' &&
    indeterminate.evidence.level === 'indeterminate' &&
    indeterminate.evidence.signals.length === 1 &&
    indeterminate.evidence.signals[0] === 'process.grammar_unknown'
  )
}
