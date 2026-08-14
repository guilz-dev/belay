import { createHash } from 'node:crypto'
import { policyDecisionToLegacyReason } from '../capability/policy-bridge.js'
import {
  type EffectPolicyDisposition,
  type EffectRequirementPolicyDecision,
  evaluateEffectRequirementPolicy,
  policyDecisionRequiresAsk,
} from '../capability/policy-engine.js'
import type { PolicyDecision } from '../capability/policy-types.js'
import type {
  CapabilityAction,
  CapabilityPrincipal,
  CapabilityRequestV1,
} from '../capability/request.js'
import type { VerdictContext } from '../verdict/types.js'
import { collectRequirements, flattenRequirementsToCapabilityRequests } from './build.js'
import type {
  EffectPlan,
  EffectPlanPolicyProjection,
  EffectRequirement,
  EffectTag,
} from './types.js'

function shellPrincipal(repoRoot: string, cwd: string): CapabilityPrincipal {
  return {
    repoRoot,
    sessionHash: createHash('sha256').update(`${repoRoot}:${cwd}`).digest('hex').slice(0, 16),
  }
}

function capabilityActionToEffectTag(action: CapabilityAction): EffectTag {
  switch (action) {
    case 'fs.read':
      return 'fs.read'
    case 'fs.write':
      return 'fs.write'
    case 'process.exec':
      return 'process.exec'
    case 'network.connect':
      return 'network.connect'
    case 'secret.read':
      return 'secret.read'
    case 'git.ref.write':
      return 'git.ref.write'
    case 'control_plane.write':
      return 'control_plane.write'
    case 'indeterminate':
      return 'indeterminate'
    default:
      return 'indeterminate'
  }
}

export function capabilityRequestsToEffectRequirements(
  requests: readonly CapabilityRequestV1[],
): EffectRequirement[] {
  return requests.map((request) => ({
    tag: capabilityActionToEffectTag(request.action),
    action: request.action,
    resource: request.resource,
    evidence: {
      level: request.evidence.level,
      signals: [...request.evidence.signals],
      basis: [...request.context.analysisBasis],
    },
    provenance: {
      innerCommand: request.resource.kind === 'executable' ? request.resource.command : undefined,
    },
    provenances: [
      {
        innerCommand: request.resource.kind === 'executable' ? request.resource.command : undefined,
      },
    ],
  }))
}

export function capabilityRequestsFromEffectPlan(
  plan: EffectPlan,
  context: VerdictContext,
): CapabilityRequestV1[] {
  const requirements = collectRequirements(plan.root)
  return flattenRequirementsToCapabilityRequests(requirements, {
    principal: shellPrincipal(context.repoRoot, context.cwd),
    cwd: context.cwd,
    repoRoot: context.repoRoot,
    hookKind: 'shell',
    inputFingerprint: plan.inputFingerprint,
  })
}

export function evaluateEffectPlanPolicy(
  plan: EffectPlan,
  context: VerdictContext,
): {
  capabilityRequests: CapabilityRequestV1[]
  decisions: PolicyDecision[]
  authorizationDecision: PolicyDecision
  projection: EffectPlanPolicyProjection
} {
  const requirements = collectRequirements(plan.root)
  const capabilityRequests = capabilityRequestsFromEffectPlan(plan, context)
  const decisions: EffectRequirementPolicyDecision[] = requirements.map((requirement, index) =>
    evaluateEffectRequirementPolicy(
      {
        tag: requirement.tag,
        action: requirement.action,
        resource: requirement.resource,
        evidence: requirement.evidence,
        provenance: requirement.provenance,
      },
      {
        cwd: context.cwd,
        repoRoot: context.repoRoot,
        trustedWorkspaceRoots: context.trustedWorkspaceRoots,
        sensitivePaths: context.sensitivePaths,
        protectedArtifactRoots: context.protectedArtifactRoots,
        grants: context.grants,
        capabilityRequest: capabilityRequests[index],
      },
    ),
  )
  const indeterminateIndexes = requirements.flatMap((requirement, index) =>
    requirement.action === 'indeterminate' ||
    requirement.tag === 'indeterminate' ||
    requirement.evidence.level === 'indeterminate'
      ? [index]
      : [],
  )
  const unresolvedPartial =
    indeterminateIndexes.length === 0 ||
    indeterminateIndexes.some((index) => decisions[index]?.matchedRule !== 'grant.exact')
  if (plan.completeness === 'partial' && unresolvedPartial) {
    decisions.push({
      effectDisposition: 'ask',
      outcome: 'require_approval',
      reason: 'indeterminate_effect',
      signals: [...plan.signals, 'effect_plan_partial'],
      matchedRule: 'effect.plan_partial',
    })
  }
  const worstDecision = worstEffectDecision(decisions)
  const authorizationDecision =
    (worstDecision?.effectDisposition === 'ask'
      ? worstDecision
      : (decisions.find((decision) => decision.matchedRule === 'grant.exact') ?? worstDecision)) ??
    ({
      outcome: 'allow',
      reason: 'read_only',
      signals: [],
      matchedRule: 'effect.effect_free',
    } satisfies PolicyDecision)
  const projection = projectEffectPlanPolicy(decisions, authorizationDecision)
  return {
    capabilityRequests,
    decisions,
    authorizationDecision,
    projection,
  }
}

function dispositionRank(disposition: EffectPolicyDisposition): number {
  switch (disposition) {
    case 'ask':
      return 2
    case 'allow_flagged':
      return 1
    case 'allow':
      return 0
    default:
      return 2
  }
}

function projectEffectPlanPolicy(
  decisions: readonly EffectRequirementPolicyDecision[],
  authorizationDecision: PolicyDecision,
): EffectPlanPolicyProjection {
  const worst = worstEffectDecision(decisions)
  if (!worst) {
    return {
      permission: 'allow',
      hookVerdict: 'allow',
      reason: 'read_only',
    }
  }
  if (worst.effectDisposition === 'ask') {
    return {
      permission: 'ask',
      hookVerdict: 'deny_pending_approval',
      reason: policyDecisionToLegacyReason(authorizationDecision),
    }
  }
  return {
    permission: 'allow',
    hookVerdict: worst.effectDisposition === 'allow_flagged' ? 'allow_flagged' : 'allow',
    reason: policyDecisionToLegacyReason(worst),
  }
}

function worstEffectDecision(
  decisions: readonly EffectRequirementPolicyDecision[],
): EffectRequirementPolicyDecision | undefined {
  let worst: EffectRequirementPolicyDecision | undefined
  for (const decision of decisions) {
    if (
      !worst ||
      dispositionRank(decision.effectDisposition) > dispositionRank(worst.effectDisposition)
    ) {
      worst = decision
    }
  }
  return worst
}

export function effectPlanPolicyRequiresAsk(decision: PolicyDecision): boolean {
  return policyDecisionRequiresAsk(decision)
}

export function effectPlanPolicyLegacyReason(decision: PolicyDecision): string {
  return policyDecisionToLegacyReason(decision)
}
