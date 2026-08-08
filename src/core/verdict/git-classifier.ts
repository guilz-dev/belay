import path from 'node:path'

import { extractRedirectTargets } from '../shell-tokenizer.js'
import type { VerdictEffect } from './types.js'

export interface NormalizedGitInvocation {
  subcommand: string
  args: string[]
  effectiveCwd?: string
  gitDir?: string
  workTree?: string
}

export interface GitCommandSemantics {
  effect: VerdictEffect
  pathTargets: string[]
  signals: string[]
  egressClass?: 'read' | 'destructive' | 'ambiguous'
  requiresAsk?: { reason: string; signals: string[] }
  effectiveCwd?: string
  gitWorkTree?: string
  normalizedKey: string
  isReadOnly: boolean
}

const GIT_BRANCH_MUTATION_FLAGS = new Set([
  '--copy',
  '--create-reflog',
  '--delete',
  '--edit-description',
  '--force',
  '--move',
  '--no-create-reflog',
  '--no-track',
  '--recurse-submodules',
  '--set-upstream-to',
  '--track',
  '--unset-upstream',
])

const GIT_BRANCH_LIST_FLAGS = new Set([
  '--abbrev',
  '--all',
  '--column',
  '--color',
  '--contains',
  '--format',
  '--ignore-case',
  '--list',
  '--merged',
  '--no-abbrev',
  '--no-column',
  '--no-color',
  '--no-contains',
  '--no-merged',
  '--points-at',
  '--remotes',
  '--show-current',
  '--sort',
  '--verbose',
])

const GIT_BRANCH_MUTATION_SHORT_FLAGS = new Set(['c', 'C', 'd', 'D', 'f', 'm', 'M', 't', 'u'])
const GIT_BRANCH_LIST_SHORT_FLAGS = new Set(['a', 'i', 'l', 'r', 'v'])

const READ_ONLY_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'describe',
  'show-ref',
  'reflog',
  'ls-files',
  'ls-tree',
  'cat-file',
  'verify-commit',
  'whatchanged',
  'shortlog',
  'help',
  'version',
])

const READ_ONLY_COMPOUND_SUBCOMMANDS = new Set(['worktree list', 'stash list', 'stash show'])

const LOCAL_MUTATION_SUBCOMMANDS = new Set([
  'add',
  'commit',
  'mv',
  'revert',
  'merge',
  'cherry-pick',
  'am',
  'apply',
  'format-patch',
])

const REMOTE_SUBCOMMANDS = new Set(['fetch', 'pull'])

const LOCAL_MUTATION_COMPOUND_SUBCOMMANDS = new Set([
  'worktree add',
  'stash push',
  'stash apply',
  'stash pop',
  'stash drop',
  'stash branch',
])

const FILE_OPERAND_SUBCOMMANDS = new Set([
  'add',
  'rm',
  'mv',
  'checkout',
  'restore',
  'clean',
  'apply',
  'cherry-pick',
  'merge',
  'show',
  'diff',
  'grep',
  'ls-files',
])

const COMPOUND_SUBCOMMAND_HEADS = new Set(['worktree', 'stash', 'tag'])

/** Positional args before `--` are refs/revisions, not worktree paths. */
const REF_ONLY_WITHOUT_TERMINATOR = new Set(['checkout', 'show', 'log'])

function isGitExecutable(token: string): boolean {
  return path.basename(token) === 'git'
}

function takesValue(flag: string): boolean {
  return (
    flag === '-C' ||
    flag === '-c' ||
    flag === '--git-dir' ||
    flag === '--work-tree' ||
    flag === '--exec-path' ||
    flag === '--paginate' ||
    flag === '--config-env' ||
    flag.startsWith('-C') ||
    flag.startsWith('-c') ||
    flag.startsWith('--git-dir=') ||
    flag.startsWith('--work-tree=')
  )
}

function peelGlobalOptions(
  tokens: string[],
  baseCwd: string,
): { rest: string[]; effectiveCwd: string; gitDir?: string; workTree?: string } {
  let effectiveCwd = baseCwd
  let gitDir: string | undefined
  let workTree: string | undefined
  const rest: string[] = []
  let index = 1

  while (index < tokens.length) {
    const token = tokens[index]
    if (!token) {
      index += 1
      continue
    }
    if (token === '--') {
      rest.push(...tokens.slice(index))
      break
    }
    if (token === '--no-pager' || token === '--no-replace-objects') {
      index += 1
      continue
    }
    if (token === '-C' || token === '--work-tree' || token === '--git-dir' || token === '-c') {
      const value = tokens[index + 1]
      if (token === '-C' && value) {
        effectiveCwd = path.resolve(baseCwd, value)
      } else if (token === '--work-tree' && value) {
        workTree = value
      } else if (token === '--git-dir' && value) {
        gitDir = value
      }
      index += value ? 2 : 1
      continue
    }
    if (token.startsWith('-C') && token.length > 2) {
      effectiveCwd = path.resolve(baseCwd, token.slice(2))
      index += 1
      continue
    }
    if (token.startsWith('--work-tree=')) {
      workTree = token.slice('--work-tree='.length)
      index += 1
      continue
    }
    if (token.startsWith('--git-dir=')) {
      gitDir = token.slice('--git-dir='.length)
      index += 1
      continue
    }
    if (token.startsWith('-c') || token.startsWith('--config')) {
      index += token.includes('=') ? 1 : tokens[index + 1] ? 2 : 1
      continue
    }
    if (token.startsWith('-')) {
      if (takesValue(token) && !token.includes('=')) {
        index += 2
      } else {
        index += 1
      }
      continue
    }
    rest.push(...tokens.slice(index))
    break
  }

  return { rest, effectiveCwd, gitDir, workTree }
}

function resolveSubcommand(rest: string[]): { subcommand: string; args: string[] } {
  const head = rest[0] ?? ''
  const second = rest[1] ?? ''
  if (COMPOUND_SUBCOMMAND_HEADS.has(head) && second && !second.startsWith('-')) {
    return { subcommand: `${head} ${second}`, args: rest.slice(2) }
  }
  return { subcommand: head, args: rest.slice(1) }
}

export function normalizeGitInvocation(
  tokens: string[],
  baseCwd: string,
): NormalizedGitInvocation | null {
  if (!isGitExecutable(tokens[0] ?? '')) {
    return null
  }
  const peeled = peelGlobalOptions(tokens, baseCwd)
  const { subcommand, args } = resolveSubcommand(peeled.rest)
  if (!subcommand) {
    return null
  }
  return {
    subcommand,
    args,
    effectiveCwd: peeled.effectiveCwd !== baseCwd ? peeled.effectiveCwd : undefined,
    gitDir: peeled.gitDir,
    workTree: peeled.workTree,
  }
}

function hasGitBranchLongFlag(tokens: string[], flags: Set<string>): boolean {
  return tokens.some((token) => {
    const [name] = token.split('=', 1)
    return name ? flags.has(name) : false
  })
}

function hasGitBranchShortFlag(tokens: string[], flags: Set<string>): boolean {
  return tokens.some((token) => {
    if (!/^-[^-]+$/.test(token)) {
      return false
    }
    return [...token.slice(1)].some((flag) => flags.has(flag))
  })
}

function gitBranchEffect(args: string[]): VerdictEffect {
  const optionTerminator = args.indexOf('--')
  const optionArgs = optionTerminator >= 0 ? args.slice(0, optionTerminator) : args
  if (
    hasGitBranchLongFlag(optionArgs, GIT_BRANCH_MUTATION_FLAGS) ||
    hasGitBranchShortFlag(optionArgs, GIT_BRANCH_MUTATION_SHORT_FLAGS)
  ) {
    return 'local_mutation'
  }
  if (
    hasGitBranchLongFlag(optionArgs, GIT_BRANCH_LIST_FLAGS) ||
    hasGitBranchShortFlag(optionArgs, GIT_BRANCH_LIST_SHORT_FLAGS)
  ) {
    return 'read_only'
  }
  const positionalArgs = args.filter(
    (token, index) =>
      (optionTerminator >= 0 && index > optionTerminator) ||
      (token !== '--' && !token.startsWith('-')),
  )
  return positionalArgs.length === 0 ? 'read_only' : 'local_mutation'
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some(
    (token) => flags.includes(token) || flags.some((flag) => token.startsWith(`${flag}=`)),
  )
}

function hasShortFlag(args: string[], letters: string): boolean {
  return args.some((token) => {
    if (!/^-[^-]+$/.test(token)) {
      return false
    }
    return [...token.slice(1)].some((flag) => letters.includes(flag))
  })
}

function isDryRunClean(args: string[]): boolean {
  return hasFlag(args, '-n', '--dry-run', '--dry-run=')
}

function isHardReset(args: string[]): boolean {
  return hasFlag(args, '--hard')
}

function isCreateBranchCheckout(args: string[]): boolean {
  return hasShortFlag(args, 'b') || hasFlag(args, '-b', '--branch')
}

function extractMessageSkippedIndices(args: string[]): Set<number> {
  const skipped = new Set<number>()
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token) {
      continue
    }
    if (token === '-m' || token === '--message' || token === '-F' || token === '--file') {
      skipped.add(index)
      if (args[index + 1]) {
        skipped.add(index + 1)
        index += 1
      }
      continue
    }
    if (token.startsWith('-m') && token.length > 2) {
      skipped.add(index)
    }
    if (token.startsWith('--message=')) {
      skipped.add(index)
    }
    if (token.startsWith('--set-upstream-to=')) {
      skipped.add(index)
    }
    if (token === '--set-upstream-to' && args[index + 1]) {
      skipped.add(index)
      skipped.add(index + 1)
      index += 1
    }
  }
  return skipped
}

function looksLikeFileOperand(token: string): boolean {
  if (!token || token === '--' || token.startsWith('-')) {
    return false
  }
  if (token.includes('/') || token.includes('\\')) {
    return true
  }
  if (token.startsWith('.')) {
    return true
  }
  return token.includes('.')
}

function looksLikeDiffPathOperand(token: string): boolean {
  if (!looksLikeFileOperand(token)) {
    return false
  }
  if (token.startsWith('.') || path.isAbsolute(token)) {
    return true
  }
  return token.includes('.')
}

function resolveGitWorkTree(
  baseCwd: string,
  effectiveCwd: string | undefined,
  workTree: string | undefined,
  gitDir: string | undefined,
): string | undefined {
  const resolveBase = effectiveCwd ?? baseCwd
  if (workTree) {
    return path.resolve(resolveBase, workTree)
  }
  if (gitDir) {
    const resolvedGitDir = path.resolve(resolveBase, gitDir)
    if (path.basename(resolvedGitDir) === '.git') {
      return path.dirname(resolvedGitDir)
    }
  }
  return undefined
}

function extractGitFileOperands(subcommand: string, args: string[]): string[] {
  const baseSubcommand = subcommand.split(' ')[0] ?? subcommand
  if (
    !FILE_OPERAND_SUBCOMMANDS.has(baseSubcommand) &&
    subcommand !== 'checkout' &&
    subcommand !== 'restore'
  ) {
    return []
  }

  const redirects = extractRedirectTargets(['git', baseSubcommand, ...args])
  const skipped = extractMessageSkippedIndices(args)
  const optionTerminator = args.indexOf('--')
  const operands: string[] = [...redirects]

  if (REF_ONLY_WITHOUT_TERMINATOR.has(subcommand) && optionTerminator < 0) {
    return operands
  }

  for (let index = 0; index < args.length; index += 1) {
    if (skipped.has(index)) {
      continue
    }
    const token = args[index]
    if (!token || token.startsWith('-') || token === '--') {
      continue
    }
    if (optionTerminator >= 0 && index < optionTerminator) {
      continue
    }
    if (
      subcommand === 'branch' ||
      subcommand === 'push' ||
      subcommand === 'fetch' ||
      subcommand === 'pull'
    ) {
      continue
    }
    if (baseSubcommand === 'diff' && optionTerminator < 0) {
      if (looksLikeDiffPathOperand(token)) {
        operands.push(token)
      }
      continue
    }
    if (looksLikeFileOperand(token) || baseSubcommand === 'add' || baseSubcommand === 'rm') {
      operands.push(token)
    }
  }

  return operands
}

function classifyDestructiveGit(
  subcommand: string,
  args: string[],
): { reason: string; signals: string[] } | null {
  if (subcommand === 'reset' && isHardReset(args)) {
    return {
      reason: 'git_history_destructive',
      signals: ['git_history_destructive', 'git.reset.hard'],
    }
  }
  if (subcommand === 'clean' && !isDryRunClean(args)) {
    return { reason: 'git_history_destructive', signals: ['git_history_destructive', 'git.clean'] }
  }
  if (subcommand === 'stash clear') {
    return {
      reason: 'git_history_destructive',
      signals: ['git_history_destructive', 'git.stash.clear'],
    }
  }
  if (subcommand === 'worktree remove' && hasFlag(args, '--force')) {
    return {
      reason: 'git_history_destructive',
      signals: ['git_history_destructive', 'git.worktree.remove.force'],
    }
  }
  if (subcommand === 'restore' && hasFlag(args, '--worktree', '-W')) {
    return {
      reason: 'git_history_destructive',
      signals: ['git_history_destructive', 'git.restore.worktree'],
    }
  }
  return null
}

export function isGitReadOnlyInvocation(tokens: string[], baseCwd: string): boolean {
  const semantics = classifyGitCommand(tokens, baseCwd)
  return semantics?.isReadOnly === true
}

export function classifyGitCommand(tokens: string[], baseCwd: string): GitCommandSemantics | null {
  const normalized = normalizeGitInvocation(tokens, baseCwd)
  if (!normalized) {
    return null
  }

  const { subcommand, args, effectiveCwd, gitDir, workTree } = normalized
  const normalizedKey = `git ${subcommand}`
  const gitWorkTree = resolveGitWorkTree(baseCwd, effectiveCwd, workTree, gitDir)
  const pathTargets = extractGitFileOperands(subcommand, args)
  const signals: string[] = [`git.${subcommand.replaceAll(' ', '.')}`]

  const destructive = classifyDestructiveGit(subcommand, args)
  if (destructive) {
    return {
      effect: 'local_mutation',
      pathTargets,
      signals: [...signals, ...destructive.signals],
      requiresAsk: destructive,
      effectiveCwd,
      gitWorkTree,
      normalizedKey,
      isReadOnly: false,
    }
  }

  if (subcommand === 'push') {
    return {
      effect: 'remote_mutation',
      pathTargets,
      signals: [...signals, 'git.push'],
      effectiveCwd,
      gitWorkTree,
      normalizedKey,
      isReadOnly: false,
    }
  }

  if (REMOTE_SUBCOMMANDS.has(subcommand)) {
    return {
      effect: 'remote_mutation',
      pathTargets: [],
      signals: [...signals, 'git.remote'],
      egressClass: 'ambiguous',
      effectiveCwd,
      gitWorkTree,
      normalizedKey,
      isReadOnly: false,
    }
  }

  if (subcommand === 'branch') {
    const effect = gitBranchEffect(args)
    return {
      effect,
      pathTargets: [],
      signals,
      effectiveCwd,
      gitWorkTree,
      normalizedKey,
      isReadOnly: effect === 'read_only',
    }
  }

  if (subcommand === 'checkout') {
    const effect = isCreateBranchCheckout(args) ? 'local_mutation' : 'read_only'
    return {
      effect,
      pathTargets: effect === 'read_only' ? pathTargets : [],
      signals,
      effectiveCwd,
      gitWorkTree,
      normalizedKey,
      isReadOnly: effect === 'read_only',
    }
  }

  if (subcommand === 'clean' && isDryRunClean(args)) {
    return {
      effect: 'read_only',
      pathTargets: [],
      signals,
      effectiveCwd,
      gitWorkTree,
      normalizedKey,
      isReadOnly: true,
    }
  }

  if (subcommand === 'reset' && !isHardReset(args)) {
    return {
      effect: 'local_mutation',
      pathTargets: [],
      signals,
      effectiveCwd,
      gitWorkTree,
      normalizedKey,
      isReadOnly: false,
    }
  }

  if (subcommand === 'tag' && hasFlag(args, '--list', '-l')) {
    return {
      effect: 'read_only',
      pathTargets: [],
      signals,
      effectiveCwd,
      gitWorkTree,
      normalizedKey,
      isReadOnly: true,
    }
  }

  if (READ_ONLY_SUBCOMMANDS.has(subcommand) || READ_ONLY_COMPOUND_SUBCOMMANDS.has(subcommand)) {
    return {
      effect: 'read_only',
      pathTargets: subcommand === 'show' || subcommand === 'diff' ? pathTargets : [],
      signals,
      effectiveCwd,
      gitWorkTree,
      normalizedKey,
      isReadOnly: true,
    }
  }

  if (
    LOCAL_MUTATION_SUBCOMMANDS.has(subcommand) ||
    LOCAL_MUTATION_COMPOUND_SUBCOMMANDS.has(subcommand)
  ) {
    return {
      effect: 'local_mutation',
      pathTargets: subcommand === 'commit' ? [] : pathTargets,
      signals,
      effectiveCwd,
      gitWorkTree,
      normalizedKey,
      isReadOnly: false,
    }
  }

  return {
    effect: 'unknown',
    pathTargets,
    signals,
    effectiveCwd,
    gitWorkTree,
    normalizedKey,
    isReadOnly: false,
  }
}
