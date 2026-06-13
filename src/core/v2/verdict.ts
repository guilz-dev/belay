import path from 'node:path'
import { relativeWithinRepo } from '../path-utils.js'
import { extractRedirectTargets, tokenizeShell } from '../shell-tokenizer.js'
import { analyzePathTargets, cwdRelative } from './containment.js'
import { classifyEgressTool } from './egress-classify.js'
import { verdictFingerprint } from './fingerprint.js'
import type { TracedTier1Judge } from './judge.js'
import { prescanInterpreterCode, tier1RequiresAsk } from './judge.js'
import { isRoutineLauncher, resolveLauncherRecipe } from './launcher-resolve.js'
import {
  allowFromCustomOverride,
  askFromCustomExternal,
  customAllowMatch,
  customExternalMatch,
} from './overrides.js'
import {
  extractRecursiveScript,
  isBareInterpreter,
  isVariableIndirectHead,
  parseSegment,
  peelTransparentWrappers,
  redactCommand,
  segmentOpacity,
  splitTopLevelSegments,
  substitutionInners,
} from './parser.js'
import type {
  InternalSegmentVerdict,
  JudgeTrace,
  VerdictContext,
  VerdictEffect,
  VerdictLocation,
  VerdictPermission,
  VerdictResult,
} from './types.js'

const DEFAULT_MAX_DEPTH = 8

const TIER0_EXTERNAL_KEYS = new Set([
  'git push',
  'docker push',
  'docker run',
  'npm publish',
  'pnpm publish',
  'terraform apply',
  'firebase',
  'fly',
  'supabase',
  'scp',
  'ssh',
  'rsync',
])

const TIER0_EXTERNAL_HEADS = new Set([
  'dropdb',
  'createdb',
  'psql',
  'mysql',
  'mongosh',
  'redis-cli',
])

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

const LOCAL_MUTATION_KEYS = new Set([
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
  'sed',
  'tee',
  'touch',
  'truncate',
])

/** Routine local build/test runners resolved from launcher recipes. */
const LOCAL_ROUTINE_HEADS = new Set([
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
])

const FIND_DANGEROUS_FLAGS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir'])

function isFindDangerous(tokens: string[]): boolean {
  return tokens.some(
    (token) =>
      FIND_DANGEROUS_FLAGS.has(token) || token.startsWith('-exec') || token.startsWith('-ok'),
  )
}

function worsePermission(left: VerdictPermission, right: VerdictPermission): VerdictPermission {
  return left === 'ask' || right === 'ask' ? 'ask' : 'allow'
}

async function evaluateSubstitutions(
  command: string,
  context: VerdictContext,
  depth: number,
): Promise<InternalSegmentVerdict | null> {
  const inners = substitutionInners(command)
  if (inners.length === 0) {
    return null
  }

  if (context.unknownLocalEffect === 'deny') {
    return askVerdict({
      location: 'unknown',
      opacity: 'recursive',
      effect: 'unknown',
      confidence: 'deterministic',
      reason: 'command_substitution',
      signals: ['command_substitution'],
    })
  }

  let worst: InternalSegmentVerdict | null = null
  for (const inner of inners) {
    const innerVerdict = await evaluateSegment(inner, context, depth + 1)
    if (innerVerdict.permission === 'ask') {
      return askVerdict({
        ...innerVerdict,
        opacity: 'recursive',
        reason: 'command_substitution',
        signals: [...innerVerdict.signals, 'command_substitution'],
      })
    }
    worst = worst ? combineInternal(worst, innerVerdict) : innerVerdict
  }

  if (!worst) {
    return null
  }

  return {
    ...worst,
    permission: 'allow',
    opacity: 'recursive',
    reason: 'command_substitution',
    signals: [...worst.signals, 'command_substitution'],
  }
}

function mergeLocation(left: VerdictLocation, right: VerdictLocation): VerdictLocation {
  if (left === right) {
    return left
  }
  if (left === 'unknown' || right === 'unknown') {
    return 'unknown'
  }
  if (left === 'mixed' || right === 'mixed') {
    return 'mixed'
  }
  return 'mixed'
}

function combineInternal(
  left: InternalSegmentVerdict,
  right: InternalSegmentVerdict,
): InternalSegmentVerdict {
  return {
    permission: worsePermission(left.permission, right.permission),
    location: mergeLocation(left.location, right.location),
    opacity:
      left.opacity === 'unparseable' || right.opacity === 'unparseable'
        ? 'unparseable'
        : left.opacity === 'opaque' || right.opacity === 'opaque'
          ? 'opaque'
          : left.opacity === 'recursive' || right.opacity === 'recursive'
            ? 'recursive'
            : 'transparent',
    effect:
      left.effect === 'remote_mutation' || right.effect === 'remote_mutation'
        ? 'remote_mutation'
        : left.effect === 'unknown' || right.effect === 'unknown'
          ? 'unknown'
          : left.effect === 'local_mutation' || right.effect === 'local_mutation'
            ? 'local_mutation'
            : 'read_only',
    confidence:
      left.confidence === 'deterministic' || right.confidence === 'deterministic'
        ? 'deterministic'
        : left.confidence,
    reason:
      worsePermission(left.permission, right.permission) === 'ask'
        ? right.permission === 'ask'
          ? right.reason
          : left.reason
        : right.reason,
    signals: [...new Set([...left.signals, ...right.signals])],
    judgeTrace: right.judgeTrace ?? left.judgeTrace,
  }
}

function askVerdict(params: Omit<InternalSegmentVerdict, 'permission'>): InternalSegmentVerdict {
  return { ...params, permission: 'ask' }
}

function allowVerdict(params: Omit<InternalSegmentVerdict, 'permission'>): InternalSegmentVerdict {
  return { ...params, permission: 'allow' }
}

function withJudgeTrace(
  verdict: InternalSegmentVerdict,
  judgeTrace?: JudgeTrace,
): InternalSegmentVerdict {
  if (!judgeTrace) {
    return verdict
  }
  return { ...verdict, judgeTrace }
}

function extractPathArgs(tokens: string[]): string[] {
  const redirects = extractRedirectTargets(tokens)
  const args: string[] = [...redirects]
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.startsWith('-') || token === '>' || token === '>>' || token === '<') {
      continue
    }
    if (redirects.includes(token)) {
      continue
    }
    args.push(token)
  }
  return args
}

function tier0ExternalMatch(key: string, head: string, tokens: string[]): boolean {
  if (TIER0_EXTERNAL_KEYS.has(key)) {
    return true
  }
  if (TIER0_EXTERNAL_HEADS.has(head)) {
    return true
  }
  if (head === 'npm' && tokens[1] === 'publish') {
    return true
  }
  if (
    head === 'docker' &&
    (tokens[1] === 'push' ||
      tokens.some((t) => t === '--push' || t.startsWith('--output=type=registry')))
  ) {
    return true
  }
  if (head === 'git' && tokens[1] === 'push') {
    return true
  }
  if (head === 'terraform' && tokens[1] === 'apply') {
    return true
  }
  return false
}

function tier0HighStakesRm(
  tokens: string[],
  context: VerdictContext,
): InternalSegmentVerdict | null {
  const head = tokens[0] ?? ''
  if (head !== 'rm') {
    return null
  }
  const targets = extractPathArgs(tokens)
  const analysis = analyzePathTargets({
    targets,
    cwd: context.cwd,
    repoRoot: context.repoRoot,
    trustedCwd: context.trustedCwd,
    sensitivePaths: context.sensitivePaths,
    protectedArtifactRoots: context.protectedArtifactRoots,
  })
  if (!context.trustedCwd || !context.cwd) {
    return askVerdict({
      location: 'unknown',
      opacity: 'transparent',
      effect: 'unknown',
      confidence: 'deterministic',
      reason: 'missing_trusted_cwd',
      signals: ['missing_trusted_cwd', ...analysis.signals],
    })
  }
  if (analysis.isHighStakes) {
    return askVerdict({
      location: analysis.location,
      opacity: 'transparent',
      effect: 'local_mutation',
      confidence: 'deterministic',
      reason: 'high_stakes_path',
      signals: ['high_stakes_path', ...analysis.signals],
    })
  }
  for (const target of targets) {
    if (target === '~' || target.startsWith('~/') || target.startsWith('/')) {
      const resolved = path.resolve(
        target === '~' || target.startsWith('~/') ? (process.env.HOME ?? '/') : context.cwd,
        target,
      )
      const relative = relativeWithinRepo(context.repoRoot, resolved)
      if (relative === null) {
        return askVerdict({
          location: 'repo_outside',
          opacity: 'transparent',
          effect: 'local_mutation',
          confidence: 'deterministic',
          reason: 'repo_outside_mutation',
          signals: ['repo_outside_mutation'],
        })
      }
    }
  }
  return null
}

async function evaluateSegment(
  command: string,
  context: VerdictContext,
  depth: number,
): Promise<InternalSegmentVerdict> {
  const maxDepth = context.maxRecursionDepth ?? DEFAULT_MAX_DEPTH
  if (depth > maxDepth) {
    return askVerdict({
      location: 'unknown',
      opacity: 'opaque',
      effect: 'unknown',
      confidence: 'deterministic',
      reason: 'recursion_depth_exceeded',
      signals: ['recursion_depth_exceeded'],
    })
  }

  const opacity = segmentOpacity(command)
  if (opacity === 'unparseable') {
    if (context.unparseableShell === 'deny') {
      return askVerdict({
        location: 'unknown',
        opacity: 'unparseable',
        effect: 'unknown',
        confidence: 'deterministic',
        reason: 'unparseable_shell',
        signals: ['unparseable_shell'],
      })
    }
    return allowVerdict({
      location: 'unknown',
      opacity: 'unparseable',
      effect: 'unknown',
      confidence: 'deterministic',
      reason: 'unparseable_shell',
      signals: ['unparseable_shell'],
    })
  }

  const substitutionResult = await evaluateSubstitutions(command, context, depth)
  if (substitutionResult) {
    return substitutionResult
  }

  const tokens = tokenizeShell(command)
  const { tokens: peeled, xargsStdinOpaque } = peelTransparentWrappers(tokens)
  if (xargsStdinOpaque || isBareInterpreter(tokens)) {
    return askVerdict({
      location: 'unknown',
      opacity: 'opaque',
      effect: 'unknown',
      confidence: 'deterministic',
      reason: 'opaque_execution',
      signals: ['opaque_execution'],
    })
  }

  const segment = parseSegment(command)
  const allowOverride = customAllowMatch(command, segment, context)
  const externalOverride = customExternalMatch(command, segment, context)
  if (allowOverride && externalOverride) {
    return allowFromCustomOverride(opacity)
  }
  if (externalOverride) {
    return askFromCustomExternal(opacity)
  }
  if (allowOverride && isRoutineLauncher(peeled)) {
    return allowFromCustomOverride(opacity)
  }

  if (isVariableIndirectHead(segment.head)) {
    return askVerdict({
      location: 'unknown',
      opacity: 'opaque',
      effect: 'unknown',
      confidence: 'deterministic',
      reason: 'variable_indirect',
      signals: ['variable_indirect'],
    })
  }

  const recursiveScript = extractRecursiveScript(peeled)
  if (recursiveScript) {
    const prescan = prescanInterpreterCode(recursiveScript)
    if (prescan && tier1RequiresAsk(prescan)) {
      return askVerdict({
        location: 'unknown',
        opacity: 'recursive',
        effect: 'unknown',
        confidence: 'deterministic',
        reason: 'interpreter_secret_prescan',
        signals: ['interpreter_secret_prescan'],
      })
    }
    const innerVerdict = await evaluateSegment(recursiveScript, context, depth + 1)
    const wrapReason =
      segment.head === 'eval'
        ? 'dynamic_shell_evaluation'
        : ['bash', 'sh', 'zsh', 'dash', 'fish'].includes(segment.head)
          ? 'shell_interpreter_script'
          : innerVerdict.reason
    return {
      ...innerVerdict,
      opacity: 'recursive',
      reason: wrapReason,
      signals: [...innerVerdict.signals, 'recursive_wrapper'],
    }
  }

  if (isRoutineLauncher(peeled)) {
    const resolution = resolveLauncherRecipe({
      tokens: peeled,
      cwd: context.cwd,
      repoRoot: context.repoRoot,
      depth,
    })
    if (!resolution) {
      return askVerdict({
        location: 'unknown',
        opacity: 'opaque',
        effect: 'unknown',
        confidence: 'deterministic',
        reason: 'launcher_unresolved',
        signals: ['launcher_unresolved'],
      })
    }
    if (resolution.opaque || resolution.recipes.length === 0) {
      return askVerdict({
        location: 'unknown',
        opacity: 'opaque',
        effect: 'unknown',
        confidence: 'deterministic',
        reason: resolution.reason,
        signals: [resolution.reason],
      })
    }
    let innerVerdict: InternalSegmentVerdict | null = null
    for (const recipe of resolution.recipes) {
      const evaluated = await evaluateSegment(recipe, context, depth + 1)
      innerVerdict = innerVerdict ? combineInternal(innerVerdict, evaluated) : evaluated
    }
    if (!innerVerdict) {
      return askVerdict({
        location: 'unknown',
        opacity: 'opaque',
        effect: 'unknown',
        confidence: 'deterministic',
        reason: resolution.reason,
        signals: [resolution.reason],
      })
    }
    return {
      ...innerVerdict,
      opacity: 'recursive',
      signals: [...innerVerdict.signals, resolution.reason],
    }
  }

  const egressClass = classifyEgressTool(segment.head, peeled)
  if (egressClass === 'destructive') {
    return askVerdict({
      location: 'external',
      opacity: 'transparent',
      effect: 'remote_mutation',
      confidence: 'deterministic',
      reason: 'tier0_external',
      signals: ['tier0_external', segment.head],
    })
  }
  if (egressClass === 'read') {
    return allowVerdict({
      location: 'external',
      opacity: 'transparent',
      effect: 'read_only',
      confidence: 'deterministic',
      reason: 'egress_read',
      signals: ['egress_read', segment.head],
    })
  }

  if (tier0ExternalMatch(segment.key, segment.head, peeled)) {
    return askVerdict({
      location: 'external',
      opacity: 'transparent',
      effect: 'remote_mutation',
      confidence: 'deterministic',
      reason: 'tier0_external',
      signals: ['tier0_external', segment.key],
    })
  }

  const rmVerdict = tier0HighStakesRm(peeled, context)
  if (rmVerdict) {
    return rmVerdict
  }

  if (!context.trustedCwd || !context.cwd) {
    const hasMutation =
      LOCAL_MUTATION_KEYS.has(segment.key) || LOCAL_MUTATION_KEYS.has(segment.head)
    if (hasMutation || opacity === 'opaque') {
      return askVerdict({
        location: 'unknown',
        opacity,
        effect: 'unknown',
        confidence: 'deterministic',
        reason: 'missing_trusted_cwd',
        signals: ['missing_trusted_cwd'],
      })
    }
  }

  let effect: VerdictEffect = 'unknown'
  if (READ_ONLY_KEYS.has(segment.key) || READ_ONLY_KEYS.has(segment.head)) {
    effect = 'read_only'
  } else if (LOCAL_MUTATION_KEYS.has(segment.key) || LOCAL_MUTATION_KEYS.has(segment.head)) {
    effect = 'local_mutation'
  } else if (LOCAL_ROUTINE_HEADS.has(segment.head)) {
    effect = 'local_mutation'
  }

  const pathArgs = extractPathArgs(peeled)
  const pathAnalysis = analyzePathTargets({
    targets: pathArgs,
    cwd: context.cwd,
    repoRoot: context.repoRoot,
    trustedCwd: context.trustedCwd,
    sensitivePaths: context.sensitivePaths,
    protectedArtifactRoots: context.protectedArtifactRoots,
  })

  if (pathAnalysis.isHighStakes) {
    return askVerdict({
      location: pathAnalysis.location,
      opacity: 'transparent',
      effect: 'local_mutation',
      confidence: 'deterministic',
      reason: 'high_stakes_path',
      signals: pathAnalysis.signals,
    })
  }

  if (segment.head === 'find' && isFindDangerous(peeled)) {
    return askVerdict({
      location: pathAnalysis.location === 'unknown' ? 'repo_local' : pathAnalysis.location,
      opacity: 'transparent',
      effect: 'local_mutation',
      confidence: 'deterministic',
      reason: 'find_dangerous_action',
      signals: ['find_dangerous_action'],
    })
  }

  if (pathAnalysis.location === 'repo_outside' || pathAnalysis.location === 'mixed') {
    const outsideEffect: VerdictEffect =
      effect === 'read_only' ? 'read_only' : effect === 'unknown' ? 'local_mutation' : effect
    return askVerdict({
      location: pathAnalysis.location,
      opacity: 'transparent',
      effect: outsideEffect,
      confidence: 'deterministic',
      reason: 'repo_outside_mutation',
      signals: ['repo_outside_mutation', ...pathAnalysis.signals],
    })
  }

  if (
    pathAnalysis.location === 'unknown' &&
    pathArgs.length > 0 &&
    LOCAL_MUTATION_KEYS.has(segment.head)
  ) {
    return askVerdict({
      location: 'unknown',
      opacity: 'transparent',
      effect: 'unknown',
      confidence: 'deterministic',
      reason: 'unknown_location_mutation',
      signals: ['unknown_location_mutation'],
    })
  }

  const needsTier1 =
    effect === 'unknown' || TIER0_EXTERNAL_HEADS.has(segment.head) || egressClass === 'ambiguous'

  let tier1Trace: JudgeTrace | undefined
  if (needsTier1) {
    const tier1Text = recursiveScript ?? command
    const tier1 = await context.judge.evaluate({
      text: tier1Text,
      context: { cwd: context.cwd, repoRoot: context.repoRoot },
      innerCode: recursiveScript ?? undefined,
    })
    tier1Trace = (context.judge as TracedTier1Judge).lastTrace as JudgeTrace | undefined
    if (tier1RequiresAsk(tier1)) {
      return askVerdict({
        location: pathAnalysis.location === 'unknown' ? 'unknown' : 'repo_local',
        opacity,
        effect: tier1.external_change ? 'remote_mutation' : effect,
        confidence: 'llm',
        reason: 'tier1_catastrophic',
        signals: ['tier1_catastrophic', tier1.reason],
        judgeTrace: tier1Trace,
      })
    }
  }

  if (
    pathAnalysis.location === 'repo_local' &&
    (effect === 'read_only' || effect === 'local_mutation') &&
    opacity !== 'opaque'
  ) {
    return withJudgeTrace(
      allowVerdict({
        location: 'repo_local',
        opacity,
        effect,
        confidence: 'assumed_repo_local',
        reason: effect === 'read_only' ? 'read_only' : 'repo_local_mutation',
        signals: effect === 'read_only' ? ['read_only'] : ['repo_local_mutation'],
      }),
      tier1Trace,
    )
  }

  if (effect === 'read_only') {
    return withJudgeTrace(
      allowVerdict({
        location: pathAnalysis.location === 'unknown' ? 'repo_local' : pathAnalysis.location,
        opacity,
        effect: 'read_only',
        confidence: 'assumed_repo_local',
        reason: 'read_only',
        signals: ['read_only'],
      }),
      tier1Trace,
    )
  }

  if (allowOverride) {
    return withJudgeTrace(allowFromCustomOverride(opacity), tier1Trace)
  }

  if (context.unknownLocalEffect === 'allow_flagged') {
    return withJudgeTrace(
      allowVerdict({
        location: pathAnalysis.location === 'unknown' ? 'repo_local' : pathAnalysis.location,
        opacity,
        effect: 'unknown',
        confidence: 'assumed_repo_local',
        reason: 'unknown_local_effect',
        signals: ['unknown_local_effect'],
      }),
      tier1Trace,
    )
  }

  return withJudgeTrace(
    askVerdict({
      location: pathAnalysis.location,
      opacity,
      effect,
      confidence: 'deterministic',
      reason: 'unknown_local_effect',
      signals: ['unknown_local_effect'],
    }),
    tier1Trace,
  )
}

function toVerdictResult(
  internal: InternalSegmentVerdict,
  command: string,
  context: VerdictContext,
): VerdictResult {
  const commandRedacted = redactCommand(command)
  const relative = cwdRelative(context.repoRoot, context.cwd)
  return {
    permission: internal.permission,
    location: internal.location,
    opacity: internal.opacity,
    effect: internal.effect,
    confidence: internal.confidence,
    reason: internal.reason,
    commandRedacted,
    fingerprint: verdictFingerprint(relative, commandRedacted),
    signals: internal.signals,
    judgeTrace: internal.judgeTrace,
  }
}

export async function verdict(command: string, context: VerdictContext): Promise<VerdictResult> {
  const trimmed = command.trim()
  if (!trimmed) {
    return toVerdictResult(
      allowVerdict({
        location: 'repo_local',
        opacity: 'transparent',
        effect: 'read_only',
        confidence: 'deterministic',
        reason: 'empty_command',
        signals: ['empty_command'],
      }),
      trimmed,
      context,
    )
  }

  const segments = splitTopLevelSegments(trimmed)
  let combined: InternalSegmentVerdict | null = null

  for (const segment of segments) {
    const segmentVerdict = await evaluateSegment(segment, context, 0)
    combined = combined ? combineInternal(combined, segmentVerdict) : segmentVerdict
  }

  return toVerdictResult(
    combined ??
      askVerdict({
        location: 'unknown',
        opacity: 'unparseable',
        effect: 'unknown',
        confidence: 'deterministic',
        reason: 'empty_segments',
        signals: ['empty_segments'],
      }),
    trimmed,
    context,
  )
}
