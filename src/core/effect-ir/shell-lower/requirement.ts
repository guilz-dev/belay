import type { ShellEffectRequirement } from '../shell-build.js'
import type { EffectProvenance } from '../types.js'

export const SECRET_PATH_PATTERN =
  /(?:^|[/\\])(?:\.env(?:\..*)?|credentials?|secrets?|id_rsa)(?:$|[/\\])/i
export const CONTROL_PLANE_PATH_PATTERN =
  /^(?:\/etc(?:\/|$)|\/var\/run(?:\/|$)|.*(?:^|[/\\])\.(?:git|ssh|cursor|claude)(?:[/\\]|$))/

export function requirement(
  tag: ShellEffectRequirement['tag'],
  action: ShellEffectRequirement['action'],
  resource: ShellEffectRequirement['resource'],
  segment: string,
  signals: string[],
): ShellEffectRequirement {
  return {
    tag,
    action,
    resource,
    evidence: {
      level: tag === 'indeterminate' ? 'indeterminate' : 'certain',
      signals: [...new Set(signals)].sort(),
      basis: ['shell_semantic_lowering'],
    },
    provenance: { segment },
  }
}

export function processRequirement(
  command: string,
  operation: 'inspect' | 'spawn',
  segment: string,
  signals: string[],
): ShellEffectRequirement {
  return requirement(
    'process.exec',
    'process.exec',
    { kind: 'executable', command, operation },
    segment,
    signals,
  )
}

export function unsupportedProcess(
  command: string,
  segment: string,
  signal: string,
): ShellEffectRequirement[] {
  return [
    processRequirement(command, 'spawn', segment, [signal]),
    requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, segment, [signal]),
  ]
}

export function addWriteEffects(
  requirements: ShellEffectRequirement[],
  resolved: string,
  segment: string,
  signals: string[],
): void {
  requirements.push(
    requirement('fs.write', 'fs.write', { kind: 'path', path: resolved }, segment, signals),
  )
  if (CONTROL_PLANE_PATH_PATTERN.test(resolved)) {
    requirements.push(
      requirement(
        'control_plane.write',
        'control_plane.write',
        { kind: 'path', path: resolved },
        segment,
        [...signals, 'protected_path'],
      ),
    )
  }
}

export function addSecretRead(
  requirements: ShellEffectRequirement[],
  resolved: string,
  segment: string,
): void {
  if (SECRET_PATH_PATTERN.test(resolved)) {
    requirements.push(
      requirement('secret.read', 'secret.read', { kind: 'path', path: resolved }, segment, [
        'secret_path_read',
      ]),
    )
  }
}

export function ensureRequirement(
  requirements: ShellEffectRequirement[],
  candidate: ShellEffectRequirement,
): void {
  if (
    !requirements.some(
      (entry) =>
        entry.action === candidate.action &&
        JSON.stringify(entry.resource) === JSON.stringify(candidate.resource),
    )
  ) {
    requirements.push(candidate)
  }
}

export function withProvenances(
  requirementValue: ShellEffectRequirement,
  provenance: EffectProvenance,
  contributing: EffectProvenance,
): ShellEffectRequirement {
  const provenances = [
    ...(requirementValue.provenances ?? [requirementValue.provenance]),
    contributing,
    provenance,
  ].filter(
    (candidate, index, all) =>
      all.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(candidate)) === index,
  )
  return { ...requirementValue, provenance, provenances }
}

export function withInnerProvenance(
  requirementValue: ShellEffectRequirement,
  innerCommand: string,
  launcher: string,
  outerSegment: string,
): ShellEffectRequirement {
  const provenance: EffectProvenance = {
    ...requirementValue.provenance,
    segment: outerSegment,
    innerCommand: requirementValue.provenance.innerCommand ?? innerCommand,
    ...(launcher === 'npm' || launcher === 'pnpm' ? { launcher, phase: 'delegate' as const } : {}),
  }
  const launcherProvenance: EffectProvenance = {
    segment: outerSegment,
    innerCommand,
    ...(launcher === 'npm' || launcher === 'pnpm' ? { launcher, phase: 'delegate' as const } : {}),
  }
  return withProvenances(requirementValue, provenance, launcherProvenance)
}
