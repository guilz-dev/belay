import { createHash } from 'node:crypto'
import { policyDecisionToLegacyReason } from '../capability/policy-bridge.js'
import {
  evaluateCapabilityRequestsPolicy,
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
import type { EffectPlan, EffectRequirement, EffectTag } from './types.js'

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
} {
  const capabilityRequests = capabilityRequestsFromEffectPlan(plan, context)
  const { decisions, decision } = evaluateCapabilityRequestsPolicy(
    capabilityRequests,
    context.config,
    {
      grants: context.grants,
      attestation: context.attestation,
      egressProxyActive: context.egressProxyActive,
    },
    context.trustedWorkspaceRoots,
  )
  return { capabilityRequests, decisions, authorizationDecision: decision }
}

export function effectPlanPolicyRequiresAsk(decision: PolicyDecision): boolean {
  return policyDecisionRequiresAsk(decision)
}

export function effectPlanPolicyLegacyReason(decision: PolicyDecision): string {
  return policyDecisionToLegacyReason(decision)
}
