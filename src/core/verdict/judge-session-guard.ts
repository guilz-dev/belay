import type { JudgeProviderId } from './judge-catalog.js'
import type { BelayJudgeSessionConfig } from './judge-runtime-config.js'

export type JudgeSessionResetReason =
  | 'provider_mismatch'
  | 'model_mismatch'
  | 'repo_mismatch'
  | 'mode_mismatch'
  | 'cli_version_mismatch'
  | 'max_turns_exceeded'
  | 'max_age_exceeded'
  | 'max_idle_exceeded'
  | 'max_prompt_bytes_exceeded'
  | 'parse_failure'
  | 'non_json_response'
  | 'cli_error'
  | 'timeout'
  | 'kill_switch'
  | 'manual_stop'
  | 'budget_exhausted'
  | 'session_disabled'
  | 'provider_not_allowlisted'
  | 'initial'

export type JudgeFallbackReason =
  | 'session_disabled'
  | 'provider_not_allowlisted'
  | 'session_unavailable'
  | 'guard_reset'
  | 'parse_error'
  | 'non_json_response'
  | 'cli_error'
  | 'timeout'
  | 'connect_timeout'
  | 'eval_timeout'
  | 'parse_timeout'
  | 'version_mismatch'
  | 'kill_switch'
  | 'shadow_forced_spawn'
  | 'unsafe_option_rejected'
  | 'broker_busy_reset'
  | `${Exclude<JudgeProviderId, 'ollama'>}_cli_spawn_error`
  | `${Exclude<JudgeProviderId, 'ollama'>}_cli_nonzero`
  | `${Exclude<JudgeProviderId, 'ollama'>}_cli_unavailable`
  | `${Exclude<JudgeProviderId, 'ollama'>}_cli_parse_error`

export interface JudgeSessionKeyParts {
  providerId: JudgeProviderId
  model: string
  repoRoot: string
  judgeMode: string
  cliVersion: string
}

export interface JudgeSessionBudget {
  turnCount: number
  createdAtMs: number
  lastUsedAtMs: number
  promptBytes: number
}

export interface JudgeSessionGuardDecision {
  canReuse: boolean
  resetReason?: JudgeSessionResetReason
  sessionKey: string
}

export function buildJudgeSessionKey(parts: JudgeSessionKeyParts): string {
  return [parts.providerId, parts.model, parts.repoRoot, parts.judgeMode, parts.cliVersion].join(
    ':',
  )
}

export function evaluateSessionReuse(
  existing: JudgeSessionKeyParts | null,
  requested: JudgeSessionKeyParts,
  budget: JudgeSessionBudget | null,
  config: BelayJudgeSessionConfig,
  now = Date.now(),
  incomingPromptBytes = 0,
): JudgeSessionGuardDecision {
  const sessionKey = buildJudgeSessionKey(requested)

  if (!config.enabled) {
    return { canReuse: false, resetReason: 'session_disabled', sessionKey }
  }

  if (!config.providerAllowlist.includes(requested.providerId)) {
    return { canReuse: false, resetReason: 'provider_not_allowlisted', sessionKey }
  }

  if (!existing || !budget) {
    return { canReuse: false, resetReason: 'initial', sessionKey }
  }

  const existingKey = buildJudgeSessionKey(existing)
  if (existingKey !== sessionKey) {
    if (existing.providerId !== requested.providerId) {
      return { canReuse: false, resetReason: 'provider_mismatch', sessionKey }
    }
    if (existing.model !== requested.model) {
      return { canReuse: false, resetReason: 'model_mismatch', sessionKey }
    }
    if (existing.repoRoot !== requested.repoRoot) {
      return { canReuse: false, resetReason: 'repo_mismatch', sessionKey }
    }
    if (existing.judgeMode !== requested.judgeMode) {
      return { canReuse: false, resetReason: 'mode_mismatch', sessionKey }
    }
    if (existing.cliVersion !== requested.cliVersion) {
      return { canReuse: false, resetReason: 'cli_version_mismatch', sessionKey }
    }
    return { canReuse: false, resetReason: 'provider_mismatch', sessionKey }
  }

  if (budget.turnCount >= config.maxTurns) {
    return { canReuse: false, resetReason: 'max_turns_exceeded', sessionKey }
  }
  if (now - budget.createdAtMs >= config.maxAgeMs) {
    return { canReuse: false, resetReason: 'max_age_exceeded', sessionKey }
  }
  if (now - budget.lastUsedAtMs >= config.maxIdleMs) {
    return { canReuse: false, resetReason: 'max_idle_exceeded', sessionKey }
  }
  if (budget.promptBytes + incomingPromptBytes > config.maxPromptBytes) {
    return { canReuse: false, resetReason: 'max_prompt_bytes_exceeded', sessionKey }
  }

  return { canReuse: true, sessionKey }
}

export function exceedsPromptBudget(
  promptBytes: number,
  config: BelayJudgeSessionConfig,
  existingBudget: JudgeSessionBudget | null = null,
): boolean {
  const total = (existingBudget?.promptBytes ?? 0) + promptBytes
  return total > config.maxPromptBytes
}

export function guardFailClosedFallbackReason(
  resetReason: JudgeSessionResetReason,
): JudgeFallbackReason {
  switch (resetReason) {
    case 'parse_failure':
      return 'parse_error'
    case 'non_json_response':
      return 'non_json_response'
    case 'cli_error':
      return 'cli_error'
    case 'timeout':
      return 'timeout'
    case 'cli_version_mismatch':
      return 'version_mismatch'
    case 'kill_switch':
      return 'kill_switch'
    case 'session_disabled':
      return 'session_disabled'
    case 'provider_not_allowlisted':
      return 'provider_not_allowlisted'
    case 'max_prompt_bytes_exceeded':
      return 'guard_reset'
    default:
      return 'guard_reset'
  }
}

export function transportFallbackToFailClosedReason(
  providerId: Exclude<JudgeProviderId, 'ollama'>,
  fallback: JudgeFallbackReason | undefined,
): string {
  if (!fallback) {
    return `${providerId}_cli_parse_error`
  }
  if (fallback.endsWith('_cli_unavailable') || fallback.endsWith('_cli_parse_error')) {
    return fallback
  }
  switch (fallback) {
    case 'non_json_response':
    case 'parse_error':
    case 'parse_timeout':
      return `${providerId}_cli_parse_error`
    default:
      return `${providerId}_cli_unavailable`
  }
}
