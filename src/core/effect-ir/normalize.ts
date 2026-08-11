import { canonicalStringify, hashValue } from '../fingerprint.js'
import type { EffectNode, EffectPlan, EffectRequirement, EffectTag } from './types.js'

export function normalizeEffectTags(tags: Iterable<EffectTag>): readonly EffectTag[] {
  const set = new Set(tags)
  if (set.has('read_only') && set.size > 1) {
    throw new Error('read_only must not co-occur with other effect tags')
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
      if (!existing) {
        seen.set(key, {
          ...req,
          provenances: uniqueProvenances(req.provenances ?? [req.provenance]),
        })
        continue
      }
      const strongest =
        evidenceRank(req.evidence.level) > evidenceRank(existing.evidence.level) ? req : existing
      seen.set(key, {
        ...strongest,
        evidence: {
          level: strongest.evidence.level,
          signals: [...new Set([...existing.evidence.signals, ...req.evidence.signals])],
          basis: [...new Set([...existing.evidence.basis, ...req.evidence.basis])],
        },
        provenances: uniqueProvenances([
          ...(existing.provenances ?? [existing.provenance]),
          ...(req.provenances ?? [req.provenance]),
        ]),
      })
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
    disposition: present.some((plan) => plan.disposition === 'effects') ? 'effects' : 'effect_free',
    completeness: present.every((plan) => plan.completeness === 'complete')
      ? 'complete'
      : 'partial',
    signals: [...new Set(present.flatMap((plan) => [...plan.signals]))].sort(),
  }
}

function uniqueProvenances(
  provenances: readonly EffectRequirement['provenance'][],
): EffectRequirement['provenance'][] {
  const seen = new Map<string, EffectRequirement['provenance']>()
  for (const provenance of provenances) {
    seen.set(canonicalStringify(provenance), provenance)
  }
  return [...seen.values()]
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
