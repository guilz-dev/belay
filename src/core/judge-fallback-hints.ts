import type { ClassifyResult } from './types.js'

const INFRASTRUCTURE_FALLBACK_SUFFIXES = [
  '_cli_nonzero',
  '_cli_unavailable',
  '_cli_parse_error',
  '_cli_spawn_error',
] as const

const INFRASTRUCTURE_FALLBACK_REASONS = new Set([
  'eval_timeout',
  'connect_timeout',
  'parse_timeout',
  'session_unavailable',
  'session_disabled',
  'provider_not_allowlisted',
  'guard_reset',
  'kill_switch',
  'non_json_response',
  'parse_error',
  'cli_error',
  'timeout',
  'version_mismatch',
  'shadow_forced_spawn',
  'unsafe_option_rejected',
  'broker_busy_reset',
])

function isInfrastructureFallbackReason(reason: string): boolean {
  if (INFRASTRUCTURE_FALLBACK_REASONS.has(reason)) {
    return true
  }
  return INFRASTRUCTURE_FALLBACK_SUFFIXES.some((suffix) => reason.endsWith(suffix))
}

function infrastructureSignal(signal: string): boolean {
  return isInfrastructureFallbackReason(signal)
}

export function extractJudgeFallbackReason(
  result: Pick<ClassifyResult, 'axes' | 'assessment'>,
): string | undefined {
  if (result.axes?.judgeFallbackReason) {
    return result.axes.judgeFallbackReason
  }
  return result.assessment.signals.find((signal) => isInfrastructureFallbackReason(signal))
}

export function isJudgeInfrastructureFailure(
  result: Pick<ClassifyResult, 'axes' | 'assessment' | 'reason'>,
): boolean {
  if (result.axes?.judgeProvider === 'fallback') {
    return true
  }
  const fallbackReason = extractJudgeFallbackReason(result)
  if (fallbackReason && isInfrastructureFallbackReason(fallbackReason)) {
    return true
  }
  return result.assessment.signals.some(infrastructureSignal)
}

export function inferProviderIdFromFallbackReason(
  fallbackReason: string | undefined,
  fallbackProviderId = 'cursor',
): string {
  if (!fallbackReason) {
    return fallbackProviderId
  }
  const match = fallbackReason.match(/^(cursor|claude|codex)_/)
  return match?.[1] ?? fallbackProviderId
}

export function formatJudgeRecoveryHint(
  providerId: string,
  fallbackReason?: string,
): string | null {
  if (!fallbackReason) {
    return null
  }

  if (fallbackReason.endsWith('_cli_nonzero') || fallbackReason.endsWith('_cli_unavailable')) {
    switch (providerId) {
      case 'cursor':
        return 'Judge CLI is not authenticated. Run: agent login'
      case 'claude':
        return 'Claude CLI failed. Run: claude auth login'
      case 'codex':
        return 'Codex CLI failed. Check codex auth'
      default:
        return `Judge CLI transport failed (${fallbackReason}). Check ${providerId} CLI auth`
    }
  }

  if (fallbackReason.endsWith('_cli_parse_error')) {
    return `Judge CLI returned an invalid response (${fallbackReason}). Retry after updating the ${providerId} CLI`
  }

  if (fallbackReason.endsWith('_cli_spawn_error')) {
    return `Judge CLI could not be started (${fallbackReason}). Install or repair the ${providerId} CLI`
  }

  switch (fallbackReason) {
    case 'eval_timeout':
    case 'connect_timeout':
    case 'parse_timeout':
    case 'timeout':
      return 'Judge timed out. Check network or increase judge.timeoutMs'
    case 'session_unavailable':
    case 'session_disabled':
      return 'Judge session transport is unavailable. Run: belay doctor'
    case 'kill_switch':
      return 'Judge session kill switch is active. Run: belay judge status'
    default:
      if (isInfrastructureFallbackReason(fallbackReason)) {
        return `Judge transport failed (${fallbackReason}). Run: belay doctor`
      }
      return null
  }
}

export function formatJudgeInfrastructureDenyMessage(params: {
  providerId: string
  fallbackReason?: string
  command?: string
}): { user_message: string; agent_message: string } {
  const fallbackReason = params.fallbackReason ?? 'judge_transport_unavailable'
  const recoveryHint =
    formatJudgeRecoveryHint(params.providerId, fallbackReason) ??
    'Judge transport is unavailable. Run: belay doctor'
  const commandHint = params.command
    ? ` For details: belay explain --command "${params.command}"`
    : ' For details: belay explain'

  return {
    user_message: `Belay could not reach the Tier1 judge (${fallbackReason}). ${recoveryHint}. Then retry.${commandHint}`,
    agent_message: `Belay denied this action because the Tier1 judge transport failed (${fallbackReason}). Repair judge infrastructure, then retry the exact same action.`,
  }
}
