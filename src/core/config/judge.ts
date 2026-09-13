import { warnDeprecatedJudgeModelAuto } from '../judge-model-policy.js'
import {
  getJudgeProviderSpec,
  inferProviderIdFromConfig,
  isRemovedProviderId,
  normalizeLegacyProviderId,
  warnRemovedProviderId,
} from '../verdict/judge-catalog.js'
import { normalizeJudgeRuntimeConfig } from '../verdict/judge-runtime-config.js'
import { DEFAULT_JUDGE_LOCAL_OLLAMA, DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE } from './defaults.js'
import type {
  BelayJudgeConfig,
  DeprecatedJudgeProviderId,
  JudgeProviderId,
  RawConfigInput,
} from './types.js'

export function normalizeJudgeProvider(
  provider: string | undefined,
): 'ollama' | 'openai-compatible' | 'anthropic' {
  if (provider === 'anthropic') {
    return 'anthropic'
  }
  if (provider === 'openai-compatible' || provider === 'cursor') {
    return 'openai-compatible'
  }
  return 'ollama'
}

function defaultJudgeTemplateForProvider(
  provider: 'ollama' | 'openai-compatible' | 'anthropic',
): BelayJudgeConfig {
  if (provider === 'ollama') {
    return DEFAULT_JUDGE_LOCAL_OLLAMA
  }
  if (provider === 'anthropic') {
    return {
      mode: 'shadow',
      provider: 'anthropic',
      providerId: 'claude',
      model: 'claude-sonnet-4-6',
      timeoutMs: 8000,
      endpoint: null,
      keepAlive: null,
    }
  }
  return DEFAULT_JUDGE_OPENAI_COMPATIBLE_TEMPLATE
}

export function synthesizeJudgeFromRaw(raw: RawConfigInput): BelayJudgeConfig {
  const judge = raw.judge as (Partial<BelayJudgeConfig> & { provider?: string }) | undefined
  if (judge?.provider) {
    const rawProvider = String(judge.provider)
    const provider = normalizeJudgeProvider(rawProvider)
    const base = defaultJudgeTemplateForProvider(provider)
    const providerId =
      judge.providerId && normalizeLegacyProviderId(judge.providerId)
        ? normalizeLegacyProviderId(judge.providerId)!
        : rawProvider === 'cursor'
          ? ('cursor' as const)
          : undefined
    return normalizeJudgeConfig({
      ...base,
      ...judge,
      provider,
      ...(providerId ? { providerId } : {}),
    })
  }
  return { ...DEFAULT_JUDGE_LOCAL_OLLAMA }
}

export function normalizeJudgeConfig(judge: BelayJudgeConfig): BelayJudgeConfig {
  const provider = normalizeJudgeProvider(judge.provider)
  const base = defaultJudgeTemplateForProvider(provider)

  const rawProviderId = judge.providerId ? String(judge.providerId) : undefined
  if (rawProviderId && isRemovedProviderId(rawProviderId)) {
    warnRemovedProviderId(rawProviderId)
    let model =
      typeof judge.model === 'string' && judge.model.trim() ? judge.model.trim() : base.model
    if (model === 'auto') {
      warnDeprecatedJudgeModelAuto()
      model = base.model
    }
    const timeoutMs =
      typeof judge.timeoutMs === 'number' && judge.timeoutMs > 0 ? judge.timeoutMs : base.timeoutMs
    const endpoint: string | null =
      typeof judge.endpoint === 'string' && judge.endpoint.trim() ? judge.endpoint.trim() : null
    return {
      mode: judge.mode === 'off' ? 'off' : 'shadow',
      provider,
      providerId: rawProviderId as DeprecatedJudgeProviderId,
      model,
      timeoutMs,
      endpoint,
      keepAlive:
        provider === 'ollama' && typeof judge.keepAlive === 'string' && judge.keepAlive.trim()
          ? judge.keepAlive.trim()
          : provider === 'ollama'
            ? DEFAULT_JUDGE_LOCAL_OLLAMA.keepAlive
            : null,
      ...(judge.cloudConsent ? { cloudConsent: judge.cloudConsent } : {}),
      ...(judge.credential ? { credential: judge.credential } : {}),
      runtime: normalizeJudgeRuntimeConfig(judge.runtime),
    }
  }

  let providerId: JudgeProviderId =
    rawProviderId && normalizeLegacyProviderId(rawProviderId)
      ? normalizeLegacyProviderId(rawProviderId)!
      : inferProviderIdFromConfig({ ...judge, provider })

  const spec = getJudgeProviderSpec(providerId)
  if (spec && spec.driver !== provider) {
    providerId = inferProviderIdFromConfig({ ...judge, provider })
  }

  const catalogSpec = getJudgeProviderSpec(providerId)
  let model =
    typeof judge.model === 'string' && judge.model.trim() ? judge.model.trim() : base.model
  if (model === 'auto' && catalogSpec?.defaultModel) {
    warnDeprecatedJudgeModelAuto()
    model = catalogSpec.defaultModel
  }
  if (!model && catalogSpec?.defaultModel) {
    model = catalogSpec.defaultModel
  }

  const timeoutMs =
    typeof judge.timeoutMs === 'number' && judge.timeoutMs > 0 ? judge.timeoutMs : base.timeoutMs

  let endpoint: string | null =
    typeof judge.endpoint === 'string' && judge.endpoint.trim() ? judge.endpoint.trim() : null
  if (!endpoint && catalogSpec?.defaultEndpoint) {
    endpoint = catalogSpec.defaultEndpoint
  }

  const normalized: BelayJudgeConfig = {
    mode: judge.mode === 'off' ? 'off' : 'shadow',
    provider,
    providerId,
    model,
    timeoutMs,
    endpoint,
    keepAlive:
      provider === 'ollama' && typeof judge.keepAlive === 'string' && judge.keepAlive.trim()
        ? judge.keepAlive.trim()
        : provider === 'ollama'
          ? DEFAULT_JUDGE_LOCAL_OLLAMA.keepAlive
          : null,
  }

  if (judge.cloudConsent?.accepted) {
    normalized.cloudConsent = {
      accepted: true,
      at: judge.cloudConsent.at,
      providerId: judge.cloudConsent.providerId ?? providerId,
      endpoint: judge.cloudConsent.endpoint,
      by: judge.cloudConsent.by,
    }
  }

  if (judge.credential?.mode === 'project' || judge.credential?.mode === 'apiKey') {
    normalized.credential = {
      mode: judge.credential.mode,
      ...(judge.credential.ref ? { ref: judge.credential.ref } : {}),
    }
  }

  normalized.runtime = normalizeJudgeRuntimeConfig(judge.runtime)

  return normalized
}

export function rejectTeamLayerJudgeSecrets(
  judge: Partial<BelayJudgeConfig> | undefined,
  source: 'team' | 'repo',
): void {
  if (source !== 'team' || !judge) {
    return
  }
  if (judge.credential?.mode === 'apiKey') {
    throw new Error('team config cannot set judge.credential.mode to apiKey.')
  }
  const raw = judge as { credential?: { key?: string } }
  if (raw.credential && 'key' in raw.credential && raw.credential.key) {
    throw new Error('team config cannot contain inline judge credential keys.')
  }
}
