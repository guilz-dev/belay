import { collectRequirements } from '../effect-ir/build.js'
import type { EffectPlan, EffectRequirement } from '../effect-ir/types.js'
import { canonicalStringify } from '../fingerprint.js'

export interface AuthorizationProjection {
  completeness: EffectPlan['completeness']
  opacity: EffectPlan['opacity']
  signals: readonly string[]
  requirements: readonly string[]
}

/** Compare authorization-relevant projections. Raw commands and ASTs are not retained. */
export function projectAuthorization(plan: EffectPlan): AuthorizationProjection {
  return {
    completeness: plan.completeness,
    opacity: plan.opacity,
    signals: [...plan.signals].sort(),
    requirements: collectRequirements(plan.root).map(projectRequirement).sort(),
  }
}

export function authorizationProjectionsEqual(left: EffectPlan, right: EffectPlan): boolean {
  return (
    canonicalStringify(projectAuthorization(left)) ===
    canonicalStringify(projectAuthorization(right))
  )
}

function projectRequirement(requirement: EffectRequirement): string {
  return canonicalStringify({
    tag: requirement.tag,
    action: requirement.action,
    resource: requirement.resource,
    level: requirement.evidence.level,
    signals: [...requirement.evidence.signals].sort(),
  })
}
