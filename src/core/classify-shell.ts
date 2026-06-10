import { matchesCustomCommand } from './custom-command-match.js'
import { shellFingerprint } from './fingerprint.js'
import {
  hasOutsideRepoPath,
  normalizeToken,
  pathWithinRoot,
  relativeWithinRepo,
  resolveMutationTarget,
} from './path-utils.js'
import { findCommandSubstitutions, MAX_SUBSTITUTION_DEPTH } from './shell-substitution.js'
import {
  commandKey,
  extractRedirectTargets,
  normalizeShellCommand,
  tokenizeShell,
} from './shell-tokenizer.js'
import type { Assessment, ClassifierOptions, ClassifyResult } from './types.js'

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'cd',
  'echo',
  'find',
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
])

const FLAGGED_COMMANDS = new Set([
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

const EXTERNAL_COMMANDS = new Set([
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

const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish'])

const DYNAMIC_SHELL_COMMANDS = new Set(['eval', 'source', 'exec'])

const INTERPRETER_SCRIPT_FLAGS = new Set(['-c', '-lc', '-e', '--eval'])

const EXTERNAL_SCRIPT_TERMS = ['deploy', 'publish', 'release', 'ship', 'prod']

const VERDICT_RANK: Record<string, number> = {
  allow: 0,
  allow_flagged: 1,
  deny_pending_approval: 2,
}

interface SegmentContext {
  tokens: string[]
  separator: 'start' | '&&' | '||' | ';' | '|'
}

function worseVerdict(left: ClassifyResult, right: ClassifyResult): ClassifyResult {
  const leftRank = VERDICT_RANK[left.verdict] ?? 0
  const rightRank = VERDICT_RANK[right.verdict] ?? 0
  if (rightRank > leftRank) {
    return right
  }
  if (rightRank < leftRank) {
    return left
  }
  return right
}

function denyResult(params: {
  reason: string
  normalizedCommand: string
  cwdRelative: string
  assessment: Assessment
}): ClassifyResult {
  return {
    verdict: 'deny_pending_approval',
    reason: params.reason,
    normalizedCommand: params.normalizedCommand,
    fingerprint: shellFingerprint(params.cwdRelative, params.normalizedCommand),
    assessment: params.assessment,
  }
}

function splitSegmentsWithSeparators(tokens: string[]): SegmentContext[] {
  const segments: SegmentContext[] = []
  let current: string[] = []
  let separator: SegmentContext['separator'] = 'start'

  const flush = () => {
    if (current.length > 0) {
      segments.push({ tokens: current, separator })
      current = []
    }
  }

  for (const token of tokens) {
    if (token === '&&' || token === '||' || token === ';' || token === '|') {
      flush()
      separator = token
      continue
    }
    current.push(token)
  }
  flush()
  return segments
}

function isExternalKey(
  key: string,
  normalizedCommand: string,
  options: ClassifierOptions,
): boolean {
  return (
    EXTERNAL_COMMANDS.has(key) ||
    (options.customExternalCommands ?? []).some((pattern) =>
      matchesCustomCommand(normalizedCommand, key, pattern),
    )
  )
}

function matchesCustomAllow(
  normalizedCommand: string,
  key: string,
  options: ClassifierOptions,
): boolean {
  return (options.customAllowCommands ?? []).some((pattern) =>
    matchesCustomCommand(normalizedCommand, key, pattern),
  )
}

function matchesCustomExternal(
  normalizedCommand: string,
  key: string,
  options: ClassifierOptions,
): boolean {
  return (options.customExternalCommands ?? []).some((pattern) =>
    matchesCustomCommand(normalizedCommand, key, pattern),
  )
}

function targetsControlPlane(
  paths: string[],
  cwd: string,
  controlPlaneDir: string | null | undefined,
): boolean {
  if (!controlPlaneDir) {
    return false
  }
  return paths.some((target) => {
    const resolved = resolveMutationTarget(target, cwd)
    if (!resolved) {
      return false
    }
    return pathWithinRoot(controlPlaneDir, resolved)
  })
}

function classifySubstitutionInners(params: {
  command: string
  cwd: string
  repoRoot: string
  options: ClassifierOptions
  depth: number
}): ClassifyResult | null {
  const { command, cwd, repoRoot, options, depth } = params
  if (depth >= MAX_SUBSTITUTION_DEPTH) {
    return null
  }

  const substitutions = findCommandSubstitutions(command)
  if (substitutions.length === 0) {
    return null
  }

  const normalizedCommand = normalizeShellCommand(command, repoRoot, normalizeToken)
  const cwdRelative = relativeWithinRepo(repoRoot, cwd) ?? cwd
  let worst: ClassifyResult | null = null

  for (const substitution of substitutions) {
    const inner = classifyShell(substitution, cwd, repoRoot, options, depth + 1)
    if (options.unknownLocalEffect === 'deny') {
      return denyResult({
        reason: 'command_substitution',
        normalizedCommand,
        cwdRelative,
        assessment: {
          reversibility: 'irreversible',
          external: inner.assessment.external,
          blastRadius: 'command substitution',
          confidence: 0.9,
          signals: ['command_substitution', ...inner.assessment.signals],
        },
      })
    }

    const wrapped = wrapInnerVerdict({
      inner,
      normalizedCommand,
      cwdRelative,
      wrapReason: 'command_substitution',
      wrapSignal: 'command_substitution',
    })
    worst = worst ? worseVerdict(worst, wrapped) : wrapped
  }

  return worst
}

function unknownLocalEffectResult(params: {
  normalizedCommand: string
  cwdRelative: string
  assessment: Assessment
  options: ClassifierOptions
}): ClassifyResult {
  const { normalizedCommand, cwdRelative, assessment, options } = params
  if (options.unknownLocalEffect === 'deny') {
    return denyResult({
      reason: 'unknown_local_effect',
      normalizedCommand,
      cwdRelative,
      assessment,
    })
  }
  return {
    verdict: 'allow_flagged',
    reason: 'unknown_local_effect',
    normalizedCommand,
    fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
    assessment,
  }
}

function extractInterpreterScript(tokens: string[]): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const flag = tokens[index]
    if (INTERPRETER_SCRIPT_FLAGS.has(flag)) {
      return tokens[index + 1] ?? null
    }
  }
  return null
}

function hasInPlaceSedFlag(tokens: string[]): boolean {
  return tokens.some((token) => token === '-i' || token === '--in-place')
}

function wrapInnerVerdict(params: {
  inner: ClassifyResult
  normalizedCommand: string
  cwdRelative: string
  wrapReason: string
  wrapSignal: string
}): ClassifyResult {
  const { inner, normalizedCommand, cwdRelative, wrapReason, wrapSignal } = params
  const signals = [wrapSignal, ...inner.assessment.signals]
  if (inner.verdict === 'deny_pending_approval') {
    return {
      ...inner,
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      reason: wrapReason,
      assessment: {
        ...inner.assessment,
        signals,
      },
    }
  }
  if (inner.verdict === 'allow_flagged') {
    return {
      ...inner,
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      reason: wrapReason,
      assessment: {
        ...inner.assessment,
        signals,
      },
    }
  }
  if (inner.verdict === 'allow') {
    return {
      verdict: 'allow_flagged',
      reason: wrapReason,
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      assessment: {
        reversibility: 'recoverable_with_cost',
        external: inner.assessment.external,
        blastRadius: inner.assessment.blastRadius,
        confidence: Math.min(inner.assessment.confidence, 0.7),
        signals,
      },
    }
  }
  return inner
}

function classifySegment(
  segment: SegmentContext,
  cwd: string,
  repoRoot: string,
  normalizedCommand: string,
  cwdRelative: string,
  options: ClassifierOptions,
  depth: number,
): ClassifyResult {
  const segmentTokens = segment.tokens
  const key = commandKey(segmentTokens)
  const redirects = extractRedirectTargets(segmentTokens)
  const signals: string[] = []

  if (matchesCustomAllow(normalizedCommand, key, options)) {
    return {
      verdict: 'allow',
      reason: 'custom_allow',
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      assessment: {
        reversibility: 'reversible',
        external: false,
        blastRadius: 'this repository',
        confidence: 0.99,
        signals: ['custom_allow_command'],
      },
    }
  }

  if (matchesCustomExternal(normalizedCommand, key, options)) {
    return denyResult({
      reason: 'custom_external',
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: 'irreversible',
        external: true,
        blastRadius: 'custom external command',
        confidence: 0.95,
        signals: ['custom_external_command'],
      },
    })
  }

  if (DYNAMIC_SHELL_COMMANDS.has(key) || (key === '.' && segmentTokens.length > 1)) {
    signals.push('dynamic_shell_evaluation')
    return denyResult({
      reason: 'dynamic_shell_evaluation',
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: 'irreversible',
        external: true,
        blastRadius: 'dynamic shell evaluation',
        confidence: 0.93,
        signals,
      },
    })
  }

  if (targetsControlPlane(redirects, cwd, options.controlPlaneDir)) {
    signals.push('control_plane_redirect')
    return denyResult({
      reason: 'control_plane_mutation',
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: 'irreversible',
        external: false,
        blastRadius: 'agent-belay control plane',
        confidence: 0.97,
        signals,
      },
    })
  }

  if (targetsControlPlane(segmentTokens.slice(1), cwd, options.controlPlaneDir)) {
    signals.push('control_plane_path')
    return denyResult({
      reason: 'control_plane_mutation',
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: 'irreversible',
        external: false,
        blastRadius: 'agent-belay control plane',
        confidence: 0.97,
        signals,
      },
    })
  }

  const hasOutsideRedirect = redirects.some((target) => {
    const resolved = resolveMutationTarget(target, cwd)
    if (!resolved) {
      return false
    }
    return relativeWithinRepo(repoRoot, resolved) === null
  })
  if (hasOutsideRedirect) {
    signals.push('outside_repo_redirect')
    return denyResult({
      reason: 'outside_repo_redirect',
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: 'irreversible',
        external: true,
        blastRadius: 'outside the repository',
        confidence: 0.92,
        signals,
      },
    })
  }

  if (FLAGGED_COMMANDS.has(key) && hasOutsideRepoPath(segmentTokens.slice(1), cwd, repoRoot)) {
    signals.push('outside_repo_mutation')
    return denyResult({
      reason: 'outside_repo_mutation',
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: 'irreversible',
        external: true,
        blastRadius: 'outside the repository',
        confidence: 0.9,
        signals,
      },
    })
  }

  if (segment.separator === '|' && SHELL_INTERPRETERS.has(key)) {
    signals.push('pipe_to_shell')
    return denyResult({
      reason: 'pipe_to_shell',
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: 'irreversible',
        external: true,
        blastRadius: 'shell interpreter via pipe',
        confidence: 0.94,
        signals,
      },
    })
  }

  if (depth < 2) {
    const innerScript = extractInterpreterScript(segmentTokens)
    if (innerScript && (SHELL_INTERPRETERS.has(key) || key === 'node')) {
      const inner = classifyShell(innerScript, cwd, repoRoot, options, depth + 1)
      const wrapReason = key === 'node' ? 'node_eval' : 'shell_interpreter_script'
      const wrapSignal = key === 'node' ? 'node_eval' : 'shell_interpreter_script'
      return wrapInnerVerdict({
        inner,
        normalizedCommand,
        cwdRelative,
        wrapReason,
        wrapSignal,
      })
    }
  }

  if (key === 'sed' && hasInPlaceSedFlag(segmentTokens)) {
    signals.push('sed_in_place')
    return {
      verdict: 'allow_flagged',
      reason: 'local_mutation',
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      assessment: {
        reversibility: 'recoverable_with_cost',
        external: false,
        blastRadius: 'this repository',
        confidence: 0.74,
        signals,
      },
    }
  }

  if ((key === 'npm run' || key === 'pnpm run') && segmentTokens[2]) {
    const scriptName = segmentTokens[2].toLowerCase()
    if (EXTERNAL_SCRIPT_TERMS.some((term) => scriptName.includes(term))) {
      signals.push('external_script_name', scriptName)
      return denyResult({
        reason: 'external_script',
        normalizedCommand,
        cwdRelative,
        assessment: {
          reversibility: 'irreversible',
          external: true,
          blastRadius: `npm script: ${scriptName}`,
          confidence: 0.88,
          signals,
        },
      })
    }
  }

  if (key === 'curl' || key === 'wget') {
    const hasAuthHeader = segmentTokens.some(
      (token) => token === '-H' || token === '--header' || /authorization/i.test(token),
    )
    if (hasAuthHeader) {
      signals.push('credential_header')
      return {
        verdict: 'allow_flagged',
        reason: 'credential_header',
        normalizedCommand,
        fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
        assessment: {
          reversibility: 'recoverable_with_cost',
          external: true,
          blastRadius: 'external request with credentials',
          confidence: 0.75,
          signals,
        },
      }
    }
  }

  if (isExternalKey(key, normalizedCommand, options)) {
    signals.push('external_command', key)
    return denyResult({
      reason: 'external_effect',
      normalizedCommand,
      cwdRelative,
      assessment: {
        reversibility: 'irreversible',
        external: true,
        blastRadius: key === 'git push' ? 'remote origin' : 'external system',
        confidence: 0.92,
        signals,
      },
    })
  }

  if (READ_ONLY_COMMANDS.has(key)) {
    return {
      verdict: 'allow',
      reason: 'read_only',
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      assessment: {
        reversibility: 'reversible',
        external: false,
        blastRadius: 'this repository',
        confidence: 0.95,
        signals: ['read_only_command'],
      },
    }
  }

  if (key === 'node' || key === 'sed') {
    signals.push(key === 'node' ? 'node_execution' : 'sed_execution')
    return unknownLocalEffectResult({
      normalizedCommand,
      cwdRelative,
      options,
      assessment: {
        reversibility: 'recoverable_with_cost',
        external: false,
        blastRadius: 'this repository',
        confidence: 0.64,
        signals,
      },
    })
  }

  if (FLAGGED_COMMANDS.has(key) || redirects.length > 0) {
    signals.push('local_mutation')
    return {
      verdict: 'allow_flagged',
      reason: 'local_mutation',
      normalizedCommand,
      fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
      assessment: {
        reversibility: 'recoverable_with_cost',
        external: false,
        blastRadius: 'this repository',
        confidence: 0.72,
        signals,
      },
    }
  }

  signals.push('unknown_local_effect')
  return unknownLocalEffectResult({
    normalizedCommand,
    cwdRelative,
    options,
    assessment: {
      reversibility: 'recoverable_with_cost',
      external: false,
      blastRadius: 'this repository',
      confidence: 0.61,
      signals,
    },
  })
}

export function classifyShell(
  command: string,
  cwd: string,
  repoRoot: string,
  options: ClassifierOptions = {},
  depth = 0,
): ClassifyResult {
  const substitutionResult = classifySubstitutionInners({
    command,
    cwd,
    repoRoot,
    options,
    depth,
  })
  if (substitutionResult) {
    return substitutionResult
  }

  const tokens = tokenizeShell(command)
  const segments = splitSegmentsWithSeparators(tokens)
  const normalizedCommand = normalizeShellCommand(command, repoRoot, normalizeToken)
  const cwdRelative = relativeWithinRepo(repoRoot, cwd) ?? cwd

  let effective: ClassifyResult = {
    verdict: 'allow',
    reason: 'read_only',
    normalizedCommand,
    fingerprint: shellFingerprint(cwdRelative, normalizedCommand),
    assessment: {
      reversibility: 'reversible',
      external: false,
      blastRadius: 'this repository',
      confidence: 0.95,
      signals: ['read_only'],
    },
  }

  for (let index = 0; index < segments.length; index += 1) {
    const result = classifySegment(
      segments[index],
      cwd,
      repoRoot,
      normalizedCommand,
      cwdRelative,
      options,
      depth,
    )
    effective = worseVerdict(effective, result)
    if (result.verdict === 'deny_pending_approval' && options.strictChains !== true) {
      return result
    }
  }

  return effective
}
