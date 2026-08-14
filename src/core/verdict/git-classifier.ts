import path from 'node:path'

import type { ShellEffectRequirement } from '../effect-ir/shell-build.js'
import { parseNetworkEndpoint } from '../network-endpoint.js'
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
  scopeTargets: string[]
  signals: string[]
  egressClass?: 'read' | 'destructive' | 'ambiguous'
  requiresAsk?: { reason: string; signals: string[] }
  effectiveCwd?: string
  gitWorkTree?: string
  normalizedKey: string
  isReadOnly: boolean
}

export interface DecodeGitEffectsParams {
  tokens: string[]
  cwd: string
  repoRoot: string
  segment: string
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

function isDryRunClean(args: string[]): boolean {
  return hasFlag(args, '-n', '--dry-run', '--dry-run=')
}

function isHardReset(args: string[]): boolean {
  return hasFlag(args, '--hard')
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
  const effectiveGitDir = gitDir ? path.resolve(effectiveCwd ?? baseCwd, gitDir) : undefined
  const scopeTargets = [effectiveCwd, gitWorkTree, effectiveGitDir].filter(
    (target, index, targets): target is string =>
      Boolean(target) && targets.indexOf(target) === index,
  )
  const pathTargets = extractGitFileOperands(subcommand, args)
  const signals: string[] = [`git.${subcommand.replaceAll(' ', '.')}`]

  const destructive = classifyDestructiveGit(subcommand, args)
  if (destructive) {
    return {
      effect: 'local_mutation',
      pathTargets,
      scopeTargets,
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
      scopeTargets,
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
      scopeTargets,
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
      scopeTargets,
      signals,
      effectiveCwd,
      gitWorkTree,
      normalizedKey,
      isReadOnly: effect === 'read_only',
    }
  }

  if (subcommand === 'checkout') {
    return {
      effect: 'local_mutation',
      pathTargets,
      scopeTargets,
      signals,
      effectiveCwd,
      gitWorkTree,
      normalizedKey,
      isReadOnly: false,
    }
  }

  if (subcommand === 'clean' && isDryRunClean(args)) {
    return {
      effect: 'read_only',
      pathTargets: [],
      scopeTargets,
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
      scopeTargets,
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
      scopeTargets,
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
      scopeTargets,
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
      scopeTargets,
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
    scopeTargets,
    signals,
    effectiveCwd,
    gitWorkTree,
    normalizedKey,
    isReadOnly: false,
  }
}

/**
 * Decode git CLI grammar to typed effects without making an authorization
 * decision. Legacy classification remains separate until the authority cutover.
 */
export function decodeGitEffects(params: DecodeGitEffectsParams): ShellEffectRequirement[] | null {
  const normalized = normalizeGitInvocation(params.tokens, params.cwd)
  if (!normalized) {
    return null
  }

  const { subcommand, args } = normalized
  const signals = [
    `git.${subcommand.replaceAll(' ', '.')}`,
    ...(subcommand === 'push' ? ['tier0_external'] : []),
  ]
  const effectiveCwd = normalized.effectiveCwd ?? params.cwd
  const workTreeRoot = normalized.workTree
    ? path.resolve(normalized.effectiveCwd ?? params.cwd, normalized.workTree)
    : (normalized.effectiveCwd ?? params.repoRoot)
  const gitRefRoot = normalized.gitDir
    ? path.resolve(effectiveCwd, normalized.gitDir)
    : workTreeRoot
  const gitControlRoot = normalized.gitDir ? gitRefRoot : path.join(gitRefRoot, '.git')
  const requirements: ShellEffectRequirement[] = []

  if (subcommand === 'fetch' || subcommand === 'pull') {
    const positionals = gitRemotePositionals(args)
    if (subcommand === 'fetch' && args.includes('--all')) {
      return [
        gitRequirement(
          'network.connect',
          'network.connect',
          {
            kind: 'network',
            host: 'unknown',
            protocol: 'git-remote',
            mode: 'read',
            payload: 'none',
          },
          params.segment,
          [...signals, 'git.fetch_all_remotes_unknown'],
        ),
        gitRequirement(
          'git.ref.write',
          'git.ref.write',
          { kind: 'git-ref', ref: 'refs/remotes/*', scope: 'local', repoPath: gitRefRoot },
          params.segment,
          [...signals, 'git.ref.local'],
        ),
        gitRequirement('indeterminate', 'indeterminate', { kind: 'unknown' }, params.segment, [
          ...signals,
          'git.fetch_all_remotes_unknown',
        ]),
      ]
    }
    const multiple = subcommand === 'fetch' && args.includes('--multiple')
    const remoteTokens = multiple ? positionals : [positionals[0]]
    for (const remoteToken of remoteTokens) {
      const remote = gitRemoteResource(remoteToken)
      requirements.push(
        gitRequirement(
          'network.connect',
          'network.connect',
          {
            kind: 'network',
            ...remote.endpoint,
            mode: 'read',
            payload: 'none',
          },
          params.segment,
          [...signals, 'git.network.read'],
        ),
        gitRequirement(
          'git.ref.write',
          'git.ref.write',
          {
            kind: 'git-ref',
            ref: remote.ref ? `refs/remotes/${remote.ref}/*` : 'refs/remotes/*',
            scope: 'local',
            repoPath: gitRefRoot,
          },
          params.segment,
          [...signals, 'git.ref.local'],
        ),
      )
    }
    const hazardousFetchSignals = gitFetchControlSignals(params.tokens, args, remoteTokens)
    if (hazardousFetchSignals.length > 0) {
      requirements.push(
        gitRequirement('indeterminate', 'indeterminate', { kind: 'unknown' }, params.segment, [
          ...signals,
          ...hazardousFetchSignals,
        ]),
      )
    }
    if (multiple && positionals.length === 0) {
      requirements.push(
        gitRequirement('indeterminate', 'indeterminate', { kind: 'unknown' }, params.segment, [
          ...signals,
          'git.fetch_multiple_remote_missing',
        ]),
      )
    }
    if (subcommand === 'pull') {
      requirements.push(
        gitRequirement(
          'fs.write',
          'fs.write',
          { kind: 'path', path: workTreeRoot },
          params.segment,
          [...signals, 'git.worktree.update'],
        ),
      )
    }
    return requirements
  }

  if (subcommand === 'push') {
    const positionals = gitRemotePositionals(args)
    const repositoryOption = gitOptionValue(args, '--repo')
    const remote = gitRemoteResource(repositoryOption.value ?? positionals[0])
    const refs = repositoryOption.value ? positionals : positionals.slice(1)
    const lowered = [
      gitRequirement(
        'network.connect',
        'network.connect',
        {
          kind: 'network',
          ...remote.endpoint,
          mode: 'mutate',
          payload: 'present',
        },
        params.segment,
        [...signals, 'git.network.mutate'],
      ),
    ]
    for (const ref of refs.length > 0 ? refs : ['*']) {
      lowered.push(
        gitRequirement(
          'git.ref.write',
          'git.ref.write',
          {
            kind: 'git-ref',
            ref: ref.startsWith('refs/') ? ref : `refs/heads/${ref}`,
            scope: 'remote',
          },
          params.segment,
          [...signals, 'git.ref.remote'],
        ),
      )
    }
    if (repositoryOption.missing) {
      lowered.push(
        gitRequirement('indeterminate', 'indeterminate', { kind: 'unknown' }, params.segment, [
          ...signals,
          'git.push_repository_missing',
        ]),
      )
    }
    return lowered
  }

  if (subcommand === 'reflog') {
    const operation = args[0]
    const mutationFlags = [
      '--expire',
      '--expire-unreachable',
      '--rewrite',
      '--stale-fix',
      '--updateref',
    ]
    const mutating =
      operation === 'expire' ||
      operation === 'delete' ||
      operation === 'drop' ||
      args.some((arg) => mutationFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
    if (mutating) {
      return [
        gitRequirement(
          'process.exec',
          'process.exec',
          { kind: 'executable', command: 'git', operation: 'spawn' },
          params.segment,
          [...signals, 'git_history_destructive', 'git.reflog.mutate'],
        ),
        gitRequirement(
          'control_plane.write',
          'control_plane.write',
          { kind: 'path', path: path.join(gitControlRoot, 'logs') },
          params.segment,
          [...signals, 'git_history_destructive', 'git.reflog.mutate'],
        ),
      ]
    }
    if (isReadOnlyReflogInvocation(args)) {
      return [
        gitRequirement(
          'process.exec',
          'process.exec',
          { kind: 'executable', command: 'git', operation: 'inspect' },
          params.segment,
          [...signals, 'git.inspect'],
        ),
        gitRequirement('fs.read', 'fs.read', { kind: 'path', path: workTreeRoot }, params.segment, [
          ...signals,
          'git.repository.read',
        ]),
      ]
    }
    return [
      gitRequirement(
        'process.exec',
        'process.exec',
        { kind: 'executable', command: 'git', operation: 'spawn' },
        params.segment,
        signals,
      ),
      gitRequirement('indeterminate', 'indeterminate', { kind: 'unknown' }, params.segment, [
        ...signals,
        'git.reflog.grammar_incomplete',
      ]),
    ]
  }

  const semantics = classifyGitCommand(params.tokens, params.cwd)
  if (!semantics) {
    return null
  }
  if (semantics.isReadOnly) {
    requirements.push(
      gitRequirement(
        'process.exec',
        'process.exec',
        { kind: 'executable', command: 'git', operation: 'inspect' },
        params.segment,
        [...signals, 'git.inspect'],
      ),
      gitRequirement('fs.read', 'fs.read', { kind: 'path', path: workTreeRoot }, params.segment, [
        ...signals,
        'git.repository.read',
      ]),
    )
    for (const operand of semantics.pathTargets) {
      requirements.push(
        gitRequirement(
          'fs.read',
          'fs.read',
          { kind: 'path', path: path.resolve(workTreeRoot, operand) },
          params.segment,
          [...signals, 'git.path.read'],
        ),
      )
    }
    return requirements
  }

  if (semantics.effect === 'local_mutation') {
    requirements.push(
      gitRequirement(
        'process.exec',
        'process.exec',
        { kind: 'executable', command: 'git', operation: 'spawn' },
        params.segment,
        signals,
      ),
      gitRequirement(
        'git.ref.write',
        'git.ref.write',
        {
          kind: 'git-ref',
          ref: localGitRef(subcommand, args),
          scope: 'local',
          repoPath: gitRefRoot,
        },
        params.segment,
        [...signals, 'git.ref.local'],
      ),
    )
    for (const operand of semantics.pathTargets) {
      requirements.push(
        gitRequirement(
          'fs.write',
          'fs.write',
          { kind: 'path', path: path.resolve(workTreeRoot, operand) },
          params.segment,
          [...signals, 'git.path.write'],
        ),
      )
    }
    if (semantics.requiresAsk) {
      requirements.push(
        gitRequirement(
          'fs.write',
          'fs.write',
          { kind: 'path', path: workTreeRoot },
          params.segment,
          [...signals, ...semantics.requiresAsk.signals, 'git.destructive_worktree_write'],
        ),
        gitRequirement(
          'control_plane.write',
          'control_plane.write',
          { kind: 'path', path: gitControlRoot },
          params.segment,
          [...signals, ...semantics.requiresAsk.signals, 'git.destructive_history_write'],
        ),
      )
    }
    return requirements
  }

  return [
    gitRequirement(
      'process.exec',
      'process.exec',
      { kind: 'executable', command: 'git', operation: 'spawn' },
      params.segment,
      signals,
    ),
    gitRequirement('indeterminate', 'indeterminate', { kind: 'unknown' }, params.segment, [
      ...signals,
      'git.grammar_incomplete',
    ]),
  ]
}

function isReadOnlyReflogInvocation(args: string[]): boolean {
  if (args[0] === 'exists') {
    return args.length === 2 && Boolean(args[1]) && !(args[1] ?? '').startsWith('-')
  }
  let index = args[0] === 'show' || args[0] === 'list' ? 1 : 0
  let positionalCount = 0
  while (index < args.length) {
    const arg = args[index] ?? ''
    if (arg === '--all' || /^-\d+$/.test(arg)) {
      index += 1
      continue
    }
    if (arg === '-n' || arg === '--max-count') {
      const count = args[index + 1]
      if (!count || !/^\d+$/.test(count)) {
        return false
      }
      index += 2
      continue
    }
    if (/^-n\d+$/.test(arg) || /^--(?:max-count|date|format|pretty)=.+/.test(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith('-')) {
      return false
    }
    positionalCount += 1
    if (args[0] !== 'show' && args[0] !== 'list') {
      return false
    }
    if (positionalCount > 1) {
      return false
    }
    index += 1
  }
  return true
}

const GIT_REMOTE_OPTIONS_WITH_VALUES = new Set([
  '--depth',
  '--exec',
  '--filter',
  '--jobs',
  '--negotiation-tip',
  '--push-option',
  '--repo',
  '--receive-pack',
  '--recurse-submodules',
  '--server-option',
  '--shallow-exclude',
  '--shallow-since',
  '--upload-pack',
  '-j',
  '-o',
])

function gitFetchControlSignals(
  tokens: string[],
  args: string[],
  remoteTokens: Array<string | undefined>,
): string[] {
  const signals: string[] = []
  if (
    tokens.some(
      (token) =>
        token === '-c' ||
        (token.startsWith('-c') && token.length > 2) ||
        token === '--config-env' ||
        token.startsWith('--config-env=') ||
        token === '--exec-path' ||
        token.startsWith('--exec-path='),
    )
  ) {
    signals.push('git.fetch.global_execution_override')
  }
  if (
    args.some((arg) =>
      ['--exec', '--server-option', '--upload-pack'].some(
        (option) => arg === option || arg.startsWith(`${option}=`),
      ),
    )
  ) {
    signals.push('git.fetch.caller_controlled_execution_or_payload')
  }
  if (remoteTokens.some((remote) => remote?.startsWith('ext::'))) {
    signals.push('git.fetch.external_remote_helper')
  }
  return signals
}

function gitOptionValue(args: string[], option: string): { value?: string; missing: boolean } {
  const exactIndex = args.indexOf(option)
  if (exactIndex >= 0) {
    const value = args[exactIndex + 1]
    return value && !value.startsWith('-') ? { value, missing: false } : { missing: true }
  }
  const prefix = `${option}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  if (inline !== undefined) {
    const value = inline.slice(prefix.length)
    return value ? { value, missing: false } : { missing: true }
  }
  return { missing: false }
}

function gitRemotePositionals(args: string[]): string[] {
  const positionals: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '--') {
      positionals.push(...args.slice(index + 1))
      break
    }
    if (arg.startsWith('-')) {
      if (GIT_REMOTE_OPTIONS_WITH_VALUES.has(arg) && !arg.includes('=')) {
        index += args[index + 1] ? 1 : 0
      }
      continue
    }
    positionals.push(arg)
  }
  return positionals
}

function gitRemoteResource(remoteToken: string | undefined): {
  endpoint: { host: string; protocol: string; port?: number }
  ref?: string
} {
  const token = remoteToken && !remoteToken.startsWith('-') ? remoteToken : undefined
  const endpoint = token
    ? parseNetworkEndpoint(token, { allowHostedGitShorthand: true, allowScpStyle: true })
    : null
  if (endpoint) {
    return { endpoint }
  }
  const ref = token && !token.includes('/') ? token : undefined
  return {
    endpoint: { host: ref ?? 'origin', protocol: 'git-remote' },
    ...(ref ? { ref } : {}),
  }
}

function localGitRef(subcommand: string, args: string[]): string {
  if (subcommand === 'branch') {
    const name = args.find((arg) => arg && !arg.startsWith('-'))
    return name ? `refs/heads/${name}` : 'refs/heads/*'
  }
  if (subcommand === 'tag') {
    const name = args.find((arg) => arg && !arg.startsWith('-'))
    return name ? `refs/tags/${name}` : 'refs/tags/*'
  }
  return 'refs/local/*'
}

function gitRequirement(
  tag: ShellEffectRequirement['tag'],
  action: ShellEffectRequirement['action'],
  resource: ShellEffectRequirement['resource'],
  segment: string,
  signals: string[],
): ShellEffectRequirement {
  return {
    tag,
    action,
    resource,
    evidence: {
      level: tag === 'indeterminate' ? 'indeterminate' : 'certain',
      signals: [...new Set(signals)].sort(),
      basis: ['git_grammar'],
    },
    provenance: { segment },
  }
}
