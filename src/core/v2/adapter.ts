import type { BelayConfigV3 } from '../config.js'
import type { ClassifierOptions, ClassifyResult } from '../types.js'
import { createDeterministicJudgeStub, createOllamaJudge } from './judge.js'
import type { Tier1Judge, VerdictContext, VerdictResult } from './types.js'
import { verdict } from './verdict.js'

export function buildVerdictContext(params: {
  cwd: string
  repoRoot: string
  config: BelayConfigV3
  options?: ClassifierOptions
  judge?: Tier1Judge
  trustedCwd?: boolean
}): VerdictContext {
  return {
    cwd: params.cwd,
    repoRoot: params.repoRoot,
    trustedCwd: params.trustedCwd ?? Boolean(params.cwd),
    sensitivePaths: params.options?.sensitivePaths ?? params.config.classifier.sensitivePaths,
    protectedArtifactRoots: params.options?.protectedArtifactRoots,
    judge:
      params.judge ??
      (params.config.policy.modelAssist.enabled
        ? createOllamaJudge(params.config.policy.modelAssist.model)
        : createDeterministicJudgeStub()),
    mode: params.config.mode,
  }
}

export async function classifyShellV2(
  command: string,
  cwd: string,
  repoRoot: string,
  config: BelayConfigV3,
  options: ClassifierOptions = {},
  judge?: Tier1Judge,
): Promise<ClassifyResult> {
  const context = buildVerdictContext({ cwd, repoRoot, config, options, judge })
  const result = await verdict(command, context)
  return verdictToClassifyResult(result)
}

export function verdictToClassifyResult(result: VerdictResult): ClassifyResult {
  const external =
    result.location === 'external' ||
    result.location === 'repo_outside' ||
    result.effect === 'remote_mutation'

  const hookVerdict =
    result.permission === 'allow'
      ? result.effect === 'local_mutation'
        ? 'allow_flagged'
        : 'allow'
      : 'deny_pending_approval'

  const legacyReason =
    result.reason === 'repo_outside_mutation'
      ? result.effect === 'read_only'
        ? 'outside_repo_redirect'
        : 'outside_repo_mutation'
      : result.reason === 'tier0_external'
        ? 'external_effect'
        : result.reason === 'high_stakes_path'
          ? 'protected_artifact'
          : result.reason

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
    v2: {
      location: result.location,
      opacity: result.opacity,
      effect: result.effect,
      confidence: result.confidence,
      would: result.permission,
      by: 'v2',
      commandRedacted: result.commandRedacted,
      commandFingerprint: result.fingerprint,
      signals: result.signals,
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
    by: 'v2',
    signals: result.signals,
  }
}
