import path from 'node:path'

import { extractRedirectTargets } from '../shell-tokenizer.js'
import { classifyGitCommand } from './git-classifier.js'
import type { ParsedSegment } from './parser.js'
import type { VerdictEffect } from './types.js'

export interface ShellCommandSemantics {
  effect: VerdictEffect
  pathTargets: string[]
  scopeTargets?: string[]
  signals: string[]
  egressClass?: 'read' | 'destructive' | 'ambiguous'
  requiresAsk?: { reason: string; signals: string[] }
  effectiveCwd?: string
  gitWorkTree?: string
  normalizedKey?: string
  isReadOnly?: boolean
}

const READ_ONLY_KEYS = new Set([
  'cat',
  'cd',
  'echo',
  'head',
  'ls',
  'pwd',
  'rg',
  'sort',
  'tail',
  'wc',
  'which',
  'find',
  'grep',
  'jq',
  'stat',
  'file',
  'du',
  'readlink',
  'realpath',
  'basename',
  'dirname',
  'uname',
  'whoami',
  'id',
  'printenv',
  'test',
  'printf',
  'cut',
  'tr',
  'uniq',
  'cmp',
  'comm',
  'shasum',
  'md5sum',
])

const PURE_READ_ONLY_KEYS = new Set([
  'echo',
  'pwd',
  'which',
  'grep',
  'jq',
  'stat',
  'file',
  'du',
  'readlink',
  'realpath',
  'basename',
  'dirname',
  'uname',
  'whoami',
  'id',
  'printenv',
  'test',
  'printf',
  'cut',
  'tr',
  'uniq',
  'cmp',
  'comm',
  'shasum',
  'md5sum',
])

const LOCAL_MUTATION_KEYS = new Set([
  'chmod',
  'cp',
  'mkdir',
  'mv',
  'rm',
  'sed',
  'tee',
  'touch',
  'truncate',
])

export const LOCAL_ROUTINE_HEADS = new Set([
  'tsc',
  'vitest',
  'vite',
  'webpack',
  'esbuild',
  'rollup',
  'jest',
  'mocha',
  'cargo',
  'go',
  'make',
  'cmake',
  'biome',
  'eslint',
])

function looksLikePathToken(token: string): boolean {
  if (!token || token.startsWith('-')) {
    return false
  }
  return (
    token.includes('/') || token.includes('\\') || token.startsWith('.') || token.includes('...')
  )
}

function filterRoutinePathTargets(head: string, targets: string[]): string[] {
  if (!LOCAL_ROUTINE_HEADS.has(head)) {
    return targets
  }
  return targets.filter((target) => looksLikePathToken(target))
}

function extractFilePathOperands(tokens: string[]): string[] {
  const redirects = extractRedirectTargets(tokens)
  const args: string[] = [...redirects]
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.startsWith('-')) {
      continue
    }
    if (redirects.includes(token)) {
      continue
    }
    args.push(token)
  }
  return args
}

function isRsyncRemoteOperand(token: string): boolean {
  if (/^rsync:\/\/.+/.test(token)) {
    return true
  }
  if (/^(?:[^@\s/:]+@)?(?:\[[^\]]+\]|[^:/\s]+)::/.test(token)) {
    return true
  }
  if (
    !/^[A-Za-z]:[\\/]/.test(token) &&
    /^(?:[^@\s/:]+@)?(?:\[[^\]]+\]|[^:/\s]+):[^:].*/.test(token)
  ) {
    return true
  }
  if (/^\/\/.+\//.test(token)) {
    return true
  }
  return false
}

function classifyRsync(tokens: string[]): ShellCommandSemantics {
  const args = tokens.slice(1)
  const pathTargets = args.filter((token) => token && !token.startsWith('-'))
  const signals = ['rsync']
  const destructive = args.some(
    (token) =>
      token.startsWith('--delete') ||
      token === '--del' ||
      token === '--remove-source-files' ||
      token.startsWith('--remove-source-files='),
  )

  if (destructive) {
    return {
      effect: 'local_mutation',
      pathTargets,
      signals: [...signals, 'rsync.destructive'],
      requiresAsk: {
        reason: 'rsync_destructive',
        signals: ['rsync.destructive', 'rsync.delete'],
      },
    }
  }

  const remote = pathTargets.some((token) => isRsyncRemoteOperand(token))
  if (remote) {
    return {
      effect: 'remote_mutation',
      pathTargets,
      signals: [...signals, 'rsync.remote'],
      egressClass: 'ambiguous',
    }
  }

  return {
    effect: 'local_mutation',
    pathTargets,
    signals: [...signals, 'rsync.local'],
  }
}

export function isPureReadOnlySemantics(
  segment: ParsedSegment,
  semantics: ShellCommandSemantics,
): boolean {
  return (
    semantics.isReadOnly === true ||
    PURE_READ_ONLY_KEYS.has(segment.head) ||
    PURE_READ_ONLY_KEYS.has(segment.key) ||
    PURE_READ_ONLY_KEYS.has(semantics.normalizedKey ?? '')
  )
}

export function analyzeShellCommandSemantics(
  tokens: string[],
  segment: ParsedSegment,
  cwd: string,
): ShellCommandSemantics {
  const head = segment.head
  const basename = path.basename(tokens[0] ?? head)

  if (basename === 'git') {
    const gitSemantics = classifyGitCommand(tokens, cwd)
    if (gitSemantics) {
      return {
        effect: gitSemantics.effect,
        pathTargets: gitSemantics.pathTargets,
        scopeTargets: gitSemantics.scopeTargets,
        signals: gitSemantics.signals,
        egressClass: gitSemantics.egressClass,
        requiresAsk: gitSemantics.requiresAsk,
        effectiveCwd: gitSemantics.effectiveCwd,
        gitWorkTree: gitSemantics.gitWorkTree,
        normalizedKey: gitSemantics.normalizedKey,
        isReadOnly: gitSemantics.isReadOnly,
      }
    }
  }

  if (head === 'rsync') {
    return classifyRsync(tokens)
  }

  let effect: VerdictEffect = 'unknown'
  let pathTargets = extractFilePathOperands(tokens)
  pathTargets = filterRoutinePathTargets(head, pathTargets)
  const signals: string[] = []

  if (READ_ONLY_KEYS.has(segment.key) || READ_ONLY_KEYS.has(head)) {
    effect = 'read_only'
  } else if (LOCAL_MUTATION_KEYS.has(segment.key) || LOCAL_MUTATION_KEYS.has(head)) {
    effect = 'local_mutation'
  } else if (LOCAL_ROUTINE_HEADS.has(head)) {
    effect = 'local_mutation'
    signals.push('routine_local')
  }

  if (extractRedirectTargets(tokens).length > 0 && effect === 'read_only') {
    effect = 'local_mutation'
  }

  return {
    effect,
    pathTargets,
    signals,
    normalizedKey: segment.key,
    isReadOnly: effect === 'read_only',
  }
}

export { LOCAL_MUTATION_KEYS, PURE_READ_ONLY_KEYS, READ_ONLY_KEYS }
