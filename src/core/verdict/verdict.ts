import path from 'node:path'
import { policyDecisionToLegacyReason } from '../capability/policy-bridge.js'
import { combinePolicyDecisions, policyDecisionRequiresAsk } from '../capability/policy-engine.js'
import { mergeEffectPlans } from '../effect-ir/normalize.js'
import { isPackageExecLauncher } from '../effect-ir/package-exec.js'
import { evaluatePackageExecSegment } from '../effect-ir/package-exec-eval.js'
import { canonicalPath, resolveMutationTarget } from '../path-utils.js'
import {
  extractRedirectTargets,
  isFdDuplication,
  isRedirectOperator,
  tokenizeShell,
} from '../shell-tokenizer.js'
import {
  analyzePathTargets,
  cwdRelative,
  isDestructiveHighStakesMutation,
  resolveTrustedPath,
  touchesProtectedRoot,
} from './containment.js'
import { classifyEgressTool } from './egress-classify.js'
import { verdictFingerprint } from './fingerprint.js'
import {
  isReadOnlyLauncherInvocation,
  isRoutineLauncher,
  resolveLauncherRecipe,
} from './launcher-resolve.js'
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
import { mutationPrescanRequiresAsk, prescanInterpreterCode, tier1RequiresAsk } from './prescan.js'
import {
  evaluateSegmentShellPolicy,
  type SegmentShellPolicyInput,
  shellPolicyMetadata,
} from './shell-policy.js'
import {
  analyzeShellCommandSemantics,
  isPureReadOnlySemantics,
  LOCAL_MUTATION_KEYS,
} from './shell-semantics.js'

import type {
  InternalSegmentVerdict,
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
])

const TIER0_EXTERNAL_HEADS = new Set([
  'dropdb',
  'createdb',
  'psql',
  'mysql',
  'mongosh',
  'redis-cli',
])

const BELAY_SELF_COMMANDS = new Set(['approve', 'revoke'])

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

  if (!worst || worst.permission === 'allow') {
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
  const policyDecisions = [
    ...(left.effectPlanPolicyDecisions ??
      (left.authorizationDecision ? [left.authorizationDecision] : [])),
    ...(right.effectPlanPolicyDecisions ??
      (right.authorizationDecision ? [right.authorizationDecision] : [])),
  ]
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
    capabilityRequests: [...(left.capabilityRequests ?? []), ...(right.capabilityRequests ?? [])],
    authorizationDecision:
      policyDecisions.length > 0 ? combinePolicyDecisions(policyDecisions) : undefined,
    effectPlan: mergeEffectPlans(left.effectPlan, right.effectPlan),
    effectPlanPolicyDecisions: policyDecisions,
  }
}

function askVerdict(params: Omit<InternalSegmentVerdict, 'permission'>): InternalSegmentVerdict {
  return { ...params, permission: 'ask' }
}

function resolveShellPathTargets(pathArgs: string[], context: VerdictContext): string[] {
  if (!context.cwd) {
    return []
  }
  return pathArgs.map((target) => {
    const resolved =
      (context.trustedCwd ? resolveTrustedPath(target, context.cwd, context.trustedCwd) : null) ??
      resolveMutationTarget(target, context.cwd)
    if (!resolved) {
      const joined = path.isAbsolute(target) ? target : path.join(context.cwd, target)
      return canonicalPath(joined)
    }
    return canonicalPath(resolved)
  })
}

function withShellPolicyMetadata(
  input: SegmentShellPolicyInput,
  existing: Pick<InternalSegmentVerdict, 'capabilityRequests' | 'authorizationDecision'> = {},
): Pick<InternalSegmentVerdict, 'capabilityRequests' | 'authorizationDecision'> {
  if (existing.capabilityRequests?.length) {
    return existing
  }
  return shellPolicyMetadata(input)
}

function allowVerdict(params: Omit<InternalSegmentVerdict, 'permission'>): InternalSegmentVerdict {
  return { ...params, permission: 'allow' }
}

function extractPathArgs(tokens: string[]): string[] {
  const redirects = extractRedirectTargets(tokens)
  const args: string[] = [...redirects]
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.startsWith('-') || isRedirectOperator(token) || isFdDuplication(token)) {
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

function pathContextFromSemantics(
  context: VerdictContext,
  semantics: ReturnType<typeof analyzeShellCommandSemantics>,
): VerdictContext {
  const cwd = semantics.gitWorkTree ?? semantics.effectiveCwd
  if (!cwd || cwd === context.cwd) {
    return context
  }
  return { ...context, cwd }
}

function isPureReadOnlySegment(
  segment: ReturnType<typeof parseSegment>,
  semantics: ReturnType<typeof analyzeShellCommandSemantics>,
): boolean {
  return isPureReadOnlySemantics(segment, semantics)
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

function tier0ExternalMatch(
  key: string,
  head: string,
  tokens: string[],
  signals: string[] = [],
): boolean {
  if (TIER0_EXTERNAL_KEYS.has(key)) {
    return true
  }
  if (signals.includes('git.push')) {
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
  if (head === 'terraform' && tokens[1] === 'apply') {
    return true
  }
  return false
}

function isBelayJudgeSelfCommand(tokens: string[]): boolean {
  return (
    tokens[0] === 'belay' &&
    tokens[1] === 'judge' &&
    (tokens[2] === 'use' ||
      tokens[2] === 'status' ||
      tokens[2] === 'list' ||
      tokens[2] === 'test' ||
      tokens[2] === 'consent')
  )
}

function isBelayConfigSelfCommand(tokens: string[]): boolean {
  if (tokens[0] !== 'belay' || tokens[1] !== 'config') {
    return false
  }
  const sub = tokens[2]
  if (!sub) {
    return true
  }
  if (sub === 'list' || sub === 'get' || sub === 'judge') {
    return true
  }
  if (sub === 'credential') {
    return true
  }
  if (sub === 'set' || sub === 'unset') {
    const pathKey = tokens[3] ?? ''
    return pathKey.startsWith('judge.')
  }
  return false
}

function isBelaySelfCommand(tokens: string[]): boolean {
  const head = tokens[0] ?? ''
  const subcommand = tokens[1] ?? ''
  return (
    head === 'belay' &&
    (BELAY_SELF_COMMANDS.has(subcommand) ||
      isBelayJudgeSelfCommand(tokens) ||
      isBelayConfigSelfCommand(tokens))
  )
}

function tier0HighStakesRm(
  tokens: string[],
  context: VerdictContext,
): InternalSegmentVerdict | null {
  const head = (tokens[0] ?? '').split('/').pop() ?? ''
  if (head !== 'rm') {
    return null
  }
  const targets = extractPathArgs(tokens)
  const analysis = analyzePathTargets({
    targets,
    cwd: context.cwd,
    repoRoot: context.repoRoot,
    trustedCwd: context.trustedCwd,
    trustedWorkspaceRoots: context.trustedWorkspaceRoots,
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
  for (const target of targets) {
    const normalized = target.replace(/^['"]|['"]$/g, '')
    if (normalized === '~' || normalized === '$HOME' || normalized.startsWith('~/')) {
      return askVerdict({
        location: 'repo_outside',
        opacity: 'transparent',
        effect: 'local_mutation',
        confidence: 'deterministic',
        reason: 'high_stakes_path',
        signals: ['catastrophic_home_deletion', ...analysis.signals],
      })
    }
  }
  if (analysis.isHighStakes && analysis.signals.includes('high_stakes_path')) {
    let destructiveHighStakes = false
    for (const target of targets) {
      const resolved =
        resolveTrustedPath(target, context.cwd, context.trustedCwd) ??
        resolveMutationTarget(target, context.cwd)
      if (
        resolved &&
        isDestructiveHighStakesMutation(
          head,
          resolved,
          context.repoRoot,
          context.sensitivePaths,
          context.protectedArtifactRoots,
          context.trustedWorkspaceRoots,
        )
      ) {
        destructiveHighStakes = true
        break
      }
    }
    if (destructiveHighStakes) {
      return askVerdict({
        location: analysis.location,
        opacity: 'transparent',
        effect: 'local_mutation',
        confidence: 'deterministic',
        reason: 'high_stakes_path',
        signals: ['high_stakes_path', ...analysis.signals],
      })
    }
  }
  return null
}

function verdictFromOpacityPolicy(params: {
  command: string
  segmentHead: string
  opacity: import('./types.js').VerdictOpacity
  effect: import('./types.js').VerdictEffect
  location: import('./types.js').VerdictLocation
  pathArgs: string[]
  signals: string[]
  context: import('./types.js').VerdictContext
}): InternalSegmentVerdict {
  const { requests, decision } = evaluateSegmentShellPolicy({
    command: params.command,
    segmentHead: params.segmentHead,
    effect: params.effect,
    location: params.location,
    opacity: params.opacity,
    pathArgs: params.pathArgs,
    signals: params.signals,
    context: params.context,
  })
  const base = {
    location: params.location,
    opacity: params.opacity,
    effect: params.effect,
    confidence: 'deterministic' as const,
    signals: [...params.signals, ...decision.signals],
    capabilityRequests: requests,
    authorizationDecision: decision,
  }
  if (policyDecisionRequiresAsk(decision)) {
    return {
      permission: 'ask',
      reason: policyDecisionToLegacyReason(decision),
      ...base,
    }
  }
  return {
    permission: 'allow',
    reason: policyDecisionToLegacyReason(decision),
    ...base,
  }
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
    return verdictFromOpacityPolicy({
      command,
      segmentHead: parseSegment(command).head,
      opacity: 'unparseable',
      effect: 'unknown',
      location: 'unknown',
      pathArgs: [],
      signals: ['unparseable_shell'],
      context,
    })
  }

  const substitutionResult = await evaluateSubstitutions(command, context, depth)
  if (substitutionResult) {
    return substitutionResult
  }

  const tokens = tokenizeShell(command)
  const { tokens: peeled, xargsStdinOpaque } = peelTransparentWrappers(tokens)
  if (xargsStdinOpaque || isBareInterpreter(tokens)) {
    return verdictFromOpacityPolicy({
      command,
      segmentHead: parseSegment(command).head,
      opacity: 'opaque',
      effect: 'unknown',
      location: 'unknown',
      pathArgs: [],
      signals: ['opaque_execution'],
      context,
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
      const { requests, decision } = evaluateSegmentShellPolicy({
        command: recursiveScript,
        segmentHead: segment.head,
        effect: 'unknown',
        location: 'unknown',
        opacity: 'recursive',
        pathArgs: [],
        signals: ['interpreter_secret_prescan', prescan.reason],
        context,
      })
      const legacyReason = policyDecisionRequiresAsk(decision)
        ? policyDecisionToLegacyReason(decision)
        : 'interpreter_secret_prescan'
      return askVerdict({
        location: 'unknown',
        opacity: 'recursive',
        effect: 'unknown',
        confidence: 'deterministic',
        reason: legacyReason,
        signals: ['interpreter_secret_prescan', prescan.reason, ...decision.signals],
        capabilityRequests: requests,
        authorizationDecision: decision,
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

  if (isPackageExecLauncher(peeled)) {
    return evaluatePackageExecSegment({
      command,
      peeled,
      context,
      evaluateInner: (innerRecipe) => evaluateSegment(innerRecipe, context, depth + 1),
    })
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
      for (const sub of splitTopLevelSegments(recipe)) {
        const evaluated = await evaluateSegment(sub, context, depth + 1)
        innerVerdict = innerVerdict ? combineInternal(innerVerdict, evaluated) : evaluated
      }
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

  const semantics = analyzeShellCommandSemantics(peeled, segment, context.cwd)
  const pathContext = pathContextFromSemantics(context, semantics)

  if (semantics.requiresAsk) {
    const { requests, decision } = evaluateSegmentShellPolicy({
      command,
      segmentHead: segment.head,
      effect: 'local_mutation',
      location: 'repo_local',
      opacity: 'transparent',
      pathArgs: semantics.pathTargets,
      signals: semantics.requiresAsk.signals,
      context: pathContext,
    })
    return askVerdict({
      location: 'repo_local',
      opacity: 'transparent',
      effect: 'local_mutation',
      confidence: 'deterministic',
      reason: semantics.requiresAsk.reason,
      signals: semantics.requiresAsk.signals,
      capabilityRequests: requests,
      authorizationDecision: decision,
    })
  }

  const egressClass = semantics.egressClass ?? classifyEgressTool(segment.head, peeled)
  if (egressClass === 'destructive') {
    const { requests, decision } = evaluateSegmentShellPolicy({
      command,
      segmentHead: segment.head,
      effect: 'remote_mutation',
      location: 'external',
      opacity: 'transparent',
      egressClass: 'destructive',
      pathArgs: [],
      signals: ['tier0_external', segment.head],
      context,
    })
    return askVerdict({
      location: 'external',
      opacity: 'transparent',
      effect: 'remote_mutation',
      confidence: 'deterministic',
      reason: 'tier0_external',
      signals: ['tier0_external', segment.head, ...decision.signals],
      capabilityRequests: requests,
      authorizationDecision: decision,
    })
  }
  if (
    tier0ExternalMatch(
      semantics.normalizedKey ?? segment.key,
      segment.head,
      peeled,
      semantics.signals,
    )
  ) {
    const tier0Key = semantics.normalizedKey ?? segment.key
    const { requests, decision } = evaluateSegmentShellPolicy({
      command,
      segmentHead: segment.head,
      effect: 'remote_mutation',
      location: 'external',
      opacity: 'transparent',
      pathArgs: [],
      signals: ['tier0_external', tier0Key, ...semantics.signals],
      context: pathContext,
    })
    return askVerdict({
      location: 'external',
      opacity: 'transparent',
      effect: 'remote_mutation',
      confidence: 'deterministic',
      reason: 'tier0_external',
      signals: ['tier0_external', tier0Key, ...decision.signals],
      capabilityRequests: requests,
      authorizationDecision: decision,
    })
  }

  const rmVerdict = tier0HighStakesRm(peeled, pathContext)
  if (rmVerdict) {
    return rmVerdict
  }

  if (isBelaySelfCommand(peeled)) {
    return allowVerdict({
      location: 'unknown',
      opacity: 'transparent',
      effect: 'local_mutation',
      confidence: 'deterministic',
      reason: 'belay_control_plane_command',
      signals: ['belay_control_plane_command', segment.head],
    })
  }

  let effect: VerdictEffect = semantics.effect
  if (isReadOnlyLauncherInvocation(peeled)) {
    effect = 'read_only'
  }

  const pathArgs = semantics.pathTargets
  const policyPathArgs = [...new Set([...pathArgs, ...(semantics.scopeTargets ?? [])])]

  const pathAnalysis = analyzePathTargets({
    targets: policyPathArgs,
    cwd: pathContext.cwd,
    repoRoot: pathContext.repoRoot,
    trustedCwd: pathContext.trustedCwd,
    trustedWorkspaceRoots: pathContext.trustedWorkspaceRoots,
    sensitivePaths: pathContext.sensitivePaths,
    protectedArtifactRoots: pathContext.protectedArtifactRoots,
  })

  // Path-less read/mutation in a trusted cwd: assume repo-local (e.g. git status, tsc --noEmit).
  const effectiveLocation: VerdictLocation =
    policyPathArgs.length === 0 &&
    pathContext.trustedCwd &&
    pathContext.cwd &&
    (effect === 'read_only' || effect === 'local_mutation') &&
    pathAnalysis.location === 'unknown'
      ? 'repo_local'
      : pathAnalysis.location

  if (!context.trustedCwd || !context.cwd) {
    if (opacity === 'opaque' || effect === 'unknown' || effect === 'local_mutation') {
      return askVerdict({
        location: 'unknown',
        opacity,
        effect: effect === 'read_only' ? 'unknown' : effect,
        confidence: 'deterministic',
        reason: 'missing_trusted_cwd',
        signals: ['missing_trusted_cwd'],
      })
    }
    if (effect === 'read_only' && !isPureReadOnlySegment(segment, semantics)) {
      return askVerdict({
        location: 'unknown',
        opacity,
        effect: 'read_only',
        confidence: 'deterministic',
        reason: 'missing_trusted_cwd',
        signals: ['missing_trusted_cwd'],
      })
    }
  }

  if (
    (effect === 'local_mutation' || effect === 'unknown') &&
    context.protectedArtifactRoots &&
    context.protectedArtifactRoots.length > 0
  ) {
    for (const target of pathArgs) {
      const resolved =
        resolveTrustedPath(target, pathContext.cwd, pathContext.trustedCwd) ??
        resolveMutationTarget(target, pathContext.cwd)
      if (resolved && touchesProtectedRoot(resolved, pathContext.protectedArtifactRoots ?? [])) {
        return askVerdict({
          location: pathAnalysis.location,
          opacity: 'transparent',
          effect: 'local_mutation',
          confidence: 'deterministic',
          reason: 'high_stakes_path',
          signals: ['high_stakes_path', 'control_plane_path'],
        })
      }
    }
  }

  if (effect === 'local_mutation' || effect === 'unknown') {
    let destructiveHighStakes = false
    for (const target of pathArgs) {
      const resolved =
        resolveTrustedPath(target, pathContext.cwd, pathContext.trustedCwd) ??
        resolveMutationTarget(target, pathContext.cwd)
      if (
        resolved &&
        isDestructiveHighStakesMutation(
          segment.head,
          resolved,
          pathContext.repoRoot,
          pathContext.sensitivePaths,
          pathContext.protectedArtifactRoots,
          pathContext.trustedWorkspaceRoots,
        )
      ) {
        destructiveHighStakes = true
        break
      }
    }
    if (destructiveHighStakes) {
      return askVerdict({
        location: pathAnalysis.location,
        opacity: 'transparent',
        effect: 'local_mutation',
        confidence: 'deterministic',
        reason: 'high_stakes_path',
        signals: pathAnalysis.signals,
      })
    }
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

  if (
    effect === 'read_only' &&
    (pathAnalysis.location === 'repo_outside' || pathAnalysis.location === 'mixed')
  ) {
    return allowVerdict({
      location: pathAnalysis.location,
      opacity,
      effect: 'read_only',
      confidence: 'deterministic',
      reason: 'read_only',
      signals: ['read_only', ...pathAnalysis.signals],
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

  const resolvedPathTargets = resolveShellPathTargets(policyPathArgs, pathContext)
  const semanticSignals = semantics.signals
  const buildPolicyInput = (
    overrides: Partial<SegmentShellPolicyInput> &
      Pick<SegmentShellPolicyInput, 'effect' | 'location'>,
  ): SegmentShellPolicyInput => ({
    command: recursiveScript ?? command,
    segmentHead: segment.head,
    opacity,
    egressClass: egressClass ?? undefined,
    pathArgs: policyPathArgs,
    resolvedPathTargets,
    signals: [...semanticSignals, ...pathAnalysis.signals],
    context: pathContext,
    ...overrides,
  })

  const outsideMutation =
    pathAnalysis.location === 'repo_outside' || pathAnalysis.location === 'mixed'
  const mutationPrescan =
    (effect === 'local_mutation' || effect === 'unknown') && pathArgs.length > 0
      ? mutationPrescanRequiresAsk({
          targets: pathArgs,
          cwd: pathContext.cwd,
          repoRoot: pathContext.repoRoot,
          trustedCwd: pathContext.trustedCwd,
          trustedWorkspaceRoots: pathContext.trustedWorkspaceRoots,
          sensitivePaths: pathContext.sensitivePaths,
        })
      : null
  if (mutationPrescan) {
    const { requests, decision } = evaluateSegmentShellPolicy(
      buildPolicyInput({
        effect: 'local_mutation',
        location:
          pathAnalysis.location === 'unknown'
            ? 'unknown'
            : pathAnalysis.location === 'repo_outside' || pathAnalysis.location === 'mixed'
              ? pathAnalysis.location
              : 'repo_local',
        signals: ['tier1_catastrophic', mutationPrescan.reason, ...pathAnalysis.signals],
      }),
    )
    const legacyReason = policyDecisionRequiresAsk(decision)
      ? policyDecisionToLegacyReason(decision, { outsideMutation, effect: 'local_mutation' })
      : 'tier1_catastrophic'
    return askVerdict({
      location:
        pathAnalysis.location === 'unknown'
          ? 'unknown'
          : pathAnalysis.location === 'repo_outside' || pathAnalysis.location === 'mixed'
            ? pathAnalysis.location
            : 'repo_local',
      opacity,
      effect: 'local_mutation',
      confidence: 'deterministic',
      reason: legacyReason,
      signals: ['tier1_catastrophic', mutationPrescan.reason, ...decision.signals],
      capabilityRequests: requests,
      authorizationDecision: decision,
    })
  }
  const needsPolicy =
    effect === 'unknown' ||
    TIER0_EXTERNAL_HEADS.has(segment.head) ||
    egressClass === 'ambiguous' ||
    egressClass === 'read' ||
    (outsideMutation && effect !== 'read_only')

  let policyMetadata: Pick<InternalSegmentVerdict, 'capabilityRequests' | 'authorizationDecision'> =
    {}
  if (needsPolicy) {
    const { requests, decision } = evaluateSegmentShellPolicy(
      buildPolicyInput({
        effect,
        location: pathAnalysis.location,
      }),
    )
    policyMetadata = {
      capabilityRequests: requests,
      authorizationDecision: decision,
    }
    if (policyDecisionRequiresAsk(decision)) {
      return askVerdict({
        location:
          pathAnalysis.location === 'unknown'
            ? 'unknown'
            : pathAnalysis.location === 'repo_outside' || pathAnalysis.location === 'mixed'
              ? pathAnalysis.location
              : 'repo_local',
        opacity,
        effect:
          decision.reason === 'external_effect' || decision.reason === 'network_connect'
            ? 'remote_mutation'
            : effect,
        confidence: 'deterministic',
        reason: policyDecisionToLegacyReason(decision, { outsideMutation, effect }),
        signals: ['policy_required', ...decision.signals],
        ...policyMetadata,
      })
    }
  }

  if (outsideMutation && effect !== 'read_only') {
    const policyAllowsOutside =
      policyMetadata.authorizationDecision?.outcome === 'allow' &&
      (policyMetadata.authorizationDecision.matchedRule === 'grant.exact' ||
        policyMetadata.authorizationDecision.matchedRule === 'boundary.verified' ||
        policyMetadata.authorizationDecision.matchedRule === 'builtin.trusted_workspace')
    if (!policyAllowsOutside) {
      const legacyReason =
        policyMetadata.authorizationDecision &&
        policyDecisionRequiresAsk(policyMetadata.authorizationDecision)
          ? policyDecisionToLegacyReason(policyMetadata.authorizationDecision, {
              outsideMutation,
              effect,
            })
          : 'outside_repo_mutation'
      return askVerdict({
        location: pathAnalysis.location,
        opacity,
        effect: 'local_mutation',
        confidence: 'deterministic',
        reason: legacyReason,
        signals: ['outside_repo_mutation', ...pathAnalysis.signals],
        ...policyMetadata,
      })
    }
    return allowVerdict({
      location: pathAnalysis.location,
      opacity,
      effect: 'local_mutation',
      confidence: 'deterministic',
      reason: 'repo_outside_local_mutation',
      signals: ['repo_outside_local_mutation', ...pathAnalysis.signals],
      ...policyMetadata,
    })
  }

  if (
    effectiveLocation === 'repo_local' &&
    (effect === 'read_only' || effect === 'local_mutation') &&
    opacity !== 'opaque'
  ) {
    return allowVerdict({
      location: 'repo_local',
      opacity,
      effect,
      confidence: 'assumed_repo_local',
      reason: effect === 'read_only' ? 'read_only' : 'repo_local_mutation',
      signals: effect === 'read_only' ? ['read_only'] : ['repo_local_mutation'],
      ...withShellPolicyMetadata(
        buildPolicyInput({ effect, location: 'repo_local' }),
        policyMetadata,
      ),
    })
  }

  if (effect === 'read_only') {
    const readOnlyLocation =
      pathContext.trustedCwd && pathContext.cwd
        ? effectiveLocation === 'unknown'
          ? 'repo_local'
          : effectiveLocation
        : 'unknown'
    return allowVerdict({
      location: readOnlyLocation,
      opacity,
      effect: 'read_only',
      confidence: context.trustedCwd && context.cwd ? 'assumed_repo_local' : 'deterministic',
      reason: 'read_only',
      signals: ['read_only'],
      ...withShellPolicyMetadata(
        buildPolicyInput({ effect: 'read_only', location: readOnlyLocation }),
        policyMetadata,
      ),
    })
  }

  if (allowOverride) {
    return allowFromCustomOverride(opacity)
  }

  if (context.unknownLocalEffect === 'allow_flagged') {
    return allowVerdict({
      location: effectiveLocation === 'unknown' ? 'repo_local' : effectiveLocation,
      opacity,
      effect: 'unknown',
      confidence: 'assumed_repo_local',
      reason: 'unknown_local_effect',
      signals: ['unknown_local_effect'],
      ...withShellPolicyMetadata(
        buildPolicyInput({
          effect: 'unknown',
          location: effectiveLocation === 'unknown' ? 'repo_local' : effectiveLocation,
        }),
        policyMetadata,
      ),
    })
  }

  return askVerdict({
    location: effectiveLocation,
    opacity,
    effect,
    confidence: 'deterministic',
    reason: 'unknown_local_effect',
    signals: ['unknown_local_effect'],
    ...withShellPolicyMetadata(
      buildPolicyInput({ effect, location: pathAnalysis.location }),
      policyMetadata,
    ),
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
    capabilityRequests: internal.capabilityRequests,
    authorizationDecision: internal.authorizationDecision,
    effectPlan: internal.effectPlan,
    effectPlanPolicyDecisions: internal.effectPlanPolicyDecisions,
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
