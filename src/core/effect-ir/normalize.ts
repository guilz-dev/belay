import { canonicalStringify, hashValue } from '../fingerprint.js'
import type { EffectNode, EffectPlan, EffectRequirement, EffectTag } from './types.js'

export function normalizeEffectTags(tags: Iterable<EffectTag>): readonly EffectTag[] {
  const set = new Set(tags)
  if (set.has('read_only') && set.size > 1) {
    throw new Error('read_only must not co-occur with other effect tags')
  }
  if (set.has('indeterminate') && set.size > 1) {
    throw new Error('indeterminate must not co-occur with other effect tags')
  }
  return [...set].sort()
}

export function mergeRequirements(
  ...groups: readonly (readonly EffectRequirement[])[]
): EffectRequirement[] {
  const seen = new Map<string, EffectRequirement>()
  for (const group of groups) {
    for (const req of group) {
      const key = `${req.action}:${req.resource.kind}:${resourceKey(req.resource)}`
      const existing = seen.get(key)
      if (!existing || evidenceRank(req.evidence.level) > evidenceRank(existing.evidence.level)) {
        seen.set(key, req)
        continue
      }
      if (evidenceRank(req.evidence.level) === evidenceRank(existing.evidence.level)) {
        seen.set(key, {
          ...existing,
          evidence: {
            ...existing.evidence,
            signals: [...new Set([...existing.evidence.signals, ...req.evidence.signals])],
            basis: [...new Set([...existing.evidence.basis, ...req.evidence.basis])],
          },
        })
      }
    }
  }
  return [...seen.values()]
}

export function mergeEffectPlans(
  ...plans: readonly (EffectPlan | null | undefined)[]
): EffectPlan | undefined {
  const present = plans.filter((plan): plan is EffectPlan => plan !== null && plan !== undefined)
  if (!present.length) {
    return undefined
  }
  if (present.length === 1) {
    return present[0]
  }
  const children: EffectNode[] = present.flatMap((plan) =>
    plan.root.kind === 'merge' ? [...plan.root.children] : [plan.root],
  )
  const opacity = present.some((plan) => plan.opacity === 'unparseable')
    ? 'unparseable'
    : present.some((plan) => plan.opacity === 'opaque')
      ? 'opaque'
      : present.some((plan) => plan.opacity === 'recursive')
        ? 'recursive'
        : 'transparent'
  const fingerprints = present.map((plan) => plan.inputFingerprint).sort()
  return {
    version: 1,
    root: { kind: 'merge', children },
    inputFingerprint: hashValue(`effect-plan-input:v1:${canonicalStringify(fingerprints)}`),
    opacity,
    signals: [...new Set(present.flatMap((plan) => [...plan.signals]))].sort(),
  }
}

function resourceKey(resource: EffectRequirement['resource']): string {
  switch (resource.kind) {
    case 'path':
      return resource.path
    case 'network':
      return `${resource.host}:${resource.port ?? ''}:${resource.protocol ?? ''}`
    case 'executable':
      return resource.command
    case 'package-cache':
      return resource.manager
    case 'git-ref':
      return resource.ref
    case 'unknown':
      return 'unknown'
    default:
      return 'unknown'
  }
}

function evidenceRank(level: EffectRequirement['evidence']['level']): number {
  switch (level) {
    case 'certain':
      return 3
    case 'possible':
      return 2
    case 'indeterminate':
      return 1
    default:
      return 0
  }
}
