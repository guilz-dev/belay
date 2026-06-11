import { matchesCustomCommand } from './custom-command-match.js'
import {
  hasOutsideRepoPath,
  pathWithinRoot,
  relativeWithinRepo,
  resolveMutationTarget,
} from './path-utils.js'
import type { PolicyMatch, ShellAttributes } from './policy/types.js'
import { commandKey, extractRedirectTargets, tokenizeShell } from './shell-tokenizer.js'
import { detectUnparseableShell } from './shell-unparseable.js'
import type { ClassifierOptions } from './types.js'

const READ_ONLY_KEYS = new Set([
  'cat',
  'cd',
  'echo',
  'git diff',
  'git log',
  'git rev-parse',
  'git show',
  'git status',
  'head',
  'ls',
  'pwd',
  'rg',
  'sort',
  'tail',
  'wc',
  'which',
  'find',
])

const FLAGGED_KEYS = new Set([
  'chmod',
  'cp',
  'git add',
  'git clean',
  'git commit',
  'git mv',
  'git reset',
  'mkdir',
  'mv',
  'rm',
  'tee',
  'touch',
  'truncate',
])

const EXTERNAL_KEYS = new Set([
  'aws',
  'curl',
  'docker push',
  'docker run',
  'firebase deploy',
  'fly deploy',
  'gh',
  'git push',
  'gcloud',
  'heroku',
  'kubectl',
  'netlify',
  'npm publish',
  'pnpm publish',
  'rsync',
  'scp',
  'ssh',
  'supabase',
  'terraform apply',
  'vercel',
  'wget',
])

const DYNAMIC_KEYS = new Set(['eval', 'source', 'exec'])
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish'])
const FIND_DANGEROUS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir'])
const FORCE_FLAGS = new Set(['--force', '-f'])
const EXTERNAL_SCRIPT_TERMS = ['deploy', 'publish', 'release', 'ship', 'prod']

function protectedRoots(options: ClassifierOptions): string[] {
  return [
    ...(options.protectedArtifactRoots ?? []),
    ...(options.controlPlaneDir ? [options.controlPlaneDir] : []),
  ]
}

function hitsProtected(paths: string[], cwd: string, roots: string[]): boolean {
  if (roots.length === 0) {
    return false
  }
  return paths.some((target) => {
    const resolved = resolveMutationTarget(target, cwd)
    if (!resolved) {
      return false
    }
    return roots.some((root) => pathWithinRoot(root, resolved))
  })
}

function redirectKind(
  redirects: string[],
  cwd: string,
  repoRoot: string,
  roots: string[],
): ShellAttributes['redirectKind'] {
  if (redirects.length === 0) {
    return 'none'
  }
  if (hitsProtected(redirects, cwd, roots)) {
    return 'protected'
  }
  const hasOutside = redirects.some((target) => {
    const resolved = resolveMutationTarget(target, cwd)
    return resolved !== null && relativeWithinRepo(repoRoot, resolved) === null
  })
  if (hasOutside) {
    return 'outside'
  }
  const tokens = redirects.join(' ')
  if (tokens.includes('>>')) {
    return 'append'
  }
  if (redirects.length > 0) {
    return 'truncate'
  }
  return 'none'
}

function inferTargetScope(
  segmentTokens: string[],
  cwd: string,
  repoRoot: string,
  key: string,
): ShellAttributes['targetScope'] {
  if (EXTERNAL_KEYS.has(key) || key === 'curl' || key === 'wget') {
    return 'external'
  }
  const paths = segmentTokens.slice(1)
  if (hasOutsideRepoPath(paths, cwd, repoRoot)) {
    return 'outside'
  }
  if (key === 'find' || key === 'chmod' || key === 'rm') {
    const hasRecursive = segmentTokens.some((token) => token === '-R' || token === '-r')
    if (hasRecursive) {
      return 'dir'
    }
  }
  if (FLAGGED_KEYS.has(key)) {
    return 'file'
  }
  if (READ_ONLY_KEYS.has(key)) {
    return 'repo'
  }
  return 'repo'
}

function findDangerousFlags(tokens: string[]): boolean {
  return tokens.some(
    (token) => FIND_DANGEROUS.has(token) || token.startsWith('-exec') || token.startsWith('-ok'),
  )
}

function isExternalKey(
  key: string,
  normalizedCommand: string,
  options: ClassifierOptions,
): boolean {
  if (EXTERNAL_KEYS.has(key)) {
    return true
  }
  if (key === 'git push' && segmentHasForce(normalizedCommand)) {
    return true
  }
  return (options.customExternalCommands ?? []).some((pattern) =>
    matchesCustomCommand(normalizedCommand, key, pattern),
  )
}

function segmentHasForce(command: string): boolean {
  const tokens = tokenizeShell(command)
  return tokens.some((token) => FORCE_FLAGS.has(token))
}

export function analyzeShellSegment(params: {
  segmentTokens: string[]
  cwd: string
  repoRoot: string
  normalizedCommand: string
  cwdRelative: string
  options: ClassifierOptions
  separator?: 'start' | '&&' | '||' | ';' | '|'
  depth?: number
}): ShellAttributes {
  const { segmentTokens, cwd, repoRoot, normalizedCommand, cwdRelative, options, separator } =
    params
  const key = commandKey(segmentTokens)
  const flags = segmentTokens.filter((token) => token.startsWith('-'))
  const redirects = extractRedirectTargets(segmentTokens)
  const roots = protectedRoots(options)
  const redirect = redirectKind(redirects, cwd, repoRoot, roots)
  const signals: string[] = []

  const isUnparseable = detectUnparseableShell(normalizedCommand)
  const isDynamicEval = DYNAMIC_KEYS.has(key) || (key === '.' && segmentTokens.length > 1)
  let hasPipeToShell =
    segmentTokens.includes('|') && segmentTokens.some((token) => SHELL_INTERPRETERS.has(token))
  if (separator === '|' && SHELL_INTERPRETERS.has(key)) {
    hasPipeToShell = true
  }
  const hitsProtectedArtifact =
    hitsProtected(redirects, cwd, roots) || hitsProtected(segmentTokens.slice(1), cwd, roots)
  const hitsOutsideRepo =
    hasOutsideRepoPath(segmentTokens.slice(1), cwd, repoRoot) || redirect === 'outside'
  const hasCredentialHeader = segmentTokens.some(
    (token) => token === '-H' || token === '--header' || /authorization/i.test(token),
  )
  const findDangerous = key === 'find' && findDangerousFlags(segmentTokens)
  const isCustomAllow = (options.customAllowCommands ?? []).some((pattern) =>
    matchesCustomCommand(normalizedCommand, key, pattern),
  )
  const isCustomExternal = (options.customExternalCommands ?? []).some((pattern) =>
    matchesCustomCommand(normalizedCommand, key, pattern),
  )

  if (isUnparseable) {
    signals.push('unparseable_shell')
  }
  if (isDynamicEval) {
    signals.push('dynamic_shell_evaluation')
  }
  if (hasPipeToShell) {
    signals.push('pipe_to_shell')
  }
  if (hitsProtectedArtifact) {
    signals.push('control_plane_path')
  }
  if (hitsOutsideRepo) {
    signals.push('outside_repo_mutation')
  }
  if (hasCredentialHeader) {
    signals.push('credential_header')
  }
  if (findDangerous) {
    signals.push('find_dangerous_action')
  }
  if (key === 'rm' && flags.some((flag) => flag === '-rf' || flag === '-fr')) {
    signals.push('rm_recursive_force')
  }
  if (key === 'git push' && segmentHasForce(normalizedCommand)) {
    signals.push('git_push_force')
  }
  if (key === 'docker run' && flags.includes('--privileged')) {
    signals.push('docker_privileged')
  }
  if (key === 'sed' && flags.some((flag) => flag === '-i' || flag === '--in-place')) {
    signals.push('sed_in_place')
  }
  if ((key === 'npm run' || key === 'pnpm run') && segmentTokens[2]) {
    const scriptName = segmentTokens[2].toLowerCase()
    if (EXTERNAL_SCRIPT_TERMS.some((term) => scriptName.includes(term))) {
      signals.push('external_script_name', scriptName)
    }
  }

  return {
    commandKey: key,
    normalizedCommand,
    cwdRelative,
    flags,
    targetScope: inferTargetScope(segmentTokens, cwd, repoRoot, key),
    redirectKind: redirect,
    signals,
    isUnparseable,
    isDynamicEval,
    hasPipeToShell,
    hitsProtectedArtifact,
    hitsOutsideRepo,
    isCustomAllow,
    isCustomExternal,
    isReadOnlyKey: READ_ONLY_KEYS.has(key),
    isFlaggedKey: FLAGGED_KEYS.has(key),
    isExternalKey: isExternalKey(key, normalizedCommand, options),
    hasCredentialHeader,
    findDangerous,
  }
}

export function matchesPolicyRule(match: PolicyMatch, attributes: ShellAttributes): boolean {
  if (match.signal && !attributes.signals.includes(match.signal)) {
    return false
  }
  if (match.commandKey) {
    const keys = Array.isArray(match.commandKey) ? match.commandKey : [match.commandKey]
    if (!keys.includes(attributes.commandKey)) {
      return false
    }
  }
  if (match.targetScope) {
    const scopes = Array.isArray(match.targetScope) ? match.targetScope : [match.targetScope]
    if (!scopes.includes(attributes.targetScope)) {
      return false
    }
  }
  if (match.redirectKind) {
    const kinds = Array.isArray(match.redirectKind) ? match.redirectKind : [match.redirectKind]
    if (!kinds.includes(attributes.redirectKind)) {
      return false
    }
  }
  if (match.flag) {
    const flags = Array.isArray(match.flag) ? match.flag : [match.flag]
    if (!flags.some((flag) => attributes.flags.includes(flag))) {
      return false
    }
  }
  if (match.customAllow === true && !attributes.isCustomAllow) {
    return false
  }
  if (match.customExternal === true && !attributes.isCustomExternal) {
    return false
  }
  if (match.unparseable === true && !attributes.isUnparseable) {
    return false
  }
  if (match.protectedArtifact === true && !attributes.hitsProtectedArtifact) {
    return false
  }
  if (match.outsideRepo === true && !attributes.hitsOutsideRepo) {
    return false
  }
  return true
}
