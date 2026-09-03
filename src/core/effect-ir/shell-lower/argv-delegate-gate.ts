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

export function shouldApplyArgvDelegate(
  head: string,
  innerTokens: string[],
  depth: number,
): boolean {
  if (depth > 0 || isEgressToolHead(head) || head === 'bundle') {
    return false
  }
  if (ARGV_DELEGATE_INNER_BLOCKLIST.has(head)) {
    return false
  }
  const innerHead = path.basename(innerTokens[0] ?? '')
  if (ARGV_DELEGATE_INNER_BLOCKLIST.has(innerHead)) {
    return false
  }
  return innerTokens.length >= 2
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
    spawn.action === 'process.exec' &&
    spawn.resource.kind === 'executable' &&
    spawn.resource.command === head &&
    spawn.resource.operation === 'spawn' &&
    indeterminate.action === 'indeterminate' &&
    indeterminate.evidence.signals.includes('process.grammar_unknown')
  )
}
