import { policyDecisionToLegacyReason } from '../capability/policy-bridge.js'
import { policyDecisionRequiresAsk } from '../capability/policy-engine.js'
import { cwdRelative } from '../verdict/containment.js'
import { verdictFingerprint } from '../verdict/fingerprint.js'
import { redactCommand } from '../verdict/parser.js'
import type { InternalSegmentVerdict, VerdictContext } from '../verdict/types.js'
import { buildEffectPlan } from './build.js'
import { innerRecipeFromPeel, peelPackageExecArgv } from './package-exec.js'
import { capabilityRequestsToEffectRequirements, evaluateEffectPlanPolicy } from './policy.js'
import type { EffectPlan } from './types.js'

export interface PackageExecEvalParams {
  command: string
  peeled: string[]
  context: VerdictContext
  evaluateInner: (innerRecipe: string) => Promise<InternalSegmentVerdict>
}

function askFromEffectPlan(params: {
  plan: EffectPlan
  context: VerdictContext
  reason: string
  signals: string[]
  inner?: InternalSegmentVerdict
}): InternalSegmentVerdict {
  const { capabilityRequests, authorizationDecision, decisions } = evaluateEffectPlanPolicy(
    params.plan,
    params.context,
  )
  const legacyReason = policyDecisionRequiresAsk(authorizationDecision)
    ? policyDecisionToLegacyReason(authorizationDecision)
    : params.reason
  return {
    permission: 'ask',
    location: params.inner?.location ?? 'unknown',
    opacity: params.plan.opacity,
    effect: params.inner?.effect ?? 'unknown',
    confidence: 'deterministic',
    reason: legacyReason,
    signals: [...new Set([...params.signals, ...params.plan.signals])],
    capabilityRequests,
    authorizationDecision,
    effectPlan: params.plan,
    effectPlanPolicyDecisions: decisions,
  }
}

function allowFromEffectPlan(params: {
  plan: EffectPlan
  context: VerdictContext
  inner: InternalSegmentVerdict
  signals: string[]
}): InternalSegmentVerdict {
  const { capabilityRequests, authorizationDecision, decisions } = evaluateEffectPlanPolicy(
    params.plan,
    params.context,
  )
  return {
    ...params.inner,
    opacity: params.plan.opacity,
    signals: [...new Set([...params.inner.signals, ...params.signals, ...params.plan.signals])],
    capabilityRequests,
    authorizationDecision,
    effectPlan: params.plan,
    effectPlanPolicyDecisions: decisions,
  }
}

export async function evaluatePackageExecSegment(
  params: PackageExecEvalParams,
): Promise<InternalSegmentVerdict> {
  const peel = peelPackageExecArgv(params.peeled)
  if (!peel) {
    return {
      permission: 'ask',
      location: 'unknown',
      opacity: 'opaque',
      effect: 'unknown',
      confidence: 'deterministic',
      reason: 'launcher_unresolved',
      signals: ['launcher_unresolved'],
    }
  }

  const relative = cwdRelative(params.context.repoRoot, params.context.cwd)
  const inputFingerprint = verdictFingerprint(relative, redactCommand(params.command))

  if (peel.opaque) {
    const plan =
      buildEffectPlan({
        tokens: params.peeled,
        cwd: params.context.cwd,
        repoRoot: params.context.repoRoot,
        inputFingerprint,
      }) ??
      ({
        version: 1,
        root: { kind: 'merge', children: [] },
        inputFingerprint,
        opacity: 'opaque',
        signals: [peel.reason],
      } as EffectPlan)
    return askFromEffectPlan({
      plan,
      context: params.context,
      reason: peel.reason,
      signals: [peel.reason, ...peel.signals],
    })
  }

  const innerRecipe = innerRecipeFromPeel(peel)
  let innerVerdict: InternalSegmentVerdict | null = null
  let innerRequirements: ReturnType<typeof capabilityRequestsToEffectRequirements> | undefined

  if (innerRecipe) {
    innerVerdict = await params.evaluateInner(innerRecipe)
    if (innerVerdict.capabilityRequests?.length) {
      innerRequirements = capabilityRequestsToEffectRequirements(innerVerdict.capabilityRequests)
    } else if (innerVerdict.permission === 'allow' && innerVerdict.effect === 'read_only') {
      innerRequirements = []
    }
  }

  const plan = buildEffectPlan({
    tokens: params.peeled,
    cwd: params.context.cwd,
    repoRoot: params.context.repoRoot,
    inputFingerprint,
    innerRequirements,
  })

  if (!plan) {
    return {
      permission: 'ask',
      location: innerVerdict?.location ?? 'unknown',
      opacity: 'opaque',
      effect: innerVerdict?.effect ?? 'unknown',
      confidence: 'deterministic',
      reason: peel.reason,
      signals: [peel.reason, ...peel.signals],
      capabilityRequests: innerVerdict?.capabilityRequests,
      authorizationDecision: innerVerdict?.authorizationDecision,
    }
  }

  const { capabilityRequests, authorizationDecision, decisions } = evaluateEffectPlanPolicy(
    plan,
    params.context,
  )

  if (policyDecisionRequiresAsk(authorizationDecision)) {
    return askFromEffectPlan({
      plan,
      context: params.context,
      reason: policyDecisionToLegacyReason(authorizationDecision),
      signals: [peel.reason, ...peel.signals],
      inner: innerVerdict ?? undefined,
    })
  }

  if (innerVerdict?.permission === 'ask') {
    return {
      ...innerVerdict,
      opacity: plan.opacity,
      signals: [...new Set([...innerVerdict.signals, peel.reason, ...plan.signals])],
      capabilityRequests,
      authorizationDecision,
      effectPlan: plan,
      effectPlanPolicyDecisions: decisions,
    }
  }

  if (!innerVerdict) {
    return {
      permission: 'allow',
      location: 'repo_local',
      opacity: plan.opacity,
      effect: 'read_only',
      confidence: 'deterministic',
      reason: peel.reason,
      signals: [peel.reason, ...plan.signals],
      capabilityRequests,
      authorizationDecision,
      effectPlan: plan,
      effectPlanPolicyDecisions: decisions,
    }
  }

  return allowFromEffectPlan({
    plan,
    context: params.context,
    inner: innerVerdict,
    signals: [peel.reason, ...peel.signals],
  })
}
