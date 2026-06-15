import type { BelayJudgeConfig, JudgeProvider } from '../config.js'

export type JudgeProviderId = 'ollama' | 'codex' | 'claude' | 'cursor'

/** Read-time aliases for legacy configs; never written on fresh init. */
export const LEGACY_PROVIDER_ID_ALIASES: Record<string, JudgeProviderId> = {
  local: 'ollama',
  openai: 'codex',
}

/** Removed catalog ids; load emits a warning and best-effort canonical mapping. */
export const REMOVED_JUDGE_PROVIDER_IDS = ['openrouter', 'custom'] as const

export function isRemovedProviderId(id: string): boolean {
  return (REMOVED_JUDGE_PROVIDER_IDS as readonly string[]).includes(id)
}

export function warnRemovedProviderId(id: string): void {
  process.stderr.write(
    `Warning: judge.providerId "${id}" was removed; migrate with belay config set judge.providerId <ollama|codex|claude|cursor>.\n`,
  )
}

export interface JudgeProviderSpec {
  id: JudgeProviderId
  driver: JudgeProvider
  defaultEndpoint: string | null
  defaultModel: string
  apiKeyEnvVars: string[]
  isCloud: boolean
}

export const JUDGE_CATALOG: Record<JudgeProviderId, JudgeProviderSpec> = {
  ollama: {
    id: 'ollama',
    driver: 'ollama',
    defaultEndpoint: 'http://localhost:11434',
    defaultModel: 'gemma4:e2b',
    apiKeyEnvVars: [],
    isCloud: false,
  },
  codex: {
    id: 'codex',
    driver: 'openai-compatible',
    defaultEndpoint: null,
    defaultModel: 'gpt-5.3-codex-high',
    apiKeyEnvVars: ['OPENAI_API_KEY', 'BELAY_JUDGE_API_KEY'],
    isCloud: true,
  },
  claude: {
    id: 'claude',
    driver: 'anthropic',
    defaultEndpoint: null,
    defaultModel: 'claude-sonnet-4-6',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY', 'BELAY_JUDGE_API_KEY'],
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
}

export const JUDGE_PROVIDER_IDS = Object.keys(JUDGE_CATALOG) as JudgeProviderId[]

export function normalizeLegacyProviderId(id: string): JudgeProviderId | null {
  if (id in JUDGE_CATALOG) {
    return id as JudgeProviderId
  }
  return LEGACY_PROVIDER_ID_ALIASES[id] ?? null
}

export function getJudgeProviderSpec(id: string): JudgeProviderSpec | null {
  const normalized = normalizeLegacyProviderId(id)
  if (!normalized) {
    return null
  }
  return JUDGE_CATALOG[normalized]
}

export function isJudgeProviderId(value: string): boolean {
  return normalizeLegacyProviderId(value) !== null
}

export function inferProviderIdFromConfig(judge: Partial<BelayJudgeConfig>): JudgeProviderId {
  if (judge.providerId) {
    const normalized = normalizeLegacyProviderId(judge.providerId)
    if (normalized) {
      return normalized
    }
  }
  if (judge.provider === 'ollama') {
    return 'ollama'
  }
  if (judge.provider === 'anthropic') {
    return 'claude'
  }
  const endpoint = judge.endpoint?.trim().toLowerCase() ?? ''
  if (endpoint.includes('openrouter.ai')) {
    return 'codex'
  }
  if (endpoint.includes('api.openai.com')) {
    return 'codex'
  }
  if (endpoint) {
    return 'codex'
  }
  if (judge.provider === 'openai-compatible') {
    const model = judge.model?.trim().toLowerCase() ?? ''
    if (model.includes('composer')) {
      return 'cursor'
    }
  }
  return 'codex'
}

export interface ResolveJudgeFromCatalogInput {
  providerId: JudgeProviderId | string
  model?: string
  endpoint?: string | null
  timeoutMs?: number
  keepAlive?: string | null
}

export function resolveJudgeFromCatalog(input: ResolveJudgeFromCatalogInput): BelayJudgeConfig {
  const providerId = normalizeLegacyProviderId(String(input.providerId))
  if (!providerId) {
    throw new Error(`Unknown judge provider id: ${input.providerId}`)
  }
  const spec = JUDGE_CATALOG[providerId]
  const model = input.model?.trim() || spec.defaultModel
  const endpoint =
    input.endpoint !== undefined ? input.endpoint?.trim() || null : spec.defaultEndpoint
  return {
    provider: spec.driver,
    providerId: spec.id,
    model,
    endpoint,
    timeoutMs: input.timeoutMs ?? (spec.isCloud ? 8000 : 25000),
    keepAlive: spec.driver === 'ollama' ? (input.keepAlive ?? '30m') : null,
  }
}

export function catalogRequiresEndpoint(_providerId: JudgeProviderId): boolean {
  return false
}

export function isCloudProviderId(providerId: JudgeProviderId | string | undefined): boolean {
  if (!providerId) {
    return false
  }
  const normalized = normalizeLegacyProviderId(providerId)
  if (!normalized) {
    return false
  }
  return JUDGE_CATALOG[normalized].isCloud
}
