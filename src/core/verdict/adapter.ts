import type { BelayConfigV4 } from '../config.js'
import type { ClassifierOptions, ClassifyResult } from '../types.js'
import { judgeTraceAuditFields } from './judge-audit.js'
import { createJudgeFromConfig } from './judge-factory.js'
import type { Tier1Judge, VerdictContext, VerdictResult } from './types.js'
import { verdict } from './verdict.js'

export function resolveClassifierTrustedCwd(
  cwd: string,
  options?: Pick<ClassifierOptions, 'trustedCwd'>,
  explicit?: boolean,
): boolean {
  if (explicit !== undefined) {
    return explicit
  }
  return options?.trustedCwd ?? Boolean(cwd)
}

export function buildVerdictContext(params: {
  cwd: string
  repoRoot: string
  config: BelayConfigV4
  options?: ClassifierOptions
  judge?: Tier1Judge
  trustedCwd?: boolean
}): VerdictContext {
  const protectedArtifactRoots = [
    ...(params.options?.protectedArtifactRoots ?? []),
    ...(params.options?.controlPlaneDir ? [params.options.controlPlaneDir] : []),
  ]

  return {
    cwd: params.cwd,
    repoRoot: params.repoRoot,
    trustedCwd: resolveClassifierTrustedCwd(params.cwd, params.options, params.trustedCwd),
    sensitivePaths: params.options?.sensitivePaths ?? params.config.classifier.sensitivePaths,
    protectedArtifactRoots:
      protectedArtifactRoots.length > 0 ? [...new Set(protectedArtifactRoots)] : undefined,
    customAllowCommands: params.options?.customAllowCommands ?? params.config.overrides.allow,
    customExternalCommands:
      params.options?.customExternalCommands ?? params.config.overrides.external,
    judge: params.judge ?? params.options?.tier1Judge ?? createJudgeFromConfig(params.config),
    mode: params.config.mode,
    unknownLocalEffect:
      params.options?.unknownLocalEffect ?? params.config.policy.unknownLocalEffect,
    unparseableShell: params.options?.unparseableShell ?? params.config.policy.unparseableShell,
  }
}

export async function classifyShell(
  command: string,
  cwd: string,
  repoRoot: string,
  config: BelayConfigV4,
  options: ClassifierOptions = {},
  judge?: Tier1Judge,
): Promise<ClassifyResult> {
  const context = buildVerdictContext({ cwd, repoRoot, config, options, judge })
  const result = await verdict(command, context)
  return verdictToClassifyResult(result)
}

function mapLegacyReason(result: VerdictResult): string {
  if (result.reason === 'repo_outside_mutation') {
    return result.effect === 'read_only' ? 'outside_repo_redirect' : 'outside_repo_mutation'
  }
  if (result.reason === 'tier0_external') {
    return 'external_effect'
  }
  if (result.reason === 'high_stakes_path') {
    return 'protected_artifact'
  }
  if (
    result.reason === 'opaque_execution' &&
    /\|\s*(bash|sh|zsh|dash|fish)\b/.test(result.commandRedacted)
  ) {
    return 'pipe_to_shell'
  }
  if (result.reason === 'launcher_unresolved' || result.reason === 'makefile_missing') {
    return 'unknown_local_effect'
  }
  if (result.reason === 'npm_script_undefined' || result.reason === 'package_json_missing') {
    return 'unknown_local_effect'
  }
  if (result.reason === 'repo_local_mutation') {
    return 'local_mutation'
  }
  if (result.reason === 'tier1_not_restorable') {
    return 'tier1_catastrophic'
  }
  if (result.reason === 'tier0_restorable' || result.reason === 'tier1_restorable') {
    return result.effect === 'local_mutation' ? 'local_mutation' : result.reason
  }
  return result.reason
}

export function verdictToClassifyResult(result: VerdictResult): ClassifyResult {
  const external =
    result.location === 'external' ||
    result.location === 'repo_outside' ||
    result.effect === 'remote_mutation'

  const legacyReason = mapLegacyReason(result)

  const hookVerdict =
    result.permission === 'ask'
      ? 'deny_pending_approval'
      : legacyReason === 'command_substitution' ||
          legacyReason === 'unknown_local_effect' ||
          legacyReason === 'unparseable_shell' ||
          result.effect === 'local_mutation'
        ? 'allow_flagged'
        : 'allow'

  const assessment = {
    reversibility:
      result.effect === 'read_only'
        ? ('reversible' as const)
        : result.permission === 'allow'
          ? ('recoverable_with_cost' as const)
          : ('irreversible' as const),
    external,
    blastRadius: result.location,
    confidence:
      result.confidence === 'deterministic'
        ? 0.95
        : result.confidence === 'llm'
          ? 0.75
          : hookVerdict === 'allow_flagged'
            ? 0.75
            : 0.7,
    signals: result.signals,
  }

  return {
    verdict: hookVerdict,
    reason: legacyReason,
    fingerprint: result.fingerprint,
    assessment,
    normalizedCommand: result.commandRedacted,
    summary: result.commandRedacted,
    axes: {
      location: result.location,
      opacity: result.opacity,
      effect: result.effect,
      confidence: result.confidence,
      would: result.permission,
      by: 'verdict',
      commandRedacted: result.commandRedacted,
      commandFingerprint: result.fingerprint,
      signals: result.signals,
      ...judgeTraceAuditFields(result.judgeTrace),
    },
  }
}

export function verdictAuditFields(result: VerdictResult): Record<string, unknown> {
  return {
    schemaVersion: 2,
    commandRedacted: result.commandRedacted,
    commandFingerprint: result.fingerprint,
    location: result.location,
    opacity: result.opacity,
    effect: result.effect,
    confidence: result.confidence,
    would: result.permission,
    by: 'verdict',
    signals: result.signals,
    ...judgeTraceAuditFields(result.judgeTrace),
  }
}
