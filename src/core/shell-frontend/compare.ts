import { collectRequirements } from '../effect-ir/build.js'
import type { EffectNode, EffectPlan, EffectRequirement } from '../effect-ir/types.js'
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

/** Keep every requirement already on the candidate and fail closed on mismatch. */
export function appendParserDisagreement(plan: EffectPlan): EffectPlan {
  const signal = 'parser.disagreement'
  return {
    ...plan,
    completeness: 'partial',
    signals: [...new Set([...plan.signals, signal])].sort(),
    root: addDisagreement(plan.root, signal),
  }
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

function addDisagreement(node: EffectNode, signal: string): EffectNode {
  const marker: EffectNode = {
    kind: 'exec',
    commandRedacted: '',
    segmentHead: '',
    requirements: [
      {
        tag: 'indeterminate',
        action: 'indeterminate',
        resource: { kind: 'unknown' },
        evidence: {
          level: 'indeterminate',
          signals: [signal],
          basis: ['shell_semantic_lowering'],
        },
        provenance: { segment: '' },
      },
    ],
  }
  if (node.kind === 'merge' || node.kind === 'launcher') {
    return { ...node, children: [...node.children, marker] }
  }
  return { kind: 'merge', children: [node, marker] }
}
