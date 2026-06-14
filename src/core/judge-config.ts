import type { BelayJudgeConfig, JudgeCloudConsent, JudgeProviderId } from './config.js'
import { normalizeJudgeProvider } from './config.js'
import {
  type JudgeProviderId as CatalogId,
  catalogRequiresEndpoint,
  getJudgeProviderSpec,
  isCloudProviderId,
  isJudgeProviderId,
  JUDGE_PROVIDER_IDS,
  resolveJudgeFromCatalog,
} from './verdict/judge-catalog.js'

export type JudgeProfileName = 'local-ollama' | 'cursor' | 'claude' | 'codex'

const PROFILE_TO_PROVIDER_ID: Record<JudgeProfileName, JudgeProviderId> = {
  'local-ollama': 'local',
  cursor: 'cursor',
  claude: 'openai',
  codex: 'openai',
}

export const JUDGE_PROFILE_LOCAL_OLLAMA: BelayJudgeConfig = resolveJudgeFromCatalog({
  providerId: 'local',
})

export const JUDGE_PROFILE_CURSOR: BelayJudgeConfig = {
  ...resolveJudgeFromCatalog({ providerId: 'openai' }),
  model: 'auto',
}

export const JUDGE_PROFILE_CLAUDE: BelayJudgeConfig = { ...JUDGE_PROFILE_CURSOR }

export const JUDGE_PROFILE_CODEX: BelayJudgeConfig = { ...JUDGE_PROFILE_CURSOR }

export const JUDGE_PROFILES: Record<JudgeProfileName, BelayJudgeConfig> = {
  'local-ollama': JUDGE_PROFILE_LOCAL_OLLAMA,
  cursor: JUDGE_PROFILE_CURSOR,
  claude: JUDGE_PROFILE_CLAUDE,
  codex: JUDGE_PROFILE_CODEX,
}

export interface ResolveJudgeConfigInput {
  judgeProfile?: JudgeProfileName
  judgeProvider?: 'ollama' | 'openai-compatible' | 'cursor'
  judgeProviderId?: JudgeProviderId
  judgeModel?: string
  judgeEndpoint?: string
  existingJudge?: BelayJudgeConfig
}

function warnDeprecated(message: string): void {
  process.stderr.write(`Warning: ${message}\n`)
}

export function resolveJudgeConfig(input: ResolveJudgeConfigInput = {}): BelayJudgeConfig {
  if (input.judgeProviderId && isJudgeProviderId(input.judgeProviderId)) {
    return resolveJudgeFromCatalog({
      providerId: input.judgeProviderId,
      model: input.judgeModel,
      endpoint: input.judgeEndpoint,
    })
  }

  if (input.judgeProvider) {
    const rawProvider = input.judgeProvider
    const provider = normalizeJudgeProvider(rawProvider)
    const providerId: CatalogId =
      rawProvider === 'cursor' ? 'cursor' : provider === 'ollama' ? 'local' : 'openai'
    return resolveJudgeFromCatalog({
      providerId,
      model: input.judgeModel,
      endpoint: input.judgeEndpoint,
    })
  }

  if (input.judgeProfile) {
    warnDeprecated(
      `--judge-profile is deprecated; use belay judge use <provider-id> (${JUDGE_PROVIDER_IDS.join(', ')}).`,
    )
    const providerId = PROFILE_TO_PROVIDER_ID[input.judgeProfile]
    const base = resolveJudgeFromCatalog({
      providerId,
      model: input.judgeModel,
      endpoint: input.judgeEndpoint,
    })
    if (input.judgeProfile === 'cursor') {
      return {
        ...base,
        providerId: 'cursor',
        model: input.judgeModel ?? 'composer-2.5',
        endpoint: input.judgeEndpoint?.trim() ?? null,
      }
    }
    return base
  }

  if (input.existingJudge) {
    return { ...input.existingJudge }
  }

  return { ...JUDGE_PROFILE_LOCAL_OLLAMA }
}

export class CloudJudgeConsentRequiredError extends Error {
  constructor(details?: { consent?: boolean; key?: boolean; localFallback?: boolean }) {
    const parts: string[] = []
    if (details?.consent !== false) {
      parts.push(
        'Cloud judge requires recorded consent (interactive TTY with --accept-cloud, or judge_cloud_consent capability approval).',
      )
    }
    if (details?.key !== false) {
      parts.push('Set provider API keys via env or belay judge use --credential apiKey.')
    }
    if (details?.localFallback !== false) {
      parts.push('Use belay judge use local for local-only Tier1.')
    }
    super(parts.join(' '))
    this.name = 'CloudJudgeConsentRequiredError'
  }
}

export class JudgeEndpointRequiredError extends Error {
  constructor(providerId?: JudgeProviderId) {
    super(
      providerId === 'cursor' || providerId === 'custom'
        ? `${providerId} judge requires --endpoint (or judge.endpoint in config).`
        : 'openai-compatible judge requires --judge-endpoint (or judge.endpoint in config). No default cloud base URL is applied.',
    )
    this.name = 'JudgeEndpointRequiredError'
  }
}

export function isCloudJudgeConfig(judge: BelayJudgeConfig): boolean {
  if (judge.providerId) {
    return isCloudProviderId(judge.providerId)
  }
  return judge.provider === 'openai-compatible'
}

export function hasValidCloudConsent(judge: BelayJudgeConfig): boolean {
  if (!judge.cloudConsent?.accepted) {
    return false
  }
  if (!judge.endpoint?.trim()) {
    return false
  }
  const providerId = judge.providerId ?? (judge.provider === 'ollama' ? 'local' : 'openai')
  return (
    judge.cloudConsent.endpoint === judge.endpoint.trim() &&
    judge.cloudConsent.providerId === providerId
  )
}

export function assertJudgeEndpoint(judge: BelayJudgeConfig): void {
  const providerId = judge.providerId ?? (judge.provider === 'ollama' ? 'local' : 'openai')
  if (catalogRequiresEndpoint(providerId) && !judge.endpoint?.trim()) {
    throw new JudgeEndpointRequiredError(providerId)
  }
  if (judge.provider === 'openai-compatible' && !judge.endpoint?.trim()) {
    throw new JudgeEndpointRequiredError(providerId)
  }
}

export function resolveInitJudgeConfig(input: {
  isFresh: boolean
  hasExplicitJudgeFlags: boolean
  judgeProfile?: JudgeProfileName
  judgeProvider?: 'ollama' | 'openai-compatible' | 'cursor'
  judgeProviderId?: JudgeProviderId
  judgeModel?: string
  judgeEndpoint?: string
  acceptCloudJudge?: boolean
  interactiveConsent?: boolean
  cloudConsentApprovalId?: string
  existingJudge?: BelayJudgeConfig
  defaultJudgeProfile?: JudgeProfileName
}): BelayJudgeConfig {
  if (input.hasExplicitJudgeFlags) {
    const judge = resolveJudgeConfig({
      judgeProfile: input.judgeProfile,
      judgeProvider: input.judgeProvider,
      judgeProviderId: input.judgeProviderId,
      judgeModel: input.judgeModel,
      judgeEndpoint: input.judgeEndpoint,
    })
    assertJudgeEndpoint(judge)
    if (isCloudJudgeConfig(judge) && judge.endpoint?.trim()) {
      if (input.cloudConsentApprovalId) {
        return applyCloudConsent(judge, {
          by: `capability-approval:${input.cloudConsentApprovalId}`,
        })
      }
      if (input.acceptCloudJudge && input.interactiveConsent) {
        return applyCloudConsent(judge, { by: 'tty' })
      }
    }
    return judge
  }

  if (!input.isFresh && input.existingJudge) {
    const judge = resolveJudgeConfig({ existingJudge: input.existingJudge })
    assertJudgeEndpoint(judge)
    return judge
  }

  return resolveJudgeConfig({ judgeProviderId: 'local' })
}

export function applyCloudConsent(
  judge: BelayJudgeConfig,
  params: { by: string },
): BelayJudgeConfig {
  const providerId = judge.providerId ?? 'openai'
  const endpoint = judge.endpoint?.trim()
  if (!endpoint) {
    return judge
  }
  const cloudConsent: JudgeCloudConsent = {
    accepted: true,
    at: new Date().toISOString(),
    providerId,
    endpoint,
    by: params.by,
  }
  return { ...judge, cloudConsent }
}

export interface JudgeUseOptions {
  providerId: JudgeProviderId
  model?: string
  endpoint?: string
  timeoutMs?: number
  acceptCloud?: boolean
  cloudConsentApprovalId?: string
  credentialMode?: 'project' | 'apiKey'
  keyEnv?: string
  interactiveTTY?: boolean
  interactiveConsentApproved?: boolean
}

export function resolveJudgeUsePatch(
  existing: BelayJudgeConfig,
  options: JudgeUseOptions,
): { judge: BelayJudgeConfig; warnings: string[]; errors: string[] } {
  const warnings: string[] = []
  const errors: string[] = []
  const spec = getJudgeProviderSpec(options.providerId)
  if (!spec) {
    errors.push(`Unknown judge provider id: ${options.providerId}`)
    return { judge: existing, warnings, errors }
  }

  let judge = resolveJudgeFromCatalog({
    providerId: options.providerId,
    model:
      options.model ?? (existing.providerId === options.providerId ? existing.model : undefined),
    endpoint:
      options.endpoint !== undefined
        ? options.endpoint
        : existing.providerId === options.providerId
          ? existing.endpoint
          : undefined,
    timeoutMs: options.timeoutMs ?? existing.timeoutMs,
    keepAlive: existing.keepAlive,
  })

  if (catalogRequiresEndpoint(options.providerId) && !judge.endpoint?.trim()) {
    errors.push(`${options.providerId} requires --endpoint.`)
  }

  if (options.providerId === 'custom' && !judge.model?.trim()) {
    errors.push('custom requires --model.')
  }

  if (options.credentialMode === 'apiKey') {
    judge = {
      ...judge,
      credential: options.keyEnv
        ? { mode: 'apiKey', ref: `env:${options.keyEnv}` }
        : { mode: 'apiKey', ref: 'store:judge' },
    }
  } else if (options.credentialMode === 'project') {
    judge = { ...judge, credential: { mode: 'project' } }
  } else if (existing.credential) {
    judge = { ...judge, credential: existing.credential }
  }

  const needsNewConsent =
    spec.isCloud &&
    (!existing.cloudConsent?.accepted ||
      existing.cloudConsent.endpoint !== judge.endpoint?.trim() ||
      existing.cloudConsent.providerId !== options.providerId)

  if (spec.isCloud && needsNewConsent) {
    if (options.cloudConsentApprovalId) {
      judge = applyCloudConsent(judge, {
        by: `capability-approval:${options.cloudConsentApprovalId}`,
      })
    } else if (
      options.acceptCloud &&
      options.interactiveTTY &&
      options.interactiveConsentApproved
    ) {
      judge = applyCloudConsent(judge, { by: 'tty' })
    } else if (options.acceptCloud && options.interactiveTTY) {
      warnings.push('Cloud consent not recorded (--accept-cloud requires confirmation).')
    } else if (options.acceptCloud && !options.interactiveTTY) {
      warnings.push(
        'Cloud consent not recorded in non-interactive mode. Pass --cloud-consent-approval-id after judge_cloud_consent approval.',
      )
    } else if (!existing.cloudConsent?.accepted) {
      warnings.push('Cloud judge will remain disabled until consent is recorded.')
    }
  } else if (existing.cloudConsent?.accepted && spec.isCloud) {
    judge = { ...judge, cloudConsent: existing.cloudConsent }
  }

  return { judge, warnings, errors }
}
