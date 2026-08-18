import type { CapabilityResource } from '../capability/request.js'
import { collectRequirements } from './build.js'
import { joinEffectOpacity, mergeRequirements } from './normalize.js'
import type {
  AnalysisCompleteness,
  EffectNode,
  EffectPlan,
  EffectRequirement,
  ExecEffectNode,
} from './types.js'

type ShellNetworkResource = Extract<CapabilityResource, { kind: 'network' }> &
  Required<Pick<Extract<CapabilityResource, { kind: 'network' }>, 'mode' | 'payload'>>

type ShellExecutableResource = Extract<CapabilityResource, { kind: 'executable' }> &
  Required<Pick<Extract<CapabilityResource, { kind: 'executable' }>, 'operation'>>

type ShellGitRefResource = Extract<CapabilityResource, { kind: 'git-ref' }> &
  Required<Pick<Extract<CapabilityResource, { kind: 'git-ref' }>, 'scope'>>

export type ShellEffectResource =
  | Exclude<CapabilityResource, { kind: 'network' | 'executable' | 'git-ref' }>
  | ShellNetworkResource
  | ShellExecutableResource
  | ShellGitRefResource

export type ShellEffectRequirement = Omit<EffectRequirement, 'resource'> & {
  resource: ShellEffectResource
}

export interface ShellEffectSegment {
  commandRedacted: string
  segmentHead: string
  requirements: readonly ShellEffectRequirement[]
  completeness: AnalysisCompleteness
  opacity: EffectPlan['opacity']
  signals: readonly string[]
}

export interface BuildShellEffectPlanParams {
  inputFingerprint: string
  segments: readonly ShellEffectSegment[]
  signals?: readonly string[]
}

/**
 * Build a canonical EffectPlan from shell segments that have already been
 * semantically analyzed. This function only assembles and normalizes effects;
 * command-specific lowering belongs to the segment producers.
 */
export function buildShellEffectPlan(params: BuildShellEffectPlanParams): EffectPlan {
  const nodes = params.segments.map(buildSegmentNode)
  const root = mergeNodes(nodes)
  const requirements = collectRequirements(root)
  const completeness: AnalysisCompleteness = requirements.some(isIndeterminateRequirement)
    ? 'partial'
    : 'complete'

  return {
    version: 1,
    root,
    inputFingerprint: params.inputFingerprint,
    opacity: joinEffectOpacity(...params.segments.map((segment) => segment.opacity)),
    disposition: requirements.length === 0 ? 'effect_free' : 'effects',
    completeness,
    signals: [
      ...new Set([
        ...(params.signals ?? []),
        ...params.segments.flatMap((segment) => [...segment.signals]),
        ...requirements.flatMap((requirement) => [...requirement.evidence.signals]),
      ]),
    ].sort(),
  }
}

function buildSegmentNode(segment: ShellEffectSegment): ExecEffectNode {
  const requirements = mergeRequirements(segment.requirements)
  const partial =
    segment.completeness === 'partial' ||
    requirements.some((requirement) => requirement.evidence.level === 'indeterminate')
  if (partial && !requirements.some(isIndeterminateRequirement)) {
    const provenance = { segment: segment.commandRedacted }
    requirements.push({
      tag: 'indeterminate',
      action: 'indeterminate',
      resource: { kind: 'unknown' },
      evidence: {
        level: 'indeterminate',
        signals: [...new Set([...segment.signals, 'effect_plan.segment_partial'])],
        basis: [`shell_segment:${segment.segmentHead}`],
      },
      provenance,
      provenances: [provenance],
    })
  }
  return {
    kind: 'exec',
    commandRedacted: segment.commandRedacted,
    segmentHead: segment.segmentHead,
    requirements,
  }
}

function isIndeterminateRequirement(requirement: EffectRequirement): boolean {
  return requirement.tag === 'indeterminate' || requirement.action === 'indeterminate'
}

function mergeNodes(nodes: readonly ExecEffectNode[]): EffectNode {
  if (nodes.length === 1 && nodes[0]) {
    return nodes[0]
  }
  return { kind: 'merge', children: nodes }
}
