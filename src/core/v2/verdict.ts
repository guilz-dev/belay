import path from 'node:path'
import { relativeWithinRepo } from '../path-utils.js'
import { extractRedirectTargets, tokenizeShell } from '../shell-tokenizer.js'
import { analyzePathTargets, cwdRelative, resolveTrustedPath } from './containment.js'
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
  VerdictOpacity,
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

const FIND_DANGEROUS_FLAGS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir'])

interface ChainState {
  cwd: string
  trustedCwd: boolean
}

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
  }

  return null
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

function isVariableOrOpaquePathToken(token: string): boolean {
  return token.includes('$') || token.includes('`')
}

function isLocalMutationHead(key: string, head: string): boolean {
  return LOCAL_MUTATION_KEYS.has(key) || LOCAL_MUTATION_KEYS.has(head)
}

function updateChainState(command: string, state: ChainState): ChainState {
  const segment = parseSegment(command)
  if (segment.head !== 'cd') {
    return state
  }

  if (!state.trustedCwd) {
    return state
  }

  const target = segment.tokens[1] ?? '~'
  if (!target || target === '-' || isVariableOrOpaquePathToken(target)) {
    return { ...state, trustedCwd: false }
  }

  const resolved = resolveTrustedPath(target, state.cwd, state.trustedCwd)
  if (!resolved) {
    return { ...state, trustedCwd: false }
  }

  return {
    cwd: resolved,
    trustedCwd: true,
  }
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

async function evaluateTier1(
  command: string,
  context: VerdictContext,
  params: {
    opacity: VerdictOpacity
    effect: VerdictEffect
    pathAnalysis: ReturnType<typeof analyzePathTargets>
    innerCode?: string
  },
): Promise<InternalSegmentVerdict> {
  const tier1 = await context.judge.evaluate({
    text: command,
    context: { cwd: context.cwd, repoRoot: context.repoRoot },
    innerCode: params.innerCode,
  })
  const tier1Trace = (context.judge as TracedTier1Judge).lastTrace as JudgeTrace | undefined
  const location =
    params.pathAnalysis.location === 'unknown' ? 'unknown' : params.pathAnalysis.location

  if (tier1RequiresAsk(tier1)) {
    return askVerdict({
      location,
      opacity: params.opacity,
      effect: tier1.external_change ? 'remote_mutation' : params.effect,
      confidence: 'llm',
      reason: 'tier1_not_restorable',
      signals: ['tier1_not_restorable', tier1.reason],
      judgeTrace: tier1Trace,
    })
  }

  return allowVerdict({
    location: location === 'unknown' ? 'repo_local' : location,
    opacity: params.opacity,
    effect: params.effect === 'unknown' ? 'read_only' : params.effect,
    confidence: 'llm',
    reason: 'tier1_restorable',
    signals: ['tier1_restorable', tier1.reason],
    judgeTrace: tier1Trace,
  })
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
    if (!resolution || resolution.opaque || resolution.recipes.length === 0) {
      return evaluateTier1(command, context, {
        opacity: resolution?.opaque ? 'opaque' : 'transparent',
        effect: 'unknown',
        pathAnalysis: {
          location: 'unknown',
          isHighStakes: false,
          signals: [resolution?.reason ?? 'launcher_unresolved'],
        },
      })
    }
    let innerVerdict: InternalSegmentVerdict | null = null
    for (const recipe of resolution.recipes) {
      const evaluated = await evaluateSegment(recipe, context, depth + 1)
      innerVerdict = innerVerdict ? combineInternal(innerVerdict, evaluated) : evaluated
    }
    if (!innerVerdict) {
      return evaluateTier1(command, context, {
        opacity: 'opaque',
        effect: 'unknown',
        pathAnalysis: {
          location: 'unknown',
          isHighStakes: false,
          signals: [resolution.reason],
        },
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
  // tier0_restorable: egress tools with no payload/mutate flags (structural read, not tool-name allow)
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

  const effect: VerdictEffect = isLocalMutationHead(segment.key, segment.head)
    ? 'local_mutation'
    : 'unknown'

  const pathArgs = extractPathArgs(peeled)
  const pathAnalysis = analyzePathTargets({
    targets: pathArgs,
    cwd: context.cwd,
    repoRoot: context.repoRoot,
    trustedCwd: context.trustedCwd,
    sensitivePaths: context.sensitivePaths,
    protectedArtifactRoots: context.protectedArtifactRoots,
  })

  if (!context.trustedCwd || !context.cwd) {
    if (
      isLocalMutationHead(segment.key, segment.head) &&
      (pathArgs.length > 0 || effect === 'local_mutation')
    ) {
      return askVerdict({
        location: 'unknown',
        opacity,
        effect,
        confidence: 'deterministic',
        reason: 'missing_trusted_cwd',
        signals: ['missing_trusted_cwd'],
      })
    }
  }

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
    return askVerdict({
      location: pathAnalysis.location,
      opacity: 'transparent',
      effect: effect === 'unknown' ? 'local_mutation' : effect,
      confidence: 'deterministic',
      reason: 'repo_outside_mutation',
      signals: ['repo_outside_mutation', ...pathAnalysis.signals],
    })
  }

  if (
    pathAnalysis.location === 'unknown' &&
    pathArgs.length > 0 &&
    isLocalMutationHead(segment.key, segment.head)
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

  // tier0_restorable: repo-local FS mutation with proven path containment
  if (
    pathAnalysis.location === 'repo_local' &&
    effect === 'local_mutation' &&
    opacity !== 'opaque'
  ) {
    return allowVerdict({
      location: 'repo_local',
      opacity,
      effect,
      confidence: 'assumed_repo_local',
      reason: 'tier0_restorable',
      signals: ['tier0_restorable', 'repo_local_mutation'],
    })
  }

  if (allowOverride) {
    return allowFromCustomOverride(opacity)
  }

  return evaluateTier1(command, context, {
    opacity,
    effect,
    pathAnalysis,
  })
}

function toVerdictResult(
  internal: InternalSegmentVerdict,
  command: string,
  context: VerdictContext,
  fingerprintCwd: string = context.cwd,
): VerdictResult {
  const commandRedacted = redactCommand(command)
  const relative = cwdRelative(context.repoRoot, fingerprintCwd)
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
  let chainState: ChainState = {
    cwd: context.cwd,
    trustedCwd: context.trustedCwd,
  }

  for (const segment of segments) {
    const segmentContext: VerdictContext = {
      ...context,
      cwd: chainState.cwd,
      trustedCwd: chainState.trustedCwd,
    }
    const segmentVerdict = await evaluateSegment(segment, segmentContext, 0)
    combined = combined ? combineInternal(combined, segmentVerdict) : segmentVerdict
    chainState = updateChainState(segment, chainState)
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
    chainState.cwd,
  )
}
