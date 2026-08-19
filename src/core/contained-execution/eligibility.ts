import path from 'node:path'

import type { BelayConfigV3 } from '../config.js'
import { collectRequirements } from '../effect-ir/build.js'
import type { EffectPlan, EffectRequirement } from '../effect-ir/types.js'
import type { GatedAction } from '../gate-contract.js'
import { resolveWorkspaceRootMatch } from '../path-utils.js'
import type { ClassifyResult } from '../types.js'

const FORBIDDEN_SIGNALS = new Set([
  'command_substitution',
  'control_plane_mutation',
  'dynamic_shell_evaluation',
  'high_stakes_path',
  'pipe_to_shell',
  'secret_payload_send',
  'shell.xargs_stdin_dynamic',
  'sensitive_path_read',
  'tier0_external',
  'tier1_catastrophic',
  'unparseable_shell',
])

/**
 * Returns whether an unknown shell EffectPlan can be mediated by the contained
 * execution boundary. This only interprets normalized effects and gate context;
 * it never derives authority from command syntax or command identity.
 */
export function isContainedUnknownExecutionEligible(
  config: BelayConfigV3,
  action: Pick<GatedAction, 'kind' | 'repoRoot'>,
  result: ClassifyResult,
): boolean {
  const contained = config.sandbox.containedExecution
  if (
    !contained?.enabled ||
    !config.sandbox.enabled ||
    config.sandbox.runtime !== 'container' ||
    action.kind !== 'shell' ||
    !path.isAbsolute(action.repoRoot) ||
    !hasResolvedRepoIdentity(action.repoRoot) ||
    !config.gates.shell ||
    result.reason !== 'unknown_local_effect' ||
    result.axes?.location !== 'repo_local' ||
    result.assessment.external
  ) {
    return false
  }

  const plan = result.effectPlan
  if (!plan || (plan.opacity !== 'transparent' && plan.opacity !== 'recursive')) {
    return false
  }

  const requirements = collectRequirements(plan.root)
  if (
    requirements.length === 0 ||
    !hasSafeRecursiveExpansion(plan, requirements) ||
    !requirements.some((requirement) => requirement.action === 'process.exec') ||
    requirements.some((requirement) => !isPermittedRequirement(requirement, action.repoRoot))
  ) {
    return false
  }

  return !collectSignals(result, requirements).some(isForbiddenSignal)
}

function hasSafeRecursiveExpansion(
  plan: EffectPlan,
  requirements: readonly EffectRequirement[],
): boolean {
  if (plan.opacity === 'transparent') {
    return true
  }
  return requirements.some((requirement) =>
    (requirement.provenances ?? [requirement.provenance]).some(
      (provenance) => typeof provenance.innerCommand === 'string' && provenance.innerCommand !== '',
    ),
  )
}

function isPermittedRequirement(requirement: EffectRequirement, repoRoot: string): boolean {
  if (requirement.tag === 'indeterminate' || requirement.action === 'indeterminate') {
    return (
      requirement.tag === 'indeterminate' &&
      requirement.action === 'indeterminate' &&
      requirement.resource.kind === 'unknown'
    )
  }

  if (requirement.tag === 'process.exec' && requirement.action === 'process.exec') {
    return (
      requirement.resource.kind === 'executable' &&
      (requirement.resource.operation === 'inspect' || requirement.resource.operation === 'spawn')
    )
  }

  return (
    ((requirement.tag === 'fs.read' && requirement.action === 'fs.read') ||
      (requirement.tag === 'fs.write' && requirement.action === 'fs.write')) &&
    requirement.resource.kind === 'path' &&
    isRepoLocalPath(repoRoot, requirement.resource.path)
  )
}

function isRepoLocalPath(repoRoot: string, targetPath: string): boolean {
  try {
    return resolveWorkspaceRootMatch(repoRoot, [], targetPath)?.kind === 'repo'
  } catch {
    return false
  }
}

function hasResolvedRepoIdentity(repoRoot: string): boolean {
  try {
    const match = resolveWorkspaceRootMatch(repoRoot, [], repoRoot)
    return match?.kind === 'repo' && match.relativePath === '.'
  } catch {
    return false
  }
}

function collectSignals(
  result: ClassifyResult,
  requirements: readonly EffectRequirement[],
): readonly string[] {
  return [
    ...new Set([
      ...result.assessment.signals,
      ...(result.axes?.signals ?? []),
      ...(result.effectPlan?.signals ?? []),
      ...requirements.flatMap((requirement) => requirement.evidence.signals),
    ]),
  ]
}

function isForbiddenSignal(signal: string): boolean {
  return (
    FORBIDDEN_SIGNALS.has(signal) ||
    signal.startsWith('tier0_') ||
    signal.startsWith('tier1_') ||
    signal.includes('high_stakes') ||
    signal.includes('control_plane')
  )
}
