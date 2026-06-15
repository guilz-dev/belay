import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { repoLocalStateDirFor } from '../../config-io.js'
import type { BelayConfigV4, BelayJudgeConfig } from '../config.js'
import { normalizeJudgeProvider, scrubOptionsFromConfig } from '../config.js'
import { resolveJudgeCredential } from '../judge-api-key.js'
import { hasValidCloudConsent, isCloudJudgeConfig } from '../judge-config.js'
import {
  createDeterministicJudgeStub,
  createFailClosedJudge,
  createOllamaJudge,
  createOpenAiCompatibleJudge,
  type TracedTier1Judge,
} from './judge.js'
import { getJudgeProviderSpec, isRemovedProviderId } from './judge-catalog.js'

const FIXTURE_MODELS_URL = new URL('../../../fixtures/judge-models.json', import.meta.url)

let cachedPinnedModels: {
  'openai-compatible': { autoResolved: string }
  ollama: { ciPin: string }
} | null = null

export function resetPinnedJudgeModelsCache(): void {
  cachedPinnedModels = null
}

export async function loadPinnedJudgeModels(): Promise<{
  'openai-compatible': { autoResolved: string }
  ollama: { ciPin: string }
}> {
  if (cachedPinnedModels) {
    return cachedPinnedModels
  }
  try {
    const raw = await readFile(fileURLToPath(FIXTURE_MODELS_URL), 'utf8')
    cachedPinnedModels = JSON.parse(raw) as {
      'openai-compatible': { autoResolved: string }
      ollama: { ciPin: string }
    }
    return cachedPinnedModels
  } catch {
    cachedPinnedModels = {
      'openai-compatible': { autoResolved: 'composer-2.5' },
      ollama: { ciPin: 'gemma4:e2b' },
    }
    return cachedPinnedModels
  }
}

export function resolveJudgeModel(judge: BelayJudgeConfig): {
  requested: string
  resolved: string
} {
  const requested = judge.model
  if (requested === 'auto') {
    const spec = judge.providerId ? getJudgeProviderSpec(judge.providerId) : null
    const resolved =
      process.env.BELAY_JUDGE_MODEL_RESOLVED?.trim() || spec?.defaultModel || requested
    return { requested, resolved }
  }
  return { requested, resolved: requested }
}

/** @deprecated Use resolveJudgeModel */
export const resolveCloudModel = (
  requested: string,
  pinned: { autoResolved: string },
): { requested: string; resolved: string } => {
  if (requested === 'auto') {
    const envResolved = process.env.BELAY_JUDGE_MODEL_RESOLVED?.trim()
    return {
      requested,
      resolved: envResolved || pinned.autoResolved,
    }
  }
  return { requested, resolved: requested }
}

/** @deprecated Use resolveJudgeModel */
export const resolveCursorModel = resolveCloudModel

export function createJudgeFromConfig(
  config: BelayConfigV4,
  options: { pinnedModels?: { autoResolved: string }; repoRoot?: string } = {},
): TracedTier1Judge {
  if (process.env.BELAY_DETERMINISTIC_JUDGE === '1') {
    return createDeterministicJudgeStub()
  }

  const judgeConfig = config.judge
  if (judgeConfig.providerId && isRemovedProviderId(String(judgeConfig.providerId))) {
    const { resolved } = resolveJudgeModel(judgeConfig)
    return createFailClosedJudge({
      reason: 'judge_provider_removed',
      fallbackReason: 'provider_migration_required',
      modelRequested: judgeConfig.model,
      modelResolved: resolved,
    })
  }

  const provider = normalizeJudgeProvider(judgeConfig.provider)
  const catalogSpec = judgeConfig.providerId ? getJudgeProviderSpec(judgeConfig.providerId) : null

  if (provider === 'openai-compatible') {
    const endpoint = judgeConfig.endpoint?.trim()
    if (!endpoint) {
      return createFailClosedJudge({
        reason: 'openai_compatible_endpoint_missing',
        fallbackReason: 'missing_endpoint',
        modelRequested: judgeConfig.model,
        modelResolved: judgeConfig.model,
      })
    }

    if (isCloudJudgeConfig(judgeConfig) && !hasValidCloudConsent(judgeConfig)) {
      return createFailClosedJudge({
        reason: 'openai_compatible_consent_missing',
        fallbackReason: 'cloud_consent_missing',
        modelRequested: judgeConfig.model,
        modelResolved: judgeConfig.model,
      })
    }

    const { resolved } = resolveJudgeModel(judgeConfig)
    const repoRoot = options.repoRoot ?? process.cwd()
    const repoLocalStateDir = repoLocalStateDirFor(repoRoot, config)

    return createOpenAiCompatibleJudge({
      endpoint,
      modelRequested: judgeConfig.model,
      modelResolved: resolved,
      timeoutMs: judgeConfig.timeoutMs,
      sensitivePaths: config.classifier.sensitivePaths,
      scrubOptions: scrubOptionsFromConfig(config),
      resolveApiKey: async () =>
        resolveJudgeCredential({
          judge: judgeConfig,
          catalogSpec: catalogSpec ?? undefined,
          repoRoot,
          repoLocalStateDir,
          config,
        }),
    })
  }

  if (provider === 'ollama') {
    return createOllamaJudge({
      model: judgeConfig.model,
      baseUrl: judgeConfig.endpoint ?? 'http://127.0.0.1:11434',
      timeoutMs: judgeConfig.timeoutMs,
      keepAlive: judgeConfig.keepAlive,
    })
  }

  if (provider === 'anthropic') {
    const { resolved } = resolveJudgeModel(judgeConfig)
    return createFailClosedJudge({
      reason: 'anthropic_not_implemented',
      fallbackReason: 'anthropic_runtime_unavailable',
      modelRequested: judgeConfig.model,
      modelResolved: resolved,
    })
  }

  return createFailClosedJudge({
    reason: 'unsupported_judge_provider',
    fallbackReason: 'unsupported_provider',
    modelRequested: judgeConfig.model,
    modelResolved: judgeConfig.model,
  })
}

export function judgeConfigSummary(judge: BelayJudgeConfig): string {
  const id = judge.providerId ?? judge.provider
  return `${id}/${judge.model}`
}
