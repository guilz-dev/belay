import type { AdapterName } from '../adapters/layouts/types.js'
import type { BelayJudgeConfig, JudgeCloudConsent, JudgeProviderId } from './config.js'
import { normalizeJudgeProvider } from './config.js'
import { rejectDeprecatedJudgeModelAuto } from './judge-model-policy.js'
import { detectJudgeRuntimeCapabilities } from './judge-runtime-detection.js'
import {
  catalogRequiresEndpoint,
  getJudgeProviderSpec,
  isCloudProviderId,
  isJudgeProviderId,
  JUDGE_PROVIDER_IDS,
  normalizeLegacyProviderId,
  resolveJudgeFromCatalog,
} from './verdict/judge-catalog.js'

export type JudgeProfileName = 'local-ollama' | 'cursor' | 'claude' | 'codex'

const PROFILE_TO_PROVIDER_ID: Record<JudgeProfileName, JudgeProviderId> = {
  'local-ollama': 'ollama',
  cursor: 'cursor',
  claude: 'claude',
  codex: 'codex',
}

export const JUDGE_PROFILE_LOCAL_OLLAMA: BelayJudgeConfig = resolveJudgeFromCatalog({
  providerId: 'ollama',
})

export const JUDGE_PROFILE_CURSOR: BelayJudgeConfig = resolveJudgeFromCatalog({
  providerId: 'cursor',
})

export const JUDGE_PROFILE_CLAUDE: BelayJudgeConfig = resolveJudgeFromCatalog({
  providerId: 'claude',
})

export const JUDGE_PROFILE_CODEX: BelayJudgeConfig = resolveJudgeFromCatalog({
  providerId: 'codex',
})

export const JUDGE_PROFILES: Record<JudgeProfileName, BelayJudgeConfig> = {
  'local-ollama': JUDGE_PROFILE_LOCAL_OLLAMA,
  cursor: JUDGE_PROFILE_CURSOR,
  claude: JUDGE_PROFILE_CLAUDE,
  codex: JUDGE_PROFILE_CODEX,
}

/** Default Tier1 judge catalog id for a host adapter (fresh init, no explicit judge flags). */
export function defaultJudgeProviderForAdapter(adapter: AdapterName): JudgeProviderId {
  if (adapter === 'cursor') {
    return 'cursor'
  }
  if (adapter === 'claude') {
    return 'claude'
  }
  if (adapter === 'codex') {
    return 'codex'
  }
  return 'cursor'
}

export interface ResolveJudgeConfigInput {
  judgeProfile?: JudgeProfileName
  judgeProvider?: 'ollama' | 'openai-compatible' | 'cursor'
  judgeProviderId?: JudgeProviderId | string
  judgeModel?: string
  judgeEndpoint?: string
  existingJudge?: BelayJudgeConfig
}

function warnDeprecated(message: string): void {
  process.stderr.write(`Warning: ${message}\n`)
}

function resolveProviderIdFromFlags(input: ResolveJudgeConfigInput): JudgeProviderId | null {
  if (input.judgeProviderId) {
    const normalized = normalizeLegacyProviderId(String(input.judgeProviderId))
    if (normalized) {
      return normalized
    }
  }
  if (input.judgeProvider) {
    const rawProvider = input.judgeProvider
    const provider = normalizeJudgeProvider(rawProvider)
    if (rawProvider === 'cursor') {
      return 'cursor'
    }
    if (provider === 'ollama') {
      return 'ollama'
    }
    return 'codex'
  }
  return null
}

export function resolveJudgeConfig(input: ResolveJudgeConfigInput = {}): BelayJudgeConfig {
  if (input.judgeModel !== undefined) {
    rejectDeprecatedJudgeModelAuto(input.judgeModel)
  }
  const providerIdFromFlags = resolveProviderIdFromFlags(input)
  if (providerIdFromFlags) {
    return resolveJudgeFromCatalog({
      providerId: providerIdFromFlags,
      model: input.judgeModel,
      endpoint: input.judgeEndpoint,
    })
  }

  if (input.judgeProfile) {
    warnDeprecated(
      `--judge-profile is deprecated; use belay config set judge.providerId <provider-id> (${JUDGE_PROVIDER_IDS.join(', ')}).`,
    )
    const providerId = PROFILE_TO_PROVIDER_ID[input.judgeProfile]
    return resolveJudgeFromCatalog({
      providerId,
      model: input.judgeModel,
      endpoint: input.judgeEndpoint,
    })
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
      parts.push('Set provider API keys via env or belay config credential set --key-stdin.')
    }
    if (details?.localFallback !== false) {
      parts.push('Use belay config set judge.providerId ollama for local-only Tier1.')
    }
    super(parts.join(' '))
    this.name = 'CloudJudgeConsentRequiredError'
  }
}

export class JudgeEndpointRequiredError extends Error {
  constructor(providerId?: JudgeProviderId) {
    super(
      providerId
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
  return judge.provider === 'openai-compatible' || judge.provider === 'anthropic'
}

export function hasValidCloudConsent(judge: BelayJudgeConfig): boolean {
  if (!judge.cloudConsent?.accepted) {
    return false
  }
  if (!judge.endpoint?.trim()) {
    return false
  }
  const providerId =
    judge.providerId && normalizeLegacyProviderId(judge.providerId)
      ? normalizeLegacyProviderId(judge.providerId)!
      : judge.provider === 'ollama'
        ? 'ollama'
        : 'codex'
  return (
    judge.cloudConsent.endpoint === judge.endpoint.trim() &&
    normalizeLegacyProviderId(judge.cloudConsent.providerId) === providerId
  )
}

export function isImplicitLocalJudge(judge: BelayJudgeConfig): boolean {
  const providerId =
    judge.providerId && normalizeLegacyProviderId(judge.providerId)
      ? normalizeLegacyProviderId(judge.providerId)!
      : judge.provider === 'ollama'
        ? 'ollama'
        : null
  if (providerId !== 'ollama') {
    return false
  }
  if (judge.cloudConsent?.accepted) {
    return false
  }
  const factoryDefault = resolveJudgeFromCatalog({ providerId: 'ollama' })
  const endpoint = judge.endpoint?.trim() ?? factoryDefault.endpoint
  const defaultEndpoint = factoryDefault.endpoint?.trim()
  const endpointMatches =
    !judge.endpoint ||
    endpoint === defaultEndpoint ||
    endpoint === 'http://127.0.0.1:11434' ||
    endpoint === 'http://localhost:11434'
  return judge.provider === 'ollama' && judge.model === factoryDefault.model && endpointMatches
}

export function migrateImplicitLocalJudgeIfNeeded(
  existingJudge: BelayJudgeConfig,
  adapter: AdapterName,
): BelayJudgeConfig | null {
  if (!isImplicitLocalJudge(existingJudge)) {
    return null
  }
  return applyFreshInitDefaults(
    resolveJudgeFromCatalog({ providerId: defaultJudgeProviderForAdapter(adapter) }),
  )
}

export function assertJudgeEndpoint(judge: BelayJudgeConfig): void {
  const providerId =
    judge.providerId && normalizeLegacyProviderId(judge.providerId)
      ? normalizeLegacyProviderId(judge.providerId)!
      : judge.provider === 'ollama'
        ? 'ollama'
        : 'codex'
  const transport = judge.endpoint?.trim()
    ? 'http'
    : (detectJudgeRuntimeCapabilities(providerId).cliTransport ?? 'http')
  if (catalogRequiresEndpoint(providerId, { transport }) && !judge.endpoint?.trim()) {
    throw new JudgeEndpointRequiredError(providerId)
  }
}

function applyFreshInitDefaults(judge: BelayJudgeConfig): BelayJudgeConfig {
  const endpoint = process.env.BELAY_JUDGE_ENDPOINT?.trim()
  return {
    ...judge,
    ...(endpoint ? { endpoint } : {}),
    credential: { mode: 'project' },
  }
}

export function resolveInitJudgeConfig(input: {
  isFresh: boolean
  hasExplicitJudgeFlags: boolean
  judgeProfile?: JudgeProfileName
  judgeProvider?: 'ollama' | 'openai-compatible' | 'cursor'
  judgeProviderId?: JudgeProviderId | string
  judgeModel?: string
  judgeEndpoint?: string
  acceptCloudJudge?: boolean
  interactiveConsent?: boolean
  cloudConsentApprovalId?: string
  existingJudge?: BelayJudgeConfig
  adapter?: AdapterName
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
    return resolveJudgeConfig({ existingJudge: input.existingJudge })
  }

  const adapter = input.adapter ?? 'cursor'
  const judge = resolveJudgeConfig({ judgeProviderId: defaultJudgeProviderForAdapter(adapter) })
  return applyFreshInitDefaults(judge)
}

export function applyCloudConsent(
  judge: BelayJudgeConfig,
  params: { by: string },
): BelayJudgeConfig {
  const providerId =
    judge.providerId && normalizeLegacyProviderId(judge.providerId)
      ? normalizeLegacyProviderId(judge.providerId)!
      : 'codex'
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
  providerId: JudgeProviderId | string
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
  const normalizedId = normalizeLegacyProviderId(String(options.providerId))
  if (!normalizedId) {
    errors.push(`Unknown judge provider id: ${options.providerId}`)
    return { judge: existing, warnings, errors }
  }
  const spec = getJudgeProviderSpec(normalizedId)
  if (!spec) {
    errors.push(`Unknown judge provider id: ${options.providerId}`)
    return { judge: existing, warnings, errors }
  }

  let judge = resolveJudgeFromCatalog({
    providerId: normalizedId,
    model:
      options.model ?? (existing.providerId === normalizedId ? existing.model : undefined),
    endpoint:
      options.endpoint !== undefined
        ? options.endpoint
        : existing.providerId === normalizedId
          ? existing.endpoint
          : undefined,
    timeoutMs: options.timeoutMs ?? existing.timeoutMs,
    keepAlive: existing.keepAlive,
  })

  if (catalogRequiresEndpoint(normalizedId, {
    transport: judge.endpoint?.trim()
      ? 'http'
      : (detectJudgeRuntimeCapabilities(normalizedId).cliTransport ?? 'unavailable'),
  }) && !judge.endpoint?.trim()) {
    errors.push(`${normalizedId} requires --endpoint for HTTP transport.`)
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
      normalizeLegacyProviderId(existing.cloudConsent.providerId) !== normalizedId)

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

// Re-export for callers that validate provider ids
export { isJudgeProviderId }
