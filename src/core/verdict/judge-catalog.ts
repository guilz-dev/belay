import type { BelayJudgeConfig, JudgeProvider } from '../config.js'

export type JudgeProviderId = 'local' | 'openai' | 'cursor' | 'openrouter' | 'custom'

export interface JudgeProviderSpec {
  id: JudgeProviderId
  driver: JudgeProvider
  defaultEndpoint: string | null
  defaultModel: string
  apiKeyEnvVars: string[]
  isCloud: boolean
}

export const JUDGE_CATALOG: Record<JudgeProviderId, JudgeProviderSpec> = {
  local: {
    id: 'local',
    driver: 'ollama',
    defaultEndpoint: 'http://localhost:11434',
    defaultModel: 'gemma4:e2b',
    apiKeyEnvVars: [],
    isCloud: false,
  },
  openai: {
    id: 'openai',
    driver: 'openai-compatible',
    defaultEndpoint: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    apiKeyEnvVars: ['OPENAI_API_KEY', 'BELAY_JUDGE_API_KEY'],
    isCloud: true,
  },
  cursor: {
    id: 'cursor',
    driver: 'openai-compatible',
    defaultEndpoint: null,
    defaultModel: 'composer-2.5',
    apiKeyEnvVars: ['CURSOR_API_KEY', 'BELAY_JUDGE_API_KEY'],
    isCloud: true,
  },
  openrouter: {
    id: 'openrouter',
    driver: 'openai-compatible',
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4.1-mini',
    apiKeyEnvVars: ['OPENROUTER_API_KEY', 'BELAY_JUDGE_API_KEY'],
    isCloud: true,
  },
  custom: {
    id: 'custom',
    driver: 'openai-compatible',
    defaultEndpoint: null,
    defaultModel: '',
    apiKeyEnvVars: ['BELAY_JUDGE_API_KEY'],
    isCloud: true,
  },
}

export const JUDGE_PROVIDER_IDS = Object.keys(JUDGE_CATALOG) as JudgeProviderId[]

export function getJudgeProviderSpec(id: string): JudgeProviderSpec | null {
  if (id in JUDGE_CATALOG) {
    return JUDGE_CATALOG[id as JudgeProviderId]
  }
  return null
}

export function isJudgeProviderId(value: string): value is JudgeProviderId {
  return value in JUDGE_CATALOG
}

export function inferProviderIdFromConfig(judge: Partial<BelayJudgeConfig>): JudgeProviderId {
  const endpoint = judge.endpoint?.trim().toLowerCase() ?? ''
  if (judge.provider === 'ollama') {
    return 'local'
  }
  if (endpoint.includes('api.openai.com')) {
    return 'openai'
  }
  if (endpoint.includes('openrouter.ai')) {
    return 'openrouter'
  }
  if (endpoint) {
    return 'custom'
  }
  if (judge.providerId && isJudgeProviderId(judge.providerId)) {
    return judge.providerId
  }
  return 'custom'
}

export interface ResolveJudgeFromCatalogInput {
  providerId: JudgeProviderId
  model?: string
  endpoint?: string | null
  timeoutMs?: number
  keepAlive?: string | null
}

export function resolveJudgeFromCatalog(input: ResolveJudgeFromCatalogInput): BelayJudgeConfig {
  const spec = JUDGE_CATALOG[input.providerId]
  const model =
    input.model?.trim() ||
    spec.defaultModel ||
    (input.providerId === 'custom' ? '' : spec.defaultModel)
  const endpoint =
    input.endpoint !== undefined
      ? input.endpoint?.trim() || null
      : spec.defaultEndpoint
  return {
    provider: spec.driver,
    providerId: spec.id,
    model,
    endpoint,
    timeoutMs: input.timeoutMs ?? (spec.isCloud ? 8000 : 25000),
    keepAlive: spec.driver === 'ollama' ? (input.keepAlive ?? '30m') : null,
  }
}

export function catalogRequiresEndpoint(providerId: JudgeProviderId): boolean {
  return providerId === 'cursor' || providerId === 'custom'
}

export function isCloudProviderId(providerId: JudgeProviderId | undefined): boolean {
  if (!providerId) {
    return false
  }
  return JUDGE_CATALOG[providerId].isCloud
}
