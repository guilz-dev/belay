import type { PolicyDecision } from '../capability/policy-types.js'
import type { CapabilityRequestV1 } from '../capability/request.js'
import { canonicalStringify, hashValue } from '../fingerprint.js'
import { collectRequirements } from './build.js'
import type { EffectPlan } from './types.js'

export function hashEffectPlan(plan: EffectPlan): string {
  const requirements = collectRequirements(plan.root)
    .map((requirement) => ({
      tag: requirement.tag,
      action: requirement.action,
      resource: requirement.resource,
      evidence: {
        level: requirement.evidence.level,
        signals: [...requirement.evidence.signals].sort(),
        basis: [...requirement.evidence.basis].sort(),
      },
      provenance: requirement.provenance,
    }))
    .sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)))
  return hashValue(
    `effect-plan:v1:${canonicalStringify({
      version: plan.version,
      inputFingerprint: plan.inputFingerprint,
      opacity: plan.opacity,
      signals: [...plan.signals].sort(),
      requirements,
    })}`,
  )
}

export function effectPlanAuditFields(
  plan: EffectPlan | undefined,
  policy?: {
    capabilityRequests?: readonly CapabilityRequestV1[]
    decisions?: readonly PolicyDecision[]
    authorizationDecision?: PolicyDecision
  },
): Record<string, unknown> {
  if (!plan) {
    return {}
  }
  const fields: Record<string, unknown> = {
    effectPlanVersion: plan.version,
    effectIRHash: hashEffectPlan(plan),
    effectPlanSignals: [...plan.signals],
    effectPlanOpacity: plan.opacity,
    effectPlanRequirements: collectRequirements(plan.root).map((requirement) => ({
      tag: requirement.tag,
      action: requirement.action,
      resource: requirement.resource,
      evidence: requirement.evidence,
      provenance: requirement.provenance,
    })),
  }
  if (policy?.authorizationDecision) {
    fields.effectPlanPolicyOutcome = policy.authorizationDecision.outcome
    fields.effectPlanPolicyReason = policy.authorizationDecision.reason
    if (policy.authorizationDecision.matchedRule) {
      fields.effectPlanPolicyMatchedRule = policy.authorizationDecision.matchedRule
    }
  }
  if (policy?.capabilityRequests?.length) {
    fields.effectPlanRequestActions = policy.capabilityRequests.map((request) => request.action)
    fields.effectPlanRequestCount = policy.capabilityRequests.length
    if (
      policy.capabilityRequests.some((request) =>
        request.evidence.signals.includes('package_cache_write'),
      )
    ) {
      fields.effectPlanCacheWriteProjected = true
    }
  }
  if (policy?.decisions?.length) {
    fields.effectPlanRequestDecisions = policy.decisions.map((decision) => ({
      outcome: decision.outcome,
      reason: decision.reason,
      matchedRule: decision.matchedRule,
    }))
  }
  return fields
}
