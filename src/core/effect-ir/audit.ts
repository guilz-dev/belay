import type { PolicyDecision } from '../capability/policy-types.js'
import type { CapabilityRequestV1 } from '../capability/request.js'
import { canonicalStringify, hashValue } from '../fingerprint.js'
import { collectRequirements } from './build.js'
import type { EffectPlan, EffectProvenance } from './types.js'

function auditableProvenance(provenance: EffectProvenance): EffectProvenance {
  return {
    ...(provenance.segment ? { segment: provenance.segment } : {}),
    ...(provenance.launcher ? { launcher: provenance.launcher } : {}),
    ...(provenance.phase ? { phase: provenance.phase } : {}),
  }
}

function auditableResource(resource: ReturnType<typeof collectRequirements>[number]['resource']) {
  if (resource.kind === 'executable') {
    return {
      kind: 'executable',
      commandHash: hashValue(resource.command),
      ...(resource.operation ? { operation: resource.operation } : {}),
    }
  }
  return resource
}

export function hashEffectPlan(plan: EffectPlan): string {
  const requirements = collectRequirements(plan.root)
    .map((requirement) => ({
      tag: requirement.tag,
      action: requirement.action,
      resource: auditableResource(requirement.resource),
      evidence: {
        level: requirement.evidence.level,
        signals: [...requirement.evidence.signals].sort(),
        basis: [...requirement.evidence.basis].sort(),
      },
      provenance: requirement.provenance,
      provenances: [...(requirement.provenances ?? [requirement.provenance])].sort((left, right) =>
        canonicalStringify(left).localeCompare(canonicalStringify(right)),
      ),
    }))
    .sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)))
  return hashValue(
    `effect-plan:v1:${canonicalStringify({
      version: plan.version,
      inputFingerprint: plan.inputFingerprint,
      opacity: plan.opacity,
      disposition: plan.disposition,
      completeness: plan.completeness,
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
    effectPlanDisposition: plan.disposition,
    effectPlanCompleteness: plan.completeness,
    effectPlanRequirements: collectRequirements(plan.root).map((requirement) => ({
      tag: requirement.tag,
      action: requirement.action,
      resource: auditableResource(requirement.resource),
      evidence: requirement.evidence,
      provenance: auditableProvenance(requirement.provenance),
      provenances: (requirement.provenances ?? [requirement.provenance]).map((provenance) =>
        auditableProvenance(provenance),
      ),
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
